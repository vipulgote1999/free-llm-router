/**
 * Provider registry — the single source of truth for endpoints, auth styles,
 * model tables, capabilities, and free-tier limits. All limits are env-
 * overridable (e.g. GROQ_RPM) because providers change them over time.
 * Verify this against live provider catalogs with: node scripts/verify-models.mjs
 */

import type { Capability, Limits, ModelInfo, ProviderConfig } from './types';
import { UNLIMITED } from './windows';
import { MPX_CATALOG } from './mpx-catalog.generated';
import { normalizeModelId } from './mpx';
import {
  isFreeZenModel,
  modelInfosForFreeIds,
  parseEnvModelList,
} from './zen';

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
      m('@cf/baai/bge-base-en-v1.5', ['bge-base', 'bge-embeddings'], ['embeddings'], 512),
      m('@cf/baai/bge-m3', ['bge-m3'], ['embeddings'], 8192),
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
      m('openai/gpt-oss-20b', ['gpt-oss-20b'], ['text'], 131072, {
        rpm: 30,
        rpd: 1000,
        tpm: 8000,
        tpd: 100000,
      }),
      m('openai/gpt-oss-120b', ['gpt-oss-120b', 'gpt-oss'], ['text'], 131072, {
        rpm: 30,
        rpd: 1000,
        tpm: 8000,
        tpd: 200000,
      }),
      m('qwen/qwen3.6-27b', ['qwen3.6'], ['text'], 131072),
      m('allam-2-7b', ['allam'], ['text'], 131072),
      m('groq/compound', ['compound'], ['text'], 131072),
      m('groq/compound-mini', ['compound-mini'], ['text'], 131072),
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
    auto: { text: 'gpt-oss-120b', vision: 'gpt-oss-120b', audio: 'gpt-oss-120b' },
    models: [
      m('gpt-oss-120b', ['gpt-oss'], ['text'], 131072),
      m('gemma-4-31b', ['gemma-4'], ['text'], 262144),
    ],
  },
  {
    // Catalog verified live 2026-08: keyless zen only serves the *-free
    // tier — everything else returns 401 Missing API key. Only free models
    // are registered so the router never wastes hops on key-required ones.
    // Go key reuse: when OPENCODE_API_KEY is set, zen also sends it as
    // Bearer (same gateway, separate quota) so free models avoid the
    // IP-based 100/day limit.
    id: 'zen',
    name: 'OpenCode Zen (keyless + Go key when set)',
    baseUrl: 'https://opencode.ai/zen/v1',
    auth: 'none',
    apiKeyEnv: 'OPENCODE_API_KEY',
    keyHeader: 'x-opencode-api-key',
    // ~100 requests/day per IP on the free tier
    limits: { rpm: 10, rpd: 100, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 130,
    auto: {
      text: 'deepseek-v4-flash-free',
      vision: 'deepseek-v4-flash-free',
      audio: 'deepseek-v4-flash-free',
    },
    models: [
      m('big-pickle', ['pickle'], ['text'], 131072),
      m('deepseek-v4-flash-free', ['deepseek-free', 'deepseek-chat', 'deepseek'], ['text'], 131072),
      m('x-preview-f-free', ['x-free', 'x-preview'], ['text'], 131072),
      m('muse-spark-1.2-contributor-free', ['muse-contributor-free', 'muse-spark'], ['text'], 131072),
      m('mimo-v2.5-free', ['mimo'], ['text'], 131072),
      m('hy3-free', ['hy3'], ['text'], 131072),
      m('nemotron-3-ultra-free', ['nemotron-free', 'nemotron-ultra'], ['text'], 1000000),
      m('nemotron-3.5-lightning-free', ['nemotron-lightning-free', 'nemotron-lightning'], ['text'], 1000000),
      m('laguna-s-2.1-free', ['laguna-free', 'laguna'], ['text'], 262144),
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini (AI Studio free)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // the OpenAI-compat layer accepts Bearer, not x-goog-api-key (verified live)
    auth: 'bearer',
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
      m('gemma-4-31b-it', ['gemma-4'], ['vision', 'text'], 262144, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-flash-latest', ['flash-latest'], ['vision', 'audio', 'text'], 1048576),
      m('gemini-flash-lite-latest', ['flash-lite-latest'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 15,
        rpd: 1000,
      }),
      m('gemini-pro-latest', ['pro-latest'], ['vision', 'audio', 'text'], 1048576, {
        rpm: 5,
        rpd: 100,
      }),
      m('gemini-3-flash-preview', ['gemini-3-flash'], ['vision', 'text'], 1048576, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-3.1-flash-lite', ['gemini-3-flash-lite'], ['vision', 'text'], 1048576, {
        rpm: 15,
        rpd: 1000,
        tpm: 250000,
      }),
      m('gemini-3.5-flash-lite', [], ['vision', 'text'], 1048576, {
        rpm: 15,
        rpd: 1000,
        tpm: 250000,
      }),
      m('gemini-3.5-flash', [], ['vision', 'text'], 1048576, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-3.6-flash', [], ['vision', 'text'], 1048576, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-3.7-flash', [], ['vision', 'text'], 1048576, {
        rpm: 10,
        rpd: 250,
        tpm: 250000,
      }),
      m('gemini-3.1-pro-preview', ['gemini-3-pro'], ['vision', 'text'], 1048576, {
        rpm: 5,
        rpd: 100,
        tpm: 250000,
      }),
      m('gemini-embedding-001', ['gemini-embedding', 'gemini-embed', 'text-embedding'], ['embeddings'], 8192),
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
      m('z-ai/glm-5.2:free', ['glm-5.2', 'glm-free'], ['text'], 131072),
    ],
  },
  {
    // Gateway requires no key for its free pool; a key raises quota. Free
    // models are the `:free`/`-free`/`/free` ids in the ModelPulseX catalog.
    id: 'kilocode',
    name: 'Kilo Code Gateway (free models)',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    auth: 'none',
    apiKeyEnv: 'KILOCODE_API_KEY',
    keyHeader: 'x-kilocode-api-key',
    // ModelPulseX caps scheduler concurrency at 10 RPM; ~200 req/hr documented.
    limits: { rpm: 10, rpd: 200, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 65,
    auto: { text: 'kilo-auto/free', vision: 'kilo-auto/free', audio: 'kilo-auto/free' },
    // Free models are appended from the checked-in ModelPulseX catalog.
    models: [],
  },
  {
    // Ollama's public cloud (not the self-hosted `ollama` provider). Only the
    // allowlist below is free; everything else requires a subscription.
    id: 'ollama_cloud',
    name: 'Ollama Cloud (free allowlist)',
    baseUrl: 'https://ollama.com/v1',
    auth: 'bearer',
    apiKeyEnv: 'OLLAMA_API_KEY',
    keyHeader: null,
    // No published free-tier numbers — conservative, env-overridable.
    limits: { rpm: 10, rpd: 100, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 40,
    auto: { text: 'gemma4:31b', vision: 'gemma4:31b', audio: 'gemma4:31b' },
    models: [
      m('gemma4:31b', [], ['text'], 131072),
      m('minimax-m3', ['ollama-minimax-m3'], ['text'], 128000),
      m('gpt-oss:20b', [], ['text'], 131072),
      m('gpt-oss:120b', [], ['text'], 131072),
      m('nemotron-3-super', [], ['text'], 128000),
      m('nemotron-3-ultra', [], ['text'], 128000),
      m('nemotron-3-nano:30b', [], ['text'], 128000),
    ],
  },
  {
    // Same catalog as keyless zen, via the keyed gateway (separate quota).
    id: 'opencode',
    name: 'OpenCode Zen (with key)',
    baseUrl: 'https://opencode.ai/zen/v1',
    auth: 'bearer',
    apiKeyEnv: 'OPENCODE_API_KEY',
    keyHeader: 'x-opencode-api-key',
    // gateway limits are unpublished — conservative defaults, env-overridable
    limits: { rpm: 20, rpd: 500, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 125,
    auto: {
      text: 'deepseek-v4-flash-free',
      vision: 'gemini-3.5-flash',
      audio: 'deepseek-v4-flash-free',
    },
    models: [
      m('big-pickle', ['pickle'], ['text'], 131072),
      m('deepseek-v4-flash-free', ['deepseek-free', 'deepseek-chat', 'deepseek'], ['text'], 131072),
      m('x-preview-f-free', ['x-free', 'x-preview'], ['text'], 131072),
      m('muse-spark-1.2-contributor-free', ['muse-contributor-free', 'muse-spark'], ['text'], 131072),
      m('mimo-v2.5-free', ['mimo'], ['text'], 131072),
      m('hy3-free', ['hy3'], ['text'], 131072),
      m('nemotron-3-ultra-free', ['nemotron-free', 'nemotron-ultra'], ['text'], 1000000),
      m('nemotron-3.5-lightning-free', ['nemotron-lightning-free', 'nemotron-lightning'], ['text'], 1000000),
      m('laguna-s-2.1-free', ['laguna-free', 'laguna'], ['text'], 262144),
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
      m('gpt-5.6-luna', ['gpt-5.6'], ['vision'], 272000),
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
      m('deepseek-v4-flash', ['deepseek-flash'], ['text'], 131072),
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
      vision: 'nvidia/nemotron-nano-12b-v2-vl',
      audio: 'meta/llama-3.3-70b-instruct',
    },
    models: [
      m('meta/llama-3.3-70b-instruct', ['llama-3.3-70b', 'llama-70b'], ['text'], 131072),
      m('meta/llama-3.1-8b-instruct', ['llama-3.1-8b', 'llama-8b'], ['text'], 131072),
      m('nvidia/nemotron-3-super-120b-a12b', ['nemotron'], ['text'], 262144),
      m('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', ['nemotron-omni-r'], ['reasoning'], 256000),
      m('nvidia/nemotron-nano-12b-v2-vl', ['nemotron-vl'], ['vision'], 128000),
      m('nvidia/llama-3.3-nemotron-super-49b-v1.5', ['nemotron-49b'], ['text'], 131072),
      m('deepseek-ai/deepseek-v4-flash-0731', ['deepseek-chat', 'deepseek-flash'], ['text'], 131072),
      m('google/gemma-4-31b-it', ['gemma-4'], ['text'], 262144),
      m('minimaxai/minimax-m3', ['minimax'], ['text'], 131072),
      m('meta/muse-glimmer-30b', ['muse'], ['text'], 131072),
      m('meta/llama-3.2-90b-vision-instruct', ['llama-vision-90b'], ['vision'], 131072),
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
      // verified live: only the Llama-3.3 endpoint is on the free tier;
      // DeepSeek/MiniMax/gemma/gpt-oss return 402 PAYMENT_METHOD_REQUIRED
      m('Meta-Llama-3.3-70B-Instruct', ['llama-3.3-70b', 'llama-70b'], ['text'], 131072),
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
      m('codestral-latest', ['codestral'], ['text'], 262144),
      m('ministral-8b-latest', ['ministral'], ['text'], 131072),
      m('ministral-3b-latest', ['ministral-3b'], ['text'], 131072),
      m('mistral-medium-latest', ['mistral-medium'], ['text'], 131072),
      m('magistral-small-latest', ['magistral'], ['text'], 131072),
      m('mistral-embed', ['embed-mistral'], ['embeddings'], 8192),
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
      m('llama3.2', [], ['text'], 131072),
      m('llama3.1:8b', ['llama3.1'], ['text'], 131072),
      m('qwen2.5', [], ['text'], 32768),
      m('gemma3', [], ['vision'], 131072),
      m('nomic-embed-text', ['nomic-embed'], ['embeddings'], 8192),
    ],
  },
  {
    id: 'truerouter',
    name: 'TrueRouter (TokenRouter free)',
    baseUrl: 'https://api.tokenrouter.com/v1',
    auth: 'bearer',
    apiKeyEnv: 'TRUEROUTER_API_KEY',
    keyHeader: 'x-truerouter-api-key',
    // free tier on TokenRouter — conservative defaults, env-overridable
    limits: { rpm: 20, rpd: 200, tpm: MAX, tpd: MAX },
    dayAnchorUtc: 0,
    weight: 50,
    auto: { text: 'llama3.1:8b', vision: 'llama3.1:8b', audio: 'llama3.1:8b' },
    models: [
      m('llama3.1:8b', ['llama3.1', 'llama-8b'], ['text'], 131072),
      m('qwen2.5-coder:7b', ['qwen2.5-coder', 'qwen-coder'], ['text'], 131072),
    ],
  },
];

export const PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id));

/**
 * Exact model ids (and the aliases the router derives for them) that exist
 * only in the checked-in ModelPulseX catalog. They are merged into provider
 * catalogs at request time, so `parseModelSpec` must recognize them too —
 * otherwise ids like `openrouter/free` get split into provider `openrouter`
 * + model `free`.
 */
const MPX_MODEL_IDS: Set<string> = new Set();
for (const row of MPX_CATALOG) {
  MPX_MODEL_IDS.add(normalizeModelId(row.id));
  for (const alias of derivedAliases(row.id)) MPX_MODEL_IDS.add(alias);
}

/** True when the string is a registered model id or alias on any provider. */
export function isKnownModelId(id: string): boolean {
  if (MPX_MODEL_IDS.has(id)) return true;
  return PROVIDERS.some(
    (p) => p.models.some((m) => m.id === id || m.aliases.includes(id)),
  );
}

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

// ------------------------------------------------------------- ModelPulseX catalog

const VALID_CAPABILITIES = new Set<Capability>(['text', 'vision', 'audio', 'reasoning', 'embeddings']);

function sanitizeCapabilities(caps: string[]): Capability[] {
  const out = caps.filter((c): c is Capability => VALID_CAPABILITIES.has(c as Capability));
  return out.length > 0 ? out : ['text'];
}

/** Derived aliases for a model we only know through ModelPulseX discovery. */
function derivedAliases(id: string): string[] {
  const base = id.replace(/:free$/, '').replace(/-free$/, '');
  return base && base !== id ? [base] : [];
}

const MPX_BY_PROVIDER = new Map<string, typeof MPX_CATALOG>();
for (const row of MPX_CATALOG) {
  const list = MPX_BY_PROVIDER.get(row.provider) ?? [];
  list.push(row);
  MPX_BY_PROVIDER.set(row.provider, list);
}
// OpenCode's keyed gateway exposes the same catalog as keyless Zen.
const ZEN_ROWS = MPX_BY_PROVIDER.get('zen');
if (ZEN_ROWS && ZEN_ROWS.length > 0 && !MPX_BY_PROVIDER.has('opencode')) {
  MPX_BY_PROVIDER.set('opencode', ZEN_ROWS);
}

function findMpxRow(rows: typeof MPX_CATALOG, modelId: string) {
  const id = normalizeModelId(modelId);
  return rows.find((r) => normalizeModelId(r.id) === id);
}

/**
 * Merge the checked-in ModelPulseX catalog into a provider's models.
 * - FREE + active models missing from the registry are appended.
 * - PREVIOUSLY_FREE models already in the registry are marked `free: false`.
 * - Explicit models are never removed.
 */
function mergeMpxModels(providerId: string, models: ModelInfo[]): ModelInfo[] {
  const rows = MPX_BY_PROVIDER.get(providerId);
  if (!rows || rows.length === 0) return models;

  const byId = new Map(models.map((m) => [m.id, m]));
  for (const row of rows) {
    const id = normalizeModelId(row.id);
    const existing = byId.get(id);
    if (row.freeStatus === 'PREVIOUSLY_FREE') {
      if (existing) byId.set(id, { ...existing, free: false });
      continue;
    }
    if (row.freeStatus !== 'FREE' || !row.active) continue;
    if (existing) {
      byId.set(id, { ...existing, free: true, context: existing.context || row.context });
      continue;
    }
    byId.set(id, {
      id,
      aliases: derivedAliases(id),
      capabilities: sanitizeCapabilities(row.capabilities),
      context: row.context || 131_072,
      free: true,
    });
  }
  return [...byId.values()];
}

function staticFree(providerId: string, modelId: string): boolean {
  if (providerId === 'zen' || providerId === 'opencode') return isFreeZenModel(modelId);
  if (providerId === 'openrouter') return modelId.endsWith(':free') || modelId === 'openrouter/free';
  return true;
}

/**
 * True when `auto` may route to this model. ModelPulseX is authoritative for
 * providers it covers; unlisted models there are not verified free. Providers
 * with no MPX data keep the static free-tier heuristic.
 */
export function isFreeForAuto(p: ProviderConfig, modelId: string): boolean {
  const model = p.models.find((m) => m.id === modelId || m.aliases.includes(modelId));
  if (!model) return false;
  if (model.free === false) return false;

  const rows = MPX_BY_PROVIDER.get(p.id);
  if (rows && rows.length > 0) {
    const row = findMpxRow(rows, model.id);
    return row ? row.freeStatus === 'FREE' && row.active : false;
  }
  return staticFree(p.id, model.id);
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
  let customOllamaModels = false;
  if (p.id === 'ollama') {
    const names = parseKeys(asStr(env.OLLAMA_MODELS));
    if (names.length > 0) {
      models = names.map((n) => m(n, [], ['text'], 131072));
      customOllamaModels = true;
    }
  }

  // Zen keyless: dynamic free-model pickup. If ZEN_FREE_MODELS is set
  // (comma-separated, e.g. from a cron that fetched /zen/v1/models),
  // use it; otherwise fall back to the static registry. Only *-free
  // plus big-pickle are accepted so paid models are never tried
  // keyless (they would 401).
  if (p.id === 'zen') {
    const envList = parseEnvModelList(asStr(env.ZEN_FREE_MODELS));
    if (envList.length > 0) {
      const free = envList.filter(isFreeZenModel);
      if (free.length > 0) models = modelInfosForFreeIds(free);
    }
  }

  // OpenCode (keyed) — same free pool plus paid catalog. If
  // OPENCODE_FREE_MODELS is set, replace only the free subset
  // dynamically while keeping the paid models static.
  if (p.id === 'opencode') {
    const envList = parseEnvModelList(
      asStr(env.OPENCODE_FREE_MODELS) ?? asStr(env.ZEN_FREE_MODELS),
    );
    if (envList.length > 0) {
      const free = envList.filter(isFreeZenModel);
      if (free.length > 0) {
        const freeInfos = modelInfosForFreeIds(free);
        const paidInfos = p.models.filter((mm) => !isFreeZenModel(mm.id));
        models = [...freeInfos, ...paidInfos];
      }
    }
  }

  const keys = parseKeys(asStr(env[p.apiKeyEnv]));

  // Checked-in ModelPulseX catalog: add verified-free models, mark retired ones.
  // An explicit OLLAMA_MODELS list describes the operator's own host, so leave it alone.
  if (!customOllamaModels) models = mergeMpxModels(p.id, models);

  // OpenCode with key gets first priority over keyless zen — separate quota
  let weight = p.weight;
  if (p.id === 'opencode' && keys.length > 0) weight = 135;

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
    weight,
    limits: { ...p.limits, ...envLimits },
    envLimits,
    disabled,
    disabledReason,
  };
}

export function getProviders(env: Record<string, unknown>): ProviderConfig[] {
  return PROVIDERS.map((p) => resolveProvider(p, env));
}

// ------------------------------------------------------------- runtime overrides

/**
 * Admin-editable per-provider overrides. Persisted in VaultDO storage so they
 * survive sessions and redeploys; merged on top of the static registry at
 * request time. `auto.*` swaps which model serves text/vision/audio routing;
 * `limits` clamps the free-tier windows (same semantics as <PROVIDER>_RPM env).
 */
export interface RuntimeOverrides {
  enabled?: boolean;
  weight?: number;
  autoText?: string;
  autoVision?: string;
  autoAudio?: string;
  limits?: Partial<Limits>;
}

export type RuntimeConfig = Record<string, RuntimeOverrides>;

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Validate one provider's override payload — unknown fields are dropped. */
export function sanitizeRuntimeOverride(raw: unknown): RuntimeOverrides {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: RuntimeOverrides = {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  const weight = num(src.weight);
  if (weight !== undefined) out.weight = weight;
  for (const [key, field] of [
    ['autoText', 'autoText'],
    ['autoVision', 'autoVision'],
    ['autoAudio', 'autoAudio'],
  ] as const) {
    if (typeof src[key] === 'string' && (src[key] as string).length <= 200) {
      out[field] = src[key] as string;
    }
  }
  if (src.limits && typeof src.limits === 'object') {
    const lim: Partial<Limits> = {};
    for (const f of ['rpm', 'rpd', 'tpm', 'tpd'] as const) {
      const v = num((src.limits as Record<string, unknown>)[f]);
      if (v !== undefined) lim[f] = v;
    }
    if (Object.keys(lim).length > 0) out.limits = lim;
  }
  return out;
}

/**
 * Merge runtime overrides onto resolved providers. Unknown provider ids and
 * empty overrides pass through untouched. Pure — unit-tested directly.
 */
export function applyRuntimeOverrides(
  providers: ProviderConfig[],
  overrides: RuntimeConfig | undefined,
): ProviderConfig[] {
  if (!overrides || typeof overrides !== 'object') return providers;
  return providers.map((p) => {
    const o = sanitizeRuntimeOverride(overrides[p.id]);
    if (Object.keys(o).length === 0) return p;
    const wasDisabled = p.disabled;
    const next: ProviderConfig = { ...p };
    if (o.enabled === false) {
      next.disabled = true;
      next.disabledReason = next.disabledReason ?? 'disabled via admin config';
    } else if (o.enabled === true) {
      // admin explicitly re-enabled — clear a config-disable but keep
      // infrastructural disables (missing keys / missing base URL)
      if (next.disabledReason?.includes('admin config')) {
        next.disabled = false;
        next.disabledReason = undefined;
      }
    }
    if (o.weight !== undefined && !wasDisabled) next.weight = o.weight;
    const auto = { ...p.auto };
    if (o.autoText) auto.text = o.autoText;
    if (o.autoVision) auto.vision = o.autoVision;
    if (o.autoAudio) auto.audio = o.autoAudio;
    next.auto = auto;
    const autoOverride = { ...(p.autoOverride ?? {}) };
    if (o.autoText) autoOverride.text = true;
    if (o.autoVision) autoOverride.vision = true;
    if (o.autoAudio) autoOverride.audio = true;
    if (Object.keys(autoOverride).length > 0) next.autoOverride = autoOverride;
    if (o.limits) {
      next.limits = { ...p.limits, ...o.limits };
      next.envLimits = { ...(p.envLimits ?? {}), ...o.limits };
      next.models = p.models.map((mm) =>
        o.limits && Object.keys(o.limits).length > 0
          ? { ...mm, limits: { ...mm.limits, ...o.limits } }
          : mm,
      );
    }
    return next;
  });
}

export function providerById(
  providers: ProviderConfig[],
  id: string,
): ProviderConfig | undefined {
  return providers.find((p) => p.id === id);
}
