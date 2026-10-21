import { describe, expect, it } from 'vitest';
import { bucketsFor, getProviders, isFreeForAuto, providerById } from '../src/config';

const KEYED = { KILOCODE_API_KEY: 'k', OLLAMA_API_KEY: 'o' } as Record<string, unknown>;

const TOP30_KILO = [
  'reflection/beam-free',
  'minimax/minimax-m3.1-flash:free',
  'openrouter/free',
  'nvidia/nemotron-3.5-super-vl:free',
  'cohere/north-mini-code:free',
  'kilo-auto/free',
  'nvidia/nemotron-3.5-content-safety:free',
  'dots-studio/dots-3-note-preview:free',
];

const OLLAMA_FREE = [
  'gemma4:31b',
  'minimax-m3',
  'gpt-oss:20b',
  'gpt-oss:120b',
  'nemotron-3-super',
  'nemotron-3-ultra',
  'nemotron-3-nano:30b',
];

describe('kilocode provider', () => {
  it('registers the ModelPulseX free catalog and limits', () => {
    const p = providerById(getProviders(KEYED), 'kilocode');
    expect(p).toBeDefined();
    expect(p?.disabled).toBe(false);
    expect(p?.baseUrl).toBe('https://api.kilo.ai/api/gateway');
    expect(p?.limits.rpm).toBe(10);
    expect(p?.limits.rpd).toBe(200);
    const ids = p?.models.map((m) => m.id) ?? [];
    for (const id of TOP30_KILO) expect(ids).toContain(id);
    expect(ids.length).toBeGreaterThanOrEqual(11);
    expect(isFreeForAuto(p!, 'reflection/beam-free')).toBe(true);
  });

  it('works keyless so the gateway can still be tried', () => {
    const p = providerById(getProviders({}), 'kilocode');
    expect(p?.disabled).toBe(false);
    expect(bucketsFor(p!, new Headers(), {})).toEqual([{ id: 'anonymous', key: null }]);
  });

  it('sends the environment key as a bearer bucket when set', () => {
    const p = providerById(getProviders(KEYED), 'kilocode')!;
    expect(bucketsFor(p, new Headers(), KEYED)).toEqual([{ id: 'key:0', key: 'k' }]);
  });
});

describe('ollama_cloud provider', () => {
  it('registers exactly the verified-free Ollama Cloud models', () => {
    const p = providerById(getProviders(KEYED), 'ollama_cloud');
    expect(p).toBeDefined();
    expect(p?.disabled).toBe(false);
    expect(p?.baseUrl).toBe('https://ollama.com/v1');
    expect(p?.limits.rpm).toBe(10);
    expect(p?.limits.rpd).toBe(100);
    expect(p?.models.map((m) => m.id)).toEqual(OLLAMA_FREE);
    for (const id of OLLAMA_FREE) expect(isFreeForAuto(p!, id)).toBe(true);
  });

  it('disables itself cleanly without OLLAMA_API_KEY', () => {
    const p = providerById(getProviders({}), 'ollama_cloud');
    expect(p?.disabled).toBe(true);
    expect(p?.disabledReason).toContain('OLLAMA_API_KEY');
  });

  it('keeps the self-hosted ollama provider unchanged', () => {
    const p = providerById(getProviders({}), 'ollama');
    expect(p?.disabled).toBe(true);
    expect(p?.disabledReason).toContain('OLLAMA_BASE_URL');
    expect(p?.models.some((m) => m.id === 'llama3.2')).toBe(true);
  });
});
