import { describe, expect, it } from 'vitest';
import {
  bucketsFor,
  getModelLimits,
  getProviders,
  hash8,
  parseKeys,
} from '../src/config';
import { UNLIMITED } from '../src/windows';

describe('parseKeys', () => {
  it('splits comma-separated keys and trims', () => {
    expect(parseKeys('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseKeys('')).toEqual([]);
    expect(parseKeys(undefined)).toEqual([]);
  });
});

describe('hash8', () => {
  it('is stable and short', () => {
    expect(hash8('secret-key')).toBe(hash8('secret-key'));
    expect(hash8('secret-key')).toHaveLength(8);
    expect(hash8('a')).not.toBe(hash8('b'));
  });
});

describe('getProviders', () => {
  it('keeps keyless providers enabled without any env', () => {
    const ps = getProviders({});
    expect(ps.find((p) => p.id === 'cloudflare')?.disabled).toBeFalsy();
    expect(ps.find((p) => p.id === 'zen')?.disabled).toBeFalsy();
  });

  it('disables ollama until OLLAMA_BASE_URL is set', () => {
    const ps = getProviders({});
    const ollama = ps.find((p) => p.id === 'ollama');
    expect(ollama?.disabled).toBe(true);
    expect(ollama?.disabledReason).toContain('OLLAMA_BASE_URL');

    const on = getProviders({ OLLAMA_BASE_URL: 'https://my-ollama.example/v1' });
    expect(on.find((p) => p.id === 'ollama')?.disabled).toBeFalsy();
  });

  it('parses env keys and applies env limit overrides', () => {
    const ps = getProviders({
      GROQ_API_KEY: 'a, b',
      GROQ_RPM: 7,
      GEMINI_TPD: '9000',
    });
    const groq = ps.find((p) => p.id === 'groq');
    expect(groq?.disabled).toBeFalsy();
    expect(groq?.limits.rpm).toBe(7);
    const gemini = ps.find((p) => p.id === 'gemini');
    expect(gemini?.limits.tpd).toBe(9000);
  });

  it('supports base URL overrides', () => {
    const ps = getProviders({ ZEN_BASE_URL: 'https://proxy.example/zen/' });
    expect(ps.find((p) => p.id === 'zen')?.baseUrl).toBe('https://proxy.example/zen');
  });

  it('builds custom ollama models from OLLAMA_MODELS', () => {
    const ps = getProviders({
      OLLAMA_BASE_URL: 'https://o.example/v1',
      OLLAMA_MODELS: 'mymodel:7b, other:1b',
    });
    const ollama = ps.find((p) => p.id === 'ollama');
    expect(ollama?.models.map((m) => m.id)).toEqual(['mymodel:7b', 'other:1b']);
  });
});

describe('bucketsFor', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it('gives keyless providers one anonymous bucket', () => {
    const zen = getProviders({}).find((p) => p.id === 'zen')!;
    expect(bucketsFor(zen, headers({}), {})).toEqual([{ id: 'anonymous', key: null }]);
  });

  it('uses a configured key for keyless-style providers (ollama)', () => {
    const ollama = getProviders({
      OLLAMA_BASE_URL: 'https://o.example/v1',
      OLLAMA_API_KEY: 'secret',
    }).find((p) => p.id === 'ollama')!;
    const buckets = bucketsFor(ollama, headers({}), { OLLAMA_API_KEY: 'secret' });
    expect(buckets).toEqual([{ id: 'key:0', key: 'secret' }]);
  });

  it('tries the client key before the env pool', () => {
    const groq = getProviders({ GROQ_API_KEY: 'env1, env2' }).find((p) => p.id === 'groq')!;
    const buckets = bucketsFor(groq, headers({ 'x-groq-api-key': 'client1' }), {
      GROQ_API_KEY: 'env1, env2',
    });
    expect(buckets.map((b) => b.id)).toEqual([
      `client:${hash8('client1')}`,
      'key:0',
      'key:1',
    ]);
    expect(buckets[0]?.key).toBe('client1');
  });

  it('falls back to the env pool without a client key', () => {
    const groq = getProviders({ GROQ_API_KEY: 'env1' }).find((p) => p.id === 'groq')!;
    const buckets = bucketsFor(groq, headers({}), { GROQ_API_KEY: 'env1' });
    expect(buckets.map((b) => b.id)).toEqual(['key:0']);
  });
});

describe('getModelLimits', () => {
  it('merges provider defaults, model overrides, then env overrides', () => {
    const ps = getProviders({ GROQ_API_KEY: 'a', GROQ_RPM: 5 });
    const groq = ps.find((p) => p.id === 'groq')!;
    // model-level override (llama-3.1-8b tpm 6000 beats provider 12000)
    expect(getModelLimits(groq, 'llama-3.1-8b-instant').tpm).toBe(6000);
    // env override beats both
    expect(getModelLimits(groq, 'llama-3.1-8b-instant').rpm).toBe(5);
  });

  it('uses provider defaults when the model has no overrides', () => {
    const ps = getProviders({ GEMINI_API_KEY: 'a' });
    const gemini = ps.find((p) => p.id === 'gemini')!;
    expect(getModelLimits(gemini, 'gemini-2.5-flash').rpd).toBe(250);
    expect(getModelLimits(gemini, 'gemini-2.5-flash').tpd).toBe(UNLIMITED);
  });
});
