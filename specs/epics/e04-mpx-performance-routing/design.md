# e04 — ModelPulseX Performance-Aware Routing + Defect Fixes

**Status:** approved design (2026-10-21)
**Owner:** router
**Source of truth for free-model state:** [ModelPulseX](https://modelpulsex.pages.dev) (`/api/models`, `/api/leaderboard`)

## Context

The router's static model registry drifted from the live free tiers. Live probes on
2026-10-21 reproduced:

- `model:"auto"` returned `410 ModelDeprecated` from
  `zen/muse-spark-1.2-contributor-free` and did **not** fail over.
- `POST /v1/embeddings` with `text-embedding-3-small` returned `503` because all three
  registered aliases (`opencode`, `zen`, `openrouter`) are dead upstream.
- An unknown model returned a raw upstream `400` instead of an OpenAI-shaped `404`.
- ModelPulseX discovery showed only **4** Zen models currently `FREE`; the router shipped
  **10** Zen models, none of them in that free set (7 `PREVIOUSLY_FREE`, inactive).
- ModelPulseX ranked `groq/openai/gpt-oss-safeguard-20b` #1 (TPS 1151, TTFT 292 ms,
  96.2% uptime) — it was absent from the router.

The router must stop guessing which models are free and fast, and treat ModelPulseX as
the observed source of truth while remaining fully functional when ModelPulseX is down
or stale.

## Goals

1. `auto` routes only to models ModelPulseX reports as `FREE` and active (or to the static
   free heuristic only when MPX has no data for that provider).
2. `auto` prefers measured performance: TPS, TTFT, and uptime over static weights and
   Artificial Analysis intelligence.
3. Routing degrades safely: live MPX → checked-in snapshot → static order.
4. All confirmed production defects listed below are fixed and covered by tests.
5. Preflight (`npm test && npm run typecheck`) is green; live `auto` returns 200 from a
   verified free model.

## Non-goals

- Adding the seven providers MPX monitors but the router does not (kilocode, glhf,
  agnes_ai, aionlabs, nscale, speka, nexaapi, orcarouter, ninerouter, opencode_go).
- Cross-model embedding substitution. Different embedding models produce incompatible
  dimensions; a dead embedding model returns an actionable `404`, never a silent swap.
- Removing explicit models. Paid/retired models stay requestable by id; they are only
  excluded from `auto`.
- Real-time MPX data on every request. The live fetch is cached and non-blocking on the
  failure path.

## Data contract

### ModelPulseX endpoints

| Endpoint | Used for |
|---|---|
| `GET /api/models?includeInactive=1` | Free catalog: `provider_name`, `provider_model_id`, `free_status`, `active`, `context_length`, `capabilities` |
| `GET /api/leaderboard?range=24h&sort=overall&profile=balanced` | Perf: `provider`, `model`, `free_status`, `status`, `tps_24h`, `ttft_24h`, `uptime_7d`, `sampleCount24h`, `meta.last_benchmark`, `meta.is_stale` |

### Provider mapping

```
opencode_zen  -> zen, opencode (same catalog, different quota)
opencode_go   -> opencode
openrouter    -> openrouter
groq          -> groq
cerebras      -> cerebras
gemini        -> gemini
mistral       -> mistral
nvidia        -> nvidia
sambanova     -> sambanova
ollama        -> ollama
ollama_pro    -> ollama
tokenrouter   -> truerouter
```

Unmapped providers (cloudflare, truerouter fallback) use the static free heuristic.

### Model-id normalization

- Strip a leading `models/` (Gemini discovery ids).
- Keep OpenRouter `vendor/model:free` ids verbatim.
- Strip a `:free` suffix only for capability/alias lookup, never for the upstream id.

## Architecture

```
scripts/sync-modelpulse.mjs
        │  generate
        ▼
src/mpx-catalog.generated.ts ──► src/config.ts (merge FREE models, mark PREVIOUSLY_FREE)
                                        │
src/mpx.ts (pure parse/score/rank) ◄────┘
        ▲
src/mpx-source.ts (fetch, 1.2s timeout, 5-min cache, fail-open)
        ▲
src/router.ts (auto only: free filter → perf rank → existing failover loop)
```

### `src/mpx.ts` (pure, no Cloudflare imports)

- `normalizeProvider(name)`, `normalizeModel(id)`.
- `parseLeaderboard(json)` → validated, deduplicated rows.
- `parseCatalog(json)` → free/previously-free catalog.
- `performanceScore(row)` → `0..1`:
  - `speed = clamp01(log1p(tps) / log1p(1200))`
  - `latency = clamp01(1 - ttft / 8000)`
  - `reliability = uptime_7d ?? uptime_24h ?? 0.5`
  - `raw = 0.45*speed + 0.25*latency + 0.30*reliability`
  - shrink toward `0.5` by `confidence = min(1, sampleCount24h / 12)`
  - status multiplier: `SUCCESS 1`, `RATE_LIMITED 0.5`, `TIMEOUT 0.6`,
    `PROVIDER_ERROR/STREAM_ERROR 0.4`, other/unknown `0.7`;
    `MODEL_UNAVAILABLE` and `free_status !== FREE` are exclusion, not a score.
- `rankCandidates(candidates, snapshot, staticScore)`:
  - Exclude rows that are not `FREE`/active or are `MODEL_UNAVAILABLE` **only if at least
    one candidate survives**.
  - Stable sort by perf score; unknown rows use `staticScore` (weight + AA intelligence).
  - Return a new array; never mutate the input.

### `src/mpx-source.ts` (Cloudflare fetch allowed)

- Module-level cache: `{ snapshot, fetchedAt, promise }`, TTL 5 minutes.
- Single-flight: concurrent callers share one fetch.
- `AbortSignal.timeout(1200)`; on any error/timeout/invalid payload return the generated
  snapshot (or `undefined` when the generated snapshot is empty).
- Ignore a live payload whose `meta.last_benchmark` is older than 6 hours **for ranking**;
  still use it for free-status filtering (catalog truth changes more slowly).
- Never throws.

### `src/config.ts`

- Import the generated catalog at module load.
- For each covered provider, append MPX `FREE` models that are missing, using MPX
  `context_length`/`capabilities` and derived aliases (base id only; no generic aliases).
- Mark MPX `PREVIOUSLY_FREE` models with `free: false` when they already exist.
- `isFreeForAuto(provider, modelId)`:
  - If the provider is MPX-covered and the catalog has data: MPX `FREE` + active.
  - Else: static heuristic — Zen/OpenCode `isFreeZenModel`, OpenRouter `:free` or
    `openrouter/free`, other providers free-tier default.
- `auto` filters to `free !== false` and `isFreeForAuto`; if the filtered pool is empty
  (e.g. no free vision model), fall back to the unfiltered pool so the router still serves.

### `src/router.ts`

- Load the perf snapshot once per `auto` request (and embeddings `auto`).
- `buildCandidateChain` remains sync but receives the snapshot for post-ranking.
- `auto`: apply free filter (in `detect.ts`) then `rankCandidates` before the failover loop.
- Explicit model/fallback chains keep their order.
- Embeddings endpoint: when `model` is `auto`/empty, select only `embeddings`-capable
  models across providers, weight-ordered; otherwise honor the explicit model.
- Perf load failure is logged once per isolate (`mpx_unavailable`) and never blocks.

## Defect fixes (all confirmed)

| # | File | Fix |
|---|---|---|
| 1 | `src/router.ts` | Classify `410` and `400` bodies matching `model.*(unavailable|not found|does not exist|deprecated|invalid model)` as per-model retryable: `cooldownModel` (300 s) + continue to next candidate. Never passthrough a retryable 410. |
| 2 | `src/index.ts`, `src/router.ts` | `POST /v1/images/generations` and `/v1/audio/speech` must pass the parsed JSON body bytes to `routeRaw`; no `null` body. |
| 3 | `src/index.ts` | Remove the catch-all that re-routes any unknown `POST /v1/*` with a `model` to embeddings. Unknown endpoints return OpenAI-shaped `404`. |
| 4 | `src/index.ts`, `src/vault.ts` | `touchKey` must send `{op:'touchKey', key}`; VaultDO hashes it before lookup. `lastUsedAt` updates. |
| 5 | `src/router.ts` | `sanitizeChatContent` must delete `content-length`, `content-encoding`, `transfer-encoding`, `connection` before constructing the new response. |
| 6 | `src/config.ts`, `src/detect.ts` | Honor explicit admin `autoText`/`autoVision`/`autoAudio` overrides. Add `autoOverride` flags so registry defaults do not override intelligence ranking. |
| 7 | `src/limiter.ts` | Pass `dayAnchorUtc` through `cooldown`/`cooldownModel`; use it when creating a missing bucket (Gemini 08:00 UTC anchor). |
| 8 | `package.json`, `.github/workflows/deploy.yml` | Move `@cloudflare/workerd-linux-arm64` to `optionalDependencies`; remove the CI `jq` deletion hack. |
| 9 | `scripts/benchmark.mjs` | Default base URL → `https://free-llm-router.vipulgote5.workers.dev`. |
| 10 | `src/admin.ts` | Escape `provider`/`reason` in `renderChain`; resolve AA scores with `getScore()` so `:free` ids display. |
| 11 | `src/router.ts` | Legacy `/v1/completions` with `stream:true`: synthesize a `text_completion` SSE chunk + `[DONE]` instead of returning chat-chunk shapes. |
| 12 | `src/index.ts` | Guard `decodeURIComponent` on `/v1/models/:id` with `try/catch` → 400. |
| 13 | `src/router.ts` | `routeRaw` must not attempt Cloudflare (`baseUrl === ''`) or a provider without a key; skip with reason `unsupported_endpoint` instead of a network cooldown. |
| 14 | `src/router.ts` | When every attempt ended `model_unavailable`, return `404 model_not_found` with `tried[]` and available models, not `503`. |
| 15 | `src/config.ts`, `src/router.ts` | Remove dead embedding registrations (`zen`/`opencode`/`openrouter` `text-embedding-3-small`, `nvidia/nv-embedqa-e5-v5`) from auto. Implement the Workers AI embeddings path (`AI.run(model, {text:[...]})` → OpenAI `embeddings` shape) so `bge-base`/`bge-m3` work; keep Gemini and Mistral embeddings. |

## Testing

Pure (`test/mpx.test.ts`):
- Provider/model normalization.
- Leaderboard parsing rejects malformed rows, dedupes, keeps free flags.
- Score monotonicity: higher TPS / lower TTFT / higher uptime ranks higher.
- Low sample count shrinks toward neutral.
- `MODEL_UNAVAILABLE` and non-free rows excluded when a survivor exists.
- Ranking is stable and never mutates.

Config (`test/config.test.ts`):
- Generated PMX catalog merges missing free models (groq safeguard, openrouter/free).
- `isFreeForAuto` excludes `opencode/claude-opus-5` and retired Zen ids.
- Auto falls back to the unfiltered pool when no free model matches a capability.

Router (`test/router.integration.test.ts`):
- 410 → per-model cooldown → next provider succeeds.
- 400 "Model is unavailable" → failover.
- All-404 → OpenAI-shaped 404 with `tried[]`.
- Streaming legacy completions shape.
- JSON body preserved for images/speech (capture mocked fetch body).
- Auto ordering uses the injected snapshot (mock `mpx-source`).

Source (`test/mpx-source.test.ts`):
- Timeout/failure falls back to the generated snapshot.
- Cache prevents a second fetch within TTL.
- Stale live payload is not used for ranking.

Live verification (manual, after deploy):
- `model:"auto"` returns 200 with `x-router-provider` not `zen`.
- `text-embedding-3-small` returns a clear 404 (or 200 if a free provider appears).
- `gemini-embedding-001` returns 200.
- `POST /v1/does-not-exist` returns 404.
- `GET /admin` still renders and no unescaped model text executes.

## Rollout

1. Land the spec + plan.
2. Implement pure modules + tests first (TDD).
3. Wire config/router/index/vault/limiter/admin.
4. Run `node scripts/sync-modelpulse.mjs` to generate the checked-in snapshot.
5. Preflight green.
6. Deploy (separate approval) and run live verification.

## Risks

- **MPX staleness/outage:** fail-open ladder, 1.2 s timeout, checked-in snapshot.
- **MPX provider naming drift:** normalization is pure and tested; unknown providers fall
  back to static behavior.
- **Perf ranking flipping too aggressively:** only `auto` is reordered; stable tie-break
  by weight + intelligence; status penalties prevent a single bad sample from dominating.
- **Free-model churn:** `npm run sync:modelpulse` is the refresh path; the script is
  non-destructive to explicit models.
- **Zen outage:** MPX currently reports all Zen free models `PROVIDER_ERROR`; auto will
  avoid Zen until measured success returns. Explicit `zen/...` requests still work/fail over.
