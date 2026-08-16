# free-llm-router

An OpenAI-compatible router that aggregates **12 free LLM providers** behind one Cloudflare Worker. It tracks every provider's rate limits (RPM/RPD/TPM/TPD + cooldowns) in a Durable Object, **fails over automatically** when a provider is exhausted, and **routes by content** — images go to vision models, audio to audio models, reasoning requests to reasoning models.

Send requests to `https://<your-worker>.workers.dev/v1` and never see a 429 again (as long as at least one provider has quota).

## Providers

| Provider | Auth | Default free limits (RPM / RPD / TPM / TPD) | Models |
|---|---|---|---|
| cloudflare | Workers AI binding (no key) | 30 / 200* / — / — | @cf llama-3.3-70b, r1-distill, qwen-coder, llama vision |
| groq | `GROQ_API_KEY` | 30 / 1000 / 12K / 100K (per model) | llama-3.3-70b-versatile, llama-3.1-8b-instant |
| cerebras | `CEREBRAS_API_KEY` | 30 / — / 60K / 1M | llama-3.3-70b, llama-3.1-8b |
| zen | keyless (IP-limited) | 10 / 100 / — / — | claude-4/5, gemini-3.x, gpt-5.x, grok-4.6, deepseek-v4, glm-5, kimi-k3, minimax, qwen3.x + `*-free` tier |
| gemini | `GEMINI_API_KEY` | 10 / 250 / 250K / — (per model) | 2.5-flash, 2.5-pro, flash-lite, 2.0-flash (vision + audio) |
| openrouter | `OPENROUTER_API_KEY` | 20 / 50 / — / — | nemotron-3 family, gemma-4, gpt-oss-20b, laguna, lfm (incl. nemotron-vl vision) |
| opencode | `OPENCODE_API_KEY` | 20 / 500 / — / — | same catalog as zen, via keyed gateway |
| nvidia | `NVIDIA_API_KEY` | 40 / — / — / — | llama-3.3-70b, r1, qwen-coder |
| sambanova | `SAMBANOVA_API_KEY` | 20 / 20 / — / 200K | Llama-3.3-70B, Llama-3.1-8B, DeepSeek-R1, QwQ |
| mistral | `MISTRAL_API_KEY` | 60 / — / 500K / — | mistral-small, nemo, codestral, ministral |
| ollama | `OLLAMA_BASE_URL` | 60 / — / — / — | your pulled models (llama3.2, qwen2.5, gemma3…) |

`*` Workers AI free tier is 10k neurons/day (not requests) — the request count is a conservative proxy; tune with `CLOUDFLARE_RPD`.

All limits are env-overridable — providers change them. See [Limit overrides](#limit-overrides).

## Quickstart

```bash
# 1. install (on any Linux/macOS/Windows machine with Node 20+)
npm install

# 2. configure secrets — repeat for each provider you have
npx wrangler login
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
# optional, same pattern: OPENCODE_API_KEY CEREBRAS_API_KEY
#                        SAMBANOVA_API_KEY NVIDIA_API_KEY MISTRAL_API_KEY
#                        OLLAMA_API_KEY ROUTER_API_KEY

# 3. deploy (DO migration is applied automatically)
npm run deploy
```

Local dev: `cp .dev.vars.example .dev.vars`, fill keys, `npm run dev`.

> **Termux/Android note:** `wrangler` (via its `workerd` binary) has no android-arm64 build, so `wrangler dev`/`wrangler deploy` don't run *on the phone*. Tests and typecheck work fine there; deploy from any desktop machine. `wrangler` is in `optionalDependencies` so installs elsewhere succeed.

## Usage

```bash
# explicit model (any provider that has it, weight-ordered)
curl https://<worker>.workers.dev/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer whatever' \
  -d '{"model":"llama-70b","messages":[{"role":"user","content":"hi"}]}'

# auto: let content pick the model
curl ... -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'

# vision: auto routes to a vision-capable provider
curl ... -d '{"model":"auto","messages":[{"role":"user","content":[
  {"type":"text","text":"what is this?"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'

# force a provider:  provider/model  or  model@provider
curl ... -d '{"model":"groq/llama-3.3-70b-versatile", ...}'
curl ... -d '{"model":"llama-70b@cerebras", ...}'
```

OpenAI SDKs work by setting `base_url`:

```python
from openai import OpenAI
client = OpenAI(base_url="https://<worker>.workers.dev/v1", api_key="x")
client.chat.completions.create(model="auto", messages=[{"role":"user","content":"hello"}])
```

Streaming (`"stream": true`) is passed through transparently.

## How routing works

1. **Capability detection** — the request body is scanned: image/audio parts, `reasoning_effort`, estimated total tokens.
2. **Candidate list** — providers are filtered to those that (a) support the content type and (b) have the requested model (or an alias). Sorted by weight; reasoning requests prefer reasoning models.
3. **Capacity check** — the provider's Durable Object checks RPM/RPD/TPM/TPD windows and cooldowns. Out of quota → skip, note the reset time.
4. **Call upstream** — OpenAI-compatible `/chat/completions` with the right auth header per provider.
5. **On 429** — the `Retry-After`/`X-RateLimit-Reset` header is parsed and the bucket is put on cooldown until then; the next provider/key in the chain is tried. 401/403/402/404/5xx and network errors also skip to the next bucket with appropriate cooldowns.
6. **Exhausted?** — `503` with a `tried` array listing every attempt, its reason, and when that bucket resets.

Key order per provider: client-supplied key (its own quota) → shared env keys. Providers without keys (zen) share one `anonymous` bucket.

## Multiple keys per provider

Comma-separate keys in one secret to multiply capacity — each key gets its own tracked bucket:

```bash
npx wrangler secret put GROQ_API_KEY   # value: sk-aaa,sk-bbb,sk-ccc
```

Clients can also bring their own key per request (tracked separately):

```bash
curl ... -H 'x-groq-api-key: sk-client1' -H 'x-gemini-api-key: AIza...' ...
```

## Limit overrides

Every limit is overridable per provider: `<PROVIDER>_RPM`, `<PROVIDER>_RPD`, `<PROVIDER>_TPM`, `<PROVIDER>_TPD` (e.g. `OPENROUTER_RPD=1000` if you've purchased credits, `CLOUDFLARE_RPD=100`). Also `ZEN_BASE_URL`, `OPENCODE_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_MODELS` (comma list), `UPSTREAM_TIMEOUT_MS`, `CORS_ORIGIN`.

Set a `ROUTER_API_KEY` secret to gate `/v1/*` and `/admin/*` behind `Authorization: Bearer <key>`.

## Admin dashboard

- `GET /admin` — live table: per provider/bucket usage vs limits, minute/day reset countdowns, cooldowns, last error. Auto-refreshes every 5s. Reset button clears all counters.
- `GET /admin/stats` — the same data as JSON.
- `GET /health` — enabled providers at a glance.

## Troubleshooting

- **zen 429s constantly** — zen is IP-limited; all Workers traffic egresses from Cloudflare datacenter IPs, which zen may throttle heavily. Leave it in the chain; failover handles it.
- **Ollama unreachable** — Cloudflare can't reach your LAN. Expose it via Cloudflare Tunnel (`cloudflared tunnel`) and set `OLLAMA_BASE_URL=https://<tunnel>/v1`.
- **Workers AI `403` on some models** — Cloudflare restricts heavy models on the Workers *free* plan; those requests fail over to other providers automatically.
- **Limits changed upstream** — bump the env overrides, no redeploy of code needed (secrets apply on deploy; regular env vars via `wrangler secret` need a redeploy — or use plain `[vars]`).
- **Reset times** — RPD resets at UTC midnight for most providers; Gemini resets at midnight Pacific (tracked via `dayAnchorUtc: 8`).

## Verify the registry against live catalogs

Providers change model lists. Check our registry against each provider's real `/models` endpoint anytime:

```bash
node scripts/verify-models.mjs
```

Keyless providers (openrouter, zen) are always checked. Keyed providers (groq, gemini, cerebras, sambanova, nvidia, mistral, opencode, ollama, cloudflare) are checked when their keys are in `.dev.vars`. Output: per provider — our models still present? (`GONE` lines) and NEW upstream models not yet in `src/config.ts` (`+` lines).

## Development

```bash
npm test            # vitest — window math, detection, model selection, config
npm run typecheck   # tsc --noEmit
```

Pure logic (windows, detect, config) lives without Cloudflare imports so it unit-tests cleanly. The Durable Object and router are exercised via `wrangler dev` on a desktop machine.

## Disclaimers

- Free tiers change, and providers may throttle or block datacenter egress (zen) without notice. This router maximizes what's freely available; it cannot guarantee any single provider's availability.
- GitHub Models was retired by GitHub — the provider has been removed from the registry.
- Respect provider ToS; don't use multiple accounts to circumvent limits.
