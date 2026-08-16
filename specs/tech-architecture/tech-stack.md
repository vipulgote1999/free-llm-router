# Tech Stack — free-llm-router

- **Runtime:** Cloudflare Workers (ESM, `main: src/index.ts`, compatibility date 2025-01-01, nodejs_compat)
- **Language:** TypeScript, strict mode
- **State:** Durable Objects, SQLite-backed (`new_sqlite_classes: [ProviderLimiter]`), one DO per provider (`limiter:<providerId>`), dirty-flag + alarm flush persistence
- **AI binding:** Workers AI (`ai.binding = "AI"`) for the cloudflare provider
- **Testing:** Vitest on pure modules (windows, detect, config); no DO runtime tests
- **Tooling:** wrangler (dev/deploy), tsc --noEmit
- **Secrets:** wrangler secrets (GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OPENCODE_API_KEY, CEREBRAS_API_KEY, GITHUB_TOKEN, SAMBANOVA_API_KEY, NVIDIA_API_KEY, MISTRAL_API_KEY, OLLAMA_API_KEY optional, ROUTER_API_KEY optional)

## Module graph

```
index.ts (routes, auth, CORS)
  ├── router.ts (failover loop, upstream calls, Workers AI path)
  │     ├── detect.ts (capabilities, model selection)
  │     └── config.ts (provider registry, limits, key buckets)
  ├── limiter.ts (DurableObject ProviderLimiter)
  │     └── windows.ts (pure window math)
  ├── admin.ts (dashboard HTML, stats aggregation)
  └── http.ts (json/cors helpers)
```

## Gray areas (resolved)

- Workers fetch auto-decompresses upstream bodies → strip content-encoding/content-length on passthrough.
- Cloudflare provider streams in a non-OpenAI SSE shape → force non-stream and synthesize OpenAI JSON.
- Gemini daily quota resets midnight Pacific → dayAnchorUtc: 8.
- Zen/openrouter RPD varies (100/day vs 50/day) → defaults from research, env-overridable.
