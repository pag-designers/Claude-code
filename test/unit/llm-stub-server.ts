import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Local stand-in for POST /v1/messages (JSON and SSE streaming). It records every request body
 * exactly as the SDK sent it, and emulates prompt-cache accounting: a cache_control breakpoint whose
 * rendered prefix (model + effort + everything up to and including that block) was seen before is a
 * READ; the first time it is a WRITE. That lets tests prove that our prompt layout really
 * produces cache hits for the same window / steered re-runs - without a network.
 */

export interface StubUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StubReply {
  /** HTTP status; anything >= 400 returns an Anthropic-style error body. */
  status?: number;
  headers?: Record<string, string>;
  errorType?: string;
  errorMessage?: string;
  /** The assistant text (normally a JSON document). */
  text?: string;
  stopReason?: string;
  stopDetails?: { type: string; category: string | null; explanation: string | null };
  /** Overrides the emulated usage. */
  usage?: StubUsage;
  /** Emit a thinking block before the text (as adaptive thinking does). */
  thinking?: boolean;
  /** Send an SSE `error` event after `text` has been partly streamed. */
  sseErrorAfterText?: boolean;
  /** Start streaming, then never finish (abort tests). */
  hang?: boolean;
  /** Exact text deltas (e.g. to split a "[12:3" + "0]" citation marker); overrides the 4-way split. */
  textChunks?: string[];
  /** tool_use blocks streamed after the text (input_json_delta in pieces). stop_reason defaults to tool_use. */
  toolUses?: { id?: string; name: string; input: unknown }[];
  /** Start the first tool_use block, then never finish (abort-mid-tool-stream tests). */
  hangInToolUse?: boolean;
  /** Send this exact string as the first tool_use input JSON (to simulate unparseable tool input). */
  rawToolJson?: string;
}

/** Loose view of any request content block (text, image, tool_use, tool_result, thinking ...). */
export interface WireContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: string; ttl?: string };
  source?: { type: string; media_type?: string; data?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  [extra: string]: unknown;
}
export interface WireTool {
  name: string;
  description?: string;
  strict?: boolean;
  eager_input_streaming?: boolean;
  input_schema: Record<string, unknown>;
  [extra: string]: unknown;
}

/** The request body as the SDK sends it (only the parts the tests look at are typed). */
export interface WireBlock {
  type: string;
  text: string;
  cache_control?: { type: string; ttl?: string };
}
export interface WireBody {
  model: string;
  max_tokens: number;
  stream?: boolean;
  system?: string | WireBlock[];
  messages: { role: string; content: string | WireBlock[] }[];
  output_config?: { effort?: string; format?: { type: string; schema: Record<string, unknown> } };
  [extra: string]: unknown;
}

export interface Recorded {
  body: WireBody;
  headers: http.IncomingHttpHeaders;
  usage: Required<StubUsage>;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

export class StubAnthropic {
  readonly requests: Recorded[] = [];
  private server: http.Server | null = null;
  private readonly seenPrefixes = new Set<string>();
  private sockets = new Set<Socket>();
  /** Per-request replies; the last one repeats. A function can decide from the body. */
  replies: (StubReply | ((body: WireBody, n: number) => StubReply))[] = [];
  minCacheTokens = 512;

  get baseUrl(): string {
    const a = this.server?.address() as AddressInfo | null;
    if (!a) throw new Error('stub not started');
    return `http://127.0.0.1:${a.port}`;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  reset(): void {
    this.requests.length = 0;
    this.seenPrefixes.clear();
    this.replies = [];
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages') {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end('{"type":"error","error":{"type":"not_found_error","message":"nope"}}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
    const n = this.requests.length;
    const pick = this.replies[Math.min(n, this.replies.length - 1)];
    const reply: StubReply = typeof pick === 'function' ? pick(body, n) : (pick ?? {});
    const usage = this.accountUsage(body, reply);
    this.requests.push({ body, headers: req.headers, usage });

    const status = reply.status ?? 200;
    if (status >= 400) {
      res.writeHead(status, { 'content-type': 'application/json', ...(reply.headers ?? {}) }).end(
        JSON.stringify({
          type: 'error',
          error: {
            type: reply.errorType ?? 'api_error',
            message: reply.errorMessage ?? `stub error ${status}`,
          },
        }),
      );
      return;
    }

    const toolUses = (reply.toolUses ?? []).map((t, i) => ({
      id: t.id ?? `toolu_stub_${n}_${i}`,
      name: t.name,
      input: t.input,
    }));
    const text = reply.text ?? (toolUses.length ? '' : '{}');
    const stop = reply.stopReason ?? (toolUses.length ? 'tool_use' : 'end_turn');
    const model = String(body.model);
    const message = (content: unknown[], u: Record<string, number>) => ({
      id: `msg_stub_${n}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      stop_details: reply.stopDetails ?? null,
      usage: u,
    });

    if (!body.stream) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            message(
              [
                ...(text ? [{ type: 'text', text }] : []),
                ...toolUses.map((t) => ({ type: 'tool_use', ...t })),
              ],
              { ...usage },
            ),
          ),
        );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        ...message([], { ...usage, output_tokens: 1 }),
        stop_reason: null,
        stop_details: null,
      },
    });
    let idx = 0;
    if (reply.thinking) {
      send('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'signature_delta', signature: 'sig' },
      });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    if (text) {
      send('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' },
      });
      const parts = reply.textChunks ?? splitInto(text, 4);
      for (let i = 0; i < parts.length; i++) {
        send('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: parts[i] },
        });
        if (reply.hang && i === 0) return; // stall: client must abort
        if (reply.sseErrorAfterText && i === 1) {
          send('error', {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          });
          res.end();
          return;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      send('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    for (const t of toolUses) {
      send('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
      });
      const json = reply.rawToolJson ?? JSON.stringify(t.input);
      const pieces = splitInto(json, 3);
      for (let i = 0; i < pieces.length; i++) {
        send('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: pieces[i] },
        });
        if (reply.hangInToolUse && i === 0) return;
        await new Promise((r) => setTimeout(r, 2));
      }
      send('content_block_stop', { type: 'content_block_stop', index: idx });
      idx++;
    }
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null, stop_details: reply.stopDetails ?? null },
      usage: { output_tokens: usage.output_tokens },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  /** Emulated cache accounting: longest previously-seen breakpoint prefix is a read. */
  private accountUsage(body: WireBody, reply: StubReply): Required<StubUsage> {
    const o = reply.usage ?? {};
    const outTok = o.output_tokens ?? Math.max(1, approxTokens(reply.text ?? '{}'));
    if (reply.usage?.input_tokens !== undefined) {
      return {
        input_tokens: o.input_tokens ?? 0,
        output_tokens: outTok,
        cache_creation_input_tokens: o.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: o.cache_read_input_tokens ?? 0,
      };
    }
    // Render order: system blocks, then message content blocks. Breakpoints = blocks with cache_control.
    const blocks: { text: string; cc: boolean }[] = [];
    const asBlocks = (c: string | WireContentBlock[] | undefined): WireContentBlock[] =>
      typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? []);
    // text counts as text; any other block (image, tool_use, tool_result, thinking) is rendered as
    // its JSON, with image bytes replaced by a short digest so they stay cheap but still distinguish
    // prefixes. Image tokens are therefore NOT emulated (see tests: they assert wire shape only).
    const render = (b: WireContentBlock): string => {
      if (typeof b.text === 'string' && b.type === 'text') return b.text;
      if (b.type === 'image' && b.source?.data)
        return `[image ${crypto.createHash('sha1').update(b.source.data).digest('hex')}]`;
      return JSON.stringify(b);
    };
    for (const b of asBlocks(body.system as string | WireContentBlock[] | undefined))
      blocks.push({ text: render(b), cc: !!b.cache_control });
    for (const m of body.messages)
      for (const b of asBlocks(m.content as string | WireContentBlock[]))
        blocks.push({ text: render(b), cc: !!b.cache_control });
    // tools are rendered BEFORE system in the real cache order
    const header = JSON.stringify([
      body.model,
      body.output_config?.effort ?? null,
      body.output_config?.format ?? null,
      (body as { tools?: unknown }).tools ?? null,
    ]);
    let acc = header;
    let covered = 0; // tokens up to the last breakpoint
    let read = 0;
    let write = 0;
    for (const b of blocks) {
      acc += '\u0000' + b.text;
      if (!b.cc) continue;
      const tokensHere = approxTokens(acc);
      if (tokensHere < this.minCacheTokens) continue;
      const h = crypto.createHash('sha1').update(acc).digest('hex');
      if (this.seenPrefixes.has(h)) {
        read = tokensHere;
        write = 0;
      } else {
        this.seenPrefixes.add(h);
        write = tokensHere - read;
      }
      covered = tokensHere;
    }
    return {
      input_tokens: Math.max(0, approxTokens(acc) - covered),
      output_tokens: outTok,
      cache_creation_input_tokens: write,
      cache_read_input_tokens: read,
    };
  }
}

function splitInto(s: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [''];
}
