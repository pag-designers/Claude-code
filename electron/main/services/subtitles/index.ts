/**
 * SubtitleService: user edits layered over the ASR transcript (BRIEF §5 "Subtitles track").
 * Pure functions; every mutation returns a NEW `SubtitleEdits` with `rev` incremented.
 */
import type { Cue, SubtitleEdits } from '@shared/cp2';
import type { Word } from '@shared/pipeline';
import type { SubtitleService } from '../../pipeline/contracts2';
import { applyEdits, buildCues, toSrt, toVtt, tokenize, type EditedWord } from './cues';

export { applyEdits, buildCues, toSrt, toVtt, wrapTokens, tokenize } from './cues';
export type { EditedWord } from './cues';

type WordEdit = SubtitleEdits['words'][string];

const clone = (e: SubtitleEdits): SubtitleEdits => ({
  rev: e.rev,
  words: Object.fromEntries(Object.entries(e.words).map(([k, v]) => [k, { ...v }])),
  breaks: [...e.breaks],
  merges: [...e.merges],
});

const bump = (e: SubtitleEdits): SubtitleEdits => ({ ...e, rev: e.rev + 1 });

const sortedUnique = (a: number[]): number[] => [...new Set(a)].sort((x, y) => x - y);

function findCue(
  words: Word[],
  edits: SubtitleEdits,
  cueId: number,
): { cues: Cue[]; cue: Cue } | null {
  const cues = buildCues(words, edits);
  const cue = cues[cueId] ?? cues.find((c) => c.id === cueId);
  return cue ? { cues, cue } : null;
}

/** Longest-common-subsequence alignment of two token lists (exact match). */
function align(a: string[], b: string[]): { ai: number; bi: number }[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as Uint16Array;
      row[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as Uint16Array)[j + 1] ?? 0) + 1
          : Math.max((dp[i + 1] as Uint16Array)[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: { ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ ai: i, bi: j });
      i++;
      j++;
    } else if (((dp[i + 1] as Uint16Array)[j] ?? 0) >= ((dp[i] as Uint16Array)[j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

function editCueText(
  words: Word[],
  edits: SubtitleEdits,
  cueId: number,
  text: string,
): SubtitleEdits {
  const found = findCue(words, edits, cueId);
  if (!found) return edits;
  const { cue } = found;
  const ew = applyEdits(words, edits).filter(
    (w) => w.origIndex >= cue.wordStart && w.origIndex <= cue.wordEnd,
  );
  const oldTokens = ew.map((w) => w.w);
  const newTokens = tokenize(text);
  if (oldTokens.length === newTokens.length && oldTokens.every((t, i) => t === newTokens[i])) {
    return edits; // identity: nothing to persist
  }

  // assign every new token to an original word of the cue
  const assigned = new Map<number, string[]>();
  const origOf = (i: number): number => ew[i]?.origIndex ?? cue.wordStart;
  for (const w of ew) assigned.set(w.origIndex, []);
  const put = (orig: number, tok: string): void => {
    const list = assigned.get(orig);
    if (list) list.push(tok);
  };
  const pairs = align(oldTokens, newTokens);
  let ai = 0;
  let bi = 0;
  let lastOrig = origOf(0);
  const region = (aEnd: number, bEnd: number): void => {
    const a = aEnd - ai;
    const b = bEnd - bi;
    const paired = Math.min(a, b);
    for (let k = 0; k < paired; k++) {
      lastOrig = origOf(ai + k);
      put(lastOrig, newTokens[bi + k] as string);
    }
    for (let k = paired; k < b; k++) put(lastOrig, newTokens[bi + k] as string); // insertions
    ai = aEnd;
    bi = bEnd;
  };
  for (const p of pairs) {
    region(p.ai, p.bi);
    lastOrig = origOf(p.ai);
    put(lastOrig, newTokens[p.bi] as string);
    ai = p.ai + 1;
    bi = p.bi + 1;
  }
  region(oldTokens.length, newTokens.length);

  const next = clone(edits);
  const asr = new Map<number, string[]>();
  for (const idx of assigned.keys()) asr.set(idx, tokenize(words[idx]?.w ?? ''));
  for (const [idx, toks] of assigned) {
    const key = String(idx);
    const cur: WordEdit = { ...(next.words[key] ?? {}) };
    const original = asr.get(idx) ?? [];
    if (toks.length === 0) {
      cur.hidden = true;
      delete cur.text;
    } else {
      delete cur.hidden;
      if (toks.length === original.length && toks.every((t, i) => t === original[i]))
        delete cur.text;
      else cur.text = toks.join(' ');
    }
    if (Object.keys(cur).length === 0) delete next.words[key];
    else next.words[key] = cur;
  }
  return bump(next);
}

function splitCue(
  words: Word[],
  edits: SubtitleEdits,
  cueId: number,
  atWordIndex: number,
): SubtitleEdits {
  const found = findCue(words, edits, cueId);
  if (!found) return edits;
  const { cue } = found;
  // the break goes before the first visible word at or after `atWordIndex`, inside the cue
  const ew = applyEdits(words, edits);
  const at = ew.find((w) => w.origIndex >= atWordIndex && w.origIndex > cue.wordStart);
  if (!at || at.origIndex > cue.wordEnd) return edits;
  // a word expanded into several tokens can only be split at its first token
  if (edits.breaks.includes(at.origIndex) && !edits.merges.includes(at.origIndex)) return edits;
  const next = clone(edits);
  next.breaks = sortedUnique([...next.breaks, at.origIndex]);
  next.merges = next.merges.filter((m) => m !== at.origIndex);
  return bump(next);
}

function mergeWithNext(words: Word[], edits: SubtitleEdits, cueId: number): SubtitleEdits {
  const found = findCue(words, edits, cueId);
  const { cues, cue } = found ?? { cues: [], cue: null };
  if (!cue) return edits;
  const nextCue = cues[cue.id + 1];
  if (!nextCue) return edits;
  const f = nextCue.wordStart;
  const next = clone(edits);
  next.breaks = next.breaks.filter((b) => b !== f);
  next.merges = sortedUnique([...next.merges, f]);
  const after = buildCues(words, next);
  if (after.length >= cues.length) return edits; // the rules (length, 6 s) forbid this merge
  return bump(next);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function shiftCue(
  words: Word[],
  edits: SubtitleEdits,
  cueId: number,
  deltaSec: number,
): SubtitleEdits {
  const found = findCue(words, edits, cueId);
  if (!found || !Number.isFinite(deltaSec) || deltaSec === 0) return edits;
  const { cues, cue } = found;
  // keep the cue between its neighbours and the start of the video
  const prev = cues[cue.id - 1];
  const nxt = cues[cue.id + 1];
  let d = deltaSec;
  d = Math.max(d, (prev ? prev.e : 0) - cue.s);
  if (nxt) d = Math.min(d, nxt.s - cue.e);
  if (d === 0) return edits;
  const next = clone(edits);
  const ew = applyEdits(words, edits);
  const idxs = new Set(
    ew
      .filter((w) => w.origIndex >= cue.wordStart && w.origIndex <= cue.wordEnd)
      .map((w) => w.origIndex),
  );
  for (const idx of idxs) {
    const key = String(idx);
    const cur: WordEdit = { ...(next.words[key] ?? {}) };
    const shift = round3((cur.shift ?? 0) + d);
    if (shift === 0) delete cur.shift;
    else cur.shift = shift;
    if (Object.keys(cur).length === 0) delete next.words[key];
    else next.words[key] = cur;
  }
  return bump(next);
}

export function createSubtitleService(): SubtitleService {
  return {
    applyEdits: (words, edits): (Word & { origIndex: number })[] => applyEdits(words, edits),
    cues: (words, edits) => buildCues(words, edits),
    editCueText,
    splitCue,
    mergeWithNext,
    shiftCue,
    toSrt,
    toVtt,
  };
}

export type { EditedWord as SubtitleWord };
export const _internal = { align };
