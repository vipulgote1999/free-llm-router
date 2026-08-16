/**
 * Provider registry — the single source of truth for endpoints, auth styles,
 * model tables, capabilities, and free-tier limits. All limits are env-
 * overridable (e.g. GROQ_RPM) because providers change them over time.
 * Verify this against live provider catalogs with: node scripts/verify-models.mjs
 */

import type { Limits, ModelInfo, ProviderConfig } from './types';
import { UNLIMITED } from './windows';

const MAX = UNLIMITED;

function m(
  id: string,
  aliases: string[],
  capabilities: ModelInfo['capabilities'],
  context: number,
  limits?: Partial<Limits>,
): ModelInfo {
  return { id, aliases, capabilities, context, limits };
}

// ---------------------------------------------------------------- providers

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    baseUrl: '',
    auth: 'none',
    apiKeyEnv: '',
    keyHeader: null,
    // 10k neurons/day free (not tokens); request-count is a conservative proxy.
    limits: { rpm: 30, rpd: 200, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 110,
    auto: {
      text: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      vision: '@cf/meta/llama-3.2-11b-vision-instruct',
      audio: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    },
    models: [
      m('@cf/meta/llama-3.3-70b-instruct-fp8-fast', ['cf-llama-70b'], ['text'], 131072),
      m('@cf/meta/llama-3.1-8b-instruct', ['cf-llama-8b'], ['text'], 131072),
      m('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', ['cf-r1'], ['reasoning'], 131072),
      m('@cf/qwen/qwen2.5-coder-32b-instruct', ['cf-qwen-coder'], ['text'], 131072),
      m('@cf/meta/llama-3.2-11b-vision-instruct', ['cf-llama-vision'], ['vision'], 131072),
      m('@cf/meta/llama-4-scout-17b-16e-instruct', ['cf-llama4-scout'], ['vision'], 131072),
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'bearer',
    apiKeyEnv: 'GROQ_API_KEY',
    keyHeader: 'x-groq-api-key',
    limits: { rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 },
    dayAnchorUtc: 0,
    weight: 100,
    auto: {
      text: 'llama-3.3-70b-versatile',
      vision: 'llama-3.3-70b-versatile',
      audio: 'llama-3.3-70b-versatile',
    },
    models: [
      m('llama-3.3-70b-versatile', ['llama-3.3-70b', 'llama-70b'], ['text'], 131072, {
        rpm: 30,
        rpd: 1000,
        tpm: 12000,
        tpd: 100000,
      }),
      m('llama-3.1-8b-instant', ['llama-3.1-8b', 'llama-8b'], ['text'], 131072, {
        rpm: 30,
        rpd: 14400,
        tpm: 6000,
        tpd: 500000,
      }),
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    auth: 'bearer',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    keyHeader: 'x-cerebras-api-key',
    // Free: 30 RPM, 60K TPM, 1M TPD
    limits: { rpm: 30, rpd: MAX, tpm: 60000, tpd: 1000000 },
    dayAnchorUtc: 0,
    weight: 85,
    auto: { text: 'llama-3.3-70b', vision: 'llama-3.3-70b', audio: 'llama-3.3-70b' },
    models: [
      m('llama-3.3-70b', ['llama-70b'], ['text'], 131072),
      m('llama-3.1-8b', ['llama-8b'], ['text'], 131072),
    ],
  },
  {
    // Catalog verified live 2026-08: the *-free models are the guaranteed
    // free tier; the rest is what zen serves keyless (IP-limited).
    id: 'zen',
    name: 'OpenCode Zen (keyless)',
    baseUrl: 'https://opencode.ai/zen/v1',
    auth: 'none',
    apiKeyEnv: '',
    keyHeader: null,
    // ~100 requests/day per IP on the free tier
    limits: { rpm: 10, rpd: 100, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 80,
    auto: {
      text: 'deepseek-v4-flash-free',
      vision: 'gemini-3.5-flash',
      audio: 'deepseek-v4-flash-free',
    },
    models: [
      // --- explicitly free zen models
      m('deepseek-v4-flash-free', ['deepseek-free'], ['text'], 131072),
      m('mimo-v2.5-free', ['mimo'], ['text'], 131072),
      m('hy3-free', ['hy3'], ['text'], 131072),
      m('nemotron-3-ultra-free', ['nemotron-free'], ['text'], 1000000),
      m('nemotron-3.5-lightning-free', ['nemotron-lightning-free'], ['text'], 1000000),
      m('laguna-s-2.1-free', ['laguna-free'], ['text'], 262144),
      // --- claude family (vision)
      m('claude-fable-5', [], ['vision'], 200000),
      m('claude-opus-5', ['opus'], ['vision', 'reasoning'], 200000),
      m('claude-opus-4-8', ['opus-4-8'], ['vision'], 200000),
      m('claude-opus-4-7', ['opus-4-7'], ['vision'], 200000),
      m('claude-opus-4-6', ['opus-4-6'], ['vision'], 200000),
      m('claude-opus-4-5', ['opus-4-5'], ['vision'], 200000),
      m('claude-sonnet-5', ['sonnet'], ['vision', 'reasoning'], 200000),
      m('claude-sonnet-4-6', ['sonnet-4-6'], ['vision'], 200000),
      m('claude-sonnet-4-5', ['sonnet-4-5'], ['vision'], 200000),
      m('claude-sonnet-4', ['claude'], ['vision'], 200000),
      m('claude-haiku-4-5', ['haiku'], ['vision'], 200000),
      // --- gemini family (vision)
      m('gemini-3.6-flash', ['gemini-3.6'], ['vision'], 1048576),
      m('gemini-3.7-flash', ['gemini-3.7'], ['vision'], 1048576),
      m('gemini-3.5-flash-lite', [], ['vision'], 1048576),
      m('gemini-3.5-flash', ['gemini-flash'], ['vision'], 1048576),
      m('gemini-3.1-pro', ['gemini-pro'], ['vision', 'reasoning'], 1048576),
      m('gemini-3-flash', [], ['vision'], 1048576),
      // --- gpt-5 family (vision)
      m('gpt-5.6-sol', [], ['vision'], 272000),
      m('gpt-5.6-terra', [], ['vision'], 272000),
      m('gpt-5.6-luna', ['gpt-5'], ['vision'], 272000),
      m('gpt-5.5', [], ['vision'], 272000),
      m('gpt-5.5-pro', [], ['vision'], 272000),
      m('gpt-5.4', [], ['vision'], 272000),
      m('gpt-5.4-pro', [], ['vision'], 272000),
      m('gpt-5.4-mini', ['gpt-mini'], ['vision'], 272000),
      m('gpt-5.4-nano', ['gpt-nano'], ['vision'], 272000),
      m('gpt-5.3-codex-spark', [], ['text'], 272000),
      m('gpt-5.3-codex', [], ['text'], 272000),
      m('gpt-5.2', [], ['vision'], 272000),
      m('gpt-5.2-codex', [], ['text'], 272000),
      m('gpt-5.1', [], ['vision'], 272000),
      m('gpt-5.1-codex-max', [], ['text'], 272000),
      m('gpt-5.1-codex', [], ['text'], 272000),
      m('gpt-5.1-codex-mini', [], ['text'], 272000),
      m('gpt-5', [], ['vision'], 272000),
      m('gpt-5-codex', [], ['text'], 272000),
      m('gpt-5-nano', [], ['vision'], 272000),
      // --- grok / misc
      m('grok-build-0.1', [], ['text'], 262144),
      m('grok-4.6', ['grok'], ['vision'], 262144),
      m('grok-4.5', ['grok-4'], ['vision'], 262144),
      m('muse-spark-1.2', ['muse'], ['text'], 131072),
      // --- deepseek / glm / minimax / kimi / qwen
      m('deepseek-v4-pro', ['deepseek-pro'], ['reasoning'], 131072),
      m('deepseek-v4-flash', ['deepseek-chat', 'deepseek-flash'], ['text'], 131072),
      m('glm-5.2', ['glm'], ['text'], 131072),
      m('glm-5.1', ['glm-5.1'], ['text'], 131072),
      m('glm-5', ['glm-5'], ['text'], 131072),
      m('minimax-m3', [], ['text'], 131072),
      m('minimax-m2.7', [], ['text'], 131072),
      m('minimax-m2.5', ['minimax'], ['text'], 131072),
      m('kimi-k3', ['kimi'], ['text'], 131072),
      m('kimi-k2.7-code', [], ['text'], 131072),
      m('kimi-k2.6', ['kimi-k2.6'], ['text'], 131072),
      m('kimi-k2.5', ['kimi-k2.5'], ['text'], 131072),
      m('qwen3.6-plus', ['qwen-plus'], ['reasoning'], 131072),
      m('qwen3.5-plus', ['qwen3.5'], ['text'], 131072),
      m('big-pickle', [], ['text'], 131072),
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini (AI Studio free)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'x-goog-api-key',
    apiKeyEnv: 'GEMINI_API_KEY',
    keyHeader: 'x-gemini-api-key',
    limits: { rpm: 10, rpd: 250, tpm: 250000, tpd: MAX },
    dayAnchorUtc: 8, // daily quota resets at midnight Pacific
    weight: 75,
    auto: {
      text: 'gemini-2.5-flash',
      vision: 'gemini-2.5-flash',
      audio: 'gemini-2.5-flash',
    },
    models: [
      m('gemini-2.5-flash', ['gemini-flash', 'flash'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-2.5-flash-lite', ['flash-lite'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 15,
        rpd: 1000,
        tpm: 250000,
      }),
      m('gemini-2.5-pro', ['gemini-pro'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 5,
        rpd: 100,
        tpm: 250000,
      }),
      m('gemini-2.0-flash', ['gemini-2.0'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 15,
        rpd: 1500,
        tpm: 1000000,
      }),
    ],
  },
  {
    // Catalog verified live 2026-08: the old :free lineup (llama-3.3-70b,
    // deepseek-chat/r1, qwen-vl, gemini-2.0-flash-exp) has been removed.
    id: 'openrouter',
    name: 'OpenRouter (:free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyHeader: 'x-openrouter-api-key',
    // :free models — 20 RPM, 50 RPD without purchased credits (1000 with >$10)
    limits: { rpm: 20, rpd: 50, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 70,
    auto: {
      text: 'nvidia/nemotron-3-super-120b-a12b:free',
      vision: 'nvidia/nemotron-nano-12b-v2-vl:free',
      audio: 'nvidia/nemotron-3-super-120b-a12b:free',
    },
    models: [
      m('nvidia/nemotron-3.5-lightning:free', ['nemotron-lightning'], ['text'], 1000000),
      m('nvidia/nemotron-3-ultra-550b-a55b:free', ['nemotron-ultra'], ['text'], 1000000),
      m('dots-studio/dots-3-note-preview:free', ['dots-note'], ['text'], 512000),
      m('poolside/laguna-s-2.1:free', ['laguna'], ['text'], 262144),
      m('poolside/laguna-xs-2.1:free', ['laguna-xs'], ['text'], 262144),
      m('google/gemma-4-26b-a4b-it:free', ['gemma-4-26b'], ['text'], 262144),
      m('google/gemma-4-31b-it:free', ['gemma-4'], ['text'], 262144),
      m('nvidia/nemotron-3-super-120b-a12b:free', ['nemotron'], ['text'], 262144),
      m('cohere/north-mini-code:free', ['north-mini-code'], ['text'], 256000),
      m('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', ['nemotron-omni-r'], ['reasoning'], 256000),
      m('nvidia/nemotron-3-nano-30b-a3b:free', ['nemotron-nano'], ['text'], 256000),
      m('openai/gpt-oss-20b:free', ['gpt-oss'], ['text'], 131072),
      m('liquid/lfm-2.5-2.6b:free', ['lfm'], ['text'], 128000),
      m('nvidia/nemotron-nano-12b-v2-vl:free', ['nemotron-vl'], ['vision'], 128000),
      m('nvidia/nemotron-nano-9b-v2:free', ['nemotron-nano-9b'], ['text'], 128000),
    ],
  },
  {
    // Same catalog as keyless zen, via the keyed gateway (separate quota).
    id: 'opencode',
    name: 'OpenCode Zen (with key)',
    baseUrl: 'https://api.opencode.ai/zen/v1',
    auth: 'bearer',
    apiKeyEnv: 'OPENCODE_API_KEY',
    keyHeader: 'x-opencode-api-key',
    // gateway limits are unpublished — conservative defaults, env-overridable
    limits: { rpm: 20, rpd: 500, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 70,
    auto: {
      text: 'deepseek-v4-flash-free',
      vision: 'gemini-3.5-flash',
      audio: 'deepseek-v4-flash-free',
    },
    models: [
      m('deepseek-v4-flash-free', ['deepseek-free'], ['text'], 131072),
      m('mimo-v2.5-free', ['mimo'], ['text'], 131072),
      m('hy3-free', ['hy3'], ['text'], 131072),
      m('nemotron-3-ultra-free', ['nemotron-free'], ['text'], 1000000),
      m('nemotron-3.5-lightning-free', ['nemotron-lightning-free'], ['text'], 1000000),
      m('laguna-s-2.1-free', ['laguna-free'], ['text'], 262144),
      m('claude-fable-5', [], ['vision'], 200000),
      m('claude-opus-5', ['opus'], ['vision', 'reasoning'], 200000),
      m('claude-opus-4-8', [], ['vision'], 200000),
      m('claude-opus-4-7', [], ['vision'], 200000),
      m('claude-opus-4-6', [], ['vision'], 200000),
      m('claude-opus-4-5', [], ['vision'], 200000),
      m('claude-sonnet-5', ['sonnet'], ['vision', 'reasoning'], 200000),
      m('claude-sonnet-4-6', [], ['vision'], 200000),
      m('claude-sonnet-4-5', [], ['vision'], 200000),
      m('claude-sonnet-4', ['claude'], ['vision'], 200000),
      m('claude-haiku-4-5', ['haiku'], ['vision'], 200000),
      m('gemini-3.6-flash', [], ['vision'], 1048576),
      m('gemini-3.7-flash', [], ['vision'], 1048576),
      m('gemini-3.5-flash-lite', [], ['vision'], 1048576),
      m('gemini-3.5-flash', ['gemini-flash'], ['vision'], 1048576),
      m('gemini-3.1-pro', ['gemini-pro'], ['vision', 'reasoning'], 1048576),
      m('gemini-3-flash', [], ['vision'], 1048576),
      m('gpt-5.6-sol', [], ['vision'], 272000),
      m('gpt-5.6-terra', [], ['vision'], 272000),
      m('gpt-5.6-luna', ['gpt-5'], ['vision'], 272000),
      m('gpt-5.5', [], ['vision'], 272000),
      m('gpt-5.5-pro', [], ['vision'], 272000),
      m('gpt-5.4', [], ['vision'], 272000),
      m('gpt-5.4-pro', [], ['vision'], 272000),
      m('gpt-5.4-mini', ['gpt-mini'], ['vision'], 272000),
      m('gpt-5.4-nano', ['gpt-nano'], ['vision'], 272000),
      m('gpt-5.3-codex-spark', [], ['text'], 272000),
      m('gpt-5.3-codex', [], ['text'], 272000),
      m('gpt-5.2', [], ['vision'], 272000),
      m('gpt-5.2-codex', [], ['text'], 272000),
      m('gpt-5.1', [], ['vision'], 272000),
      m('gpt-5.1-codex-max', [], ['text'], 272000),
      m('gpt-5.1-codex', [], ['text'], 272000),
      m('gpt-5.1-codex-mini', [], ['text'], 272000),
      m('gpt-5', [], ['vision'], 272000),
      m('gpt-5-codex', [], ['text'], 272000),
      m('gpt-5-nano', [], ['vision'], 272000),
      m('grok-build-0.1', [], ['text'], 262144),
      m('grok-4.6', ['grok'], ['vision'], 262144),
      m('grok-4.5', [], ['vision'], 262144),
      m('muse-spark-1.2', [], ['text'], 131072),
      m('deepseek-v4-pro', ['deepseek-pro'], ['reasoning'], 131072),
      m('deepseek-v4-flash', ['deepseek-chat', 'deepseek-flash'], ['text'], 131072),
      m('glm-5.2', ['glm'], ['text'], 131072),
      m('glm-5.1', [], ['text'], 131072),
      m('glm-5', [], ['text'], 131072),
      m('minimax-m3', [], ['text'], 131072),
      m('minimax-m2.7', [], ['text'], 131072),
      m('minimax-m2.5', ['minimax'], ['text'], 131072),
      m('kimi-k3', ['kimi'], ['text'], 131072),
      m('kimi-k2.7-code', [], ['text'], 131072),
      m('kimi-k2.6', [], ['text'], 131072),
      m('kimi-k2.5', [], ['text'], 131072),
      m('qwen3.6-plus', ['qwen-plus'], ['reasoning'], 131072),
      m('qwen3.5-plus', [], ['text'], 131072),
      m('big-pickle', [], ['text'], 131072),
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    auth: 'bearer',
    apiKeyEnv: 'NVIDIA_API_KEY',
    keyHeader: 'x-nvidia-api-key',
    // free developer: 40 RPM soft limit, 1000 one-time credits
    limits: { rpm: 40, rpd: MAX, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 60,
    auto: {
      text: 'meta/llama-3.3-70b-instruct',
      vision: 'meta/llama-3.3-70b-instruct',
      audio: 'meta/llama-3.3-70b-instruct',
    },
    models: [
      m('meta/llama-3.3-70b-instruct', ['llama-3.3-70b', 'llama-70b'], ['text'], 131072),
      m('meta/llama-3.1-8b-instruct', ['llama-3.1-8b', 'llama-8b'], ['text'], 131072),
      m('deepseek-ai/deepseek-r1', ['deepseek-r1', 'r1'], ['reasoning'], 131072),
      m('qwen/qwen2.5-coder-32b-instruct', ['qwen-coder'], ['text'], 131072),
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1',
    auth: 'bearer',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    keyHeader: 'x-sambanova-api-key',
    // free: 20 RPM, 20 RPD, 200K TPD — per model, per account
    limits: { rpm: 20, rpd: 20, tpm: MAX, tpd: 200000 },
    dayAnchorUtc: 0,
    weight: 55,
    auto: {
      text: 'Meta-Llama-3.3-70B-Instruct',
      vision: 'Meta-Llama-3.3-70B-Instruct',
      audio: 'Meta-Llama-3.3-70B-Instruct',
    },
    models: [
      m('Meta-Llama-3.3-70B-Instruct', ['llama-3.3-70b', 'llama-70b'], ['text'], 131072),
      m('Meta-Llama-3.1-8B-Instruct', ['llama-3.1-8b', 'llama-8b'], ['text'], 131072),
      m('DeepSeek-R1', ['deepseek-r1', 'r1'], ['reasoning'], 131072),
      m('QwQ-32B-Preview', ['qwq'], ['reasoning'], 32768),
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral (free experiment)',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'bearer',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyHeader: 'x-mistral-api-key',
    // free: ~1 RPS, 500K TPM, monthly token cap
    limits: { rpm: 60, rpd: MAX, tpm: 500000, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 50,
    auto: {
      text: 'mistral-small-latest',
      vision: 'mistral-small-latest',
      audio: 'mistral-small-latest',
    },
    models: [
      m('mistral-small-latest', ['mistral-small'], ['text'], 131072),
      m('open-mistral-nemo', ['mistral-nemo'], ['text'], 131072),
      m('codestral-latest', ['codestral'], ['text'], 262144),
      m('ministral-8b-latest', ['ministral'], ['text'], 131072),
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (self-hosted / tunnel)',
    baseUrl: '',
    auth: 'none',
    apiKeyEnv: 'OLLAMA_API_KEY',
    keyHeader: 'x-ollama-api-key',
    limits: { rpm: 60, rpd: MAX, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 45,
    auto: { text: 'llama3.2', vision: 'gemma3', audio: 'llama3.2' },
    models: [
      m('llama3.2', ['llama3.2'], ['text'], 131072),
      m('llama3.1:8b', ['llama3.1'], ['text'], 131072),
      m('qwen2.5', ['qwen2.5'], ['text'], 32768),
      m('gemma3', ['gemma3'], ['vision'], 131072),
    ],
  },
];

export const PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id));

// ------------------------------------------------------------------ helpers

function asStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function parseKeys(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** djb2 — stable across restarts, short enough to show in the dashboard. */
export function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

export interface KeyBucket {
  id: string;
  key: string | null;
}

/**
 * Buckets to try for a provider, in order: the client's own key first (its
 * quota is separate), then the shared env pool.
 */
export function bucketsFor(
  p: ProviderConfig,
  headers: Headers,
  env: Record<string, unknown>,
): KeyBucket[] {
  const envKeys = parseKeys(asStr(env[p.apiKeyEnv]));
  const out: KeyBucket[] = [];
  const override = p.keyHeader ? headers.get(p.keyHeader) : null;
  if (override) out.push({ id: `client:${hash8(override)}`, key: override });
  if (p.auth === 'none') {
    // keyless provider: one anonymous bucket, or key:0 if a key is configured
    if (envKeys.length > 0) out.push({ id: 'key:0', key: envKeys[0] ?? null });
    else out.push({ id: 'anonymous', key: null });
    return out;
  }
  envKeys.forEach((k, i) => out.push({ id: `key:${i}`, key: k }));
  return out;
}

/** Merge provider defaults ← model overrides ← env overrides. */
export function getModelLimits(
  p: ProviderConfig,
  modelId: string,
): Limits {
  const model = p.models.find((mm) => mm.id === modelId);
  return { ...p.limits, ...(model?.limits ?? {}), ...(p.envLimits ?? {}) };
}

function resolveProvider(
  p: ProviderConfig,
  env: Record<string, unknown>,
): ProviderConfig {
  const up = p.id.toUpperCase();
  const baseUrl = (asStr(env[`${up}_BASE_URL`]) ?? p.baseUrl).replace(/\/+$/, '');

  const envLimits: Partial<Limits> = {};
  for (const field of ['RPM', 'RPD', 'TPM', 'TPD'] as const) {
    const raw = asStr(env[`${up}_${field}`]);
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      envLimits[field.toLowerCase() as keyof Limits] = n;
    }
  }

  // Ollama models are whatever the user has pulled; env can override the list.
  let models = p.models;
  if (p.id === 'ollama') {
    const names = parseKeys(asStr(env.OLLAMA_MODELS));
    if (names.length > 0) {
      models = names.map((n) => m(n, [], ['text'], 131072));
    }
  }

  const keys = parseKeys(asStr(env[p.apiKeyEnv]));

  let disabled = false;
  let disabledReason: string | undefined;
  if (p.id === 'ollama') {
    disabled = baseUrl === '';
    disabledReason = disabled ? 'set OLLAMA_BASE_URL (e.g. your tunnel URL)' : undefined;
  } else if (p.auth !== 'none' && keys.length === 0 && !p.keyHeader) {
    disabled = true;
    disabledReason = `set ${p.apiKeyEnv} secret`;
  }

  return {
    ...p,
    baseUrl,
    models,
    limits: { ...p.limits, ...envLimits },
    envLimits,
    disabled,
    disabledReason,
  };
}

export function getProviders(env: Record<string, unknown>): ProviderConfig[] {
  return PROVIDERS.map((p) => resolveProvider(p, env));
}

export function providerById(
  providers: ProviderConfig[],
  id: string,
): ProviderConfig | undefined {
  return providers.find((p) => p.id === id);
}
