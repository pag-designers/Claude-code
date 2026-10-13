import type { AnalysisService } from '../../pipeline/contracts';
import { segmentSentences } from './sentences';
import { computeSignals } from './signals';

export { segmentSentences, joinWords } from './sentences';
export { computeSignals } from './signals';
export { buildTranscript, toTranscriptWords } from './transcript';

export function createAnalysisService(): AnalysisService {
  return {
    segmentSentences: (words, signals) => segmentSentences(words, signals),
    computeSignals: (args) => computeSignals(args),
  };
}
