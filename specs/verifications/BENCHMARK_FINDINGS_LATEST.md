# Benchmark Findings — 2026-08-17 (epic e02)

Base: https://free-llm-router.vipulgote4.workers.dev · iters=3 · conc=12

## Final numbers (9/9 checks)

| Metric | Value |
|---|---|
| Router overhead (groq direct vs routed) | **+9ms** |
| Concurrency: 12 parallel, auto | 0 errors, p95 **4.7s**, 2.6 req/s, all served by Workers AI |
| Single-shot latency avg | groq 326ms · cloudflare 446ms · mistral 545ms · nvidia 1174ms · openrouter 3292ms |
| Stream TTFT (groq) | 285ms, SSE ends `[DONE]` ✓ |
| Failover: cooldown skip | 195ms (DO check + 503 with reason) |
| Failover: 402 → skip | cerebras cooled 12h, chain continued ✓ |
| Accuracy corpus | 12/12 fixtures |

Providers down from CF egress this window (router handles): zen (429, per-IP free tier),
sambanova (429 high-demand), gemini intermittent 429 at minute boundaries.

## Bugs found & fixed by the benchmark

1. **`nvidia/...:free` model ids misparsed as forced-provider** — exact registered
   model id now wins over `provider/model` split (detect.ts).
2. **`@cf/...` ids broke `model@provider` force parsing** — `@`-suffix only applies
   when the suffix is a known provider id (detect.ts).
3. **Bench harness defects** (truncated-body parsing, missing timing wrapper,
   wrong stream expectation) — fixed in benchmark.mjs.

## Improvements made

- **402 → 12h cooldown** (was 5 min): "payment required" won't change mid-day;
  cerebras no longer burns a hop every 5 minutes.

## Reverted with evidence

- **Auto-mode load spreading (minute rotation + DO round-robin)**: measured,
  then reverted. Free tiers are *concurrency*-limited (mistral ~1 RPS), so a
  uniform spread queues on slow providers: p95 19.3s vs 4.7s weight-ordered.
  Weight order + 429-failover is the better strategy.

## Future work (epic e03 candidates)

- Per-provider **concurrency caps** in the limiter DO (acquire/release
  in-flight counts) so bursts queue on fast providers instead of slow ones.
- Per-hop **timeout budgets** (observed 64s chain when gemma-4 hit multiple
  dead ends; first hops should fail fast, last hop gets the full budget).
- **Health-aware weights**: adjust provider order from observed latency/429
  rates (EWMA in DO) instead of static weights.
- Zen/sambanova: unusable from Cloudflare egress — consider surfacing
  "provider health" on /health so clients can exclude them explicitly.

## Reproduce

```bash
node scripts/benchmark.mjs --base https://free-llm-router.vipulgote4.workers.dev --iters 3 --conc 12
npm run bench:accuracy
```
