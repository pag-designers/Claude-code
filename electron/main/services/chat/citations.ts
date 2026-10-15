import { fmtClock } from '../llm/transcript';

/**
 * Timestamp citations. The assistant writes `[mm:ss]` / `[h:mm:ss]` (also `[mm:ss-mm:ss]`) right after
 * a claim; the markers STAY in the streamed text (the UI linkifies them) and are additionally reported
 * once each through `onCitation`. Markers outside the video are not reported (a model can invent
 * them); they stay visible in the text, which the UI should render as plain text (it only linkifies
 * markers it received as citations).
 */

const MARKER =
  /\[\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s*[-–—]\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2}))?\s*\]/g;

export interface ParsedMarker {
  t: number;
  label: string;
  /** Offset of the marker in the scanned text and its length. */
  index: number;
  length: number;
}

function toSeconds(h: string | undefined, m: string, s: string): number | null {
  const mm = Number(m);
  const ss = Number(s);
  const hh = h === undefined ? 0 : Number(h);
  if (ss > 59) return null;
  if (h !== undefined && mm > 59) return null;
  return hh * 3600 + mm * 60 + ss;
}

/** All well-formed markers in `text` (range markers report their start). */
export function parseMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const t = toSeconds(m[1], m[2] ?? '0', m[3] ?? '0');
    if (t === null) continue;
    out.push({
      t,
      label: m[0].slice(1, -1).replace(/\s+/g, ''),
      index: m.index,
      length: m[0].length,
    });
  }
  return out;
}

/** Incremental scanner: feed streamed deltas, get each valid, new citation once. */
export class CitationScanner {
  private buf = '';
  /** Offset from which the buffer still has to be scanned (a marker may be split across deltas). */
  private from = 0;
  private readonly seen = new Set<number>();
  readonly all: { t: number; label: string }[] = [];

  constructor(private readonly durationSec: number) {}

  push(delta: string): { t: number; label: string }[] {
    this.buf += delta;
    const fresh: { t: number; label: string }[] = [];
    const tail = this.buf.slice(this.from);
    let consumed = 0;
    for (const m of parseMarkers(tail)) {
      consumed = Math.max(consumed, m.index + m.length);
      // 1 s tolerance: transcript clocks are floored, the video can end mid-second
      if (m.t > this.durationSec + 1 || this.seen.has(m.t)) continue;
      this.seen.add(m.t);
      const c = { t: m.t, label: m.label };
      this.all.push(c);
      fresh.push(c);
    }
    // keep an unfinished "[..." (at most 24 chars) for the next delta
    const open = tail.lastIndexOf('[');
    const unfinished = open >= consumed && tail.length - open <= 24 && !tail.includes(']', open);
    this.from += unfinished ? open : tail.length;
    return fresh;
  }
}

/** Clock label in the same style as the transcript the model saw. */
export const clockLabel = (sec: number, hours: boolean) => fmtClock(sec, hours);
