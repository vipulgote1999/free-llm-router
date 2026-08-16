# Free LLM Router — Conventions

Read this before any git operation or code change.

## Project

OpenAI-compatible router that aggregates free LLM providers (Groq, Gemini, OpenRouter, OpenCode Zen, Cerebras, GitHub Models, SambaNova, NVIDIA NIM, Mistral, Ollama, Cloudflare Workers AI) behind one Cloudflare Worker, with per-provider rate-limit tracking, automatic failover, and content-aware routing.

Stack: TypeScript / Cloudflare Workers + Durable Objects (SQLite) / Vitest.

## Commands

| Action | Command |
|--------|---------|
| Run (dev) | `npx wrangler dev` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Preflight | `npm test && npm run typecheck` |
| Deploy | `npm run deploy` |

## Architecture

`src/config.ts` (provider registry + limits) → `src/detect.ts` (content capabilities + model selection) → `src/router.ts` (failover loop) → `src/limiter.ts` (Durable Object holding RPM/RPD/TPM/TPD windows + cooldowns). `src/windows.ts` is pure math with no Cloudflare imports. `src/admin.ts` serves the dashboard; `src/index.ts` is the worker entry.

## Conventions

- Pure logic (window math, detection, selection) lives in modules without Cloudflare imports and MUST be unit-tested.
- All rate-limit state lives in Durable Objects; never in KV or worker globals.
- Providers are data in `src/config.ts`; behavior lives in `src/router.ts`.
- Tests: Vitest, `test/*.test.ts`, run with `npm test`.
- Plans and specs go in `specs/`. Read them before writing code.

## Defensive code categories (all core to this project)

- **Rate limit**: RPM/RPD/TPM/TPD windows per provider bucket, 429 → cooldown until reset.
- **Retry**: next provider/key in the candidate chain on 429/5xx/401.
- **Circuit breaker**: cooldown timers in the limiter DO; provider skipped while cooling.
- **Timeout**: upstream fetch aborts via `AbortSignal.timeout` (env-overridable).
- **Graceful degradation**: 503 with per-provider reset info when everything is exhausted.

## Never

- Never hardcode API keys or secrets in source, wrangler.jsonc, or specs.
- Never dismiss reproducible gate failures as pre-existing or out of scope.
- Never proceed on red Preflight — invoke quick-fix or fix-bug first.
- Never add a provider without its limits in `src/config.ts` and a row in README's provider table.

## Discovered Defects

Reproducible failures found while working on something else: fix-or-log.
Trivial data-only fixes go through quick-fix; logic fixes go through investigate-bug → develop-tdd → validate-fix. Separate commits for discovered fixes.

Banned dismissive phrases: "pre-existing", "unrelated to session", "not introduced by my changes", "out of scope" (when ignoring a red gate).

## Git

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `perf:`.
- workflow_mode: solo-git (see specs/state.yaml). Land via `release-branch` solo-local when the epic completes.
