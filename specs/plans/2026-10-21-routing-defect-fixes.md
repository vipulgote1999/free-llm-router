# Routing Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three routing defects exposed by the ModelPulseX top-30 live probe: slash-containing exact model IDs being split, OpenRouter reset headers parsed in the wrong unit, and empty 200 responses treated as success.

**Architecture:** All three are pure-logic fixes with unit coverage. `isKnownModelId` gains the checked-in ModelPulseX IDs so exact IDs win over the `provider/model` heuristic. `retryAfterSeconds` distinguishes epoch milliseconds from epoch seconds. The router's non-streaming chat success path rejects empty completions and fails over, while preserving tool calls, refusals, and `finish_reason: "length"`.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest.

**Spec:** `specs/verifications/TOP30_LIVE_PROBE_2026-10-21.md` (evidence below).

## Global Constraints

- No Cloudflare imports in pure modules (`config.ts`, `detect.ts`, `mpx.ts`).
- Every fix needs a test that failed before the fix.
- Preflight (`npm test && npm run typecheck`) must be green before each commit.
- One conventional commit per defect.
- Never log or commit the admin key.

## Review Focus

- A model ID that starts with a provider name but is not registered must still support the `provider/model` force syntax (`groq/llama-3.3-70b-versatile`).
- `Retry-After` is authoritative and must keep precedence over `x-ratelimit-reset`.
- Tool-call responses and refusals have `content: null`/empty and must not be failed over.
- Reasoning-only responses truncated by `max_tokens` (`finish_reason: "length"`) must pass through.
- Streaming responses must keep the existing SSE path untouched.

---

### Task 1: Recognize ModelPulseX-only exact model IDs

**Files:**
- Modify: `src/mpx.ts` (export `derivedAliases`)
- Modify: `src/config.ts:481` (`isKnownModelId`)
- Test: `test/detect.test.ts`

**Interfaces:**
- Produces: `isKnownModelId(id: string): boolean` now returns true for IDs and derived aliases in `MPX_CATALOG`.
- Consumes: existing `MPX_CATALOG` and `normalizeModelId`.

- [ ] **Step 1: Write failing tests**

Add to `describe("parseModelSpec")`:

```ts
it("keeps ModelPulseX-only ids with a provider prefix intact", () => {
  expect(parseModelSpec("openrouter/free")).toEqual({ model: "openrouter/free" });
  expect(parseModelSpec("nvidia/nemotron-3.5-super-vl:free")).toEqual({
    model: "nvidia/nemotron-3.5-super-vl:free",
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/detect.test.ts`
Expected: FAIL — both return `{ provider, model }` splits.

- [ ] **Step 3: Implement**

Export `derivedAliases` from `src/mpx.ts`, then in `src/config.ts` build a module-level `MPX_MODEL_IDS: Set<string>` from `MPX_CATALOG` (normalized id + derived aliases) and return true from `isKnownModelId` when the set has the id.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mpx.ts src/config.ts test/detect.test.ts
git commit -m "fix(config): recognize ModelPulseX exact ids before provider split"
```

---

### Task 2: Parse OpenRouter reset timestamps by magnitude

**Files:**
- Modify: `src/router.ts:1111` (`retryAfterSeconds`)
- Test: `test/router-retry-after.test.ts` (create)

**Interfaces:**
- Produces: `export function retryAfterSeconds(res: Response): number` — seconds, clamped to 1..86400.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { retryAfterSeconds } from "../src/router";

const hdr = (h: Record<string, string>) => new Response(null, { headers: h });

it("reads epoch-millisecond reset headers as milliseconds", () => {
  const reset = String(Date.now() + 90_000); // 13-digit OpenRouter value
  const secs = retryAfterSeconds(hdr({ "x-ratelimit-reset": reset }));
  expect(secs).toBeGreaterThan(80);
  expect(secs).toBeLessThanOrEqual(91);
});

it("keeps epoch-second reset headers working", () => {
  const reset = String(Math.floor((Date.now() + 90_000) / 1000));
  const secs = retryAfterSeconds(hdr({ "x-ratelimit-reset": reset }));
  expect(secs).toBeGreaterThan(80);
  expect(secs).toBeLessThanOrEqual(91);
});

it("honors Retry-After before the reset header", () => {
  const res = hdr({ "retry-after": "42", "x-ratelimit-reset": String(Date.now() + 900_000) });
  expect(retryAfterSeconds(res)).toBe(42);
});
```

- [ ] **Step 2: Run and watch the millisecond test fail**

Run: `npx vitest run test/router-retry-after.test.ts`
Expected: FAIL — 86400.

- [ ] **Step 3: Implement**

In `retryAfterSeconds`, parse `x-ratelimit-reset` as a number and choose `ms = n >= 1e12 ? n : n * 1000`; keep the existing `Date.now()` comparison and clamp.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/router-retry-after.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router-retry-after.test.ts
git commit -m "fix(router): parse epoch-millisecond rate-limit reset headers"
```

---

### Task 3: Fail over on empty non-streaming chat completions

**Files:**
- Modify: `src/router.ts` (success path + `isEmptyChatCompletion`)
- Test: `test/router.integration.test.ts`

**Interfaces:**
- Produces: `isEmptyChatCompletion(res: Response): Promise<boolean>` — true only for JSON 2xx chat bodies whose first choice has no content, no `tool_calls`, no `function_call`, no `refusal`, and `finish_reason !== "length"`.

- [ ] **Step 1: Write failing tests**

Add to `describe('routeChat end-to-end')` using the existing `mockFetch`, `makeEnv`, `makeRequest` helpers:

```ts
it('fails over when an upstream returns 200 with empty content', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('api.groq.com')) return upstreamResponse('');
    if (String(url).includes('integrate.api.nvidia.com')) return upstreamResponse('from nvidia');
    return new Response('nope', { status: 404 });
  }));
  const env = makeEnv({ GROQ_API_KEY: 'g', NVIDIA_API_KEY: 'n' });
  const res = await routeChat(makeRequest('llama-70b'), env as never, {
    model: 'llama-70b', messages: [{ role: 'user', content: 'hi' }],
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-router-provider')).toBe('nvidia');
});

it('keeps tool-call responses whose content is null', async () => {
  vi.stubGlobal('fetch', mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, {
    model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }],
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-router-provider')).toBe('groq');
});

it('keeps empty content truncated by max_tokens', async () => {
  vi.stubGlobal('fetch', mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, {
    model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }],
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('x-router-provider')).toBe('groq');
});

it('returns 503 when every candidate returns empty content', async () => {
  vi.stubGlobal('fetch', mockFetch(() => upstreamResponse('')));
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  const res = await routeChat(makeRequest('groq/llama-3.3-70b-versatile'), env as never, {
    model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }],
  });
  expect(res.status).toBe(503);
  const j = (await res.json()) as { error: { tried: { reason: string }[] } };
  expect(j.error.tried.every((t) => t.reason === 'empty_response')).toBe(true);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/router.integration.test.ts`
Expected: the failover test returns `via=groq`; the all-empty test returns 200.

- [ ] **Step 3: Implement**

Add `isEmptyChatCompletion`; in the non-streaming `chat/completions` success branch, before `finish('ok')`, set `attempt.reason = 'empty_response'`, `finish('error')`, advance `attemptIndex`, and `continue` when it returns true.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run test/router.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router.integration.test.ts
git commit -m "fix(router): fail over on empty chat completions"
```

---

### Task 4: Preflight and live re-verification

- [ ] **Step 1: Run the full preflight**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 2: Deploy and re-probe**

Run: `npm run deploy`, then the `/tmp/opencode/test-top30.mjs` probe with `max_tokens: 4096`.
Expected: rank 1/2/4 Groq pass, mistral 8/8, gemini pass; `openrouter/free` and `nvidia/...` no longer cool down a literal model on all providers; OpenRouter cooldown is minutes, not 24h (quota permitting).

- [ ] **Step 3: Record results**

Append the probe table to `specs/verifications/TOP30_LIVE_PROBE_2026-10-21.md`.
