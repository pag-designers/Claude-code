import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { redact } from '../../logger';
import type { OnProgress } from '../../pipeline/contracts';
import type { BudgetGuard, CostPort } from './budget';
import {
  abortError,
  isAbortError,
  isTransient,
  LlmError,
  mapApiError,
  NO_KEY_MESSAGE,
} from './errors';
import { buildRepairBlock } from './prompts';
import { estimateTokens } from './transcript';

export type Effort = 'low' | 'medium' | 'high';

/** Calls on a single operation: the first try plus at most ONE repair/escalation retry. */
const MAX_ATTEMPTS = 2;
/** Extra attempts allowed for errors that strike after the stream had begun (SDK can't retry those). */
const MAX_MIDSTREAM_RETRIES = 1;
const PROMPT_TOKEN_LIMIT = 900_000; // models have a 1M window; leave room for output

export interface RunArgs<T> {
  model: string;
  /** Recorded in the cost log, e.g. "understand" / "moments". */
  purpose: string;
  /** Frozen system text (breakpoint 1). */
  system: string;
  /** Per-video / per-window context (breakpoint 2). */
  stable: string;
  /** Everything that varies per call; no cache marker. */
  volatile: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  effort: Effort;
  /** Thinking + answer both count; streaming makes large values safe. */
  maxTokens: number;
  /** Rough size of the JSON answer, only to turn streamed characters into a progress fraction. */
  expectedOutputChars: number;
  /** Used for the pre-call hard-cap check. */
  estimatedOutputTokens: number;
  signal?: AbortSignal;
  onProgress?: OnProgress;
  /**
   * Semantic check after zod. A returned string is treated like a schema failure (one repair
   * retry names it to the model). `finalAttempt` is true when no retry is left.
   */
  validate?: (parsed: T, info: { finalAttempt: boolean }) => string | null;
}

export interface EngineDeps {
  getApiKey: () => string | null;
  cost: CostPort;
  budget: BudgetGuard;
  baseUrl?: string;
  maxRetries?: number;
  log: (m: string) => void;
}

const lower = (e: Effort): Effort => (e === 'high' ? 'medium' : 'low');

function formatIssues(err: z.ZodError): string {
  const issues = err.issues
    .slice(0, 6)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  const more = err.issues.length > 6 ? ` (+${err.issues.length - 6} more)` : '';
  return `schema validation failed - ${issues.join('; ')}${more}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type Once =
  | { kind: 'text'; text: string }
  | { kind: 'truncated'; outputTokens: number };

export class LlmEngine {
  private client: Anthropic | null = null;
  private clientKey = '';

  constructor(private readonly deps: EngineDeps) {}

  isConfigured(): boolean {
    return !!this.deps.getApiKey()?.trim();
  }

  assertConfigured(): void {
    if (!this.isConfigured()) throw new LlmError('no-key', NO_KEY_MESSAGE);
  }

  private clientFor(key: string): Anthropic {
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({
        apiKey: key,
        // Explicit nulls/URL so env vars (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL) can never
        // redirect or re-authenticate the app.
        authToken: null,
        baseURL: this.deps.baseUrl ?? 'https://api.anthropic.com',
        maxRetries: this.deps.maxRetries ?? 3,
        timeout: 10 * 60 * 1000,
      });
      this.clientKey = key;
    }
    return this.client;
  }

  /** One structured-output call with budget guard, cost accounting, retries and validation. */
  async run<T>(args: RunArgs<T>): Promise<T> {
    const key = this.deps.getApiKey()?.trim();
    if (!key) throw new LlmError('no-key', NO_KEY_MESSAGE);
    const { signal } = args;
    if (signal?.aborted) throw abortError(signal);

    const promptTokens = estimateTokens(args.system + args.stable + args.volatile);
    if (promptTokens > PROMPT_TOKEN_LIMIT) {
      throw new LlmError(
        'too-long',
        `This video's transcript is too long for one request (about ${Math.round(promptTokens / 1000)}K tokens).`,
      );
    }

    let effort = args.effort;
    let maxTokens = args.maxTokens;
    let repair: string | null = null;
    let midstream = 0;
    let lastProblem = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      await this.deps.budget.check(args.model, promptTokens, args.estimatedOutputTokens);

      let once: Once;
      const flags = { started: false };
      try {
        once = await this.once(this.clientFor(key), args, { effort, maxTokens, repair }, flags);
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        if (flags.started && isTransient(e) && midstream < MAX_MIDSTREAM_RETRIES) {
          midstream++;
          attempt--; // does not consume the validation/escalation retry
          this.deps.log(`${args.purpose}: stream broke mid-response (${errText(e)}); retrying once`);
          await sleep(1500, signal);
          continue;
        }
        throw mapApiError(e, args.model);
      }

      if (once.kind === 'truncated') {
        lastProblem = `the answer was cut off at ${once.outputTokens} output tokens (max_tokens)`;
        if (attempt < MAX_ATTEMPTS) {
          // Thinking shares max_tokens with the answer: think less and allow more room.
          effort = lower(effort);
          maxTokens = Math.min(maxTokens * 2, 64_000);
          repair = null;
          this.deps.log(
            `${args.purpose}: hit max_tokens; retrying at effort=${effort}, max_tokens=${maxTokens}`,
          );
          continue;
        }
        throw new LlmError(
          'truncated',
          'Claude ran out of output space twice while answering. Try again, or use a shorter video section.',
        );
      }

      // ---- parse + validate ----
      let problem: string | null = null;
      let parsed: T | undefined;
      let json: unknown;
      try {
        json = JSON.parse(once.text);
      } catch (e) {
        problem = once.text.trim()
          ? `the reply was not valid JSON (${e instanceof Error ? e.message : 'parse error'})`
          : 'the reply was empty';
      }
      if (problem === null) {
        const r = args.schema.safeParse(json);
        if (!r.success) problem = formatIssues(r.error);
        else {
          const semantic = args.validate?.(r.data, { finalAttempt: attempt >= MAX_ATTEMPTS }) ?? null;
          if (semantic) problem = semantic;
          else parsed = r.data;
        }
      }
      if (problem === null && parsed !== undefined) {
        args.onProgress?.(1);
        return parsed;
      }
      lastProblem = problem ?? 'unknown validation problem';
      this.deps.log(`${args.purpose}: unusable reply (attempt ${attempt}): ${lastProblem}`);
      repair = lastProblem;
    }

    throw new LlmError(
      'invalid-output',
      `Claude returned an answer that could not be used, even after one retry: ${lastProblem}`,
    );
  }

  /** A single streamed request. Records usage (also for unusable replies). */
  private async once<T>(
    client: Anthropic,
    args: RunArgs<T>,
    p: { effort: Effort; maxTokens: number; repair: string | null },
    flags: { started: boolean },
  ): Promise<Once> {
    const content: Anthropic.TextBlockParam[] = [
      { type: 'text', text: args.stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: args.volatile },
    ];
    if (p.repair) content.push({ type: 'text', text: buildRepairBlock(p.repair) });

    // No temperature/top_p/top_k (400 on these models), no prefill (last turn is the user's), no
    // tool_choice, no `thinking` (adaptive is the default; depth is steered by effort only).
    const params: Anthropic.MessageStreamParams = {
      model: args.model,
      max_tokens: p.maxTokens,
      system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: {
        effort: p.effort,
        format: { type: 'json_schema', schema: args.jsonSchema },
      },
    };

    args.onProgress?.(null, p.repair ? 'Retrying…' : 'Thinking…');
    let chars = 0;
    let lastReported = 0;
    const stream = client.messages.stream(params, args.signal ? { signal: args.signal } : {});
    stream.on('streamEvent', () => {
      flags.started = true;
    });
    stream.on('text', (delta) => {
      chars += delta.length;
      const f = Math.min(0.95, chars / Math.max(1, args.expectedOutputChars));
      if (f - lastReported >= 0.01) {
        lastReported = f;
        args.onProgress?.(f, 'Writing…');
      }
    });

    let msg: Anthropic.Message;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      if (isAbortError(e) && args.signal?.aborted) throw abortError(args.signal);
      throw e;
    }

    const u = msg.usage;
    await this.record(args.model, args.purpose, msg);
    this.deps.log(
      `${args.purpose}: ${args.model} effort=${p.effort} stop=${msg.stop_reason} ` +
        `in=${u.input_tokens} cacheRead=${u.cache_read_input_tokens ?? 0} ` +
        `cacheWrite=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}` +
        (msg._request_id ? ` req=${msg._request_id}` : ''),
    );

    if (msg.stop_reason === 'refusal') {
      const d = msg.stop_details;
      const why = d ? ` (${[d.category, d.explanation].filter(Boolean).join(': ')})` : '';
      throw new LlmError(
        'refusal',
        `Claude declined to process this content${why}. Try a different video section or rephrase the steering prompt.`,
      );
    }
    if (msg.stop_reason === 'model_context_window_exceeded') {
      throw new LlmError('too-long', "This video's transcript does not fit into the model's context window.");
    }
    if (msg.stop_reason === 'max_tokens') return { kind: 'truncated', outputTokens: u.output_tokens };

    // Read by block type, never by position: adaptive thinking may put thinking blocks first.
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { kind: 'text', text };
  }

  private async record(model: string, purpose: string, msg: Anthropic.Message): Promise<void> {
    const u = msg.usage;
    try {
      await this.deps.cost.record(model, purpose, {
        // `input_tokens` excludes cache tokens; reads/writes are reported separately.
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      });
    } catch (e) {
      this.deps.log(`could not record cost: ${errText(e)}`);
    }
  }
}

function errText(e: unknown): string {
  return redact(e instanceof Error ? e.message : String(e));
}
