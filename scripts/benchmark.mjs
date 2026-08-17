#!/usr/bin/env node
/**
 * Live benchmark harness for the deployed free-llm-router.
 * Zero dependencies — Node 26 fetch + perf_hooks.
 *
 *   node scripts/benchmark.mjs [--base URL] [--iters N] [--conc C]
 *                              [--suite all|health|latency|failover|concurrency|stream]
 *                              [--skip-live] [--json out.json]
 *
 * Results land in specs/verifications/benchmark-results/ and on stdout.
 * Reads provider keys from .dev.vars for direct-vs-router overhead tests.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ config
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (name, dflt) => {
    const i = a.indexOf(name);
    return i !== -1 && a[i + 1] ? a[i + 1] : dflt;
  };
  return {
    base: get('--base', 'https://free-llm-router.vipulgote4.workers.dev'),
    iters: Number(get('--iters', '3')),
    conc: Number(get('--conc', '12')),
    suite: get('--suite', 'all'),
    skipLive: a.includes('--skip-live'),
    json: get('--json', null),
  };
}

function loadDevVars() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, '.dev.vars'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {
    /* no keys */
  }
  return env;
}

const env = loadDevVars();
const args = parseArgs();
const results = { meta: { started: new Date().toISOString(), base: args.base }, suites: {} };

// ----------------------------------------------------------------- helpers
async function timed(fn) {
  const t0 = performance.now();
  const out = await fn();
  return { ...out, ms: Math.round(performance.now() - t0) };
}

async function chat(body, headers = {}) {
  const res = await fetch(`${args.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  return { status: res.status, provider: res.headers.get('x-router-provider'), model: res.headers.get('x-router-model'), text };
}

async function adminStats() {
  const res = await fetch(`${args.base}/admin/stats`);
  return res.ok ? res.json() : null;
}

async function adminReset() {
  await fetch(`${args.base}/admin/reset`, { method: 'POST' });
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarizeLatency(name, samples) {
  if (samples.length === 0) {
    console.log(`  ${name.padEnd(30)} n=0 (no 200 responses — provider 429/5xx this run)`);
    return { n: 0, avg: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = pct(sorted, 50);
  const p95 = pct(sorted, 95);
  const p99 = pct(sorted, 99);
  const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
  console.log(`  ${name.padEnd(30)} n=${samples.length} avg=${avg}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  return { n: samples.length, avg, p50, p95, p99 };
}

function passThreshold(name, cond, detail) {
  const verdict = cond ? 'PASS' : 'FAIL';
  console.log(`  ${verdict}  ${name}${detail ? ` — ${detail}` : ''}`);
  return { name, verdict, detail };
}

// ----------------------------------------------------------------- suites
async function suiteHealth() {
  console.log('\n=== health ===');
  const res = await fetch(`${args.base}/health`);
  const j = await res.json();
  const enabled = j.providers?.filter((p) => p.enabled).map((p) => p.id) ?? [];
  const stats = await adminStats();
  console.log(`  providers enabled: ${enabled.length} (${enabled.join(', ')})`);
  console.log(`  admin stats: ${stats ? 'reachable, ' + stats.length + ' providers tracked' : 'UNREACHABLE'}`);
  results.suites.health = {
    enabled,
    statsReachable: !!stats,
    checks: [passThreshold('all expected providers enabled', enabled.length >= 8, `${enabled.length} enabled`), passThreshold('admin stats reachable', !!stats)],
  };
}

async function suiteLatency() {
  console.log('\n=== latency (per-provider forced, single-shot) ===');
  const targets = [
    ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    ['groq', 'llama-3.3-70b-versatile'],
    ['gemini', 'gemini-2.5-flash'],
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'],
    ['nvidia', 'nvidia/nemotron-3-super-120b-a12b'],
    ['mistral', 'mistral-small-latest'],
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct'],
    ['zen', 'deepseek-v4-flash-free'],
  ];
  const out = {};
  for (const [provider, model] of targets) {
    const samples = [];
    let lastStatus = null;
    for (let i = 0; i < args.iters; i++) {
      const r = await timed(() => chat({ model: `${provider}/${model}`, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }));
      lastStatus = r.status;
      if (r.status === 200) samples.push(r.ms);
    }
    out[provider] = summarizeLatency(provider, samples);
    out[provider].lastStatus = lastStatus;
  }

  // router overhead: direct provider call vs through-router (groq + gemini)
  console.log('\n  router overhead (direct vs through-router, same provider):');
  const overhead = {};
  const direct = {
    groq: { url: 'https://api.groq.com/openai/v1/chat/completions', auth: ['authorization', `Bearer ${env.GROQ_API_KEY}`] },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', auth: ['authorization', `Bearer ${env.GEMINI_API_KEY}`] },
  };
  for (const [provider, cfg] of Object.entries(direct)) {
    if (!env[`${provider.toUpperCase()}_API_KEY`]) continue;
    const model = provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gemini-2.5-flash';
    const directMs = [];
    for (let i = 0; i < args.iters; i++) {
      const t0 = performance.now();
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [cfg.auth[0]]: cfg.auth[1] },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
        signal: AbortSignal.timeout(120000),
      });
      await res.text();
      directMs.push(Math.round(performance.now() - t0));
    }
    const routerMs = out[provider]?.avg ?? null;
    if (routerMs !== null) {
      const delta = routerMs - Math.round(directMs.reduce((s, v) => s + v, 0) / directMs.length);
      overhead[provider] = delta;
      console.log(`    ${provider}: direct avg ${Math.round(directMs.reduce((s, v) => s + v, 0) / directMs.length)}ms, via router ${routerMs}ms, overhead ${delta > 0 ? '+' : ''}${delta}ms`);
    }
  }
  const worstOverhead = Math.max(0, ...Object.values(overhead).filter((v) => Number.isFinite(v)));
  results.suites.latency = { out, overhead, checks: [passThreshold('router overhead p95 < 1000ms', worstOverhead < 1000, `worst avg overhead ${worstOverhead}ms`)] };
}

async function suiteFailover() {
  console.log('\n=== failover ===');
  const checks = [];
  const observed = [];

  // 1) cooldown skip: force zen (known-cooling from CF egress) → expect quick 503 with cooldown reason
  const zen = await timed(() => chat({ model: 'zen/deepseek-v4-flash-free', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }));
  let parsed = null;
  try {
    parsed = JSON.parse(zen.text);
  } catch {
    /* non-json */
  }
  const reason = parsed?.error?.tried?.[0]?.reason ?? 'unknown';
  observed.push({ case: 'zen-forced-while-cooling', status: zen.status, reason, ms: zen.ms });
  console.log(`  zen forced while cooling → ${zen.status} (${reason}, ${zen.ms}ms)`);
  checks.push(passThreshold('cooldown skip is fast', zen.ms < 5000 && zen.status === 503, `${zen.ms}ms`));
  checks.push(passThreshold('cooldown reason reported', reason === 'cooldown' || reason === 'rate_limited' || reason === 'limit', reason));

  // 2) chain failover on 402 + rpm-exhaustion via 'gemma-4' alias
  //    chain: cerebras(85, 402→cool) → gemini(75) → openrouter(70) → nvidia(60)
  console.log('\n  gemma-4 alias chain (cerebras 402 expected, then gemini):');
  const chain = [];
  for (let i = 1; i <= 3; i++) {
    const r = await timed(() => chat({ model: 'gemma-4', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }));
    chain.push({ attempt: i, status: r.status, provider: r.provider, ms: r.ms });
    console.log(`    #${i} → ${r.status} ${r.provider ?? 'none'} (${r.ms}ms)`);
  }
  observed.push({ case: 'gemma-4 alias chain', chain });

  // 3) state tracking: stats must reflect cooldowns/counters for the buckets hit above
  const stats = await adminStats();
  const zenBucket = stats?.find((p) => p.provider === 'zen')?.buckets?.anonymous;
  const tracked = zenBucket && (zenBucket.cooldownUntil > Date.now() || zenBucket.lastError);
  console.log(`  zen cooldown tracked in DO: ${tracked ? `yes (${zenBucket?.lastError ?? 'cooldown'})` : 'no'}`);
  checks.push(passThreshold('cooldown state persisted in DO', !!tracked));
  observed.push({ case: 'zen cooldown tracked', tracked });

  results.suites.failover = { observed, checks };
}

async function suiteConcurrency() {
  console.log(`\n=== concurrency (${args.conc} parallel, auto model) ===`);
  const t0 = performance.now();
  const jobs = Array.from({ length: args.conc }, () => timed(() => chat({ model: 'auto', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 })));
  const rs = await Promise.all(jobs);
  const total = Math.round(performance.now() - t0);
  const ok = rs.filter((r) => r.status === 200);
  const errors = rs.filter((r) => r.status !== 200);
  const lat = rs.map((r) => r.ms).sort((a, b) => a - b);
  const dist = {};
  for (const r of rs) dist[r.provider ?? 'none'] = (dist[r.provider ?? 'none'] ?? 0) + 1;
  console.log(`  ${args.conc} requests in ${total}ms → ${(args.conc / (total / 1000)).toFixed(1)} req/s`);
  console.log(`  ok=${ok.length} errors=${errors.length}  avg=${Math.round(lat.reduce((s, v) => s + v, 0) / lat.length)}ms  p95=${pct(lat, 95)}ms`);
  console.log(`  provider distribution: ${JSON.stringify(dist)}`);
  const errRate = errors.length / rs.length;
  results.suites.concurrency = {
    n: args.conc,
    totalMs: total,
    reqPerSec: Number((args.conc / (total / 1000)).toFixed(1)),
    ok: ok.length,
    errors: errors.length,
    p95: pct(lat, 95),
    distribution: dist,
    checks: [
      passThreshold('client-visible 5xx < 5%', errRate < 0.05, `${(errRate * 100).toFixed(0)}% errors`),
      passThreshold('no hung requests', lat.every((v) => v < 60000), `max ${lat[lat.length - 1]}ms`),
    ],
  };
}

async function suiteStream() {
  console.log('\n=== streaming (auto + groq forced) ===');
  const out = {};
  for (const spec of [
    ['auto', { model: 'auto', stream: true }],
    ['groq', { model: 'groq/llama-3.3-70b-versatile', stream: true }],
  ]) {
    const t0 = performance.now();
    const res = await fetch(`${args.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spec[1], messages: [{ role: 'user', content: 'Count from 1 to 5' }], max_tokens: 60 }),
      signal: AbortSignal.timeout(120000),
    });
    let ttft = null;
    let done = false;
    let chunks = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done: rd, value } = await reader.read();
      if (rd) break;
      buf += decoder.decode(value, { stream: true });
      chunks++;
      if (ttft === null && buf.includes('data:')) ttft = Math.round(performance.now() - t0);
      if (buf.includes('[DONE]')) done = true;
    }
    const total = Math.round(performance.now() - t0);
    // Workers AI serves a single non-stream JSON chunk by design (documented).
    const cloudflareJson = res.headers.get('x-router-provider') === 'cloudflare' && !done && buf.includes('"choices"');
    const streamOk = done || cloudflareJson;
    out[spec[0]] = { status: res.status, ttft, totalMs: total, chunks, done, cloudflareJson, provider: res.headers.get('x-router-provider') };
    console.log(`  ${spec[0].padEnd(8)} status=${res.status} provider=${res.headers.get('x-router-provider')} ttft=${ttft}ms total=${total}ms chunks=${chunks} ${cloudflareJson ? 'json(non-stream design)' : done ? 'done' : 'INCOMPLETE'}`);
  }
  results.suites.stream = {
    out,
    checks: [passThreshold('all streams complete ([DONE] or Workers-AI JSON)', Object.values(out).every((o) => o.status === 200 && (o.done || o.cloudflareJson)))],
  };
}

// ------------------------------------------------------------------- main
(async () => {
  console.log(`free-llm-router benchmark — ${args.base}\nstarted ${results.meta.started}`);
  if (!args.skipLive) {
    await adminReset();
    await suiteHealth();
    await suiteLatency();
    await suiteFailover();
    await suiteConcurrency();
    await suiteStream();
  } else {
    console.log('--skip-live: only offline suites would run (none in this script; see npm run bench:accuracy)');
  }

  // summary
  const allChecks = Object.values(results.suites).flatMap((s) => s.checks ?? []);
  const failed = allChecks.filter((c) => c.verdict === 'FAIL');
  console.log(`\n=== summary: ${allChecks.length - failed.length}/${allChecks.length} checks passed${failed.length ? `, FAILED: ${failed.map((f) => f.name).join('; ')}` : ''} ===`);

  results.summary = { total: allChecks.length, passed: allChecks.length - failed.length, failed: failed.map((f) => f.name) };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = join(root, 'specs/verifications/benchmark-results');
  mkdirSync(dir, { recursive: true });
  const jsonPath = args.json ?? join(dir, `bench-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  const md = join(dir, `bench-${stamp}.md`);
  writeFileSync(md, `# Benchmark ${stamp}\n\n- base: ${args.base}\n- iters: ${args.iters}, concurrency: ${args.conc}\n\n\`\`\`json\n${JSON.stringify(results, null, 2).slice(0, 12000)}\n\`\`\`\n`);
  console.log(`\nreport: ${jsonPath}`);
})().catch((err) => {
  console.error('benchmark crashed:', err);
  process.exit(1);
});
