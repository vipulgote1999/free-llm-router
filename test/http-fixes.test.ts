import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { VaultDO } from '../src/vault';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function makeEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const namespace = {
    idFromName: () => ({
      fetch: async (_url: string, init: RequestInit) => {
        const op = JSON.parse(String(init.body)) as { op: string };
        return json(op.op === 'acquire' ? { ok: true } : { ok: true });
      },
    }),
    get: (stub: unknown) => stub,
  };
  return { LIMITER: namespace, VAULT: namespace, ROUTER_API_KEY: 'k', ...extra };
}

function authRequest(path: string, body?: unknown, method = 'POST'): Request {
  const headers: Record<string, string> = { authorization: 'Bearer k' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://r.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('worker HTTP surface', () => {
  it('preserves the JSON body for images/generations', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('/images/generations')) {
          const raw = init.body;
          bodies.push(raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw));
        }
        return json({ data: [] });
      }),
    );
    const res = await worker.fetch(authRequest('/v1/images/generations', { model: 'auto', prompt: 'cat' }), makeEnv() as never, {} as never);
    expect(res.status).toBe(200);
    expect(bodies[0]).toContain('"prompt":"cat"');
  });

  it('returns 404 for an unknown /v1 POST instead of rerouting to embeddings', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const res = await worker.fetch(authRequest('/v1/does-not-exist', { model: 'auto' }), makeEnv() as never, {} as never);
    expect(res.status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed model id instead of throwing', async () => {
    const res = await worker.fetch(authRequest('/v1/models/%E0%A4%A', undefined, 'GET'), makeEnv() as never, {} as never);
    expect(res.status).toBe(400);
  });
});

describe('VaultDO touchKey', () => {
  it('updates lastUsedAt when given the raw key', async () => {
    vi.useFakeTimers();
    const store = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => {
          store.set(k, v);
        },
        delete: async () => true,
        list: async () => new Map(),
        setAlarm: async () => undefined,
        getAlarm: async () => null,
        deleteAlarm: async () => undefined,
      },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    };
    const vault = new VaultDO(ctx as never, {} as never);
    await Promise.resolve();
    await Promise.resolve();

    const op = (body: unknown) => new Request('https://vault/op', { method: 'POST', body: JSON.stringify(body) });
    const created = (await (await vault.fetch(op({ op: 'createKey', name: 'test', scope: 'api' }))).json()) as { key: string };
    await vault.fetch(op({ op: 'touchKey', key: created.key }));
    vi.runAllTimers();

    const listed = (await (await vault.fetch(op({ op: 'listKeys' }))).json()) as { keys: { lastUsedAt?: number }[] };
    expect(listed.keys[0]?.lastUsedAt).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
