/**
 * Shared types for the router. OpenAI-compatible shapes on the wire.
 */

export type Capability = 'text' | 'vision' | 'audio' | 'reasoning' | 'embeddings';

export interface ChatPart {
  type: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content: string | ChatPart[] | null;
  [key: string]: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  fallbacks?: unknown;
  num_retries?: number;
  [key: string]: unknown;
}

export interface CompletionRequest {
  model?: string;
  prompt?: string | string[];
  stream?: boolean;
  max_tokens?: number;
  fallbacks?: unknown;
  num_retries?: number;
  [key: string]: unknown;
}

export interface EmbeddingRequest {
  model?: string;
  input?: string | string[] | number[] | number[][];
  encoding_format?: string;
  fallbacks?: unknown;
  num_retries?: number;
  [key: string]: unknown;
}

export interface GenericRequest {
  model?: string;
  fallbacks?: unknown;
  num_retries?: number;
  [key: string]: unknown;
}

export interface Limits {
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
}

export interface ModelInfo {
  /** model id sent upstream */
  id: string;
  /** names clients may use to ask for this model */
  aliases: string[];
  capabilities: Capability[];
  /** context window in tokens */
  context: number;
  /** per-model free-tier limits (falls back to provider defaults) */
  limits?: Partial<Limits>;
}

export type ProviderId =
  | 'groq'
  | 'gemini'
  | 'openrouter'
  | 'zen'
  | 'opencode'
  | 'cerebras'
  | 'sambanova'
  | 'nvidia'
  | 'mistral'
  | 'ollama'
  | 'cloudflare'
  | 'truerouter';

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  /** OpenAI-compatible base, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  /** how the upstream expects credentials */
  auth: 'bearer' | 'x-goog-api-key' | 'none';
  /** env var holding comma-separated keys */
  apiKeyEnv: string;
  /** header for per-request client-supplied keys (null = not supported) */
  keyHeader: string | null;
  limits: Limits;
  /** UTC hour at which the provider resets its daily quota */
  dayAnchorUtc: number;
  /** higher = tried first */
  weight: number;
  /** default models picked for auto-routing */
  auto: { text: string; vision: string; audio: string };
  models: ModelInfo[];
  disabled?: boolean;
  disabledReason?: string;
  /** env-level limit overrides (win over model defaults) */
  envLimits?: Partial<Limits>;
}

export interface WindowState {
  start: number;
  requests: number;
  tokens: number;
}

export interface BucketState {
  minute: WindowState;
  day: WindowState;
  cooldownUntil: number;
  lastError?: string;
  modelCooldowns?: Record<string, number>;
}

export interface AcquireResult {
  ok: boolean;
  reason?: 'limit' | 'cooldown';
  /** seconds until a retry is worth trying */
  retryAfter?: number;
  minuteResetsAt?: number;
  dayResetsAt?: number;
}
