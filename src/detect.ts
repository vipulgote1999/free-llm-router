/**
 * Content-aware routing: detect what the request needs (vision / audio /
 * reasoning / long context) and pick a provider + model that can serve it.
 * Pure logic — no Cloudflare imports.
 */

import type { ChatPart, ChatRequest, Capability, ModelInfo } from "./types";
import type { ProviderConfig } from "./types";
import { PROVIDER_IDS, isKnownModelId, isFreeForAuto } from "./config";
import { getScore } from "./model-scores";

export interface Caps {
  vision: boolean;
  audio: boolean;
  reasoning: boolean;
  inputTokens: number;
  estTotalTokens: number;
}

/** Rough per-attachment token costs (exact pixel counts are not worth decoding). */
const IMAGE_TOKEN_EST = 1200;
const AUDIO_TOKEN_EST = 2000;

export function detect(req: ChatRequest): Caps {
  let vision = false;
  let audio = false;
  let chars = 0;

  for (const msg of req.messages ?? []) {
    const content = msg.content;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) {
      if (content) chars += JSON.stringify(content).length;
      continue;
    }
    for (const part of content as ChatPart[]) {
      if (!part || typeof part !== "object") continue;
      switch (part.type) {
        case "text":
          chars += String(part.text ?? "").length;
          break;
        case "image_url":
        case "input_image":
        case "image":
          vision = true;
          chars += IMAGE_TOKEN_EST * 4;
          break;
        case "input_audio":
        case "audio_url":
        case "audio":
          audio = true;
          chars += AUDIO_TOKEN_EST * 4;
          break;
        default:
          chars += JSON.stringify(part).length;
          break;
      }
    }
  }

  const inputTokens = Math.ceil(chars / 4);
  const estTotalTokens =
    inputTokens + (req.max_tokens ?? req.max_completion_tokens ?? 1024);
  const reasoning =
    req.reasoning_effort !== undefined ||
    /(^|[^a-z])(r1|reasoning)([^a-z]|$)/i.test(req.model ?? "");

  return { vision, audio, reasoning, inputTokens, estTotalTokens };
}

export interface ModelSpec {
  provider?: string;
  model: string;
}

/**
 * Parse the client's model field:
 *   "model@provider"  → force provider  (e.g. "llama-70b@cerebras")
 *   "provider/model"  → force provider  (e.g. "groq/llama-3.3-70b-versatile")
 *   "model"           → any provider that has it (aliases included)
 *   "" / "auto"       → auto-select by content
 * Resolution order matters: an exact registered model id wins over the
 * provider-split heuristic, because OpenRouter ids look like "nvidia/...".
 */
export function parseModelSpec(requested: string | undefined): ModelSpec {
  if (!requested || requested.trim() === "") return { model: "auto" };
  const spec = requested.trim();

  const at = spec.lastIndexOf("@");
  if (at > 0 && PROVIDER_IDS.has(spec.slice(at + 1))) {
    return { provider: spec.slice(at + 1), model: spec.slice(0, at) };
  }
  if (isKnownModelId(spec)) return { model: spec };
  const slash = spec.indexOf("/");
  if (slash > 0 && PROVIDER_IDS.has(spec.slice(0, slash))) {
    return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  }
  return { model: spec };
}

export interface Candidate {
  provider: ProviderConfig;
  model: string;
}

const LONG_CONTEXT_TOKENS = 32000;

function intelligenceOf(modelId: string): number {
  return getScore(modelId)?.score ?? 0;
}

export function selectCandidates(
  spec: ModelSpec,
  caps: Caps,
  providers: ProviderConfig[],
): Candidate[] {
  const active = providers.filter((p) => !p.disabled);
  const pool = spec.provider
    ? active.filter((p) => p.id === spec.provider)
    : active;

  // auto: prefer verified-free models, then order by weight + AA intelligence.
  // If no free model matches the requested capability (e.g. no free audio
  // model), fall back to the full registry so the router still serves.
  if (spec.model === "auto") {
    const build = (freeOnly: boolean): (Candidate & { effective: number })[] => {
      const out: (Candidate & { effective: number })[] = [];
      for (const p of pool) {
        if (caps.vision && !hasCapability(p, "vision")) continue;
        if (caps.audio && !hasCapability(p, "audio")) continue;
        const base = freeOnly
          ? p.models.filter((mm) => isFreeForAuto(p, mm.id))
          : p.models;
        if (base.length === 0) continue;
        const model = chooseAutoModel(p, caps, base);
        if (!model) continue;
        const boost = caps.reasoning && hasCapability(p, "reasoning") ? 1000 : 0;
        const effective = p.weight + boost + intelligenceOf(model);
        out.push({ provider: p, model, effective });
      }
      return out;
    };
    let out = build(true);
    if (out.length === 0) out = build(false);
    out.sort((a, b) => b.effective - a.effective);
    return out.map(({ provider, model }) => ({ provider, model }));
  }

  const sorted = [...pool].sort((a, b) => b.weight - a.weight);

  // NOTE (bench-2026-08-17): spreading auto requests across providers was
  // measured and REVERTED — free tiers are concurrency-limited (mistral
  // ~1 RPS), so a uniform spread queues on slow providers and hurts burst
  // p95 (19.3s vs 6.3s weight-ordered). Weight order + 429-failover is the
  // better strategy; per-provider concurrency caps are a future epic.

  const out: Candidate[] = [];
  for (const p of sorted) {
    if (caps.vision && !hasCapability(p, "vision")) continue;
    if (caps.audio && !hasCapability(p, "audio")) continue;
    const model = chooseModel(p, spec.model, caps);
    if (model) out.push({ provider: p, model });
  }
  return out;
}

function hasCapability(p: ProviderConfig, cap: Capability): boolean {
  return p.models.some((mm) => mm.capabilities.includes(cap));
}

function chooseModel(
  p: ProviderConfig,
  requested: string,
  caps: Caps,
): string | null {
  if (requested !== "auto") {
    const found = p.models.find(
      (mm) => mm.id === requested || mm.aliases.includes(requested),
    );
    if (!found) return null;
    if (caps.vision && !found.capabilities.includes("vision")) return null;
    if (caps.audio && !found.capabilities.includes("audio")) return null;
    return found.id;
  }

  return chooseAutoModel(p, caps, p.models);
}

function fitsAuto(mm: ModelInfo, caps: Caps): boolean {
  if (caps.audio) return mm.capabilities.includes("audio");
  if (caps.vision) return mm.capabilities.includes("vision");
  return !mm.capabilities.includes("audio");
}

/** Explicit admin auto.* overrides win; otherwise content decides from the pool. */
function chooseAutoModel(
  p: ProviderConfig,
  caps: Caps,
  basePool: ModelInfo[],
): string | null {
  const cap = caps.audio ? "audio" : caps.vision ? "vision" : "text";
  if (p.autoOverride?.[cap]) {
    const wanted = p.auto[cap];
    const hit = p.models.find(
      (mm) => mm.id === wanted || mm.aliases.includes(wanted),
    );
    if (hit && fitsAuto(hit, caps)) return hit.id;
  }
  return pickAutoModel(caps, basePool);
}

function pickAutoModel(caps: Caps, basePool: ModelInfo[]): string | null {
  let pool = basePool;
  if (caps.audio) {
    pool = pool.filter((mm) => mm.capabilities.includes("audio"));
  } else if (caps.vision) {
    pool = pool.filter((mm) => mm.capabilities.includes("vision"));
  } else {
    pool = pool.filter((mm) => !mm.capabilities.includes("audio"));
  }
  if (pool.length === 0) return null;

  if (caps.reasoning) {
    const reasoningPool = pool.filter((mm) =>
      mm.capabilities.includes("reasoning"),
    );
    if (reasoningPool.length > 0) {
      const sorted = [...reasoningPool].sort(
        (a, b) => intelligenceOf(b.id) - intelligenceOf(a.id),
      );
      return sorted[0]!.id;
    }
  }
  if (caps.estTotalTokens > LONG_CONTEXT_TOKENS) {
    const fit = pool.filter((mm) => mm.context >= caps.estTotalTokens);
    if (fit.length > 0) {
      const sorted = [...fit].sort((a, b) => {
        const sa = intelligenceOf(a.id);
        const sb = intelligenceOf(b.id);
        if (sb !== sa) return sb - sa;
        return b.context - a.context;
      });
      return sorted[0]!.id;
    }
  }
  const sorted = [...pool].sort(
    (a, b) => intelligenceOf(b.id) - intelligenceOf(a.id),
  );
  return sorted[0]?.id ?? null;
}
