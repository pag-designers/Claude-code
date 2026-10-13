/**
 * Subtitle cue engine: ASR words + user edits -> phrase-level cues.
 *
 * Indices: every index in `SubtitleEdits` (word keys, breaks, merges) and in `Cue.wordStart/wordEnd`
 * is the ORIGINAL transcript index. A word whose text override contains spaces is expanded into several
 * display tokens that share the original index and split the word's time span by character count.
 *
 * Cue rules: <= 2 lines of <= 42 characters, <= 6 s (a single token longer than a line may overflow),
 * >= 1 s when the neighbours leave room, times monotonic and non-overlapping.
 */
import type { Cue, SubtitleEdits } from '@shared/cp2';
import type { Word } from '@shared/pipeline';

export const MAX_LINE_CHARS = 42;
export const MAX_LINES = 2;
export const MAX_CUE_SEC = 6;
export const MIN_CUE_SEC = 1;
/** A silence this long between two words starts a new cue. */
export const CUE_PAUSE_SEC = 0.7;
const STRONG = /[.?!…]["')\]”’]*$/;
const SOFT = /[,;:–—]["')\]”’]*$/;
const MIN_TOKEN_SEC = 0.05;

export type EditedWord = Word & { origIndex: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const glyphs = (s: string): number => [...segmenter.segment(s)].length;

/** Whitespace-separated tokens of a text. */
export const tokenize = (text: string): string[] => text.split(/\s+/).filter((t) => t !== '');

/** Expanded display words after `edits` (see SubtitleService.applyEdits). */
export function applyEdits(words: Word[], edits: SubtitleEdits): EditedWord[] {
  const out: EditedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    const e = edits.words[String(i)];
    if (e?.hidden) continue;
    const text = e?.text !== undefined ? e.text : w.w;
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    const shift = e?.shift ?? 0;
    const s = Math.max(0, w.s + shift);
    const end = Math.max(s, w.e + shift);
    if (tokens.length === 1) {
      out.push({ ...w, w: tokens[0] ?? '', s, e: end, origIndex: i });
      continue;
    }
    const weights = tokens.map((t) => Math.max(1, glyphs(t)));
    const total = weights.reduce((a, b) => a + b, 0);
    let dur = end - s;
    const minDur = MIN_TOKEN_SEC * tokens.length;
    if (dur < minDur) dur = minDur;
    let cum = 0;
    tokens.forEach((t, k) => {
      const a = s + (dur * cum) / total;
      cum += weights[k] ?? 1;
      const b = s + (dur * cum) / total;
      out.push({ w: t, s: round3(a), e: round3(b), origIndex: i });
    });
  }
  return out;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Splits tokens into <= MAX_LINES lines of <= 42 chars, or null when they do not fit. */
export function wrapTokens(tokens: string[]): string[] | null {
  const total = tokens.join(' ').length;
  if (total <= MAX_LINE_CHARS) return [tokens.join(' ')];
  let best: { score: number; lines: string[] } | null = null;
  for (let k = 1; k < tokens.length; k++) {
    const a = tokens.slice(0, k).join(' ');
    const b = tokens.slice(k).join(' ');
    if (a.length > MAX_LINE_CHARS || b.length > MAX_LINE_CHARS) continue;
    const last = tokens[k - 1] ?? '';
    const score =
      Math.abs(a.length - b.length) -
      (STRONG.test(last) ? 10 : SOFT.test(last) ? 6 : 0) +
      (a.length > b.length ? 3 : 0);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best ? best.lines : null;
}

export interface BreakSets {
  /** Display-token indices (into the edited words) where a cue must start. */
  forced: Set<number>;
  /** Display-token indices where automatic breaks are suppressed. */
  merged: Set<number>;
}

/** Maps original-index breaks/merges to the first visible display token at or after them. */
export function breakSets(ew: EditedWord[], edits: SubtitleEdits): BreakSets {
  const forced = new Set<number>();
  const merged = new Set<number>();
  const firstAtOrAfter = (orig: number): number => {
    let lo = 0;
    let hi = ew.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ew[mid]?.origIndex ?? 0) < orig) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const b of edits.breaks) {
    const t = firstAtOrAfter(b);
    if (t < ew.length) forced.add(t);
  }
  for (const m of edits.merges) {
    const t = firstAtOrAfter(m);
    if (t < ew.length && !forced.has(t)) merged.add(t);
  }
  return { forced, merged };
}

interface Draft {
  from: number;
  to: number;
}

function draftCues(ew: EditedWord[], sets: BreakSets): Draft[] {
  const drafts: Draft[] = [];
  let from = 0;
  const toks = (a: number, b: number): string[] => ew.slice(a, b + 1).map((x) => x.w);
  for (let i = 1; i <= ew.length; i++) {
    const prev = ew[i - 1];
    const cur = ew[i];
    let cut = i === ew.length;
    if (!cut && prev && cur) {
      const first = ew[from];
      const curLen = toks(from, i - 1).join(' ').length;
      const gap = cur.s - prev.e;
      const merged = sets.merged.has(i);
      const overflow = wrapTokens([...toks(from, i - 1), cur.w]) === null;
      const tooLong = first ? cur.e - first.s > MAX_CUE_SEC : false;
      if (sets.forced.has(i) || overflow || tooLong) cut = true;
      else if (!merged) {
        if (STRONG.test(prev.w) || gap >= CUE_PAUSE_SEC) cut = true;
        else if (SOFT.test(prev.w) && curLen >= 30) cut = true;
      }
    }
    if (cut) {
      drafts.push({ from, to: i - 1 });
      from = i;
    }
  }
  return drafts;
}

/** Joins a too-short cue to the following one when the rules allow it. */
function mergeShort(ew: EditedWord[], drafts: Draft[], sets: BreakSets): Draft[] {
  const out: Draft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    let d = drafts[i] as Draft;
    for (;;) {
      const next = drafts[i + 1];
      const first = ew[d.from];
      const last = ew[d.to];
      if (!next || !first || !last) break;
      const dur = last.e - first.s;
      const nextFirst = ew[next.from];
      const nextLast = ew[next.to];
      if (dur >= MIN_CUE_SEC || !nextFirst || !nextLast) break;
      const ok =
        !sets.forced.has(next.from) &&
        nextFirst.s - last.e < CUE_PAUSE_SEC &&
        nextLast.e - first.s <= MAX_CUE_SEC &&
        wrapTokens(ew.slice(d.from, next.to + 1).map((x) => x.w)) !== null;
      if (!ok) break;
      d = { from: d.from, to: next.to };
      i++;
    }
    out.push(d);
  }
  return out;
}

export function buildCues(words: Word[], edits: SubtitleEdits): Cue[] {
  const ew = applyEdits(words, edits);
  if (ew.length === 0) return [];
  const sets = breakSets(ew, edits);
  const drafts = mergeShort(ew, draftCues(ew, sets), sets);
  const cues: Cue[] = [];
  for (const d of drafts) {
    const first = ew[d.from];
    const last = ew[d.to];
    if (!first || !last) continue;
    const lines = wrapTokens(ew.slice(d.from, d.to + 1).map((x) => x.w)) ?? [
      ew
        .slice(d.from, d.to + 1)
        .map((x) => x.w)
        .join(' '),
    ];
    cues.push({
      id: cues.length,
      s: first.s,
      e: Math.max(last.e, first.s),
      text: lines.join('\n'),
      wordStart: first.origIndex,
      wordEnd: last.origIndex,
    });
  }
  // timing: extend short cues into the gap, then make the sequence monotonic and non-overlapping
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i] as Cue;
    const next = cues[i + 1];
    if (c.e - c.s < MIN_CUE_SEC) {
      const room = next ? Math.max(c.e, next.s) : c.s + MIN_CUE_SEC;
      c.e = Math.min(c.s + MIN_CUE_SEC, room);
    }
    if (next && next.s - c.e < 0.12 && next.s >= c.e) c.e = next.s; // no flicker between cues
  }
  let t = 0;
  for (const c of cues) {
    if (c.s < t) c.s = t;
    if (c.e <= c.s) c.e = c.s + 0.1;
    c.s = round3(c.s);
    c.e = round3(c.e);
    t = c.e;
  }
  return cues;
}

/* --------------------------------------------- SRT / VTT -------------------------------------------- */

function timestamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Plain cue text: no control chars, no blank lines (they end an SRT/VTT cue), trimmed lines. */
function cleanText(text: string): string[] {
  return text
    .replace(CONTROL, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
}

export interface CueRange {
  startSec: number;
  endSec: number;
}

/** Cues of `range` as clip-relative cues (overlap >= 40 % of the cue or >= 1 s; times clamped). */
export function cuesInRange(cues: Cue[], range?: CueRange): Cue[] {
  if (!range) return cues;
  const out: Cue[] = [];
  for (const c of cues) {
    const s = Math.max(c.s, range.startSec);
    const e = Math.min(c.e, range.endSec);
    if (e <= s) continue;
    if ((e - s) / Math.max(0.001, c.e - c.s) < 0.4 && e - s < 1) continue;
    out.push({ ...c, id: out.length, s: s - range.startSec, e: e - range.startSec });
  }
  return out;
}

export function toSrt(cues: Cue[], range?: CueRange): string {
  return cuesInRange(cues, range)
    .map((c, i) => {
      // "<" would be read as an HTML tag by most players
      const lines = cleanText(c.text).map((l) =>
        l.replace(/-->/g, '->').replace(/<(?=[a-zA-Z/!])/g, '‹'),
      );
      return `${i + 1}\n${timestamp(c.s, ',')} --> ${timestamp(c.e, ',')}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

export function toVtt(cues: Cue[], range?: CueRange): string {
  const body = cuesInRange(cues, range)
    .map((c) => {
      const lines = cleanText(c.text).map((l) =>
        l
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/--&gt;/g, '--&gt;'),
      );
      return `${timestamp(c.s, '.')} --> ${timestamp(c.e, '.')}\n${lines.join('\n')}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
