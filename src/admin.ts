/**
 * Admin surface: /admin (HTML dashboard), /admin/stats (JSON), /admin/reset.
 * Stats are aggregated by querying each provider's limiter DO in parallel.
 */

import type { BucketState, ProviderConfig } from './types';
import { DAY_MS, MINUTE_MS } from './windows';

interface AdminEnv {
  LIMITER: DurableObjectNamespace;
  [key: string]: unknown;
}

export interface BucketStats extends BucketState {
  minuteResetsAt: number;
  dayResetsAt: number;
}

export interface ProviderStats {
  provider: string;
  name: string;
  weight: number;
  dayAnchorUtc: number;
  models: number;
  limits: ProviderConfig['limits'];
  disabled?: boolean;
  disabledReason?: string;
  buckets: Record<string, BucketStats>;
}

async function doCall<T>(stub: DurableObjectStub, payload: unknown): Promise<T> {
  const res = await stub.fetch('https://limiter/op', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`limiter returned ${res.status}`);
  return (await res.json()) as T;
}

export async function collectStats(
  env: AdminEnv,
  providers: ProviderConfig[],
): Promise<ProviderStats[]> {
  const rows = await Promise.all(
    providers.map(async (p) => {
      const stub = env.LIMITER.get(env.LIMITER.idFromName(`limiter:${p.id}`));
      const raw = await doCall<{ buckets: Record<string, BucketState>; now: number }>(
        stub,
        { op: 'stats' },
      );
      const buckets: Record<string, BucketStats> = {};
      for (const [id, b] of Object.entries(raw.buckets)) {
        buckets[id] = {
          ...b,
          minuteResetsAt: b.minute.start + MINUTE_MS,
          dayResetsAt: b.day.start + DAY_MS,
        };
      }
      return {
        provider: p.id,
        name: p.name,
        weight: p.weight,
        dayAnchorUtc: p.dayAnchorUtc,
        models: p.models.length,
        limits: p.limits,
        disabled: p.disabled,
        disabledReason: p.disabledReason,
        buckets,
      };
    }),
  );
  return rows;
}

export async function resetAll(
  env: AdminEnv,
  providers: ProviderConfig[],
): Promise<void> {
  await Promise.all(
    providers.map((p) =>
      doCall(env.LIMITER.get(env.LIMITER.idFromName(`limiter:${p.id}`)), {
        op: 'reset',
      }),
    ),
  );
}

// -------------------------------------------------------------------- HTML

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>free-llm-router — limits</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; margin: 24px; }
  h1 { font-size: 16px; } h1 small { color: #8b949e; font-weight: normal; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; position: sticky; top: 0; background: #0d1117; }
  .bar { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; margin-top: 3px; min-width: 70px; }
  .bar i { display: block; height: 100%; background: #2ea043; }
  .bar.hot i { background: #d29922; } .bar.full i { background: #f85149; }
  .cool { color: #f85149; } .ok { color: #2ea043; }
  .dim { color: #8b949e; } .err { color: #f85149; font-size: 11px; }
  .btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
         padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  .btn:hover { background: #30363d; }
  .row-disabled { opacity: .4; }
</style>
</head>
<body>
<h1>free-llm-router <small>provider limits · resets · cooldowns</small></h1>
<p class="dim">Auto-refresh every 5s.
  <button class="btn" onclick="resetAll()">Reset all counters</button>
  <span id="msg" class="err"></span>
</p>
<div id="app">loading…</div>
<script>
const fmt = (ts) => ts ? new Date(ts).toISOString().replace('T',' ').slice(0,19) + 'Z' : '—';
const inSec = (ts, now) => Math.max(0, Math.ceil((ts - now) / 1000));
const pct = (used, limit) => limit > 1e15 ? 0 : Math.min(100, Math.round((used / limit) * 100));
function bar(used, limit) {
  const p = pct(used, limit);
  const cls = p >= 100 ? 'full' : p >= 80 ? 'hot' : '';
  return '<div class="bar ' + cls + '"><i style="width:' + p + '%"></i></div>';
}
function cell(used, limit) { return used + ' / ' + (limit > 1e15 ? '∞' : limit) + bar(used, limit); }
async function load() {
  const res = await fetch('/admin/stats');
  const rows = await res.json();
  const now = Date.now();
  let html = '<table><tr><th>provider</th><th>bucket</th><th>RPM</th><th>TPM</th>' +
    '<th>RPD</th><th>min resets</th><th>day resets</th><th>cooldown</th></tr>';
  for (const p of rows) {
    const ids = Object.keys(p.buckets);
    const rowsHtml = ids.length ? ids.map(id => {
      const b = p.buckets[id];
      const cd = Math.max(0, b.cooldownUntil - now);
      return '<tr>' +
        '<td class="dim">' + p.name + (p.disabled ? ' (disabled: ' + (p.disabledReason||'') + ')' : '') + '</td>' +
        '<td>' + id + '</td>' +
        '<td>' + cell(b.minute.requests, p.limits.rpm) + '</td>' +
        '<td>' + cell(b.minute.tokens, p.limits.tpm) + '</td>' +
        '<td>' + cell(b.day.requests, p.limits.rpd) + '</td>' +
        '<td>' + inSec(b.minuteResetsAt, now) + 's <span class="dim">' + fmt(b.minuteResetsAt) + '</span></td>' +
        '<td>' + (inSec(b.dayResetsAt, now) / 3600).toFixed(1) + 'h <span class="dim">' + fmt(b.dayResetsAt) + '</span></td>' +
        '<td>' + (cd > 0 ? '<span class="cool">' + Math.ceil(cd/1000) + 's</span>' : '<span class="ok">clear</span>') +
          (b.lastError ? '<div class="err">' + b.lastError + '</div>' : '') + '</td>' +
        '</tr>';
    }).join('') : '<tr><td class="dim">' + p.name + '</td><td class="dim">no traffic yet</td><td colspan="6"></td></tr>';
    html += rowsHtml;
  }
  html += '</table>';
  document.getElementById('app').innerHTML = html;
}
async function resetAll() {
  document.getElementById('msg').textContent = '';
  const res = await fetch('/admin/reset', { method: 'POST' });
  if (!res.ok) document.getElementById('msg').textContent = 'reset failed';
  load();
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
