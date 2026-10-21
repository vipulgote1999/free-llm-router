/**
 * ModelPulseX performance data — pure parsing, scoring, and candidate ranking.
 * No Cloudflare imports: this module is unit-tested directly.
 *
 * ModelPulseX publishes two shapes we care about:
 *  - /api/leaderboard  → per-model TPS/TTFT/uptime/status (live routing signal)
 *  - /api/models       → verified free catalog (checked in as a generated snapshot)
 */

export type MpxFreeStatus = 'FREE' | 'PREVIOUSLY_FREE' | 'UNKNOWN';

export interface MpxPerfRow {
  /** router provider id after normalization */
  provider: string;
  /** normalized model id */
  model: string;
  freeStatus: MpxFreeStatus;
  active: boolean;
  status: string;
  tps24: number | null;
  ttft24: number | null;
  uptime7d: number | null;
  samples24h: number;
}

export interface MpxSnapshot {
  rows: MpxPerfRow[];
  fetchedAt: number;
  source: 'live' | 'snapshot';
  lastBenchmark: string | null;
  stale: boolean;
}

export interface MpxCatalogModel {
  provider: string;
  id: string;
  freeStatus: MpxFreeStatus;
  active: boolean;
  context: number;
  capabilities: string[];
}

/** ModelPulseX provider names → router provider ids. */
const PROVIDER_MAP: Record<string, string> = {
  opencode_zen: 'zen',
  opencode_go: 'opencode',
  ollama_pro: 'ollama',
  tokenrouter: 'truerouter',
};

export function normalizeProvider(name: string): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  return PROVIDER_MAP[raw] ?? raw;
}

/** Gemini discovery ids carry a `models/` prefix; router ids do not. */
export function normalizeModelId(id: string): string {
  return typeof id === 'string' ? id.trim().replace(/^models\//, '') : '';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asCount(v: unknown): number {
  const n = asNumber(v);
  return n == null || n < 0 ? 0 : Math.floor(n);
}

function asFreeStatus(v: unknown): MpxFreeStatus {
  const s = asString(v).toUpperCase();
  if (s === 'FREE') return 'FREE';
  if (s === 'PREVIOUSLY_FREE') return 'PREVIOUSLY_FREE';
  return 'UNKNOWN';
}

function asCapabilities(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((c): c is string => typeof c === 'string');
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseLeaderboard(payload: unknown, fetchedAt = Date.now()): MpxSnapshot {
  const p = payload as { leaderboard?: unknown; meta?: { last_benchmark?: unknown; is_stale?: unknown } } | null;
  const list = Array.isArray(p?.leaderboard) ? p!.leaderboard : [];
  const rows: MpxPerfRow[] = [];
  const seen = new Set<string>();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const provider = normalizeProvider(asString(r.provider));
    const model = normalizeModelId(asString(r.model));
    if (!provider || !model) continue;
    const key = `${provider}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      provider,
      model,
      freeStatus: asFreeStatus(r.free_status),
      active: r.active !== false,
      status: asString(r.status).toUpperCase() || 'UNKNOWN',
      tps24: asNumber(r.tps_24h ?? r.tps_1h ?? r.tps_now),
      ttft24: asNumber(r.ttft_24h ?? r.ttft_1h ?? r.ttft_now),
      uptime7d: asNumber(r.uptime_7d ?? r.uptime_24h),
      samples24h: asCount(r.sampleCount24h ?? r.samples24h),
    });
  }

  return {
    rows,
    fetchedAt,
    source: 'live',
    lastBenchmark: asString(p?.meta?.last_benchmark) || null,
    stale: p?.meta?.is_stale === true,
  };
}

export function parseCatalog(payload: unknown): MpxCatalogModel[] {
  const p = payload as { models?: unknown } | null;
  const list = Array.isArray(p?.models) ? p!.models : [];
  const out: MpxCatalogModel[] = [];
  const seen = new Set<string>();

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const provider = normalizeProvider(asString(r.provider_name));
    const id = normalizeModelId(asString(r.provider_model_id));
    if (!provider || !id) continue;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      provider,
      id,
      freeStatus: asFreeStatus(r.free_status),
      active: r.active === true || r.active === 1,
      context: asCount(r.context_length) || 131_072,
      capabilities: asCapabilities(r.capabilities),
    });
  }

  return out;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function statusMultiplier(status: string): number {
  if (status === 'SUCCESS') return 1;
  if (status === 'RATE_LIMITED') return 0.5;
  if (status === 'TIMEOUT') return 0.6;
  if (status === 'PROVIDER_ERROR' || status === 'STREAM_ERROR') return 0.4;
  return 0.7;
}

/** Measured quality in 0..1. Excluded rows return 0; callers filter them separately. */
export function performanceScore(row: MpxPerfRow): number {
  if (row.freeStatus !== 'FREE' || !row.active || row.status === 'MODEL_UNAVAILABLE') return 0;

  const tps = Math.max(0, row.tps24 ?? 0);
  const speed = clamp01(Math.log1p(tps) / Math.log1p(1200));
  const latency = row.ttft24 == null ? 0.3 : clamp01(1 - row.ttft24 / 8000);
  const reliability = row.uptime7d == null ? 0.5 : clamp01(row.uptime7d);
  const raw = 0.45 * speed + 0.25 * latency + 0.3 * reliability;

  // Low sample counts shrink toward neutral instead of letting one lucky run win.
  const confidence = clamp01(row.samples24h / 12);
  const shrunk = raw * confidence + 0.5 * (1 - confidence);

  return shrunk * statusMultiplier(row.status);
}

function isExcluded(row: MpxPerfRow): boolean {
  return row.freeStatus !== 'FREE' || !row.active || row.status === 'MODEL_UNAVAILABLE';
}

interface Rankable {
  provider: { id: string };
  model: string;
}

/**
 * Reorder candidates for `auto` routing. Known MPX rows are ranked by measured
 * performance and placed ahead of candidates without data (ranked by the
 * caller's static score). The perf score is 0..1 and static scores are raw
 * weights, so the two groups are never compared directly.
 *
 * Excluded rows are dropped only when at least one candidate survives; if MPX
 * would empty the chain, the original order is returned.
 */
export function rankCandidates<T extends Rankable>(candidates: T[], snapshot: MpxSnapshot | undefined, staticScore: (c: T) => number): T[] {
  if (candidates.length === 0) return [];

  const byKey = new Map<string, MpxPerfRow>();
  for (const row of snapshot?.rows ?? []) byKey.set(`${row.provider}:${row.model}`, row);

  const entries = candidates.map((candidate, index) => ({ candidate, index, row: byKey.get(`${candidate.provider.id}:${candidate.model}`) }));
  const survivors = entries.filter((e) => !e.row || !isExcluded(e.row));
  const pool = survivors.length > 0 ? survivors : entries;

  const known = pool
    .filter((e) => e.row)
    .sort((a, b) => performanceScore(b.row!) - performanceScore(a.row!) || staticScore(b.candidate) - staticScore(a.candidate) || a.index - b.index);
  const unknown = pool
    .filter((e) => !e.row)
    .sort((a, b) => staticScore(b.candidate) - staticScore(a.candidate) || a.index - b.index);

  return [...known, ...unknown].map((e) => e.candidate);
}
