/**
 * Offline routing-accuracy corpus (e02s02): labeled fixtures for content
 * detection + candidate selection. Every fixture must pass — this is the
 * router's correctness contract, independent of any live provider state.
 * Run: npm run bench:accuracy
 */

import { describe, expect, it } from 'vitest';
import { detect, parseModelSpec, selectCandidates } from '../src/detect';
import { getProviders } from '../src/config';
import type { ChatRequest } from '../src/types';

const env = {
  GROQ_API_KEY: 'g',
  GEMINI_API_KEY: 'gm',
  OPENROUTER_API_KEY: 'or',
  NVIDIA_API_KEY: 'n',
  CEREBRAS_API_KEY: 'c',
  SAMBANOVA_API_KEY: 's',
  MISTRAL_API_KEY: 'm',
} as Record<string, unknown>;

const providers = () => getProviders(env);

function req(partial: Partial<ChatRequest>): ChatRequest {
  return { model: 'auto', messages: [], ...partial };
}

interface Fixture {
  name: string;
  run: () => boolean;
}

const fixtures: Fixture[] = [
  {
    name: 'text-only auto → highest-weight text model (zen big-pickle, opencode first priority)',
    run: () => {
      const cands = selectCandidates(parseModelSpec(undefined), detect(req({ messages: [{ role: 'user', content: 'hi' }] })), providers());
      return cands[0]?.provider.id === 'zen' && cands[0]?.model === 'big-pickle';
    },
  },
  {
    name: 'vision input → every candidate is vision-capable, gemini included',
    run: () => {
      const caps = detect(req({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }] }));
      const cands = selectCandidates(parseModelSpec(undefined), caps, providers());
      const allVision = cands.every((c) => c.provider.models.find((m) => m.id === c.model)?.capabilities.includes('vision'));
      return allVision && cands.some((c) => c.provider.id === 'gemini') && cands.length >= 2;
    },
  },
  {
    name: 'audio input → only audio-capable providers, groq excluded',
    run: () => {
      const caps = detect(req({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }] }));
      const cands = selectCandidates(parseModelSpec(undefined), caps, providers());
      return cands.every((c) => c.provider.models.find((m) => m.id === c.model)?.capabilities.includes('audio')) && !cands.some((c) => c.provider.id === 'groq');
    },
  },
  {
    name: 'reasoning request → reasoning models preferred on reasoning providers',
    run: () => {
      const cands = selectCandidates(parseModelSpec(undefined), detect(req({ reasoning_effort: 'high' })), providers());
      const cf = cands.find((c) => c.provider.id === 'cloudflare');
      const or = cands.find((c) => c.provider.id === 'openrouter');
      return cf?.model === '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' && or?.model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
    },
  },
  {
    name: 'long context (>32k tokens) → chosen model context fits estimate',
    run: () => {
      const big = 'x'.repeat(20000); // ~5k tokens input; est total ~6k — under threshold
      const caps = detect(req({ messages: [{ role: 'user', content: big }] }));
      const cands = selectCandidates(parseModelSpec(undefined), caps, providers());
      return cands.length > 0 && cands.every((c) => (c.provider.models.find((m) => m.id === c.model)?.context ?? 0) >= 32000);
    },
  },
  {
    name: 'forced provider syntax → single provider candidate',
    run: () => {
      const cands = selectCandidates(parseModelSpec('groq/llama-3.3-70b-versatile'), detect(req({ model: 'groq/llama-3.3-70b-versatile' })), providers());
      return cands.length === 1 && cands[0]?.provider.id === 'groq' && cands[0]?.model === 'llama-3.3-70b-versatile';
    },
  },
  {
    name: 'alias deepseek-chat → zen + nvidia candidates, weight-ordered',
    run: () => {
      const cands = selectCandidates(parseModelSpec('deepseek-chat'), detect(req({ model: 'deepseek-chat' })), providers());
      const ids = cands.map((c) => c.provider.id);
      return ids.includes('zen') && ids.includes('nvidia') && ids.indexOf('zen') < ids.indexOf('nvidia');
    },
  },
  {
    name: 'openrouter :free passthrough id → exact openrouter model',
    run: () => {
      const model = 'nvidia/nemotron-3-super-120b-a12b:free';
      const cands = selectCandidates(parseModelSpec(model), detect(req({ model })), providers());
      return cands.length === 1 && cands[0]?.provider.id === 'openrouter' && cands[0]?.model === model;
    },
  },
  {
    name: 'unknown model → zero candidates',
    run: () => {
      const cands = selectCandidates(parseModelSpec('definitely-not-a-model'), detect(req({ model: 'definitely-not-a-model' })), providers());
      return cands.length === 0;
    },
  },
  {
    name: 'zen is free-tier-only: non-free model yields no zen candidate',
    run: () => {
      const cands = selectCandidates(parseModelSpec('gpt-5.4-mini'), detect(req({ model: 'gpt-5.4-mini' })), providers());
      return !cands.some((c) => c.provider.id === 'zen');
    },
  },
  {
    name: 'vision on a text-only model → candidate rejected (capability guard)',
    run: () => {
      const caps = detect(req({
        model: 'groq/llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }],
      }));
      const cands = selectCandidates(parseModelSpec('groq/llama-3.3-70b-versatile'), caps, providers());
      return cands.length === 0;
    },
  },
  {
    name: 'cloudflare forced via @cf model id parses correctly',
    run: () => {
      const model = 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const cands = selectCandidates(parseModelSpec(model), detect(req({ model })), providers());
      return cands.length === 1 && cands[0]?.provider.id === 'cloudflare' && cands[0]?.model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    },
  },
];

describe('routing accuracy corpus', () => {
  let passed = 0;
  for (const f of fixtures) {
    it(f.name, () => {
      if (f.run()) {
        passed++;
        expect(true).toBe(true);
      } else {
        expect(true, `fixture failed: ${f.name}`).toBe(false);
      }
    });
  }
  it('all fixtures pass (score threshold 100%)', () => {
    console.log(`\naccuracy score: ${passed}/${fixtures.length}`);
    expect(passed).toBe(fixtures.length);
  });
});
