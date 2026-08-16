/**
 * Content-aware routing: detect what the request needs (vision / audio /
 * reasoning / long context) and pick a provider + model that can serve it.
 * Pure logic — no Cloudflare imports.
 */

import type { ChatPart, ChatRequest, Capability } from './types';
import type { ProviderConfig } from './types';
import { PROVIDER_IDS } from './config';

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
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) {
      if (content) chars += JSON.stringify(content).length;
      continue;
    }
    for (const part of content as ChatPart[]) {
      if (!part || typeof part !== 'object') continue;
      switch (part.type) {
        case 'text':
          chars += String(part.text ?? '').length;
          break;
        case 'image_url':
        case 'input_image':
        case 'image':
          vision = true;
          chars += IMAGE_TOKEN_EST * 4;
          break;
        case 'input_audio':
        case 'audio_url':
        case 'audio':
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
    /(^|[^a-z])(r1|reasoning)([^a-z]|$)/i.test(req.model ?? '');

  return { vision, audio, reasoning, inputTokens, estTotalTokens };
}

export interface ModelSpec {
  provider?: string;
  model: string;
}

/**
 * Parse the client's model field:
 *   "provider/model"  → force provider  (e.g. "groq/llama-3.3-70b-versatile")
 *   "model@provider"  → force provider  (e.g. "llama-70b@cerebras")
 *   "model"           → any provider that has it (aliases included)
 *   "" / "auto"       → auto-select by content
 * OpenRouter ids contain "/" but their first segment is never a provider id.
 */
export function parseModelSpec(requested: string | undefined): ModelSpec {
  if (!requested || requested.trim() === '') return { model: 'auto' };
  const spec = requested.trim();

  const at = spec.lastIndexOf('@');
  if (at > 0) {
    return { provider: spec.slice(at + 1), model: spec.slice(0, at) };
  }
  const slash = spec.indexOf('/');
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

export function selectCandidates(
  spec: ModelSpec,
  caps: Caps,
  providers: ProviderConfig[],
): Candidate[] {
  const active = providers.filter((p) => !p.disabled);
  const pool = spec.provider
    ? active.filter((p) => p.id === spec.provider)
    : active;

  const sorted = [...pool].sort((a, b) => {
    // auto + reasoning: providers with reasoning models jump the queue
    const aBoost =
      spec.model === 'auto' && caps.reasoning && hasCapability(a, 'reasoning')
        ? 1000
        : 0;
    const bBoost =
      spec.model === 'auto' && caps.reasoning && hasCapability(b, 'reasoning')
        ? 1000
        : 0;
    return b.weight + bBoost - (a.weight + aBoost);
  });

  const out: Candidate[] = [];
  for (const p of sorted) {
    if (caps.vision && !hasCapability(p, 'vision')) continue;
    if (caps.audio && !hasCapability(p, 'audio')) continue;
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
  if (requested !== 'auto') {
    const found = p.models.find(
      (mm) => mm.id === requested || mm.aliases.includes(requested),
    );
    if (!found) return null;
    if (caps.vision && !found.capabilities.includes('vision')) return null;
    if (caps.audio && !found.capabilities.includes('audio')) return null;
    return found.id;
  }

  // auto: content decides
  let pool = p.models;
  if (caps.audio) {
    pool = pool.filter((mm) => mm.capabilities.includes('audio'));
  } else if (caps.vision) {
    pool = pool.filter((mm) => mm.capabilities.includes('vision'));
  } else {
    pool = pool.filter((mm) => !mm.capabilities.includes('audio'));
  }
  if (pool.length === 0) return null;

  if (caps.reasoning) {
    const r = pool.find((mm) => mm.capabilities.includes('reasoning'));
    if (r) return r.id;
  }
  if (caps.estTotalTokens > LONG_CONTEXT_TOKENS) {
    const fit = pool
      .filter((mm) => mm.context >= caps.estTotalTokens)
      .sort((a, b) => b.context - a.context);
    if (fit[0]) return fit[0].id;
  }
  return pool[0]?.id ?? null;
}
