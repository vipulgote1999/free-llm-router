import { describe, expect, it } from 'vitest';
import { detect, parseModelSpec, selectCandidates } from '../src/detect';
import { getProviders } from '../src/config';
import type { ChatRequest } from '../src/types';

const env = {
  GROQ_API_KEY: 'g1',
  GEMINI_API_KEY: 'gm1',
  OPENROUTER_API_KEY: 'or1',
} as Record<string, unknown>;

const providers = () => getProviders(env);

function req(partial: Partial<ChatRequest>): ChatRequest {
  return { model: 'auto', messages: [], ...partial };
}

describe('detect', () => {
  it('flags plain text only', () => {
    const caps = detect(
      req({ messages: [{ role: 'user', content: 'hello world' }] }),
    );
    expect(caps.vision).toBe(false);
    expect(caps.audio).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.inputTokens).toBe(Math.ceil('hello world'.length / 4));
  });

  it('flags OpenAI image_url parts as vision', () => {
    const caps = detect(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
            ],
          },
        ],
      }),
    );
    expect(caps.vision).toBe(true);
  });

  it('flags Gemini-style input_image parts as vision', () => {
    const caps = detect(
      req({
        messages: [
          { role: 'user', content: [{ type: 'input_image', image_url: { url: 'data:…' } }] },
        ],
      }),
    );
    expect(caps.vision).toBe(true);
  });

  it('flags audio parts', () => {
    const caps = detect(
      req({
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }],
      }),
    );
    expect(caps.audio).toBe(true);
  });

  it('flags reasoning via reasoning_effort or model name', () => {
    expect(detect(req({ reasoning_effort: 'high' })).reasoning).toBe(true);
    expect(detect(req({ model: 'deepseek-r1' })).reasoning).toBe(true);
    expect(detect(req({ model: 'llama-70b' })).reasoning).toBe(false);
  });

  it('estimates total tokens including max_tokens', () => {
    const caps = detect(req({ messages: [{ role: 'user', content: 'abcd' }], max_tokens: 100 }));
    expect(caps.inputTokens).toBe(1);
    expect(caps.estTotalTokens).toBe(101);
  });
});

describe('parseModelSpec', () => {
  it('treats empty/auto as auto', () => {
    expect(parseModelSpec(undefined)).toEqual({ model: 'auto' });
    expect(parseModelSpec('auto')).toEqual({ model: 'auto' });
  });

  it('parses provider/model force syntax', () => {
    expect(parseModelSpec('groq/llama-3.3-70b-versatile')).toEqual({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
  });

  it('parses model@provider force syntax', () => {
    expect(parseModelSpec('llama-70b@cerebras')).toEqual({
      provider: 'cerebras',
      model: 'llama-70b',
    });
  });

  it('leaves openrouter-style ids alone', () => {
    expect(parseModelSpec('meta-llama/llama-3.3-70b-instruct:free')).toEqual({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
    });
  });
});

describe('selectCandidates', () => {
  it('auto text picks the highest-weight enabled provider first', () => {
    const cands = selectCandidates(
      parseModelSpec(undefined),
      detect(req({})),
      providers(),
    );
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]?.provider.id).toBe('cloudflare');
    expect(cands[0]?.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(cands[1]?.provider.id).toBe('groq');
  });

  it('auto vision only returns vision-capable providers', () => {
    const caps = detect(
      req({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] },
        ],
      }),
    );
    const cands = selectCandidates(parseModelSpec(undefined), caps, providers());
    expect(cands.every((c) => c.provider.models
      .find((mm) => mm.id === c.model)?.capabilities.includes('vision'))).toBe(true);
    expect(cands.some((c) => c.provider.id === 'gemini')).toBe(true);
    expect(cands.some((c) => c.provider.id === 'groq')).toBe(false); // no vision model
    expect(cands.some((c) => c.provider.id === 'zen')).toBe(true); // zen has vision models now
  });

  it('auto reasoning prefers reasoning models', () => {
    const cands = selectCandidates(
      parseModelSpec(undefined),
      detect(req({ model: 'auto', reasoning_effort: 'high' })),
      providers(),
    );
    const cf = cands.find((c) => c.provider.id === 'cloudflare');
    expect(cf?.model).toBe('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
    const or = cands.find((c) => c.provider.id === 'openrouter');
    expect(or?.model).toBe('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  });

  it('resolves aliases across providers, weight-ordered', () => {
    const cands = selectCandidates(
      parseModelSpec('llama-70b'),
      detect(req({ model: 'llama-70b' })),
      providers(),
    );
    const ids = cands.map((c) => c.provider.id);
    expect(ids).toContain('groq');
    expect(ids).toContain('cerebras');
    expect(ids.indexOf('groq')).toBeLessThan(ids.indexOf('cerebras'));
    // every candidate resolves the alias to that provider's concrete model
    for (const c of cands) {
      const mm = c.provider.models.find((x) => x.id === c.model);
      expect(mm).toBeDefined();
    }
  });

  it('force syntax restricts to one provider', () => {
    const cands = selectCandidates(
      parseModelSpec('groq/llama-3.3-70b-versatile'),
      detect(req({ model: 'groq/llama-3.3-70b-versatile' })),
      providers(),
    );
    expect(cands.map((c) => c.provider.id)).toEqual(['groq']);
    expect(cands[0]?.model).toBe('llama-3.3-70b-versatile');
  });

  it('returns nothing for unknown models', () => {
    const cands = selectCandidates(
      parseModelSpec('definitely-not-a-model'),
      detect(req({ model: 'definitely-not-a-model' })),
      providers(),
    );
    expect(cands).toEqual([]);
  });

  it('skips disabled providers', () => {
    const cands = selectCandidates(parseModelSpec(undefined), detect(req({})), getProviders({}));
    expect(cands.some((c) => c.provider.id === 'ollama')).toBe(false);
  });
});
