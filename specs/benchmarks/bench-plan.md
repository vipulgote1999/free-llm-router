# Benchmark Plan — free-llm-router

Goal: validate the deployed router in depth — performance, failover, rate-limit
tracking, content routing — and surface improvement opportunities.

## Suites

| Suite | What it measures | Pass threshold |
|---|---|---|
| health | worker liveness, provider enablement, DO stats reachable | all enabled providers listed |
| latency | per-provider p50/p95/p99 single-shot; router overhead vs direct provider call | router overhead p95 < 1000ms |
| failover | observed provider chain on 402/429/RPM-exhaustion; hop latency; cooldown recording; reset recovery | no request hangs > 60s; cooldown recorded in stats |
| concurrency | C parallel requests, error rate, provider distribution, tail latency | client 5xx < 5%, no hung requests |
| stream | time-to-first-token, SSE integrity (data: [DONE]), tokens/sec | all streams terminate with [DONE] |
| accuracy (offline, vitest) | content detection + candidate selection vs labeled fixtures | 100% fixtures correct |

## Artifacts

- `specs/verifications/benchmark-results/bench-<ts>.md` + `.json` per run
- Console summary table per suite

## Invocation

```bash
node scripts/benchmark.mjs --base https://free-llm-router.vipulgote4.workers.dev --iters 3 --conc 12
npm run bench:accuracy   # offline fixture corpus
```

## Quota notes

Free tiers are small: keep --iters ≤ 3 and --conc ≤ 20. The failover suite
burns ~10 RPD on the exhausted provider by design. Run weekly, not hourly.
`--skip-live` runs only offline checks.
