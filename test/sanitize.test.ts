/**
 * Reasoning-leakage sanitizer + score normalization + Workers AI coercion.
 * Covers probe findings: <thought> blocks in non-streaming chat, `:free`
 * score misses, and non-string Workers AI responses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeChat, stripReasoningTags } from '../src/router';
import { getScore } from '../src/model-scores';

// ---- minimal limiter mock (acquire always ok) ----
function makeEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ns = {
    idFromName: (name: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const op = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (op.op === 'acquire')
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
    get: (s: unknown) => s,
  };
  return { LIMITER: ns, ...extra };
}

function chatReq(model: string, extra: Record<string, unknown> = {}): Request {
  return new Request('https://router.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });
}

function upstreamChat(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('stripReasoningTags', () => {
  it('removes paired <thought> blocks', () => {
    expect(stripReasoningTags('<thought>plan</thought>[{"a":1}]')).toBe('[{"a":1}]');
  });
  it('removes <think>/<thinking>/<reasoning> case-insensitively', () => {
    expect(stripReasoningTags('<THINK>x</THINK>hi')).toBe('hi');
    expect(stripReasoningTags('<thinking class="r">x</thinking>hi')).toBe('hi');
    expect(stripReasoningTags('<reasoning>y</reasoning>hi')).toBe('hi');
  });
  it('removes unclosed trailing blocks (truncated streams)', () => {
    expect(stripReasoningTags('<thought>partial answer')).toBe('');
  });
  it('returns the original string untouched when no tags are present', () => {
    const s = '  [{"a":1}]  ';
    expect(stripReasoningTags(s)).toBe(s); // same reference, no trim
  });
});

describe('non-streaming chat sanitization', () => {
  it('strips thought leakage from upstream chat responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => upstreamChat('<thought>The user wants 1..5</thought>1, 2, 3')),
    );
    const env = makeEnv({ GROQ_API_KEY: 'g' });
    const body = { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] };
    const res = await routeChat(chatReq(body.model), env as never, body as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe('1, 2, 3');
  });

  it('leaves clean responses byte-identical (no re-serialization)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => upstreamChat('clean answer')));
    const env = makeEnv({ GROQ_API_KEY: 'g' });
    const body = { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] };
    const res = await routeChat(chatReq(body.model), env as never, body as never);
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe('clean answer');
  });

  it('does not buffer streaming responses (leakage documented client-side)', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<thought>"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    const env = makeEnv({ GROQ_API_KEY: 'g' });
    const body = {
      model: 'groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    };
    const res = await routeChat(chatReq(body.model, { stream: true }), env as never, body as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('<thought>');
  });
});

describe('getScore normalization', () => {
  it('resolves :free-suffixed ids to their bare entries', () => {
    expect(getScore('openai/gpt-oss-20b:free')?.aaSlug).toBe('gpt-oss-20b');
    expect(getScore('nvidia/nemotron-3-super-120b-a12b:free')?.score).toBe(38);
  });
  it('returns new null-entries for MedTrail defaults (no silent miss)', () => {
    expect(getScore('llama-3.3-70b-versatile')).toBeDefined();
    expect(getScore('gemma-4-31b')).toBeDefined();
    expect(getScore('gemini-embedding-001')).toBeDefined();
  });
});

describe('Workers AI non-string coercion', () => {
  it('stringifies object responses to keep message.content a string', async () => {
    const env = makeEnv({
      AI: { run: async () => ({ response: { name: 'Paracetamol', strength: '500mg' } }) },
    });
    const body = { model: 'auto', messages: [{ role: 'user', content: 'extract' }] };
    const res = await routeChat(chatReq('auto'), env as never, body as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { choices: { message: { content: unknown } }[] };
    expect(typeof j.choices[0]?.message.content).toBe('string');
    expect(j.choices[0]?.message.content as string).toContain('Paracetamol');
  });
});
