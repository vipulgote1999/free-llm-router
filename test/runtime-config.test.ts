import { describe, expect, it } from 'vitest';
import {
  applyRuntimeOverrides,
  getProviders,
  sanitizeRuntimeOverride,
} from '../src/config';
import { UNLIMITED } from '../src/windows';

const base = getProviders({});

describe('sanitizeRuntimeOverride', () => {
  it('drops unknown fields and bad values', () => {
    const s = sanitizeRuntimeOverride({
      enabled: 'yes',
      weight: -5,
      autoText: 42,
      junk: true,
      limits: { rpm: 'abc', tpd: -1 },
    });
    expect(s).toEqual({});
  });

  it('keeps valid fields', () => {
    const s = sanitizeRuntimeOverride({
      enabled: false,
      weight: 99,
      autoText: 'gemini-2.5-flash-lite',
      limits: { rpm: 5 },
    });
    expect(s.enabled).toBe(false);
    expect(s.weight).toBe(99);
    expect(s.autoText).toBe('gemini-2.5-flash-lite');
    expect(s.limits).toEqual({ rpm: 5 });
  });
});

describe('applyRuntimeOverrides', () => {
  it('passes through when no overrides', () => {
    expect(applyRuntimeOverrides(base, undefined)).toEqual(base);
    expect(applyRuntimeOverrides(base, {})).toEqual(base);
    expect(applyRuntimeOverrides(base, { nope: {} })).toEqual(base);
  });

  it('disables a provider via admin config', () => {
    const out = applyRuntimeOverrides(base, { groq: { enabled: false } });
    const groq = out.find((p) => p.id === 'groq')!;
    expect(groq.disabled).toBe(true);
    expect(groq.disabledReason).toContain('admin config');
    // others untouched
    expect(out.find((p) => p.id === 'mistral')!.disabled).toBeFalsy();
  });

  it('re-enables only admin-config disables, not infrastructural ones', () => {
    const withKeylessOllama = base.map((p) =>
      p.id === 'ollama' ? { ...p, disabled: true, disabledReason: 'set OLLAMA_BASE_URL (e.g. your tunnel URL)' } : p,
    );
    const out = applyRuntimeOverrides(withKeylessOllama, {
      groq: { enabled: true },
      ollama: { enabled: true },
    });
    expect(out.find((p) => p.id === 'groq')!.disabled).toBeFalsy();
    const ollama = out.find((p) => p.id === 'ollama')!;
    expect(ollama.disabled).toBe(true);
    expect(ollama.disabledReason).toContain('OLLAMA_BASE_URL');
  });

  it('overrides auto model picks', () => {
    const gemini = base.find((p) => p.id === 'gemini')!;
    const out = applyRuntimeOverrides(base, {
      gemini: { autoText: 'gemini-2.5-pro', autoVision: 'gemma-4-31b-it' },
    });
    const next = out.find((p) => p.id === 'gemini')!;
    expect(next.auto.text).toBe('gemini-2.5-pro');
    expect(next.auto.vision).toBe('gemma-4-31b-it');
    expect(next.auto.audio).toBe(gemini.auto.audio);
  });

  it('clamps limits onto provider and its models', () => {
    const out = applyRuntimeOverrides(base, {
      openrouter: { limits: { rpd: 5000 } },
    });
    const or = out.find((p) => p.id === 'openrouter')!;
    expect(or.limits.rpd).toBe(5000);
    for (const mm of or.models) expect(mm.limits?.rpd).toBe(5000);
    // models without their own limit table inherit only the overridden field;
    // unset fields resolve from provider defaults via getModelLimits
    const plain = or.models.find((mm) => mm.id === 'openai/gpt-oss-20b:free');
    expect(plain?.limits).toEqual({ rpd: 5000 });
  });

  it('applies weight overrides', () => {
    const out = applyRuntimeOverrides(base, { mistral: { weight: 200 } });
    expect(out.find((p) => p.id === 'mistral')!.weight).toBe(200);
    expect(out.find((p) => p.id === 'zen')!.weight).not.toBe(200);
  });

  it('never makes an unlimited limit finite by accident', () => {
    const cf = applyRuntimeOverrides(base, { cloudflare: { limits: { tpm: 100000 } } })
      .find((p) => p.id === 'cloudflare');
    if (!cf) throw new Error('cloudflare missing');
    expect(cf.limits.tpm).toBe(100000);
    expect(cf.limits.tpd).toBe(UNLIMITED);
  });
});
