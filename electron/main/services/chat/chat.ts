import type Anthropic from '@anthropic-ai/sdk';
import type { ChatRunInput, ChatRunResult } from '../../pipeline/contracts2';
import { redact } from '../../logger';
import type { BudgetGuard } from '../llm/budget';
import type { LlmEngine } from '../llm/client';
import { abortError, LlmError } from '../llm/errors';
import { estimateTokens } from '../llm/transcript';
import { CitationScanner } from './citations';
import { buildTranscriptBlock, buildVideoContext, CHAT_SYSTEM } from './prompts';
import { retrieveExcerpts } from './retrieval';
import { CHAT_TOOLS, validateToolCall, type ToolValidationContext } from './tools';

/**
 * AI Chat (BRIEF §6). One user turn = a retrieval step (long videos only) + a streamed tool loop.
 *
 * PATHS
 *  - whole transcript: estimated < WHOLE_TRANSCRIPT_MAX_TOKENS (~60K tokens, i.e. hours of speech): the
 *    full timestamped transcript sits in the CACHED prefix (system + video context + transcript), so
 *    only the first question of a thread pays the cache write; later turns read it at 0.1x.
 *  - retrieval: longer: the fast model picks the relevant windows (retrieval.ts); the smart model
 *    answers from those windows + the video summary/chapters. Excerpts differ per question, so they
 *    are NOT in the cached prefix; the video context still is.
 *
 * Models: smart model (Sonnet-class) generates; effort 'low' - chat is lookup + synthesis, and at low
 * the model skips thinking on simple requests (migration guide: "low for chat"). Over the monthly
 * target the fast model answers instead. Design choices, not measurements.
 *
 * TOOL LOOP: stream -> collect tool_use blocks -> validate (zod + the video) -> executeTool ->
 * tool_result with the exact tool_use_id -> repeat until end_turn. The assistant turn is appended
 * BYTE-FOR-BYTE (`message.content`, thinking blocks included): Sonnet/Haiku 5.5 check that replayed
 * thinking blocks match what they produced. Tools run sequentially, in block order.
 */

export const WHOLE_TRANSCRIPT_MAX_TOKENS = 60_000;
export const MAX_ITERATIONS = 6;
export const MAX_TOOL_CALLS = 8;
export const MAX_HISTORY_TURNS = 12;
const MAX_TURN_OUTPUT_TOKENS = 24_000;
const MAX_TOKENS_PER_CALL = 12_000;
const HISTORY_TEXT_MAX = 4_000;
const CHAT_EFFORT = 'low' as const;
/** Haiku 5.5 bills a higher rate card above 100K prompt tokens (see cost.ts). */
const HAIKU_CHEAP_RATE_PROMPT_TOKENS = 100_000;
/** Strict tool schemas + descriptions, roughly. */
const TOOLS_TOKENS = 1_100;

export interface ChatContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelSmart: string; modelFast: string }>;
  log: (m: string) => void;
}

export async function runChat(ctx: ChatContext, input: ChatRunInput): Promise<ChatRunResult> {
  ctx.engine.assertConfigured();
  const { signal } = input;
  if (signal?.aborted) throw abortError(signal);
  const userText = input.userText.trim();
  if (!userText) throw new LlmError('bad-request', 'Type a message first.');

  const sentences = input.transcript.sentences
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.s - b.s);
  const durationSec = Math.max(
    input.transcript.durationSec,
    sentences[sentences.length - 1]?.e ?? 0,
  );
  const settings = await ctx.getSettings();
  const status = await ctx.budget.peek(); // throws BudgetExceededError at the hard cap

  // ---- context + path
  const videoContext = buildVideoContext({
    info: input.info,
    analysis: input.analysis,
    clip: input.clip,
    durationSec,
  });
  const transcriptBlock = buildTranscriptBlock(sentences, durationSec);
  const transcriptTokens = estimateTokens(transcriptBlock);
  const whole = transcriptTokens <= WHOLE_TRANSCRIPT_MAX_TOKENS;
  const history = trimHistory(input.history);

  let excerpts: string | null = null;
  if (!whole) {
    ctx.log(
      `chat: transcript ~${Math.round(transcriptTokens / 1000)}K tokens > ${WHOLE_TRANSCRIPT_MAX_TOKENS / 1000}K; retrieving relevant windows with ${settings.modelFast}`,
    );
    const r = await retrieveExcerpts(
      { engine: ctx.engine, budget: ctx.budget, log: ctx.log },
      {
        question: userText,
        recentUser: history
          .filter((h) => h.role === 'user')
          .slice(-2)
          .map((h) => h.text),
        sentences,
        title: input.info.title,
        summary: input.analysis?.overview.summary ?? null,
        durationSec,
        model: settings.modelFast,
        signal,
      },
    );
    ctx.log(
      `chat: ${r.windows} window(s) from ${r.slices} slice(s)${r.fallback ? ' (keyword fallback)' : ''}`,
    );
    excerpts = r.text;
  }

  const contextBlock = whole ? `${videoContext}\n${transcriptBlock}` : videoContext;
  const messages = buildMessages(contextBlock, history, excerpts, userText);
  const baseTokens =
    estimateTokens(CHAT_SYSTEM) +
    TOOLS_TOKENS +
    estimateTokens(contextBlock) +
    estimateTokens(excerpts ?? '') +
    history.reduce((a, h) => a + estimateTokens(h.text), 0) +
    estimateTokens(userText);

  let model = settings.modelSmart;
  if (status.level === 'over-target') {
    if (baseTokens < HAIKU_CHEAP_RATE_PROMPT_TOKENS) {
      model = settings.modelFast;
      ctx.log(`chat: over monthly target - answering with ${model}`);
    } else ctx.log('chat: over monthly target but prompt >100K tokens; staying on the smart model');
  }

  // ---- streaming state
  const scanner = new CitationScanner(durationSec);
  let text = '';
  const emit = (delta: string) => {
    text += delta;
    input.onDelta(delta);
    for (const c of scanner.push(delta)) input.onCitation(c);
  };

  const vctx: ToolValidationContext = {
    durationSec,
    sentences,
    clipId: input.clip?.id ?? null,
  };
  const done: string[] = [];
  let toolCalls = 0;
  let outputTokens = 0;
  let promptTokens = baseTokens;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    let first = true;
    const msg = await ctx.engine.converse({
      model,
      purpose: 'chat',
      system: CHAT_SYSTEM,
      messages,
      tools: CHAT_TOOLS,
      effort: CHAT_EFFORT,
      maxTokens: MAX_TOKENS_PER_CALL,
      promptTokens,
      estimatedOutputTokens: 1_500,
      signal,
      onText: (d) => {
        // blank line between the text of two iterations (before / after a tool call)
        if (first) {
          first = false;
          if (text && !/\s$/.test(text) && !/^\s/.test(d)) emit('\n\n');
        }
        emit(d);
      },
    });
    const u = msg.usage;
    outputTokens += u.output_tokens;
    promptTokens =
      u.input_tokens +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      u.output_tokens;

    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (msg.stop_reason === 'max_tokens') {
      // A tool input cut off at max_tokens can still parse as a valid partial object: never run it.
      const lost = toolUses.length > 0;
      emit(
        `${text && !/\s$/.test(text) ? '\n\n' : ''}(${lost ? 'The answer was cut off before I could finish the action - please try again.' : 'The answer was cut off - ask me to continue.'})`,
      );
      break;
    }
    if (msg.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: msg.content as Anthropic.ContentBlockParam[] });
      continue;
    }
    if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: msg.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      results.push(await runTool(tu, toolCalls > MAX_TOOL_CALLS));
      if (signal?.aborted) throw abortError(signal);
    }
    messages.push({ role: 'user', content: results });
    promptTokens += results.reduce((a, r) => a + estimateTokens(String(r.content ?? '')), 0);

    if (iter === MAX_ITERATIONS || outputTokens > MAX_TURN_OUTPUT_TOKENS) {
      ctx.log(`chat: stopping after ${iter} model call(s), ${outputTokens} output tokens`);
      emit(
        `${text && !/\s$/.test(text) ? '\n\n' : ''}(I stopped here to stay within limits. The actions above were completed.)`,
      );
      break;
    }
  }

  if (!text.trim()) {
    if (done.length) emit(`Done: ${done.join(' ')}`);
    else
      throw new LlmError('invalid-output', 'Claude did not produce an answer. Please try again.');
  }
  return { text, citations: scanner.all };

  /** Validates and executes one tool call; always returns a tool_result for its exact id. */
  async function runTool(
    tu: Anthropic.ToolUseBlock,
    overLimit: boolean,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const raw = isRecord(tu.input) ? tu.input : {};
    const card = (
      status: 'running' | 'done' | 'failed',
      inputShown: Record<string, unknown>,
      summary: string | null,
      href: string | null,
    ) => input.onAction({ id: tu.id, tool: tu.name, input: inputShown, status, summary, href });
    const err = (message: string): Anthropic.ToolResultBlockParam => {
      card('failed', raw, message, null);
      return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: message };
    };

    if (overLimit)
      return err(
        `Too many actions in one message (limit ${MAX_TOOL_CALLS}). This one was not run.`,
      );
    const v = validateToolCall(tu.name, tu.input, vctx);
    if (!v.ok) return err(v.message);

    card('running', v.input, null, null);
    try {
      const r = await input.executeTool(
        tu.name as Parameters<ChatRunInput['executeTool']>[0],
        v.input,
      );
      const summary = redact(r.summary);
      card(r.ok ? 'done' : 'failed', v.input, summary, r.href ?? null);
      if (r.ok) done.push(summary);
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: summary,
        ...(r.ok ? {} : { is_error: true }),
      };
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      const message = `The action failed: ${redact(e instanceof Error ? e.message : String(e))}`;
      ctx.log(`chat: tool ${tu.name} threw: ${message}`);
      card('failed', v.input, message, null);
      return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: message };
    }
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Last MAX_HISTORY_TURNS non-empty turns, text only, starting with a user turn. */
export function trimHistory(
  history: ChatRunInput['history'],
): { role: 'user' | 'assistant'; text: string }[] {
  const turns = history
    .map((h) => ({ role: h.role, text: h.text.trim().slice(0, HISTORY_TEXT_MAX) }))
    .filter((h) => h.text.length > 0)
    .slice(-MAX_HISTORY_TURNS);
  while (turns.length && turns[0]!.role !== 'user') turns.shift();
  return turns;
}

/**
 * messages[0] starts with the cached context block (breakpoint) followed by the first history turn,
 * so the cached prefix is identical across turns even though the history window slides.
 */
export function buildMessages(
  contextBlock: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  excerpts: string | null,
  userText: string,
): Anthropic.MessageParam[] {
  const ctxBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: contextBlock,
    cache_control: { type: 'ephemeral' },
  };
  const current: Anthropic.TextBlockParam[] = [
    ...(excerpts ? [{ type: 'text' as const, text: excerpts }] : []),
    { type: 'text', text: userText },
  ];
  const messages: Anthropic.MessageParam[] = [];
  const [firstTurn, ...rest] = history;
  if (!firstTurn) return [{ role: 'user', content: [ctxBlock, ...current] }];
  messages.push({ role: 'user', content: [ctxBlock, { type: 'text', text: firstTurn.text }] });
  for (const h of rest) messages.push({ role: h.role, content: h.text });
  messages.push({ role: 'user', content: current });
  return messages;
}
