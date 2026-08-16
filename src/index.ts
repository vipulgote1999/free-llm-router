/**
 * Worker entry point. Routes:
 *   POST /v1/chat/completions   (alias /chat/completions)
 *   GET  /v1/models             (alias /models)
 *   GET  /health                open
 *   GET  /                      info
 *   GET  /admin                 dashboard
 *   GET  /admin/stats           JSON stats
 *   POST /admin/reset           clear limiter state
 */

import type { Ai } from '@cloudflare/workers-types';
import { ProviderLimiter } from './limiter';
import { getProviders } from './config';
import { routeChat } from './router';
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
  return request.headers.get('authorization') === `Bearer ${key}`;
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
        capabilities: mm.capabilities,
        aliases: mm.aliases,
        context: mm.context,
      });
    }
  }
  return { object: 'list', data: out };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ---- public ----
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
    if (path === '/') {
      return json(
        {
          name: 'free-llm-router',
          version: '0.1.0',
          endpoints: [
            'POST /v1/chat/completions',
            'GET /v1/models',
            'GET /health',
            'GET /admin',
            'GET /admin/stats',
          ],
        },
        { headers: cors },
      );
    }

    // ---- gated ----
    if (!authorized(request, env)) {
      return jsonErr(401, 'invalid ROUTER_API_KEY', undefined);
    }

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      if (request.method !== 'POST') return jsonErr(405, 'POST only');
      let body: ChatRequest;
      try {
        body = (await request.json()) as ChatRequest;
      } catch {
        return jsonErr(400, 'invalid JSON body');
      }
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        return jsonErr(400, '`messages` array is required');
      }
      try {
        return await routeChat(request, env, body);
      } catch (err) {
        return jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (path === '/v1/models' || path === '/models') {
      return json(modelsList(env), { headers: cors });
    }

    if (path === '/admin' || path === '/admin/') {
      return html(DASHBOARD_HTML);
    }
    if (path === '/admin/stats') {
      const providers = getProviders(env);
      return json(await collectStats(env, providers), { headers: cors });
    }
    if (path === '/admin/reset' && request.method === 'POST') {
      await resetAll(env, getProviders(env));
      return json({ ok: true }, { headers: cors });
    }

    return jsonErr(404, 'not found — see GET / for endpoints');
  },
};
