# UAT — free-llm-router v0.1.0 (epic e01)

Date: 2026-08-16 · Gate: verify-work · Preflight: `npm test && npm run typecheck`

## Automated evidence (run on this machine)

| Check | Command | Result |
|---|---|---|
| Unit: window math, anchors, rolling | `npx vitest run test/windows.test.ts` | ✅ 8/8 |
| Unit: capability detection, model selection, force syntax | `npx vitest run test/detect.test.ts` | ✅ 18/18 |
| Unit: env parsing, buckets, limit merge | `npx vitest run test/config.test.ts` | ✅ 11/11 |
| Integration: failover loop w/ mocked DO + upstreams | `npx vitest run test/router.integration.test.ts` | ✅ 6/6 |
| Compile gate | `npm run typecheck` | ✅ clean |
| Registry vs live catalogs (openrouter, zen) | `node scripts/verify-models.mjs` | ✅ 15/15, 62/62 |

Integration scenarios covered headlessly (the wrangler-dev smoke equivalent):
- happy path passthrough + x-router-provider/model headers
- 429 → cooldown ~retry-after → failover to next provider
- pre-exhausted bucket skipped (RPM limit)
- bucket in cooldown skipped
- all-exhausted → 503 with per-attempt reset info
- Workers AI binding path → OpenAI-shaped JSON

## Manual verification (requires desktop machine — workerd has no android build)

- [ ] `npx wrangler dev` on a desktop; POST /v1/chat/completions with a real GROQ_API_KEY in .dev.vars
- [ ] Verify streaming (`"stream": true`) passes through with `curl -N`
- [ ] Verify `/admin` dashboard shows live usage + reset countdowns after real requests
- [ ] Deploy: `npx wrangler secret put GROQ_API_KEY` … `npm run deploy`; re-run `node scripts/verify-models.mjs` with all keys to complete the registry check for groq/gemini/cerebras/sambanova/nvidia/mistral/opencode/ollama/cloudflare
- [ ] Confirm DO migration applied (wrangler deploy output shows `new_sqlite_classes`)
- [ ] Optional: set ROUTER_API_KEY and confirm 401 without bearer token

## Known limitations (accepted)

- Cloudflare provider is non-streaming (Workers AI SSE shape differs from OpenAI) — documented in README
- Zen shares one anonymous bucket across all keyless traffic (IP-limited upstream)
- GitHub Models removed from registry — API retired by GitHub (2026-08)
