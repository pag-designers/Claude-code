/**
 * Pure subtitle-editing model (no React). The server owns cue chunking; the client edits `SubtitleEdits`
 * (per-word text/shift/hidden + forced breaks/merges) and mirrors every operation on the cue list optimistically, so the
 * UI answers instantly while `subtitles:save` returns the authoritative cues.
 *
 * Contract assumption: `Cue.wordStart/wordEnd` are inclusive indices into `videos:transcript` words, and
 * `SubtitleEdits.words` is keyed by those same indices.
 */
import type { Cue, SubtitleEdits } from '@shared/cp2';

export interface TWord {
  w: string;
  s: number;
  e: number;
}

export interface SubState {
  cues: Cue[];
  edits: SubtitleEdits;
}

export const NUDGE_STEP = 0.1;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type WordEdit = NonNullable<SubtitleEdits['words'][string]>;

/* ------------------------------------------------------------ word helpers --------------------------------------- */

export function wordText(words: readonly TWord[], edits: SubtitleEdits, i: number): string {
  return (edits.words[String(i)]?.text ?? words[i]?.w ?? '').trim();
}
export const isHidden = (edits: SubtitleEdits, i: number): boolean =>
  edits.words[String(i)]?.hidden === true;

export function wordTimes(
  words: readonly TWord[],
  edits: SubtitleEdits,
  i: number,
): { s: number; e: number } {
  const w = words[i];
  const shift = edits.words[String(i)]?.shift ?? 0;
  return { s: r3((w?.s ?? 0) + shift), e: r3((w?.e ?? 0) + shift) };
}

/** Indices of the words of a cue that are still shown. */
export function visibleIndices(
  edits: SubtitleEdits,
  wordStart: number,
  wordEnd: number,
): number[] {
  const out: number[] = [];
  for (let i = wordStart; i <= wordEnd; i++) if (!isHidden(edits, i)) out.push(i);
  return out;
}

export function cueTextOf(
  words: readonly TWord[],
  edits: SubtitleEdits,
  wordStart: number,
  wordEnd: number,
): string {
  return visibleIndices(edits, wordStart, wordEnd)
    .map((i) => wordText(words, edits, i))
    .filter(Boolean)
    .join(' ');
}

function cueSpan(
  words: readonly TWord[],
  edits: SubtitleEdits,
  wordStart: number,
  wordEnd: number,
): { s: number; e: number } {
  const vis = visibleIndices(edits, wordStart, wordEnd);
  const first = vis[0] ?? wordStart;
  const last = vis[vis.length - 1] ?? wordEnd;
  return { s: wordTimes(words, edits, first).s, e: wordTimes(words, edits, last).e };
}

export const tokenize = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/* ------------------------------------------------------------ edit plumbing -------------------------------------- */

function cloneEdits(e: SubtitleEdits): SubtitleEdits {
  return { rev: e.rev, words: { ...e.words }, breaks: [...e.breaks], merges: [...e.merges] };
}

function putWord(e: SubtitleEdits, i: number, patch: Partial<WordEdit>): void {
  const key = String(i);
  const next: WordEdit = { ...e.words[key], ...patch };
  for (const k of Object.keys(next) as (keyof WordEdit)[]) if (next[k] === undefined) delete next[k];
  if (next.shift !== undefined && Math.abs(next.shift) < 0.0005) delete next.shift;
  if (next.hidden === false) delete next.hidden;
  if (Object.keys(next).length === 0) delete e.words[key];
  else e.words[key] = next;
}

const addUnique = (list: number[], n: number) => {
  if (!list.includes(n)) list.push(n);
  list.sort((a, b) => a - b);
};
const removeValue = (list: number[], n: number) => {
  const at = list.indexOf(n);
  if (at >= 0) list.splice(at, 1);
};

let tempId = 0;
/** Cues created locally (split) get a negative id until the server answers with the real ones. */
export const newTempCueId = (): number => -(++tempId);

/* ------------------------------------------------------------ text diff ------------------------------------------ */

interface Pair {
  oldAt: number;
  newAt: number;
}

/** Longest common subsequence (exact token equality) -> matched index pairs, ascending. */
function lcsPairs(a: readonly string[], b: readonly string[]): Pair[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ oldAt: i, newAt: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

export interface OpResult {
  state: SubState;
  /** Set when the operation could not do (all of) what was asked. */
  warning?: string;
}

const indexOfCue = (cues: readonly Cue[], id: number) => cues.findIndex((c) => c.id === id);

/**
 * Applies a new text to a cue. Words are never invented: tokens replace the cue's words in order (a longer text is folded
 * into the neighbouring word), removed words become `hidden`, and unchanged words keep their original timing.
 */
export function applyCueText(
  s: SubState,
  words: readonly TWord[],
  cueId: number,
  text: string,
): OpResult {
  const at = indexOfCue(s.cues, cueId);
  const cue = s.cues[at];
  if (!cue) return { state: s };
  const vis = visibleIndices(s.edits, cue.wordStart, cue.wordEnd);
  const oldTexts = vis.map((i) => wordText(words, s.edits, i));
  const tokens = tokenize(text);
  if (tokens.join(' ') === oldTexts.join(' ')) return { state: s };

  const edits = cloneEdits(s.edits);
  const original = (i: number) => (words[i]?.w ?? '').trim();
  const setText = (i: number, t: string) => putWord(edits, i, { text: t === original(i) ? undefined : t });
  const hide = (i: number) => putWord(edits, i, { hidden: true });
  let warning: string | undefined;

  const pairs = lcsPairs(oldTexts, tokens);
  // walk the gaps between matched anchors (the last anchor is a sentinel past the end)
  const anchors: Pair[] = [...pairs, { oldAt: oldTexts.length, newAt: tokens.length }];
  let o = 0;
  let n = 0;
  let prevMatched: number | null = null; // word index of the previous unchanged word
  for (const a of anchors) {
    const oldGap = vis.slice(o, a.oldAt);
    const newGap = tokens.slice(n, a.newAt);
    const k = Math.min(oldGap.length, newGap.length);
    for (let g = 0; g < k; g++) setText(oldGap[g]!, newGap[g]!);
    for (let g = k; g < oldGap.length; g++) hide(oldGap[g]!);
    if (newGap.length > k) {
      const extra = newGap.slice(k).join(' ');
      const nextMatched = a.oldAt < vis.length ? vis[a.oldAt]! : null;
      if (k > 0) {
        const target = oldGap[k - 1]!;
        setText(target, `${wordText(words, edits, target)} ${extra}`);
      } else if (prevMatched !== null) {
        setText(prevMatched, `${wordText(words, edits, prevMatched)} ${extra}`);
      } else if (nextMatched !== null) {
        setText(nextMatched, `${extra} ${wordText(words, edits, nextMatched)}`);
      } else warning = 'There is no word left to attach the new text to.';
    }
    if (a.oldAt < vis.length) prevMatched = vis[a.oldAt]!;
    o = a.oldAt + 1;
    n = a.newAt + 1;
  }

  const cues = s.cues.slice();
  if (tokens.length === 0) {
    cues.splice(at, 1);
  } else {
    cues[at] = {
      ...cue,
      text: cueTextOf(words, edits, cue.wordStart, cue.wordEnd),
      ...cueSpan(words, edits, cue.wordStart, cue.wordEnd),
    };
  }
  return { state: { cues, edits }, warning };
}

/** Splits a cue after its `keep`-th visible word (1 <= keep < visible words). */
export function splitCue(
  s: SubState,
  words: readonly TWord[],
  cueId: number,
  keep: number,
): OpResult {
  const at = indexOfCue(s.cues, cueId);
  const cue = s.cues[at];
  if (!cue) return { state: s };
  const vis = visibleIndices(s.edits, cue.wordStart, cue.wordEnd);
  if (keep < 1 || keep >= vis.length)
    return { state: s, warning: 'Place the caret between two words to split.' };
  const breakAt = vis[keep]!;
  const edits = cloneEdits(s.edits);
  addUnique(edits.breaks, breakAt);
  removeValue(edits.merges, breakAt);
  const first: Cue = {
    ...cue,
    wordEnd: breakAt - 1,
    text: cueTextOf(words, edits, cue.wordStart, breakAt - 1),
    ...cueSpan(words, edits, cue.wordStart, breakAt - 1),
  };
  const second: Cue = {
    id: newTempCueId(),
    wordStart: breakAt,
    wordEnd: cue.wordEnd,
    text: cueTextOf(words, edits, breakAt, cue.wordEnd),
    ...cueSpan(words, edits, breakAt, cue.wordEnd),
  };
  const cues = s.cues.slice();
  cues.splice(at, 1, first, second);
  return { state: { cues, edits } };
}

/** Joins a cue with the one that follows it. */
export function mergeWithNext(s: SubState, words: readonly TWord[], cueId: number): OpResult {
  const at = indexOfCue(s.cues, cueId);
  const cue = s.cues[at];
  const next = s.cues[at + 1];
  if (!cue || !next) return { state: s, warning: 'This is the last cue.' };
  const edits = cloneEdits(s.edits);
  removeValue(edits.breaks, next.wordStart);
  addUnique(edits.merges, next.wordStart);
  const merged: Cue = {
    ...cue,
    wordEnd: next.wordEnd,
    text: cueTextOf(words, edits, cue.wordStart, next.wordEnd),
    ...cueSpan(words, edits, cue.wordStart, next.wordEnd),
  };
  const cues = s.cues.slice();
  cues.splice(at, 2, merged);
  return { state: { cues, edits } };
}

/** Moves every word of the cue by `delta` seconds (the cue keeps its length). */
export function shiftCue(
  s: SubState,
  words: readonly TWord[],
  cueId: number,
  delta: number,
): OpResult {
  const at = indexOfCue(s.cues, cueId);
  const cue = s.cues[at];
  if (!cue || Math.abs(delta) < 0.0005) return { state: s };
  // never before 0:00
  const minStart = cueSpan(words, s.edits, cue.wordStart, cue.wordEnd).s;
  const d = minStart + delta < 0 ? -minStart : delta;
  if (Math.abs(d) < 0.0005)
    return { state: s, warning: 'This cue already starts at 0:00.' };
  const edits = cloneEdits(s.edits);
  for (let i = cue.wordStart; i <= cue.wordEnd; i++)
    putWord(edits, i, { shift: r3((edits.words[String(i)]?.shift ?? 0) + d) });
  const cues = s.cues.slice();
  cues[at] = { ...cue, ...cueSpan(words, edits, cue.wordStart, cue.wordEnd) };
  return { state: { cues, edits } };
}

export function setCueStart(
  s: SubState,
  words: readonly TWord[],
  cueId: number,
  start: number,
): OpResult {
  const cue = s.cues.find((c) => c.id === cueId);
  if (!cue) return { state: s };
  return shiftCue(s, words, cueId, start - cue.s);
}

/** Removes the cue from the captions (all of its words become hidden). */
export function deleteCue(s: SubState, cueId: number): OpResult {
  const at = indexOfCue(s.cues, cueId);
  const cue = s.cues[at];
  if (!cue) return { state: s };
  const edits = cloneEdits(s.edits);
  for (let i = cue.wordStart; i <= cue.wordEnd; i++) putWord(edits, i, { hidden: true });
  const cues = s.cues.slice();
  cues.splice(at, 1);
  return { state: { cues, edits } };
}

/** Number of visible words that precede a caret offset in `text` (rounded to the nearest word boundary). */
export function wordsBeforeCaret(text: string, caret: number): number {
  let count = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret >= end) count++;
    else if (caret > start) {
      // inside a word: snap to the closer boundary
      if (caret - start >= end - caret) count++;
      break;
    } else break;
  }
  return count;
}

/* ------------------------------------------------------------ lookup / search ------------------------------------ */

/** The cue being spoken at `t` (last cue starting at or before t, if t is not past its end by more than `grace`). */
export function activeCueIndex(cues: readonly Pick<Cue, 's' | 'e'>[], t: number, grace = 0.35): number {
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((cues[mid]?.s ?? Infinity) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return -1;
  // nudged cues can overlap: prefer a neighbour that really contains t
  for (let i = ans; i >= Math.max(0, ans - 3); i--) {
    const c = cues[i];
    if (c && t >= c.s && t <= c.e + 0.0001) return i;
  }
  const c = cues[ans];
  return c && t <= c.e + grace ? ans : -1;
}

export interface CueMatch {
  cue: number;
  ranges: [number, number][];
}

export function findCueMatches(cues: readonly Pick<Cue, 'text'>[], query: string): CueMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: CueMatch[] = [];
  cues.forEach((c, i) => {
    const hay = c.text.toLowerCase();
    const ranges: [number, number][] = [];
    let from = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at < 0) break;
      ranges.push([at, at + q.length]);
      from = at + q.length;
    }
    if (ranges.length) out.push({ cue: i, ranges });
  });
  return out;
}

/* ------------------------------------------------------------ time formatting ------------------------------------- */

/** 75.34 -> "1:15.3" (tenths, tabular friendly). */
export function formatCueTime(sec: number): string {
  const t = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const tenths = Math.floor(t * 10 + 1e-6);
  const s = Math.floor(tenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  const frac = tenths % 10;
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)}:${ss}.${frac}`;
}

/** Accepts "12.5", "1:12.5", "1:02:03". Returns null when it is not a time. */
export function parseCueTime(input: string): number | null {
  const t = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return r3(sec);
}

/* ------------------------------------------------------------ history -------------------------------------------- */

export interface History<T> {
  past: T[];
  future: T[];
}
export const HISTORY_LIMIT = 50;
export const emptyHistory = <T,>(): History<T> => ({ past: [], future: [] });

export function pushHistory<T>(h: History<T>, current: T): History<T> {
  const past = [...h.past, current];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}
export function undoHistory<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  const value = h.past[h.past.length - 1];
  if (value === undefined) return null;
  return { value, history: { past: h.past.slice(0, -1), future: [current, ...h.future] } };
}
export function redoHistory<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  const value = h.future[0];
  if (value === undefined) return null;
  return { value, history: { past: [...h.past, current], future: h.future.slice(1) } };
}
