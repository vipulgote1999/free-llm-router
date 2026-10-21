import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('packaging', () => {
  it('defaults the benchmark to the live worker', async () => {
    const src = await readFile('scripts/benchmark.mjs', 'utf8');
    expect(src).toContain('free-llm-router.vipulgote5.workers.dev');
    expect(src).not.toContain('vipulgote4');
  });
});
