/**
 * Multi-signal candidate generation (BRIEF §4.5). Pure: transcript + audio signals in, ranked and
 * de-duplicated MomentCandidate[] out. The LLM later re-ranks these; `prior` is only a pre-filter.
 */
import {
  durationRange,
  type AudioSignals,
  type MomentCandidate,
  type PipelineOptions,
  type Transcript,
} from '@shared/pipeline';
import {
  clamp01,
  hasNumberText,
  hookStrength,
  selfContainment,
  sentenceHasQuestion,
  tokensOf,
} from './heuristics';
import { buildIndex, paddedEnd, paddedStart, type WordIndex } from './words';

/** Windows are rejected when they are mostly silence/music. */
const MIN_WORDS_PER_SEC = 1.0;
/** Two candidates overlapping more than this fraction of the shorter one are duplicates. */
const MAX_OVERLAP = 0.3;
const MEDIAN_RADIUS_SEC = 45;

export interface GenerateArgs {
  transcript: Transcript;
  signals: AudioSignals;
  options: PipelineOptions;
  window: { startSec: number; endSec: number };
  maxCandidates: number;
  /** Optional pre-built index (cache). */
  index?: WordIndex;
}

interface SentInfo {
  first: number;
  last: number;
  id: number;
  s: number;
  e: number;
  text: string;
  hasQ: boolean;
  hasNum: boolean;
}

interface HopStats {
  hop: number;
  n: number;
  /** prefix sums, length n+1 */
  excess: Float64Array;
  high: Float64Array;
  rate: Float64Array;
  rate2: Float64Array;
  laugh: Float64Array;
  speakerChanges: number[];
}

/** Median of a numeric array (copying + sorting). */
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function buildHopStats(signals: AudioSignals, fromSec: number, toSec: number): HopStats {
  const hop = signals.hopSec > 0 ? signals.hopSec : 0.5;
  const n = Math.max(signals.loudness.length, signals.speechRate.length, Math.ceil(toSec / hop));
  const loud = signals.loudness;
  // Loudness may contain -Infinity / sentinel silence values; replace with the quietest finite value.
  let floor = Infinity;
  for (const v of loud) if (Number.isFinite(v) && v < floor) floor = v;
  if (!Number.isFinite(floor)) floor = -70;
  const L = (h: number): number => {
    const v = loud[h];
    return v !== undefined && Number.isFinite(v) ? v : floor;
  };

  const excess = new Float64Array(n + 1);
  const high = new Float64Array(n + 1);
  const rate = new Float64Array(n + 1);
  const rate2 = new Float64Array(n + 1);
  const laugh = new Float64Array(n + 1);

  const h0 = Math.max(0, Math.floor((fromSec - MEDIAN_RADIUS_SEC) / hop));
  const h1 = Math.min(n, Math.ceil((toSec + MEDIAN_RADIUS_SEC) / hop));
  const radius = Math.max(1, Math.round(MEDIAN_RADIUS_SEC / hop));
  const exc = new Float64Array(n);
  const hi = new Float64Array(n);
  if (loud.length > 0) {
    for (let h = h0; h < h1; h++) {
      const lo = Math.max(0, h - radius);
      const up = Math.min(n - 1, h + radius);
      // subsample the neighbourhood so the median stays cheap on long videos
      const stride = Math.max(1, Math.floor((up - lo) / 120));
      const vals: number[] = [];
      for (let k = lo; k <= up; k += stride) vals.push(L(k));
      const med = median(vals);
      const d = L(h) - med;
      exc[h] = d > 0 ? d : 0;
      hi[h] = d > 2 ? 1 : 0;
    }
  }
  const lg = new Float64Array(n);
  for (const ev of signals.laughter) {
    const a = Math.max(0, Math.floor(ev.s / hop));
    const b = Math.min(n, Math.ceil(ev.e / hop));
    for (let h = a; h < b; h++) lg[h] = Math.max(lg[h] ?? 0, ev.score);
  }
  for (let h = 0; h < n; h++) {
    excess[h + 1] = (excess[h] ?? 0) + (exc[h] ?? 0);
    high[h + 1] = (high[h] ?? 0) + (hi[h] ?? 0);
    const r = signals.speechRate[h] ?? 0;
    rate[h + 1] = (rate[h] ?? 0) + (Number.isFinite(r) ? r : 0);
    rate2[h + 1] = (rate2[h] ?? 0) + (Number.isFinite(r) ? r * r : 0);
    laugh[h + 1] = (laugh[h] ?? 0) + (lg[h] ?? 0);
  }
  return {
    hop,
    n,
    excess,
    high,
    rate,
    rate2,
    laugh,
    speakerChanges: [...signals.speakerChanges].sort((a, b) => a - b),
  };
}

function countInRange(sorted: number[], a: number, b: number): number {
  let c = 0;
  for (const t of sorted) {
    if (t >= b) break;
    if (t >= a) c++;
  }
  return c;
}

export function generateCandidatesImpl(args: GenerateArgs): MomentCandidate[] {
  const { transcript, signals, options, window, maxCandidates } = args;
  if (maxCandidates <= 0) return [];
  const range = durationRange(options);
  const ix = args.index ?? buildIndex(transcript, signals.silences);
  const { words } = ix;

  // sentences fully inside the window
  const sents: SentInfo[] = [];
  for (const sp of ix.sentences) {
    const a = words[sp.first];
    const b = words[sp.last];
    if (!a || !b) continue;
    if (a.s < window.startSec - 1e-6 || b.e > window.endSec + 1e-6) continue;
    sents.push({
      first: sp.first,
      last: sp.last,
      id: sp.id,
      s: a.s,
      e: b.e,
      text: sp.text,
      hasQ: sentenceHasQuestion(sp.text),
      hasNum: hasNumberText(tokensOf(sp.text), sp.text),
    });
  }
  if (sents.length === 0) return [];

  const stats = buildHopStats(signals, window.startSec, window.endSec);
  const q = new Int32Array(sents.length + 1);
  const num = new Int32Array(sents.length + 1);
  sents.forEach((s, k) => {
    q[k + 1] = (q[k] ?? 0) + (s.hasQ ? 1 : 0);
    num[k + 1] = (num[k] ?? 0) + (s.hasNum ? 1 : 0);
  });
  const wordPrefix = new Int32Array(sents.length + 1);
  sents.forEach((s, k) => (wordPrefix[k + 1] = (wordPrefix[k] ?? 0) + (s.last - s.first + 1)));

  const target = range.minSec + 0.65 * (range.maxSec - range.minSec);
  const cands: (MomentCandidate & { _a: number; _b: number })[] = [];

  for (let a = 0; a < sents.length; a++) {
    const sa = sents[a];
    if (!sa) continue;
    const ps = paddedStart(ix, sa.first);
    // hook features depend on the start only
    const openWords: string[] = [];
    for (let k = sa.first; k < words.length && openWords.length < 14; k++) {
      const w = words[k];
      if (!w || w.s - sa.s >= 3) break;
      openWords.push(w.w.trim());
    }
    const hook = hookStrength(openWords.join(' '), sa.text, openWords.length);
    const firstTokens = tokensOf(sa.text).slice(0, 4);
    const firstRaw = (words[sa.first]?.w ?? '').trim().replace(/^[^\p{L}]+/u, '');
    const startsLower =
      firstRaw !== '' && firstRaw === firstRaw.toLowerCase() && firstRaw !== firstRaw.toUpperCase();

    for (let b = a; b < sents.length; b++) {
      const sb = sents[b];
      if (!sb) continue;
      // a long silence inside the window means dead air / music: no window may span it
      if (b > a && sb.s - (sents[b - 1]?.e ?? sb.s) > 6) break;
      const pe = paddedEnd(ix, sb.last);
      const dur = pe - ps;
      if (dur > range.maxSec) break;
      if (dur < range.minSec) continue;
      const nWords = (wordPrefix[b + 1] ?? 0) - (wordPrefix[a] ?? 0);
      const wps = nWords / dur;
      if (wps < MIN_WORDS_PER_SEC) continue;

      const h0 = Math.max(0, Math.floor(ps / stats.hop));
      const h1 = Math.min(stats.n, Math.max(h0 + 1, Math.ceil(pe / stats.hop)));
      const hn = Math.max(1, h1 - h0);

      // energy: loudness above the local median
      const meanExcess = ((stats.excess[h1] ?? 0) - (stats.excess[h0] ?? 0)) / hn;
      const fracHigh = ((stats.high[h1] ?? 0) - (stats.high[h0] ?? 0)) / hn;
      const energy = clamp01(0.6 * (meanExcess / 4) + 0.4 * (fracHigh / 0.4));

      // speech-rate change (coefficient of variation of words/s inside the clip)
      const sum = (stats.rate[h1] ?? 0) - (stats.rate[h0] ?? 0);
      const sum2 = (stats.rate2[h1] ?? 0) - (stats.rate2[h0] ?? 0);
      const mean = sum / hn;
      const variance = Math.max(0, sum2 / hn - mean * mean);
      const speechRateChange = mean > 0.2 ? clamp01((Math.sqrt(variance) / mean) * 2.5) : 0;

      const laughSecs = (((stats.laugh[h1] ?? 0) - (stats.laugh[h0] ?? 0)) * stats.hop) / 1;
      const laughter = clamp01(laughSecs / 2.5);

      const hasQuestion = (q[b + 1] ?? 0) - (q[a] ?? 0) > 0;
      const hasNumber = (num[b + 1] ?? 0) - (num[a] ?? 0) > 0;

      const lastWord = words[sb.last]?.w ?? '';
      const wordsAfterFirst = nWords - (sa.last - sa.first + 1);
      const speakerChanges = countInRange(stats.speakerChanges, sa.s, sb.e);
      const selfContained = selfContainment({
        firstTokens,
        lastWord,
        lastSentence: sb.text,
        firstSentence: sa.text,
        sentenceCount: b - a + 1,
        wordsAfterFirstSentence: wordsAfterFirst,
        speakerChanges,
        startsAtSentenceStart: true,
        endsAtSentenceEnd: true,
        startsLowercase: startsLower,
      });

      const density = clamp01(wps / 2.4);
      const lengthFit = clamp01(
        1 - Math.abs(dur - target) / Math.max(1, range.maxSec - range.minSec),
      );
      let prior =
        0.28 * hook.score +
        0.12 * energy +
        0.05 * speechRateChange +
        0.08 * laughter +
        (hasQuestion ? 0.05 : 0) +
        (hasNumber ? 0.04 : 0) +
        0.25 * selfContained +
        0.08 * density +
        0.05 * lengthFit;
      if (selfContained < 0.35) prior *= 0.6;
      prior = clamp01(prior);

      const text = sents
        .slice(a, b + 1)
        .map((s) => s.text.trim())
        .join(' ');
      cands.push({
        id: `m${Math.round(ps * 1000)}-${Math.round(pe * 1000)}`,
        s: ps,
        e: pe,
        prior,
        sentenceIds: sents.slice(a, b + 1).map((s) => s.id),
        text,
        signals: {
          hookStrength: hook.score,
          energy,
          speechRateChange,
          laughter,
          hasQuestion,
          hasNumber,
          selfContained,
        },
        _a: a,
        _b: b,
      });
    }
  }

  // non-maximum suppression
  cands.sort((x, y) => y.prior - x.prior || x.s - y.s || x.e - y.e);
  const picked: MomentCandidate[] = [];
  for (const c of cands) {
    if (picked.length >= maxCandidates) break;
    let dup = false;
    for (const p of picked) {
      const inter = Math.min(c.e, p.e) - Math.max(c.s, p.s);
      if (inter > 0 && inter / Math.min(c.e - c.s, p.e - p.s) > MAX_OVERLAP) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      const { _a, _b, ...rest } = c;
      void _a;
      void _b;
      picked.push(rest);
    }
  }
  return picked;
}
