#!/usr/bin/env node
/**
 * Verify the model registry in src/config.ts against LIVE provider /models
 * endpoints. Keyless providers are checked without credentials; keyed
 * providers are checked when their keys are present (put them in .dev.vars).
 *
 *   node scripts/verify-models.mjs
 *
 * Output per provider: which of OUR configured models still exist upstream,
 * and which NEW upstream models are missing from the registry.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- load .dev.vars if present -------------------------------------------
function loadDevVars() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, '.dev.vars'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {
    /* no .dev.vars — keyless providers still work */
  }
  return env;
}

// ---- extract our registry model ids from src/config.ts --------------------
function ourModels(providerId) {
  const src = readFileSync(join(root, 'src/config.ts'), 'utf8');
  const providerBlocks = src.split(/^\s*\{/m).filter((b) => b.includes(`id: '${providerId}'`));
  const ids = new Set();
  for (const block of providerBlocks) {
    for (const match of block.matchAll(/m\(\s*'([^']+)'/g)) ids.add(match[1]);
  }
  return ids;
}

// ---- provider endpoints ---------------------------------------------------
const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    keyless: true,
    parse: (j) => j.data.map((m) => m.id),
    // only :free variants matter for this router
    interesting: (ids) => ids.filter((id) => id.includes(':free')),
    // not a chat model
    ignore: new Set(['nvidia/nemotron-3.5-content-safety:free']),
  },
  zen: {
    url: 'https://opencode.ai/zen/v1/models',
    keyless: true,
    parse: (j) => j.data.map((m) => m.id),
    // keyless zen only serves the *-free tier (verified live)
    interesting: (ids) => ids.filter((id) => id.endsWith('-free')),
  },
  cloudflare: {
    envKeys: ['CF_ACCOUNT_ID', 'CF_API_TOKEN'],
    keyless: false,
    async fetchModels(env) {
      if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return null;
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search`;
      const headers = { authorization: `Bearer ${env.CF_API_TOKEN}` };
      const all = [];
      for (let page = 1; page < 20; page++) {
        const res = await fetch(`${url}?per_page=100&page=${page}`, { headers });
        if (!res.ok) throw new Error(`CF API ${res.status}`);
        const j = await res.json();
        all.push(...(j.result ?? []));
        if (!j.result_info || page * 100 >= j.result_info.total_count) break;
      }
      return all.map((m) => m.name);
    },
  },
  groq: { envKey: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
  gemini: {
    envKey: 'GEMINI_API_KEY',
    auth: 'x-goog-api-key',
    async fetchModels(env) {
      // the OpenAI-compat layer has no /models; use the native list
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return (j.models ?? []).map((m) => m.name.replace(/^models\//, ''));
    },
  },
  cerebras: { envKey: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/models', auth: 'bearer' },
  sambanova: { envKey: 'SAMBANOVA_API_KEY', url: 'https://api.sambanova.ai/v1/models', auth: 'bearer' },
  nvidia: { envKey: 'NVIDIA_API_KEY', url: 'https://integrate.api.nvidia.com/v1/models', auth: 'bearer' },
  mistral: { envKey: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/models', auth: 'bearer' },
  opencode: { envKey: 'OPENCODE_API_KEY', url: 'https://api.opencode.ai/zen/v1/models', auth: 'bearer' },
  ollama: {
    envKey: 'OLLAMA_BASE_URL',
    async fetchModels(env) {
      if (!env.OLLAMA_BASE_URL) return null;
      const res = await fetch(`${env.OLLAMA_BASE_URL.replace(/\/$/, '')}/models`);
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const j = await res.json();
      return (j.models ?? []).map((m) => m.name);
    },
  },
};

async function fetchList(env, provider, def) {
  if (def.keyless) {
    const res = await fetch(def.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return def.parse(await res.json());
  }
  if (def.fetchModels) {
    if (def.envKey && !env[def.envKey]) return null;
    return def.fetchModels(env);
  }
  if (!env[def.envKey]) return null; // no key — skipped
  const headers = { accept: 'application/json' };
  if (def.auth === 'bearer') headers.authorization = `Bearer ${env[def.envKey]}`;
  if (def.auth === 'x-goog-api-key') headers['x-goog-api-key'] = env[def.envKey];
  const res = await fetch(def.url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).data.map((m) => m.id);
}

// ---- main -----------------------------------------------------------------
const env = loadDevVars();
let hadFindings = false;

for (const [id, def] of Object.entries(PROVIDERS)) {
  const header = `=== ${id} ===`;
  try {
    const upstream = await fetchList(env, id, def);
    if (upstream === null) {
      const needed = def.envKeys ? def.envKeys.join(' + ') : def.envKey;
      console.log(`${header}\n  skipped — set ${needed} in .dev.vars (or env) to check`);
      continue;
    }
    const upstreamSet = new Set(upstream);
    const ours = [...ourModels(id)];

    const missing = ours.filter((m) => !upstreamSet.has(m));
    let added = upstream.filter((m) => !new Set(ours).has(m));
    if (def.interesting) added = def.interesting(added);
    if (def.ignore) added = added.filter((m) => !def.ignore.has(m));
    if (id === 'openrouter') console.log(`  (showing only :free NEW models; content-safety classifier ignored)`);
    if (id === 'zen') console.log(`  (showing only *-free NEW models — keyless tier)`);

    console.log(`${header}  upstream models: ${upstream.length}`);
    if (missing.length) {
      hadFindings = true;
      console.log(`  GONE (ours, not upstream):`);
      for (const m of missing) console.log(`    ✗ ${m}`);
    } else {
      console.log(`  all ${ours.length} registered models present ✓`);
    }
    if (added.length) {
      hadFindings = true;
      console.log(`  NEW (upstream, not in registry): ${added.length}`);
      for (const m of added.slice(0, 40)) console.log(`    + ${m}`);
      if (added.length > 40) console.log(`    … and ${added.length - 40} more`);
    }
  } catch (err) {
    console.log(`${header}\n  ERROR: ${err.message}`);
  }
  console.log('');
}

if (hadFindings) {
  console.log('→ Update src/config.ts for GONE/NEW models, then run `npm test && npm run typecheck`.');
} else {
  console.log('→ Registry matches live catalogs.');
}
