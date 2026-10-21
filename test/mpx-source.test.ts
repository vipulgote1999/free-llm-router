import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakedSnapshot, clearMpxCache, loadMpxSnapshot } from '../src/mpx-source';

const payload = {
  leaderboard: [
    {
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      free_status: 'FREE',
      status: 'SUCCESS',
      tps_24h: 1000,
      ttft_24h: 300,
      uptime_7d: 1,
      sampleCount24h: 20,
    },
  ],
  meta: { last_benchmark: new Date().toISOString(), is_stale: false },
};

afterEach(() => {
  clearMpxCache();
  vi.unstubAllGlobals();
});

describe('loadMpxSnapshot', () => {
  it('fetches once and caches within the TTL', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect((await loadMpxSnapshot()).rows[0]!.provider).toBe('groq');
    await loadMpxSnapshot();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falls back to the baked snapshot on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const s = await loadMpxSnapshot();
    expect(s.source).toBe('snapshot');
    expect(s.rows.length).toBeGreaterThan(0);
  });

  it('passes an abort signal so a hung fetch cannot stall routing', async () => {
    const f = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', f);
    await loadMpxSnapshot();
    expect((f.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('marks a week-old live payload stale for ranking', async () => {
    const old = { ...payload, meta: { last_benchmark: '2026-10-01T00:00:00.000Z', is_stale: true } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(old), { status: 200 })));
    expect((await loadMpxSnapshot()).stale).toBe(true);
  });

  it('returns the baked snapshot for an empty live payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ leaderboard: [] }), { status: 200 })));
    expect((await loadMpxSnapshot()).source).toBe('snapshot');
  });
});

describe('bakedSnapshot', () => {
  it('marks an old checked-in snapshot stale for ranking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    expect(bakedSnapshot().stale).toBe(true);
    vi.useRealTimers();
  });
});

describe('ranking staleness', () => {
  it('keeps ranking a recent payload even when ModelPulseX flags it stale', async () => {
    const recent = { ...payload, meta: { last_benchmark: new Date().toISOString(), is_stale: true } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(recent), { status: 200 })));
    expect((await loadMpxSnapshot()).stale).toBe(false);
  });
});
