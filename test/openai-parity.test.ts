/**
 * OpenAI parity + LiteLLM-style fallback tests
 * Covers: /v1/models/:id, /v1/completions, /v1/embeddings, fallbacks param,
 * context_length_exceeded fallback, and raw passthrough.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeChat, routeCompletion, routeEmbedding, getRecentLogs, clearRecentLogs } from '../src/router';

// ---- mock limiter (same as router.integration) ----
interface FakeBucket { min: { req: number; tok: number }; day: { req: number; tok: number }; cooldownUntil: number; }
const limiterState = new Map<string, Map<string, FakeBucket>>();
function fresh(): FakeBucket { return { min: { req: 0, tok: 0 }, day: { req: 0, tok: 0 }, cooldownUntil: 0 }; }
function providerState(id: string): Map<string, FakeBucket> { let s=limiterState.get(id); if(!s){s=new Map(); limiterState.set(id,s);} return s; }
function bucketOf(p: string, id: string): FakeBucket { const s=providerState(p); let b=s.get(id); if(!b){b=fresh(); s.set(id,b);} return b; }
function json(data: unknown, status=200, headers: Record<string,string>={}) { return new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json', ...headers }}); }
async function fakeLimiterFetch(provider: string, init: RequestInit): Promise<Response> {
  const op = JSON.parse(String(init.body)) as Record<string, unknown>;
  const b=bucketOf(provider, String(op.bucket));
  if(op.op==='acquire'){
    const l=op.limits as { rpm:number; rpd:number };
    if(b.cooldownUntil > Date.now()) return json({ ok:false, reason:'cooldown', retryAfter:5 });
    if(b.min.req+1 > l.rpm || b.day.req+1 > l.rpd) return json({ ok:false, reason:'limit', retryAfter:60 });
    b.min.req+=1; b.day.req+=1;
    return json({ ok:true, minuteResetsAt:Date.now()+60000, dayResetsAt:Date.now()+86400000 });
  }
  if(op.op==='cooldown'){ b.cooldownUntil=Date.now()+Number(op.seconds)*1000; return json({ ok:true }); }
  if(op.op==='stats') return json({ buckets:{}, now:Date.now() });
  if(op.op==='reset'){ limiterState.clear(); return json({ ok:true }); }
  return json({ error:'unknown op' },400);
}
function makeEnv(extra: Record<string,unknown>={}): Record<string,unknown>{
  const ns={ idFromName:(name:string)=>({ fetch:(_url:string, init:RequestInit)=> fakeLimiterFetch(name.replace('limiter:',''), init) }), get:(s:unknown)=>s };
  return { LIMITER: ns, AI: { run: async()=>({ response:'cf-answer' }) }, ...extra };
}
function makeRequest(model:string, bodyExtra:Record<string,unknown>={}): Request{
  return new Request('https://router.test/v1/chat/completions',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ model, messages:[{role:'user',content:'hi'}], ...bodyExtra })});
}
function upstreamResponse(content:string, model='x'){ return new Response(JSON.stringify({ id:'x', object:'chat.completion', choices:[{index:0, message:{role:'assistant',content}, finish_reason:'stop'}], usage:{prompt_tokens:5, completion_tokens:5, total_tokens:10} }),{status:200, headers:{'content-type':'application/json'}}); }
function embeddingResponse(){ return new Response(JSON.stringify({ object:'list', data:[{ object:'embedding', embedding:[0.1,0.2,0.3], index:0 }], model:'test', usage:{prompt_tokens:5, total_tokens:5}}),{status:200, headers:{'content-type':'application/json'}}); }
function completionResponse(text='hello'){ return new Response(JSON.stringify({ id:'cmpl-x', object:'text_completion', created:0, model:'x', choices:[{text, index:0, finish_reason:'stop'}], usage:{prompt_tokens:5, completion_tokens:5, total_tokens:10}}),{status:200, headers:{'content-type':'application/json'}}); }

beforeEach(()=>{ limiterState.clear(); clearRecentLogs(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------------

describe('OpenAI parity - models', () => {
  it('routes completions via provider chain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url:string)=>{
      if(String(url).includes('api.groq.com')) return completionResponse('groq completion');
      return new Response('not found',{status:404});
    }));
    const env=makeEnv({GROQ_API_KEY:'g'});
    const req=new Request('https://r.test/v1/completions',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ model:'groq/llama-3.3-70b-versatile', prompt:'Say hi', max_tokens:5 })});
    const body={ model:'groq/llama-3.3-70b-versatile', prompt:'Say hi', max_tokens:5 } as Record<string,unknown>;
    const res=await routeCompletion(req, env as never, body);
    expect(res.status).toBe(200);
    const j=await res.json() as { choices:{text:string}[] };
    expect(j.choices[0]?.text).toBe('groq completion');
    expect(res.headers.get('x-router-provider')).toBe('groq');
  });

  it('routes embeddings via provider chain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url:string)=>{
      if(String(url).includes('api.mistral.ai')) return embeddingResponse();
      return new Response('nope',{status:500});
    }));
    const env=makeEnv({MISTRAL_API_KEY:'m'});
    const req=new Request('https://r.test/v1/embeddings',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ model:'mistral-embed', input:'hello' })});
    const body={ model:'mistral-embed', input:'hello' } as Record<string,unknown>;
    const res=await routeEmbedding(req, env as never, body);
    expect(res.status).toBe(200);
    const j=await res.json() as { data:{embedding:number[]}[] };
    expect(j.data[0]?.embedding).toEqual([0.1,0.2,0.3]);
    expect(res.headers.get('x-router-provider')).toBe('mistral');
  });

  it('preserves unknown body fields (tools, response_format, etc.)', async () => {
    let captured: Record<string,unknown> | null=null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url:string, init:RequestInit)=>{
      captured = JSON.parse(String(init.body));
      return upstreamResponse('ok');
    }));
    const env=makeEnv({GROQ_API_KEY:'g'});
    const req=makeRequest('groq/llama-3.3-70b-versatile', { temperature:0.7, top_p:0.9, response_format:{type:'json_object'}, tools:[{type:'function', function:{name:'get_time'}}], tool_choice:'auto' } as Record<string,unknown>);
    const body={ model:'groq/llama-3.3-70b-versatile', messages:[{role:'user',content:'hi'}], temperature:0.7, top_p:0.9, response_format:{type:'json_object'}, tools:[{type:'function', function:{name:'get_time'}}], tool_choice:'auto' } as Record<string,unknown>;
    const res=await routeChat(req, env as never, body as never);
    expect(res.status).toBe(200);
    expect(captured).toMatchObject({ temperature:0.7, top_p:0.9, response_format:{type:'json_object'} });
    expect((captured as unknown as Record<string, unknown>)?.tools).toEqual([{type:'function', function:{name:'get_time'}}]);
  });

  it('falls back on 429 respecting fallbacks param (LiteLLM style)', async () => {
    const calls:string[]=[];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url:string)=>{
      calls.push(String(url));
      if(String(url).includes('api.groq.com')) return new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429, headers:{'retry-after':'5'}});
      if(String(url).includes('api.cerebras.ai')) return upstreamResponse('cerebras fallback');
      return new Response('not found',{status:404});
    }));
    const env=makeEnv({GROQ_API_KEY:'g', CEREBRAS_API_KEY:'c'});
    const body={ model:'groq/llama-3.3-70b-versatile', messages:[{role:'user',content:'hi'}], fallbacks:['cerebras/gpt-oss-120b'] } as Record<string,unknown>;
    const req=makeRequest('groq/llama-3.3-70b-versatile', { fallbacks:['cerebras/gpt-oss-120b'] } as Record<string,unknown>);
    const res=await routeChat(req, env as never, body as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('cerebras');
    expect(calls.some(c=> c.includes('cerebras'))).toBe(true);
  });

  it('falls back on context_length_exceeded (400) to next provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url:string)=>{
      if(String(url).includes('api.groq.com')) return new Response(JSON.stringify({error:{message:'This model\'s maximum context length is 8192 tokens. context_length_exceeded', type:'invalid_request_error', code:'context_length_exceeded'}}),{status:400, headers:{'content-type':'application/json'}});
      if(String(url).includes('integrate.api.nvidia.com')) return upstreamResponse('nvidia long context ok');
      return new Response('not found',{status:404});
    }));
    const env=makeEnv({GROQ_API_KEY:'g', NVIDIA_API_KEY:'n'});
    const longPrompt='a'.repeat(20000);
    const body={ model:'groq/llama-3.3-70b-versatile', messages:[{role:'user', content: longPrompt }], fallbacks:['nvidia/meta/llama-3.3-70b-instruct'] } as Record<string,unknown>;
    const req=new Request('https://r.test/v1/chat/completions',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    const res=await routeChat(req, env as never, body as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('nvidia');
  });

  it('supports model@provider and provider/model syntax for embeddings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url:string)=>{
      if(String(url).includes('api.mistral.ai')) return embeddingResponse();
      return new Response('nope',{status:500});
    }));
    const env=makeEnv({MISTRAL_API_KEY:'m'});
    const body={ model:'mistral-embed@mistral', input:'hi' } as Record<string,unknown>;
    const req=new Request('https://r.test/v1/embeddings',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    const res=await routeEmbedding(req, env as never, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-router-provider')).toBe('mistral');
  });

  it('routes non-chat 400 without fallbacks as passthrough (not retried)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async ()=> new Response(JSON.stringify({error:{message:'Invalid prompt', type:'invalid_request_error'}}),{status:400, headers:{'content-type':'application/json'}})));
    const env=makeEnv({GROQ_API_KEY:'g'});
    const body={ model:'groq/llama-3.3-70b-versatile', prompt:'' } as Record<string,unknown>;
    const req=new Request('https://r.test/v1/completions',{method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
    const res=await routeCompletion(req, env as never, body);
    // should passthrough the 400 directly rather than 503
    expect(res.status).toBe(400);
  });

  it('exposes recent logs for dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async ()=> upstreamResponse('hi')));
    const env=makeEnv({GROQ_API_KEY:'g'});
    const req=makeRequest('groq/llama-3.3-70b-versatile');
    await routeChat(req, env as never, { model:'groq/llama-3.3-70b-versatile', messages:[{role:'user',content:'hi'}] } as never);
    const logs=getRecentLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length-1]?.provider).toBe('groq');
    expect(logs[logs.length-1]?.outcome).toBe('ok');
  });
});

describe('OpenAI parity - config model registry', () => {
  it('models list contains entries with required OpenAI fields', async () => {
    const { getProviders } = await import('../src/config');
    const ps=getProviders({GROQ_API_KEY:'g', MISTRAL_API_KEY:'m'});
    const all = ps.flatMap(p=> p.models.map(m=> ({id:m.id, owned_by:p.id, object:'model'})));
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toHaveProperty('id');
    expect(all[0]).toHaveProperty('owned_by');
    expect(all[0]).toHaveProperty('object');
  });

  it('unknown model is not in known list and would 404', async () => {
    const { getProviders, isKnownModelId } = await import('../src/config');
    expect(isKnownModelId('not-a-real-model-xyz')).toBe(false);
    const ps=getProviders({});
    const found=ps.some(p=> p.models.some(m=> m.id==='not-a-real-model-xyz'));
    expect(found).toBe(false);
  });

  it('embedding models are present for capable providers', async () => {
    const { getProviders } = await import('../src/config');
    const ps=getProviders({MISTRAL_API_KEY:'m', GEMINI_API_KEY:'g', OLLAMA_BASE_URL:'https://o.test/v1'});
    const mistral=ps.find(p=> p.id==='mistral');
    expect(mistral?.models.some(m=> m.capabilities.includes('embeddings'))).toBe(true);
    const gemini=ps.find(p=> p.id==='gemini');
    expect(gemini?.models.some(m=> m.capabilities.includes('embeddings'))).toBe(true);
  });
});
