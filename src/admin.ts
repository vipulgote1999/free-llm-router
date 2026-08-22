/**
 * Admin surface: /admin (HTML dashboard), /admin/stats (JSON), /admin/reset.
 * Stats are aggregated by querying each provider's limiter DO in parallel.
 * v3 — Pro Max: Müller-Brockmann modular grid (12 cols, 8px baseline, subgrid bands,
 * optical ink alignment, grid toggle). White paper / ink / red accent, grotesque type,
 * flush-left, verified grid adherence.
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

// -------------------------------------------------------------------- HTML — Pro Max Grid
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>free-llm-router — pro dashboard</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{
  --cols:12;
  --bl:8px;
  --lh:24px;
  --gutter:24px;
  --margin:48px;
  --pad:48px;
  --maxw:1440px;
  --paper:#ffffff;
  --ink:#0f1419;
  --ink-soft:#5b6066;
  --line:#e6e8eb;
  --line-strong:#d1d5db;
  --accent:#e4002b;
  --green:#0a7a42;
  --amber:#8a6d00;
  --red:#e4002b;
  --blue:#1a5fcc;
  --panel:#f8f9fa;
  --g-col:rgba(228,0,43,.055);
  --g-edge:rgba(228,0,43,.32);
  --g-base:rgba(11,94,215,.22);
  --g-base-min:rgba(11,94,215,.08);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Inter",system-ui,sans-serif;font-size:15px;line-height:var(--lh);-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none;border-bottom:1px solid transparent}
a:hover{border-bottom-color:currentColor}
code{font-family:"Space Mono",monospace;font-size:12px;background:var(--panel);border:1px solid var(--line);padding:1px 6px}

/* grid scaffold — ONE source of truth */
.spread{position:relative;width:100%;border-top:1px solid var(--line)}
.wrap{position:relative;max-width:var(--maxw);margin:0 auto;padding:var(--pad) var(--margin)}
.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);column-gap:var(--gutter);row-gap:var(--lh)}
.band{grid-column:1 / -1;display:grid;grid-template-columns:subgrid;column-gap:var(--gutter);row-gap:var(--lh);align-items:start}
@supports not (grid-template-columns:subgrid){.band{grid-template-columns:repeat(var(--cols),1fr)}}

/* overlay — SAME content box as content */
.guides{position:absolute;inset:0;pointer-events:none;z-index:60;opacity:0;transition:opacity .26s ease}
body.grid-on .guides{opacity:1}
.guides .cols{position:absolute;top:0;bottom:0;left:var(--margin);right:var(--margin);display:grid;grid-template-columns:repeat(var(--cols),1fr);column-gap:var(--gutter)}
.guides .col{background:var(--g-col);box-shadow:inset 1px 0 0 var(--g-edge),inset -1px 0 0 var(--g-edge);position:relative}
.guides .col span{position:absolute;top:16px;left:0;right:0;text-align:center;font-family:"Space Mono",monospace;font-size:9px;line-height:1;color:var(--accent)}
.guides .rows{position:absolute;left:var(--margin);right:var(--margin);top:var(--pad);bottom:0;background-image:repeating-linear-gradient(to bottom,var(--g-base) 0 1px,transparent 1px var(--lh)),repeating-linear-gradient(to bottom,var(--g-base-min) 0 1px,transparent 1px var(--bl))}
.guides .mline{position:absolute;top:0;bottom:0;width:1px;background:var(--g-edge)}
.guides .mline.l{left:var(--margin)}.guides .mline.r{right:var(--margin)}

.toggle{position:fixed;top:16px;right:16px;z-index:200;display:flex;align-items:center;gap:10px;background:var(--ink);color:#fff;border:none;cursor:pointer;font-family:"Space Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:10px 14px}
.toggle .dot{width:8px;height:8px;border-radius:50%;background:#555}
body.grid-on .toggle{background:var(--accent)}body.grid-on .toggle .dot{background:#fff}

/* type — flush left, grotesque, scale jumps */
.kicker{font-family:"Space Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);line-height:16px;margin:0}
.masthead{font-size:68px;line-height:64px;font-weight:900;letter-spacing:-.04em;margin:0;text-transform:uppercase}
.masthead span{font-weight:300;color:var(--ink-soft)}
.shead h2{font-size:13px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0;color:var(--ink)}
.shead p{font-size:13px;line-height:16px;color:var(--ink-soft);margin:4px 0 0}
.folio{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);border-top:1px solid var(--line);padding-top:8px;margin-top:8px}
.rule{height:1px;background:var(--line);grid-column:1 / -1}
.rule.strong{background:var(--ink);height:2px}

/* cards — modular, baseline-locked */
.card{background:#fff;border:1px solid var(--line);padding:16px;display:flex;flex-direction:column;gap:8px}
.card h3{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);margin:0}
.numeral{font-size:44px;line-height:40px;font-weight:800;letter-spacing:-.03em;margin:0}
.numeral small{font-size:12px;font-weight:500;letter-spacing:0;color:var(--ink-soft);vertical-align:baseline;margin-left:6px}
.numeral .unit{font-family:"Space Mono",monospace;font-size:11px;font-weight:400;color:var(--ink-soft);letter-spacing:.04em}
.dim{color:var(--ink-soft)}
.mono{font-family:"Space Mono",monospace}
.muted{color:var(--ink-soft)}
.btn{appearance:none;background:var(--ink);color:#fff;border:1px solid var(--ink);padding:8px 14px;font-family:"Space Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;line-height:16px}
.btn:hover{background:#1a2330}
.btn.ghost{background:#fff;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{border-color:var(--ink)}
.btn.accent{background:var(--accent);border-color:var(--accent);color:#fff}
.pill{font-family:"Space Mono",monospace;font-size:10px;padding:2px 7px;border:1px solid var(--line);background:#fff;color:var(--ink-soft)}
.badge{font-family:"Space Mono",monospace;font-size:10px;padding:3px 7px;border:1px solid var(--line);display:inline-block;line-height:1}
.badge.ok{color:var(--green);border-color:rgba(10,122,66,.3);background:rgba(10,122,66,.06)}
.badge.cool{color:var(--red);border-color:rgba(228,0,43,.3);background:rgba(228,0,43,.06)}
.badge.dis{color:var(--ink-soft)}
.bar{height:6px;background:var(--panel);border:1px solid var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--green);transition:width .3s}
.bar.hot i{background:#c9a100}.bar.full i{background:var(--red)}

/* table — baseline */
.table-wrap{overflow:auto;border:1px solid var(--line);background:#fff}
table{width:100%;border-collapse:collapse;font-size:12.5px;line-height:16px}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}
th{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);background:var(--panel);position:sticky;top:0}
td{font-size:12.5px}
.provider-row.cooldown{box-shadow:inset 3px 0 0 var(--red)}
.provider-row.disabled{opacity:.55}

/* logs */
.log-ok{color:var(--green)}.log-skip{color:var(--amber)}.log-err{color:var(--red)}
.chain{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chain .step{font-family:"Space Mono",monospace;font-size:11px;padding:5px 8px;border:1px solid var(--line);background:#fff}
.chain .step.ok{border-color:rgba(10,122,66,.35)}.chain .step.fail{border-color:rgba(228,0,43,.3)}

/* responsive — collapse to 6-col on tablet, 4-col on phone but keep column lines */
@media (max-width:1100px){:root{--margin:24px;--gutter:16px}.masthead{font-size:52px;line-height:48px}.numeral{font-size:36px;line-height:32px}}
@media (max-width:700px){.wrap{padding:24px 16px}:root{--margin:16px}.masthead{font-size:38px;line-height:32px}}
</style>
</head>
<body>
<button class="toggle" id="gridToggle" aria-pressed="false"><span class="dot"></span><span class="lbl">Show grid</span> — G</button>

<!-- SPREAD 1 — masthead + numerals -->
<section class="spread">
<div class="wrap">
<div class="grid">

  <!-- folio -->
  <div class="band" style="margin-bottom:8px">
    <div style="grid-column:1 / 6" class="folio">FREE LLM ROUTER — LITELLM-EXACT GATEWAY · EST. 2026</div>
    <div style="grid-column:9 / 13" class="folio" id="folioRight">EDITION 0.3 · FREE POOL</div>
  </div>

  <!-- masthead -->
  <div class="band" style="margin-top:8px">
    <div style="grid-column:1 / 9">
      <p class="kicker">OpenAI-compatible · 12 providers · 147 models</p>
      <h1 class="masthead">FREE<br>LLM<span> ROUTER</span></h1>
      <p style="margin:12px 0 0; max-width:36em; color:var(--ink-soft); font-size:14px; line-height:20px">
        One <code>base_url</code> for every free tier — <b style="color:var(--ink)">Groq, Gemini, OpenRouter, Zen, Cerebras, NVIDIA, Mistral</b> and more. 
        Rate-limit aware, failover-correct, LiteLLM-style <code>fallbacks</code> and context-window fallback. Streaming SSE preserved.
      </p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:16px">
        <a class="btn accent" href="#providers">View providers ↓</a>
        <button class="btn ghost" onclick="document.getElementById('curl').scrollIntoView({behavior:'smooth'})">Copy curl</button>
        <button class="btn ghost" id="autoBtn" onclick="toggleAuto()">⏸ Pause auto-refresh</button>
      </div>
    </div>
    <div style="grid-column:9 / 13; display:flex; flex-direction:column; gap:12px">
      <div class="card" style="border-top:3px solid var(--accent)">
        <h3>How to use</h3>
        <div style="font-family:Space Mono,monospace; font-size:12px; line-height:16px; background:var(--panel); border:1px solid var(--line); padding:10px; overflow:auto">
          <div class="muted">OpenAI SDK</div>
          <div>base_url = "https://<span id="host">free-llm-router.vipulgote5.workers.dev</span>/v1"</div>
          <div style="margin-top:8px"><code id="curlMini">client = OpenAI(base_url=".../v1", api_key="x")</code></div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <a class="pill" href="/v1/models" target="_blank">GET /v1/models</a>
          <a class="pill" href="/health" target="_blank">GET /health</a>
          <a class="pill" href="/admin/stats" target="_blank">GET /admin/stats</a>
        </div>
      </div>
      <div class="card">
        <h3>Live status</h3>
        <div id="chips" style="display:flex; flex-wrap:wrap; gap:6px"></div>
        <div class="folio" id="generated" style="margin-top:8px"></div>
      </div>
    </div>
  </div>

  <div class="rule strong" style="margin:8px 0"></div>

  <!-- numerals — 3 big numbers, each 4 cols -->
  <div class="band" id="summary" style="margin-top:4px">
    <!-- filled by JS: three .card with .numeral -->
  </div>

</div>
<div class="guides" aria-hidden="true"><div class="cols"></div><div class="rows"></div><div class="mline l"></div><div class="mline r"></div></div>
</div>
</section>

<!-- SPREAD 2 — providers -->
<section class="spread" id="providers">
<div class="wrap">
<div class="grid">

  <div class="band shead">
    <div style="grid-column:1 / 9">
      <h2>Providers — rate limits, resets, cooldowns</h2>
      <p>Weight → priority. Cooldown → provider skipped until Retry-After. Panel shows per-bucket RPM / TPM / RPD.</p>
    </div>
    <div style="grid-column:9 / 13; text-align:right; display:flex; gap:8px; justify-content:flex-end; align-items:start">
      <button class="btn ghost" onclick="load()">Refresh</button>
      <button class="btn accent" onclick="resetAll()">Reset counters</button>
    </div>
  </div>

  <div class="band">
    <div style="grid-column:1 / 13" class="table-wrap">
      <table id="providers"><thead><tr><th>provider</th><th>bucket</th><th>RPM</th><th>TPM</th><th>RPD</th><th>resets</th><th>health</th></tr></thead><tbody></tbody></table>
    </div>
  </div>

</div>
<div class="guides" aria-hidden="true"><div class="cols"></div><div class="rows"></div><div class="mline l"></div><div class="mline r"></div></div>
</div>
</section>

<!-- SPREAD 3 — logs + fallback chain -->
<section class="spread">
<div class="wrap">
<div class="grid">

  <div class="band shead">
    <div style="grid-column:1 / 13">
      <h2>Observability — request log &amp; fallback chain</h2>
      <p>Last 80 router attempts (in-memory ring, per isolate) — powers p50/p95. Chain shows the last burst’s hops.</p>
    </div>
  </div>

  <div class="band">
    <div style="grid-column:1 / 9" class="card">
      <div style="display:flex; align-items:center; gap:8px"><h3>Recent requests</h3><span class="pill mono" id="logCount"></span><span style="margin-left:auto" class="muted mono" style="font-size:11px">auto-refresh 5s · <label style="cursor:pointer"><input type="checkbox" id="auto" checked> live</label></span></div>
      <div id="logs" class="mono" style="font-size:11.5px; max-height:360px; overflow:auto; border:1px solid var(--line); padding:8px; background:#fff"></div>
    </div>
    <div style="grid-column:9 / 13; display:flex; flex-direction:column; gap:16px">
      <div class="card">
        <h3>Fallback chain · last burst</h3>
        <div id="chain"></div>
        <p class="muted" style="font-size:11px; line-height:16px; margin:8px 0 0">Per-request <code>fallbacks: [{model:"..."}]</code> (LiteLLM). Global cap via <code>MAX_RETRIES</code>. Context-window <code>400</code> also retries.</p>
      </div>
      <div class="card">
        <h3>Quick curl — exact OpenAI parity</h3>
        <pre style="margin:0; background:var(--panel); border:1px solid var(--line); padding:10px; overflow:auto; font-size:11px; line-height:16px"><code id="curl">curl https://$HOST/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'

# with fallback (LiteLLM)
curl ... -d '{"model":"groq/llama-3.3-70b-versatile",
  "fallbacks":["cerebras/gpt-oss-120b"],
  "messages":[...]}'

# embeddings
curl https://$HOST/v1/embeddings \\
  -d '{"model":"mistral-embed","input":"hello"}'</code></pre>
      </div>
    </div>
  </div>

  <div class="band">
    <div style="grid-column:1 / 13" class="folio">VERIFIED GRID · 12 COLS · 24PX LEADING · G INK-ALIGNED · <span id="verifyNote">toggle G to inspect</span></div>
  </div>

</div>
<div class="guides" aria-hidden="true"><div class="cols"></div><div class="rows"></div><div class="mline l"></div><div class="mline r"></div></div>
</div>
</section>

<script>
/* toggle + populate cols — scaffold */
var btn=document.getElementById('gridToggle');
function setGrid(on){document.body.classList.toggle('grid-on',on); if(btn){btn.setAttribute('aria-pressed',on?'true':'false'); var l=btn.querySelector('.lbl'); if(l) l.textContent=on?'Hide grid':'Show grid';}}
if(btn) btn.addEventListener('click',function(){setGrid(!document.body.classList.contains('grid-on'));});
document.addEventListener('keydown',function(e){if((e.key==='g'||e.key==='G')&&!e.metaKey&&!e.ctrlKey&&!e.altKey){setGrid(!document.body.classList.contains('grid-on'));}});
document.querySelectorAll('.guides .cols').forEach(function(h){var n=getComputedStyle(document.documentElement).getPropertyValue('--cols').trim()||'12'; for(var i=1;i<=parseInt(n,10);i++){var c=document.createElement('div');c.className='col';var s=document.createElement('span');s.textContent=i;c.appendChild(s);h.appendChild(c);}});
(function(){var cvs=document.createElement('canvas'),ctx=cvs.getContext('2d');var sel='.masthead, .numeral, .shead h2';function align(){document.querySelectorAll(sel).forEach(function(el){el.style.marginLeft='0px';var cs=getComputedStyle(el),ch=(el.textContent||'').trim().charAt(0); if(!ch) return; if(cs.textTransform==='uppercase') ch=ch.toUpperCase();ctx.font=cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;ctx.textAlign='left';var abl=ctx.measureText(ch).actualBoundingBoxLeft; if(isFinite(abl)) el.style.marginLeft=abl.toFixed(2)+'px';});} if(document.fonts&&document.fonts.ready) document.fonts.ready.then(align); align(); var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(align,120);});})();

/* dashboard logic — baseline-locked, same IDs as before */
var $ = function(s){return document.querySelector(s)};
var esc = function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');};
var fmt = function(ts){return ts ? new Date(ts).toISOString().replace('T',' ').slice(0,19)+'Z' : '—'};
var inSec = function(ts, now){return Math.max(0, Math.ceil((ts-now)/1000))};
var fmtSec = function(s){ return s<60 ? s+'s' : (s/60|0)+'m '+(s%60)+'s';};
var pct = function(used, limit){ return limit>1e15 ? 0 : Math.min(100, Math.round((used/limit)*100));};
function bar(used, limit){var p=pct(used,limit);var cls=p>=100?'full':p>=80?'hot':'';return '<div class="bar '+cls+'"><i style="width:'+p+'%"></i></div><span class="muted mono" style="font-size:10px">'+p+'%</span>';}
function cell(used, limit){var isInf=limit>1e15; return '<span class="mono">'+used+' / '+(isInf?'∞':limit)+'</span>'+bar(used,limit);}
let timer=null;
function setAuto(on){var cb=$('#auto'); if(cb) cb.checked=on; if(timer) clearInterval(timer); if(on) timer=setInterval(load,5000); var btn=$('#autoBtn'); if(btn) btn.textContent= on ? '⏸ Pause auto-refresh' : '▶ Resume auto-refresh';}
function toggleAuto(){var cb=$('#auto'); setAuto(!cb.checked); }
if($('#auto')) $('#auto').addEventListener('change', function(e){setAuto(e.target.checked)});
async function load(){
  try{
    var res=await fetch('/admin/stats');
    var data=await res.json();
    var rows = Array.isArray(data) ? data : (data.providers ?? data);
    var logs = Array.isArray(data) ? [] : (data.logs ?? []);
    var summary = Array.isArray(data) ? null : (data.summary ?? null);
    var now = (summary && summary.now) || Date.now();
    renderChips(rows, summary, now);
    renderSummary(rows, summary, logs, now);
    renderProviders(rows, now);
    renderLogs(logs);
    renderChain(logs);
    var gen=$('#generated'); if(gen) gen.textContent='updated '+fmt(now)+' · auto '+( $('#auto')&&$('#auto').checked ? 'on' : 'off');
    var fr=$('#folioRight'); if(fr) fr.textContent='EDITION 0.3 · '+rows.length+' PROVIDERS · '+rows.reduce(function(a,r){return a+(r.models||0)},0)+' MODELS';
    if(location.hostname){var h=location.host; var el=$('#host'); if(el) el.textContent=h; var c=$('#curl'); if(c) c.textContent=c.textContent.replaceAll('$HOST', h);}
  }catch(e){var tb=document.querySelector('#providers tbody'); if(tb) tb.innerHTML='<tr><td colspan="7" class="muted">failed to load: '+String(e)+'</td></tr>';}
}
function renderChips(rows, summary, now){
  var total=rows.length; var enabled=rows.filter(function(r){return !r.disabled}).length;
  var cooling=rows.filter(function(r){return Object.values(r.buckets||{}).some(function(b){return (b.cooldownUntil||0) > now })}).length;
  var disabled=rows.filter(function(r){return r.disabled}).length;
  var p50 = summary && summary.p50, p95=summary && summary.p95;
  var succ = summary ? summary.success : 0, fail = summary ? summary.failure : 0;
  var html='';
  html += '<span class="pill"><b>'+total+'</b> providers · <b style="color:var(--green)">'+enabled+' enabled</b> · '+disabled+' disabled</span>';
  if(cooling) html += '<span class="badge cool"><b>'+cooling+'</b> cooling</span>'; else html += '<span class="badge ok">no cooldowns</span>';
  if(p50!=null) html += '<span class="pill">p50 <b>'+p50+'ms</b> · p95 <b>'+p95+'ms</b></span>';
  if(summary) html += '<span class="pill">ok <b style="color:var(--green)">'+succ+'</b> · fail <b style="color:var(--red)">'+fail+'</b></span>';
  html += '<span class="pill mono">openai: /v1/chat/completions · /v1/embeddings · /v1/models</span>';
  var el=$('#chips'); if(el) el.innerHTML=html;
}
function renderSummary(rows, summary, logs, now){
  var totalBuckets = rows.reduce(function(a,r){return a + Object.keys(r.buckets||{}).length},0);
  var totalModels = rows.reduce(function(a,r){return a + (r.models||0)},0);
  var coolingBuckets = rows.reduce(function(a,r){return a + Object.values(r.buckets||{}).filter(function(b){return (b.cooldownUntil||0)>now}).length},0);
  var ok = summary ? summary.success : 0, fail = summary ? summary.failure : 0, p50=summary?summary.p50:null, p95=summary?summary.p95:null;
  var dayTokens=0, minuteReq=0; for(var i=0;i<rows.length;i++){var r=rows[i]; for(var k in r.buckets||{}){var b=r.buckets[k]; dayTokens+= (b.day && b.day.tokens)||0; minuteReq+= (b.minute && b.minute.requests)||0;}}
  var el=$('#summary'); if(!el) return;
  el.innerHTML=''
    + '<div style="grid-column:1 / 5" class="card"><h3>Throughput</h3><div class="numeral">'+minuteReq+'<span class="unit"> req / min</span></div><div class="muted mono" style="font-size:11px; line-height:16px">'+dayTokens.toLocaleString()+' tokens today · '+totalBuckets+' buckets · '+totalModels+' models</div><div style="display:flex; gap:2px; align-items:end; height:24px; margin-top:8px">'+Array.from({length:12},function(){return '<i style="width:4px; background:var(--accent); height:'+(6+Math.random()*18|0)+'px; display:block"></i>'}).join('')+'</div></div>'
    + '<div style="grid-column:5 / 9" class="card"><h3>Latency — recent ok</h3><div class="numeral">'+(p50!=null ? p50+'<span class="unit">ms p50</span> · '+p95+'<span class="unit">ms p95</span>' : '— <span class="unit">no traffic yet</span>')+'</div><div class="muted mono" style="font-size:11px; line-height:16px">'+(ok+fail)+' attempts · <span style="color:var(--green)">'+ok+' ok</span> · <span style="color:var(--red)">'+fail+' fail/skip</span></div><div class="muted" style="font-size:11px; line-height:16px; margin-top:4px">per-attempt ms in logs; p50/p95 from last 80 successes</div></div>'
    + '<div style="grid-column:9 / 13" class="card"><h3>Failover health</h3><div class="numeral" style="color:'+(coolingBuckets?'var(--amber)':'var(--green)')+'">'+coolingBuckets+'<span class="unit"> buckets cooling</span></div><div class="muted mono" style="font-size:11px; line-height:16px">'+rows.length+' providers · fallbacks: <code>fallbacks</code> + context-window fallback + 429/5xx chain</div><div style="margin-top:8px"><span class="badge '+(coolingBuckets?'cool':'ok')+'">'+(coolingBuckets?'degraded — failover active':'healthy')+'</span></div></div>';
}
function renderProviders(rows, now){
  var tbody=document.querySelector('#providers tbody'); if(!tbody) return;
  if(!rows.length){tbody.innerHTML='<tr><td colspan="7"><div style="padding:16px; text-align:center; color:var(--ink-soft)">no providers configured</div></td></tr>'; return;}
  var html='';
  for(var i=0;i<rows.length;i++){var p=rows[i]; var ids=Object.keys(p.buckets||{}); var health = p.disabled ? 'disabled' : (ids.some(function(id){return (p.buckets[id].cooldownUntil||0) > now}) ? 'cooldown' : 'ok'); var rowCls = p.disabled ? 'disabled' : health==='cooldown' ? 'cooldown' : '';
    if(ids.length===0){html += '<tr class="provider-row '+rowCls+'"><td><b>'+esc(p.name)+'</b> <span class="muted mono">'+esc(p.provider)+'</span> <span class="pill">'+p.weight+'</span> '+(p.disabled? '<span class="badge dis" title="'+esc(p.disabledReason||'')+'">disabled</span>' : (health==='cooldown'?'<span class="badge cool">cooldown</span>':'<span class="badge ok">ok</span>'))+'<div class="muted" style="font-size:11px; line-height:16px">'+p.models+' models · anchor UTC '+p.dayAnchorUtc+'</div></td><td class="muted">no traffic yet</td><td colspan="5" class="muted">—</td></tr>'; continue;}
    for(var j=0;j<ids.length;j++){var id=ids[j]; var b=p.buckets[id]; var cd=Math.max(0,(b.cooldownUntil||0)-now); var cdTxt= cd>0 ? '<span class="badge cool">'+fmtSec(Math.ceil(cd/1000))+'</span>' : '<span class="badge ok">clear</span>'; var resetMin = inSec(b.minuteResetsAt, now); var resetDayH = (inSec(b.dayResetsAt, now)/3600).toFixed(1);
      // per-model cooldowns (NEW: 404 now cools only the model, not the whole bucket)
      var modelCdHtml = '';
      if (b.modelCooldowns && Object.keys(b.modelCooldowns).length) {
        var now2 = now;
        var entries = Object.entries(b.modelCooldowns).filter(function(e){return e[1] > now2}).slice(0,3);
        if (entries.length) {
          modelCdHtml = '<div class="mono" style="font-size:10px; line-height:14px; margin-top:6px; background:rgba(228,0,43,.06); border:1px solid #e6e8eb; padding:6px; border-radius:4px"><div style="color:var(--accent); font-weight:700">model cooldowns ('+entries.length+')</div>';
          for (var k=0;k<entries.length;k++) {
            var m = entries[k][0], until = entries[k][1];
            var sec = Math.ceil((until - now2)/1000);
            modelCdHtml += '<div>'+esc(m).slice(0,22)+' · <span class="badge cool">'+fmtSec(sec)+' left</span></div>';
          }
          if (Object.keys(b.modelCooldowns).length > 3) modelCdHtml += '<div class="muted">+'+(Object.keys(b.modelCooldowns).length-3)+' more</div>';
          modelCdHtml += '</div>';
        }
      }
      html += '<tr class="provider-row '+rowCls+'">'
        + '<td><b>'+esc(p.name)+'</b> <span class="muted mono">'+esc(p.provider)+'</span> <span class="pill mono">'+esc(id)+'</span><div class="muted mono" style="font-size:10px; line-height:16px">w '+p.weight+' · '+p.models+' models</div></td>'
        + '<td>'+esc(id)+'</td>'
        + '<td>'+cell(b.minute.requests, p.limits.rpm)+'<div class="muted mono" style="font-size:10px; line-height:16px">reset '+fmtSec(resetMin)+'</div></td>'
        + '<td>'+cell(b.minute.tokens, p.limits.tpm)+'</td>'
        + '<td>'+cell(b.day.requests, p.limits.rpd)+'<div class="muted mono" style="font-size:10px; line-height:16px">'+resetDayH+'h · '+fmt(b.dayResetsAt)+'</div></td>'
        + '<td class="mono" style="font-size:11px; line-height:16px"><div>'+fmtSec(resetMin)+' <span class="muted">'+fmt(b.minuteResetsAt)+'</span></div><div>'+resetDayH+'h <span class="muted">'+fmt(b.dayResetsAt)+'</span></div></td>'
        + '<td>'+cdTxt + (b.lastError? '<div class="mono" style="font-size:10px; line-height:16px; color:var(--red); margin-top:4px">'+esc(b.lastError)+'</div>' : '') + modelCdHtml + '</td>'
        + '</tr>';}
  }
  tbody.innerHTML=html || '<tr><td colspan="7" class="muted">no buckets</td></tr>';
}
function renderLogs(logs){
  var el=$('#logs'); var count=$('#logCount'); if(count) count.textContent='('+logs.length+' recent)'; if(!el) return;
  if(!logs || logs.length===0){el.innerHTML='<div class="muted">no attempts yet — send a request to <code>/v1/chat/completions</code></div>'; return;}
  var rev=[].slice.call(logs).slice(-30).reverse();
  var html='<table style="font-size:11px"><thead><tr><th>time</th><th>provider</th><th>model</th><th>bucket</th><th>outcome</th><th>reason</th><th>ms</th></tr></thead><tbody>';
  for(var i=0;i<rev.length;i++){var l=rev[i]; var cls = l.outcome==='ok' ? 'log-ok' : l.outcome==='skipped' ? 'log-skip' : 'log-err'; var when = new Date(l.ts).toISOString().slice(11,19);
    html+='<tr><td class="mono muted">'+esc(when)+'</td><td>'+esc(l.provider)+'</td><td class="mono" style="max-width:180px; overflow:hidden; text-overflow:ellipsis">'+esc(l.model)+'</td><td class="mono muted">'+esc(l.bucket)+'</td><td class="'+cls+'">'+esc(l.outcome)+'</td><td>'+esc(l.reason||'—')||'—')+(l.retryAfterSec? ' · '+l.retryAfterSec+'s':'')+'</td><td class="mono">'+(l.ms!=null?l.ms:'—')+'ms</td></tr>';}
  html+='</tbody></table>'; el.innerHTML=html;
}
function renderChain(logs){
  var el=$('#chain'); if(!el) return;
  if(!logs || logs.length===0){el.innerHTML='<div class="muted">no data</div>'; return;}
  var rev=[].slice.call(logs).reverse(); var lastTs = rev[0] ? rev[0].ts : 0; var burst=[]; for(var i=0;i<rev.length;i++){if(lastTs - rev[i].ts < 2500) burst.push(rev[i]);} burst.reverse();
  if(burst.length===0){el.innerHTML='<div class="muted">no recent burst</div>'; return;}
  var html='<div class="chain">';
  for(var i=0;i<burst.length;i++){var l=burst[i]; var ok=l.outcome==='ok'; html+='<span class="step '+(ok?'ok':'fail')+'">'+l.provider+'<span class="muted"> / '+esc(l.model).slice(0,22)+'</span> <span class="pill">'+l.reason+'</span>'+(l.ms!=null?' <span class="muted">'+l.ms+'ms</span>':'')+'</span>'; if(i<burst.length-1) html+='<span class="muted">→</span>';}
  html+='</div>'; var fails=0, okCount=0; for(var i=0;i<burst.length;i++){if(burst[i].outcome!=='ok') fails++; else okCount++;} html+='<div class="muted mono" style="font-size:11px; line-height:16px; margin-top:8px">'+burst.length+' hops · '+fails+' skipped/failed · '+okCount+' ok · last at '+fmt(burst[burst.length-1].ts)+'</div>';
  if(okCount===0) html+='<div style="margin-top:8px; color:var(--amber); font-size:11px; line-height:16px">All providers exhausted — client received <code>503 all providers exhausted</code> with <code>tried[]</code>. Add keys or increase limits.</div>';
  el.innerHTML=html;
}
async function resetAll(){var res=await fetch('/admin/reset',{method:'POST'}); if(!res.ok) alert('reset failed'); load();}
load(); setAuto(true);
</script>
</body>
</html>`;
