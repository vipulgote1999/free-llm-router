/**
 * Vault tests — pure crypto helpers (hash, password PBKDF2, key gen).
 * WebCrypto is available in Node 20+ via globalThis.crypto.
 */
import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  randomToken,
  generateApiKey,
  hashPassword,
  verifyPassword,
  timingSafeEqualHex,
  isValidApiKeyShape,
  KEY_PREFIX,
} from '../src/vault-crypto';

describe('vault — sha256Hex', () => {
  it('produces deterministic 64-char hex', async () => {
    const a = await sha256Hex('hello');
    const b = await sha256Hex('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different inputs → different hashes', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});

describe('vault — randomToken / generateApiKey', () => {
  it('random tokens are url-safe and unique', () => {
    const t1 = randomToken();
    const t2 = randomToken();
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('generateApiKey returns sk-fr- prefixed keys', () => {
    const k = generateApiKey();
    expect(k.startsWith(KEY_PREFIX)).toBe(true);
    expect(isValidApiKeyShape(k)).toBe(true);
  });
  it('isValidApiKeyShape rejects junk', () => {
    expect(isValidApiKeyShape('sk-fr-')).toBe(false);
    expect(isValidApiKeyShape('garbage')).toBe(false);
    expect(isValidApiKeyShape('')).toBe(false);
    // injection attempts
    expect(isValidApiKeyShape("sk-fr-'; DROP TABLE users;--")).toBe(false);
    expect(isValidApiKeyShape('<script>alert(1)</script>')).toBe(false);
  });
});

describe('vault — password hashing (PBKDF2)', () => {
  it('verifyPassword roundtrips correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });
  it('rejects wrong password', async () => {
    const stored = await hashPassword('right-password');
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });
  it('same password → different salts (unique hashes)', async () => {
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    expect(h1.split('$')[2]).not.toBe(h2.split('$')[2]);
    expect(h1.split('$')[3]).not.toBe(h2.split('$')[3]);
  });
  it('malformed stored hash → false (no crash)', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$abc$zz$00')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$salt$hash')).toBe(false);
  });
});

describe('vault — timingSafeEqualHex', () => {
  it('equal hex strings match, different lengths do not', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
  });
});
