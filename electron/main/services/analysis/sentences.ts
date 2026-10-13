import type { AudioSignals, Sentence, Word } from '@shared/pipeline';

/**
 * Sentence segmentation from word timestamps (no NLP model, deterministic).
 *
 * A sentence ends after a word when ANY of:
 *   1. the word ends in terminal punctuation (. ? ! … 。？！) and is not a known abbreviation / initial;
 *   2. the pause to the next word is > PAUSE_SPLIT_SEC (the pause is the longer of the ASR word gap and
 *      the audio silence that overlaps it - Whisper tends to stretch word ends into pauses);
 *   3. the next word starts a different speaker (a `speakerChanges` time falls between the two words);
 *   4. the sentence would exceed MAX_WORDS / MAX_SEC - then it is cut at the most natural interior
 *      break (longest pause, comma/semicolon, conjunction) instead of at an arbitrary position.
 *
 * Every word belongs to exactly one sentence; `wordStart..wordEnd` are inclusive indices into `words`.
 */

export const PAUSE_SPLIT_SEC = 0.7;
export const MAX_WORDS = 35;
export const MAX_SEC = 18;
const MIN_PART_WORDS = 6;

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'mt',
  'gen',
  'sen',
  'rep',
  'gov',
  'lt',
  'col',
  'sgt',
  'capt',
  'inc',
  'ltd',
  'co',
  'e.g',
  'i.e',
  'approx',
  'dept',
  'est',
]);

const CONJUNCTIONS = new Set([
  'and',
  'but',
  'so',
  'because',
  'which',
  'that',
  'then',
  'while',
  'although',
  'though',
  'however',
  'or',
  'if',
  'when',
]);

const CJK = /[⺀-鿿가-힯豈-﫿぀-ヿ]/u;
const TERMINAL = /[.?!…。？！]["'”’)\]]*$/u;
const ONLY_PUNCT = /^[\p{P}\p{S}]+$/u;

export function isTerminal(word: string): boolean {
  const w = word.trim();
  if (!TERMINAL.test(w)) return false;
  const bare = w.replace(/["'”’)\]]*$/u, '');
  if (bare.endsWith('…') || bare.endsWith('...')) return true;
  const core = bare.replace(/[.?!。？！]+$/u, '').toLowerCase();
  // "?" and "!" are always terminal; only a plain full stop can be an abbreviation / initial.
  if (/[?!？！。]$/u.test(bare)) return true;
  if (ABBREVIATIONS.has(core)) return false;
  if (/^[a-z]$/i.test(core) && core !== 'i' && bare.toLowerCase() === `${core}.`) return false; // "J." initials (but "So do I." ends)
  return true;
}

const endsSoftBreak = (word: string): boolean => /[,;:–—-]["'”’)\]]*$/u.test(word.trim());

/** Joins words into display text, honouring Whisper-style leading spaces and CJK (no spaces). */
export function joinWords(words: readonly Word[]): string {
  let out = '';
  let prev: string | null = null;
  for (const word of words) {
    const w = word.w;
    if (prev === null) {
      out = w.trimStart();
    } else if (/^\s/.test(w) || /\s$/.test(prev)) {
      out += w;
    } else if (ONLY_PUNCT.test(w)) {
      out += w;
    } else if (CJK.test(w.charAt(0)) || CJK.test(prev.charAt(prev.length - 1))) {
      out += w;
    } else {
      out += ` ${w}`;
    }
    prev = w;
  }
  return out.trim();
}

/**
 * `pause[i]` = silence between word i-1 and word i, in seconds (pause[0] = 0). It is the larger of the
 * ASR gap and the longest audio silence whose midpoint lies between the two word midpoints: Whisper
 * tends to stretch a word's end into the pause that follows it, so the word gap alone under-reports.
 */
export function pauseBefore(
  words: readonly Word[],
  silences: readonly { s: number; e: number }[],
): Float64Array {
  const n = words.length;
  const pause = new Float64Array(n);
  const mid = (i: number): number => ((words[i]?.s ?? 0) + (words[i]?.e ?? 0)) / 2;
  let si = 0;
  for (let i = 1; i < n; i++) {
    const a = words[i - 1];
    const b = words[i];
    if (!a || !b) continue;
    let p = Math.max(0, b.s - a.e);
    const lo = mid(i - 1);
    const hi = mid(i);
    while (si < silences.length) {
      const sil = silences[si];
      if (!sil || (sil.s + sil.e) / 2 >= lo) break;
      si++;
    }
    for (let k = si; k < silences.length; k++) {
      const sil = silences[k];
      if (!sil) continue;
      const m = (sil.s + sil.e) / 2;
      if (m >= hi) break;
      p = Math.max(p, sil.e - sil.s);
    }
    pause[i] = p;
  }
  return pause;
}

type SilenceInput = Pick<AudioSignals, 'silences' | 'speakerChanges'>;

export function segmentSentences(words: Word[], signals?: Partial<SilenceInput>): Sentence[] {
  const n = words.length;
  if (n === 0) return [];
  const silences = signals?.silences ?? [];
  const changes = [...(signals?.speakerChanges ?? [])].sort((a, b) => a - b);

  const mid = (i: number): number => ((words[i]?.s ?? 0) + (words[i]?.e ?? 0)) / 2;

  const gapBefore = pauseBefore(words, silences);

  // Speaker change before word i: a change time t with mid(i-1) < t <= mid(i).
  const changeBefore = new Uint8Array(n);
  {
    let ci = 0;
    for (let i = 1; i < n; i++) {
      const lo = mid(i - 1);
      const hi = mid(i);
      while (ci < changes.length && (changes[ci] ?? 0) <= lo) ci++;
      if (ci < changes.length && (changes[ci] ?? Infinity) <= hi) changeBefore[i] = 1;
    }
  }

  // Pass 1: hard boundaries. `starts` holds the index of the first word of every sentence.
  const starts: number[] = [0];
  for (let i = 1; i < n; i++) {
    const prev = words[i - 1];
    if (!prev) continue;
    if (isTerminal(prev.w) || (gapBefore[i] ?? 0) > PAUSE_SPLIT_SEC || changeBefore[i] === 1) {
      starts.push(i);
    }
  }

  // Pass 2: cap over-long sentences at their most natural interior break.
  const bounds: [number, number][] = [];
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k] ?? 0;
    const b = (starts[k + 1] ?? n) - 1;
    splitLong(a, b, bounds);
  }

  function splitLong(a: number, b: number, out: [number, number][]): void {
    const len = b - a + 1;
    const dur = (words[b]?.e ?? 0) - (words[a]?.s ?? 0);
    if (len <= MAX_WORDS && dur <= MAX_SEC) {
      out.push([a, b]);
      return;
    }
    // Candidate break after word k (k in [a+MIN-1, b-MIN]) so both parts keep >= MIN_PART_WORDS.
    const first = a + MIN_PART_WORDS - 1;
    let last = Math.min(b - MIN_PART_WORDS, a + MAX_WORDS - 1);
    // Keep the first part within MAX_SEC when the minimum part size allows it.
    while (last > first && (words[last]?.e ?? 0) - (words[a]?.s ?? 0) > MAX_SEC) last--;
    if (last < first) {
      out.push([a, b]);
      return;
    }
    let bestK = first;
    let bestScore = -Infinity;
    for (let k = first; k <= last; k++) {
      const next = words[k + 1];
      const cur = words[k];
      if (!next || !cur) continue;
      let score = gapBefore[k + 1] ?? 0;
      if (endsSoftBreak(cur.w)) score += 0.3;
      if (
        CONJUNCTIONS.has(
          next.w
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}']/gu, ''),
        )
      )
        score += 0.15;
      // Prefer breaks that make the first part close to the cap, so we produce few parts.
      score += 0.2 * ((k - a + 1) / MAX_WORDS);
      if (score > bestScore) {
        bestScore = score;
        bestK = k;
      }
    }
    out.push([a, bestK]);
    splitLong(bestK + 1, b, out);
  }

  // Speaker labels. Without any speaker signal the speaker is unknown (null). With a signal (even an
  // empty change list) we alternate S1/S2 at every change: two-party conversation is the overwhelmingly
  // common case and alternation keeps the label stable when the same person speaks again.
  const labelled = signals?.speakerChanges !== undefined;
  let speaker = 1;
  const sentences: Sentence[] = [];
  for (let id = 0; id < bounds.length; id++) {
    const bound = bounds[id];
    if (!bound) continue;
    const [a, b] = bound;
    if (id > 0 && changeBefore[a] === 1) speaker = speaker === 1 ? 2 : 1;
    sentences.push({
      id,
      s: words[a]?.s ?? 0,
      e: words[b]?.e ?? 0,
      text: joinWords(words.slice(a, b + 1)),
      speaker: labelled ? `S${speaker}` : null,
      wordStart: a,
      wordEnd: b,
    });
  }
  return sentences;
}
