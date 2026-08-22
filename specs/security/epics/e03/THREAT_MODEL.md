# Threat Model — e03 LiteLLM Parity + Dashboard v2 + Per-Model Cooldown

**Scope:** `src/index.ts` (Worker entry, 8 OpenAI endpoints), `src/router.ts` (failover), `src/http.ts` (CORS/JSON), `src/admin.ts` (dashboard HTML/JS), `src/limiter.ts` + `src/windows.ts` (DO rate limits), `src/config.ts` (provider registry).

**Trust boundaries:** Internet → Worker → Upstream providers (Groq, Gemini, OpenRouter, Zen, etc.) and Durable Object. `ROUTER_API_KEY` is the only auth secret; provider keys are per-provider secrets.

## Assets
- Provider API keys (GROQ_API_KEY etc.) — stored as Wrangler secrets, never in repo
- Rate-limit state (RPM/RPD/TPM/TPD, cooldowns, per-model cooldowns) — in DO SQLite
- Upstream responses (may contain user data)

## Attackers
- Unauthenticated internet client (no ROUTER_API_KEY)
- Authenticated client with valid ROUTER_API_KEY but trying to escalate (IDOR, SSRF, injection)
- Upstream provider returning malicious payload (XSS via reflected model name / lastError)

## STRIDE

| Threat | Example | Mitigation (implemented) |
|---|---|---|
| **Spoofing** | Fake `Authorization: Bearer` | `authorized()` checks constant-time? Uses strict equality, gated by env secret. Admin also gated. |
| **Tampering** | Large JSON body DoS, oversized multipart | Request size limits (1 MB JSON, 10 MB multipart) enforced before parsing |
| **Repudiation** | No audit of admin reset | Structured `router_attempt` logs with provider/model/bucket/outcome, no secrets |
| **Information disclosure** | Stack trace leak, secrets in logs, `lastError` XSS | Errors use `jsonErr` with sanitized message, no stack; logs never include keys; dashboard escapes HTML |
| **DoS** | 100 MB JSON bomb, many concurrent `fallbacks` | Body size limits, `fallbacks` capped to 8, `MAX_RETRIES` env caps chain |
| **Elevation** | Access `/admin/reset` without auth | `authorized()` gates all non-public routes; `admin` also requires auth if `ROUTER_API_KEY` set |

## Security controls in scope (BCP Plus Dim 12)

- **Auth:** `ROUTER_API_KEY` Bearer + `x-api-key` + plain key, applied to `/v1/*` and `/admin/*`; `CORS_ORIGIN` allowlist; `OPTIONS` handled
- **Validation:** JSON parse with try/catch, `messages` array required, `model` string length capped, `fallbacks` array capped, multipart size capped
- **Headers:** `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `HSTS` (when https), `Cache-Control: no-store` for API/admin, `X-Robots-Tag: noindex` for admin
- **Output encoding:** `escapeHtml` for all dashboard `innerHTML` interpolations (provider, model, bucket, lastError, logs)
- **SSRF:** Upstream baseUrl from `config.ts` allowlist only; endpoint path is allowlisted to OpenAI endpoints, not user-supplied URL
- **Secrets:** No hardcoding; `.dev.vars` gitignored; `wrangler secret` only; no logging of `Authorization` or `x-*-api-key` headers
- **Rate limits:** DO windows + cooldowns + per-model cooldowns; `Retry-After` parsing; `modelCooldowns` pruning

## Out of scope (deferred)
- Per-user auth / spend metering (single ROUTER_API_KEY only)
- WAF / Bot management (Cloudflare managed)
- mTLS for upstream (provider TLS is standard)

## Findings (pre-fix, for verify-work Phase 5)
- See `specs/security/REVIEW_LATEST.md` for the 5-phase scan (4 HIGH/MEDIUM before fixes, 0 HIGH after).
