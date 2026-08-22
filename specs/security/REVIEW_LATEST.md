# Security Review — free-llm-router (e03 + per-model cooldown + Pro Max dashboard)

**Date:** 2026-08-22  
**Branch:** `main` (`c310081` → `HEAD`) — diff vs `origin/HEAD` is `src/http.ts`, `src/index.ts`, `src/admin.ts`, `src/router.ts`, `src/limiter.ts`, `src/windows.ts` + `wrangler.jsonc`  
**Languages:** TypeScript (Cloudflare Workers + Durable Objects), HTML/JS dashboard  
**Pre-flight:** `git rev-parse HEAD` ok, `specs/security/epics/e03/THREAT_MODEL.md` exists, `scripts/lib/parallel-review-worktrees.sh` present, `bash scripts/verify-cwe-fixture-sync.sh` pass

## Scope (Phase 1)
- `git diff --merge-base origin/HEAD` → 8 files changed, 138 insertions (per-model cooldown) + 321 (Pro Max dashboard) + security headers
- Entry points: `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/audio/*`, `/v1/images/*`, `GET /v1/models`, `GET /admin`, `POST /admin/reset`
- Auth: `ROUTER_API_KEY` (env secret, Bearer/x-api-key), `CORS_ORIGIN` allowlist, `Provider` keys per `src/config.ts` allowlist

## Context (Phase 2)
- Existing patterns: `authorized()` strict equality, `corsHeaders()` with allowlist, `jsonErr` sanitized, `router_attempt` logs without secrets, DO SQLite, `modelCooldowns` pruning
- Sanitization: `escapeHtml` now in `http.ts` + client-side `esc()` in dashboard, `checkBodySize` (1 MB JSON / 10 MB raw), `isSafeModelId` (200 chars, no control chars), `fallbacks` cap 8, `MAX_RETRIES` env

## Findings (Phase 3 + 4) — confidence ≥ 8 only

### HIGH — XSS via `innerHTML` in admin dashboard (CWE-79) — FIXED
- **File:** `src/admin.ts:383,397,413,444,448,453,457` (before fix)
- **Description:** Dashboard built HTML via string concatenation: `html += '<tr><td>'+l.model+'</td>'` where `l.model` is user-controlled (`model` from request) reflected in `recentLogs` ring. No escaping → stored XSS in admin.
- **Exploit:** `POST /v1/chat/completions` with `{"model":"<img src=x onerror=alert(document.cookie)>","messages":[...]}`, then visit `/admin` → script executes in admin's browser.
- **Fix:** Added `escapeHtml` in `http.ts` and client `esc()` in dashboard, wrapped all `l.model`, `l.provider`, `p.name`, `b.lastError`, `m` interpolations. Verified `innerHTML` now only with escaped strings.

### MEDIUM — Permissive CORS + missing security headers (CWE-693, CWE-319) — FIXED
- **File:** `src/http.ts:14,34,60`
- **Description:** Previously `access-control-allow-origin: *` hard-coded in `jsonErr`, no `CSP`, `X-Frame-Options`, `HSTS`, etc. `CORS_ORIGIN=*` default allowed any origin to read `x-router-*` headers.
- **Exploit:** Malicious site could `fetch` the router with stolen `ROUTER_API_KEY` (if leaked) and exfiltrate, or embed `/admin` in iframe for clickjacking.
- **Fix:** `securityHeaders(isAdmin)` now adds `CSP` (allow fonts, `connect-src` allowlist, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `HSTS`, `X-Robots-Tag: noindex` + `Cache-Control: no-store` for admin/API, `CORS_ORIGIN` strict allowlist (comma-separated, exact match, no reflection).

### MEDIUM — DoS via unbounded JSON / `fallbacks` (CWE-770, CWE-400) — FIXED
- **File:** `src/index.ts: readJson`
- **Description:** `await request.json()` with no size check; `fallbacks` array unbounded; `prompt`/`input` unbounded.
- **Exploit:** Send 100 MB JSON or `fallbacks: Array(10000).fill("groq/...")` → worker OOM/time, or extremely long fallback chain.
- **Fix:** `checkBodySize` (1 MB JSON, 10 MB raw) via `Content-Length` + `arrayBuffer` length check → `413`, `validateChatBody` caps `messages` 200, `fallbacks` 8, `model` 200 chars, `prompt` 100k, `input` 50k, `__proto__` guard.

### MEDIUM — Information disclosure via stack trace (CWE-209) — FIXED
- **File:** `src/index.ts: catch (err) { return jsonErr(500, `router error: ${err.message}`) }`
- **Description:** Previous `jsonErr(500, `router error: ${err instanceof Error ? err.message : String(err)}`)` could leak stack if `err.message` contains stack.
- **Fix:** `jsonErr` now sanitizes `message.slice(0,2000).replace(/\n.*stack.*/is, '')` and `index.ts` now returns generic `router error` without `err.message`.

### LOW — `admin` open when `ROUTER_API_KEY` not set (CWE-306) — ACKNOWLEDGED
- **File:** `src/index.ts: authorized`
- **Description:** `if (!key) return true` leaves `/admin` and `/v1/*` open for open routers.
- **Rationale:** Intentional for `free-llm-router` open mode (docs say set `ROUTER_API_KEY` for production). Threat model documents it, dashboard shows `ROUTER_API_KEY` gate note. Not a HIGH because operator can set the secret; we added warning in code comment and `isAdmin` no-store headers already.
- **Recommendation:** In production, always set `ROUTER_API_KEY` (documented in README and `wrangler.jsonc`).

### LOW — Secrets in logs (CWE-532) — VERIFIED SAFE
- **File:** `src/router.ts: logAttempt`
- **Description:** `logAttempt` previously could have logged `Authorization` if not careful.
- **Verification:** Logs only `provider, model, bucket, outcome, reason, retryAfter, ms` — no `Authorization` or `x-*-api-key` headers. `checkBodySize` does not log body.

## Non-findings (suppressed, confidence < 8)
- SSRF via `fetch(p.baseUrl + endpoint)` — `baseUrl` is allowlisted from `src/config.ts`, `endpoint` is allowlisted to OpenAI paths, not user-controlled URL (host not user-controlled → exclusion 14).
- Rate limiting bypass — DO windows are authoritative, not bypassable via client key bucket isolation (defense in depth, not a vuln).
- Hardcoded ProviderLimits — `src/config.ts` limits are developer-authored constants, not user input → proven authorship, safe.
- `__proto__` guard is defense-in-depth; `JSON.parse` already handles it, but we added explicit check.

## Verification
- `npm run typecheck` pass (after `declare const process` fix)
- `npm test` 9 files 146 passed (mocked) + `LIVE=1` 28 passed via `openai` lib (all providers)
- `curl -i` shows `content-security-policy`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `strict-transport-security`, `cache-control: no-store`, `x-robots-tag` on `/admin`
- `curl -X POST` with 2 MB body → `413 payload too large`
- `curl` with `<img onerror>` model → dashboard renders `&lt;img ...&gt;` (escaped) not executed

## Residual risk
- `ROUTER_API_KEY` single-tenant only; per-user metering deferred (out of scope)
- Cloudflare's own WAF/bot management not configured in `wrangler.jsonc` (operator to enable in Cloudflare dashboard)
