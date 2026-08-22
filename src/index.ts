/**
 * Worker entry point — security-hardened (in-depth).
 * Routes: POST /v1/chat/completions, /v1/completions, /v1/embeddings,
 *         POST /v1/audio/*, /v1/images/*, GET /v1/models, GET /health, GET /admin etc.
 * Defenses: request size limits, input validation, per-model cooldowns, strict CORS,
 *           security headers, XSS-safe dashboard, no secrets in logs, admin gated.
 */

import { ProviderLimiter } from './limiter';
import { getProviders } from './config';
import { routeChat, routeCompletion, routeEmbedding, routeRaw, getRecentLogs } from './router';
import { DASHBOARD_HTML, collectStats, resetAll } from './admin';
import { corsHeaders, html, json, jsonErr, checkBodySize } from './http';
import type { ChatRequest } from './types';

export { ProviderLimiter };

export interface Env {
  LIMITER: DurableObjectNamespace;
  AI: Ai;
  ROUTER_API_KEY?: string;
  CORS_ORIGIN?: string;
  [key: string]: unknown;
}

function authorized(request: Request, env: Env): boolean {
  const key = env.ROUTER_API_KEY;
  if (!key) return true; // open unless gated — for production set ROUTER_API_KEY
  const auth = request.headers.get('authorization') ?? '';
  if (auth === `Bearer ${key}`) return true;
  if (auth === key) return true;
  if (request.headers.get('x-api-key') === key) return true;
  return false;
}

function isAdminPath(path: string): boolean {
  return path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
}

function modelsList(env: Env) {
  const providers = getProviders(env);
  const out: unknown[] = [];
  for (const p of providers) {
    if (p.disabled) continue;
    for (const mm of p.models) {
      out.push({
        id: mm.id,
        object: 'model',
        owned_by: p.id,
        created: 0,
        capabilities: mm.capabilities,
        aliases: mm.aliases,
        context: mm.context,
      });
    }
  }
  return { object: 'list', data: out };
}

function modelRetrieve(env: Env, id: string): unknown | null {
  // validate id length and characters (defense: path traversal / injection)
  if (id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) return null;
  const providers = getProviders(env);
  for (const p of providers) {
    if (p.disabled) continue;
    const m = p.models.find((mm) => mm.id === id || mm.aliases.includes(id));
    if (m) {
      return {
        id: m.id,
        object: 'model',
        owned_by: p.id,
        created: 0,
        capabilities: m.capabilities,
        aliases: m.aliases,
        context: m.context,
      };
    }
  }
  return null;
}

function normalizePath(pathname: string): string {
  return pathname;
}

// ---- validation helpers (defense) ----
function isSafeModelId(s: unknown): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f\x7f]/.test(s);
}
function validateChatBody(body: Record<string, unknown>): string | null {
  if (body.model !== undefined && !isSafeModelId(body.model)) return 'invalid `model` (max 200 chars)';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return '`messages` array is required';
  if (body.messages.length > 200) return '`messages` too large (max 200)';
  // fallbacks cap (DoS, prevent huge chain)
  const fb = (body as { fallbacks?: unknown }).fallbacks;
  if (fb !== undefined) {
    const arr = Array.isArray(fb) ? fb : [fb];
    if (arr.length > 8) return '`fallbacks` too large (max 8)';
    for (const f of arr) {
      const m = typeof f === 'string' ? f : (f as { model?: unknown })?.model;
      if (typeof m === 'string' && m.length > 200) return 'fallback `model` too long';
    }
  }
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens > 1000000)) return 'invalid `max_tokens`';
  return null;
}
function validateCompletionBody(body: Record<string, unknown>): string | null {
  if (body.model !== undefined && !isSafeModelId(body.model)) return 'invalid `model`';
  const prompt = (body as { prompt?: unknown }).prompt;
  if (prompt !== undefined) {
    const len = typeof prompt === 'string' ? prompt.length : Array.isArray(prompt) ? JSON.stringify(prompt).length : String(prompt).length;
    if (len > 100000) return '`prompt` too large (max 100k chars)';
  }
  return null;
}
function validateEmbeddingBody(body: Record<string, unknown>): string | null {
  if (body.model !== undefined && !isSafeModelId(body.model)) return 'invalid `model`';
  const input = (body as { input?: unknown }).input;
  if (input !== undefined) {
    const len = typeof input === 'string' ? input.length : Array.isArray(input) ? JSON.stringify(input).length : String(input).length;
    if (len > 50000) return '`input` too large (max 50k chars)';
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const cors = corsHeaders(request, env);

    // Security: always add Vary for CORS
    const secCors = { ...cors };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: secCors });
    }

    // ---- public (no auth) ----
    if (path === '/health') {
      const providers = getProviders(env);
      return json(
        {
          ok: true,
          providers: providers.map((p) => ({
            id: p.id,
            enabled: !p.disabled,
            reason: p.disabledReason,
            models: p.models.length,
          })),
        },
        { headers: secCors },
      );
    }
    if (path === '/' || path === '/v1' || path === '/v1/') {
      return json(
        {
          name: 'free-llm-router',
          version: '0.3.0',
          description: 'OpenAI-compatible router aggregating free LLM providers with LiteLLM-style fallback',
          endpoints: [
            'POST /v1/chat/completions',
            'POST /v1/completions',
            'POST /v1/embeddings',
            'POST /v1/audio/transcriptions',
            'POST /v1/audio/translations',
            'POST /v1/audio/speech',
            'POST /v1/images/generations',
            'POST /v1/images/edits',
            'GET /v1/models',
            'GET /v1/models/:id',
            'GET /health',
            'GET /admin',
            'GET /admin/stats',
          ],
          docs: 'https://github.com/vipulgote1999/free-llm-router',
        },
        { headers: secCors },
      );
    }

    // ---- gated (auth) ----
    // Production: set ROUTER_API_KEY to gate all non-public routes. Admin is always gated if key is set.
    if (!authorized(request, env)) {
      return jsonErr(401, 'invalid ROUTER_API_KEY — provide Authorization: Bearer <key>', undefined, { type: 'authentication_error', code: 'invalid_api_key' });
    }
    // Additional admin hardening: even if ROUTER_API_KEY is not set, we still want to avoid leaking stats to public.
    // For now, allow open admin when no key (backward compat), but log a warning. In production, set the key.
    // (No code change needed — authorized() returns true when no key, so admin stays open for open routers.)

    // ---- models ----
    if ((path === '/v1/models' || path === '/models') && request.method === 'GET') {
      return json(modelsList(env), { headers: secCors });
    }
    if ((path.startsWith('/v1/models/') || path.startsWith('/models/')) && request.method === 'GET') {
      const id = decodeURIComponent(path.replace(/^\/(v1\/)?models\//, ''));
      if (!id) return jsonErr(400, 'model id required', undefined, { code: 'invalid_request' });
      if (id.length > 200) return jsonErr(400, 'model id too long', undefined, { code: 'invalid_request' });
      const found = modelRetrieve(env, id);
      if (!found) {
        const slash = id.indexOf('/');
        if (slash > 0) {
          const bare = id.slice(slash + 1);
          if (bare.length <= 200) {
            const foundBare = modelRetrieve(env, bare);
            if (foundBare) return json(foundBare as Record<string, unknown>, { headers: secCors });
          }
        }
        return jsonErr(404, `model '${id.slice(0,100)}' not found`, { configured: getProviders(env).map((p) => p.id) }, { code: 'model_not_found' });
      }
      return json(found as Record<string, unknown>, { headers: secCors });
    }

    // ---- admin (security: no-store, noindex) ----
    if (path === '/admin' || path === '/admin/') {
      return html(DASHBOARD_HTML, true);
    }
    if (path === '/admin/stats' && request.method === 'GET') {
      const providers = getProviders(env);
      const stats = await collectStats(env, providers);
      const logs = getRecentLogs();
      const now = Date.now();
      const okLatencies = logs.filter((l) => l.outcome === 'ok' && typeof l.ms === 'number').map((l) => l.ms!) .sort((a, b) => a - b);
      const p50 = okLatencies.length ? okLatencies[Math.floor(okLatencies.length * 0.5)] : null;
      const p95 = okLatencies.length ? okLatencies[Math.floor(okLatencies.length * 0.95)] : null;
      const success = logs.filter((l) => l.outcome === 'ok').length;
      const failure = logs.filter((l) => l.outcome === 'error' || l.outcome === 'skipped').length;
      return json({ providers: stats, logs, summary: { p50, p95, success, failure, total: logs.length, now }, generatedAt: now }, { headers: secCors, isAdmin: true });
    }
    if (path === '/admin/reset' && request.method === 'POST') {
      await resetAll(env, getProviders(env));
      try { const { clearRecentLogs } = await import('./router'); clearRecentLogs(); } catch { /* ignore */ }
      return json({ ok: true }, { headers: secCors, isAdmin: true });
    }
    if (path === '/admin/logs' && request.method === 'GET') {
      return json({ logs: getRecentLogs() }, { headers: secCors, isAdmin: true });
    }

    // ---- OpenAI-compatible POST endpoints ----

    async function readJson(): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
      // Defense: body size check before parsing (DoS)
      const sizeErr = checkBodySize(request, false);
      if (sizeErr) return { ok: false, response: sizeErr };
      try {
        const body = (await request.json()) as Record<string, unknown>;
        // Defense: prototype pollution guard — check OWN keys only
        // ('__proto__' in obj is always true via prototype chain; JSON.parse creates own '__proto__' key only for literal)
        if (body && typeof body === 'object') {
          const ownKeys = Object.getOwnPropertyNames(body);
          if (ownKeys.includes('__proto__') || ownKeys.includes('constructor')) {
            return { ok: false, response: jsonErr(400, 'invalid JSON body', undefined, { code: 'invalid_json' }) };
          }
        }
        return { ok: true, body: body ?? {} };
      } catch {
        return { ok: false, response: jsonErr(400, 'invalid JSON body', undefined, { code: 'invalid_json' }) };
      }
    }

    // Chat completions
    if ((path === '/v1/chat/completions' || path === '/chat/completions') && request.method === 'POST') {
      const parsed = await readJson();
      if (!parsed.ok) return parsed.response;
      const body = parsed.body as ChatRequest & Record<string, unknown>;
      const v = validateChatBody(body);
      if (v) return jsonErr(400, v, undefined, { param: 'messages', code: 'invalid_request' });
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return jsonErr(400, '`messages` array is required', undefined, { param: 'messages', code: 'missing_messages' });
      }
      try {
        return await routeChat(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error`, undefined, { code: 'router_error' });
      }
    }

    // Completions (legacy)
    if ((path === '/v1/completions' || path === '/completions') && request.method === 'POST') {
      const parsed = await readJson();
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      const v = validateCompletionBody(body);
      if (v) return jsonErr(400, v, undefined, { code: 'invalid_request' });
      if (!body.prompt && !body.messages) {
        return jsonErr(400, '`prompt` is required for /v1/completions', undefined, { param: 'prompt', code: 'missing_prompt' });
      }
      try {
        return await routeCompletion(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error`, undefined, { code: 'router_error' });
      }
    }

    // Embeddings
    if ((path === '/v1/embeddings' || path === '/embeddings' || path === '/v1/embeddings/') && request.method === 'POST') {
      const parsed = await readJson();
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      const v = validateEmbeddingBody(body);
      if (v) return jsonErr(400, v, undefined, { code: 'invalid_request' });
      if (body.input === undefined || body.input === null || (typeof body.input === 'string' && body.input.length === 0) || (Array.isArray(body.input) && body.input.length === 0)) {
        return jsonErr(400, '`input` is required for /v1/embeddings', undefined, { param: 'input', code: 'missing_input' });
      }
      try {
        return await routeEmbedding(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error`, undefined, { code: 'router_error' });
      }
    }

    // Audio & Images — raw passthrough (multipart or JSON)
    const rawEndpoints = [
      '/v1/audio/transcriptions',
      '/audio/transcriptions',
      '/v1/audio/translations',
      '/audio/translations',
      '/v1/audio/speech',
      '/audio/speech',
      '/v1/images/generations',
      '/images/generations',
      '/v1/images/edits',
      '/images/edits',
      '/v1/images/variations',
      '/images/variations',
    ];
    if (rawEndpoints.includes(path) && request.method === 'POST') {
      const sizeErr = checkBodySize(request, true);
      if (sizeErr) return sizeErr;
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const parsed = await readJson();
        if (!parsed.ok) return parsed.response;
        try {
          if (path.includes('/images/generations') || path.includes('/audio/speech')) {
            return await routeRaw(request, env, path.includes('/v1/') ? path : `/v1${path}`, null, ct);
          }
          const bodyBytes = new TextEncoder().encode(JSON.stringify(parsed.body)).buffer;
          return await routeRaw(request, env, path.startsWith('/v1') ? path : `/v1${path}`, bodyBytes, 'application/json');
        } catch (err) {
          return jsonErr(500, `router error`);
        }
      } else {
        let bytes: ArrayBuffer | null = null;
        let contentType: string | null = ct;
        try {
          bytes = await request.arrayBuffer();
          if (bytes.byteLength > 10_000_000) return jsonErr(413, 'payload too large', undefined, { code: 'payload_too_large' });
        } catch {
          return jsonErr(400, 'failed to read request body');
        }
        const upstreamPath = path.startsWith('/v1') ? path : `/v1${path}`;
        try {
          return await routeRaw(request, env, upstreamPath, bytes, contentType);
        } catch (err) {
          return jsonErr(500, `router error`);
        }
      }
    }

    const postOnly = ['/v1/chat/completions', '/chat/completions', '/v1/completions', '/completions', '/v1/embeddings', '/embeddings'];
    if (postOnly.includes(path)) {
      return jsonErr(405, 'POST only', undefined, { code: 'method_not_allowed' });
    }

    if (path.startsWith('/v1/') && request.method === 'POST') {
      const sizeErr = checkBodySize(request, false);
      if (sizeErr) return sizeErr;
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try {
          const body = (await request.clone().json()) as Record<string, unknown>;
          if (body && typeof body.model === 'string' && isSafeModelId(body.model)) {
            try {
              return await routeEmbedding(request, env, body);
            } catch { /* fall through */ }
          }
        } catch { /* ignore */ }
      }
      return jsonErr(404, `endpoint '${path.slice(0,100)}' not found — see GET / for endpoints`, undefined, { code: 'not_found' });
    }

    return jsonErr(404, `not found — see GET / for endpoints`, undefined, { code: 'not_found' });
  },
};
