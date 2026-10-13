/**
 * Word/sentence index + boundary snapping (BRIEF §4.5: "never cut mid-word; snap to word boundaries
 * + 120–250 ms padding; prefer silence gaps"). Pure functions, no I/O.
 */
import type { AudioSignals, Transcript, Word } from '@shared/pipeline';

/** Padding bounds (seconds) around the first/last spoken word of a clip. */
export const PAD_MIN = 0.12;
export const PAD_MAX = 0.25;
/** Preferred lead-in / tail padding when there is room. Both lie inside [PAD_MIN, PAD_MAX]. */
export const PAD_START = 0.18;
export const PAD_END = 0.22;
/** Safety margin kept between a cut and the neighbouring word's reported region (ASR timings are fuzzy). */
export const GUARD = 0.03;
/** An LLM boundary this close to a sentence boundary is pulled onto it (completes/starts a sentence). */
export const SENTENCE_NUDGE_SEC = 0.6;

const STRONG_END = /[.?!…]["')\]]*$/;

export interface SentenceSpan {
  /** Index into `WordIndex.words` (inclusive). */
  first: number;
  last: number;
  id: number;
  text: string;
}

export interface WordIndex {
  words: Word[];
  /** Total length of the media (seconds); the clip can never extend past it. */
  durationSec: number;
  sentences: SentenceSpan[];
  /** word index -> sentence index (or -1). */
  sentenceOfWord: Int32Array;
  isSentenceStart: Uint8Array;
  isSentenceEnd: Uint8Array;
  silences: { s: number; e: number }[];
}

export const stripPunct = (w: string): string =>
  w
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .trim();

/** Builds the index. Words with non-finite times are repaired (never reordered or dropped). */
export function buildIndex(
  transcript: Pick<Transcript, 'words' | 'sentences' | 'durationSec'>,
  silences: AudioSignals['silences'] = [],
): WordIndex {
  const words: Word[] = transcript.words.map((w) => {
    const s = Number.isFinite(w.s) ? w.s : 0;
    const e = Number.isFinite(w.e) && w.e >= s ? w.e : s;
    return w.s === s && w.e === e ? w : { ...w, s, e };
  });
  const n = words.length;
  const lastEnd = n > 0 ? (words[n - 1]?.e ?? 0) : 0;
  const durationSec = Math.max(
    lastEnd,
    Number.isFinite(transcript.durationSec) ? transcript.durationSec : 0,
  );

  let sentences: SentenceSpan[] = [];
  for (const s of transcript.sentences) {
    if (s.wordStart >= 0 && s.wordEnd >= s.wordStart && s.wordEnd < n) {
      sentences.push({ first: s.wordStart, last: s.wordEnd, id: s.id, text: s.text });
    }
  }
  if (sentences.length === 0 && n > 0) sentences = deriveSentences(words);

  const sentenceOfWord = new Int32Array(n).fill(-1);
  const isSentenceStart = new Uint8Array(n);
  const isSentenceEnd = new Uint8Array(n);
  sentences.forEach((sp, k) => {
    for (let i = sp.first; i <= sp.last; i++) sentenceOfWord[i] = k;
    isSentenceStart[sp.first] = 1;
    isSentenceEnd[sp.last] = 1;
  });
  return {
    words,
    durationSec,
    sentences,
    sentenceOfWord,
    isSentenceStart,
    isSentenceEnd,
    silences,
  };
}

/** Fallback segmentation when the transcript carries no sentences: punctuation and long pauses. */
function deriveSentences(words: Word[]): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (!w) continue;
    const endsSentence =
      STRONG_END.test(w.w.trim()) || next === undefined || next.s - w.e >= 0.9 || i - first >= 40;
    if (endsSentence) {
      out.push({
        first,
        last: i,
        id: out.length,
        text: words
          .slice(first, i + 1)
          .map((x) => x.w.trim())
          .join(' '),
      });
      first = i + 1;
    }
  }
  return out;
}

/* ------------------------------------------------ padding ---------------------------------------- */

/**
 * Padded start time for a clip whose first spoken word is `wi`. The cut lies in the silence before the
 * word: PAD_START seconds ahead when there is room, otherwise as close to the previous word as GUARD
 * allows (never inside the previous word's region).
 */
export function paddedStart(ix: WordIndex, wi: number): number {
  const first = ix.words[wi];
  if (!first) return 0;
  const prevEnd = wi > 0 ? (ix.words[wi - 1]?.e ?? 0) : 0;
  let lower = wi > 0 ? prevEnd + GUARD : 0;
  // Prefer to stay inside a measured silence: never earlier than where the audio went quiet.
  for (const sil of ix.silences) {
    if (sil.s <= first.s && sil.e >= first.s - 0.08) {
      lower = Math.max(lower, sil.s + 0.02);
      break;
    }
  }
  const room = first.s - lower;
  const pad = Math.max(0, Math.min(PAD_START, room));
  return Math.max(0, first.s - pad);
}

/** Padded end time for a clip whose last spoken word is `wi`. Symmetric to {@link paddedStart}. */
export function paddedEnd(ix: WordIndex, wi: number): number {
  const last = ix.words[wi];
  if (!last) return 0;
  const next = ix.words[wi + 1];
  let upper = next ? next.s - GUARD : ix.durationSec;
  for (const sil of ix.silences) {
    if (sil.s <= last.e + 0.08 && sil.e >= last.e) {
      upper = Math.min(upper, sil.e - 0.02);
      break;
    }
  }
  const room = upper - last.e;
  const pad = Math.max(0, Math.min(PAD_END, room));
  return Math.min(ix.durationSec, last.e + pad);
}

/* ------------------------------------------------ snapping --------------------------------------- */

export interface SnapResult {
  startSec: number;
  endSec: number;
  /** Word indices of the first/last spoken word inside the clip (inclusive). */
  firstWord: number;
  lastWord: number;
}

/** Index of the first word that is not entirely before `t` (or `n` when there is none). */
function firstWordEndingAfter(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid]?.e ?? 0) > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the last word that starts before `t` (or -1). */
function lastWordStartingBefore(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid]?.s ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function isGoodEndWord(ix: WordIndex, i: number): boolean {
  if (ix.isSentenceEnd[i]) return true;
  const w = ix.words[i];
  const next = ix.words[i + 1];
  if (!w) return false;
  return (
    STRONG_END.test(w.w.trim()) ||
    /[,;:]$/.test(w.w.trim()) ||
    (next !== undefined && next.s - w.e >= 0.3)
  );
}

/**
 * Snaps an arbitrary [startSec,endSec] span to word boundaries.
 *  1. a boundary inside a word moves to the nearer edge of that word (the word is kept or dropped
 *     whole — never cut);
 *  2. a boundary within SENTENCE_NUDGE_SEC of a sentence edge moves onto it;
 *  3. duration is forced into [minSec,maxSec] by moving to the cheapest sentence boundaries;
 *  4. 120–250 ms padding is added inside the neighbouring silence (shorter when a neighbour is closer).
 */
export function snapSpan(
  ix: WordIndex,
  startSec: number,
  endSec: number,
  range: { minSec: number; maxSec: number },
): SnapResult {
  const { words } = ix;
  const n = words.length;
  const t0 = Math.max(0, Math.min(startSec, endSec));
  const t1 = Math.min(ix.durationSec, Math.max(startSec, endSec));
  if (n === 0) return { startSec: t0, endSec: Math.max(t0, t1), firstWord: 0, lastWord: -1 };

  // 1. word-level snap
  let i = firstWordEndingAfter(words, t0);
  const wi = words[i];
  if (wi && wi.s < t0 && t0 - wi.s > wi.e - t0) i += 1;
  let j = lastWordStartingBefore(words, t1);
  const wj = words[j];
  if (wj && wj.e > t1 && wj.e - t1 > t1 - wj.s) j -= 1;
  i = Math.min(Math.max(i, 0), n - 1);
  j = Math.min(Math.max(j, 0), n - 1);
  if (j < i) {
    // Span fell entirely in a gap or inside one word: keep the nearest word.
    j = i;
  }

  // 2. sentence nudge
  const si = ix.sentenceOfWord[i] ?? -1;
  if (si >= 0 && !ix.isSentenceStart[i]) {
    const sp = ix.sentences[si];
    if (sp && (words[i]?.s ?? 0) - (words[sp.first]?.s ?? 0) <= SENTENCE_NUDGE_SEC) i = sp.first;
  }
  const sj = ix.sentenceOfWord[j] ?? -1;
  if (sj >= 0 && !ix.isSentenceEnd[j]) {
    const sp = ix.sentences[sj];
    if (sp && (words[sp.last]?.e ?? 0) - (words[j]?.e ?? 0) <= SENTENCE_NUDGE_SEC) j = sp.last;
  }

  // 3. duration range
  const dur = (a: number, b: number): number => paddedEnd(ix, b) - paddedStart(ix, a);
  if (dur(i, j) < range.minSec - 1e-6 || dur(i, j) > range.maxSec + 1e-6) {
    const best = fitToRange(ix, i, j, range);
    i = best.i;
    j = best.j;
  }

  return { startSec: paddedStart(ix, i), endSec: paddedEnd(ix, j), firstWord: i, lastWord: j };
}

/** Cheapest (start,end) word pair near (i0,j0) whose padded duration lies in the range. */
function fitToRange(
  ix: WordIndex,
  i0: number,
  j0: number,
  range: { minSec: number; maxSec: number },
): { i: number; j: number } {
  const { words } = ix;
  const n = words.length;
  const REACH = Math.max(40, range.maxSec);
  const w0 = words[i0];
  const wj0 = words[j0];
  if (!w0 || !wj0) return { i: i0, j: j0 };

  const starts = new Set<number>([i0]);
  const ends = new Set<number>([j0]);
  for (let k = Math.max(0, i0 - 1); k >= 0 && w0.s - (words[k]?.s ?? 0) <= REACH; k--) {
    if (ix.isSentenceStart[k]) starts.add(k);
  }
  for (let k = i0 + 1; k < n && (words[k]?.s ?? 0) - w0.s <= REACH; k++) {
    if (ix.isSentenceStart[k]) starts.add(k);
  }
  for (let k = j0 + 1; k < n && (words[k]?.e ?? 0) - wj0.e <= REACH; k++) {
    if (ix.isSentenceEnd[k]) ends.add(k);
  }
  for (let k = j0 - 1; k >= i0 && wj0.e - (words[k]?.e ?? 0) <= REACH; k--) {
    if (ix.isSentenceEnd[k]) ends.add(k);
  }

  const search = (ss: Iterable<number>, es: Iterable<number>, loose: boolean) => {
    let best: { i: number; j: number; cost: number } | null = null;
    const startList = [...ss];
    const endList = [...es];
    for (const a of startList) {
      const ps = paddedStart(ix, a);
      for (const b of endList) {
        if (b < a) continue;
        const d = paddedEnd(ix, b) - ps;
        if (d < range.minSec - 1e-6 || d > range.maxSec + 1e-6) continue;
        let cost = 1.5 * Math.abs((words[a]?.s ?? 0) - w0.s) + Math.abs((words[b]?.e ?? 0) - wj0.e);
        if (loose) {
          if (a !== i0 && !ix.isSentenceStart[a]) cost += 3 + (isGoodEndWord(ix, a - 1) ? 0 : 3);
          if (b !== j0 && !isGoodEndWord(ix, b)) cost += 6;
        }
        if (
          best === null ||
          cost < best.cost - 1e-9 ||
          (Math.abs(cost - best.cost) <= 1e-9 && a < best.i)
        ) {
          best = { i: a, j: b, cost };
        }
      }
    }
    return best;
  };

  const strict = search(starts, ends, false);
  if (strict) return strict;

  // Fall back to every word end/start near the span (good punctuation/pause boundaries are cheaper).
  const looseStarts = new Set(starts);
  const looseEnds = new Set(ends);
  for (let k = Math.max(0, i0 - 60); k <= Math.min(n - 1, i0 + 60); k++) looseStarts.add(k);
  for (let k = Math.max(0, j0 - 120); k <= Math.min(n - 1, j0 + 120); k++) looseEnds.add(k);
  const loose = search(looseStarts, looseEnds, true);
  if (loose) return loose;

  // Transcript cannot satisfy the range (e.g. shorter than minSec): get as close as we can.
  const d = paddedEnd(ix, j0) - paddedStart(ix, i0);
  if (d < range.minSec) {
    let a = i0;
    let b = j0;
    while (paddedEnd(ix, b) - paddedStart(ix, a) < range.minSec && (b < n - 1 || a > 0)) {
      if (b < n - 1) b++;
      else a--;
    }
    return { i: a, j: b };
  }
  let b = j0;
  while (b > i0 && paddedEnd(ix, b) - paddedStart(ix, i0) > range.maxSec) b--;
  return { i: i0, j: b };
}
