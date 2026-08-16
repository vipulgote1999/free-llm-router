# Free LLM Router — AI Agents

Read CONVENTIONS.md before any GitHub or git operation.

## Project
OpenAI-compatible router aggregating 12 free LLM providers on Cloudflare Workers with rate-limit tracking, failover, and content-aware routing.
Stack: TypeScript, Cloudflare Workers, Durable Objects, Vitest

## Commands
| Action | Command |
|--------|---------|
| Run    | `npx wrangler dev` |
| Test   | `npm test` |
| Typecheck | `npm run typecheck` |
| Preflight | `npm test && npm run typecheck` |
| Deploy | `npm run deploy` |

## Architecture
Provider registry (config) → content detection + model selection (detect) → failover router (router) → Durable Object limiter (limiter). Pure window math in windows.ts. Dashboard in admin.ts. Entry in index.ts.

## Conventions
- Pure logic modules have no Cloudflare imports and must be unit-tested.
- Provider data lives in src/config.ts; routing behavior in src/router.ts.
- All planning output goes to specs/.

## Never
- Never hardcode secrets anywhere in the repo.
- Never proceed on red Preflight.
- Never add a provider without limits config + README row.

## Agent Rules
- **Workflow Mandate:** You MUST use the bigpowers skills (plan-work, develop-tdd, orchestrate-project) to perform tasks. DO NOT write code directly in response to a user prompt like "build this feature".
- **Always Green:** Preflight must be green before forward work.
- Read specs/ before writing code.
- Write the minimum code that solves the stated problem. Nothing extra.
- Run tests after every change. Show evidence before declaring done.
