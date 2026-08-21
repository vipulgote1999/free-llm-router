/**
 * Zen / OpenCode dynamic free-model helpers.
 * Pure logic — no Cloudflare imports, fully unit-testable.
 *
 * OpenCode Zen exposes its catalog at https://opencode.ai/zen/v1/models (keyless)
 * and https://api.opencode.ai/zen/v1/models (keyed). Free-tier models are those
 * priced at $0 — currently the `*-free` suffix plus `big-pickle`.
 * This module centralises that heuristic so the router and the sync script
 * share the same definition and the config can be refreshed without code edits.
 */

import type { ModelInfo } from './types';

const KNOWN_FREE_EXACT = new Set<string>([
  'big-pickle',
]);

const KNOWN_ALIASES: Record<string, string[]> = {
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

/** True if the model id belongs to the free tier on Zen / OpenCode. */
export function isFreeZenModel(id: string): boolean {
  if (KNOWN_FREE_EXACT.has(id)) return true;
  return id.endsWith('-free');
}

/** Filter a list of ids down to the free subset. */
export function filterFreeModels(ids: string[]): string[] {
  return ids.filter(isFreeZenModel);
}

/** Capability heuristic for a dynamic Zen free model. */
function capabilitiesFor(id: string): ModelInfo['capabilities'] {
  // Most free models are text-only; no vision/audio free models are
  // currently in the Zen catalog except via paid tier. Keep heuristic
  // narrow and update when Zen ships a free vision model.
  const lower = id.toLowerCase();
  if (lower.includes('vision') || lower.includes('vl')) return ['vision'];
  // reasoning suffix not used in free tier today; keep detection simple
  return ['text'];
}

/** Context window heuristic — free models are 131k except nemotron/laguna family. */
function contextFor(id: string): number {
  const lower = id.toLowerCase();
  if (lower.includes('nemotron')) return 1_000_000;
  if (lower.includes('laguna')) return 262_144;
  return 131_072;
}

/** Alias derived from id — prefers curated map, falls back to heuristic. */
function aliasesFor(id: string): string[] {
  if (KNOWN_ALIASES[id]) return KNOWN_ALIASES[id]!;
  // Heuristic for future unknown free models: e.g. deepseek-v4-flash-free → ['deepseek','deepseek-free']
  // Ensure distinct aliases for similar families (nemotron-*) by using up to two tokens.
  if (id === 'big-pickle') return ['pickle'];
  const base = id.replace(/-free$/, '');
  const parts = base.split('-');
  if (parts.length === 1) return [];
  const first = parts[0] ?? '';
  const second = parts[1] ?? '';
  const aliases: string[] = [];
  // For nemotron family, include second token to disambiguate ultra vs lightning
  if (first === 'nemotron' && second) {
    aliases.push(`nemotron-${second}`);
    aliases.push(`nemotron-${second}-free`);
  } else if (first) {
    aliases.push(first);
    aliases.push(`${first}-free`);
  }
  // also keep the full free-less id without version dots for fuzzy matching (de-duped)
  const noDots = base.replace(/\./g, '');
  if (noDots !== base && !aliases.includes(noDots)) aliases.push(noDots);
  return [...new Set(aliases)].slice(0, 3);
}

function m(
  id: string,
  aliases: string[],
  capabilities: ModelInfo['capabilities'],
  context: number,
): ModelInfo {
  return { id, aliases, capabilities, context };
}

/** Build ModelInfo entries for a list of free ids. */
export function modelInfosForFreeIds(ids: string[]): ModelInfo[] {
  return ids.map((id) => m(id, aliasesFor(id), capabilitiesFor(id), contextFor(id)));
}

/**
 * Merge a static fallback list with a live free-model list.
 * - Keeps ordering of live ids (upstream order) but de-duplicates.
 * - Falls back to static list when live is empty (offline / no fetch).
 */
export function mergeFreeModels(staticIds: string[], liveIds: string[]): string[] {
  const liveFree = filterFreeModels(liveIds);
  if (liveFree.length === 0) return staticIds;
  // De-duplicate while preserving live order; append any static that is
  // not in live (covers big-pickle style exact matches).
  const seen = new Set(liveFree);
  const extra = staticIds.filter((id) => !seen.has(id));
  return [...liveFree, ...extra];
}

/**
 * Parse an env-provided comma-separated model list into ids.
 * Empty string → [].
 */
export function parseEnvModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
