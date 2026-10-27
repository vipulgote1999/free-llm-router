import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML, collectStats } from '../src/admin';
import { getProviders } from '../src/config';

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

const env = {
  LIMITER: {
    idFromName: () => ({
      fetch: async () => json({ buckets: {}, now: Date.now() }),
    }),
    get: (stub: unknown) => stub,
  },
};

/** Inline scripts of a served page, in document order. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe('dashboard stats', () => {
  it('resolves Artificial Analysis scores for :free ids', async () => {
    const providers = getProviders({ OPENROUTER_API_KEY: 'x' });
    const stats = await collectStats(env as never, providers);
    const openrouter = stats.find((p) => p.provider === 'openrouter')!;
    expect(openrouter.scores['nvidia/nemotron-3-super-120b-a12b:free']?.score).toBe(38);
  });

  it('escapes provider and reason in the fallback chain renderer', () => {
    expect(DASHBOARD_HTML).toContain('esc(l.provider)');
    expect(DASHBOARD_HTML).toContain('esc(l.reason)');
  });
});

describe('dashboard page integrity', () => {
  // A single SyntaxError in the inline script kills every renderer, leaving the
  // tables silently empty (regression: a raw newline inside a JS string literal).
  it('serves an inline script that parses as JavaScript', () => {
    const scripts = inlineScripts(DASHBOARD_HTML);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      expect(() => new Function(src)).not.toThrow();
    }
  });

  it('wires the quick-start sample and its handler', () => {
    expect(DASHBOARD_HTML).toContain('id="tryBtn"');
    expect(DASHBOARD_HTML).toContain('function tryIt()');
    expect(DASHBOARD_HTML).toContain('/v1/chat/completions');
  });
});
