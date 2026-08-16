import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  MINUTE_MS,
  dayStart,
  freshBucket,
  minuteStart,
  rollBucket,
  evaluateAcquire,
  type BucketState,
} from '../src/windows';
import type { Limits } from '../src/types';

const T = (iso: string) => Date.parse(iso);

describe('minuteStart', () => {
  it('truncates to the current minute', () => {
    expect(minuteStart(T('2025-03-15T10:23:45.678Z'))).toBe(
      T('2025-03-15T10:23:00.000Z'),
    );
  });
});

describe('dayStart', () => {
  it('defaults to UTC midnight', () => {
    expect(dayStart(T('2025-03-15T10:00:00Z'))).toBe(T('2025-03-15T00:00:00Z'));
    expect(dayStart(T('2025-03-15T00:00:00Z'))).toBe(T('2025-03-15T00:00:00Z'));
  });

  it('anchors to a custom UTC hour (Gemini: midnight Pacific)', () => {
    expect(dayStart(T('2025-03-15T10:00:00Z'), 8)).toBe(T('2025-03-15T08:00:00Z'));
    expect(dayStart(T('2025-03-15T05:00:00Z'), 8)).toBe(T('2025-03-14T08:00:00Z'));
    expect(dayStart(T('2025-03-15T08:00:00Z'), 8)).toBe(T('2025-03-15T08:00:00Z'));
  });
});

describe('rollBucket', () => {
  it('rolls only the expired minute window', () => {
    const b = freshBucket(T('2025-03-15T10:00:00Z'), 0);
    b.minute.requests = 5;
    b.day.requests = 9;
    const changed = rollBucket(b, T('2025-03-15T10:01:30Z'), 0);
    expect(changed).toBe(true);
    expect(b.minute.requests).toBe(0);
    expect(b.minute.start).toBe(T('2025-03-15T10:01:00Z'));
    expect(b.day.requests).toBe(9);
  });

  it('rolls the day window when past the anchor', () => {
    const b = freshBucket(T('2025-03-15T10:00:00Z'), 8);
    b.day.requests = 7;
    rollBucket(b, T('2025-03-16T09:00:00Z'), 8);
    expect(b.day.requests).toBe(0);
    expect(b.day.start).toBe(T('2025-03-16T08:00:00Z'));
  });

  it('leaves fresh windows untouched', () => {
    const b = freshBucket(T('2025-03-15T10:00:00Z'), 0);
    b.minute.requests = 3;
    b.day.requests = 4;
    const changed = rollBucket(b, T('2025-03-15T10:00:30Z'), 0);
    expect(changed).toBe(false);
    expect(b.minute.requests).toBe(3);
    expect(b.day.requests).toBe(4);
  });

  it('exposes the window constants used by resets', () => {
    expect(MINUTE_MS).toBe(60_000);
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe('evaluateAcquire (limiter core decision)', () => {
  const NOW = T('2025-03-15T10:00:00Z');
  const limits: Limits = { rpm: 2, rpd: 3, tpm: 100, tpd: 200 };
  const bucket = (): BucketState => freshBucket(NOW, 0);

  it('counts a request and tokens when everything is fine', () => {
    const b = bucket();
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(true);
    expect(b.minute.requests).toBe(1);
    expect(b.minute.tokens).toBe(10);
    expect(b.day.requests).toBe(1);
    expect(result.minuteResetsAt).toBe(NOW + MINUTE_MS);
  });

  it('rejects when RPM is exhausted', () => {
    const b = bucket();
    b.minute.requests = 2;
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('limit');
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(b.minute.requests).toBe(2); // unchanged
  });

  it('rejects when TPM is exhausted', () => {
    const b = bucket();
    b.minute.tokens = 95;
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('limit');
  });

  it('rejects when RPD is exhausted', () => {
    const b = bucket();
    b.day.requests = 3;
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('limit');
  });

  it('rejects when TPD is exhausted', () => {
    const b = bucket();
    b.day.tokens = 195;
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(false);
  });

  it('rejects during cooldown with seconds-until-release', () => {
    const b = bucket();
    b.cooldownUntil = NOW + 45000;
    const { result } = evaluateAcquire(b, NOW, 10, limits, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cooldown');
    expect(result.retryAfter).toBe(45);
  });

  it('rolls an expired minute window before counting', () => {
    const b = bucket();
    b.minute.requests = 2; // would trip rpm
    const later = NOW + 61000;
    const { result, rolled } = evaluateAcquire(b, later, 10, limits, 0);
    expect(rolled).toBe(true);
    expect(result.ok).toBe(true);
    expect(b.minute.requests).toBe(1);
  });
});
