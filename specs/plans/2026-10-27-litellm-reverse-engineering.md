# LiteLLM Reverse-Engineering Review

## Source
Reverse-engineered BerriAI/litellm (shallow clone) focusing on `litellm/utils.py::should_retry`
and `litellm/router.py::should_retry_this_error`, plus `router_utils/cooldown_handlers.py`.

## Findings vs free-llm-router
- LiteLLM/OpenAI `should_retry` retries on 408, 409, 429 and >=500. free-llm-router already
  handled 408, 429, >=500 but treated 409 Conflict as non-retryable client_error, passthrough.
- LiteLLM cooldown handlers distinguish caller-scoped auth failures and per-exception-type
  allowed_fails policies; free-llm-router cools down the whole bucket on 401 (acceptable for
  single-key-per-provider model).
- Retry-After parsing already honors both delta-seconds and HTTP-date, plus epoch
  ms/s reset headers (matches OpenAI's `_get_retry_after_from_exception_header`).

## Change
- `classifyErrorForCooldown` now treats 409 Conflict as retryable (`conflict`, 30s cooldown),
  matching LiteLLM/OpenAI `should_retry`. Router failover loop and raw passthrough updated
  to fail over on 409 instead of passthrough.
- Exported `classifyErrorForCooldown` for direct unit testing.

## Verification
- npm test (255 passed) + npm run typecheck green.
