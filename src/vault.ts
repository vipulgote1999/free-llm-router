/**
 * Credential Vault DO — secure storage for router API keys + admin login.
 * Crypto helpers live in ./vault-crypto (pure, unit-tested).
 * Keys stored as SHA-256 hashes; master password as PBKDF2-SHA256 (100k iters).
 * Login lockout: 5 fails → 15 min. Sessions: 24h, hashed at rest.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  sha256Hex,
  randomToken,
  generateApiKey,
  hashPassword,
  verifyPassword,
  isValidApiKeyShape,
  KEY_PREFIX,
} from './vault-crypto';

export { sha256Hex, randomToken, generateApiKey, hashPassword, verifyPassword, timingSafeEqualHex, isValidApiKeyShape, KEY_PREFIX } from './vault-crypto';
import type { KeyRecord, SessionRecord } from './vault-crypto';

// ------------------------------------------------------------------ DO state types


interface LoginAttemptState {
  fails: number;
  lockedUntil: number;
}

type VaultOp =
  | { op: 'init'; masterHash: string }
  | { op: 'hasMaster' }
  | { op: 'login'; password: string }
  | { op: 'verifySession'; token: string }
  | { op: 'logout'; token: string }
  | { op: 'createKey'; name: string; scope?: 'admin' | 'api' } // returns plaintext once
  | { op: 'listKeys' }
  | { op: 'revokeKey'; hash: string }
  | { op: 'deleteKey'; hash: string }
  | { op: 'revokeKeyByPrefix'; prefix: string }
  | { op: 'deleteKeyByPrefix'; prefix: string }
  | { op: 'checkKey'; key: string }
  | { op: 'touchKey'; hash: string }
  | { op: 'changePassword'; oldPassword: string; newPassword: string }
  | { op: 'stats' };

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_SESSIONS = 50;

/** VaultDO — singleton credential store. */
export class VaultDO extends DurableObject {
  private masterHash?: string;
  private keys = new Map<string, KeyRecord>(); // hash -> record
  private sessions = new Map<string, SessionRecord>(); // token hash -> record
  private loginState: LoginAttemptState = { fails: 0, lockedUntil: 0 };
  private dirty = true;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.masterHash = (await ctx.storage.get<string>('masterHash')) ?? undefined;
      const k = await ctx.storage.get<{ [hash: string]: KeyRecord }>('keys');
      if (k) this.keys = new Map(Object.entries(k));
      const s = await ctx.storage.get<{ [hash: string]: SessionRecord }>('sessions');
      if (s) this.sessions = new Map(Object.entries(s));
      const l = await ctx.storage.get<LoginAttemptState>('loginState');
      if (l) this.loginState = l;
    });
  }

  async fetch(request: Request): Promise<Response> {
    let op: VaultOp;
    try {
      op = (await request.json()) as VaultOp;
    } catch {
      return respond({ error: 'invalid op' }, 400);
    }
    switch (op.op) {
      case 'init':
        return respond(await this.init(op.masterHash));
      case 'hasMaster':
        return respond({ hasMaster: !!this.masterHash });
      case 'login':
        return respond(await this.login(op.password));
      case 'verifySession':
        return respond(await this.verifySession(op.token));
      case 'logout':
        return respond(await this.logout(op.token));
      case 'createKey':
        return respond(await this.createKey(op.name, op.scope));
      case 'listKeys':
        return respond({ keys: [...this.keys.values()].map(sanitizeKeyRecord) });
      case 'revokeKey':
        return respond(await this.revokeKey(op.hash));
      case 'deleteKey':
        return respond(await this.deleteKey(op.hash));
      case 'revokeKeyByPrefix':
        return respond(await this.revokeKeyByPrefix(op.prefix));
      case 'deleteKeyByPrefix':
        return respond(await this.deleteKeyByPrefix(op.prefix));
      case 'checkKey':
        return respond(await this.checkKey(op.key));
      case 'touchKey':
        return respond(await this.touchKey(op.hash));
      case 'changePassword':
        return respond(await this.changePassword(op.oldPassword, op.newPassword));
      case 'stats':
        return respond({
          hasMaster: !!this.masterHash,
          totalKeys: this.keys.size,
          activeKeys: [...this.keys.values()].filter((k) => !k.revoked).length,
          activeSessions: this.sessions.size,
          lockedForSec: Math.max(0, Math.ceil((this.loginState.lockedUntil - Date.now()) / 1000)),
        });
      default:
        return respond({ error: 'unknown op' }, 400);
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('masterHash', this.masterHash ?? '');
    await this.ctx.storage.put('keys', Object.fromEntries(this.keys));
    await this.ctx.storage.put('sessions', Object.fromEntries(this.sessions));
    await this.ctx.storage.put('loginState', this.loginState);
  }

  private async init(masterHash: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.masterHash) return { ok: false, reason: 'already initialized' };
    this.masterHash = masterHash;
    await this.persist();
    return { ok: true };
  }

  private async login(password: string): Promise<{ ok: boolean; reason?: string; token?: string; expiresAt?: number }> {
    const now = Date.now();
    if (this.loginState.lockedUntil > now) {
      return { ok: false, reason: `locked for ${Math.ceil((this.loginState.lockedUntil - now) / 1000)}s` };
    }
    if (!this.masterHash) return { ok: false, reason: 'not initialized' };
    const valid = await verifyPassword(password, this.masterHash);
    if (!valid) {
      this.loginState.fails += 1;
      if (this.loginState.fails >= 5) {
        // exponential lockout: 15min after 5 fails
        this.loginState.lockedUntil = now + 15 * 60 * 1000;
        this.loginState.fails = 0;
      }
      await this.persist();
      return { ok: false, reason: 'invalid password' };
    }
    // success — reset fails
    this.loginState.fails = 0;
    // issue session
    const token = randomToken(32);
    const hash = await sha256Hex(token);
    const rec: SessionRecord = { hash, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    this.sessions.set(hash, rec);
    // prune expired / oldest sessions
    for (const [h, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(h);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.sessions.delete(oldest[0]); else break;
    }
    await this.persist();
    return { ok: true, token, expiresAt: rec.expiresAt };
  }

  private async verifySession(token: string): Promise<{ ok: boolean; reason?: string }> {
    if (!token) return { ok: false, reason: 'no token' };
    const now = Date.now();
    const hash = await sha256Hex(token);
    const rec = this.sessions.get(hash);
    if (!rec) return { ok: false, reason: 'invalid session' };
    if (rec.expiresAt <= now) {
      this.sessions.delete(hash);
      await this.persist();
      return { ok: false, reason: 'session expired' };
    }
    return { ok: true };
  }

  private async logout(token: string): Promise<{ ok: boolean }> {
    const hash = await sha256Hex(token);
    this.sessions.delete(hash);
    await this.persist();
    return { ok: true };
  }

  private async createKey(name: string, scope?: 'admin' | 'api'): Promise<{ ok: boolean; key?: string; record?: Partial<KeyRecord>; reason?: string }> {
    const plaintext = generateApiKey();
    const hash = await sha256Hex(plaintext);
    const record: KeyRecord = {
      hash,
      prefix: plaintext.slice(0, KEY_PREFIX.length + 8),
      name: String(name).slice(0, 100),
      createdAt: Date.now(),
      revoked: false,
      scope: scope === 'admin' ? 'admin' : 'api',
    };
    this.keys.set(hash, record);
    await this.persist();
    return { ok: true, key: plaintext, record: sanitizeKeyRecord(record) };
  }

  private async revokeKey(hash: string): Promise<{ ok: boolean }> {
    const r = this.keys.get(hash);
    if (r) {
      r.revoked = true;
      await this.persist();
    }
    return { ok: true };
  }

  private async deleteKey(hash: string): Promise<{ ok: boolean }> {
    this.keys.delete(hash);
    await this.persist();
    return { ok: true };
  }

  private async revokeKeyByPrefix(prefix: string): Promise<{ ok: boolean; found?: boolean }> {
    for (const [hash, r] of this.keys) {
      if (r.prefix === prefix) {
        r.revoked = true;
        await this.persist();
        return { ok: true, found: true };
      }
    }
    return { ok: true, found: false };
  }

  private async deleteKeyByPrefix(prefix: string): Promise<{ ok: boolean; found?: boolean }> {
    for (const [hash, r] of this.keys) {
      if (r.prefix === prefix) {
        this.keys.delete(hash);
        await this.persist();
        return { ok: true, found: true };
      }
    }
    return { ok: true, found: false };
  }

  private async checkKey(key: string): Promise<{ ok: boolean; record?: Partial<KeyRecord> }> {
    if (!isValidApiKeyShape(key)) return { ok: false };
    const hash = await sha256Hex(key);
    const r = this.keys.get(hash);
    if (!r || r.revoked) return { ok: false };
    return { ok: true, record: sanitizeKeyRecord(r) };
  }

  private async touchKey(hash: string): Promise<{ ok: boolean }> {
    const r = this.keys.get(hash);
    if (r) {
      r.lastUsedAt = Date.now();
      // throttle persistence for touch (high frequency)
      if (!this.touchTimer) {
        this.touchTimer = setTimeout(() => void this.persist(), 5000) as unknown as ReturnType<typeof setTimeout>;
      }
    }
    return { ok: true };
  }
  private touchTimer?: ReturnType<typeof setTimeout>;

  private async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.masterHash) return { ok: false, reason: 'not initialized' };
    const validOld = await verifyPassword(oldPassword, this.masterHash);
    if (!validOld) return { ok: false, reason: 'invalid old password' };
    if (typeof newPassword !== 'string' || newPassword.length < 8) return { ok: false, reason: 'new password too short (min 8)' };
    this.masterHash = await hashPassword(newPassword);
    // invalidate all sessions on password change
    this.sessions.clear();
    await this.persist();
    return { ok: true };
  }
}

/** Strip hash from record before sending to client. */
function sanitizeKeyRecord(r: KeyRecord): Partial<KeyRecord> {
  return {
    prefix: r.prefix,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revoked: r.revoked,
    scope: r.scope,
  };
}
