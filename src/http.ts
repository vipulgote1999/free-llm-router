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
].join(', ');

const EXPOSED_HEADERS = [
  'x-router-provider',
  'x-router-model',
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
    'access-control-allow-methods': 'GET, POST, OPTIONS',
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

export function jsonErr(
  status: number,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    { error: { message, type: 'router_error', ...extra } },
    { status, headers: { 'access-control-allow-origin': '*' } },
  );
}

export function html(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
