/**
 * Server-side SSE sanitizing for reasoning-tag leakage (<thought>/<think>/
 * <thinking>/<reasoning>) that some upstream free-tier models emit.
 * Pure logic — web standards only (TextEncoder/TextDecoder/TransformStream),
 * no Cloudflare imports. Unit-tested in test/sanitize.test.ts.
 *
 * Why incremental instead of buffering the whole stream: buffering would turn
 * time-to-first-token into time-to-last-token. ReasoningTagStripper holds back
 * only undecided bytes (a `<` that may still open a reasoning tag, bounded to
 * MAX_HOLD chars); plain content flows through chunk-by-chunk, so first-token
 * latency is unchanged for tag-free streams.
 */

const TAG_NAMES = 'thought|think|thinking|reasoning';
const OPEN_TAG_RE = new RegExp(`^<(${TAG_NAMES})\\b[^>]*>$`, 'i');
/** Max undecided tail held in text mode (covers tags with attributes). */
const MAX_HOLD = 256;
/** Tail retained in swallow mode to catch close tags split across pushes. */
const CLOSE_TAIL = 32;
/** Pending-bytes cap before best-effort flush (mirrors MAX_JSON_BYTES). */
const PENDING_CAP = 1_000_000;

export class ReasoningTagStripper {
  private swallowing: string | null = null; // lowercased tag name, or null
  private hold = ''; // undecided text-mode tail (`<` seen, no `>` yet)
  private tail = ''; // retained swallowed tail for split close-tag detection

  /** Feed decoded text; returns clean text safe to emit now. */
  push(chunk: string): string {
    let s = this.hold + chunk;
    this.hold = '';
    if (this.swallowing) {
      s = this.tail + s;
      this.tail = '';
      const rest = this.swallow(s);
      if (rest === null) return '';
      s = rest;
    }
    return this.scanText(s);
  }

  /** End of stream: release held plain text; drop unclosed reasoning rest. */
  flush(): string {
    const held = this.hold;
    this.hold = '';
    this.tail = '';
    this.swallowing = null;
    return held;
  }

  /** True while inside an unclosed reasoning block (all output withheld). */
  get isSwallowing(): boolean {
    return this.swallowing !== null;
  }

  private scanText(s: string): string {
    let out = '';
    let pos = 0;
    for (;;) {
      const lt = s.indexOf('<', pos);
      if (lt === -1) {
        out += s.slice(pos);
        break;
      }
      const nextLt = s.indexOf('<', lt + 1);
      const gt = s.indexOf('>', lt + 1);
      if (gt === -1) {
        // No `>` yet: hold from the LAST `<` (earlier ones are plain text —
        // a tag cannot contain `<` before its `>`), so a later reasoning
        // open is still detected when its `>` arrives.
        const tail = s.slice(lt);
        const lastLt = tail.lastIndexOf('<');
        const holdCand = tail.slice(lastLt);
        // All four tag names start with t/r; anything else flushes now.
        if (holdCand.length <= MAX_HOLD && /^<[tTrR][^<>]*$/.test(holdCand)) {
          out += s.slice(pos, lt + lastLt);
          this.hold = holdCand;
        } else {
          out += s.slice(pos); // plain text (`a < b`, `<3`, over-long)
        }
        break;
      }
      if (nextLt !== -1 && nextLt < gt) {
        // `<` before any `>` — lt cannot open a tag, so it is plain text;
        // re-scan from inside so a later reasoning open still matches.
        out += s.slice(pos, lt + 1);
        pos = lt + 1;
        continue;
      }
      const open = OPEN_TAG_RE.exec(s.slice(lt, gt + 1));
      if (open) {
        out += s.slice(pos, lt);
        this.swallowing = open[1]!.toLowerCase();
        this.tail = '';
        const rest = this.swallow(s.slice(gt + 1));
        if (rest === null) break;
        s = rest;
        pos = 0;
        continue;
      }
      out += s.slice(pos, gt + 1); // complete non-reasoning tag → plain text
      pos = gt + 1;
    }
    return out;
  }

  /** Returns remainder after the matching close tag, or null if still inside. */
  private swallow(s: string): string | null {
    const close = new RegExp(`</${this.swallowing}\\s*>`, 'gi');
    const m = close.exec(s);
    if (!m) {
      this.tail = s.slice(-CLOSE_TAIL);
      return null;
    }
    this.swallowing = null;
    this.tail = '';
    return s.slice(m.index + m[0].length);
  }
}

interface ContentRef {
  o: Record<string, unknown>;
  k: string;
}

/** Transform one SSE event block; JSON data payloads get content stripped. */
function transformEvent(block: string, get: (i: number) => ReasoningTagStripper, final: boolean): string {
  const lines = block.split(/\r?\n/);
  const refs = new Map<ReasoningTagStripper, ContentRef[]>();
  let touched = false;
  const out = lines.map((line) => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    let j: unknown;
    try {
      j = JSON.parse(payload);
    } catch {
      return line;
    }
    const choices = (j as { choices?: unknown })?.choices;
    if (!Array.isArray(choices)) return line;
    for (const ch of choices as Record<string, unknown>[]) {
      const idx = typeof ch?.index === 'number' ? (ch.index as number) : choices.indexOf(ch);
      const holders = [ch?.delta, ch?.message].filter((h): h is Record<string, unknown> => !!h && typeof (h as Record<string, unknown>).content === 'string');
      if (typeof ch?.text === 'string') holders.push(ch as Record<string, unknown>);
      for (const h of holders) {
        const key = 'content' in h && typeof h.content === 'string' ? 'content' : 'text';
        const s = get(idx);
        const clean = s.push(h[key] as string);
        if (clean !== h[key]) touched = true;
        h[key] = clean;
        const arr = refs.get(s) ?? [];
        arr.push({ o: h, k: key });
        refs.set(s, arr);
      }
    }
    if (!touched && !final) return line;
    if (final) {
      for (const [s, targets] of refs) {
        const tail = s.flush();
        if (tail) {
          const last = targets[targets.length - 1]!;
          last.o[last.k] = (last.o[last.k] as string) + tail;
          touched = true;
        }
      }
    }
    return touched ? `data: ${JSON.stringify(j)}` : line;
  });
  return out.join('\n');
}

/**
 * Wrap an SSE upstream body with incremental reasoning-tag sanitizing.
 * Returns null when the body is not an event stream (caller passes through).
 * Non-JSON lines, `data: [DONE]`, and event/id/retry lines go through byte-
 * identical; only JSON delta/message content is rewritten, and only when it
 * actually contains held or stripped tag bytes.
 */
export function wrapSSEBody(res: Response): Response | null {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/event-stream') || !res.body) return null;
  const strippers = new Map<number, ReasoningTagStripper>();
  const get = (i: number): ReasoningTagStripper => {
    let s = strippers.get(i);
    if (!s) {
      s = new ReasoningTagStripper();
      strippers.set(i, s);
    }
    return s;
  };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > PENDING_CAP) {
        // Pathological frameless flood — best-effort transform, never OOM.
        controller.enqueue(encoder.encode(transformEvent(pending, get, true) + '\n\n'));
        pending = '';
        return;
      }
      const parts = pending.split(/\r?\n\r?\n/);
      pending = parts.pop() ?? '';
      for (const b of parts) {
        if (b === '') continue; // keep-alive pings carry no content
        controller.enqueue(encoder.encode(transformEvent(b, get, false) + '\n\n'));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending !== '') {
        controller.enqueue(encoder.encode(transformEvent(pending, get, true) + '\n\n'));
      }
      // Else: stream ended on a block boundary. Any stripper still holding
      // bytes means the upstream was cut mid-tag-fragment without [DONE] —
      // the client is already broken there, so drop rather than fabricate.
    },
  });
  const body = res.body.pipeThrough(stream);
  return new Response(body, { status: res.status, headers: res.headers });
}
