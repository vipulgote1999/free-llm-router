#!/usr/bin/env node
/**
 * Live smoke test: one tiny chat completion per registered model against the
 * real provider API (same endpoints/auth as the router). Reads keys from
 * .dev.vars. Verdicts:
 *   ✅ 200 (works) · ⚠️ 429 (works, quota exhausted right now) ·
 *   ❌ auth/other error (key or config problem)
 *
 *   node scripts/smoke-test.mjs [--max N]
 *
 * Zen is sampled (the whole 62-model catalog would burn its daily quota):
 * the *-free tier plus a few flagships.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- env ------------------------------------------------------------------
const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.dev.vars'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
  }
} catch {
  /* no .dev.vars */
}

// ---- parse providers + models from src/config.ts ---------------------------
function parseRegistry() {
  const src = readFileSync(join(root, 'src/config.ts'), 'utf8');
  const providers = [];
  for (const block of src.split(/^\s*\{/m)) {
    const id = block.match(/id:\s*'([^']+)'/)?.[1];
    if (!id) continue;
    const baseUrl = block.match(/baseUrl:\s*'([^']*)'/)?.[1] ?? '';
    const auth = block.match(/auth:\s*'([^']+)'/)?.[1] ?? 'none';
    const apiKeyEnv = block.match(/apiKeyEnv:\s*'([^']*)'/)?.[1] ?? '';
    const models = [...block.matchAll(/m\(\s*'([^']+)'/g)].map((x) => x[1]);
    providers.push({ id, baseUrl, auth, apiKeyEnv, models });
  }
  return providers;
}

const ZEN_SAMPLE = /-free$/;
const ZEN_EXTRA = ['gpt-5.4-mini', 'gemini-3.5-flash', 'grok-4.6', 'deepseek-v4-pro'];

async function hit(provider, model) {
  const url = `${provider.baseUrl}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  const key = env[provider.apiKeyEnv];
  if (key) {
    if (provider.auth === 'x-goog-api-key') headers['x-goog-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'say hi in one word' }],
      max_tokens: 10,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const ms = Date.now() - t0;
  const text = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
  let verdict;
  if (res.status === 200) verdict = '✅ works';
  else if (res.status === 429) verdict = '⚠️ quota exhausted';
  else verdict = `❌ ${res.status}`;
  return `${verdict}  ${provider.id}/${model}  (${ms}ms)  ${text}`;
}

// ---- main -----------------------------------------------------------------
const maxArg = process.argv.indexOf('--max');
const maxModels = maxArg !== -1 ? Number(process.argv[maxArg + 1]) || Infinity : Infinity;

let total = 0;
for (const p of parseRegistry()) {
  if (p.id === 'cloudflare') {
    console.log(`— cloudflare (Workers AI binding, no HTTP) — tested after deploy`);
    continue;
  }
  if (p.id === 'ollama' && !p.baseUrl) {
    console.log(`— ollama skipped (no OLLAMA_BASE_URL)`);
    continue;
  }
  if (p.auth !== 'none' && !env[p.apiKeyEnv]) {
    console.log(`— ${p.id} skipped (no ${p.apiKeyEnv} in .dev.vars)`);
    continue;
  }
  let models = p.models;
  if (p.id === 'zen') {
    models = p.models.filter((m) => ZEN_SAMPLE.test(m) || ZEN_EXTRA.includes(m));
    console.log(`— zen sampled ${models.length}/${p.models.length} models (daily quota)`);
  }
  for (const model of models) {
    if (total >= maxModels) break;
    total++;
    try {
      console.log(await hit(p, model));
    } catch (err) {
      console.log(`❌ error  ${p.id}/${model}  ${err.message}`);
    }
  }
  console.log('');
}
