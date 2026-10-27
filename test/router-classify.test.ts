import { describe, expect, it } from 'vitest';
import { classifyErrorForCooldown } from '../src/router';

describe('classifyErrorForCooldown', () => {
  it('marks 429 as rate_limited + retryable', () => {
    expect(classifyErrorForCooldown(429, false)).toMatchObject({
      reason: 'rate_limited',
      retryable: true,
    });
  });
  it('marks 409 Conflict as conflict + retryable (LiteLLM/OpenAI should_retry)', () => {
    expect(classifyErrorForCooldown(409, false)).toMatchObject({
      reason: 'conflict',
      retryable: true,
      seconds: 30,
    });
  });
  it('marks 5xx as upstream_error + retryable', () => {
    expect(classifyErrorForCooldown(503, false)).toMatchObject({
      retryable: true,
      reason: 'upstream_error',
    });
  });
  it('marks 408 as upstream_error + retryable', () => {
    expect(classifyErrorForCooldown(408, false)).toMatchObject({
      retryable: true,
    });
  });
  it('marks plain 400 as invalid_request + non-retryable', () => {
    expect(classifyErrorForCooldown(400, false)).toMatchObject({
      reason: 'invalid_request',
      retryable: false,
    });
  });
  it('marks context-exceeded 400 as retryable', () => {
    expect(classifyErrorForCooldown(400, true)).toMatchObject({
      reason: 'context_exceeded',
      retryable: true,
    });
  });
  it('marks unknown 4xx as client_error + non-retryable', () => {
    expect(classifyErrorForCooldown(422, false)).toMatchObject({
      reason: 'client_error',
      retryable: false,
    });
  });
});
