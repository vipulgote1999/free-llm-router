/**
 * Pure window math for rate-limit tracking. No Cloudflare APIs here so
 * these functions are trivially unit-testable.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
/** "unlimited" sentinel for token windows providers don't enforce */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

import type { AcquireResult, Limits } from './types';

/** Start of the current UTC minute. */
export function minuteStart(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

/**
 * Start of the current daily window. Most providers reset at UTC midnight
 * (anchor 0); Gemini resets at midnight Pacific (~8 UTC during DST).
 */
export function dayStart(now: number, anchorUtcHour = 0): number {
  const d = new Date(now);
  const candidate = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    anchorUtcHour,
  );
  return now >= candidate ? candidate : candidate - DAY_MS;
}

export interface WindowState {
  start: number;
  requests: number;
  tokens: number;
}

export interface BucketState {
  minute: WindowState;
  day: WindowState;
  cooldownUntil: number;
  lastError?: string;
}

export function freshBucket(now: number, dayAnchorUtc: number): BucketState {
  return {
    minute: { start: minuteStart(now), requests: 0, tokens: 0 },
    day: { start: dayStart(now, dayAnchorUtc), requests: 0, tokens: 0 },
    cooldownUntil: 0,
  };
}

/** Roll expired windows forward in place. Returns true if anything changed. */
export function rollBucket(
  b: BucketState,
  now: number,
  dayAnchorUtc: number,
): boolean {
  let changed = false;
  if (b.minute.start + MINUTE_MS <= now) {
    b.minute = { start: minuteStart(now), requests: 0, tokens: 0 };
    changed = true;
  }
  if (b.day.start + DAY_MS <= now) {
    b.day = { start: dayStart(now, dayAnchorUtc), requests: 0, tokens: 0 };
    changed = true;
  }
  return changed;
}

/**
 * The limiter's core decision: roll expired windows, reject on cooldown or
 * any of the four limits, otherwise count the request + tokens. Pure — the
 * Durable Object delegates to this, and it is unit-tested directly.
 */
export function evaluateAcquire(
  b: BucketState,
  now: number,
  tokens: number,
  limits: Limits,
  dayAnchorUtc: number,
): { result: AcquireResult; rolled: boolean } {
  const rolled = rollBucket(b, now, dayAnchorUtc);

  const resets = {
    minuteResetsAt: b.minute.start + MINUTE_MS,
    dayResetsAt: b.day.start + DAY_MS,
  };

  if (b.cooldownUntil > now) {
    return {
      rolled,
      result: {
        ok: false,
        reason: 'cooldown',
        retryAfter: Math.ceil((b.cooldownUntil - now) / 1000),
        ...resets,
      },
    };
  }

  const minuteFull =
    b.minute.requests + 1 > limits.rpm ||
    b.minute.tokens + tokens > limits.tpm;
  const dayFull =
    b.day.requests + 1 > limits.rpd ||
    b.day.tokens + tokens > limits.tpd;

  if (minuteFull || dayFull) {
    const retryAfter = Math.max(
      1,
      Math.ceil((Math.min(resets.minuteResetsAt, resets.dayResetsAt) - now) / 1000),
    );
    return { rolled, result: { ok: false, reason: 'limit', retryAfter, ...resets } };
  }

  b.minute.requests += 1;
  b.minute.tokens += tokens;
  b.day.requests += 1;
  b.day.tokens += tokens;
  return { rolled, result: { ok: true, ...resets } };
}
