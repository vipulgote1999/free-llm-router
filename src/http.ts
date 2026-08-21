/** Small HTTP helpers shared across the worker. */

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

export function corsHeaders(
  request: Request,
  env: { CORS_ORIGIN?: unknown },
): Record<string, string> {
  const origin =
    typeof env.CORS_ORIGIN === 'string' && env.CORS_ORIGIN !== ''
      ? env.CORS_ORIGIN
      : '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-expose-headers': EXPOSED_HEADERS,
    vary: 'Origin',
  };
}

export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
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
  opts?: { type?: string; code?: string | null; param?: string | null },
): Response {
  const type = opts?.type ?? typeForStatus(status);
  const body: Record<string, unknown> = {
    error: {
      message,
      type,
      param: opts?.param ?? null,
      code: opts?.code ?? null,
      ...extra,
    },
  };
  // Keep legacy flat shape for older clients that relied on error.type === 'router_error'
  // but also expose OpenAI-standard fields. Extra is merged inside error for passthrough debugging.
  return json(body, { status, headers: { 'access-control-allow-origin': '*' } });
}

export function openAIError(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonErr(status, message, extra);
}

export function html(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
