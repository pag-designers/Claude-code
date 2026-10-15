import type { HighlightPlan } from '@shared/cp2';
import type { Sentence } from '@shared/pipeline';
import type { HighlightCandidate, LlmServiceV2 } from '../../pipeline/contracts2';
import type { BudgetGuard } from './budget';
import type { LlmEngine } from './client';
import { abortError, LlmError } from './errors';
import { fitHook, fitTitle } from './moments';
import { buildHighlightStable, buildHighlightVolatile, HIGHLIGHT_SYSTEM } from './prompts2';
import { modelHighlightSchema, type ModelHighlight } from './schemas2';
import { toJsonSchema } from './schemas';
import { estimateTokens } from './transcript';

/**
 * composeHighlights - One-Click Highlights (BRIEF §4.6).
 *
 * The model picks SENTENCE ids per segment and the NARRATIVE ORDER; this file turns them into seconds
 * and deterministically enforces what a prompt cannot guarantee: every segment lies inside ONE
 * candidate, 8-25 s each (trimmed / extended with neighbouring sentences of that candidate), no
 * overlap, 2-5 segments, total inside [minSec, maxSec]. Nothing is padded with invented material: when
 * the candidates cannot reach the minimum, the call fails with a clear error instead.
 *
 * Effort 'medium': ordering beats into a story is real judgement (unlike extraction), the input is
 * small (a few thousand tokens) so thinking stays cheap; budget mode drops to 'low'. A design choice,
 * not a measurement.
 */

const HIGHLIGHT_EFFORT = 'medium' as const;
export const SEG_MIN_SEC = 8;
export const SEG_MAX_SEC = 25;
const MAX_SEGMENTS = 5;
const MIN_SEGMENTS = 2;
const MAX_CANDIDATES = 24;
/** The caller word-aligns each cut with up to ~250 ms padding on both sides. */
const PAD_PER_SEGMENT_SEC = 0.5;

export interface HighlightContext {
  engine: LlmEngine;
  budget: BudgetGuard;
  getSettings: () => Promise<{ modelSmart: string; modelFast: string }>;
  log: (m: string) => void;
}

type HighlightInput = Parameters<LlmServiceV2['composeHighlights']>[0];

export async function runHighlights(
  ctx: HighlightContext,
  input: HighlightInput,
): Promise<HighlightPlan> {
  ctx.engine.assertConfigured();
  if (input.signal?.aborted) throw abortError(input.signal);
  const { minSec, maxSec } = input;
  if (!(minSec > 0) || !(maxSec > minSec) || maxSec < SEG_MIN_SEC * MIN_SEGMENTS) {
    throw new LlmError(
      'bad-request',
      `Highlight length ${minSec}-${maxSec} s is not usable (need at least ${SEG_MIN_SEC * MIN_SEGMENTS} s).`,
    );
  }
  let candidates = input.candidates
    .map((c) => ({ ...c, sentences: c.sentences.filter((s) => s.text.trim().length > 0) }))
    .filter((c) => c.sentences.length > 0);
  if (candidates.length === 0) {
    throw new LlmError(
      'empty-transcript',
      'There are no clips with speech to build a highlight reel from.',
    );
  }
  if (candidates.length > MAX_CANDIDATES) {
    ctx.log(
      `highlights: ${candidates.length} candidates; keeping the ${MAX_CANDIDATES} best-scored`,
    );
    candidates = [...candidates]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MAX_CANDIDATES);
  }
  candidates.sort((a, b) => a.startSec - b.startSec);

  const settings = await ctx.getSettings();
  const status = await ctx.budget.peek(); // throws BudgetExceededError at the hard cap
  const frugal = status.level === 'over-target';
  if (frugal) ctx.log('highlights: over monthly target - effort low');

  const stable = buildHighlightStable({
    title: input.info.title,
    channel: input.info.channel,
    summary: input.analysis?.overview.summary ?? null,
    topics: input.analysis?.topics ?? [],
    candidates,
  });
  const volatile = buildHighlightVolatile({ steering: input.prompt, minSec, maxSec, frugal });

  const out = await ctx.engine.run<ModelHighlight>({
    model: settings.modelSmart,
    purpose: 'highlights',
    system: HIGHLIGHT_SYSTEM,
    stable,
    volatile,
    schema: modelHighlightSchema,
    jsonSchema: HIGHLIGHT_JSON_SCHEMA,
    effort: frugal ? 'low' : HIGHLIGHT_EFFORT,
    maxTokens: 16_000,
    expectedOutputChars: 1_800,
    estimatedOutputTokens: 1_500,
    signal: input.signal,
    onProgress: input.onProgress,
    validate: (parsed, { finalAttempt }) => {
      if (finalAttempt) return null; // the deterministic fixer below gets the last word
      const r = assembleHighlight(parsed, candidates, { minSec, maxSec, log: () => {} });
      return r.problems.length
        ? `${r.problems.slice(0, 4).join('; ')}. Use only sentence numbers of ONE candidate per micro-moment, 8-25 seconds each, no overlaps, total ${Math.round(minSec)}-${Math.round(maxSec)} seconds.`
        : null;
    },
  });

  const r = assembleHighlight(out, candidates, { minSec, maxSec, log: ctx.log });
  if (!r.plan) {
    throw new LlmError(
      'invalid-output',
      `Could not build a ${Math.round(minSec)}-${Math.round(maxSec)} s highlight from these clips: ${r.problems.join('; ') || 'no usable segments'}.`,
    );
  }
  return r.plan;
}

const HIGHLIGHT_JSON_SCHEMA = toJsonSchema(modelHighlightSchema);

/** Rough prompt size, for cost previews. */
export function estimateHighlightTokens(
  candidates: readonly HighlightCandidate[],
  info: { title: string; channel: string | null },
): number {
  return (
    estimateTokens(HIGHLIGHT_SYSTEM) +
    estimateTokens(
      buildHighlightStable({
        title: info.title,
        channel: info.channel,
        summary: null,
        topics: [],
        candidates,
      }),
    )
  );
}

/* ------------------------------------------- deterministic assembly ------------------------------------------ */

interface Seg {
  cand: HighlightCandidate & { sentences: Sentence[] };
  /** Inclusive indices into cand.sentences. */
  i0: number;
  i1: number;
  role: string;
}

export interface AssembleResult {
  plan: HighlightPlan | null;
  /** Reasons segments were dropped or the plan could not be completed. */
  problems: string[];
}

const TERMINAL = /[.!?…]["'”’)\]]*$/u;
const endsComplete = (t: string) => TERMINAL.test(t.trim());

const dur = (s: Seg) => (s.cand.sentences[s.i1]?.e ?? 0) - (s.cand.sentences[s.i0]?.s ?? 0);
const ids = (s: Seg) => s.cand.sentences.slice(s.i0, s.i1 + 1).map((x) => x.id);

export function assembleHighlight(
  raw: ModelHighlight,
  candidates: readonly HighlightCandidate[],
  o: { minSec: number; maxSec: number; log: (m: string) => void },
): AssembleResult {
  const problems: string[] = [];
  const byId = new Map(candidates.map((c) => [c.id, c] as const));
  const kept: Seg[] = [];
  /** True when `sentence` is already used by a kept beat other than `except` (same id or same time). */
  const taken = (sentence: Sentence, except: Seg | null) =>
    kept.some((k) => {
      if (k === except) return false;
      const first = k.cand.sentences[k.i0]!.s;
      const last = k.cand.sentences[k.i1]!.e;
      return (
        ids(k).includes(sentence.id) || (sentence.s < last - 0.05 && first < sentence.e - 0.05)
      );
    });

  raw.segments.forEach((r, n) => {
    const label = `segment ${n + 1}`;
    let cand = byId.get(r.candidateId);
    const find = (c: HighlightCandidate | undefined, id: number) =>
      c ? c.sentences.findIndex((x) => x.id === id) : -1;
    if (!cand || find(cand, r.startSentence) < 0 || find(cand, r.endSentence) < 0) {
      // The model mislabelled the candidate: accept a candidate that contains both sentences.
      const alt = candidates.find(
        (c) => find(c, r.startSentence) >= 0 && find(c, r.endSentence) >= 0,
      );
      if (!alt) {
        problems.push(
          `${label}: sentences S${r.startSentence}-S${r.endSentence} are not inside one candidate`,
        );
        return;
      }
      if (cand)
        o.log(`highlights: ${label} named candidate ${cand.id} but its sentences are in ${alt.id}`);
      cand = alt;
    }
    const sentences = cand.sentences.filter((x) => x.text.trim().length > 0);
    const c = { ...cand, sentences };
    const i0 = sentences.findIndex((x) => x.id === r.startSentence);
    const i1 = sentences.findIndex((x) => x.id === r.endSentence);
    if (i0 < 0 || i1 < 0 || i0 > i1) {
      problems.push(
        `${label}: start S${r.startSentence} must not come after end S${r.endSentence}`,
      );
      return;
    }
    const seg: Seg = { cand: c, i0, i1, role: cleanLine(r.role, 120) };

    // 1. never reuse a sentence / overlap an earlier beat: trim the overlapping edges
    const clashes = (x: Sentence) => taken(x, null);
    while (seg.i0 <= seg.i1 && clashes(sentences[seg.i0]!)) seg.i0++;
    while (seg.i1 >= seg.i0 && clashes(sentences[seg.i1]!)) seg.i1--;
    if (seg.i0 > seg.i1 || sentences.slice(seg.i0, seg.i1 + 1).some(clashes)) {
      problems.push(`${label}: overlaps an earlier micro-moment`);
      return;
    }
    // 2. 8-25 s
    const fitted = fitSegment(seg, clashes);
    if (typeof fitted === 'string') {
      problems.push(`${label}: ${fitted}`);
      return;
    }
    if (fitted.i0 !== seg.i0 || fitted.i1 !== seg.i1)
      o.log(
        `highlights: ${label} adjusted to ${dur(fitted).toFixed(1)}s (${SEG_MIN_SEC}-${SEG_MAX_SEC}s rule)`,
      );
    kept.push(fitted);
  });

  // 3. at most 5: drop the weakest beat that is neither the opener nor the closer
  while (kept.length > MAX_SEGMENTS) {
    const idx = weakestInner(kept);
    o.log(`highlights: more than ${MAX_SEGMENTS} segments; dropped "${kept[idx]!.role}"`);
    kept.splice(idx, 1);
  }

  // 4. total length inside [minSec, maxSec]
  const total = () => kept.reduce((a, x) => a + dur(x), 0);
  const maxEff = () => o.maxSec - PAD_PER_SEGMENT_SEC * kept.length;

  // too long: shorten the longest beat (keeping >= 8 s), else drop the weakest inner beat
  for (let guard = 0; total() > maxEff() && guard < 80; guard++) {
    const shrinkable = kept
      .map((x, idx) => ({ idx, next: shrinkOne(x, SEG_MIN_SEC), len: dur(x) }))
      .filter((x): x is { idx: number; next: Seg; len: number } => x.next !== null)
      .sort((a, b) => b.len - a.len)[0];
    if (shrinkable) {
      kept[shrinkable.idx] = shrinkable.next;
      continue;
    }
    if (kept.length > MIN_SEGMENTS) {
      const idx = weakestInner(kept);
      o.log(`highlights: total over ${o.maxSec}s; dropped "${kept[idx]!.role}"`);
      kept.splice(idx, 1);
      continue;
    }
    break;
  }
  // too short: extend beats with neighbouring sentences of their own candidate
  for (let guard = 0; total() < o.minSec && guard < 200; guard++) {
    const extendable = kept
      .map((x, idx) => ({ idx, next: extendOne(x, (y) => taken(y, x)), len: dur(x) }))
      .filter(
        (x): x is { idx: number; next: Seg; len: number } =>
          x.next !== null && dur(x.next) <= SEG_MAX_SEC,
      )
      .sort((a, b) => a.len - b.len)[0];
    if (!extendable) break;
    kept[extendable.idx] = extendable.next;
  }

  const sum = total();
  if (kept.length < MIN_SEGMENTS) {
    problems.push(
      `only ${kept.length} usable micro-moment${kept.length === 1 ? '' : 's'} (need at least ${MIN_SEGMENTS})`,
    );
    return { plan: null, problems };
  }
  if (sum < o.minSec || sum > maxEff() + 1e-6) {
    problems.push(
      `total length ${sum.toFixed(0)} s cannot be brought inside ${Math.round(o.minSec)}-${Math.round(o.maxSec)} s with the clips available`,
    );
    return { plan: null, problems };
  }

  const title = fitTitle(raw.title);
  const hook = fitHook(raw.hook);
  if (!title || !hook) {
    problems.push('the title or hook was empty');
    return { plan: null, problems };
  }
  return {
    plan: {
      title,
      hook,
      segments: kept.map((x) => ({
        startSec: x.cand.sentences[x.i0]!.s,
        endSec: x.cand.sentences[x.i1]!.e,
        role: x.role || 'Beat',
      })),
      transition: raw.transition,
      whyItWorks: cleanLine(raw.whyItWorks, 700),
    },
    problems,
  };
}

/** Brings one segment into 8-25 s; returns the adjusted segment or the reason it is unusable. */
function fitSegment(seg0: Seg, blocked: (s: Sentence) => boolean): Seg | string {
  let seg = seg0;
  // too long: drop trailing sentences (prefer ending on a completed sentence)
  while (dur(seg) > SEG_MAX_SEC) {
    if (seg.i1 === seg.i0)
      return `one sentence alone lasts ${dur(seg).toFixed(0)} s (max ${SEG_MAX_SEC})`;
    seg = { ...seg, i1: seg.i1 - 1 };
  }
  while (
    seg.i1 > seg.i0 &&
    !endsComplete(seg.cand.sentences[seg.i1]!.text) &&
    endsComplete(seg.cand.sentences[seg.i1 - 1]!.text) &&
    dur({ ...seg, i1: seg.i1 - 1 }) >= SEG_MIN_SEC
  )
    seg = { ...seg, i1: seg.i1 - 1 };
  // too short: grow with neighbours of the same candidate
  while (dur(seg) < SEG_MIN_SEC) {
    const next = extendOne(seg, blocked);
    if (!next || dur(next) > SEG_MAX_SEC)
      return `only ${dur(seg).toFixed(1)} s and its clip has no more usable sentences (min ${SEG_MIN_SEC})`;
    seg = next;
  }
  return seg;
}

/** One more neighbouring sentence: the next one (completes thoughts) first, else the previous. */
function extendOne(seg: Seg, blocked: (s: Sentence) => boolean): Seg | null {
  const s = seg.cand.sentences;
  const after = s[seg.i1 + 1];
  if (after && !blocked(after)) return { ...seg, i1: seg.i1 + 1 };
  const before = s[seg.i0 - 1];
  if (before && !blocked(before)) return { ...seg, i0: seg.i0 - 1 };
  return null;
}

/** Drops the last sentence, keeping at least `minDur` seconds. */
function shrinkOne(seg: Seg, minDur: number): Seg | null {
  if (seg.i1 <= seg.i0) return null;
  const next = { ...seg, i1: seg.i1 - 1 };
  return dur(next) >= minDur ? next : null;
}

/** Index of the lowest-scored beat that is neither first nor last (else the last beat). */
function weakestInner(segs: Seg[]): number {
  let best = -1;
  for (let i = 1; i < segs.length - 1; i++) {
    if (best < 0 || (segs[i]!.cand.score ?? 0) < (segs[best]!.cand.score ?? 0)) best = i;
  }
  return best >= 0 ? best : segs.length - 1;
}

function cleanLine(t: string, max: number): string {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
