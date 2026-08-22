/**
 * Worker entry point — security-hardened (in-depth).
 * Routes: POST /v1/chat/completions, /v1/completions, /v1/embeddings,
 *         POST /v1/audio/*, /v1/images/*, GET /v1/models, GET /health, GET /admin etc.
 * Defenses: request size limits, input validation, per-model cooldowns, strict CORS,
 *           security headers, XSS-safe dashboard, no secrets in logs, admin gated.
 */

import { ProviderLimiter } from './limiter';
import { VaultDO, sha256Hex, hashPassword, isValidApiKeyShape, KEY_PREFIX } from './vault';
import { getProviders } from './config';
import { routeChat, routeCompletion, routeEmbedding, routeRaw, getRecentLogs } from './router';
import { DASHBOARD_HTML, LOGIN_HTML, KEYS_HTML, collectStats, resetAll } from './admin';
import { corsHeaders, html, json, jsonErr, checkBodySize } from './http';
import type { ChatRequest } from './types';

export { ProviderLimiter, VaultDO };

export interface Env {
  LIMITER: DurableObjectNamespace;
  VAULT: DurableObjectNamespace;
  AI: Ai;
  ROUTER_API_KEY?: string;
  CORS_ORIGIN?: string;
  [key: string]: unknown;
}

const SESSION_COOKIE = 'flr_session';

async function vaultFetch<T>(env: Env, payload: unknown): Promise<T> {
  const stub = env.VAULT.get(env.VAULT.idFromName('vault:global'));
  const res = await stub.fetch('https://vault/op', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`vault returned ${res.status}`);
  return (await res.json()) as T;
}

/** Extract session token from Cookie header. */
function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_\-]+)`));
  return m?.[1] ?? null;
}

/**
 * Auth resolution order:
 *  1. Session cookie (dashboard) → verified against VaultDO
 *  2. Bearer/x-api-key API key → checked against VaultDO (hashed lookup)
 *  3. Legacy ROUTER_API_KEY env (backward compat / break-glass)
 * Returns principal description or null.
 */
async function authenticate(
  request: Request,
  env: Env,
): Promise<{ via: 'session' | 'apiKey' | 'envKey'; name?: string } | null> {
  // legacy env key — always accepted (break-glass)
  const envKey = env.ROUTER_API_KEY;
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xkey = request.headers.get('x-api-key') ?? '';

  // 1. session
  const token = getSessionToken(request);
  if (token) {
    try {
      const r = await vaultFetch<{ ok: boolean }>(env, { op: 'verifySession', token });
      if (r.ok) return { via: 'session', name: 'admin-session' };
    } catch { /* vault down — fall through */ }
  }

  // 2. api keys from vault (bearer or x-api-key)
  for (const candidate of [bearer, xkey]) {
    if (candidate && isValidApiKeyShape(candidate)) {
      try {
        const r = await vaultFetch<{ ok: boolean; record?: { name?: string; prefix?: string } }>(env, { op: 'checkKey', key: candidate });
        if (r.ok) {
          // touch usage async fire-and-forget is fine here
          void vaultFetch(env, { op: 'touchKey', key: candidate }).catch(() => {});
          return { via: 'apiKey', name: r.record?.name ?? r.record?.prefix };
        }
      } catch { /* fall through */ }
    }
  }

  // 3. legacy env key
  if (envKey) {
    if ((auth === `Bearer ${envKey}` || auth === envKey || xkey === envKey) && envKey.length > 0) {
      return { via: 'envKey', name: 'legacy-key' };
    }
    return null; // key set but not matched — deny (do NOT fall through to open)
  }
  return null;
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

    // ---- login page + auth API (public) ----
    if (path === '/login' && request.method === 'GET') {
      return html(LOGIN_HTML, true);
    }
    if (path === '/v1/auth/status' && request.method === 'GET') {
      try {
        const st = await vaultFetch<{ hasMaster: boolean; lockedForSec?: number }>(env, { op: 'stats' });
        return json({ initialized: st.hasMaster, lockedForSec: st.lockedForSec ?? 0 }, { headers: secCors, isAdmin: true });
      } catch {
        return json({ initialized: false, lockedForSec: 0 }, { headers: secCors });
      }
    }
    if ((path === '/v1/auth/init' || path === '/v1/auth/login' || path === '/v1/auth/logout' || path === '/v1/auth/change-password' || path === '/v1/auth/keys' || path.startsWith('/v1/auth/keys/')) && request.method === 'POST') {
      const sizeErr = checkBodySize(request, false);
      if (sizeErr) return sizeErr;
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch { /* allow empty for logout */ }

      // init — first-run master password setup
      if (path === '/v1/auth/init') {
        const pw = String(body.password ?? '');
        if (typeof pw !== 'string' || pw.length < 8) return jsonErr(400, 'password must be at least 8 characters', undefined, { code: 'weak_password' });
        const hash = await hashPassword(pw);
        const r = await vaultFetch<{ ok: boolean; reason?: string }>(env, { op: 'init', masterHash: hash });
        if (!r.ok) return jsonErr(409, r.reason ?? 'already initialized', undefined, { code: 'already_initialized' });
        return json({ ok: true }, { headers: secCors });
      }

      // login → session cookie
      if (path === '/v1/auth/login') {
        const pw = String(body.password ?? '');
        const r = await vaultFetch<{ ok: boolean; reason?: string; token?: string; expiresAt?: number }>(env, { op: 'login', password: pw });
        if (!r.ok) return jsonErr(401, r.reason ?? 'invalid credentials', undefined, { type: 'authentication_error', code: 'invalid_credentials' });
        const headers = new Headers(secCors);
        headers.set('content-type', 'application/json; charset=utf-8');
        headers.append('set-cookie', `${SESSION_COOKIE}=${r.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);
        headers.append('cache-control', 'no-store');
        return new Response(JSON.stringify({ ok: true, expiresAt: r.expiresAt }), { status: 200, headers });
      }

      // everything below requires a valid session
      const token = getSessionToken(request);
      let sessionOk = false;
      if (token) {
        try {
          const v = await vaultFetch<{ ok: boolean }>(env, { op: 'verifySession', token });
          sessionOk = !!v.ok;
        } catch { /* fallthrough */ }
      }
      if (!sessionOk) {
        return jsonErr(401, 'admin session required — login at /login', undefined, { type: 'authentication_error', code: 'session_required' });
      }

      if (path === '/v1/auth/logout') {
        if (token) await vaultFetch(env, { op: 'logout', token });
        const headers = new Headers({ ...secCors, 'content-type': 'application/json; charset=utf-8' });
        headers.append('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }
      if (path === '/v1/auth/change-password') {
        const oldPw = String(body.oldPassword ?? '');
        const newPw = String(body.newPassword ?? '');
        const r = await vaultFetch<{ ok: boolean; reason?: string }>(env, { op: 'changePassword', oldPassword: oldPw, newPassword: newPw });
        if (!r.ok) return jsonErr(400, r.reason ?? 'change failed', undefined, { code: 'change_failed' });
        return json({ ok: true }, { headers: secCors });
      }
      if (path === '/v1/auth/keys') {
        const name = String(body.name ?? 'default').slice(0, 100);
        const scope = body.scope === 'admin' ? 'admin' : 'api';
        const r = await vaultFetch<{ ok: boolean; key?: string; record?: unknown }>(env, { op: 'createKey', name, scope });
        if (!r.ok) return jsonErr(500, 'key creation failed', undefined, { code: 'create_failed' });
        // plaintext shown exactly once
        return json({ ok: true, key: r.key, record: r.record }, { headers: secCors, isAdmin: true });
      }
      if (path.startsWith('/v1/auth/keys/')) {
        const action = path.split('/').pop();
        const hash = String((body as { hash?: string }).hash ?? '');
        if (!hash) return jsonErr(400, '`hash` required', undefined, { code: 'missing_hash' });
        // client sends prefix (hash never leaves the vault)
        const prefix = String((body as { prefix?: string }).prefix ?? '');
        if (!prefix) return jsonErr(400, '`prefix` required', undefined, { code: 'missing_prefix' });
        if (action === 'revoke') {
          await vaultFetch(env, { op: 'revokeKeyByPrefix', prefix });
          return json({ ok: true }, { headers: secCors });
        }
        if (action === 'delete') {
          await vaultFetch(env, { op: 'deleteKeyByPrefix', prefix });
          return json({ ok: true }, { headers: secCors });
        }
        return jsonErr(404, 'unknown key action', undefined, { code: 'not_found' });
      }
    }
    if (path === '/v1/auth/keys' && request.method === 'GET') {
      const token = getSessionToken(request);
      if (!token) return jsonErr(401, 'admin session required', undefined, { type: 'authentication_error', code: 'session_required' });
      try {
        const v = await vaultFetch<{ ok: boolean }>(env, { op: 'verifySession', token });
        if (!v.ok) return jsonErr(401, 'session expired', undefined, { code: 'session_expired' });
      } catch {
        return jsonErr(503, 'vault unavailable', undefined, { code: 'vault_down' });
      }
      const r = await vaultFetch<{ keys: unknown[] }>(env, { op: 'listKeys' });
      return json({ keys: r.keys }, { headers: secCors, isAdmin: true });
    }

    // ---- keys management page (dashboard for API keys) ----
    if (path === '/keys' || path === '/keys/') {
      return html(KEYS_HTML, true);
    }


    // ---- auth (vault-first, env-key fallback) ----
    const principal = await authenticate(request, env);
    if (!principal) {
      return jsonErr(401, 'unauthorized — provide Authorization: Bearer sk-fr-… key or login at /login', undefined, { type: 'authentication_error', code: 'invalid_api_key' });
    }

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
