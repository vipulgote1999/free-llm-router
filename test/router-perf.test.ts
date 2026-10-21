import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/mpx-source', () => ({
  loadMpxSnapshot: vi.fn(async () => ({
    rows: [
      {
        provider: 'zen',
        model: 'deepseek-v4.1-flash-free',
        freeStatus: 'FREE',
        active: true,
        status: 'SUCCESS',
        tps24: 10,
        ttft24: 7000,
        uptime7d: 1,
        samples24h: 20,
      },
      {
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        freeStatus: 'FREE',
        active: true,
        status: 'SUCCESS',
        tps24: 1100,
        ttft24: 300,
        uptime7d: 1,
        samples24h: 20,
      },
    ],
    fetchedAt: Date.now(),
    source: 'live',
    lastBenchmark: null,
    stale: false,
  })),
}));

import { routeChat, routeEmbedding } from '../src/router';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function makeEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    LIMITER: {
      idFromName: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const op = JSON.parse(String(init.body)) as { op: string };
          if (op.op === 'acquire') {
            return json({ ok: true, minuteResetsAt: Date.now() + 60_000, dayResetsAt: Date.now() + 86_400_000 });
          }
          return json({ ok: true });
        },
      }),
      get: (stub: unknown) => stub,
    },
    AI: { run: async () => ({ response: 'cf' }) },
    ...extra,
  };
}

function chatRequest(model: string): Request {
  return new Request('https://router.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

function upstreamChat(): Response {
  return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('performance-aware auto routing', () => {
  it('ranks measured performance ahead of static weight order', async () => {
    const f = vi.fn().mockResolvedValue(upstreamChat());
    vi.stubGlobal('fetch', f);
    const env = makeEnv({ GROQ_API_KEY: 'g' });

    const res = await routeChat(chatRequest('auto'), env as never, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('groq');
    expect(String(f.mock.calls[0]![0])).toContain('api.groq.com');
  });

  it('selects an embeddings-capable model for embeddings auto', async () => {
    const f = vi.fn().mockResolvedValue(
      json({ object: 'list', data: [{ object: 'embedding', embedding: [0.1], index: 0 }] }),
    );
    vi.stubGlobal('fetch', f);
    const env = makeEnv({ GEMINI_API_KEY: 'gm', MISTRAL_API_KEY: 'm', AI: undefined });

    const res = await routeEmbedding(new Request('https://router.test/v1/embeddings', { method: 'POST' }), env as never, {
      model: 'auto',
      input: 'hi',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('gemini');
    expect(String(f.mock.calls[0]![0])).toContain('/embeddings');
    const body = JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body)) as { model: string };
    expect(body.model).toBe('gemini-embedding-001');
  });
});
