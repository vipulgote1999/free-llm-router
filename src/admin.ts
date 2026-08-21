/**
 * Admin surface: /admin (HTML dashboard), /admin/stats (JSON), /admin/reset.
 * Stats are aggregated by querying each provider's limiter DO in parallel.
 * v2: enriched dashboard with health chips, latency p50/p95, success/failure,
 * token totals, fallback chain and live request logs.
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

// -------------------------------------------------------------------- HTML Dashboard v2

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>free-llm-router — dashboard</title>
<style>
  :root { color-scheme: dark; --bg:#0a0e13; --panel:#11161e; --border:#1f2937; --muted:#8b949e; --text:#c9d1d9; --green:#2ea043; --amber:#d29922; --red:#f85149; --blue:#58a6ff; --radius:10px; }
  *{box-sizing:border-box}
  body { font: 13px/1.5 Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background: var(--bg); color: var(--text); margin:0; }
  header { position:sticky; top:0; z-index:10; backdrop-filter:blur(12px); background:rgba(10,14,19,.85); border-bottom:1px solid var(--border); padding:14px 24px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  header h1{font-size:15px; margin:0; font-weight:700; letter-spacing:-.02em}
  header h1 small{color:var(--muted); font-weight:400; font-size:12px; margin-left:8px}
  .chips{display:flex; gap:8px; flex-wrap:wrap; align-items:center}
  .chip{font:11px/1 ui-monospace,monospace; padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:var(--panel); color:var(--muted)}
  .chip b{color:var(--text)}
  .chip.ok{border-color:rgba(46,160,67,.4); color:var(--green)}
  .chip.warn{border-color:rgba(210,153,34,.4); color:var(--amber)}
  .chip.err{border-color:rgba(248,81,73,.4); color:var(--red)}
  .actions{margin-left:auto; display:flex; gap:8px; align-items:center}
  .btn{appearance:none; background:var(--panel); color:var(--text); border:1px solid var(--border); padding:7px 12px; border-radius:8px; cursor:pointer; font:inherit; font-size:12px}
  .btn:hover{border-color:#2d3748; background:#162032}
  .btn.primary{background:#1f6feb; border-color:#1f6feb; color:white}
  .btn.primary:hover{background:#1a5fcc}
  .btn:disabled{opacity:.5; cursor:not-allowed}
  main{padding:20px 24px 40px; max-width:1400px; margin:0 auto}
  .grid{display:grid; gap:16px; margin-top:16px}
  .grid.cols3{grid-template-columns: repeat(auto-fit,minmax(280px,1fr))}
  .card{background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:14px; overflow:hidden}
  .card h3{margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted)}
  .metric{font-size:22px; font-weight:700; letter-spacing:-.03em}
  .metric small{font-size:12px; font-weight:400; color:var(--muted)}
  .dim{color:var(--muted)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  table{width:100%; border-collapse:collapse; font-size:12.5px}
  th,td{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top}
  th{color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; position:sticky; top:0; background:var(--panel)}
  .bar{height:6px; background:#0d1117; border-radius:999px; overflow:hidden; margin-top:4px; min-width:72px; border:1px solid #1a2230}
  .bar i{display:block; height:100%; background:var(--green); transition:width .3s}
  .bar.hot i{background:var(--amber)} .bar.full i{background:var(--red)}
  .badge{font:10px/1 ui-monospace,monospace; padding:3px 6px; border-radius:999px; border:1px solid var(--border); display:inline-block}
  .badge.ok{color:var(--green); border-color:rgba(46,160,67,.35); background:rgba(46,160,67,.1)}
  .badge.cool{color:var(--red); border-color:rgba(248,81,73,.35); background:rgba(248,81,73,.08)}
  .badge.disabled{color:var(--muted); border-color:var(--border)}
  .provider-row{border-left:3px solid transparent}
  .provider-row.cooldown{border-left-color:var(--red)}
  .provider-row.disabled{opacity:.55}
  .spark{height:28px; display:flex; align-items:end; gap:2px; margin-top:6px}
  .spark i{width:4px; background:var(--blue); border-radius:2px 2px 0 0; opacity:.9}
  .log-ok{color:var(--green)} .log-err{color:var(--red)} .log-skip{color:var(--amber)}
  .chain{display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:8px 0}
  .chain .step{font:11px ui-monospace,monospace; padding:5px 8px; border-radius:8px; border:1px solid var(--border); background:#0d1117}
  .chain .step.ok{border-color:rgba(46,160,67,.4)} .chain .step.fail{border-color:rgba(248,81,73,.35)}
  .pill{font:10px ui-monospace,monospace; padding:2px 6px; border-radius:999px; background:#0d1117; border:1px solid var(--border); color:var(--muted)}
  .controls{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px}
  .controls label{font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px}
  input[type=checkbox]{accent-color:#1f6feb}
  .empty{padding:24px; text-align:center; color:var(--muted); border:1px dashed var(--border); border-radius:var(--radius); background:var(--panel)}
  a{color:var(--blue); text-decoration:none} a:hover{text-decoration:underline}
  code{font-family:ui-monospace,monospace; font-size:11px; background:#0d1117; border:1px solid var(--border); padding:2px 6px; border-radius:6px}
</style>
</head>
<body>
<header>
  <h1>free-llm-router <small>LiteLLM-style gateway · free provider pool</small></h1>
  <div class="chips" id="chips"></div>
  <div class="actions">
    <label class="dim mono" style="font-size:11px"><input type="checkbox" id="auto" checked> auto-refresh 5s</label>
    <button class="btn" onclick="load()">Refresh</button>
    <button class="btn primary" onclick="resetAll()">Reset counters</button>
  </div>
</header>
<main>
  <div class="grid cols3" id="summary"></div>

  <div style="display:flex; align-items:center; gap:12px; margin-top:18px">
    <h2 style="font-size:13px; margin:0">Providers</h2>
    <span class="dim mono" style="font-size:11px" id="generated"></span>
    <span style="margin-left:auto" class="dim mono" style="font-size:11px">weight → priority · cooldown → skip until retry</span>
  </div>
  <div class="card" style="padding:0; margin-top:8px; overflow:auto; max-height:520px">
    <table id="providers"><thead><tr><th>provider</th><th>bucket</th><th>RPM</th><th>TPM</th><th>RPD</th><th>resets</th><th>health</th></tr></thead><tbody></tbody></table>
  </div>

  <div class="grid" style="grid-template-columns:1.3fr .7fr; margin-top:16px">
    <div class="card">
      <h3>Recent requests <span class="dim mono" id="logCount"></span></h3>
      <div id="logs" class="mono" style="font-size:11.5px; max-height:320px; overflow:auto"></div>
      <div class="controls">
        <span class="dim">Shows last 80 router attempts (in-memory ring, per isolate)</span>
        <button class="btn" style="margin-left:auto" onclick="load()">Load</button>
      </div>
    </div>
    <div class="card">
      <h3>Fallback chain · last 503</h3>
      <div id="chain"></div>
      <div class="dim" style="margin-top:10px; font-size:11px">
        Uses <code>fallbacks: [{model:"..."}]</code> in request body for per-request overrides (LiteLLM parity). Global retry bound via <code>MAX_RETRIES</code> env.
      </div>
      <h3 style="margin-top:16px">Quick curl</h3>
      <pre style="background:#0d1117; border:1px solid var(--border); border-radius:8px; padding:10px; overflow:auto; font-size:11px; margin:0"><code id="curl">curl https://$HOST/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'

# with fallback (LiteLLM style)
curl ... -d '{"model":"groq/llama-3.3-70b-versatile",
  "fallbacks":["cerebras/gpt-oss-120b","openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
  "messages":[...]}'</code></pre>
    </div>
  </div>

  <div class="dim mono" style="font-size:11px; margin-top:18px; text-align:center">
    OpenAI SDK: <code>base_url="https://$HOST/v1"</code> · <a href="/v1/models" target="_blank">GET /v1/models</a> · <a href="/health" target="_blank">GET /health</a> · <a href="/admin/stats" target="_blank">GET /admin/stats</a>
  </div>
</main>
<script>
const $ = (s)=>document.querySelector(s);
const fmt = (ts) => ts ? new Date(ts).toISOString().replace('T',' ').slice(0,19)+'Z' : '—';
const inSec = (ts, now) => Math.max(0, Math.ceil((ts-now)/1000));
const fmtSec = (s)=> s<60 ? s+'s' : (s/60|0)+'m '+(s%60)+'s';
const pct = (used, limit) => limit>1e15 ? 0 : Math.min(100, Math.round((used/limit)*100));
function bar(used, limit){
  const p=pct(used,limit);
  const cls=p>=100?'full':p>=80?'hot':'';
  return '<div class="bar '+cls+'"><i style="width:'+p+'%"></i></div><span class="dim mono" style="font-size:10px">'+p+'%</span>';
}
function cell(used, limit){ const isInf=limit>1e15; return '<span class="mono">'+used+' / '+(isInf?'∞':limit)+'</span>'+bar(used,limit); }

let timer=null;
function setAuto(on){
  const cb=$('#auto');
  cb.checked=on;
  if(timer) clearInterval(timer);
  if(on) timer=setInterval(load,5000);
}
$('#auto').addEventListener('change', (e)=> setAuto(e.target.checked));

async function load(){
  try{
    const res=await fetch('/admin/stats');
    const data=await res.json();
    // compat: /admin/stats may return array (legacy) or {providers,logs,summary}
    const rows = Array.isArray(data) ? data : (data.providers ?? data);
    const logs = Array.isArray(data) ? [] : (data.logs ?? []);
    const summary = Array.isArray(data) ? null : (data.summary ?? null);
    const now = (summary && summary.now) || Date.now();
    renderChips(rows, summary, now);
    renderSummary(rows, summary, logs, now);
    renderProviders(rows, now);
    renderLogs(logs);
    renderChain(logs);
    $('#generated').textContent = 'updated '+fmt(now)+' · auto '+ ( $('#auto').checked ? 'on' : 'off');
  }catch(e){
    $('#providers tbody').innerHTML = '<tr><td colspan="7" class="dim">failed to load: '+String(e)+'</td></tr>';
  }
}
function renderChips(rows, summary, now){
  const total=rows.length;
  const enabled=rows.filter(r=>!r.disabled).length;
  const cooling=rows.filter(r=> Object.values(r.buckets||{}).some(b=> (b.cooldownUntil||0) > now )).length;
  const disabled=rows.filter(r=>r.disabled).length;
  const p50 = summary?.p50, p95=summary?.p95;
  const succ = summary?.success ?? 0, fail = summary?.failure ?? 0;
  let html='';
  html += '<span class="chip"><b>'+total+'</b> providers · <b style="color:var(--green)">'+enabled+' enabled</b> · '+disabled+' disabled</span>';
  if(cooling) html += '<span class="chip err"><b>'+cooling+'</b> cooling</span>'; else html += '<span class="chip ok">no cooldowns</span>';
  if(p50!=null) html += '<span class="chip">p50 <b>'+p50+'ms</b> · p95 <b>'+p95+'ms</b></span>';
  if(summary) html += '<span class="chip">ok <b style="color:var(--green)">'+succ+'</b> · fail <b style="color:var(--red)">'+fail+'</b></span>';
  html += '<span class="chip mono">openai: /v1/chat/completions · /v1/embeddings · /v1/models</span>';
  $('#chips').innerHTML = html;
}
function renderSummary(rows, summary, logs, now){
  const totalBuckets = rows.reduce((a,r)=> a + Object.keys(r.buckets||{}).length, 0);
  const totalModels = rows.reduce((a,r)=> a + (r.models||0), 0);
  const coolingBuckets = rows.reduce((a,r)=> a + Object.values(r.buckets||{}).filter(b=> (b.cooldownUntil||0)>now).length, 0);
  const ok = summary?.success ?? 0, fail = summary?.failure ?? 0, p50=summary?.p50, p95=summary?.p95;
  // token totals (approx from bucket day tokens)
  let dayTokens = 0; let minuteReq=0;
  for(const r of rows){
    for(const b of Object.values(r.buckets||{})){
      dayTokens += b.day?.tokens ?? 0;
      minuteReq += b.minute?.requests ?? 0;
    }
  }
  const el=$('#summary');
  el.innerHTML = ''
    + '<div class="card"><h3>Throughput</h3><div class="metric">'+minuteReq+' <small>req/min (tracked)</small></div><div class="dim mono" style="font-size:11px; margin-top:4px">'+dayTokens.toLocaleString()+' tokens today · '+totalBuckets+' buckets · '+totalModels+' models</div><div class="spark">'+Array.from({length:12},(_,i)=> '<i style="height:'+ (6+Math.random()*22|0)+'px"></i>').join('')+'</div></div>'
    + '<div class="card"><h3>Latency (recent ok)</h3><div class="metric">'+(p50!=null ? p50+'<small>ms p50</small> · '+p95+'<small>ms p95</small>' : '— <small>no traffic yet</small>')+'</div><div class="dim mono" style="font-size:11px; margin-top:4px">'+(ok+fail)+' attempts · <span style="color:var(--green)">'+ok+' ok</span> · <span style="color:var(--red)">'+fail+' fail/skip</span></div><div class="dim" style="font-size:11px; margin-top:6px">per-attempt ms shown in logs; p50/p95 computed from last 80 successes</div></div>'
    + '<div class="card"><h3>Failover health</h3><div class="metric" style="color:'+(coolingBuckets? 'var(--amber)':'var(--green)')+'">'+coolingBuckets+' <small>buckets cooling</small></div><div class="dim mono" style="font-size:11px; margin-top:4px">'+rows.length+' providers · fallbacks: <code>fallbacks</code> param + context_window fallback + 429/5xx chain</div><div style="margin-top:8px"><span class="badge '+(coolingBuckets? 'cool':'ok')+'">'+(coolingBuckets? 'degraded — failover active' : 'healthy')+'</span></div></div>';
}
function renderProviders(rows, now){
  const tbody=$('#providers tbody');
  if(!rows.length){ tbody.innerHTML='<tr><td colspan="7"><div class="empty">no providers configured</div></td></tr>'; return; }
  let html='';
  for(const p of rows){
    const ids=Object.keys(p.buckets||{});
    const health = p.disabled ? 'disabled' : (ids.some(id=> (p.buckets[id].cooldownUntil||0) > now) ? 'cooldown' : 'ok');
    const rowCls = p.disabled ? 'disabled' : health==='cooldown' ? 'cooldown' : '';
    if(ids.length===0){
      html += '<tr class="provider-row '+rowCls+'"><td><b>'+p.name+'</b> <span class="dim mono">'+p.provider+'</span> <span class="pill">'+p.weight+'</span> '+(p.disabled? '<span class="badge disabled" title="'+(p.disabledReason||'')+'">disabled</span>' : (health==='cooldown'?'<span class="badge cool">cooldown</span>':'<span class="badge ok">ok</span>'))+'<div class="dim" style="font-size:11px">'+p.models+' models · anchor UTC '+p.dayAnchorUtc+'</div></td><td class="dim">no traffic yet</td><td colspan="5" class="dim">—</td></tr>';
      continue;
    }
    for(const id of ids){
      const b=p.buckets[id];
      const cd=Math.max(0,(b.cooldownUntil||0)-now);
      const cdTxt= cd>0 ? '<span class="badge cool">'+fmtSec(Math.ceil(cd/1000))+'</span>' : '<span class="badge ok">clear</span>';
      const resetMin = inSec(b.minuteResetsAt, now);
      const resetDayH = (inSec(b.dayResetsAt, now)/3600).toFixed(1);
      html += '<tr class="provider-row '+rowCls+'">'
        + '<td><b>'+p.name+'</b> <span class="dim mono">'+p.provider+'</span> <span class="pill mono">'+id+'</span><div class="dim mono" style="font-size:10px">w '+p.weight+' · '+p.models+' models</div></td>'
        + '<td>'+id+'</td>'
        + '<td>'+cell(b.minute.requests, p.limits.rpm)+'<div class="dim mono" style="font-size:10px">reset '+fmtSec(resetMin)+'</div></td>'
        + '<td>'+cell(b.minute.tokens, p.limits.tpm)+'</td>'
        + '<td>'+cell(b.day.requests, p.limits.rpd)+'<div class="dim mono" style="font-size:10px">'+resetDayH+'h · '+fmt(b.dayResetsAt)+'</div></td>'
        + '<td class="mono" style="font-size:11px"><div>'+fmtSec(resetMin)+' <span class="dim">'+fmt(b.minuteResetsAt)+'</span></div><div>'+resetDayH+'h <span class="dim">'+fmt(b.dayResetsAt)+'</span></div></td>'
        + '<td>'+cdTxt + (b.lastError? '<div class="mono" style="font-size:10px; color:var(--red); margin-top:4px">'+b.lastError+'</div>' : '') + '</td>'
        + '</tr>';
    }
  }
  tbody.innerHTML=html || '<tr><td colspan="7" class="dim">no buckets</td></tr>';
}
function renderLogs(logs){
  const el=$('#logs');
  const count=$('#logCount'); if(count) count.textContent = '('+logs.length+' recent)';
  if(!logs || logs.length===0){ el.innerHTML='<div class="dim">no attempts yet — send a request to <code>/v1/chat/completions</code></div>'; return; }
  // newest first
  const rev=[...logs].slice(-30).reverse();
  let html='<table style="font-size:11px"><thead><tr><th>time</th><th>provider</th><th>model</th><th>bucket</th><th>outcome</th><th>reason</th><th>ms</th></tr></thead><tbody>';
  for(const l of rev){
    const cls = l.outcome==='ok' ? 'log-ok' : l.outcome==='skipped' ? 'log-skip' : 'log-err';
    const when = new Date(l.ts).toISOString().slice(11,19);
    html+='<tr><td class="mono dim">'+when+'</td><td>'+l.provider+'</td><td class="mono" style="max-width:180px; overflow:hidden; text-overflow:ellipsis">'+l.model+'</td><td class="mono dim">'+l.bucket+'</td><td class="'+cls+'">'+l.outcome+'</td><td>'+(l.reason||'—')+(l.retryAfterSec? ' · '+l.retryAfterSec+'s':'')+'</td><td class="mono">'+(l.ms??'—')+'ms</td></tr>';
  }
  html+='</tbody></table>';
  el.innerHTML=html;
}
function renderChain(logs){
  const el=$('#chain');
  if(!logs || logs.length===0){ el.innerHTML='<div class="dim">no data</div>'; return; }
  // find last 503-like burst: group by recent timestamp proximity (within 2s)
  const rev=[...logs].reverse();
  // take last up to 12 entries that are close in time (within 2000ms window)
  const lastTs = rev[0]?.ts ?? 0;
  const burst = rev.filter(l=> lastTs - l.ts < 2500).reverse();
  if(burst.length===0){ el.innerHTML='<div class="dim">no recent burst</div>'; return; }
  let html='<div class="chain">';
  for(let i=0;i<burst.length;i++){
    const l=burst[i];
    const ok=l.outcome==='ok';
    html+='<span class="step '+(ok?'ok':'fail')+'">'+l.provider+'<span class="dim"> / '+l.model.slice(0,22)+'</span> <span class="pill">'+l.reason+'</span>'+(l.ms?' <span class="dim">'+l.ms+'ms</span>':'')+'</span>';
    if(i<burst.length-1) html+='<span class="dim">→</span>';
  }
  html+='</div>';
  // also show tried count
  const fails = burst.filter(l=> l.outcome!=='ok').length;
  const okCount = burst.filter(l=> l.outcome==='ok').length;
  html+='<div class="dim mono" style="font-size:11px; margin-top:6px">'+burst.length+' hops · '+fails+' skipped/failed · '+okCount+' ok · last at '+fmt(burst[burst.length-1].ts)+'</div>';
  if(okCount===0) html+='<div style="margin-top:8px; color:var(--amber); font-size:11px">All providers exhausted — client received <code>503 all providers exhausted</code> with <code>tried[]</code>. Add keys or increase limits to reduce cooldowns.</div>';
  el.innerHTML=html;
}
async function resetAll(){
  const msg=$('#chips');
  const res=await fetch('/admin/reset',{method:'POST'});
  if(!res.ok) alert('reset failed');
  load();
}
load();
setAuto(true);
if(location.hostname) $('#curl').textContent = $('#curl').textContent.replaceAll('$HOST', location.host);
// replace host placeholder in header curl example
</script>
</body>
</html>`;
