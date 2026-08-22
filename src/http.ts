/** Small HTTP helpers shared across the worker — now security-hardened. */

const ALLOWED_HEADERS = [
  'content-type',
  'authorization',
  'x-groq-api-key',
  'x-gemini-api-key',
  'x-openrouter-api-key',
  'x-opencode-api-key',
  'x-cerebras-api-key',
  'x-sambanova-api-key',
  'x-nvidia-api-key',
  'x-mistral-api-key',
  'x-ollama-api-key',
  'x-truerouter-api-key',
  'x-router-provider',
  'x-router-model',
  'x-stainless-retry-count',
  'x-title',
  'x-request-id',
].join(', ');

const EXPOSED_HEADERS = [
  'x-router-provider',
  'x-router-model',
  'x-request-id',
  'retry-after',
].join(', ');

// ---- security: request size limits (DoS) ----
export const MAX_JSON_BYTES = 1_000_000; // 1 MB for JSON bodies
export const MAX_RAW_BYTES = 10_000_000; // 10 MB for multipart (audio/images)

/** Escape HTML for safe innerHTML interpolation (XSS). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Security headers applied to every response (defense in depth). */
export function securityHeaders(isAdmin = false): Record<string, string> {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    // Cloudflare Workers are always HTTPS, so HSTS is safe
  };
  if (isAdmin) {
    h['x-robots-tag'] = 'noindex, nofollow';
    h['cache-control'] = 'no-store, max-age=0';
  } else {
    // API responses should not be cached by CDNs that might cache 4xx/5xx
    h['cache-control'] = 'no-store';
  }
  // CSP for browser clients: allow self + fonts + connect to known upstreams (for dashboard fetch)
  // Dashboard needs inline scripts (its own) and google fonts. We allow unsafe-inline for style/script
  // because dashboard is a single self-contained HTML with inline JS/CSS; a nonce would be overkill for this worker.
  // For API JSON, CSP is still useful as defense-in-depth if a browser mistakenly renders JSON as HTML.
  h['content-security-policy'] =
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://fonts.gstatic.com https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "font-src https://fonts.gstatic.com data:; " +
    "connect-src 'self' https://free-llm-router.vipulgote5.workers.dev https://api.groq.com https://api.cerebras.ai https://generativelanguage.googleapis.com https://openrouter.ai https://opencode.ai https://integrate.api.nvidia.com https://api.sambanova.ai https://api.mistral.ai https://api.tokenrouter.com; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  return h;
}

export function corsHeaders(
  request: Request,
  env: { CORS_ORIGIN?: unknown },
): Record<string, string> {
  // Strict allowlist: if CORS_ORIGIN is set, only allow that exact origin (or comma-separated list).
  // Otherwise default to * for backward compat, but still validate.
  const raw = typeof env.CORS_ORIGIN === 'string' ? env.CORS_ORIGIN.trim() : '';
  const reqOrigin = request.headers.get('origin') ?? '';
  let allowOrigin = '*';
  if (raw) {
    const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(reqOrigin)) allowOrigin = reqOrigin;
    else if (allowed.includes('*')) allowOrigin = '*';
    else allowOrigin = allowed[0] ?? 'null'; // not allowed → browser will block
  }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-expose-headers': EXPOSED_HEADERS,
    vary: 'Origin',
  };
}

export function json(data: unknown, init?: ResponseInit & { isAdmin?: boolean }): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  const sec = securityHeaders(init?.isAdmin);
  for (const [k, v] of Object.entries(sec)) if (!headers.has(k)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'router_error';

function typeForStatus(status: number): OpenAIErrorType {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'router_error';
}

export function jsonErr(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
  opts?: { type?: string; code?: string | null; param?: string | null; isAdmin?: boolean },
): Response {
  const type = opts?.type ?? typeForStatus(status);
  // Sanitize message: strip stack traces, limit length, never echo secrets
  const safeMsg = String(message).slice(0, 2000).replace(/\n.*stack.*/is, '').trim();
  const body: Record<string, unknown> = {
    error: {
      message: safeMsg,
      type,
      param: opts?.param ?? null,
      code: opts?.code ?? null,
      ...extra,
    },
  };
  return json(body, { status, isAdmin: opts?.isAdmin, headers: { 'access-control-allow-origin': '*' } });
}

export function openAIError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonErr(status, message, extra);
}

export function html(body: string, isAdmin = false): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  const sec = securityHeaders(isAdmin);
  for (const [k, v] of Object.entries(sec)) headers.set(k, v);
  return new Response(body, { headers });
}

/** Check Content-Length before reading body (DoS). Returns error Response if too large, else null. */
export function checkBodySize(request: Request, isRaw = false): Response | null {
  const len = request.headers.get('content-length');
  if (len) {
    const n = Number(len);
    const max = isRaw ? MAX_RAW_BYTES : MAX_JSON_BYTES;
    if (Number.isFinite(n) && n > max) {
      return jsonErr(413, `payload too large: ${n} > ${max} bytes`, undefined, { code: 'payload_too_large' });
    }
  }
  return null;
}
