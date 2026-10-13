/** Pure transcript / notes helpers. */
import type { Sentence, Transcript, VideoAnalysis } from '@shared/pipeline';
import { formatClock } from './format';

/** Index of the sentence being spoken at time `t` (the last sentence starting at or before t); -1 before the first. */
export function activeSentenceIndex(
  sentences: readonly Pick<Sentence, 's' | 'e'>[],
  t: number,
): number {
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((sentences[mid]?.s ?? Infinity) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Same for chapters / any [start,end) ranges. */
export function activeRangeIndex(
  ranges: readonly { start: number; end: number }[],
  t: number,
): number {
  let ans = -1;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r && t >= r.start && (t < r.end || i === ranges.length - 1)) ans = i;
  }
  return ans;
}

export interface TranscriptMatch {
  sentence: number;
  /** [from, to) character offsets inside sentence.text */
  ranges: [number, number][];
}

/** Case-insensitive substring search; every occurrence is returned, grouped by sentence. */
export function findMatches(
  sentences: readonly Pick<Sentence, 'text'>[],
  query: string,
): TranscriptMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: TranscriptMatch[] = [];
  sentences.forEach((s, i) => {
    const hay = s.text.toLowerCase();
    const ranges: [number, number][] = [];
    let from = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at < 0) break;
      ranges.push([at, at + q.length]);
      from = at + q.length;
    }
    if (ranges.length) out.push({ sentence: i, ranges });
  });
  return out;
}

export function transcriptToText(t: Pick<Transcript, 'sentences'>, withTimestamps = true): string {
  let lastSpeaker: string | null | undefined;
  const lines: string[] = [];
  for (const s of t.sentences) {
    const label = s.speaker && s.speaker !== lastSpeaker ? `${s.speaker}: ` : '';
    lastSpeaker = s.speaker;
    lines.push(`${withTimestamps ? `[${formatClock(s.s)}] ` : ''}${label}${s.text}`);
  }
  return lines.join('\n');
}

export function notesToMarkdown(title: string, a: VideoAnalysis): string {
  const out: string[] = [`# ${title}`, ''];
  const list = (h: string, items: string[]) => {
    if (!items.length) return;
    out.push(`## ${h}`, ...items.map((i) => `- ${i}`), '');
  };
  const stamped = (h: string, items: { text: string; at: number }[]) =>
    list(
      h,
      items.map((i) => `[${formatClock(i.at)}] ${i.text}`),
    );
  out.push('## Summary', a.overview.summary, '');
  list('Key takeaways', a.overview.takeaways);
  list('Key points', a.notes.keyPoints);
  stamped('Quotes', a.notes.quotes);
  stamped('Numbers', a.notes.numbers);
  stamped('Claims', a.notes.claims);
  list('Action items', a.notes.actionItems);
  return out.join('\n').trim();
}
