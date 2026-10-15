import type { Sentence } from '@shared/pipeline';

/**
 * Prompt-side transcript helpers. The model is shown one sentence per line,
 *   `S<id> [mm:ss] {speaker-on-change} text`
 * and answers with sentence ids; times are derived from the sentences in code, never taken from
 * model output (kills timestamp hallucination).
 */

/** `mm:ss`, or `h:mm:ss` when `forceHours` (use for any video that reaches one hour). */
export function fmtClock(sec: number, forceHours = false): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 || forceHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Makes untrusted text safe to embed between our XML-ish tags: control chars/newlines become
 * spaces and angle brackets become typographic ones, so transcript, title or description text can
 * never forge or close a tag such as `</transcript>`.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Speaker labels from the analysis stage look like "S1"/"S2", which collide with our "S<id>"
 * sentence labels. Show them as "spk1"/"spk2" instead.
 */
export function speakerTag(label: string): string {
  const n = /(\d+)\s*$/.exec(label)?.[1];
  return n ? `spk${n}` : cleanText(label).slice(0, 20);
}

export function formatSentenceLines(sentences: readonly Sentence[], forceHours = false): string {
  const lines: string[] = [];
  let prevSpeaker: string | null = null;
  for (const s of sentences) {
    const text = cleanText(s.text);
    if (!text) continue;
    let tag = '';
    if (s.speaker && s.speaker !== prevSpeaker) tag = `{${speakerTag(s.speaker)}} `;
    if (s.speaker) prevSpeaker = s.speaker;
    lines.push(`S${s.id} [${fmtClock(s.s, forceHours)}] ${tag}${text}`);
  }
  return lines.join('\n');
}

/**
 * Rough token estimate: ≈3.6 characters per token plus ~6 tokens of label overhead for every
 * "S<id> [mm:ss]" transcript line (digits and brackets tokenise poorly). Only used for the
 * pre-call budget check and cost previews - real usage comes back from the API.
 */
export function estimateTokens(text: string): number {
  const labelled = text.match(/^S\d+ \[/gm)?.length ?? 0;
  return Math.ceil(text.length / 3.6) + labelled * 6;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/* ----------------------------------------- quote location ----------------------------------------- */

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface SentenceIndex {
  sentences: readonly Sentence[];
  haystack: string;
  /** Start offset of each sentence inside `haystack`. */
  offsets: number[];
}

export function buildSentenceIndex(sentences: readonly Sentence[]): SentenceIndex {
  let haystack = ' ';
  const offsets: number[] = [];
  for (const s of sentences) {
    offsets.push(haystack.length);
    haystack += normalizeForMatch(s.text) + ' ';
  }
  return { sentences, haystack, offsets };
}

/**
 * Finds `quote` (punctuation/case-insensitive) in the transcript and returns the sentence it starts
 * in; with several occurrences, the one closest to `hintIndex`. Null when the text is not there
 * verbatim, i.e. the model paraphrased or invented it.
 */
export function locateQuote(
  index: SentenceIndex,
  quote: string,
  hintIndex: number,
): Sentence | null {
  const q = normalizeForMatch(quote);
  if (q.length < 8) return null;
  const needle = ` ${q} `;
  let best = -1;
  let bestDist = Infinity;
  for (let from = index.haystack.indexOf(needle); from !== -1;) {
    const si = sentenceAtOffset(index.offsets, from + 1);
    const dist = Math.abs(si - hintIndex);
    if (dist < bestDist) {
      best = si;
      bestDist = dist;
    }
    from = index.haystack.indexOf(needle, from + 1);
  }
  return best >= 0 ? (index.sentences[best] ?? null) : null;
}

function sentenceAtOffset(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
