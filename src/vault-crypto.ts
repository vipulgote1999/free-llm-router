/**
 * Vault crypto — pure helpers (no Cloudflare imports) so they unit-test cleanly.
 * SHA-256 key hashing, PBKDF2 password hashing, timing-safe compare, token gen.
 */

import { DurableObject } from 'cloudflare:workers';

// ------------------------------------------------------------------ pure helpers

export const KEY_PREFIX = 'sk-fr-';

/** SHA-256 hex of a string. */
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random URL-safe token (default 32 bytes → ~43 chars). */
export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // base64url without padding
  let s = btoa(String.fromCharCode(...arr));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a new displayable API key: sk-fr-<32 url-safe chars>. Returns plaintext (show once). */
export function generateApiKey(): string {
  return KEY_PREFIX + randomToken(24);
}

/** PBKDF2-SHA256 password hash → "pbkdf2$<iterations>$<saltHex>$<hashHex>". */
export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const saltHex = [...salt].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
}

/** Verify password against stored "pbkdf2$iter$salt$hash" string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const saltHex: string = parts[2] ?? '';
  const expected: string = parts[3] ?? '';
  if (!Number.isFinite(iterations) || !/^[0-9a-f]{32}$/.test(saltHex) || !expected) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const enc = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqualHex(hashHex, expected);
  } catch {
    return false;
  }
}

/** Constant-time hex comparison (XOR accumulate). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Validate a generated key shape. */
export function isValidApiKeyShape(key: string): boolean {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length >= 30 && /^[A-Za-z0-9_\-]+$/.test(key.slice(KEY_PREFIX.length));
}

// ------------------------------------------------------------------ record shapes

export interface KeyRecord {
  /** sha256 of full key */
  hash: string;
  /** display prefix, e.g. sk-fr-ab12cd34 */
  prefix: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  revoked?: boolean;
  /** optional scope: 'admin' | 'api' */
  scope?: 'admin' | 'api';
}

export interface SessionRecord {
  hash: string;
  createdAt: number;
  expiresAt: number;
}
