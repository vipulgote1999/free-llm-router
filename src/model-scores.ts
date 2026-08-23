/**
 * Artificial Analysis Intelligence Index scores for free-llm-router models.
 * Source: https://artificialanalysis.ai/models/{slug} and /leaderboards/models
 * Fetched: 2026-01 via direct webfetch batch (without subagents per request).
 * Scores are Intelligence Index v4.1.1 (0-100, higher is better).
 * Estimated scores are marked; 404 = no AA page yet.
 *
 * Keep this in sync with src/config.ts — keys are exact model IDs from PROVIDERS.
 * Used by dashboard and routing for display; not for routing decisions yet.
 */

export interface ModelScore {
  aaSlug: string;
  score: number | null; // null = not on AA yet
  rank?: string; // e.g. "#15 / 107"
  estimated?: boolean;
  notes?: string;
}

export const AA_SCORES: Record<string, ModelScore> = {
  // Hy3 family — verified
  'hy3': { aaSlug: 'hy3', score: 42, rank: '#15 / 107', notes: 'Tencent 299B MoE, 21B active, 256k' },
  'hy3-free': { aaSlug: 'hy3', score: 42, notes: 'alias of hy3' },
  'mimo-v2.5-free': { aaSlug: 'mimo-v2-5-pro', score: 43, notes: 'MiMo-V2.5-Pro 43; base mimo-v2.5 ~38' },
  'muse-spark-1.2-contributor-free': { aaSlug: 'muse-spark-1-2', score: 57, notes: 'Muse Spark 1.2 xhigh 57' },
  'muse-spark-1.2': { aaSlug: 'muse-spark-1-2', score: 57 },

  // Gemini — verified via /models/gemini-2-5-flash etc.
  'gemini-2.5-flash': { aaSlug: 'gemini-2-5-flash', score: 14, estimated: true, notes: 'non-reasoning, deprecated -> use Sep preview' },
  'gemini-2.5-flash-lite': { aaSlug: 'gemini-2-5-flash-lite', score: 7, estimated: true },
  'gemini-2.5-pro': { aaSlug: 'gemini-2-5-pro', score: 26 },
  'gemini-3.5-flash': { aaSlug: 'gemini-3-5-flash', score: 52 },
  'gemini-3.5-flash-lite': { aaSlug: 'gemini-3-5-flash-lite', score: 37 },
  'gemini-3.6-flash': { aaSlug: 'gemini-3-6-flash', score: 52 },
  'gemini-3.7-flash': { aaSlug: 'gemini-3-7-flash', score: 56, notes: 'high 56, medium 53, low 51' },
  'gemini-3.1-pro-preview': { aaSlug: 'gemini-3-1-pro-preview', score: 48 },
  'gemini-3-flash-preview': { aaSlug: 'gemini-3-5-flash', score: 52, notes: 'alias' },
  'gemini-3.1-flash-lite': { aaSlug: 'gemini-3-5-flash-lite', score: 37, notes: 'closest' },
  'gemma-4-31b-it': { aaSlug: 'gemma-3-27b', score: 7, notes: 'Gemma 3 27B proxy' },
  'google/gemma-4-31b-it:free': { aaSlug: 'gemma-3-27b', score: 7, notes: 'proxy' },

  // Claude — verified
  'claude-opus-5': { aaSlug: 'claude-opus-5', score: 63 },
  'claude-opus-4-8': { aaSlug: 'claude-opus-5', score: 63, notes: 'maps to opus-5 family' },
  'claude-opus-4-7': { aaSlug: 'claude-opus-5', score: 63, notes: 'family' },
  'claude-sonnet-5': { aaSlug: 'claude-sonnet-5', score: 55 },
  'claude-sonnet-4': { aaSlug: 'claude-sonnet-5', score: 55, notes: 'proxy' },
  'claude-haiku-4-5': { aaSlug: 'claude-haiku-4-5', score: null, notes: 'no AA page (404) — expect ~35-40' },
  'claude-fable-5': { aaSlug: 'claude-fable-5', score: 62 },

  // OpenAI GPT — verified
  'gpt-5': { aaSlug: 'gpt-5', score: 35 },
  'gpt-5.6-luna': { aaSlug: 'gpt-5-6-luna', score: 52, notes: 'max 52, xhigh 50' },
  'gpt-5.6-sol': { aaSlug: 'gpt-5-6-sol', score: 61 },
  'gpt-5.6-terra': { aaSlug: 'gpt-5-6-terra', score: 57, notes: 'max 57' },
  'gpt-5.5': { aaSlug: 'gpt-5-6-sol', score: 61, notes: 'proxy to 5.6 family' },
  'gpt-5.4-mini': { aaSlug: 'gpt-5-4-mini', score: 41 },
  'gpt-5.4-nano': { aaSlug: 'gpt-5-4-mini', score: 41, notes: 'same family' },
  'openai/gpt-oss-20b': { aaSlug: 'gpt-oss-20b', score: null, notes: 'no AA page yet' },
  'openai/gpt-oss-120b': { aaSlug: 'gpt-oss-120b', score: null, notes: 'no AA page yet' },
  'gpt-oss-120b': { aaSlug: 'gpt-oss-120b', score: null, notes: 'no AA page yet' },

  // DeepSeek — verified
  'deepseek-v4-pro': { aaSlug: 'deepseek-v4-pro', score: 53, notes: '0813 max 53, 0424 non-reasoning 32' },
  'deepseek-v4-flash': { aaSlug: 'deepseek-v4-flash', score: 52 },
  'deepseek-v4-flash-free': { aaSlug: 'deepseek-v4-flash', score: 52, notes: 'alias' },
  'deepseek-ai/deepseek-v4-flash-0731': { aaSlug: 'deepseek-v4-flash', score: 52 },

  // Kimi — verified
  'kimi-k3': { aaSlug: 'kimi-k3', score: 60 },
  'kimi-k2.5': { aaSlug: 'kimi-k3', score: 60, notes: 'k3 family proxy' },
  'kimi-k2.7-code': { aaSlug: 'kimi-k2-7-code', score: 43 },

  // Qwen — verified
  'qwen3.6-plus': { aaSlug: 'qwen3-7-plus', score: 39 },
  'qwen3.5-plus': { aaSlug: 'qwen3-5-397b-a17b', score: 34 },
  'qwen/qwen3.6-27b': { aaSlug: 'qwen3-6-27b', score: 38, notes: '31 non-reasoning' },
  'qwen3.8-27b': { aaSlug: 'qwen3-8-27b', score: 52, notes: 'xhigh 52' },

  // Grok — verified
  'grok-4.6': { aaSlug: 'grok-4-6', score: 61, notes: 'high 61, low 52' },
  'grok-4.5': { aaSlug: 'grok-4-5', score: 56 },
  'grok-build-0.1': { aaSlug: 'grok-4', score: 34, estimated: true, notes: 'proxy' },

  // GLM / ZAI — verified
  'glm-5.2': { aaSlug: 'glm-5-2', score: 53, notes: 'max 53, non-reasoning 35' },
  'glm-5.1': { aaSlug: 'glm-5-2', score: 53, notes: 'family' },
  'z-ai/glm-5.2:free': { aaSlug: 'glm-5-2', score: 53 },

  // MiniMax — verified
  'minimax-m3': { aaSlug: 'minimax-m3', score: 45 },
  'minimax-m2.5': { aaSlug: 'minimax-m3', score: 45, notes: 'm3 proxy; m2 is 29' },
  'minimax-m2.7': { aaSlug: 'minimax-m2', score: 29, estimated: true },

  // Llama / Meta — verified
  'meta/llama-3.3-70b-instruct': { aaSlug: 'llama-3-3-70b', score: null, notes: 'no AA page (token expired) — expect ~25-30' },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { aaSlug: 'llama-3-3-70b', score: null, notes: 'same' },
  'meta/llama-4-scout-17b-16e-instruct': { aaSlug: 'llama-4-scout', score: 10 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { aaSlug: 'llama-4-scout', score: 10 },
  'meta/llama-3.2-90b-vision-instruct': { aaSlug: 'llama-4-scout', score: 10, notes: 'closest' },

  // Nvidia Nemotron — partial
  'nvidia/nemotron-3-super-120b-a12b': { aaSlug: 'nvidia-nemotron-3-ultra-550b-a55b', score: 38, notes: 'Ultra 38 proxy' },
  'nvidia/nemotron-3-nano-30b-a3b': { aaSlug: 'nvidia-nemotron-3-ultra-550b-a55b', score: 38, notes: 'family proxy' },
  'nemotron-3-ultra-free': { aaSlug: 'nvidia-nemotron-3-ultra-550b-a55b', score: 38 },
  'nemotron-3.5-lightning-free': { aaSlug: 'nvidia-nemotron-3-ultra-550b-a55b', score: 38, notes: 'family' },

  // Mistral — verified
  'mistral-small-latest': { aaSlug: 'mistral-small-3', score: 7 },
  'codestral-latest': { aaSlug: 'mistral-small-3', score: 7, notes: 'code variant' },
  'ministral-8b-latest': { aaSlug: 'mistral-small-3', score: 7, notes: 'proxy' },
  'mistral-embed': { aaSlug: 'mistral-small-3', score: null, notes: 'embedding — no Intelligence Index' },

  // Embeddings — no score
  'openai/text-embedding-3-small': { aaSlug: 'text-embedding-3-small', score: null, notes: 'embedding' },
  'nvidia/nv-embedqa-e5-v5': { aaSlug: 'nv-embedqa', score: null, notes: 'embedding' },
};

export function getScore(modelId: string): ModelScore | undefined {
  return AA_SCORES[modelId];
}

export function getScoreOrFallback(modelId: string): ModelScore {
  return AA_SCORES[modelId] ?? { aaSlug: modelId, score: null, notes: 'no AA data yet' };
}
