import { durationRange, rankedMomentSchema, totalScore } from '@shared/pipeline';
import type { MomentCandidate, RankedMoment, Sentence } from '@shared/pipeline';
import type { LlmService } from '../../pipeline/contracts';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError } from './errors';
import { buildRankStable, buildRankVolatile, RANK_SYSTEM } from './prompts';
import { rankOutputSchema, toJsonSchema, type ModelMoment } from './schemas';
import { clamp } from './transcript';

/**
 * rankMoments — the core of the product.
 *
 * The model chooses SENTENCE IDS; this file turns them into seconds and then verifies every moment
 * (span inside the window, duration in range, no mid-sentence cuts, no overlaps, scores within the
 * rubric caps, text limits). Invalid moments are dropped with a logged reason; nothing is padded.
 *
 * Effort: 'medium' for ranking (needs real judgement about arcs and hooks, but a window is short
 * so thinking stays small), 'low' in budget mode. These are DESIGN choices, not measured results -
 * see the report: the effort sweep needs a real key and labelled data.
 */

const RANK_EFFORT = 'medium' as const;
const MAX_PROMPT_CANDIDATES = 30;
const MAX_TITLE = 60;
const MAX_HOOK_WORDS = 10;
const MAX_KEYWORDS = 8;
const CAPS = { hook: 25, retention: 25, emotion: 20, clarity: 15, shareability: 15 } as const;

export interface RankContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelSmart: string }>;
  log: (m: string) => void;
}

type RankInput = Parameters<LlmService['rankMoments']>[0];

export async function runRank(ctx: RankContext, input: RankInput): Promise<RankedMoment[]> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  const sentences = input.sentences
    .filter((s) => s.text.trim().length > 0)
    .sort((a, b) => a.s - b.s);
  if (sentences.length === 0 || input.maxClips < 1) return [];

  const settings = await ctx.getSettings();
  const status = await ctx.budget.peek(); // throws BudgetExceededError at the hard cap
  const frugal = status.level === 'over-target';
  const range = durationRange(input.options);
  const maxClips = frugal ? Math.max(1, Math.ceil(input.maxClips / 2)) : input.maxClips;

  const candidates = pickPromptCandidates(input.candidates, input.window, frugal);
  if (frugal) {
    ctx.log(
      `rankMoments: over monthly target - effort low, ${candidates.length} candidates, maxClips ${input.maxClips}->${maxClips}`,
    );
  }

  const hours = input.window.endSec >= 3600;
  const stable = buildRankStable({
    title: input.info.title,
    channel: input.info.channel,
    summary: input.analysis?.overview.summary ?? null,
    tone: input.analysis?.overview.tone ?? null,
    topics: input.analysis?.topics ?? [],
    windowStartSec: input.window.startSec,
    windowEndSec: input.window.endSec,
    sentences,
  });
  const volatile = buildRankVolatile({
    steering: input.options.prompt,
    minSec: range.minSec,
    maxSec: range.maxSec,
    maxClips,
    candidates,
    hours,
    frugal,
  });

  const verifyArgs = {
    sentences,
    window: input.window,
    range,
    candidates: input.candidates,
    maxClips,
  };

  const out = await ctx.engine.run({
    model: settings.modelSmart,
    purpose: 'moments',
    system: RANK_SYSTEM,
    stable,
    volatile,
    schema: rankOutputSchema,
    jsonSchema: RANK_JSON_SCHEMA,
    effort: frugal ? 'low' : RANK_EFFORT,
    maxTokens: 32_000,
    expectedOutputChars: 350 + maxClips * 650,
    estimatedOutputTokens: 2_000 + maxClips * 350,
    signal: input.signal,
    onProgress: input.onProgress,
    validate: (parsed, { finalAttempt }) => {
      if (finalAttempt || parsed.moments.length === 0) return null;
      const r = verifyMoments({ ...verifyArgs, raw: parsed.moments, log: () => {} });
      if (r.moments.length > 0) return null;
      return (
        'none of your moments passed the checks: ' +
        r.rejected
          .slice(0, 5)
          .map((x) => `moment ${x.index + 1}: ${x.reason}`)
          .join('; ') +
        `. Use the sentence numbers from the transcript and respect ${range.minSec}-${range.maxSec} seconds.`
      );
    },
  });

  const verified = verifyMoments({ ...verifyArgs, raw: out.moments, log: ctx.log });
  if (verified.moments.length === 0) {
    ctx.log(
      `rankMoments: 0 moments for window ${Math.round(input.window.startSec)}-${Math.round(input.window.endSec)}s` +
        (out.windowNotes ? ` (model: ${out.windowNotes.slice(0, 200)})` : ''),
    );
  }
  return verified.moments;
}

const RANK_JSON_SCHEMA = toJsonSchema(rankOutputSchema);

/** Top candidates by heuristic prior, shown chronologically. Budget mode halves the list. */
export function pickPromptCandidates(
  all: readonly MomentCandidate[],
  window: { startSec: number; endSec: number },
  frugal: boolean,
): MomentCandidate[] {
  const seen = new Set<string>();
  const inWindow = all.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return c.e > c.s && c.s >= window.startSec - 1 && c.e <= window.endSec + 1;
  });
  const cap = frugal
    ? Math.ceil(Math.min(inWindow.length, MAX_PROMPT_CANDIDATES) / 2)
    : MAX_PROMPT_CANDIDATES;
  return [...inWindow]
    .sort((a, b) => b.prior - a.prior)
    .slice(0, cap)
    .sort((a, b) => a.s - b.s);
}

/* --------------------------------------------- verification --------------------------------------------- */

export interface VerifyArgs {
  raw: readonly ModelMoment[];
  /** Window sentences sorted by time. */
  sentences: readonly Sentence[];
  window: { startSec: number; endSec: number };
  range: { minSec: number; maxSec: number };
  candidates: readonly MomentCandidate[];
  maxClips: number;
  log: (m: string) => void;
}

export interface VerifyResult {
  moments: RankedMoment[];
  rejected: { index: number; reason: string }[];
}

const TERMINAL = /[.!?…]["'”’)\]]*$/u;
const endsComplete = (t: string) => TERMINAL.test(t.trim());
const startsLower = (t: string) => /^\p{Ll}/u.test(t.trim());

/** Allowed deviation from the duration range (the caller re-snaps with word padding anyway). */
export function durationTolerance(range: { minSec: number; maxSec: number }): number {
  return clamp(range.maxSec * 0.1, 2, 5);
}

export function verifyMoments(a: VerifyArgs): VerifyResult {
  const { sentences, range } = a;
  const tol = durationTolerance(range);
  const indexById = new Map<number, number>();
  sentences.forEach((s, i) => indexById.set(s.id, i));
  const candById = new Map(a.candidates.map((c) => [c.id, c] as const));

  const rejected: VerifyResult['rejected'] = [];
  const reject = (index: number, reason: string) => {
    rejected.push({ index, reason });
    a.log(`rankMoments: dropped moment ${index + 1}: ${reason}`);
  };

  type Ok = { m: RankedMoment; i0: number; i1: number; total: number };
  const ok: Ok[] = [];

  a.raw.forEach((raw, index) => {
    // ---- 1. sentence ids -> indices (fall back to the candidate's own span when ids are bad)
    let i0 = indexById.get(raw.startSentence);
    let i1 = indexById.get(raw.endSentence);
    const cand = raw.candidateId ? candById.get(raw.candidateId) : undefined;
    if ((i0 === undefined || i1 === undefined) && cand) {
      const f = indexById.get(cand.sentenceIds[0] ?? NaN);
      const l = indexById.get(cand.sentenceIds[cand.sentenceIds.length - 1] ?? NaN);
      if (f !== undefined && l !== undefined) {
        a.log(
          `rankMoments: moment ${index + 1} had unknown sentence ids; using candidate ${cand.id}'s span`,
        );
        i0 = f;
        i1 = l;
      }
    }
    if (i0 === undefined || i1 === undefined)
      return reject(
        index,
        `unknown sentence id (S${raw.startSentence}-S${raw.endSentence}) - not in this window`,
      );
    if (i0 > i1)
      return reject(
        index,
        `start sentence S${raw.startSentence} comes after end S${raw.endSentence}`,
      );

    const dur = (x: number, y: number) => (sentences[y]?.e ?? 0) - (sentences[x]?.s ?? 0);

    // ---- 2. never start/end in the middle of a sentence (ASR splits on pauses too)
    for (let n = 0; n < 2; n++) {
      const first = sentences[i0]!;
      const prev = sentences[i0 - 1];
      if (
        prev &&
        startsLower(first.text) &&
        !endsComplete(prev.text) &&
        dur(i0 - 1, i1) <= range.maxSec + tol
      )
        i0--;
      else break;
    }
    for (let n = 0; n < 2; n++) {
      const last = sentences[i1]!;
      const next = sentences[i1 + 1];
      if (
        next &&
        !endsComplete(last.text) &&
        startsLower(next.text) &&
        dur(i0, i1 + 1) <= range.maxSec + tol
      )
        i1++;
      else break;
    }
    const firstS = sentences[i0]!;
    const lastS = sentences[i1]!;
    if (sentences[i0 - 1] && startsLower(firstS.text) && !endsComplete(sentences[i0 - 1]!.text))
      return reject(index, 'starts in the middle of a sentence');
    if (sentences[i1 + 1] && !endsComplete(lastS.text) && startsLower(sentences[i1 + 1]!.text))
      return reject(index, 'ends in the middle of a sentence');

    // ---- 3. window + duration
    const startSec = firstS.s;
    const endSec = lastS.e;
    const d = endSec - startSec;
    if (startSec < a.window.startSec - 1 || endSec > a.window.endSec + 1)
      return reject(
        index,
        `span ${startSec.toFixed(1)}-${endSec.toFixed(1)}s lies outside the window`,
      );
    if (d < range.minSec - tol || d > range.maxSec + tol)
      return reject(
        index,
        `duration ${d.toFixed(1)}s is outside ${range.minSec}-${range.maxSec}s (±${tol.toFixed(0)}s)`,
      );

    // ---- 4. text fields
    const title = fitTitle(raw.title);
    const hook = fitHook(raw.hook);
    const why = raw.whyItWorks.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!title) return reject(index, 'empty title');
    if (!hook) return reject(index, 'empty hook');
    if (title !== raw.title.trim())
      a.log(`rankMoments: moment ${index + 1} title shortened to ${MAX_TITLE} chars`);

    // ---- 5. scores: clamp to the rubric caps
    const sc = raw.scores;
    const breakdown = {
      hook: capScore(sc.hook, CAPS.hook),
      retention: capScore(sc.retention, CAPS.retention),
      emotion: capScore(sc.emotion, CAPS.emotion),
      clarity: capScore(sc.clarity, CAPS.clarity),
      shareability: capScore(sc.shareability, CAPS.shareability),
    };
    for (const k of Object.keys(CAPS) as (keyof typeof CAPS)[]) {
      if (sc[k] > CAPS[k] + 0.5 || sc[k] < -0.5)
        a.log(`rankMoments: moment ${index + 1} ${k} score ${sc[k]} clamped to 0-${CAPS[k]}`);
    }

    const spanText = sentences
      .slice(i0, i1 + 1)
      .map((s) => s.text)
      .join(' ');
    const parsed = rankedMomentSchema.safeParse({
      candidateId: cand ? cand.id : null,
      startSec,
      endSec,
      title,
      hook,
      whyItWorks: why,
      captionStyle: 'clean-pop',
      breakdown,
      confidence: normConfidence(raw.confidence),
      keywords: cleanKeywords(raw.keywords, spanText),
    });
    if (!parsed.success)
      return reject(index, `invalid after normalisation: ${parsed.error.message.slice(0, 120)}`);
    ok.push({ m: parsed.data, i0, i1, total: totalScore(breakdown) });
  });

  // ---- 6. best first; drop overlaps (the lower-scored one loses) and anything beyond maxClips
  ok.sort(
    (x, y) => y.total - x.total || y.m.confidence - x.m.confidence || x.m.startSec - y.m.startSec,
  );
  const kept: Ok[] = [];
  for (const cur of ok) {
    const clash = kept.find(
      (k) => cur.m.startSec < k.m.endSec - 0.05 && k.m.startSec < cur.m.endSec - 0.05,
    );
    if (clash) {
      a.log(
        `rankMoments: dropped "${cur.m.title}" (${cur.m.startSec.toFixed(0)}-${cur.m.endSec.toFixed(0)}s): overlaps higher-scored "${clash.m.title}"`,
      );
      continue;
    }
    if (kept.length >= a.maxClips) {
      a.log(`rankMoments: dropped "${cur.m.title}": beyond maxClips (${a.maxClips})`);
      continue;
    }
    kept.push(cur);
  }
  return { moments: kept.map((k) => k.m), rejected };
}

/* ------------------------------------------------ helpers ------------------------------------------------ */

function capScore(v: number, cap: number): number {
  return Number.isFinite(v) ? Math.round(clamp(v, 0, cap)) : 0;
}

function normConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return clamp(c > 1 && c <= 100 ? c / 100 : c, 0, 1);
}

const QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;

export function fitTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().replace(QUOTES, '').trim();
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:\-–—]+$/u, '');
  return `${base}…`;
}

export function fitHook(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim().replace(QUOTES, '').trim();
  const words = t.split(' ').filter(Boolean);
  if (words.length <= MAX_HOOK_WORDS) return t;
  return `${words
    .slice(0, MAX_HOOK_WORDS)
    .join(' ')
    .replace(/[\s,;:\-–—]+$/u, '')}…`;
}

const stripEdges = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Emphasis words: single tokens that really occur in the clip text, deduplicated. */
export function cleanKeywords(raw: readonly string[], spanText: string): string[] {
  const spoken = new Set(spanText.split(/\s+/).map(stripEdges).filter(Boolean));
  const out: string[] = [];
  for (const k of raw) {
    for (const tok of k.split(/\s+/).map(stripEdges)) {
      if (tok && spoken.has(tok) && !out.includes(tok)) out.push(tok);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}
