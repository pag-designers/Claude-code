/**
 * MomentService implementation (candidate generation + boundary snapping). See contracts.ts.
 */
import { durationRange } from '@shared/pipeline';
import type { AudioSignals, Transcript } from '@shared/pipeline';
import type { MomentService } from '../../pipeline/contracts';
import { generateCandidatesImpl } from './generate';
import { buildIndex, snapSpan, type WordIndex } from './words';

export { PAD_MAX, PAD_MIN, PAD_START, PAD_END, GUARD, buildIndex, snapSpan } from './words';
export type { WordIndex, SnapResult } from './words';
export { generateCandidatesImpl } from './generate';
export { hookStrength, selfContainment } from './heuristics';

interface CacheEntry {
  wordCount: number;
  sentenceCount: number;
  silenceCount: number;
  index: WordIndex;
}

export function createMomentService(): MomentService {
  // The orchestrator calls snap() once per LLM moment against the same transcript: cache the index.
  const cache = new WeakMap<Transcript, CacheEntry>();
  const indexFor = (t: Transcript, s: AudioSignals): WordIndex => {
    const hit = cache.get(t);
    if (
      hit &&
      hit.wordCount === t.words.length &&
      hit.sentenceCount === t.sentences.length &&
      hit.silenceCount === s.silences.length
    ) {
      return hit.index;
    }
    const index = buildIndex(t, s.silences);
    cache.set(t, {
      wordCount: t.words.length,
      sentenceCount: t.sentences.length,
      silenceCount: s.silences.length,
      index,
    });
    return index;
  };

  return {
    generateCandidates(args) {
      return generateCandidatesImpl({ ...args, index: indexFor(args.transcript, args.signals) });
    },
    snap({ startSec, endSec, transcript, signals, options }) {
      const ix = indexFor(transcript, signals);
      const r = snapSpan(ix, startSec, endSec, durationRange(options));
      return { startSec: r.startSec, endSec: r.endSec };
    },
  };
}
