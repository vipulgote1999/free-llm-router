import { describe, expect, it } from 'vitest';
import { getProviders } from '../src/config';
import {
  filterFreeModels,
  isFreeZenModel,
  modelInfosForFreeIds,
  parseEnvModelList,
} from '../src/zen';

describe('isFreeZenModel', () => {
  it('recognizes *-free suffix as free', () => {
    expect(isFreeZenModel('deepseek-v4-flash-free')).toBe(true);
    expect(isFreeZenModel('mimo-v2.5-free')).toBe(true);
    expect(isFreeZenModel('x-preview-f-free')).toBe(true);
  });
  it('recognizes big-pickle as free', () => {
    expect(isFreeZenModel('big-pickle')).toBe(true);
  });
  it('rejects paid models', () => {
    expect(isFreeZenModel('gpt-5.4-mini')).toBe(false);
    expect(isFreeZenModel('claude-opus-5')).toBe(false);
    expect(isFreeZenModel('deepseek-v4-flash')).toBe(false);
  });
});

describe('filterFreeModels', () => {
  it('keeps only free ids', () => {
    expect(filterFreeModels(['a-free', 'b', 'big-pickle', 'c-free'])).toEqual([
      'a-free',
      'big-pickle',
      'c-free',
    ]);
  });
});

describe('parseEnvModelList', () => {
  it('splits comma separated and trims', () => {
    expect(parseEnvModelList('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseEnvModelList('')).toEqual([]);
    expect(parseEnvModelList(undefined)).toEqual([]);
  });
});

describe('modelInfosForFreeIds', () => {
  it('creates ModelInfo with correct aliases and context', () => {
    const infos = modelInfosForFreeIds(['big-pickle', 'nemotron-3-ultra-free', 'laguna-s-2.1-free']);
    expect(infos.find((m) => m.id === 'big-pickle')?.aliases).toEqual(['pickle']);
    expect(infos.find((m) => m.id === 'nemotron-3-ultra-free')?.context).toBe(1_000_000);
    expect(infos.find((m) => m.id === 'laguna-s-2.1-free')?.context).toBe(262_144);
    expect(infos.find((m) => m.id === 'big-pickle')?.context).toBe(131_072);
  });
  it('produces distinct aliases for nemotron variants', () => {
    const infos = modelInfosForFreeIds(['nemotron-3-ultra-free', 'nemotron-3.5-lightning-free']);
    const ultra = infos.find((m) => m.id === 'nemotron-3-ultra-free')?.aliases;
    const lightning = infos.find((m) => m.id === 'nemotron-3.5-lightning-free')?.aliases;
    expect(ultra).not.toEqual(lightning);
    expect(ultra).toContain('nemotron-ultra');
    expect(lightning).toContain('nemotron-lightning');
  });
});

describe('getProviders zen dynamic', () => {
  it('uses ZEN_FREE_MODELS env to override zen free list', () => {
    const live = 'custom-free,big-pickle,deepseek-v4-flash-free';
    const ps = getProviders({ ZEN_FREE_MODELS: live });
    const zen = ps.find((p) => p.id === 'zen')!;
    expect(zen.models.map((m) => m.id)).toContain('custom-free');
    // non-free should be filtered out if heuristic filters? but we keep only *-free + big-pickle, so custom-free passes
    // a non-free like gpt-5.4-mini should be filtered
  });
  it('filters non-free entries from env list', () => {
    const ps = getProviders({ ZEN_FREE_MODELS: 'big-pickle,gpt-5.4-mini,another-free' });
    const zen = ps.find((p) => p.id === 'zen')!;
    const ids = zen.models.map((m) => m.id);
    expect(ids).toContain('big-pickle');
    expect(ids).toContain('another-free');
    expect(ids).not.toContain('gpt-5.4-mini');
  });
  it('opencode free subset is also driven by env (OPENCODE_FREE_MODELS)', () => {
    const ps = getProviders({ OPENCODE_FREE_MODELS: 'big-pickle,custom-free' });
    const opencode = ps.find((p) => p.id === 'opencode')!;
    const ids = opencode.models.map((m) => m.id);
    expect(ids).toContain('custom-free');
    expect(ids).toContain('big-pickle');
    // paid models preserved
    expect(ids).toContain('claude-opus-5');
  });
  it('zen weight is higher than cloudflare and groq (first priority)', () => {
    const ps = getProviders({});
    const zen = ps.find((p) => p.id === 'zen')!;
    const cf = ps.find((p) => p.id === 'cloudflare')!;
    const groq = ps.find((p) => p.id === 'groq')!;
    const opencode = ps.find((p) => p.id === 'opencode')!;
    expect(zen.weight).toBeGreaterThan(cf.weight);
    expect(opencode.weight).toBeGreaterThan(cf.weight);
    expect(zen.weight).toBeGreaterThan(groq.weight);
    // opencode slightly below zen but above others
    expect(zen.weight).toBeGreaterThan(opencode.weight);
  });
});
