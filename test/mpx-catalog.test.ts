import { describe, expect, it } from 'vitest';
import { MPX_CATALOG, MPX_PERF, MPX_SNAPSHOT_AT } from '../src/mpx-catalog.generated';

describe('generated ModelPulseX catalog', () => {
  it('is non-empty and has a valid timestamp', () => {
    expect(Number.isNaN(Date.parse(MPX_SNAPSHOT_AT))).toBe(false);
    expect(MPX_CATALOG.length).toBeGreaterThan(0);
    expect(MPX_PERF.length).toBeGreaterThan(0);
  });

  it('carries the current zen free ids and groq safeguard', () => {
    const zen = MPX_CATALOG.filter((m) => m.provider === 'zen' && m.freeStatus === 'FREE').map((m) => m.id);
    expect(zen).toContain('deepseek-v4.1-flash-free');
    expect(MPX_CATALOG.some((m) => m.provider === 'groq' && m.id === 'openai/gpt-oss-safeguard-20b' && m.freeStatus === 'FREE')).toBe(true);
  });

  it('normalizes gemini models/ ids and opencode_zen provider names', () => {
    expect(MPX_CATALOG.some((m) => m.provider === 'gemini' && m.id === 'models/gemini-flash-lite-latest')).toBe(false);
    expect(MPX_CATALOG.some((m) => m.provider === 'zen' && m.id.startsWith('models/'))).toBe(false);
  });
});
