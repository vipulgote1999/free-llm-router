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
