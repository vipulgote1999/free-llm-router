# ModelPulseX Performance-Aware Routing + Defect Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `auto` route only to ModelPulseX-verified FREE models ranked by measured TPS/TTFT/uptime, with snapshot fallback, and fix the confirmed production defects.

**Architecture:** `scripts/sync-modelpulse.mjs` generates a checked-in catalog; `src/mpx.ts` is pure parse/score/rank logic; `src/mpx-source.ts` fetches live data with a 1.2 s timeout and 5-minute cache; `src/config.ts` merges the catalog and exposes `isFreeForAuto`; `src/router.ts` applies the free filter and performance ranking only for `auto`, then runs the existing failover loop.

**Tech Stack:** TypeScript (strict), Cloudflare Workers + Durable Objects, Vitest, Node scripts.

**Spec:** `specs/epics/e04-mpx-performance-routing/design.md`

## Global Constraints

- Pure modules (`src/mpx.ts`, `src/windows.ts`, `src/detect.ts`, `src/vault-crypto.ts`) MUST NOT import `cloudflare:workers` or use Cloudflare globals.
- MPX live fetch timeout is exactly `1200` ms; cache TTL is exactly `5 * 60_000` ms; ranking ignores live data older than `6 * 60 * 60_000` ms.
- Auto is the only behavior that changes ordering; explicit model ids and per-request `fallbacks` keep their order.
- Never remove an explicit/paid model from the registry; only exclude it from `auto`.
- Every task ends with `npm test && npm run typecheck` green and a conventional commit.
- Do not log API keys or full upstream bodies.
- Follow `biome.json` (2-space, single quotes, 180 columns) for new code.

## Review Focus

1. MPX returns malformed or empty JSON → router serves with static order, no throw.
2. MPX fetch hangs → no request waits longer than ~1.2 s, then static/snapshot order.
3. A FREE model reports `RATE_LIMITED` → penalized in ranking but still usable as a fallback (not excluded).
4. Every candidate is excluded by MPX (e.g. provider outage) → the original candidate chain survives.
5. An explicit model MPX marks `PREVIOUSLY_FREE` → still requestable by id; only `auto` avoids it.

---

### Task 1: Pure MPX module

**Files:**
- Create: `src/mpx.ts`
- Test: `test/mpx.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MpxFreeStatus = 'FREE' | 'PREVIOUSLY_FREE' | 'UNKNOWN';
  export interface MpxPerfRow { provider: string; model: string; freeStatus: MpxFreeStatus; active: boolean; status: string; tps24: number | null; ttft24: number | null; uptime7d: number | null; samples24h: number; }
  export interface MpxSnapshot { rows: MpxPerfRow[]; fetchedAt: number; source: 'live' | 'snapshot'; lastBenchmark: string | null; stale: boolean; }
  export interface MpxCatalogModel { provider: string; id: string; freeStatus: MpxFreeStatus; active: boolean; context: number; capabilities: string[]; }
  export function normalizeProvider(name: string): string;
  export function normalizeModelId(id: string): string;
  export function parseLeaderboard(payload: unknown, fetchedAt?: number): MpxSnapshot;
  export function parseCatalog(payload: unknown): MpxCatalogModel[];
  export function performanceScore(row: MpxPerfRow): number;
  export function rankCandidates<T extends { provider: { id: string }; model: string }>(candidates: T[], snapshot: MpxSnapshot | undefined, staticScore: (c: T) => number): T[];
  ```
- `normalizeProvider`: map `opencode_zen`→`zen`, `opencode_go`→`opencode`, `ollama_pro`→`ollama`, `tokenrouter`→`truerouter`; unknown names pass through.
- `normalizeModelId`: strip a leading `models/`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeModelId, normalizeProvider, parseCatalog, parseLeaderboard, performanceScore, rankCandidates } from '../src/mpx';

const leaderboard = {
  leaderboard: [
    { provider: 'openrouter', model: 'minimax/minimax-m3.1-flash:free', free_status: 'FREE', status: 'SUCCESS', tps_24h: 160, ttft_24h: 3400, uptime_7d: 1, sampleCount24h: 20 },
    { provider: 'opencode_zen', model: 'deepseek-v4.1-flash-free', free_status: 'FREE', status: 'PROVIDER_ERROR', tps_24h: 0, ttft_24h: null, uptime_7d: 0.2, sampleCount24h: 7 },
    { provider: 'openrouter', model: 'retired:free', free_status: 'PREVIOUSLY_FREE', status: 'SUCCESS', tps_24h: 90, ttft_24h: 900, uptime_7d: 1, sampleCount24h: 12 },
  ],
  meta: { last_benchmark: '2026-10-21T10:15:00.000Z', is_stale: true },
};

describe('mpx normalization', () => {
  it('maps provider aliases and strips gemini models/ prefix', () => {
    expect(normalizeProvider('opencode_zen')).toBe('zen');
    expect(normalizeProvider('tokenrouter')).toBe('truerouter');
    expect(normalizeProvider('groq')).toBe('groq');
    expect(normalizeModelId('models/gemini-flash-lite-latest')).toBe('gemini-flash-lite-latest');
  });
});

describe('parseLeaderboard', () => {
  it('keeps free flags, normalizes ids, and reads meta', () => {
    const s = parseLeaderboard(leaderboard, 1);
    expect(s.rows).toHaveLength(3);
    expect(s.rows[1]!.provider).toBe('zen');
    expect(s.rows[2]!.freeStatus).toBe('PREVIOUSLY_FREE');
    expect(s.lastBenchmark).toBe('2026-10-21T10:15:00.000Z');
    expect(s.stale).toBe(true);
  });
  it('returns an empty snapshot for malformed input instead of throwing', () => {
    expect(parseLeaderboard(null).rows).toEqual([]);
    expect(parseLeaderboard({ leaderboard: 'nope' }).rows).toEqual([]);
  });
});

describe('performanceScore', () => {
  it('ranks higher TPS/TTFT/uptime above a slow erroring model', () => {
    const [fast, slow] = parseLeaderboard(leaderboard).rows;
    expect(performanceScore(fast!)).toBeGreaterThan(performanceScore(slow!));
  });
  it('shrinks low-sample rows toward neutral', () => {
    const base = { provider: 'groq', model: 'x', freeStatus: 'FREE' as const, active: true, status: 'SUCCESS', tps24: 1100, ttft24: 300, uptime7d: 1 };
    expect(performanceScore({ ...base, samples24h: 1 })).toBeLessThan(performanceScore({ ...base, samples24h: 20 }));
  });
  it('penalizes a rate-limited row but keeps it rankable', () => {
    const base = { provider: 'groq', model: 'x', freeStatus: 'FREE' as const, active: true, tps24: 1000, ttft24: 300, uptime7d: 1, samples24h: 20 };
    expect(performanceScore({ ...base, status: 'RATE_LIMITED' })).toBeLessThan(performanceScore({ ...base, status: 'SUCCESS' }));
    expect(performanceScore({ ...base, status: 'RATE_LIMITED' })).toBeGreaterThan(0);
  });
  it('returns 0 for non-free or unavailable rows', () => {
    const row = { provider: 'groq', model: 'x', freeStatus: 'PREVIOUSLY_FREE' as const, active: true, status: 'SUCCESS', tps24: 1000, ttft24: 300, uptime7d: 1, samples24h: 20 };
    expect(performanceScore(row)).toBe(0);
  });
});

describe('rankCandidates', () => {
  const cands = [
    { provider: { id: 'zen' }, model: 'deepseek-v4.1-flash-free' },
    { provider: { id: 'openrouter' }, model: 'minimax/minimax-m3.1-flash:free' },
    { provider: { id: 'groq' }, model: 'openai/gpt-oss-20b' },
  ];
  it('sorts by perf and drops non-free rows when a survivor exists', () => {
    const out = rankCandidates(cands, parseLeaderboard(leaderboard), () => 0);
    expect(out.map((c) => c.provider.id)).toEqual(['openrouter', 'zen', 'groq']);
  });
  it('keeps the original chain when every candidate is excluded', () => {
    const snap = parseLeaderboard({ leaderboard: cands.map((c) => ({ provider: c.provider.id, model: c.model, free_status: 'PREVIOUSLY_FREE', status: 'SUCCESS' })) });
    expect(rankCandidates(cands, snap, () => 0)).toEqual(cands);
  });
  it('falls back to static score when the snapshot is missing', () => {
    const out = rankCandidates(cands, undefined, (c) => (c.provider.id === 'groq' ? 10 : 1));
    expect(out[0]!.provider.id).toBe('groq');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mpx.test.ts`
Expected: FAIL — module `../src/mpx` not found.

- [ ] **Step 3: Implement `src/mpx.ts`**

Implement the exported signatures above. Parsing must never throw: wrap field access, skip rows without provider/model, and dedupe by `provider:model`. Scoring uses the exact weights from the spec:
`0.45*speed + 0.25*latency + 0.30*reliability`, shrunk by `confidence = min(1, samples24h/12)`, status multipliers `SUCCESS 1`, `RATE_LIMITED 0.5`, `TIMEOUT 0.6`, `PROVIDER_ERROR/STREAM_ERROR 0.4`, unknown `0.7`. `speed = clamp01(log1p(max(0,tps)) / log1p(1200))`, `latency = ttft == null ? 0.3 : clamp01(1 - ttft/8000)`, `reliability = uptime_7d ?? 0.5`.

`rankCandidates` scores each candidate from its matching row; a row is excluded when `freeStatus !== 'FREE' || !active || status === 'MODEL_UNAVAILABLE'`. Partition candidates into `known` (a matching row) and `unknown`; sort `known` by performance score, `unknown` by `staticScore`, and concatenate. This keeps the 0–1 perf scale from being compared directly with raw weights (45–135). If every candidate is excluded, keep all. Stable tie-break by `staticScore` then original index. Return a new array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mpx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mpx.ts test/mpx.test.ts
git commit -m "feat(mpx): pure performance parsing, scoring, and candidate ranking"
```

---

### Task 2: Generated catalog + sync script

**Files:**
- Create: `scripts/sync-modelpulse.mjs`
- Create (generated): `src/mpx-catalog.generated.ts`
- Modify: `package.json` (script entry)
- Test: `test/mpx-catalog.test.ts`

**Interfaces:**
- Produces from `src/mpx-catalog.generated.ts`:
  ```ts
  export const MPX_SNAPSHOT_AT: string;
  export const MPX_CATALOG: import('./mpx').MpxCatalogModel[];
  export const MPX_PERF: import('./mpx').MpxPerfRow[];
  ```
- `package.json` script: `"sync:modelpulse": "node scripts/sync-modelpulse.mjs"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MPX_CATALOG, MPX_PERF, MPX_SNAPSHOT_AT } from '../src/mpx-catalog.generated';

it('generated catalog is non-empty and has a timestamp', () => {
  expect(Number.isNaN(Date.parse(MPX_SNAPSHOT_AT))).toBe(false);
  expect(MPX_CATALOG.length).toBeGreaterThan(0);
  expect(MPX_PERF.length).toBeGreaterThan(0);
});

it('catalog carries the current zen free ids and groq safeguard', () => {
  const zen = MPX_CATALOG.filter((m) => m.provider === 'zen' && m.freeStatus === 'FREE').map((m) => m.id);
  expect(zen).toContain('deepseek-v4.1-flash-free');
  expect(MPX_CATALOG.some((m) => m.provider === 'groq' && m.id === 'openai/gpt-oss-safeguard-20b' && m.freeStatus === 'FREE')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mpx-catalog.test.ts`
Expected: FAIL — generated module not found.

- [ ] **Step 3: Implement `scripts/sync-modelpulse.mjs`**

Fetch `GET ${BASE}/api/models?includeInactive=1` and `GET ${BASE}/api/leaderboard?range=24h&sort=overall&profile=balanced` (`BASE` = `MODELPULSE_URL` env or `https://modelpulsex.pages.dev`). Throw on non-200, never write a partial file. Use the same normalization/scoring rules as `src/mpx.ts` (plain JS copies are acceptable; keep them in sync). Write `src/mpx-catalog.generated.ts` with a header `// AUTO-GENERATED by scripts/sync-modelpulse.mjs — do not edit.`, `MPX_SNAPSHOT_AT = new Date().toISOString()`, and JSON stringified arrays. Add the npm script.

- [ ] **Step 4: Generate and verify**

Run: `node scripts/sync-modelpulse.mjs && npx vitest run test/mpx-catalog.test.ts`
Expected: PASS, and `git diff --stat` shows only the generated file plus `package.json`.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-modelpulse.mjs src/mpx-catalog.generated.ts test/mpx-catalog.test.ts package.json package-lock.json
git commit -m "feat(mpx): sync free catalog and performance snapshot from ModelPulseX"
```

---

### Task 3: Config merge, free filter, auto overrides

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `src/detect.ts`
- Modify: `test/config.test.ts`, `test/detect.test.ts`, `test/routing-accuracy.test.ts`

**Interfaces:**
- Produces: `export function isFreeForAuto(p: ProviderConfig, modelId: string): boolean` from `src/config.ts`.
- Adds `ModelInfo.free?: boolean`.
- Adds `ProviderConfig.autoOverride?: { text?: boolean; vision?: boolean; audio?: boolean }`.
- `applyRuntimeOverrides` sets `autoOverride` flags when `autoText`/`autoVision`/`autoAudio` are present.
- `chooseModel(p, requested, caps, pool?)` honors `p.autoOverride` before intelligence sorting.

- [ ] **Step 1: Write failing tests**

In `test/config.test.ts`:
```ts
import { applyRuntimeOverrides, isFreeForAuto } from '../src/config';
it('merges ModelPulseX free models and excludes retired ones from auto', () => {
  const ps = getProviders({});
  const zen = ps.find((p) => p.id === 'zen')!;
  expect(zen.models.some((m) => m.id === 'deepseek-v4.1-flash-free')).toBe(true);
  expect(isFreeForAuto(zen, 'deepseek-v4.1-flash-free')).toBe(true);
  expect(isFreeForAuto(zen, 'muse-spark-1.2-contributor-free')).toBe(false);
  const opencode = ps.find((p) => p.id === 'opencode')!;
  expect(isFreeForAuto(opencode, 'claude-opus-5')).toBe(false);
  const groq = ps.find((p) => p.id === 'groq')!;
  expect(isFreeForAuto(groq, 'openai/gpt-oss-safeguard-20b')).toBe(true);
});
```

In `test/detect.test.ts`, replace the old auto-text expectation:
```ts
it('auto text picks only verified-free models', () => {
  const cands = selectCandidates(parseModelSpec(undefined), detect(req({ messages: [{ role: 'user', content: 'hi' }] })), providers());
  expect(cands.length).toBeGreaterThan(0);
  expect(cands.every((c) => isFreeForAuto(c.provider, c.model))).toBe(true);
  expect(cands.some((c) => c.model === 'claude-opus-5' || c.model === 'muse-spark-1.2-contributor-free')).toBe(false);
});
```

Add an override test:
```ts
it('honors an explicit autoText override', () => {
  const ps = getProviders({ GROQ_API_KEY: 'g' });
  const withOverride = applyRuntimeOverrides(ps, { zen: { autoText: 'deepseek-v4.1-flash-free' } });
  const zen = withOverride.find((p) => p.id === 'zen')!;
  expect(zen.autoOverride?.text).toBe(true);
  const cands = selectCandidates(parseModelSpec('auto'), detect(req({})), withOverride);
  expect(cands[0]?.provider.id).toBe('zen');
  expect(cands[0]?.model).toBe('deepseek-v4.1-flash-free');
});
```

Update the routing-accuracy `auto text` fixture name/assertions to free-only behavior, and the reasoning fixture to not require the unverified OpenRouter reasoning id (assert every reasoning candidate is free and at least one exists). Add:
```ts
it('explicit previously-free models stay requestable', () => {
  const cands = selectCandidates(parseModelSpec('muse-spark-1.2-contributor-free'), detect(req({ model: 'muse-spark-1.2-contributor-free' })), providers());
  expect(cands.some((c) => c.model === 'muse-spark-1.2-contributor-free')).toBe(true);
});
```
Update `test/openai-compat-matrix.test.ts`: the embeddings-model count drops after Task 5 removes the dead `text-embedding-3-small` registrations. Expect the working set (`cloudflare` 2, `gemini` 1, `mistral` 1) and assert the dead ids are absent from `zen`, `opencode`, and `openrouter`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts test/detect.test.ts test/routing-accuracy.test.ts`
Expected: FAIL — `isFreeForAuto` not exported; auto still returns paid ids.

- [ ] **Step 3: Implement**

- `src/types.ts`: add `free?: boolean` to `ModelInfo`; add `autoOverride` to `ProviderConfig`.
- `src/config.ts`: import `MPX_CATALOG`; group rows by normalized provider; in `resolveProvider`, after the Zen/OpenCode env handling, merge:
  - existing model with `PREVIOUSLY_FREE` → `{...m, free: false}`;
  - missing `FREE` + active model → append `{id, aliases: [baseId], capabilities: sanitized, context: row.context || 131072, free: true}`.
  - Derive `baseId` by stripping `:free`/`-free`; do not add generic aliases.
  - `isFreeForAuto`: return false when `m.free === false`; if MPX has rows for this provider, return true only when the matching row is `FREE` + active; otherwise fall back to `isFreeZenModel` (zen/opencode), `:free`/`openrouter/free` (openrouter), or `true`.
- `src/config.ts` `applyRuntimeOverrides`: set `next.autoOverride` flags.
- `src/detect.ts`: in the auto branch, build `free = p.models.filter((m) => isFreeForAuto(p, m.id))`, pass it to `chooseModel`; if `free.length === 0`, use `p.models`. In `chooseModel`, if `p.autoOverride?.text|vision|audio` is set and `p.auto[cap]` is in the pool, return it; else continue with intelligence. Remove the dead `spec.model === 'auto'` comparator block.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/config.test.ts test/detect.test.ts test/routing-accuracy.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

Run: `npm test && npm run typecheck`
Expected: green.
```bash
git add src/types.ts src/config.ts src/detect.ts test/config.test.ts test/detect.test.ts test/routing-accuracy.test.ts
git commit -m "feat(routing): restrict auto to ModelPulseX-verified free models and honor auto overrides"
```

---

### Task 4: Live MPX source with cache and fail-open

**Files:**
- Create: `src/mpx-source.ts`
- Test: `test/mpx-source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function bakedSnapshot(): MpxSnapshot;
  export function clearMpxCache(): void;
  export async function loadMpxSnapshot(env?: { MODELPULSE_URL?: unknown }): Promise<MpxSnapshot>;
  ```
- Behavior: TTL `300_000`; timeout `1200`; single-flight; any error → `bakedSnapshot()`; live `lastBenchmark` older than 6 h → return `{...live, stale: true}`.

- [ ] **Step 1: Write failing tests**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMpxCache, loadMpxSnapshot } from '../src/mpx-source';

const payload = { leaderboard: [{ provider: 'groq', model: 'openai/gpt-oss-20b', free_status: 'FREE', status: 'SUCCESS', tps_24h: 1000, ttft_24h: 300, uptime_7d: 1, sampleCount24h: 20 }], meta: { last_benchmark: new Date().toISOString(), is_stale: false } };

afterEach(() => { clearMpxCache(); vi.unstubAllGlobals(); });

it('fetches once and caches within the TTL', async () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal('fetch', f);
  expect((await loadMpxSnapshot()).rows[0]!.provider).toBe('groq');
  await loadMpxSnapshot();
  expect(f).toHaveBeenCalledTimes(1);
});

it('falls back to the baked snapshot on failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
  const s = await loadMpxSnapshot();
  expect(s.source).toBe('snapshot');
  expect(s.rows.length).toBeGreaterThan(0);
});

it('passes an abort signal so a hung fetch cannot stall routing', async () => {
  const f = vi.fn().mockRejectedValue(new Error('timeout'));
  vi.stubGlobal('fetch', f);
  await loadMpxSnapshot();
  expect((f.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
});

it('marks a week-old live payload stale for ranking', async () => {
  const old = { ...payload, meta: { last_benchmark: '2026-10-01T00:00:00.000Z', is_stale: true } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(old), { status: 200 })));
  expect((await loadMpxSnapshot()).stale).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mpx-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mpx-source.ts`**

Module-level `cache` and `inflight`. `fetchSnapshot` builds `${base}/api/leaderboard?range=24h&sort=overall&profile=balanced`, uses `AbortSignal.timeout(1200)`, `parseLeaderboard(json, Date.now())`, returns `undefined` on non-200/empty/throw. Never log the URL query body. `bakedSnapshot()` builds from `MPX_PERF` with `source: 'snapshot'`, `fetchedAt: Date.parse(MPX_SNAPSHOT_AT) || 0`, `stale: false`.

- [ ] **Step 4: Run test**

Run: `npx vitest run test/mpx-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mpx-source.ts test/mpx-source.test.ts
git commit -m "feat(mpx): live performance source with cache and snapshot fallback"
```

---

### Task 5: Router auto ranking, 410/model-unavailable failover, embeddings auto

**Files:**
- Modify: `src/router.ts`, `src/limiter.ts`, `src/config.ts`
- Modify: `test/router.integration.test.ts`, `test/openai-compat-matrix.test.ts`
- Create: `test/router-perf.test.ts`

**Interfaces:**
- Consumes `loadMpxSnapshot`, `rankCandidates`, `getScore`.
- Adds internal `isModelUnavailableResponse(res: Response): Promise<boolean>`.
- `buildCandidateChain` gains an `endpoint`-aware embeddings auto branch.
- Limiter `cooldown`/`cooldownModel` ops accept `dayAnchorUtc?: number`.

- [ ] **Step 1: Write failing tests**

In `test/router.integration.test.ts` (extend the import to `import { routeChat, routeCompletion, routeEmbedding } from '../src/router';`):
```ts
it('fails over on 410 ModelDeprecated and cools only that model', async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'ModelDeprecated', message: 'deprecated' } }), { status: 410, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(upstreamResponse('next provider'));
  vi.stubGlobal('fetch', f);
  const env = makeEnv({ GROQ_API_KEY: 'g', CEREBRAS_API_KEY: 'c' });
  const res = await routeChat(makeRequest('gpt-oss'), env as never, { model: 'gpt-oss', messages: [{ role: 'user', content: 'hi' }] });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-router-provider')).toBe('cerebras');
});

it('fails over on 400 "Model is unavailable"', async () => {
  const f = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Model is unavailable.' } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(upstreamResponse('next provider'));
  vi.stubGlobal('fetch', f);
  const env = makeEnv({ GROQ_API_KEY: 'g', CEREBRAS_API_KEY: 'c' });
  const res = await routeChat(makeRequest('gpt-oss'), env as never, { model: 'gpt-oss', messages: [{ role: 'user', content: 'hi' }] });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-router-provider')).toBe('cerebras');
});

it('returns OpenAI-shaped 404 when every attempt is model_unavailable', async () => {
  vi.stubGlobal('fetch', mockFetch(() => new Response(JSON.stringify({ error: { message: 'Model is unavailable.' } }), { status: 404, headers: { 'content-type': 'application/json' } })));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });
  expect(res.status).toBe(404);
  const j = await res.json() as { error: { code: string; tried: unknown[] } };
  expect(j.error.code).toBe('model_not_found');
  expect(j.error.tried.length).toBeGreaterThan(0);
});
```

In `test/router-perf.test.ts`, mock `../src/mpx-source`:
```ts
vi.mock('../src/mpx-source', () => ({
  loadMpxSnapshot: vi.fn(async () => ({ rows: [
    { provider: 'groq', model: 'openai/gpt-oss-20b', freeStatus: 'FREE', active: true, status: 'SUCCESS', tps24: 1100, ttft24: 300, uptime7d: 1, samples24h: 20 },
    { provider: 'mistral', model: 'mistral-small-latest', freeStatus: 'FREE', active: true, status: 'SUCCESS', tps24: 50, ttft24: 900, uptime7d: 1, samples24h: 20 },
  ], fetchedAt: Date.now(), source: 'live', lastBenchmark: null, stale: false })),
}));
it('auto ranks free candidates by measured performance', async () => {
  const f = vi.fn().mockResolvedValue(upstreamResponse('ok'));
  vi.stubGlobal('fetch', f);
  const env = makeEnv({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm' });
  const res = await routeChat(makeRequest('auto'), env as never, { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  expect(res.headers.get('x-router-provider')).toBe('groq');
  expect(f.mock.calls[0]![0]).toContain('api.groq.com');
});
```
Add an embeddings test: `routeEmbedding` with `{model:'auto', input:'hi'}` and mocks for gemini/mistral, assert the first call URL is an embeddings endpoint and provider is embeddings-capable.

Add to `test/router.integration.test.ts`:
```ts
it('serves Workers AI embeddings instead of reporting unsupported', async () => {
  const env = makeEnv({});
  const ai = env.AI as { run: ReturnType<typeof vi.fn> };
  ai.run = vi.fn(async () => ({ data: [[0.1, 0.2]], shape: [1, 2] }));
  const res = await routeEmbedding(new Request('https://router.test/v1/embeddings', { method: 'POST' }), env as never, { model: 'bge-base', input: 'hi' });
  expect(res.status).toBe(200);
  const j = await res.json() as { data: { embedding: number[] }[] };
  expect(j.data[0]!.embedding).toEqual([0.1, 0.2]);
});

it('does not copy stale content-length onto a sanitized response', async () => {
  vi.stubGlobal('fetch', mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<think>x</think>hello' } }] }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999' } })));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });
  expect(res.headers.get('content-length')).toBeNull();
  expect((await res.json() as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('hello');
});

it('returns text_completion SSE for legacy completions with stream:true', async () => {
  vi.stubGlobal('fetch', mockFetch(() => upstreamResponse('hello')));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeCompletion(new Request('https://router.test/v1/completions', { method: 'POST' }), env as never, { model: 'groq/llama-3.3-70b-versatile', prompt: 'hi', stream: true });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text();
  expect(text).toContain('"object":"text_completion"');
  expect(text.trim().endsWith('data: [DONE]')).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/router.integration.test.ts test/router-perf.test.ts`
Expected: FAIL on 410 (passthrough), 404 (503), and auto ordering.

- [ ] **Step 3: Implement**

- In `routeWithEndpoint`: compute `isAuto = parseModelSpec(modelStr).model === 'auto'`; if auto, `const snapshot = await loadMpxSnapshot(env as { MODELPULSE_URL?: unknown })`; build chain; `rankCandidates(chain, snapshot, (c) => c.provider.weight + (getScore(c.model)?.score ?? 0))`.
- In `buildCandidateChain`: if `endpoint.includes('embeddings')` and spec model is `auto`, primary = every active provider's embeddings-capable models, weight-ordered.
- Add `isModelUnavailableResponse`: status 410, or 400/404 with JSON `error.message|code|type` matching `/model.*(unavailable|not found|does not exist|deprecated|invalid model)/i`. In the loop, before 429 handling, call it; on match `cooldownModel(..., 300)` and continue.
- At the end: if `tried.length > 0 && tried.every((t) => t.reason === 'model_unavailable')` return `jsonErr(404, ..., { tried }, { code: 'model_not_found' })`.
- `sanitizeChatContent`: clone headers, delete `content-length`, `content-encoding`, `transfer-encoding`, `connection`.
- Legacy completions `stream:true`: force `stream:false` on the chat call, then synthesize `text_completion` SSE (`data: {...}` + `data: [DONE]`).
- `routeRaw`: skip candidates with `!cand.provider.baseUrl` (`reason: 'unsupported_endpoint'`).
- `callCloudflareAI` embeddings: `const r = await env.AI.run(model, { text: Array.isArray(input) ? input : [String(input)] })`; return an OpenAI `{object:'list', data:[{object:'embedding', embedding, index}], model, usage:{prompt_tokens:0,total_tokens:0}}` response. Never return `workers_ai_no_embeddings`.
- `src/config.ts`: remove `openai/text-embedding-3-small` from `zen` and `opencode`, `openai/text-embedding-3-small:free` from `openrouter`, and `nvidia/nv-embedqa-e5-v5` from `nvidia`. Keep the Cloudflare `bge-*`, Gemini, and Mistral embeddings.
- `src/limiter.ts`: add `dayAnchorUtc?: number` to cooldown ops and use `freshBucket(now, op.dayAnchorUtc ?? 0)`; pass it from every router `cooldown` call.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/router.integration.test.ts test/router-perf.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

Run: `npm test && npm run typecheck`
```bash
git add src/router.ts src/limiter.ts test/router.integration.test.ts test/router-perf.test.ts
git commit -m "fix(router): fail over on retired models and rank auto by ModelPulseX performance"
```

---

### Task 6: HTTP surface, raw body, vault touchKey

**Files:**
- Modify: `src/index.ts`, `src/vault.ts`
- Create: `test/http-fixes.test.ts`

**Interfaces:**
- Consumes the default worker export; tests call `worker.fetch(request, env, ctx)`.
- `VaultOp` `touchKey` becomes `{ op: 'touchKey'; key: string }`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// Fake VAULT: captures every op, returns {ok:true} for checkKey/touchKey.
// Fake LIMITER: returns {ok:true} for acquire and {buckets:{},now} for stats.
// Set ROUTER_API_KEY: 'k' in env and send `authorization: Bearer k` on requests.
function envWith(capture: { op?: unknown }, extra: Record<string, unknown> = {}) { /* build the two namespaces + ROUTER_API_KEY */ }

it('preserves the JSON body for images/generations', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { seen.push(String(init.body)); return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
  const res = await worker.fetch(new Request('https://r.test/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify({ model: 'auto', prompt: 'cat' }) }), envWith({}) as never, {} as never);
  expect(res.status).toBe(200);
  expect(seen[0]).toContain('"prompt":"cat"');
});

it('returns 404 for an unknown /v1 POST instead of rerouting to embeddings', async () => {
  const f = vi.fn(); vi.stubGlobal('fetch', f);
  const res = await worker.fetch(new Request('https://r.test/v1/does-not-exist', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: JSON.stringify({ model: 'auto' }) }), envWith({}) as never, {} as never);
  expect(res.status).toBe(404);
  expect(f).not.toHaveBeenCalled();
});

it('sends touchKey with the raw key', async () => {
  const ops: unknown[] = [];
  // fake VAULT captures ops; fake LIMITER returns ok
  // send a valid sk-fr- key; assert ops contains {op:'touchKey', key:'sk-fr-…'}
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/http-fixes.test.ts`
Expected: FAIL (body dropped, 200/401 instead of 404, touchKey missing).

- [ ] **Step 3: Implement**

- `src/index.ts`: for every JSON raw endpoint, encode `parsed.body` into bytes and pass to `routeRaw` (remove the special `null` branch).
- Delete the catch-all `if (path.startsWith('/v1/') && request.method === 'POST') { ... routeEmbedding ... }` block; return `jsonErr(404, ...)`.
- `touchKey`: `void vaultFetch(env, { op: 'touchKey', key: candidate })`.
- Wrap `decodeURIComponent` in `try/catch` → `jsonErr(400, 'invalid model id')`.
- Remove unused `isAdminPath`/`normalizePath` if trivial.
- `src/vault.ts`: change the op type, handler, and `touchKey(key)` to hash with `sha256Hex` before `this.keys.get(hash)`.

- [ ] **Step 4: Run test + gate**

Run: `npx vitest run test/http-fixes.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/vault.ts test/http-fixes.test.ts
git commit -m "fix(http): preserve raw JSON bodies, 404 unknown endpoints, and touch keys by hash"
```

---

### Task 7: Dashboard, packaging, scripts

**Files:**
- Modify: `src/admin.ts`, `package.json`, `package-lock.json`, `.github/workflows/deploy.yml`, `scripts/benchmark.mjs`

**Interfaces:**
- No new exports. Dashboard `scores` uses `getScore`; `renderChain` escapes all interpolated text.

- [ ] **Step 1: Add an assertion test**

Add to `test/config.test.ts`:
```ts
it('default benchmark base points at the live worker', async () => {
  const src = await import('node:fs/promises').then((fs) => fs.readFile('scripts/benchmark.mjs', 'utf8'));
  expect(src).toContain('free-llm-router.vipulgote5.workers.dev');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — old `vipulgote4` URL.

- [ ] **Step 3: Implement**

- `src/admin.ts`: import `getScore`; `scores: Object.fromEntries(p.models.map((mm) => [mm.id, getScore(mm.id) ?? null]))`; escape `l.provider` and `l.reason` in `renderChain`.
- `package.json`: move `@cloudflare/workerd-linux-arm64` from `devDependencies` to `optionalDependencies`; add `"sync:modelpulse"` if not already present.
- Regenerate lock: `npm install --package-lock-only --no-audit --no-fund`.
- `.github/workflows/deploy.yml`: remove both `jq ... del(.devDependencies...)` steps; use `npm ci`.
- `scripts/benchmark.mjs`: default base → `https://free-llm-router.vipulgote5.workers.dev`.

- [ ] **Step 4: Verify install + gate**

Run: `npm install --no-audit --no-fund && npm ci --no-audit --no-fund && npm test && npm run typecheck`
Expected: install succeeds on x64 without `--force`; all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/admin.ts package.json package-lock.json .github/workflows/deploy.yml scripts/benchmark.mjs test/config.test.ts
git commit -m "chore: fix installability, benchmark target, and dashboard escaping"
```

---

### Task 8: Documentation, spec state, live verification

**Files:**
- Modify: `README.md`, `SESSION.md`, `specs/state.yaml`, `specs/execution-status.yaml`, `specs/epics/e04-mpx-performance-routing/epic.yaml`

- [ ] **Step 1: Update docs**

README: add a "Performance-aware auto routing (ModelPulseX)" section documenting `MODELPULSE_URL`, the free-only rule, the fallback ladder, and `npm run sync:modelpulse`. Update the provider table rows for Zen/OpenCode/Groq/OpenRouter embeddings where they changed. Note that `text-embedding-3-small` is no longer served by free providers; list `gemini-embedding-001`, `mistral-embed`, `bge-base`, `bge-m3`.

`SESSION.md`: append a dated entry with evidence (preflight counts, live responses).

Specs: mark e04 stories complete and set `active_epic_id: e04` + release notes.

- [ ] **Step 2: Full preflight**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean. Record the exact counts.

- [ ] **Step 3: Live verification (requires deploy approval)**

Run:
```bash
curl -sS -H "Authorization: Bearer $ROUTER_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say OK"}],"max_tokens":8}' \
  https://free-llm-router.vipulgote5.workers.dev/v1/chat/completions -D -
```
Expected: HTTP 200, `x-router-provider` is `groq` or `mistral` (not `zen`), no 410.

```bash
curl -sS ... -d '{"model":"gemini-embedding-001","input":"hello"}' .../v1/embeddings
```
Expected: 200 with 3072-element vector.

- [ ] **Step 4: Commit**

```bash
git add README.md SESSION.md specs/state.yaml specs/execution-status.yaml specs/epics/e04-mpx-performance-routing/epic.yaml
git commit -m "docs(e04): document ModelPulseX routing and record verification"
```

---

## Self-Review

- Spec coverage: data contract (Tasks 1–2), routing algorithm (Tasks 1, 3, 5), fail-open (Task 4), catalog sync (Tasks 2–3), all 15 defect fixes (Tasks 5–7), tests/rollout (Tasks 1–8).
- Type consistency: `MpxPerfRow`, `MpxSnapshot`, `MpxCatalogModel` defined once in Task 1 and imported everywhere; `isFreeForAuto` defined in Task 3 and used in Tasks 3/5.
- Review Focus: malformed MPX (Task 1/4), hang (Task 4), rate-limited penalty (Task 1), all-excluded survival (Task 1/5), previously-free explicit (Task 3).
- Proportion: plan uses signatures and test assertions; bodies only for the scoring constants and the exact MPX mapping.
