# ModelPulseX Top-30 Live Probe — 2026-10-21

**Target:** `https://free-llm-router.vipulgote5.workers.dev`
**Source:** ModelPulseX leaderboard, `range=24h&sort=overall&profile=balanced`
**Probe:** one `POST /v1/chat/completions` per model, `max_tokens: 4096`, `temperature: 0`, verified status, `x-router-provider`, `x-router-model`, and non-empty content.

## Before fixes (deployed `abbd0a2`)

| Outcome | Count | Detail |
|---|---|---|
| Pass | 13 | 3 Groq, 8 Mistral, 1 Gemini, 1 OpenRouter |
| Fail | 4 | NVIDIA diffusion (upstream timeout), OpenRouter cohere (429), OpenRouter `openrouter/free` and `nvidia/nemotron-3.5-super-vl:free` (misparsed IDs) |
| Not routable | 13 | 8 kilocode, 5 Ollama (no `OLLAMA_BASE_URL`) |

Defects:
1. `openrouter/free` parsed as provider `openrouter` + model `free`; `nvidia/nemotron-3.5-super-vl:free` parsed as provider `nvidia` + model `nemotron-3.5-super-vl:free`. The router then cooled the literal model down on all 8 providers.
2. OpenRouter `x-ratelimit-reset` (epoch **milliseconds**) was multiplied by 1000, clamping every 429 to a 24h cooldown.
3. A `200` with `choices[0].message.content === ""` was passed through as success.

## After fixes (deployed `e66ca9ae`)

| Outcome | Count | Detail |
|---|---|---|
| Pass | 13 | 3 Groq, 8 Mistral, 1 Gemini, 1 OpenRouter (OpenRouter daily quota then exhausted) |
| Fail | 5 | NVIDIA diffusion now correctly reports `empty_response`; four OpenRouter models blocked by the account's daily 429 |
| Not routable | 12 | 8 kilocode, 4 Ollama (leaderboard shifted) |

Live evidence:

```
# ID parsing
openrouter/free                  → tried: openrouter:openrouter/free:cooldown
nvidia/nemotron-3.5-super-vl:free → tried: openrouter:nvidia/nemotron-3.5-super-vl:free:cooldown
(no literal "free"/"nemotron..." cooldowns on groq, cerebras, zen, gemini, opencode, nvidia, sambanova, mistral)

# reset-header unit
openrouter cooldownUntil = 2026-10-22T00:00:00.087Z  (midnight UTC, ~8.2h; previously +24h)
retryAfterSec = 29599

# empty completion
google/diffusiongemma-26b-a4b-it → 503, tried: nvidia:google/diffusiongemma-26b-a4b-it:empty_response
gemini-flash-lite-latest          → 200 "OK"
```

Remaining non-code gaps: OpenRouter's free daily cap is an account quota, not a router fault.

Note: one `POST /admin/reset` returned a transient Worker exception while clearing 12 DOs; two immediate retries returned 200.

## Provider additions (2026-10-21, `ecf9de1`, deployed `c888f750`)

Added the two providers that owned all 13 unroutable top-30 models:

| Provider | Config | Live probe (`max_tokens: 4096`) |
|---|---|---|
| `kilocode` | `https://api.kilo.ai/api/gateway`, optional `KILOCODE_API_KEY`, 10 RPM / 200 RPD, 11 catalog free models | **8/8** top-30 models passed (`reflection/beam-free`, `minimax/minimax-m3.1-flash:free`, `openrouter/free`, `nvidia/nemotron-3.5-super-vl:free`, `cohere/north-mini-code:free`, `kilo-auto/free`, `nvidia/nemotron-3.5-content-safety:free`, `dots-studio/dots-3-note-preview:free`) |
| `ollama_cloud` | `https://ollama.com/v1`, `OLLAMA_API_KEY`, 10 RPM / 100 RPD, 7-model free allowlist | **6/6** passed (`gemma4:31b`, `nemotron-3-nano:30b`, `gpt-oss:20b`, `gpt-oss:120b`, `nemotron-3-ultra`, `nemotron-3-super`) |

Cross-provider failover verified while OpenRouter was in its daily cooldown:

```
openrouter/free                   → 200 via kilocode
nvidia/nemotron-3.5-super-vl:free → 200 via kilocode
auto                              → 200 via mistral/codestral-latest (unchanged)
```

All 13 previously unroutable top-30 models now pass. Self-hosted `ollama` remains unchanged and disabled without `OLLAMA_BASE_URL`.

