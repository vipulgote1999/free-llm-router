/**
 * The failover router: walks the candidate chain (provider → key bucket),
 * asks the limiter for capacity, calls upstream, and reacts to 429/5xx with
 * cooldowns. Returns the first successful upstream response untouched.
 */

import { detect, selectCandidates } from './detect';
import { parseModelSpec } from './detect';
import {
  bucketsFor,
  getModelLimits,
  getProviders,
} from './config';
import { jsonErr } from './http';
import type { AcquireResult, ChatRequest } from './types';
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

export async function routeChat(
  request: Request,
  env: RouterEnv,
  body: ChatRequest,
): Promise<Response> {
  const caps = detect(body);
  const providers = getProviders(env as Record<string, unknown>);
  const spec = parseModelSpec(body.model);
  const candidates = selectCandidates(spec, caps, providers);

  if (candidates.length === 0) {
    const why = [
      caps.vision ? 'vision input' : null,
      caps.audio ? 'audio input' : null,
    ].filter(Boolean).join(', ');
    return jsonErr(
      404,
      `no configured provider can serve model '${body.model ?? 'auto'}'` +
        (why ? ` with ${why}` : ''),
      { configured: providers.map((p) => p.id) },
    );
  }

  const tried: Attempt[] = [];

  for (const cand of candidates) {
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
          tokens: caps.estTotalTokens,
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
        upstream = await callUpstream(cand.provider, cand.model, body, bucket.key, env);
      } catch {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 30, note: 'network error' });
        attempt.reason = 'network_error';
        finish('error');
        continue;
      }

      const res = upstream.res;
      if (!res) {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 60, note: upstream.reason });
        attempt.reason = upstream.reason ?? 'upstream_error';
        finish('error');
        continue;
      }

      const status = res.status;

      if (status === 429) {
        const secs = retryAfterSeconds(res);
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: secs, note: 'upstream 429' });
        attempt.reason = 'rate_limited';
        attempt.retryAfterSec = secs;
        finish('skipped');
        continue;
      }
      if (status === 401 || status === 403) {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 600, note: `auth rejected (${status})` });
        attempt.reason = 'auth_error';
        finish('error');
        continue;
      }
      if (status === 402) {
        // no credits / payment required — will not change within the day
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 43200, note: 'no credits (12h cooldown)' });
        attempt.reason = 'no_credits';
        finish('error');
        continue;
      }
      if (status === 404) {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 300, note: 'model unavailable upstream' });
        attempt.reason = 'model_unavailable';
        finish('error');
        continue;
      }
      if (status === 408 || status >= 500) {
        await doCall(stub, { op: 'cooldown', bucket: bucket.id, seconds: 30, note: `upstream ${status}` });
        attempt.reason = 'upstream_error';
        finish('error');
        continue;
      }

      // ---- success (any other 2xx/4xx) — pass through untouched ----
      finish('ok');
      return passthrough(res, cand.provider.id, cand.model);
    }
  }

  return jsonErr(503, 'all providers exhausted or failing', { tried });
}

// --------------------------------------------------------------- upstream

async function callUpstream(
  p: ProviderConfig,
  model: string,
  body: ChatRequest,
  key: string | null,
  env: RouterEnv,
): Promise<UpstreamResult> {
  if (p.id === 'cloudflare') return callCloudflareAI(env, model, body);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (key) {
    if (p.auth === 'x-goog-api-key') headers['x-goog-api-key'] = key;
    else headers['authorization'] = `Bearer ${key}`;
  }

  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS) || 300_000;
  const upstreamBody = { ...body, model };
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { res };
}

// ------------------------------------------------- Cloudflare Workers AI

async function callCloudflareAI(
  env: RouterEnv,
  model: string,
  body: ChatRequest,
): Promise<UpstreamResult> {
  if (!env.AI) return { reason: 'AI binding not configured' };
  try {
    // Workers AI streams a non-OpenAI SSE shape, so force non-stream and
    // synthesize an OpenAI-style response instead.
    const result = (await env.AI.run(model, {
      messages: body.messages,
      max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
      temperature: body.temperature,
      top_p: body.top_p,
    })) as { response?: string };

    const content = result?.response ?? '';
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
  return new Response(upstream.body, { status: upstream.status, headers });
}
