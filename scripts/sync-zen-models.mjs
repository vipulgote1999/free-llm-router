#!/usr/bin/env node
/**
 * Sync Zen / OpenCode free models from the live catalog into src/config.ts
 * and optionally emit env vars for dynamic runtime pickup without redeploy.
 *
 * Live catalog: https://opencode.ai/zen/v1/models (keyless, same as keyed)
 * Free heuristic: id.endsWith('-free') || id === 'big-pickle' (shared with src/zen.ts)
 *
 * Usage:
 *   node scripts/sync-zen-models.mjs           # patch src/config.ts in place
 *   node scripts/sync-zen-models.mjs --check  # exit 1 if registry is stale
 *   node scripts/sync-zen-models.mjs --env    # print ZEN_FREE_MODELS=... line for .dev.vars
 *
 * The script keeps the paid OpenCode catalog (claude/gpt/gemini etc.) untouched —
 * only the free subset of both `zen` and `opencode` providers is refreshed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'src/config.ts');
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';

function isFreeZenModel(id) {
  return id === 'big-pickle' || id.endsWith('-free');
}

const KNOWN_ALIASES = {
  'big-pickle': ['pickle'],
  'deepseek-v4-flash-free': ['deepseek-free', 'deepseek-chat', 'deepseek'],
  'x-preview-f-free': ['x-free', 'x-preview'],
  'muse-spark-1.2-contributor-free': ['muse-contributor-free', 'muse-spark'],
  'mimo-v2.5-free': ['mimo'],
  'hy3-free': ['hy3'],
  'nemotron-3-ultra-free': ['nemotron-free', 'nemotron-ultra'],
  'nemotron-3.5-lightning-free': ['nemotron-lightning-free', 'nemotron-lightning'],
  'laguna-s-2.1-free': ['laguna-free', 'laguna'],
};

function formatModelEntry(id) {
  const aliases = KNOWN_ALIASES[id] ?? (() => {
    const base = id.replace(/-free$/, '');
    const first = base.split('-')[0];
    const second = base.split('-')[1] ?? '';
    if (first === 'nemotron' && second) return [`nemotron-${second}`, `nemotron-${second}-free`];
    return first ? [first, `${first}-free`] : [];
  })();
  const context = id.includes('nemotron') ? 1_000_000 : id.includes('laguna') ? 262_144 : 131_072;
  const aliasStr = aliases.length ? `, ['${aliases.join("', '")}']` : `, []`;
  return `      m('${id}'${aliasStr}, ['text'], ${context})`;
}

async function fetchLiveIds() {
  const res = await fetch(ZEN_MODELS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetch ${ZEN_MODELS_URL} → ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((m) => m.id);
}

function patchConfig(liveFree) {
  let src = readFileSync(configPath, 'utf8');
  const original = src;

  // Build the replacement blocks for zen and opencode free subsets.
  const zenBlock = liveFree.map(formatModelEntry).join(',\n');

  // Patch zen: between `id: 'zen'` and the next provider `id: 'gemini'`
  // We replace the models array contents for zen.
  const zenRegex = /(\{\s*\/\/ Catalog verified live[\s\S]*?id: 'zen'[\s\S]*?models: \[)([\s\S]*?)(\r?\n {4}\],\r?\n {2}\},\r?\n {2}\{\r?\n {4}id: 'gemini')/;
  const zenMatch = src.match(zenRegex);
  if (!zenMatch) throw new Error('could not locate zen models block in src/config.ts');
  src = src.replace(zenRegex, `$1\n${zenBlock}\n$3`);

  // Patch opencode free subset: keep paid models, replace free ones at the top
  // opencode block contains free models first, then paid. We locate the paid marker
  // `m('claude-fable-5'` as the start of paid section.
  const opencodeRegex = /(\{\s*\/\/ Same catalog as keyless[\s\S]*?id: 'opencode'[\s\S]*?models: \[)([\s\S]*?)(,\r?\n {6}m\('claude-fable-5'[\s\S]*?)(\r?\n {4}\],)/;
  const opencodeMatch = src.match(opencodeRegex);
  if (!opencodeMatch) throw new Error('could not locate opencode models block in src/config.ts');
  const paidPart = opencodeMatch[3]; // from claude-fable onwards
  const opencodeBlock = liveFree.map(formatModelEntry).join(',') + ',' + paidPart;
  // Reconstruct: prefix + new free block + paidPart + suffix
  // Use a function replacer to avoid $ in replacement issues
  src = src.replace(opencodeRegex, (_m, p1, _p2, p3, p4) => `${p1}\n${zenBlock}${p3}${p4}`);

  // Also ensure weights are at the new priority (zen 130, opencode 125)
  src = src.replace(
    /id: 'zen'[\s\S]*?weight: \d+/,
    (m) => m.replace(/weight: \d+/, 'weight: 130'),
  );
  src = src.replace(
    /id: 'opencode'[\s\S]*?weight: \d+/,
    (m) => m.replace(/weight: \d+/, 'weight: 125'),
  );

  if (src !== original) writeFileSync(configPath, src, 'utf8');
  return src !== original;
}

// ---- CLI ---------------------------------------------------------------

const args = process.argv.slice(2);
const check = args.includes('--check');
const emitEnv = args.includes('--env');

const liveIds = await fetchLiveIds();
const liveFree = liveIds.filter(isFreeZenModel);

console.log(`Live Zen catalog: ${liveIds.length} models, ${liveFree.length} free`);
for (const id of liveFree) console.log(`  free: ${id}`);

if (emitEnv) {
  console.log(`\n# Add to .dev.vars / wrangler vars for dynamic runtime pickup (no redeploy):`);
  console.log(`ZEN_FREE_MODELS=${liveFree.join(',')}`);
  console.log(`OPENCODE_FREE_MODELS=${liveFree.join(',')}`);
}

if (check) {
  const src = readFileSync(configPath, 'utf8');
  const missing = liveFree.filter((id) => !src.includes(`'${id}'`));
  const extra = (() => {
    // find ids in zen block that are no longer live (heuristic)
    const zenSection = src.split("id: 'zen'")[1]?.split("id: 'gemini'")[0] ?? '';
    const ours = [...zenSection.matchAll(/m\('([^']+)'/g)].map((m) => m[1]);
    return ours.filter((id) => !liveIds.includes(id));
  })();
  if (missing.length || extra.length) {
    if (missing.length) console.log(`\nMissing from registry (new free models): ${missing.join(', ')}`);
    if (extra.length) console.log(`Stale in registry (gone upstream): ${extra.join(', ')}`);
    console.log('\nRegistry is stale — run: node scripts/sync-zen-models.mjs');
    process.exit(1);
  } else {
    console.log('Registry matches live free catalog ✓');
  }
} else if (!emitEnv) {
  const changed = patchConfig(liveFree);
  if (changed) console.log('\nPatched src/config.ts ✓ — run `npm test && npm run typecheck`');
  else console.log('\nNo changes needed ✓');
}
