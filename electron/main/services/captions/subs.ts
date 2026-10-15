/** Phrase-level SRT / WebVTT (<= 42 characters per cue, single line). */
import type { Word } from '@shared/pipeline';
import { SOFT_PUNCT, STRONG_PUNCT, prepareWords, type CaptionWord } from './text';

export const MAX_CUE_CHARS = 42;
const MAX_CUE_SEC = 6;
/** A pause this long between words starts a new cue. */
const CUE_PAUSE_SEC = 0.5;
const MIN_CUE_SEC = 0.5;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function buildCues(words: Word[], startSec: number, endSec: number): Cue[] {
  const ws = prepareWords(words, startSec, endSec, false);
  const phrases: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const len = (a: CaptionWord[]): number => a.map((w) => w.text).join(' ').length;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!w) continue;
    if (cur.length > 0) {
      const wouldBe = len(cur) + 1 + w.text.length;
      const first = cur[0];
      if (wouldBe > MAX_CUE_CHARS || (first && w.e - first.s > MAX_CUE_SEC)) {
        phrases.push(cur);
        cur = [];
      }
    }
    cur.push(w);
    const next = ws[i + 1];
    const gap = next ? next.s - w.e : Infinity;
    const softOk = SOFT_PUNCT.test(w.text) && len(cur) >= 24;
    if (STRONG_PUNCT.test(w.text) || gap >= CUE_PAUSE_SEC || softOk || !next) {
      phrases.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) phrases.push(cur);

  const cues: Cue[] = phrases.map((p) => ({
    start: p[0]?.s ?? 0,
    end: p[p.length - 1]?.e ?? 0,
    text: p.map((w) => w.text).join(' '),
  }));
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    if (!c) continue;
    if (next && next.start - c.end < 0.12) c.end = next.start; // no flicker between cues
    if (c.end - c.start < MIN_CUE_SEC) {
      const room = next ? next.start : Math.max(0, endSec - startSec);
      c.end = Math.min(room, c.start + MIN_CUE_SEC);
      if (c.end <= c.start) c.end = c.start + 0.1;
    }
  }
  return cues;
}

function ts(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

export function buildSrt(words: Word[], startSec: number, endSec: number): string {
  return buildCues(words, startSec, endSec)
    .map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function buildVtt(words: Word[], startSec: number, endSec: number): string {
  const body = buildCues(words, startSec, endSec)
    // "-->" and "&", "<" have meaning in WebVTT cue text
    .map((c) => {
      const safe = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '--&gt;');
      return `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${safe}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
