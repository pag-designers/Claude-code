import type { Chapter, Sentence, VideoAnalysis } from '@shared/pipeline';
import { videoAnalysisSchema } from '@shared/pipeline';
import type { LlmService } from '../../pipeline/contracts';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import {
  buildUnderstandStable,
  buildUnderstandVolatile,
  targetChapterCount,
  UNDERSTAND_SYSTEM,
} from './prompts';
import {
  toJsonSchema,
  understandAiSchema,
  understandYtSchema,
  type UnderstandAiOutput,
  type UnderstandYtOutput,
} from './schemas';
import { buildSentenceIndex, clamp, estimateTokens, locateQuote } from './transcript';

/**
 * understand() — overview, chapters, notes, topics/entities/keywords for the whole video.
 *
 * Effort 'low': summarising/extracting a transcript does not need deep deliberation, and one call
 * per video makes this the cheap part of the pipeline. Chapters are positioned by SENTENCE ID and
 * derived end = next start, so they always cover the video with no gaps or overlaps. Uploader
 * (YouTube) chapters are kept verbatim (source: 'youtube'); the model only adds summaries.
 */

const UNDERSTAND_EFFORT = 'low' as const;
/** Chapters shorter than this are merged into the previous one (unless the video itself is tiny). */
const MIN_CHAPTER_SEC = 10;
/** Haiku 5.5 bills a higher rate card above 100K prompt tokens; cost.ts prices the cheap one only. */
const HAIKU_CHEAP_RATE_PROMPT_TOKENS = 100_000;

export interface UnderstandContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelSmart: string; modelFast: string }>;
  log: (m: string) => void;
}

type UnderstandInput = Parameters<LlmService['understand']>[0];

export async function runUnderstand(
  ctx: UnderstandContext,
  input: UnderstandInput,
): Promise<VideoAnalysis> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  const sentences = input.transcript.sentences
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.s - b.s);
  if (sentences.length === 0) {
    throw new LlmError(
      'empty-transcript',
      'No speech was found in this video, so there is nothing to analyse.',
    );
  }
  const durationSec = Math.max(
    input.transcript.durationSec,
    sentences[sentences.length - 1]?.e ?? 0,
  );

  const settings = await ctx.getSettings();
  const status = await ctx.budget.peek(); // throws BudgetExceededError at the hard cap

  const yt = sanitizeYoutubeChapters(input.info.chapters, durationSec);
  const stable = buildUnderstandStable({
    title: input.info.title,
    channel: input.info.channel,
    description: input.info.description,
    durationSec,
    sentences,
    youtubeChapters: yt,
  });
  const volatile = buildUnderstandVolatile({ durationSec, youtubeChapterCount: yt.length });

  // Over the monthly target: this low-value task moves to the fast model - unless the prompt is so
  // large that Haiku's higher (>100K tokens) rate card, which cost.ts does not model, would apply.
  let model = settings.modelSmart;
  if (status.level === 'over-target') {
    if (estimateTokens(stable) < HAIKU_CHEAP_RATE_PROMPT_TOKENS) {
      model = settings.modelFast;
      ctx.log(`understand: over monthly target - using ${model}`);
    } else {
      ctx.log(
        'understand: over monthly target but prompt >100K tokens; staying on the smart model',
      );
    }
  }

  const expectedChars =
    5_500 + (yt.length ? yt.length * 250 : targetChapterCount(durationSec) * 400);
  const common = {
    model,
    purpose: 'understand',
    system: UNDERSTAND_SYSTEM,
    stable,
    volatile,
    effort: UNDERSTAND_EFFORT,
    maxTokens: 32_000,
    expectedOutputChars: expectedChars,
    estimatedOutputTokens: Math.ceil(expectedChars / 3),
    signal: input.signal,
    onProgress: input.onProgress,
  };

  if (yt.length > 0) {
    const out = await ctx.engine.run<UnderstandYtOutput>({
      ...common,
      schema: understandYtSchema,
      jsonSchema: YT_JSON_SCHEMA,
      validate: (p) => {
        const have = new Set(p.chapterSummaries.map((c) => c.index));
        const missing = yt.map((_, i) => i).filter((i) => !have.has(i));
        return missing.length
          ? `chapterSummaries is missing chapter indices ${missing.join(', ')}`
          : null;
      },
    });
    const byIndex = new Map(out.chapterSummaries.map((c) => [c.index, c.summary.trim()] as const));
    const chapters: Chapter[] = yt.map((c, i) => ({
      title: c.title,
      start: c.start,
      end: c.end,
      summary: byIndex.get(i) ?? '',
      source: 'youtube',
    }));
    return assemble(out, chapters, sentences, ctx.log);
  }

  const out = await ctx.engine.run<UnderstandAiOutput>({
    ...common,
    schema: understandAiSchema,
    jsonSchema: AI_JSON_SCHEMA,
    validate: (p) =>
      deriveAiChapters(p.chapters, sentences, durationSec, () => {}).length === 0
        ? 'none of the chapters has a valid startSentence from the transcript'
        : null,
  });
  const chapters = deriveAiChapters(out.chapters, sentences, durationSec, ctx.log);
  return assemble(out, chapters, sentences, ctx.log);
}

const AI_JSON_SCHEMA = toJsonSchema(understandAiSchema);
const YT_JSON_SCHEMA = toJsonSchema(understandYtSchema);

/* ---------------------------------------------- chapters ---------------------------------------------- */

/** Clamp/sort/trim uploader chapters; drop degenerate ones. Titles and times are kept as given. */
export function sanitizeYoutubeChapters(
  chapters: readonly { title: string; start: number; end: number }[],
  durationSec: number,
): { title: string; start: number; end: number }[] {
  return chapters
    .map((c) => ({
      title: c.title.replace(/\s+/g, ' ').trim(),
      start: clamp(c.start, 0, durationSec),
      end: clamp(c.end, 0, durationSec),
    }))
    .filter((c) => c.title && c.end > c.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * AI chapters from sentence ids: start = that sentence's start, end = next chapter's start (last:
 * video end), first chapter pinned to 0. Unknown / non-increasing ids and slivers are dropped.
 */
export function deriveAiChapters(
  raw: readonly { title: string; startSentence: number; summary: string }[],
  sentences: readonly Sentence[],
  durationSec: number,
  log: (m: string) => void,
): Chapter[] {
  const byId = new Map(sentences.map((s) => [s.id, s] as const));
  const picked: { title: string; start: number; summary: string }[] = [];
  for (const c of raw) {
    const s = byId.get(c.startSentence);
    const title = c.title.replace(/\s+/g, ' ').trim();
    if (!s || !title) {
      log(`understand: dropped chapter "${title}" (unknown sentence S${c.startSentence})`);
      continue;
    }
    picked.push({ title, start: s.s, summary: c.summary.trim() });
  }
  picked.sort((a, b) => a.start - b.start);

  const minLen = Math.min(MIN_CHAPTER_SEC, durationSec / 6);
  const merged: { title: string; start: number; summary: string }[] = [];
  for (const c of picked) {
    const prev = merged[merged.length - 1];
    if (prev && c.start - prev.start < minLen) {
      log(`understand: merged chapter "${c.title}" into "${prev.title}" (too short)`);
      continue;
    }
    merged.push({ ...c });
  }
  const first = merged[0];
  if (first) first.start = 0;

  return merged.map((c, i) => ({
    title: c.title,
    start: c.start,
    end: i + 1 < merged.length ? merged[i + 1]!.start : durationSec,
    summary: c.summary,
    source: 'ai' as const,
  }));
}

/* ----------------------------------------------- assemble ----------------------------------------------- */

type Common = UnderstandAiOutput | UnderstandYtOutput;

const uniq = (xs: readonly string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
};

function assemble(
  out: Common,
  chapters: Chapter[],
  sentences: readonly Sentence[],
  log: (m: string) => void,
): VideoAnalysis {
  const idx = buildSentenceIndex(sentences);
  const posById = new Map(sentences.map((s, i) => [s.id, i] as const));
  const atId = (id: number) => sentences[posById.get(id) ?? -1];

  // Quotes must be verbatim: relocate to where the text really is, drop what is not in the video.
  const quotes: { text: string; at: number }[] = [];
  for (const q of out.notes.quotes) {
    const text = q.text.replace(/\s+/g, ' ').trim();
    const hit = locateQuote(idx, text, posById.get(q.sentence) ?? 0);
    if (!hit) {
      log(`understand: dropped quote not found verbatim in the transcript: "${text.slice(0, 60)}"`);
      continue;
    }
    quotes.push({ text, at: hit.s });
    if (quotes.length >= 8) break;
  }
  const refs = (items: readonly { text: string; sentence: number }[], max: number) => {
    const res: { text: string; at: number }[] = [];
    for (const it of items) {
      const s = atId(it.sentence);
      const text = it.text.replace(/\s+/g, ' ').trim();
      if (!s || !text) continue;
      res.push({ text, at: s.s });
      if (res.length >= max) break;
    }
    return res;
  };

  return videoAnalysisSchema.parse({
    overview: {
      summary: out.overview.summary.trim(),
      tone: out.overview.tone.trim(),
      participants: uniq(out.overview.participants, 12),
      takeaways: uniq(out.overview.takeaways, 5),
    },
    chapters,
    notes: {
      keyPoints: uniq(out.notes.keyPoints, 12),
      quotes,
      numbers: refs(out.notes.numbers, 10),
      claims: refs(out.notes.claims, 8),
      actionItems: uniq(out.notes.actionItems, 8),
    },
    topics: uniq(out.topics, 8),
    entities: uniq(out.entities, 15),
    keywords: uniq(out.keywords, 12),
  });
}
