import type { Transcript, Word } from '@shared/pipeline';
import type { TranscribeResult } from '../sidecar';
import { segmentSentences } from './sentences';
import type { AudioSignals } from '@shared/pipeline';

/**
 * Converts the sidecar's snake_case wire result into `Transcript` words: leading/trailing whitespace is
 * trimmed (Whisper prefixes words with a space), empty tokens are dropped, times are rounded to ms and
 * made monotonic (e >= s, s >= previous s), probability is kept as `p`.
 */
export function toTranscriptWords(result: Pick<TranscribeResult, 'segments'>): Word[] {
  const out: Word[] = [];
  let lastS = 0;
  for (const seg of result.segments) {
    for (const w of seg.words) {
      const text = w.word.trim();
      if (text.length === 0) continue;
      const s = Math.max(lastS, Math.round(w.start * 1000) / 1000);
      const e = Math.max(s, Math.round(w.end * 1000) / 1000);
      out.push({ w: text, s, e, p: Math.round(w.probability * 1000) / 1000 });
      lastS = s;
    }
  }
  return out;
}

/** Assembles a full `Transcript` (words + sentences) from a sidecar result. */
export function buildTranscript(
  result: TranscribeResult,
  signals?: Pick<AudioSignals, 'silences' | 'speakerChanges'>,
): Transcript {
  const words = toTranscriptWords(result);
  return {
    language: result.language,
    languageProbability: result.language_probability,
    durationSec: result.duration,
    model: result.model,
    words,
    sentences: segmentSentences(words, signals),
  };
}
