/**
 * End-to-end verification of the failover loop with a mocked Durable Object,
 * mocked upstream fetches, and a mocked Workers AI binding. This is the
 * headless equivalent of the wrangler dev smoke test (which needs workerd).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeChat } from '../src/router';

// ------------------------------------------------------- fake limiter state
// One isolated state per provider, like the real DO (limiter:<providerId>).

interface FakeBucket {
  min: { req: number; tok: number };
  day: { req: number; tok: number };
  cooldownUntil: number;
}
const limiterState = new Map<string, Map<string, FakeBucket>>();

function fresh(): FakeBucket {
  return { min: { req: 0, tok: 0 }, day: { req: 0, tok: 0 }, cooldownUntil: 0 };
}
function providerState(provider: string): Map<string, FakeBucket> {
  let s = limiterState.get(provider);
  if (!s) {
    s = new Map();
    limiterState.set(provider, s);
  }
  return s;
}
function bucketOf(provider: string, id: string): FakeBucket {
  const s = providerState(provider);
  let b = s.get(id);
  if (!b) {
    b = fresh();
    s.set(id, b);
  }
  return b;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fakeLimiterFetch(
  provider: string,
  init: RequestInit,
): Promise<Response> {
  const op = JSON.parse(String(init.body)) as Record<string, unknown>;
  const b = bucketOf(provider, String(op.bucket));
  if (op.op === 'acquire') {
    const model = String((op as Record<string, unknown>).model ?? '');
    const bAny = b as unknown as { modelCooldowns?: Record<string, number> };
    if (model && bAny.modelCooldowns?.[model] && bAny.modelCooldowns[model]! > Date.now()) return json({ ok: false, reason: 'cooldown', retryAfter: 5 });
    const l = op.limits as { rpm: number; rpd: number };
    if (b.cooldownUntil > Date.now()) {
      return json({ ok: false, reason: 'cooldown', retryAfter: 5 });
    }
    if (b.min.req + 1 > l.rpm || b.day.req + 1 > l.rpd) {
      return json({ ok: false, reason: 'limit', retryAfter: 60 });
    }
    b.min.req += 1;
    b.day.req += 1;
    return json({ ok: true, minuteResetsAt: Date.now() + 60000, dayResetsAt: Date.now() + 86400000 });
  }
  if (op.op === 'cooldownModel') {
    const m = String((op as Record<string, unknown>).model);
    const until = Date.now() + Number((op as Record<string, unknown>).seconds) * 1000;
    const bAny2 = b as unknown as { modelCooldowns?: Record<string, number> };
    if (!bAny2.modelCooldowns) bAny2.modelCooldowns = {};
    bAny2.modelCooldowns[m] = Math.max(bAny2.modelCooldowns[m] ?? 0, until);
    return json({ ok: true });
  }
  if (op.op === 'cooldown') {
    b.cooldownUntil = Date.now() + Number(op.seconds) * 1000;
    return json({ ok: true });
  }
  if (op.op === 'stats') return json({ buckets: {}, now: Date.now() });
  if (op.op === 'reset') {
    limiterState.clear();
    return json({ ok: true });
  }
  return json({ error: 'unknown op' }, 400);
}

function makeEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const namespace = {
    idFromName: (name: string) => ({
      fetch: (_url: string, init: RequestInit) =>
        fakeLimiterFetch(name.replace('limiter:', ''), init),
    }),
    get: (stub: unknown) => stub,
  };
  return { LIMITER: namespace, AI: { run: async () => ({ response: 'cf-answer' }) }, ...extra };
}

function makeRequest(model: string, messages: unknown = [{ role: 'user', content: 'hi' }]): Request {
  return new Request('https://router.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
}

// ----------------------------------------------------------- upstream mocks

type Upstream = (url: string) => Response;
function upstreamResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetch(handler: Upstream) {
  return vi
    .fn()
    .mockImplementation(async (url: string) => handler(url)) as unknown as typeof fetch;
}

beforeEach(() => {
  limiterState.clear();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------- tests

describe('routeChat end-to-end (mocked DO + upstreams)', () => {
  it('happy path: passes through the upstream response with router headers', async () => {
    vi.stubGlobal('fetch', mockFetch(() => upstreamResponse('hello from groq')));
    const env = makeEnv({ GROQ_API_KEY: 'g' });
    const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('groq');
    expect(res.headers.get('x-router-model')).toBe('llama-3.3-70b-versatile');
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe('hello from groq');
  });

  it('fails over on 429 and cools the exhausted bucket down', async () => {
    const fetchMockFn = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('api.groq.com')) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '42' },
        });
      }
      if (String(url).includes('integrate.api.nvidia.com')) {
        return upstreamResponse('hello from nvidia');
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMockFn);

    const env = makeEnv({ GROQ_API_KEY: 'g', NVIDIA_API_KEY: 'n' });
    const res = await routeChat(makeRequest('llama-70b'), env as never, {
      model: 'llama-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('nvidia');
    // groq bucket:0 is now cooling for ~42s
    const groqBucket = bucketOf('groq', 'key:0');
    expect(groqBucket.cooldownUntil).toBeGreaterThan(Date.now() + 40000);
    expect(groqBucket.cooldownUntil).toBeLessThanOrEqual(Date.now() + 43000);
  });

  it('skips a bucket that is already at its limit', async () => {
    // pre-exhaust groq's RPM window
    const b = bucketOf('groq', 'key:0');
    b.min.req = 30; // groq rpm default 30
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        String(url).includes('integrate.api.nvidia.com')
          ? upstreamResponse('nvidia again')
          : new Response('nope', { status: 500 }),
      ),
    );
    const env = makeEnv({ GROQ_API_KEY: 'g', NVIDIA_API_KEY: 'n' });
    const res = await routeChat(makeRequest('llama-70b'), env as never, {
      model: 'llama-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.headers.get('x-router-provider')).toBe('nvidia');
  });

  it('skips buckets in cooldown', async () => {
    bucketOf('groq', 'key:0').cooldownUntil = Date.now() + 100000;
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        String(url).includes('integrate.api.nvidia.com')
          ? upstreamResponse('post-cooldown')
          : new Response('nope', { status: 500 }),
      ),
    );
    const env = makeEnv({ GROQ_API_KEY: 'g', NVIDIA_API_KEY: 'n' });
    const res = await routeChat(makeRequest('llama-70b'), env as never, {
      model: 'llama-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.headers.get('x-router-provider')).toBe('nvidia');
  });

  it('returns 503 with per-attempt reset info when everything is exhausted', async () => {
    for (const id of ['key:0', 'anonymous']) {
      const b = bucketOf('groq', id);
      b.min.req = 9999;
    }
    vi.stubGlobal(
      'fetch',
      mockFetch(() => upstreamResponse('unreachable')),
    );
    const env = makeEnv({ GROQ_API_KEY: 'g' }); // only groq has a key
    const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: { tried: { reason: string }[] } };
    expect(j.error.tried.length).toBeGreaterThan(0);
    expect(j.error.tried.every((t) => t.reason === 'limit')).toBe(true);
  });

  it('serves via the Workers AI binding with an OpenAI-shaped response', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => new Response('zen should not be reached', { status: 200 })),
    );
    const env = makeEnv({}); // no keys — cloudflare (AI) then zen
    const res = await routeChat(
      makeRequest('cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
      env as never,
      {
        model: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        messages: [{ role: 'user', content: 'hi' }],
      },
    );
    expect(res.headers.get('x-router-provider')).toBe('cloudflare');
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe('cf-answer');
  });
});
