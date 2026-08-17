/**
 * ProviderLimiter — one SQLite-backed Durable Object per provider
 * (`limiter:<providerId>`). Holds per-bucket RPM/RPD/TPM/TPD windows and
 * 429-driven cooldowns. Counters roll lazily on access; state persists via a
 * dirty flag flushed by an alarm (and immediately for cooldowns/resets).
 */

import { DurableObject } from 'cloudflare:workers';

import {
  evaluateAcquire,
  type BucketState,
  freshBucket,
} from './windows';
import type { AcquireResult, Limits } from './types';

interface AcquireOp {
  op: 'acquire';
  bucket: string;
  tokens: number;
  limits: Limits;
  dayAnchorUtc: number;
}
interface CooldownOp {
  op: 'cooldown';
  bucket: string;
  seconds: number;
  note?: string;
}
interface StatsOp {
  op: 'stats';
}
interface ResetOp {
  op: 'reset';
}
type LimiterOp = AcquireOp | CooldownOp | StatsOp | ResetOp;

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class ProviderLimiter extends DurableObject {
  private buckets = new Map<string, BucketState>();
  private dirty = false;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Record<string, BucketState>>('buckets');
      if (saved) this.buckets = new Map(Object.entries(saved));
    });
  }

  async fetch(request: Request): Promise<Response> {
    let op: LimiterOp;
    try {
      op = (await request.json()) as LimiterOp;
    } catch {
      return respond({ error: 'invalid op' }, 400);
    }
    switch (op.op) {
      case 'acquire':
        return respond(this.acquire(op));
      case 'cooldown':
        return respond(await this.cooldown(op));
      case 'stats':
        return respond(this.stats());
      case 'reset':
        this.buckets = new Map();
        this.dirty = true;
        await this.flush();
        return respond({ ok: true });
      default:
        return respond({ error: 'unknown op' }, 400);
    }
  }

  private acquire(op: AcquireOp): AcquireResult {
    const now = Date.now();
    let b = this.buckets.get(op.bucket);
    if (!b) {
      b = freshBucket(now, op.dayAnchorUtc);
      this.buckets.set(op.bucket, b);
    }
    const { result, rolled } = evaluateAcquire(
      b,
      now,
      op.tokens,
      op.limits,
      op.dayAnchorUtc,
    );
    if (result.ok || rolled) {
      this.dirty = true;
      void this.ctx.storage.setAlarm(Date.now() + 5000);
    }
    return result;
  }

  private async cooldown(op: CooldownOp): Promise<{ ok: true; until: number }> {
    const now = Date.now();
    let b = this.buckets.get(op.bucket);
    if (!b) {
      b = freshBucket(now, 0);
      this.buckets.set(op.bucket, b);
    }
    b.cooldownUntil = Math.max(b.cooldownUntil, now + op.seconds * 1000);
    if (op.note) b.lastError = op.note;
    this.dirty = true;
    await this.flush();
    return { ok: true, until: b.cooldownUntil };
  }

  private stats(): {
    buckets: Record<string, BucketState>;
    now: number;
  } {
    return { buckets: Object.fromEntries(this.buckets), now: Date.now() };
  }

  async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.ctx.storage.put('buckets', Object.fromEntries(this.buckets));
    this.dirty = false;
  }
}
