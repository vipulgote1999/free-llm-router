import { describe, expect, it } from 'vitest';
import {
  normalizeModelId,
  normalizeProvider,
  parseCatalog,
  parseLeaderboard,
  performanceScore,
  rankCandidates,
} from '../src/mpx';

const leaderboard = {
  leaderboard: [
    {
      provider: 'openrouter',
      model: 'minimax/minimax-m3.1-flash:free',
      free_status: 'FREE',
      status: 'SUCCESS',
      tps_24h: 160,
      ttft_24h: 3400,
      uptime_7d: 1,
      sampleCount24h: 20,
    },
    {
      provider: 'opencode_zen',
      model: 'deepseek-v4.1-flash-free',
      free_status: 'FREE',
      status: 'PROVIDER_ERROR',
      tps_24h: 0,
      ttft_24h: null,
      uptime_7d: 0.2,
      sampleCount24h: 7,
    },
    {
      provider: 'openrouter',
      model: 'retired:free',
      free_status: 'PREVIOUSLY_FREE',
      status: 'SUCCESS',
      tps_24h: 90,
      ttft_24h: 900,
      uptime_7d: 1,
      sampleCount24h: 12,
    },
  ],
  meta: { last_benchmark: '2026-10-21T10:15:00.000Z', is_stale: true },
};

describe('mpx normalization', () => {
  it('maps provider aliases and strips the gemini models/ prefix', () => {
    expect(normalizeProvider('opencode_zen')).toBe('zen');
    expect(normalizeProvider('opencode_go')).toBe('opencode');
    expect(normalizeProvider('tokenrouter')).toBe('truerouter');
    expect(normalizeProvider('groq')).toBe('groq');
    expect(normalizeModelId('models/gemini-flash-lite-latest')).toBe('gemini-flash-lite-latest');
  });
});

describe('parseLeaderboard', () => {
  it('keeps free flags, normalizes ids, and reads meta', () => {
    const s = parseLeaderboard(leaderboard, 1);
    expect(s.rows).toHaveLength(3);
    expect(s.rows[1]!.provider).toBe('zen');
    expect(s.rows[2]!.freeStatus).toBe('PREVIOUSLY_FREE');
    expect(s.lastBenchmark).toBe('2026-10-21T10:15:00.000Z');
    expect(s.stale).toBe(true);
  });

  it('returns an empty snapshot for malformed input instead of throwing', () => {
    expect(parseLeaderboard(null).rows).toEqual([]);
    expect(parseLeaderboard({ leaderboard: 'nope' }).rows).toEqual([]);
  });
});

describe('parseCatalog', () => {
  it('parses model metadata and tolerates string capabilities', () => {
    const catalog = parseCatalog({
      models: [
        {
          provider_name: 'opencode_zen',
          provider_model_id: 'deepseek-v4.1-flash-free',
          free_status: 'FREE',
          active: 1,
          context_length: 131072,
          capabilities: '["text"]',
        },
      ],
    });
    expect(catalog).toEqual([
      {
        provider: 'zen',
        id: 'deepseek-v4.1-flash-free',
        freeStatus: 'FREE',
        active: true,
        context: 131072,
        capabilities: ['text'],
      },
    ]);
  });
});

describe('performanceScore', () => {
  it('ranks higher TPS/TTFT/uptime above a slow erroring model', () => {
    const [fast, slow] = parseLeaderboard(leaderboard).rows;
    expect(performanceScore(fast!)).toBeGreaterThan(performanceScore(slow!));
  });

  it('shrinks low-sample rows toward neutral', () => {
    const base = {
      provider: 'groq',
      model: 'x',
      freeStatus: 'FREE' as const,
      active: true,
      status: 'SUCCESS',
      tps24: 1100,
      ttft24: 300,
      uptime7d: 1,
    };
    expect(performanceScore({ ...base, samples24h: 1 })).toBeLessThan(performanceScore({ ...base, samples24h: 20 }));
  });

  it('penalizes a rate-limited row but keeps it rankable', () => {
    const base = {
      provider: 'groq',
      model: 'x',
      freeStatus: 'FREE' as const,
      active: true,
      tps24: 1000,
      ttft24: 300,
      uptime7d: 1,
      samples24h: 20,
    };
    expect(performanceScore({ ...base, status: 'RATE_LIMITED' })).toBeLessThan(performanceScore({ ...base, status: 'SUCCESS' }));
    expect(performanceScore({ ...base, status: 'RATE_LIMITED' })).toBeGreaterThan(0);
  });

  it('returns 0 for non-free or unavailable rows', () => {
    const row = {
      provider: 'groq',
      model: 'x',
      freeStatus: 'PREVIOUSLY_FREE' as const,
      active: true,
      status: 'SUCCESS',
      tps24: 1000,
      ttft24: 300,
      uptime7d: 1,
      samples24h: 20,
    };
    expect(performanceScore(row)).toBe(0);
  });
});

describe('rankCandidates', () => {
  const cands = [
    { provider: { id: 'zen' }, model: 'deepseek-v4.1-flash-free' },
    { provider: { id: 'openrouter' }, model: 'minimax/minimax-m3.1-flash:free' },
    { provider: { id: 'groq' }, model: 'openai/gpt-oss-20b' },
  ];

  it('sorts by perf and drops non-free rows when a survivor exists', () => {
    const out = rankCandidates(cands, parseLeaderboard(leaderboard), () => 0);
    expect(out.map((c) => c.provider.id)).toEqual(['openrouter', 'zen', 'groq']);
  });

  it('keeps the original chain when every candidate is excluded', () => {
    const snap = parseLeaderboard({
      leaderboard: cands.map((c) => ({
        provider: c.provider.id,
        model: c.model,
        free_status: 'PREVIOUSLY_FREE',
        status: 'SUCCESS',
      })),
    });
    expect(rankCandidates(cands, snap, () => 0)).toEqual(cands);
  });

  it('falls back to static score when the snapshot is missing', () => {
    const out = rankCandidates(cands, undefined, (c) => (c.provider.id === 'groq' ? 10 : 1));
    expect(out[0]!.provider.id).toBe('groq');
  });
});
