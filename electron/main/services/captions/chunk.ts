/**
 * Caption chunking: groups words into 1-3 word on-screen lines without awkward splits.
 * Phrase boundaries (strong punctuation, pauses, commas after >=2 words) are hard; inside a phrase a
 * small DP picks the partition: prefers 2-3 words, avoids lines that end on function words
 * ("of", "the", "and"), avoids lonely single words, honours the per-line character budget.
 */
import { SOFT_PUNCT, STRONG_PUNCT, WEAK_END, normalizeToken, type CaptionWord } from './text';

/** A pause at least this long ends the phrase (and the on-screen line). */
export const PAUSE_BREAK_SEC = 0.25;

export interface ChunkOptions {
  maxWords: number;
  maxChars: number;
}

/** Splits into phrases (arrays of words). */
export function splitPhrases(words: CaptionWord[]): CaptionWord[][] {
  const phrases: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    cur.push(w);
    const next = words[i + 1];
    const gap = next ? next.s - w.e : Infinity;
    const strong = STRONG_PUNCT.test(w.text);
    const soft = SOFT_PUNCT.test(w.text) && cur.length >= 2;
    if (strong || soft || gap >= PAUSE_BREAK_SEC || !next) {
      phrases.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) phrases.push(cur);
  return phrases;
}

const chunkChars = (ws: CaptionWord[]): number =>
  ws.reduce((n, w) => n + [...w.text].length, 0) + Math.max(0, ws.length - 1);

/** Partition of one phrase into chunks (arrays of consecutive words). */
export function partitionPhrase(phrase: CaptionWord[], opt: ChunkOptions): CaptionWord[][] {
  const n = phrase.length;
  if (n <= 1) return [phrase];
  // best[i] = cheapest cost to cover words [0,i)
  const best: number[] = new Array<number>(n + 1).fill(Infinity);
  const choice: number[] = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let size = Math.min(opt.maxWords, i); size >= 1; size--) {
      const from = i - size;
      const prev = best[from];
      if (prev === undefined || !Number.isFinite(prev)) continue;
      const chunk = phrase.slice(from, i);
      let cost = size === 1 ? 0.8 : size === 2 ? 0.15 : 0;
      if (size > 1 && chunkChars(chunk) > opt.maxChars) cost += 100;
      const last = chunk[chunk.length - 1];
      const isFinal = i === n;
      if (last && !isFinal) {
        if (WEAK_END.has(normalizeToken(last.text))) cost += 1.0;
        if (SOFT_PUNCT.test(last.text)) cost -= 0.4;
      }
      const total = prev + cost;
      if (total < (best[i] ?? Infinity) - 1e-9) {
        best[i] = total;
        choice[i] = size;
      }
    }
  }
  const out: CaptionWord[][] = [];
  let i = n;
  while (i > 0) {
    const size = choice[i] || 1;
    out.unshift(phrase.slice(i - size, i));
    i -= size;
  }
  return out;
}

export function chunkWords(words: CaptionWord[], opt: ChunkOptions): CaptionWord[][] {
  return splitPhrases(words).flatMap((p) => partitionPhrase(p, opt));
}
