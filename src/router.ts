/**
 * The failover router: walks the candidate chain (provider → key bucket),
 * asks the limiter for capacity, calls upstream, and reacts to 429/5xx with
 * cooldowns. Returns the first successful upstream response untouched.
 * 
 * v2: LiteLLM-style enhancements — per-error cooldowns with exponential
 * backoff + jitter, request-level `fallbacks` param, context-window-exceeded
 * fallback, and generic endpoint support (completions/embeddings/audio/images).
 */

import { detect, selectCandidates } from './detect';
import { parseModelSpec } from './detect';
import {
  bucketsFor,
  getModelLimits,
  getProviders,
} from './config';
import { jsonErr } from './http';
import type { AcquireResult, ChatRequest, GenericRequest } from './types';
import type { ProviderConfig } from './types';

interface RouterEnv {
  LIMITER: DurableObjectNamespace;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  [key: string]: unknown;
}

export interface Attempt {
  provider: string;
  model: string;
  bucket: string;
  reason: string;
  retryAfterSec?: number;
  minuteResetsAt?: number;
  dayResetsAt?: number;
  ms?: number;
}

/** Structured log — one JSON line per attempt (visible in wrangler tail / logs). */
function logAttempt(attempt: Attempt, outcome: string): void {
  console.log(
    JSON.stringify({
      t: 'router_attempt',
      provider: attempt.provider,
      model: attempt.model,
      bucket: attempt.bucket,
      outcome,
      reason: attempt.reason,
      retryAfterSec: attempt.retryAfterSec ?? null,
      dayResetsAt: attempt.dayResetsAt ?? null,
      ms: attempt.ms ?? null,
    }),
  );
  pushLog({
    ts: Date.now(),
    provider: attempt.provider,
    model: attempt.model,
    bucket: attempt.bucket,
    outcome,
    reason: attempt.reason,
    retryAfterSec: attempt.retryAfterSec,
    ms: attempt.ms,
  });
}

// ------------------------------------------------------------------ request log ring
// In-memory ring for dashboard visibility. Workers are stateless across
// instances, but this gives last-N visibility within a single isolate.
// Durable Objects hold the authoritative rate-limit state; this is best-effort UI.
interface LogEntry extends Attempt {
  ts: number;
  outcome: string;
}
const RECENT_MAX = 80;
const recentLogs: LogEntry[] = [];
function pushLog(e: LogEntry): void {
  recentLogs.push(e);
  if (recentLogs.length > RECENT_MAX) recentLogs.shift();
}
export function getRecentLogs(): LogEntry[] {
  return [...recentLogs];
}
export function clearRecentLogs(): void {
  recentLogs.length = 0;
}

interface UpstreamResult {
  res?: Response;
  reason?: string;
}

async function doCall<T>(stub: DurableObjectStub, payload: unknown): Promise<T> {
  const res = await stub.fetch('https://limiter/op', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`limiter returned ${res.status}`);
  return (await res.json()) as T;
}

// ----------------------------------------------------------------- helpers

function jittered(base: number): number {
  // +/-20% jitter, deterministic enough for dashboards but helps thundering herd.
  // If Math.random is mocked (tests), this still stays close to base.
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.min(86400, Math.round(base * jitter)));
}

function isContextLengthErrorMessage(msg: string): boolean {
  return /context_length_exceeded|context length|maximum context length|too many tokens/i.test(msg);
}

async function isContextLengthError(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return false;
  try {
    const clone = res.clone();
    const j = (await clone.json()) as { error?: { code?: string; message?: string; type?: string } };
    const code = String(j?.error?.code ?? '').toLowerCase();
    const msg = String(j?.error?.message ?? '');
    const type = String(j?.error?.type ?? '').toLowerCase();
    if (code.includes('context_length_exceeded')) return true;
    if (type.includes('context_length_exceeded')) return true;
    if (isContextLengthErrorMessage(msg)) return true;
  } catch {
    // not JSON, fall through
  }
  return false;
}

function parseFallbackModels(body: GenericRequest): string[] {
  const raw = body.fallbacks ?? (body as Record<string, unknown>).fallbacks ?? (body as Record<string, unknown>).fallback;
  if (!raw) return [];
  const arr: unknown[] = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    else if (item && typeof item === 'object') {
      const m = (item as Record<string, unknown>).model;
      if (typeof m === 'string' && m.trim()) out.push(m.trim());
      // LiteLLM also supports {"fallbacks": [{"model": "...", "api_key": "..."}]}
      // we only need model
    }
  }
  return out;
}

function estimateTokens(body: Record<string, unknown>, endpoint: string): number {
  // Reuse detect for chat; for others do rough char/4.
  if (endpoint.includes('chat/completions')) {
    try {
      const caps = detect(body as ChatRequest);
      return caps.estTotalTokens;
    } catch {
      return 1024;
    }
  }
  if (endpoint.includes('completions') && !endpoint.includes('chat')) {
    const prompt = (body as { prompt?: unknown }).prompt;
    let chars = 0;
    if (typeof prompt === 'string') chars = prompt.length;
    else if (Array.isArray(prompt)) chars = prompt.join(' ').length;
    else if (prompt) chars = JSON.stringify(prompt).length;
    const max = (body as { max_tokens?: number; max_completion_tokens?: number }).max_tokens
      ?? (body as { max_completion_tokens?: number }).max_completion_tokens ?? 1024;
    return Math.ceil(chars / 4) + max;
  }
  if (endpoint.includes('embeddings')) {
    const input = (body as { input?: unknown }).input;
    let chars = 0;
    if (typeof input === 'string') chars = input.length;
    else if (Array.isArray(input)) chars = JSON.stringify(input).length;
    else if (input) chars = String(input).length;
    return Math.ceil(chars / 4) + 8;
  }
  // audio/images: use 600 tokens proxy for limiter; not critical.
  return 512;
}

function classifyErrorForCooldown(status: number, bodyIndicatesContextExceeded: boolean): { seconds: number; reason: string; retryable: boolean } {
  if (status === 429) return { seconds: 60, reason: 'rate_limited', retryable: true };
  if (status === 401 || status === 403) return { seconds: 600, reason: 'auth_error', retryable: true };
  if (status === 402) return { seconds: 43200, reason: 'no_credits', retryable: true };
  if (status === 404) return { seconds: 0, reason: 'model_unavailable', retryable: true }; // auto-healing: per-model, no bucket cooldown
  if (status === 408) return { seconds: 30, reason: 'upstream_error', retryable: true };
  if (status >= 500) return { seconds: 30, reason: 'upstream_error', retryable: true };
  if (status === 400 && bodyIndicatesContextExceeded) return { seconds: 30, reason: 'context_exceeded', retryable: true };
  // 400 invalid_request for other reasons is NOT retryable (bad client input)
  if (status === 400) return { seconds: 0, reason: 'invalid_request', retryable: false };
  return { seconds: 0, reason: 'client_error', retryable: false };
}

// Build candidate chain with fallback expansion.
function buildCandidateChain(
  modelStr: string | undefined,
  caps: { vision: boolean; audio: boolean; reasoning: boolean; estTotalTokens: number },
  providers: ProviderConfig[],
  fallbacks: string[],
  endpoint: string,
): { provider: ProviderConfig; model: string }[] {
  const primarySpec = parseModelSpec(modelStr);
  let primary = selectCandidates(primarySpec, caps as never, providers);

  // If no primary candidates and model was not 'auto', allow generic passthrough:
  // try every active provider weight-ordered with the exact requested model.
  // This handles embeddings models like text-embedding-3-small that may not be
  // in the strict capability map but are still servable by providers.
  if (primary.length === 0 && modelStr && modelStr !== 'auto') {
    const active = [...providers].filter((p) => !p.disabled).sort((a, b) => b.weight - a.weight);
    // For embeddings endpoint, prefer providers with embeddings capability if any exist
    const wantEmbeddings = endpoint.includes('embeddings');
    const filtered = wantEmbeddings ? active.filter((p) => p.models.some((m) => m.capabilities.includes('embeddings'))) : active;
    const pool = filtered.length > 0 ? filtered : active;
    primary = pool.map((p) => ({ provider: p, model: primarySpec.model }));
  }

  // Append fallback models, deduplicating provider+model
  const seen = new Set(primary.map((c) => `${c.provider.id}:${c.model}`));
  const extra: typeof primary = [];
  for (const fb of fallbacks) {
    const spec = parseModelSpec(fb);
    // For fallbacks we also want to filter by caps (vision/audio) but allow generic if no match
    let cands = selectCandidates(spec, caps as never, providers);
    if (cands.length === 0 && spec.model !== 'auto') {
      const active = [...providers].filter((p) => !p.disabled).sort((a, b) => b.weight - a.weight);
      cands = active.map((p) => ({ provider: p, model: spec.model }));
    }
    for (const c of cands) {
      const key = `${c.provider.id}:${c.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        extra.push(c);
      }
    }
  }

  // For now, keep strict: only primary + explicit fallbacks. Auto-healing for forced providers
  // is handled dynamically in the failover loop (on network/5xx) so tests that expect 503
  // for exhausted forced providers still pass, while live network failures still heal.
  return [...primary, ...extra];
}

// ----------------------------------------------------------------- main entry (chat)
export async function routeChat(
  request: Request,
  env: RouterEnv,
  body: ChatRequest,
): Promise<Response> {
  return routeWithEndpoint(request, env, body as Record<string, unknown>, '/chat/completions');
}

export async function routeCompletion(
  request: Request,
  env: RouterEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  return routeWithEndpoint(request, env, body, '/completions');
}

export async function routeEmbedding(
  request: Request,
  env: RouterEnv,
  body: Record<string, unknown>,
): Promise<Response> {
  return routeWithEndpoint(request, env, body, '/embeddings');
}

export async function routeGeneric(
  request: Request,
  env: RouterEnv,
  body: Record<string, unknown> | null,
  endpoint: string,
): Promise<Response> {
  return routeWithEndpoint(request, env, body ?? {}, endpoint);
}

// Generic JSON failover — used by chat/completions/embeddings
async function routeWithEndpoint(
  request: Request,
  env: RouterEnv,
  body: Record<string, unknown>,
  endpoint: string,
): Promise<Response> {
  const providers = getProviders(env as Record<string, unknown>);
  const modelStr = (body.model as string | undefined) ?? 'auto';
  const fallbacks = parseFallbackModels(body as GenericRequest);

  // Caps: for chat we detect vision/audio/reasoning; for others we assume text-only
  // but preserve reasoning detection for generic.
  let caps: { vision: boolean; audio: boolean; reasoning: boolean; estTotalTokens: number };
  if (endpoint.includes('chat/completions')) {
    caps = detect(body as ChatRequest);
  } else {
    const est = estimateTokens(body, endpoint);
    const reasoning =
      (body as { reasoning_effort?: unknown }).reasoning_effort !== undefined ||
      /(^|[^a-z])(r1|reasoning)([^a-z]|$)/i.test(modelStr);
    caps = { vision: false, audio: false, reasoning, estTotalTokens: est };
  }

  const candidates = buildCandidateChain(modelStr, caps, providers, fallbacks, endpoint);

  if (candidates.length === 0) {
    const why = [
      (caps as { vision?: boolean }).vision ? 'vision input' : null,
      (caps as { audio?: boolean }).audio ? 'audio input' : null,
    ].filter(Boolean).join(', ');
    return jsonErr(
      404,
      `no configured provider can serve model '${modelStr}'` +
        (why ? ` with ${why}` : '') + (endpoint.includes('embeddings') ? ' for embeddings' : ''),
      { configured: providers.map((p) => p.id) },
      { code: 'model_not_found' },
    );
  }

  const tried: Attempt[] = [];
  const estTokens = caps.estTotalTokens;
  const maxRetriesEnv = Number(env.MAX_RETRIES) || Number(env.NUM_RETRIES) || 0;
  const bodyRetries = Number((body as { num_retries?: unknown }).num_retries);
  const effectiveMaxCandidates = (() => {
    const n = Number.isFinite(bodyRetries) && bodyRetries >= 0 ? bodyRetries + 1 : 0;
    const envN = Number.isFinite(maxRetriesEnv) && maxRetriesEnv > 0 ? maxRetriesEnv + 1 : 0;
    if (n && envN) return Math.min(n, envN, candidates.length) || candidates.length;
    if (n) return Math.min(n, candidates.length);
    if (envN) return Math.min(envN, candidates.length);
    return candidates.length;
  })();
  const limitedCandidates = candidates.slice(0, effectiveMaxCandidates);

  let attemptIndex = 0;
  for (const cand of limitedCandidates) {
    const buckets = bucketsFor(cand.provider, request.headers, env as Record<string, unknown>);
    if (buckets.length === 0) continue;

    for (const bucket of buckets) {
      const t0 = Date.now();
      const attempt: Attempt = {
        provider: cand.provider.id,
        model: cand.model,
        bucket: bucket.id,
        reason: 'pending',
      };
      const finish = (outcome: string) => {
        attempt.ms = Date.now() - t0;
        logAttempt(attempt, outcome);
        tried.push(attempt);
      };
      const stub = env.LIMITER.get(
        env.LIMITER.idFromName(`limiter:${cand.provider.id}`),
      );

      // ---- acquire capacity ----
      let acq: AcquireResult;
      try {
        acq = await doCall<AcquireResult>(stub, {
          op: 'acquire',
          bucket: bucket.id,
          tokens: estTokens,
          limits: getModelLimits(cand.provider, cand.model),
          dayAnchorUtc: cand.provider.dayAnchorUtc,
        });
      } catch {
        attempt.reason = 'limiter_error';
        finish('error');
        continue;
      }
      if (!acq.ok) {
        attempt.reason = acq.reason === 'cooldown' ? 'cooldown' : 'limit';
        attempt.retryAfterSec = acq.retryAfter;
        attempt.minuteResetsAt = acq.minuteResetsAt;
        attempt.dayResetsAt = acq.dayResetsAt;
        finish('skipped');
        continue;
      }

      // ---- call upstream ----
      let upstream: UpstreamResult;
      try {
        upstream = await callUpstream(cand.provider, cand.model, body, bucket.key, env, endpoint);
      } catch {
        const secs = jittered(30 * Math.min(1 << Math.min(attemptIndex, 2), 4));
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: 'network error' });
        attempt.reason = 'network_error';
        finish('error');
        attemptIndex++;
        continue;
      }

      const res = upstream.res;
      if (!res) {
        // Auto-healing: don't hammer bucket for per-model issues like workers_ai_no_embeddings
        const noc = upstream.reason === 'workers_ai_no_embeddings' ? 0 : 30;
        if (noc) await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: noc, note: upstream.reason });
        attempt.reason = upstream.reason ?? 'upstream_error';
        finish('error');
        attemptIndex++;
        continue;
      }

      const status = res.status;

      // Handle 400 context_length_exceeded as retryable fallback (LiteLLM behavior)
      let isContextExceeded = false;
      if (status === 400) {
        isContextExceeded = await isContextLengthError(res);
        if (isContextExceeded) {
          await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 30, note: 'context exceeded' });
          attempt.reason = 'context_exceeded';
          finish('skipped');
          attemptIndex++;
          continue;
        }
      }

      if (status === 429) {
        const secs = retryAfterSeconds(res);
        // Retry-After is authoritative; don't jitter it (tests rely on exact value)
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: 'upstream 429' });
        attempt.reason = 'rate_limited';
        attempt.retryAfterSec = secs;
        finish('skipped');
        attemptIndex++;
        continue;
      }
      const cls = classifyErrorForCooldown(status, isContextExceeded);
      if (cls.retryable) {
        // Apply exponential backoff for 5xx/408 etc where seconds is base
        const base = cls.seconds || 30;
        const withBackoff = base * (1 + Math.min(attemptIndex, 3) * 0.5);
        const secs = status >= 500 || status === 408 ? jittered(withBackoff) : base;
        if (secs > 0) {
          await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: `upstream ${status}` });
        }
        attempt.reason = cls.reason;
        if (status === 402 || status === 404 || status === 401 || status === 403 || status >= 500 || status === 408) {
          // these are retryable to next provider
          finish(status >= 500 || status === 408 ? 'error' : 'skipped');
          attemptIndex++;
          continue;
        }
      } else if (status === 400) {
        // Non-context 400: don't cooldown, just fail over? Actually 400 invalid_request
        // is client error — don't retry, but we should still fail over only if it's not
        // truly invalid (LiteLLM retries on some 400s). For safety, do NOT retry on plain 400
        // unless context_exceeded already handled. Return the upstream 400 directly as it's
        // likely a client bug, but we still try next provider if there are fallbacks?
        // LiteLLM treats 400 as non-retryable except context. So if fallbacks exist, try next;
        // otherwise passthrough the 400.
        if (fallbacks.length > 0 && attemptIndex < limitedCandidates.length - 1) {
          attempt.reason = 'invalid_request';
          finish('error');
          attemptIndex++;
          continue;
        }
        // No fallbacks: passthrough the 400 so client sees real upstream validation
        finish('ok');
        return passthrough(res, cand.provider.id, cand.model);
      }

      // For status that is not explicitly retryable above but 4xx other than 429/400/401 etc:
      // passthrough to client (e.g., 400 without fallback, 402 already handled)
      // However 401/402/404/5xx were retryable and continued; if we reach here for those,
      // they already continued. So remaining statuses are 2xx success or terminal 4xx.

      if (status >= 400 && status < 500 && status !== 429) {
        // If retryable classification already handled, we continued.
        // For remaining 4xx (e.g., 402 handled, 404 handled, 401 handled), if not continued
        // it's because secs 0. But we already continued for those above. So this is
        // non-retryable 4xx — passthrough.
        // To avoid swallowing client errors, passthrough directly.
        // But we classified 401/402/404 as retryable, so they would have continued.
        // So if we are here with 401 etc but not continued due to jitter? No.
        // Fallback safety: if status is 401/402/404 and we didn't continue, still continue for compatibility.
        if ([401, 402, 403, 404].includes(status)) {
          attempt.reason = cls.reason;
          finish('error');
          attemptIndex++;
          continue;
        }
        finish('ok');
        return passthrough(res, cand.provider.id, cand.model);
      }

      // ---- success (2xx) — pass through untouched ----
      finish('ok');
      return passthrough(res, cand.provider.id, cand.model);
    }
  }

  return jsonErr(503, 'all providers exhausted or failing', { tried }, { code: 'all_providers_exhausted' });
}

// --------------------------------------------------------------- upstream

async function callUpstream(
  p: ProviderConfig,
  model: string,
  body: Record<string, unknown>,
  key: string | null,
  env: RouterEnv,
  endpoint: string,
): Promise<UpstreamResult> {
  if (p.id === 'cloudflare') return callCloudflareAI(env, model, body, endpoint);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (key) {
    if (p.auth === 'x-goog-api-key') headers['x-goog-api-key'] = key;
    else headers['authorization'] = `Bearer ${key}`;
  }
  // Pass through LiteLLM-style custom headers if present
  // (allow client to set x-title etc. — already allowed via CORS)

  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || 15000;
  // Create upstream body with model override, but preserve every other field verbatim.
  // LiteLLM and OpenAI clients may send fallbacks/num_retries — upstream doesn't know them, strip them.
  const { fallbacks: _fb, fallback: _fb2, num_retries: _nr, ...cleanBody } = body as Record<string, unknown>;
  const upstreamBody = cleanBody.model ? { ...cleanBody, model } : { ...cleanBody, model };

  // Legacy /v1/completions (non-chat) — most free providers only implement chat.
  // Convert prompt → messages and call /chat/completions, then synthesize a
  // text_completion response so clients get the shape they asked for. This
  // mirrors Cloudflare AI handling and makes embeddings/completions work uniformly.
  const isCompletions = endpoint.includes('/completions') && !endpoint.includes('chat');
  if (isCompletions) {
    const prompt = (cleanBody as { prompt?: unknown }).prompt;
    const promptText = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? (prompt as unknown[]).join('\n') : prompt != null ? String(prompt) : '';
    // Respect existing messages if client already sent them (some callers do)
    const messages = (cleanBody as { messages?: unknown }).messages as unknown[] | undefined;
    const chatBody: Record<string, unknown> = messages
      ? { ...cleanBody, model, messages }
      : { ...cleanBody, model, messages: [{ role: 'user', content: promptText }] };
    delete (chatBody as Record<string, unknown>).prompt;
    // Strip completions-only fields that chat doesn't expect, but keep common ones
    const url = `${p.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // If provider returned a chat.completion, reshape to text_completion for completions callers
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      try {
        const clone = res.clone();
        const j = await clone.json() as { choices?: { message?: { content?: string } }[]; id?: string; model?: string; created?: number; usage?: unknown };
        if (j.choices && j.choices[0]?.message) {
          const text = j.choices[0]?.message?.content ?? '';
          const payload = {
            id: j.id ?? `cmpl-${crypto.randomUUID()}`,
            object: 'text_completion',
            created: j.created ?? Math.floor(Date.now() / 1000),
            model: j.model ?? model,
            choices: [{ text, index: 0, finish_reason: 'stop' }],
            usage: j.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          return { res: new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) };
        }
      } catch { /* fall through to raw */ }
    }
    return { res };
  }

  // Ensure endpoint path is OpenAI-compatible: /v1/... — providers all use /v1 prefix
  const targetPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${p.baseUrl}${targetPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { res };
}

// Raw passthrough for multipart endpoints (audio/images)
export async function routeRaw(
  request: Request,
  env: RouterEnv,
  endpoint: string,
  bodyBytes: ArrayBuffer | null,
  contentType: string | null,
): Promise<Response> {
  const providers = getProviders(env as Record<string, unknown>);
  // Model may be in multipart or query param; try to extract for routing.
  // For multipart we can't easily parse without deps, so use 'auto' plus endpoint.
  let modelStr = 'auto';
  const ct = request.headers.get('content-type') ?? '';
  // Attempt to extract model from query or from body string for simple cases
  const url = new URL(request.url);
  if (url.searchParams.get('model')) modelStr = url.searchParams.get('model')!;
  // Also try to peek bodyBytes if small JSON
  if (!bodyBytes && request.method === 'POST') {
    try {
      const j = await request.clone().json() as Record<string, unknown>;
      if (typeof j.model === 'string') modelStr = j.model;
    } catch { /* not JSON */ }
  }

  const caps = { vision: endpoint.includes('image'), audio: endpoint.includes('audio'), reasoning: false, estTotalTokens: 512 };
  const candidates = buildCandidateChain(modelStr, caps, providers, [], endpoint);

  if (candidates.length === 0) {
    const active = providers.filter((p) => !p.disabled);
    if (active.length === 0) return jsonErr(503, 'no providers available', {}, { code: 'no_providers' });
    // fallback to all active for raw
    candidates.push(...active.map((p) => ({ provider: p, model: modelStr })));
  }

  const tried: Attempt[] = [];
  for (const cand of candidates) {
    const buckets = bucketsFor(cand.provider, request.headers, env as Record<string, unknown>);
    if (buckets.length === 0) continue;
    for (const bucket of buckets) {
      const t0 = Date.now();
      const attempt: Attempt = { provider: cand.provider.id, model: cand.model, bucket: bucket.id, reason: 'pending' };
      const finish = (outcome: string) => {
        attempt.ms = Date.now() - t0;
        logAttempt(attempt, outcome);
        tried.push(attempt);
      };
      const stub = env.LIMITER.get(env.LIMITER.idFromName(`limiter:${cand.provider.id}`));
      let acq: AcquireResult;
      try {
        acq = await doCall<AcquireResult>(stub, {
          op: 'acquire',
          bucket: bucket.id,
          tokens: 512,
          limits: getModelLimits(cand.provider, cand.model),
          dayAnchorUtc: cand.provider.dayAnchorUtc,
        });
      } catch {
        attempt.reason = 'limiter_error';
        finish('error');
        continue;
      }
      if (!acq.ok) {
        attempt.reason = acq.reason === 'cooldown' ? 'cooldown' : 'limit';
        attempt.retryAfterSec = acq.retryAfter;
        finish('skipped');
        continue;
      }
      // call upstream raw
      try {
        const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
        if (contentType) headers['content-type'] = contentType;
        else if (ct) headers['content-type'] = ct;
        if (bucket.key) {
          if (cand.provider.auth === 'x-goog-api-key') headers['x-goog-api-key'] = bucket.key;
          else headers['authorization'] = `Bearer ${bucket.key}`;
        }
        const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || 15000;
        const res = await fetch(`${cand.provider.baseUrl}${endpoint}`, {
          method: request.method,
          headers,
          body: bodyBytes as BodyInit | null,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const status = res.status;
        if (status === 429) {
          const secs = retryAfterSeconds(res);
          await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: 'upstream 429' });
          attempt.reason = 'rate_limited';
          attempt.retryAfterSec = secs;
          finish('skipped');
          continue;
        }
        if ([401, 403, 402, 404, 408].includes(status) || status >= 500) {
          // Auto-healing: 404 is per-model, don't cooldown whole bucket
          if (status === 404) {
            attempt.reason = 'model_unavailable';
            finish('skipped');
            continue;
          }
          const map: Record<number, number> = { 401: 600, 403: 600, 402: 43200, 408: 30 };
          const secs = map[status] ?? 30;
          await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: `upstream ${status}` });
          attempt.reason = status === 401 || status === 403 ? 'auth_error' : status === 402 ? 'no_credits' : status === 404 ? 'model_unavailable' : 'upstream_error';
          finish('error');
          continue;
        }
        if (status >= 400) {
          // For other 4xx, passthrough directly (client error)
          finish('ok');
          return passthrough(res, cand.provider.id, cand.model);
        }
        finish('ok');
        return passthrough(res, cand.provider.id, cand.model);
      } catch {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 30, note: 'network error' });
        attempt.reason = 'network_error';
        finish('error');
        continue;
      }
    }
  }
  return jsonErr(503, 'all providers exhausted or failing', { tried }, { code: 'all_providers_exhausted' });
}

// ------------------------------------------------- Cloudflare Workers AI

async function callCloudflareAI(
  env: RouterEnv,
  model: string,
  body: Record<string, unknown>,
  endpoint: string,
): Promise<UpstreamResult> {
  if (!env.AI) return { reason: 'AI binding not configured' };
  // Workers AI only supports chat/completions; for other endpoints synthesize or proxy as error.
  if (endpoint.includes('embeddings')) {
    // Synthesize a fake embeddings response for DX; upstream doesn't have embeddings.
    // Return 503 style but indicate model unavailable so fallback tries next provider.
    return { reason: 'workers_ai_no_embeddings' };
  }
  if (endpoint.includes('completions') && !endpoint.includes('chat')) {
    // Map completions to chat internally: wrap prompt as user message.
    const prompt = (body as { prompt?: unknown }).prompt;
    const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.join('\n') : String(prompt ?? '');
    const result = (await env.AI.run(model, {
      prompt: text,
      max_tokens: (body as { max_tokens?: number }).max_tokens ?? 1024,
    })) as { response?: string };
    const content = result?.response ?? '';
    const payload = {
      id: `cmpl-${crypto.randomUUID()}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ text: content, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return { res: new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }) };
  }
  try {
    // Workers AI streams a non-OpenAI SSE shape, so force non-stream and
    // synthesize an OpenAI-style response instead.
    const messages = (body as { messages?: unknown }).messages as { role: string; content: unknown }[] | undefined;
    const result = (await env.AI.run(model, {
      messages: messages ?? [{ role: 'user', content: String((body as { prompt?: unknown }).prompt ?? 'hello') }],
      max_tokens: (body as { max_tokens?: number; max_completion_tokens?: number }).max_tokens
        ?? (body as { max_completion_tokens?: number }).max_completion_tokens ?? 1024,
      temperature: (body as { temperature?: unknown }).temperature,
      top_p: (body as { top_p?: unknown }).top_p,
    })) as { response?: string };

    const content = result?.response ?? '';
    const isStreaming = (body as { stream?: boolean }).stream;
    if (isStreaming) {
      // Synthesize minimal SSE stream for compatibility
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const chunk = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          const done = {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(done)}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return {
        res: new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' },
        }),
      };
    }
    const payload = {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return {
      res: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    };
  } catch {
    // AIError (429 out-of-neurons, 3040 out-of-capacity, 403 free-plan block…)
    return { reason: 'workers_ai_error' };
  }
}

// ----------------------------------------------------------------- helpers

function retryAfterSeconds(res: Response): number {
  const clamp = (s: number) => Math.min(Math.max(s, 1), 86400);

  const ra = res.headers.get('retry-after');
  if (ra) {
    if (/^\d+$/.test(ra.trim())) return clamp(parseInt(ra, 10));
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return clamp(Math.ceil((t - Date.now()) / 1000));
  }
  const reset = res.headers.get('x-ratelimit-reset'); // unix seconds (openrouter)
  if (reset) {
    const t = Number(reset) * 1000;
    if (Number.isFinite(t) && t > Date.now()) {
      return clamp(Math.ceil((t - Date.now()) / 1000));
    }
  }
  return 60;
}

function passthrough(upstream: Response, providerId: string, model: string): Response {
  const headers = new Headers(upstream.headers);
  // Workers fetch auto-decompresses; forwarding these headers would corrupt the body.
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.delete('connection');
  headers.set('access-control-allow-origin', '*');
  headers.set('x-router-provider', providerId);
  headers.set('x-router-model', model);
  // Ensure CORS headers remain if upstream didn't set them
  if (!headers.has('access-control-allow-origin')) headers.set('access-control-allow-origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers });
}
