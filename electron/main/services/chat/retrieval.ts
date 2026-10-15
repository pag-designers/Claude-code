import type { Sentence } from '@shared/pipeline';
import type { BudgetGuard } from '../llm/budget';
import type { LlmEngine } from '../llm/client';
import { abortError, LlmError, type LlmErrorCode } from '../llm/errors';
import { toJsonSchema } from '../llm/schemas';
import { retrievalSchema, type RetrievalOutput } from '../llm/schemas2';
import {
  estimateTokens,
  fmtClock,
  formatSentenceLines,
  normalizeForMatch,
} from '../llm/transcript';
import { buildRetrievalStable, buildRetrievalVolatile, RETRIEVE_SYSTEM } from './prompts';

/**
 * Retrieval for transcripts too long for one prompt (estimated > ~60K tokens, i.e. several hours of
 * speech): the FAST model (Haiku-class) first reads the transcript in slices and picks the windows
 * relevant to the question (small JSON, cheap); the smart model then answers ONLY from those windows
 * (plus the video summary/chapters, which are always present).
 *
 * Why slices: Haiku 5.5 bills 5x above 100K prompt tokens, so each slice is kept at ~70K estimated
 * tokens (the cheap rate card). The slice prefix is identical for every question about the video, so
 * from the second question on it is served from the prompt cache at 0.1x.
 */

export const SLICE_TOKENS = 70_000;
export const EXCERPT_TOKEN_BUDGET = 12_000;
const MAX_WINDOW_SENTENCES = 60;
const MARGIN = 2;
const RETRIEVAL_EFFORT = 'low' as const;

export interface RetrievalContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  log: (m: string) => void;
}

export interface Window {
  /** Inclusive indices into the sentence array. */
  i0: number;
  i1: number;
  relevance: number;
}

export interface Excerpts {
  /** The <transcript_excerpts> block, or a note when nothing was relevant. */
  text: string;
  windows: number;
  slices: number;
  /** True when the model-based retrieval failed and keyword matching was used instead. */
  fallback: boolean;
}

/** Splits the sentences into consecutive slices of at most `maxTokens` estimated tokens. */
export function sliceSentences(sentences: readonly Sentence[], maxTokens: number): Sentence[][] {
  const slices: Sentence[][] = [];
  let cur: Sentence[] = [];
  let tokens = 0;
  for (const s of sentences) {
    const t = estimateTokens(`S${s.id} [00:00] ${s.text}`) + 1;
    if (cur.length && tokens + t > maxTokens) {
      slices.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(s);
    tokens += t;
  }
  if (cur.length) slices.push(cur);
  return slices;
}

/** Errors for which keyword matching is an acceptable substitute (everything else is shown to the user). */
const RECOVERABLE = new Set<LlmErrorCode>([
  'invalid-output',
  'truncated',
  'overloaded',
  'api',
  'network',
]);

export async function retrieveExcerpts(
  ctx: RetrievalContext,
  a: {
    question: string;
    recentUser: readonly string[];
    sentences: readonly Sentence[];
    title: string;
    summary: string | null;
    durationSec: number;
    model: string;
    signal?: AbortSignal;
  },
): Promise<Excerpts> {
  const hours = a.durationSec >= 3600;
  const slices = sliceSentences(a.sentences, SLICE_TOKENS);
  const indexById = new Map<number, number>();
  a.sentences.forEach((s, i) => indexById.set(s.id, i));

  let windows: Window[];
  let fallback = false;
  try {
    const results = await Promise.all(
      slices.map(async (slice, n) => {
        const first = slice[0]!;
        const last = slice[slice.length - 1]!;
        const sliceIds = new Set(slice.map((s) => s.id));
        const out = await ctx.engine.run<RetrievalOutput>({
          model: a.model,
          purpose: 'chat',
          system: RETRIEVE_SYSTEM,
          stable: buildRetrievalStable({
            title: a.title,
            summary: a.summary,
            sentences: slice,
            durationSec: a.durationSec,
            sliceLabel: `part ${n + 1} of ${slices.length}, ${fmtClock(first.s, hours)}-${fmtClock(last.e, hours)}`,
          }),
          volatile: buildRetrievalVolatile(a.question, a.recentUser),
          schema: retrievalSchema,
          jsonSchema: RETRIEVAL_JSON_SCHEMA,
          effort: RETRIEVAL_EFFORT,
          maxTokens: 4_000,
          expectedOutputChars: 500,
          estimatedOutputTokens: 600,
          signal: a.signal,
          validate: (p) =>
            p.windows.length > 0 &&
            p.windows.every((w) => !sliceIds.has(w.startSentence) || !sliceIds.has(w.endSentence))
              ? 'none of the windows uses sentence numbers from this slice'
              : null,
        });
        return out.windows
          .filter((w) => sliceIds.has(w.startSentence) && sliceIds.has(w.endSentence))
          .map((w): Window | null => {
            const i0 = indexById.get(w.startSentence);
            const i1 = indexById.get(w.endSentence);
            if (i0 === undefined || i1 === undefined || i0 > i1) return null;
            return {
              i0,
              i1: Math.min(i1, i0 + MAX_WINDOW_SENTENCES - 1),
              relevance: clampRel(w.relevance),
            };
          })
          .filter((w): w is Window => w !== null);
      }),
    );
    windows = results.flat();
  } catch (e) {
    if (a.signal?.aborted) throw abortError(a.signal);
    if (!(e instanceof LlmError) || !RECOVERABLE.has(e.code)) throw e;
    ctx.log(`chat: retrieval failed (${e.code}); using keyword matching instead`);
    fallback = true;
    windows = lexicalWindows(a.question, a.sentences);
  }

  const chosen = selectWindows(windows, a.sentences, hours);
  if (chosen.length === 0) {
    return {
      text: '<transcript_excerpts note="No passage of the transcript looked relevant to this question.">\n</transcript_excerpts>',
      windows: 0,
      slices: slices.length,
      fallback,
    };
  }
  const parts = chosen.map((w, n) => {
    const seg = a.sentences.slice(w.i0, w.i1 + 1);
    const head = `[excerpt ${n + 1}: ${fmtClock(seg[0]!.s, hours)}-${fmtClock(seg[seg.length - 1]!.e, hours)}]`;
    return `${head}\n${formatSentenceLines(seg, hours)}`;
  });
  return {
    text: [
      `<transcript_excerpts note="Only these parts of the video were selected for this question; the rest was not read.">`,
      ...parts,
      `</transcript_excerpts>`,
    ].join('\n'),
    windows: chosen.length,
    slices: slices.length,
    fallback,
  };
}

const RETRIEVAL_JSON_SCHEMA = toJsonSchema(retrievalSchema);

const clampRel = (r: number) => (Number.isFinite(r) ? Math.min(10, Math.max(1, r)) : 1);

/**
 * Most relevant windows first, each widened by a small margin, until the excerpt budget is used;
 * overlapping/adjacent windows are merged; the result is chronological.
 */
export function selectWindows(
  windows: readonly Window[],
  sentences: readonly Sentence[],
  hours: boolean,
): Window[] {
  const picked: Window[] = [];
  let tokens = 0;
  const widen = (w: Window): Window => ({
    ...w,
    i0: Math.max(0, w.i0 - MARGIN),
    i1: Math.min(sentences.length - 1, w.i1 + MARGIN),
  });
  for (const w of [...windows].sort((x, y) => y.relevance - x.relevance || x.i0 - y.i0)) {
    const ww = widen(w);
    const cost = estimateTokens(formatSentenceLines(sentences.slice(ww.i0, ww.i1 + 1), hours));
    if (tokens + cost > EXCERPT_TOKEN_BUDGET) continue;
    tokens += cost;
    picked.push(ww);
  }
  picked.sort((x, y) => x.i0 - y.i0);
  const merged: Window[] = [];
  for (const w of picked) {
    const prev = merged[merged.length - 1];
    if (prev && w.i0 <= prev.i1 + 1) {
      prev.i1 = Math.max(prev.i1, w.i1);
      prev.relevance = Math.max(prev.relevance, w.relevance);
    } else merged.push({ ...w });
  }
  return merged;
}

const STOP = new Set(
  'the and for are was were you your with that this have from they what when where which who whom how why about into than then them there their can could would should will not but all any out has had his her its our did does done say said tell video part show find'.split(
    ' ',
  ),
);

/** Keyword windows (no model): used only when the Haiku retrieval call failed. */
export function lexicalWindows(question: string, sentences: readonly Sentence[]): Window[] {
  const terms = [
    ...new Set(
      normalizeForMatch(question)
        .split(' ')
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  ];
  if (terms.length === 0 || sentences.length === 0) return [];
  const df = new Map<string, number>();
  const norm = sentences.map((s) => normalizeForMatch(s.text));
  for (const t of terms) df.set(t, norm.filter((n) => n.includes(t)).length);
  const score = norm.map((n) =>
    terms.reduce((a, t) => a + (n.includes(t) ? 1 / Math.log(2 + (df.get(t) ?? 0)) : 0), 0),
  );
  const RADIUS = 5;
  const win = score.map((_, i) => {
    let sum = 0;
    for (let j = Math.max(0, i - RADIUS); j <= Math.min(score.length - 1, i + RADIUS); j++)
      sum += score[j]!;
    return sum;
  });
  const order = win
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);
  const out: Window[] = [];
  for (const { v, i } of order) {
    if (out.length >= 4) break;
    if (out.some((w) => i >= w.i0 - RADIUS && i <= w.i1 + RADIUS)) continue;
    out.push({
      i0: Math.max(0, i - RADIUS),
      i1: Math.min(sentences.length - 1, i + RADIUS),
      relevance: Math.min(10, 3 + v * 2),
    });
  }
  return out;
}
