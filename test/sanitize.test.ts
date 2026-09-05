/**
 * Reasoning-leakage sanitizer + score normalization + Workers AI coercion.
 * Covers probe findings: <thought> blocks in non-streaming chat, `:free`
 * score misses, and non-string Workers AI responses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeChat, stripReasoningTags } from "../src/router";
import { ReasoningTagStripper, wrapSSEBody } from "../src/stream-sanitize";
import { getScore } from "../src/model-scores";

// ---- minimal limiter mock (acquire always ok) ----
function makeEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ns = {
    idFromName: (_name: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const op = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (op.op === "acquire")
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
    get: (s: unknown) => s,
  };
  return { LIMITER: ns, ...extra };
}

function chatReq(model: string, extra: Record<string, unknown> = {}): Request {
  return new Request("https://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }),
  });
}

function upstreamChat(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Concatenate all delta.content fields of an SSE response body. */
async function sseContents(res: Response): Promise<string> {
  const text = await res.text();
  const parts: string[] = [];
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const j = JSON.parse(p) as {
          choices?: { delta?: { content?: unknown } }[];
        };
        const c = j.choices?.[0]?.delta?.content;
        if (typeof c === "string") parts.push(c);
      } catch {
        /* non-JSON data line — ignore */
      }
    }
  }
  return parts.join("");
}

describe("stripReasoningTags", () => {
  it("removes paired <thought> blocks", () => {
    expect(stripReasoningTags('<thought>plan</thought>[{"a":1}]')).toBe(
      '[{"a":1}]',
    );
  });
  it("removes <think>/<thinking>/<reasoning> case-insensitively", () => {
    expect(stripReasoningTags("<THINK>x</THINK>hi")).toBe("hi");
    expect(stripReasoningTags('<thinking class="r">x</thinking>hi')).toBe("hi");
    expect(stripReasoningTags("<reasoning>y</reasoning>hi")).toBe("hi");
  });
  it("removes unclosed trailing blocks (truncated streams)", () => {
    expect(stripReasoningTags("<thought>partial answer")).toBe("");
  });
  it("returns the original string untouched when no tags are present", () => {
    const s = '  [{"a":1}]  ';
    expect(stripReasoningTags(s)).toBe(s); // same reference, no trim
  });
});

describe("non-streaming chat sanitization", () => {
  it("strips thought leakage from upstream chat responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          upstreamChat("<thought>The user wants 1..5</thought>1, 2, 3"),
        ),
    );
    const env = makeEnv({ GROQ_API_KEY: "g" });
    const body = {
      model: "groq/llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
    };
    const res = await routeChat(
      chatReq(body.model),
      env as never,
      body as never,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(j.choices[0]?.message.content).toBe("1, 2, 3");
  });

  it("leaves clean responses byte-identical (no re-serialization)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => upstreamChat("clean answer")),
    );
    const env = makeEnv({ GROQ_API_KEY: "g" });
    const body = {
      model: "groq/llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
    };
    const res = await routeChat(
      chatReq(body.model),
      env as never,
      body as never,
    );
    const j = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(j.choices[0]?.message.content).toBe("clean answer");
  });

  it("strips thought leakage from streamed responses (server-side)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"<thought>plan"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"ning</thought>1, 2"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":", 3"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(sse, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
        ),
    );
    const env = makeEnv({ GROQ_API_KEY: "g" });
    const body = {
      model: "groq/llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const res = await routeChat(
      chatReq(body.model, { stream: true }),
      env as never,
      body as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).not.toContain("<thought");
    expect(text).not.toContain("plan");
    expect(text).toContain("data: [DONE]");
    expect(await sseContents(new Response(text))).toBe("1, 2, 3");
  });

  it("strips leakage split mid-tag across upstream chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<tho"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ught>x</th"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ought>hi"}}]}\n\ndata: [DONE]\n\n',
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (const s of chunks)
                  c.enqueue(new TextEncoder().encode(s));
                c.close();
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
      ),
    );
    const env = makeEnv({ GROQ_API_KEY: "g" });
    const body = {
      model: "groq/llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const res = await routeChat(
      chatReq(body.model, { stream: true }),
      env as never,
      body as never,
    );
    expect(res.status).toBe(200);
    expect(await sseContents(res)).toBe("hi");
  });

  it("strips Workers AI synthesized SSE", async () => {
    const env = makeEnv({
      AI: { run: async () => ({ response: "<think>dose</think>Hi" }) },
    });
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const res = await routeChat(
      chatReq("auto", { stream: true }),
      env as never,
      body as never,
    );
    expect(res.status).toBe(200);
    expect(await sseContents(res)).toBe("Hi");
  });
});

describe("ReasoningTagStripper (incremental)", () => {
  it("passes plain text through untouched", () => {
    const s = new ReasoningTagStripper();
    expect(s.push("hello ") + s.push("world") + s.flush()).toBe(
      "hello world",
    );
  });
  it("strips a tag split across pushes", () => {
    const s = new ReasoningTagStripper();
    let out = s.push("<tho");
    out += s.push("ught>secret</th");
    out += s.push("ought>hi");
    out += s.flush();
    expect(out).toBe("hi");
  });
  it("handles attributes split across pushes", () => {
    const s = new ReasoningTagStripper();
    const out = s.push('<thinking cl') + s.push('ass="r">x</thinking>ok') + s.flush();
    expect(out).toBe("ok");
  });
  it("is case-insensitive and passes non-reasoning tags through", () => {
    const s = new ReasoningTagStripper();
    const out =
      s.push("<B>hi</B> 5 < 6 <THINK>x</THINK>!") + s.flush();
    expect(out).toBe("<B>hi</B> 5 < 6 !");
  });
  it("handles close tags split across pushes", () => {
    const s = new ReasoningTagStripper();
    let out = s.push("<think>x</thi");
    out += s.push("nk>done");
    out += s.flush();
    expect(out).toBe("done");
  });
  it("drops unclosed blocks at flush, releases held plain text", () => {
    const s = new ReasoningTagStripper();
    expect(s.push("a < b")).toBe("a < b");
    const s2 = new ReasoningTagStripper();
    expect(s2.push("<th")).toBe("");
    expect(s2.flush()).toBe("<th");
    const s3 = new ReasoningTagStripper();
    expect(s3.push("<thought>never closed") + s3.flush()).toBe("");
  });
});

describe("wrapSSEBody", () => {
  it("returns null for non-SSE bodies", () => {
    expect(
      wrapSSEBody(
        new Response("{}", { headers: { "content-type": "application/json" } }),
      ),
    ).toBeNull();
  });
  it("survives awkward byte splits and preserves framing", async () => {
    const events =
      'data: {"choices":[{"delta":{"content":"<think>a</think>A"}}]}\n\n' +
      ': ping\n\n' +
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n' +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(events);
    const slices: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) slices.push(bytes.slice(i, i + 7));
    const res = new Response(
      new ReadableStream({
        start(c) {
          for (const s of slices) c.enqueue(s);
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const wrapped = wrapSSEBody(res)!;
    expect(wrapped).not.toBeNull();
    const text = await wrapped.text();
    expect(text).not.toContain("<think");
    expect(text).toContain(": ping");
    expect(text).toContain("data: [DONE]");
    expect(await sseContents(new Response(text))).toBe("AB");
  });
  it("leaves clean streams byte-identical", async () => {
    const events =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    const res = new Response(events, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(await wrapSSEBody(res)!.text()).toBe(events);
  });
});

describe("getScore normalization", () => {
  it("resolves :free-suffixed ids to their bare entries", () => {
    expect(getScore("openai/gpt-oss-20b:free")?.aaSlug).toBe("gpt-oss-20b");
    expect(getScore("nvidia/nemotron-3-super-120b-a12b:free")?.score).toBe(38);
  });
  it("returns new null-entries for MedTrail defaults (no silent miss)", () => {
    expect(getScore("llama-3.3-70b-versatile")).toBeDefined();
    expect(getScore("gemma-4-31b")).toBeDefined();
    expect(getScore("gemini-embedding-001")).toBeDefined();
  });
});

describe("Workers AI non-string coercion", () => {
  it("stringifies object responses to keep message.content a string", async () => {
    const env = makeEnv({
      AI: {
        run: async () => ({
          response: { name: "Paracetamol", strength: "500mg" },
        }),
      },
    });
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "extract" }],
    };
    const res = await routeChat(chatReq("auto"), env as never, body as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      choices: { message: { content: unknown } }[];
    };
    expect(typeof j.choices[0]?.message.content).toBe("string");
    expect(j.choices[0]?.message.content as string).toContain("Paracetamol");
  });
});
