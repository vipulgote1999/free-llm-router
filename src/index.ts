/**
 * Worker entry point. Routes:
 *   POST /v1/chat/completions   (alias /chat/completions)
 *   POST /v1/completions        (alias /completions)
 *   POST /v1/embeddings         (alias /embeddings)
 *   POST /v1/audio/*            (transcriptions, translations, speech)
 *   POST /v1/images/*           (generations, edits, variations)
 *   GET  /v1/models             (alias /models)
 *   GET  /v1/models/:id         (alias /models/:id)
 *   GET  /health                open
 *   GET  /                      info
 *   GET  /admin                 dashboard
 *   GET  /admin/stats           JSON stats
 *   POST /admin/reset           clear limiter state
 *
 * Exact OpenAI-compatible behavior: every unknown field passes through,
 * streaming SSE is preserved byte-for-byte, errors use OpenAI shape.
 */

import { ProviderLimiter } from './limiter';
import { getProviders } from './config';
import { routeChat, routeCompletion, routeEmbedding, routeRaw, getRecentLogs } from './router';
import { DASHBOARD_HTML, collectStats, resetAll } from './admin';
import { corsHeaders, html, json, jsonErr } from './http';
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
  if (!key) return true; // open router unless gated
  const auth = request.headers.get('authorization') ?? '';
  // Support both "Bearer <key>" and plain key for SDK compat
  if (auth === `Bearer ${key}`) return true;
  if (auth === key) return true;
  // Also allow x-api-key header for LiteLLM clients
  if (request.headers.get('x-api-key') === key) return true;
  return false;
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
  // Allow both /v1/... and /... (LiteLLM supports both). Keep /v1 prefix for upstream mapping.
  return pathname;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
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
        { headers: cors },
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
        { headers: cors },
      );
    }

    // ---- gated ----
    if (!authorized(request, env)) {
      return jsonErr(401, 'invalid ROUTER_API_KEY — provide Authorization: Bearer <key>', undefined, { type: 'authentication_error', code: 'invalid_api_key' });
    }

    // ---- models ----
    if ((path === '/v1/models' || path === '/models') && request.method === 'GET') {
      return json(modelsList(env), { headers: cors });
    }
    // GET /v1/models/:id and /models/:id
    if ((path.startsWith('/v1/models/') || path.startsWith('/models/')) && request.method === 'GET') {
      const id = decodeURIComponent(path.replace(/^\/(v1\/)?models\//, ''));
      if (!id) return jsonErr(400, 'model id required', undefined, { code: 'invalid_request' });
      const found = modelRetrieve(env, id);
      if (!found) {
        // Also try exact provider-prefixed lookup: if client asks for "groq/llama-70b", strip provider
        const slash = id.indexOf('/');
        if (slash > 0) {
          const bare = id.slice(slash + 1);
          const foundBare = modelRetrieve(env, bare);
          if (foundBare) return json(foundBare as Record<string, unknown>, { headers: cors });
        }
        return jsonErr(404, `model '${id}' not found`, { configured: getProviders(env).map((p) => p.id) }, { code: 'model_not_found' });
      }
      return json(found as Record<string, unknown>, { headers: cors });
    }

    // ---- admin ----
    if (path === '/admin' || path === '/admin/') {
      return html(DASHBOARD_HTML);
    }
    if (path === '/admin/stats' && request.method === 'GET') {
      const providers = getProviders(env);
      const stats = await collectStats(env, providers);
      // Enrich with recent logs and overall health summary
      const logs = getRecentLogs();
      const now = Date.now();
      // compute latency p50/p95 from recent logs where outcome ok
      const okLatencies = logs.filter((l) => l.outcome === 'ok' && typeof l.ms === 'number').map((l) => l.ms!) .sort((a, b) => a - b);
      const p50 = okLatencies.length ? okLatencies[Math.floor(okLatencies.length * 0.5)] : null;
      const p95 = okLatencies.length ? okLatencies[Math.floor(okLatencies.length * 0.95)] : null;
      const success = logs.filter((l) => l.outcome === 'ok').length;
      const failure = logs.filter((l) => l.outcome === 'error' || l.outcome === 'skipped').length;
      return json({ providers: stats, logs, summary: { p50, p95, success, failure, total: logs.length, now }, generatedAt: now }, { headers: cors });
    }
    if (path === '/admin/reset' && request.method === 'POST') {
      await resetAll(env, getProviders(env));
      // also clear recent logs
      try { const { clearRecentLogs } = await import('./router'); clearRecentLogs(); } catch { /* ignore */ }
      return json({ ok: true }, { headers: cors });
    }
    if (path === '/admin/logs' && request.method === 'GET') {
      return json({ logs: getRecentLogs() }, { headers: cors });
    }

    // ---- OpenAI-compatible POST endpoints ----

    // Helper to read JSON body safely
    async function readJson(): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
      try {
        const body = (await request.json()) as Record<string, unknown>;
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
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return jsonErr(400, '`messages` array is required', undefined, { param: 'messages', code: 'missing_messages' });
      }
      try {
        return await routeChat(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`, undefined, { code: 'router_error' });
      }
    }

    // Completions (legacy)
    if ((path === '/v1/completions' || path === '/completions') && request.method === 'POST') {
      const parsed = await readJson();
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (!body.prompt && !body.messages) {
        // OpenAI completions requires prompt, but we allow prompt or messages for compat
        return jsonErr(400, '`prompt` is required for /v1/completions', undefined, { param: 'prompt', code: 'missing_prompt' });
      }
      try {
        return await routeCompletion(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`, undefined, { code: 'router_error' });
      }
    }

    // Embeddings
    if ((path === '/v1/embeddings' || path === '/embeddings' || path === '/v1/embeddings/') && request.method === 'POST') {
      const parsed = await readJson();
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (body.input === undefined || body.input === null || (typeof body.input === 'string' && body.input.length === 0) || (Array.isArray(body.input) && body.input.length === 0)) {
        return jsonErr(400, '`input` is required for /v1/embeddings', undefined, { param: 'input', code: 'missing_input' });
      }
      try {
        return await routeEmbedding(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`, undefined, { code: 'router_error' });
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
      const ct = request.headers.get('content-type') ?? '';
      // For JSON-based images/generations we can still handle as JSON via routeGeneric for better fallback.
      // But raw passthrough will also handle JSON since we forward bytes verbatim.
      if (ct.includes('application/json')) {
        const parsed = await readJson();
        if (!parsed.ok) return parsed.response;
        try {
          // For images/generations as JSON, use generic JSON router for model-aware fallback
          if (path.includes('/images/generations') || path.includes('/audio/speech')) {
            return await routeRaw(request, env, path.includes('/v1/') ? path : `/v1${path}`, null, ct);
            // alternative: use routeGeneric with JSON body
          }
          // fallback to raw with JSON bytes
          const bodyBytes = new TextEncoder().encode(JSON.stringify(parsed.body)).buffer;
          return await routeRaw(request, env, path.startsWith('/v1') ? path : `/v1${path}`, bodyBytes, 'application/json');
        } catch (err) {
          return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // multipart/form-data or other: read raw bytes and passthrough
        let bytes: ArrayBuffer | null = null;
        let contentType: string | null = ct;
        try {
          bytes = await request.arrayBuffer();
        } catch {
          return jsonErr(400, 'failed to read request body');
        }
        // Normalize path to /v1/... for upstream
        const upstreamPath = path.startsWith('/v1') ? path : `/v1${path}`;
        try {
          return await routeRaw(request, env, upstreamPath, bytes, contentType);
        } catch (err) {
          return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Explicit 405 for known POST-only paths hit with GET
    const postOnly = ['/v1/chat/completions', '/chat/completions', '/v1/completions', '/completions', '/v1/embeddings', '/embeddings'];
    if (postOnly.includes(path)) {
      return jsonErr(405, 'POST only', undefined, { code: 'method_not_allowed' });
    }

    // LiteLLM-style fallback: any POST to /v1/* that looks like OpenAI but unknown -> try generic json passthrough if model present
    if (path.startsWith('/v1/') && request.method === 'POST') {
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try {
          const body = (await request.clone().json()) as Record<string, unknown>;
          if (body && typeof body.model === 'string') {
            // Generic proxy: treat as chat-like for failover
            try {
              return await routeEmbedding(request, env, body); // will handle via generic endpoint logic
            } catch { /* fall through to 404 */ }
          }
        } catch { /* ignore */ }
      }
      return jsonErr(404, `endpoint '${path}' not found — see GET / for endpoints`, undefined, { code: 'not_found' });
    }

    return jsonErr(404, `not found — see GET / for endpoints`, undefined, { code: 'not_found' });
  },
};
