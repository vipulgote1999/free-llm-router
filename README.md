# free-llm-router

An **exact OpenAI-compatible** router that aggregates **12 free LLM providers** behind one Cloudflare Worker — with **LiteLLM-style fallback** and a live dashboard. It tracks every provider's rate limits (RPM/RPD/TPM/TPD + cooldowns) in a Durable Object, **fails over automatically** (429, 5xx, context-window exceeded), and **routes by content** — images → vision, audio → audio, reasoning → reasoning, long context → largest window.

Drop-in replacement: change only `base_url` to `https://<your-worker>.workers.dev/v1` and keep your OpenAI SDK code, LiteLLM configs, Vercel AI SDK, or LangChain.

## What LiteLLM parity means

- **Every OpenAI shape passes through verbatim** — `temperature`, `top_p`, `stream`, `tools`/`tool_choice`, `response_format`, `reasoning_effort`, `stop`, `max_tokens`, `seed`, `user`, `parallel_tool_calls`, etc. are forwarded unchanged. Responses (including SSE `text/event-stream` with `[DONE]`) are proxied byte-for-byte, with only `x-router-provider`/`x-router-model` headers added.
- **Full OpenAI surface** — `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings`, `POST /v1/audio/*`, `POST /v1/images/*`, `GET /v1/models` + `GET /v1/models/:id` (+ unversioned aliases `/chat/completions`, `/models`, etc.). Unknown endpoints return OpenAI-shaped `{error:{message,type,code,param}}`.
- **LiteLLM `fallbacks` + `num_retries`** — per-request fallback chains just like LiteLLM proxy:
  ```json
  {
    "model": "groq/llama-3.3-70b-versatile",
    "fallbacks": ["cerebras/gpt-oss-120b", "openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
    "messages": [{"role":"user","content":"hi"}]
  }
  ```
  Also accepts `{"fallbacks":[{"model":"..."}]}`. Global cap via `MAX_RETRIES` env (maps to LiteLLM `num_retries`).
- **Context-window fallback** — `400 context_length_exceeded` (checked via `error.code` and message) automatically retries the next candidate with a larger context window, instead of surfacing 400 to the client.
- **Exact error parity** — errors use OpenAI types (`invalid_request_error`, `authentication_error`, `not_found_error`, `rate_limit_error`, `server_error`) with `code`/`param`, plus a `tried[]` array on 503s for debugging failover.

## Providers

| Provider | Auth | Default free limits (RPM / RPD / TPM / TPD) | Models |
|---|---|---|---|
| cloudflare | Workers AI binding (no key) | 30 / 200* / — / — | @cf llama-3.3-70b, r1-distill, qwen-coder, llama vision + `bge-base`/`bge-m3` embeddings |
| groq | `GROQ_API_KEY` | 30 / 1000 / 12K / 100K (per model) | llama-3.3-70b-versatile, llama-3.1-8b-instant, gpt-oss-20b/120b |
| cerebras | `CEREBRAS_API_KEY` | 30 / — / 60K / 1M | gpt-oss-120b, gemma-4, glm-4.7 |
| zen | keyless (IP-limited) | 10 / 100 / — / — | claude-4/5, gemini-3.x, gpt-5.x, grok-4.6, deepseek-v4, glm-5, kimi-k3, minimax, qwen3.x + `*-free` + `text-embedding-3-small` |
| gemini | `GEMINI_API_KEY` | 10 / 250 / 250K / — (per model) | 2.5-flash, 2.5-pro, flash-lite, 3.5/3.6/3.7-flash, gemma-4 + `text-embedding-004` |
| openrouter | `OPENROUTER_API_KEY` | 20 / 50 / — / — | nemotron-3 family, gemma-4, gpt-oss-20b, laguna, lfm, + `text-embedding-3-small:free` |
| opencode | `OPENCODE_API_KEY` | 20 / 500 / — / — | same catalog as zen (free + paid) + `text-embedding-3-small` |
| nvidia | `NVIDIA_API_KEY` | 40 / — / — / — | llama-3.3-70b, nemotron-3, gemma-4, muse, llama vision + `nv-embedqa` |
| sambanova | `SAMBANOVA_API_KEY` | 20 / 20 / — / 200K | Meta-Llama-3.3-70B-Instruct |
| mistral | `MISTRAL_API_KEY` | 60 / — / 500K / — | mistral-small, codestral, ministral + `mistral-embed` |
| ollama | `OLLAMA_BASE_URL` | 60 / — / — / — | your pulled models + `nomic-embed-text` |
| truerouter | `TRUEROUTER_API_KEY` | 20 / 200 / — / — | llama3.1:8b, qwen2.5-coder:7b |

`*` Workers AI free tier is 10k neurons/day (not requests) — the request count is a conservative proxy; tune with `CLOUDFLARE_RPD`.

All limits are env-overridable — see [Limit overrides](#limit-overrides).

## Quickstart

```bash
# 1. install (on any Linux/macOS/Windows machine with Node 20+)
npm install

# 2. configure secrets — repeat for each provider you have
npx wrangler login
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
# optional: OPENCODE_API_KEY CEREBRAS_API_KEY SAMBANOVA_API_KEY NVIDIA_API_KEY MISTRAL_API_KEY OLLAMA_API_KEY ROUTER_API_KEY

# 3. deploy (DO migration is applied automatically)
npm run deploy
```

Local dev: `cp .dev.vars.example .dev.vars`, fill keys, `npm run dev`.

> **Termux/Android note:** `wrangler` (via `workerd`) has no android-arm64 build, so `wrangler dev`/`wrangler deploy` don't run *on the phone*. Tests and typecheck work fine there; deploy from desktop. `wrangler` is in `optionalDependencies`.

## Usage

```bash
# explicit model (any provider that has it, weight-ordered)
curl https://<worker>.workers.dev/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama-70b","messages":[{"role":"user","content":"hi"}]}'

# OpenAI-compatible embeddings
curl .../v1/embeddings -d '{"model":"text-embedding-3-small","input":"hello world"}'

# legacy completions
curl .../v1/completions -d '{"model":"llama-70b","prompt":"Once upon"}'

# auto: let content pick the model
curl ... -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'

# vision: auto routes to a vision-capable provider
curl ... -d '{"model":"auto","messages":[{"role":"user","content":[
  {"type":"text","text":"what is this?"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'

# force a provider:  provider/model  or  model@provider
curl ... -d '{"model":"groq/llama-3.3-70b-versatile", ...}'
curl ... -d '{"model":"llama-70b@cerebras", ...}'

# LiteLLM-style fallback chain (per-request)
curl .../v1/chat/completions -d '{
  "model":"groq/llama-3.3-70b-versatile",
  "fallbacks":["cerebras/gpt-oss-120b","openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
  "messages":[{"role":"user","content":"hi"}]
}'
```

OpenAI SDKs work by setting `base_url`:

```python
from openai import OpenAI
client = OpenAI(base_url="https://<worker>.workers.dev/v1", api_key="sk-anything-if-no-ROUTER_API_KEY")
# chat
client.chat.completions.create(model="auto", messages=[{"role":"user","content":"hello"}], stream=False)
# embeddings
client.embeddings.create(model="text-embedding-3-small", input="hello world")
# completions
client.completions.create(model="mistral-small-latest", prompt="Once upon", max_tokens=50)
```

```ts
import OpenAI from "openai"
const client = new OpenAI({ baseURL: "https://<worker>.workers.dev/v1", apiKey: "x" })
// LiteLLM parity: fallbacks via extra body
await client.chat.completions.create({
  model: "groq/llama-3.3-70b-versatile",
  messages: [{role:"user", content:"hi"}],
  // @ts-ignore — router reads this
  fallbacks: ["cerebras/gpt-oss-120b"],
} as any)
```

Streaming (`"stream": true`) is passed through as `text/event-stream` with `[DONE]` terminator, including through Workers AI (synthesized SSE).

## How routing works

1. **Capability detection** — request body scanned: image/audio parts, `reasoning_effort`, estimated total tokens (including `max_tokens`). Long-context requests prefer models with larger windows.
2. **Candidate chain** — providers filtered to those that (a) support the content type and (b) have the requested model or alias, sorted by weight; `reasoning` models are boosted for reasoning requests. `fallbacks` array is appended (deduplicated). For unknown embedding models, every enabled provider is tried weight-ordered.
3. **Capacity check** — Durable Object checks RPM/RPD/TPM/TPD windows and cooldowns. Out of quota → skip, note `retryAfter` + reset times.
4. **Call upstream** — OpenAI-compatible `POST <providerBase>/chat/completions` (or `/completions`/`/embeddings`/etc.) with the right auth header. Every extra field (`tools`, `response_format`, `reasoning_effort`, etc.) is preserved.
5. **On error** — `429` → cooldown until `Retry-After`/`X-RateLimit-Reset`; `401/403`→10m; `402`→12h; `404`→5m; `408/5xx`→30s with exponential backoff + jitter and then next provider/key is tried. `400 context_length_exceeded` also fails over to the next candidate (large-context fallback).
6. **Exhausted?** — `503` with OpenAI-shaped `{error:{message,type:"server_error",code:"all_providers_exhausted", tried:[...]}}` listing every attempt, `reason`, `retryAfterSec`, and reset timestamps. Success returns the upstream body untouched with `x-router-provider`/`x-router-model` headers.

Key order per provider: client-supplied key (`x-<provider>-api-key` header, its own quota) → shared env keys. Keyless providers (zen) share one `anonymous` bucket.

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

Every limit is overridable per provider: `<PROVIDER>_RPM`, `<PROVIDER>_RPD`, `<PROVIDER>_TPM`, `<PROVIDER>_TPD` (e.g. `OPENROUTER_RPD=1000` if you've purchased credits, `CLOUDFLARE_RPD=100`). Also `ZEN_BASE_URL`, `OPENCODE_BASE_URL`, `OLLAMA_BASE_URL`, `OLLAMA_MODELS` (comma list), `UPSTREAM_TIMEOUT_MS` (default 300_000), `MAX_RETRIES`/`NUM_RETRIES` (caps the candidate chain length, LiteLLM-style), `CORS_ORIGIN`.

Set a `ROUTER_API_KEY` secret to gate `/v1/*` and `/admin/*` behind `Authorization: Bearer <key>` (also accepts `x-api-key`).

## Admin dashboard v2

Open `https://<worker>.workers.dev/admin`:

- **Summary chips** — total/enabled/disabled providers, cooling count, latency p50/p95 (from recent successes), success vs fail counts.
- **Provider table** — per bucket `RPM`/`TPM`/`RPD` bars with %, minute/day reset countdowns, cooldown countdown + `lastError`. Disabled providers are dimmed. Weight shown per provider (higher → tried first).
- **Recent requests ring** — last 80 router attempts (in-memory, per isolate): timestamp, provider/model/bucket, `ok`/`skipped`/`error`, reason, `retryAfter`, latency ms. Powers p50/p95.
- **Fallback chain** — visualization of the last burst (requests within ~2.5s) showing each hop `provider/model → reason → ms`, with a clear 503 explanation when all providers are exhausted. Includes curl snippet for per-request `fallbacks`.
- `GET /admin/stats` — JSON with `{providers, logs, summary:{p50,p95,success,failure,total,now}, generatedAt}` (legacy array shape also handled by the dashboard). `GET /admin/logs` and `POST /admin/reset` (clears DO counters and the in-memory ring).

## Troubleshooting

- **zen 429s constantly** — zen is IP-limited; Workers egress IPs are throttled heavily. Keep it in chain; failover handles it. Raise `ZEN_RPD` if you have a different egress.
- **Ollama unreachable** — Cloudflare can't reach LAN. Expose via Cloudflare Tunnel (`cloudflared tunnel`) and set `OLLAMA_BASE_URL=https://<tunnel>/v1`.
- **Workers AI `403` on some models** — heavy models are restricted on Workers free plan; they fail over automatically. Check `lastError` in dashboard.
- **Limits changed upstream** — bump env overrides, no code redeploy needed for `[vars]`; secrets need `wrangler deploy`.
- **Reset times** — RPD resets at UTC midnight for most providers; Gemini at midnight Pacific (`dayAnchorUtc: 8`).
- **400 without fallback** — non-context `400`s are passed through to the client (client bug). Add `fallbacks` if you want the router to retry 400s.

## Verify the registry against live catalogs

```bash
node scripts/verify-models.mjs
```

Keyless providers (openrouter, zen) checked without credentials; keyed providers checked when keys are in `.dev.vars`. Output: `GONE` (our model no longer upstream) and `+` (new upstream models missing from `src/config.ts`).

## Development

```bash
npm test            # vitest — window math, detection, config, router integration, OpenAI parity (86 tests)
npm run typecheck   # tsc --noEmit
npm test && npm run typecheck   # preflight (must be green)
```

Pure logic (`windows`, `detect`, `config`) lives without Cloudflare imports so it unit-tests cleanly. Durable Object and router are exercised via `wrangler dev` on desktop and mocked integration tests.

## Disclaimers

- Free tiers change and providers may throttle datacenter egress without notice. This router maximizes what's free; it cannot guarantee a single provider's availability.
- GitHub Models was retired — provider removed from registry.
- Respect provider ToS; don't use multiple accounts to circumvent limits.
