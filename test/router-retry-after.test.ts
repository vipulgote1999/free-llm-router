import { describe, expect, it } from 'vitest';
import { retryAfterSeconds } from '../src/router';

function hdr(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe('retryAfterSeconds', () => {
  it('reads epoch-millisecond reset headers as milliseconds', () => {
    const reset = String(Date.now() + 90_000); // 13-digit OpenRouter value
    const secs = retryAfterSeconds(hdr({ 'x-ratelimit-reset': reset }));
    expect(secs).toBeGreaterThan(80);
    expect(secs).toBeLessThanOrEqual(91);
  });

  it('keeps epoch-second reset headers working', () => {
    const reset = String(Math.floor((Date.now() + 90_000) / 1000));
    const secs = retryAfterSeconds(hdr({ 'x-ratelimit-reset': reset }));
    expect(secs).toBeGreaterThan(80);
    expect(secs).toBeLessThanOrEqual(91);
  });

  it('honors Retry-After before the reset header', () => {
    const res = hdr({
      'retry-after': '42',
      'x-ratelimit-reset': String(Date.now() + 900_000),
    });
    expect(retryAfterSeconds(res)).toBe(42);
  });

  it('clamps an absurdly distant reset to one day', () => {
    const reset = String(Date.now() + 400 * 24 * 60 * 60 * 1000);
    expect(retryAfterSeconds(hdr({ 'x-ratelimit-reset': reset }))).toBe(86_400);
  });
});
