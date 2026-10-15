import type { SubtitleWord } from '@shared/editor';

/* Pure edits of a subtitle cue's word list (cue-LOCAL seconds). Every function returns a new array. */

const MIN_WORD = 0.02;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Replaces word `i`'s text. Empty text removes the word (its time goes to the previous word, or the next if first).
 * Text with spaces becomes several words sharing the original span in proportion to their length; the first keeps
 * the original highlight colour.
 */
export function setWordText(
  words: readonly SubtitleWord[],
  i: number,
  text: string,
): SubtitleWord[] {
  const w = words[i];
  if (!w) return [...words];
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const out = words.filter((_, j) => j !== i).map((x) => ({ ...x }));
    const prev = out[i - 1];
    const next = out[i];
    if (prev) prev.e = Math.max(prev.e, w.e);
    else if (next) next.s = Math.min(next.s, w.s);
    return out;
  }
  if (parts.length === 1)
    return words.map((x, j) => (j === i ? { ...x, w: parts[0] as string } : { ...x }));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const span = Math.max(w.e - w.s, MIN_WORD * parts.length);
  let at = w.s;
  const pieces: SubtitleWord[] = parts.map((p, k) => {
    const len = (p.length / total) * span;
    const piece: SubtitleWord = {
      w: p,
      s: r3(at),
      e: r3(k === parts.length - 1 ? w.s + span : at + len),
      color: k === 0 ? w.color : null,
    };
    at += len;
    return piece;
  });
  return [
    ...words.slice(0, i).map((x) => ({ ...x })),
    ...pieces,
    ...words.slice(i + 1).map((x) => ({ ...x })),
  ];
}

export function setWordColor(
  words: readonly SubtitleWord[],
  i: number,
  color: string | null,
): SubtitleWord[] {
  return words.map((x, j) => (j === i ? { ...x, color } : { ...x }));
}

/**
 * Moves the START of word `i` (the boundary with the previous word): the previous word's end follows when it touched
 * or overlapped the old start. Clamped so every word keeps at least MIN_WORD seconds.
 */
export function setWordStart(
  words: readonly SubtitleWord[],
  i: number,
  start: number,
  durationSec: number,
): SubtitleWord[] {
  const out = words.map((x) => ({ ...x }));
  const cur = out[i];
  if (!cur) return out;
  const prev = out[i - 1];
  const lo = prev ? prev.s + MIN_WORD : 0;
  const hi = Math.min(cur.e - MIN_WORD, durationSec);
  const s = r3(Math.min(Math.max(start, lo), Math.max(lo, hi)));
  if (prev && (Math.abs(prev.e - cur.s) < 0.011 || prev.e > s)) prev.e = s;
  cur.s = s;
  return out;
}

/** Moves the END of the last word (inner boundaries are edited through the next word's start). */
export function setLastWordEnd(
  words: readonly SubtitleWord[],
  end: number,
  durationSec: number,
): SubtitleWord[] {
  const out = words.map((x) => ({ ...x }));
  const last = out[out.length - 1];
  if (!last) return out;
  last.e = r3(Math.min(Math.max(end, last.s + MIN_WORD), durationSec));
  return out;
}

/** Index of the word being spoken at cue-local time `t` (or the last one that has started), −1 before the first. */
export function activeWordIndex(words: readonly SubtitleWord[], t: number): number {
  let idx = -1;
  words.forEach((w, i) => {
    if (t >= w.s - 1e-6) idx = i;
  });
  if (idx >= 0 && t > (words[idx] as SubtitleWord).e + 0.5) return -1;
  return idx;
}
