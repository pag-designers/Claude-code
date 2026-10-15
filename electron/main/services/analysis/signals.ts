import type { AudioSignals, Word } from '@shared/pipeline';
import { AbortError, LineBuffer, runProcess } from '../media/proc';
import { isTerminal, pauseBefore } from './sentences';
import { FRAME_SEC, FrameAnalyzer, SAMPLE_RATE, median, percentile, type FrameSeries } from './dsp';

/**
 * Audio signals for the moment finder (BRIEF §4.3). Everything is a pure function of (wav, words,
 * duration): no clocks, no randomness, no state.
 *
 * Pipeline (the WAV is only ever STREAMED through ffmpeg - PCM is never held in memory):
 *   pass 1  ffmpeg decodes -> s16le on stdout -> FrameAnalyzer folds it into 50 ms frames
 *           (level, brightness, ZCR, F0). ~72k frames per hour of audio.
 *   pass 2  ffmpeg `silencedetect` (threshold adapted to the file's noise floor from pass 1) and
 *           `ebur128` momentary loudness (LUFS, 400 ms window, printed every 100 ms by ametadata).
 *   derive  per-hop series + laughter + speaker changes from frames/words/silences (pure functions
 *           below, unit tested without ffmpeg).
 */

export const HOP_SEC = 0.5;
/** Window of the words/second estimate. */
export const SPEECH_RATE_WINDOW_SEC = 3;
/** Loudness floor: ebur128 reports ~-120 for digital silence; values below this are clamped. */
export const LOUDNESS_FLOOR_LUFS = -70;
export const MIN_SILENCE_SEC = 0.3;

export interface ComputeSignalsArgs {
  wavPath: string;
  words: Word[];
  durationSec: number;
  ffmpegPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number | null, message?: string) => void;
}

export interface Ebur128Sample {
  /** End time of the 100 ms block the momentary value was reported on. */
  t: number;
  lufs: number;
}

export interface Silence {
  s: number;
  e: number;
}

/* --------------------------------------------- ffmpeg passes ---------------------------------------------- */

async function pass1Frames(args: ComputeSignalsArgs): Promise<FrameSeries> {
  const analyzer = new FrameAnalyzer();
  const expectedBytes = Math.max(1, args.durationSec * SAMPLE_RATE * 2);
  let bytes = 0;
  const res = await runProcess(
    args.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-i',
      args.wavPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ],
    {
      signal: args.signal,
      onStdout: (c) => {
        analyzer.push(c);
        bytes += c.length;
        args.onProgress?.(Math.min(0.55, (bytes / expectedBytes) * 0.55), 'Analysing audio');
      },
    },
  );
  if (res.code !== 0)
    throw new Error(`ffmpeg failed decoding ${args.wavPath}: ${lastLines(res.stderrTail)}`);
  return analyzer.finish();
}

async function pass2Silence(
  args: ComputeSignalsArgs,
  thresholdDb: number,
): Promise<{ silences: Silence[]; loudness: Ebur128Sample[] }> {
  const filter =
    `silencedetect=noise=${thresholdDb.toFixed(1)}dB:d=${MIN_SILENCE_SEC},` +
    'ebur128=metadata=1:peak=none,' +
    'ametadata=mode=print:file=-:key=lavfi.r128.M';
  const silenceLog: string[] = [];
  const meta: string[] = [];
  const errLines = new LineBuffer((l) => {
    if (l.includes('silencedetect')) silenceLog.push(l);
  });
  const outLines = new LineBuffer((l) => {
    if (l.length > 0) meta.push(l);
  });
  const res = await runProcess(
    args.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-v',
      'info',
      '-i',
      args.wavPath,
      '-vn',
      '-af',
      filter,
      '-f',
      'null',
      '-',
    ],
    {
      signal: args.signal,
      onStdout: (c) => outLines.push(c),
      onStderr: (c) => errLines.push(c),
    },
  );
  errLines.flush();
  outLines.flush();
  if (res.code !== 0)
    throw new Error(`ffmpeg loudness/silence pass failed: ${lastLines(res.stderrTail)}`);
  return {
    silences: parseSilenceLog(silenceLog, args.durationSec),
    loudness: parseEbur128(meta),
  };
}

const lastLines = (s: string, n = 3): string => s.trim().split('\n').slice(-n).join(' | ');

/* ------------------------------------------------ parsers -------------------------------------------------- */

/** Parses `silence_start: x` / `silence_end: y | silence_duration: z` lines from ffmpeg's log. */
export function parseSilenceLog(lines: readonly string[], durationSec: number): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of lines) {
    const st = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (st?.[1] !== undefined) {
      open = Math.max(0, Number(st[1]));
      continue;
    }
    const en = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (en?.[1] !== undefined && open !== null) {
      const e = Math.min(durationSec, Number(en[1]));
      if (e > open) out.push({ s: open, e });
      open = null;
    }
  }
  if (open !== null && durationSec > open) out.push({ s: open, e: durationSec });
  return out;
}

/** Parses ametadata print output: `frame:N pts:P pts_time:T` followed by `lavfi.r128.M=V`. */
export function parseEbur128(lines: readonly string[]): Ebur128Sample[] {
  const out: Ebur128Sample[] = [];
  let t: number | null = null;
  for (const line of lines) {
    const pt = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (pt?.[1] !== undefined) {
      t = Number(pt[1]);
      continue;
    }
    const m = /lavfi\.r128\.M=\s*(-?[\d.]+|-?inf|nan)/i.exec(line);
    if (m?.[1] !== undefined && t !== null) {
      const v = Number(m[1]);
      out.push({ t: t + 0.1, lufs: Number.isFinite(v) ? v : LOUDNESS_FLOOR_LUFS });
      t = null;
    }
  }
  return out;
}

/* ---------------------------------------------- pure derivation --------------------------------------------- */

/**
 * Silence threshold relative to the file's own noise floor: a quiet studio (-65 dB floor) and a noisy
 * room (-45 dB floor) both put "silence" about a quarter of the way up from the floor to speech level.
 */
export function adaptiveSilenceDb(levelDb: Float32Array): number {
  const active: number[] = [];
  for (const v of levelDb) if (v > -90) active.push(v);
  if (active.length < 20) return -45;
  const floor = percentile(active, 5);
  const loud = percentile(active, 90);
  const thr = floor + 0.25 * (loud - floor);
  return Math.max(-58, Math.min(-32, thr));
}

export const hopCount = (durationSec: number): number =>
  Math.max(1, Math.ceil(durationSec / HOP_SEC));

/** Mean momentary LUFS (power average) of the samples that end inside each hop. */
export function loudnessSeries(samples: readonly Ebur128Sample[], durationSec: number): number[] {
  const n = hopCount(durationSec);
  const sum = new Float64Array(n);
  const cnt = new Uint32Array(n);
  for (const s of samples) {
    const i = Math.min(n - 1, Math.max(0, Math.ceil((s.t - 1e-6) / HOP_SEC) - 1));
    sum[i] = (sum[i] ?? 0) + Math.pow(10, Math.max(LOUDNESS_FLOOR_LUFS, s.lufs) / 10);
    cnt[i] = (cnt[i] ?? 0) + 1;
  }
  const out: number[] = [];
  let last = LOUDNESS_FLOOR_LUFS;
  for (let i = 0; i < n; i++) {
    const c = cnt[i] ?? 0;
    if (c > 0) last = Math.max(LOUDNESS_FLOOR_LUFS, 10 * Math.log10((sum[i] ?? 0) / c));
    out.push(round(last, 2)); // carry the previous value over a (rare) hole
  }
  return out;
}

/** Words per second inside a sliding window centred on each hop; words are counted by midpoint. */
export function speechRateSeries(words: readonly Word[], durationSec: number): number[] {
  const n = hopCount(durationSec);
  const mids = words.map((w) => (w.s + w.e) / 2).sort((a, b) => a - b);
  const half = SPEECH_RATE_WINDOW_SEC / 2;
  const out: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * HOP_SEC;
    const a = Math.max(0, c - half);
    const b = Math.min(durationSec, c + half);
    while (lo < mids.length && (mids[lo] ?? 0) < a) lo++;
    if (hi < lo) hi = lo;
    while (hi < mids.length && (mids[hi] ?? 0) < b) hi++;
    out.push(round((hi - lo) / Math.max(0.5, b - a), 3));
  }
  return out;
}

const LAUGH_TOKEN =
  /^[[(]?\s*(?:(?:ha|he|hah|heh|hee|haa|ho)+[!.,?]*|lol|laughs?|laughter|laughing|applause|clapping|cheers?|cheering)\s*[\])]?[!.,?]*$/i;

/** Per-frame mask: true where a (non-laughter-token) word is being spoken, with a small dilation. */
function speechMask(frames: FrameSeries, words: readonly Word[]): Uint8Array {
  const mask = new Uint8Array(frames.count);
  const pad = 0.06;
  for (const w of words) {
    if (LAUGH_TOKEN.test(w.w.trim())) continue;
    const a = Math.max(0, Math.floor((w.s - pad) / FRAME_SEC));
    const b = Math.min(frames.count - 1, Math.ceil((w.e + pad) / FRAME_SEC));
    for (let i = a; i <= b; i++) mask[i] = 1;
  }
  return mask;
}

export interface LaughterOptions {
  /** Minimum duration of a reported burst. */
  minSec?: number;
  /** Largest dip inside a burst that is bridged ("ha - ha - ha"). */
  bridgeSec?: number;
  /** Minimum score to report. */
  minScore?: number;
}

/**
 * Laughter / applause heuristic - loud, non-speech, noisy or rhythmically modulated bursts.
 *
 * A frame is a candidate when ALL hold:
 *   - no recognised word covers it (words that are themselves laughter tokens like "haha"/"[laughter]"
 *     do not count as speech);
 *   - it is loud: within 10 dB of the speech reference (75th percentile level of word-covered frames; the
 *     90th percentile of all non-silent frames when there are no words) and above -45 dBFS.
 * Candidates are merged (dips <= bridgeSec are bridged) and kept when >= minSec. Each burst is scored
 * 0..1 as 0.30 loudness-vs-speech + 0.20 duration (saturates at 1.5 s) + 0.30 character + 0.20
 * polyphony, where character = max(noisiness, modulation): noisiness = mean brightness `hf`
 * (applause/crowd noise are broadband), modulation = std-dev of the frame level (laughter pulses; steady
 * music/hum do not); polyphony = 1 - voicedFraction / 0.55 (overlapping voices have no single clear
 * pitch). Bursts are discarded when character < 0.3 (steady, tonal: music beds, hum, room tone) or when
 * more than 55 % of their frames are voiced (almost certainly ONE person talking that the ASR dropped).
 *
 * Honest limits: it targets audience laughter, cheering and applause. It cannot tell applause from other
 * loud broadband noise (a door slam, rain), and one person laughing alone is deliberately NOT reported
 * because it is indistinguishable from speech the ASR missed. Laughter overlapping speech is invisible.
 * Treat the score as a prior for "something non-verbal and loud happens here", not as a classifier.
 */
export function detectLaughter(
  frames: FrameSeries,
  words: readonly Word[],
  opts: LaughterOptions = {},
): { s: number; e: number; score: number }[] {
  const minSec = opts.minSec ?? 0.6;
  const bridge = Math.round((opts.bridgeSec ?? 0.3) / FRAME_SEC);
  const minScore = opts.minScore ?? 0.4;
  if (frames.count === 0) return [];
  const mask = speechMask(frames, words);

  const speechLevels: number[] = [];
  const allActive: number[] = [];
  for (let i = 0; i < frames.count; i++) {
    const l = frames.levelDb[i] ?? -140;
    if (l > -60) allActive.push(l);
    if (mask[i] === 1 && l > -60) speechLevels.push(l);
  }
  const ref =
    speechLevels.length >= 20
      ? percentile(speechLevels, 75)
      : allActive.length >= 20
        ? percentile(allActive, 90)
        : -30;
  const thr = Math.max(-45, ref - 10);

  const cand = new Uint8Array(frames.count);
  for (let i = 0; i < frames.count; i++) {
    cand[i] = mask[i] === 0 && (frames.levelDb[i] ?? -140) >= thr ? 1 : 0;
  }

  const runs: [number, number][] = [];
  let i = 0;
  while (i < frames.count) {
    if (cand[i] !== 1) {
      i++;
      continue;
    }
    let end = i;
    let j = i + 1;
    while (j < frames.count) {
      if (cand[j] === 1) {
        end = j;
        j++;
      } else if (j - end <= bridge) {
        j++;
      } else break;
    }
    runs.push([i, end]);
    i = end + 1;
  }

  const out: { s: number; e: number; score: number }[] = [];
  for (const [a, b] of runs) {
    const dur = (b - a + 1) * FRAME_SEC;
    if (dur < minSec) continue;
    let lvlSum = 0;
    let hfSum = 0;
    let voiced = 0;
    const lv: number[] = [];
    for (let k = a; k <= b; k++) {
      const l = frames.levelDb[k] ?? -140;
      lvlSum += l;
      hfSum += frames.hf[k] ?? 0;
      if ((frames.f0[k] ?? 0) > 0) voiced++;
      lv.push(l);
    }
    const n = b - a + 1;
    const meanLvl = lvlSum / n;
    const meanHf = hfSum / n;
    const voicedFrac = voiced / n;
    // A single clean voice (a word the ASR dropped, a filler, a breath) has a clear pitch in most
    // frames; a crowd of overlapping voices or broadband noise does not.
    if (voicedFrac > 0.55) continue;
    const loudness = clamp01((meanLvl - (ref - 12)) / 12);
    const noisiness = clamp01((meanHf - 0.25) / 0.9);
    const modulation = clamp01(stdev(lv) / 6);
    const character = Math.max(noisiness, modulation);
    if (character < 0.3) continue;
    const polyphony = clamp01(1 - voicedFrac / 0.55);
    const score = 0.3 * loudness + 0.2 * clamp01(dur / 1.5) + 0.3 * character + 0.2 * polyphony;
    if (score < minScore) continue;
    out.push({
      s: round(a * FRAME_SEC, 2),
      e: round((b + 1) * FRAME_SEC, 2),
      score: round(score, 3),
    });
  }
  return out;
}

export interface SpeakerChangeOptions {
  /** Shortest pause that can carry a turn change (after a sentence end). */
  minPauseSec?: number;
  /** Pause that can carry a turn change even in the middle of a sentence (interruption). */
  midSentencePauseSec?: number;
  /** Context window on each side of the pause. */
  windowSec?: number;
  /** Minimum separation between two reported changes. */
  minSeparationSec?: number;
}

/**
 * Speaker-change heuristic. There is NO diarisation (BRIEF: pyannote is LATER); this looks only at turn
 * boundaries that are acoustically plausible:
 *   1. candidate = a pause between consecutive words (ASR gap or audio silence, whichever is longer)
 *      of >= minPauseSec that follows a sentence end (. ? !), or >= midSentencePauseSec anywhere - people
 *      do not hand over the floor in the middle of a clause after a short breath;
 *   2. compare the voice 2.5 s before vs 2.5 s after, using only word-covered voiced frames:
 *        dp = |ln(F0_after / F0_before)| / ln(1.3)      (median fundamental frequency; 1.0 == 30 % shift)
 *        dl = |level_after - level_before| / 6 dB        (median level - mic distance / loudness of voice)
 *        dh = |hf_after - hf_before| / 0.25              (median brightness - rough timbre)
 *   3. evidence = dp + 0.5 dl + 0.5 dh; a change is reported when dp >= 0.8 (F0 differs by >= ~23 %) and
 *      evidence >= 1.3 - 0.2 * min(pause, 1.5 s) (longer pauses need less evidence). Reported time =
 *      middle of the pause. The same speaker's pitch moves ~10-15 % between sentences (question
 *      intonation, emphasis), which is why the pitch gate sits well above that.
 *   4. changes closer than minSeparationSec keep the strongest one.
 * Both sides need >= 8 voiced frames, otherwise the pause is skipped (no evidence either way).
 *
 * Honest limits: F0 separates male/female and many same-gender pairs, but two similar voices (e.g. two
 * women at 190 vs 200 Hz) are NOT separated, and a speaker who suddenly raises their pitch by >25 %
 * (excited question) can be mistaken for a new one; overlapping speech and back-channels ("mm-hm") are
 * invisible. Treat results as hints that only ever *split* sentences. Tuned on a real 19-min
 * host/guest/guest interview: finds the male/female turn changes, misses female/female ones.
 */
export function detectSpeakerChanges(
  frames: FrameSeries,
  words: readonly Word[],
  silences: readonly Silence[],
  opts: SpeakerChangeOptions = {},
): number[] {
  const minPause = opts.minPauseSec ?? 0.4;
  const midPause = opts.midSentencePauseSec ?? 1.2;
  const win = opts.windowSec ?? 2.5;
  const minSep = opts.minSeparationSec ?? 1.5;
  if (frames.count === 0 || words.length < 2) return [];
  const mask = speechMask(frames, words);

  /** Median voice descriptors of word-covered frames in [t0, t1). */
  const describe = (t0: number, t1: number): { f0: number; level: number; hf: number } | null => {
    const a = Math.max(0, Math.floor(t0 / FRAME_SEC));
    const b = Math.min(frames.count, Math.ceil(t1 / FRAME_SEC));
    const f0: number[] = [];
    const lv: number[] = [];
    const hf: number[] = [];
    for (let i = a; i < b; i++) {
      if (mask[i] !== 1) continue;
      const p = frames.f0[i] ?? 0;
      if (p <= 0) continue;
      f0.push(p);
      lv.push(frames.levelDb[i] ?? -140);
      hf.push(frames.hf[i] ?? 0);
    }
    if (f0.length < 8) return null;
    return { f0: median(f0), level: median(lv), hf: median(hf) };
  };

  const cands: { t: number; strength: number }[] = [];
  const pauses = pauseBefore(words, silences);
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const next = words[i];
    if (!prev || !next) continue;
    const pause = pauses[i] ?? 0;
    if (pause < minPause) continue;
    if (!isTerminal(prev.w) && pause < midPause) continue;

    const before = describe(prev.e - win, prev.e);
    const after = describe(next.s, next.s + win);
    if (!before || !after) continue;
    const dp = Math.abs(Math.log(after.f0 / before.f0)) / Math.log(1.3);
    const dl = Math.abs(after.level - before.level) / 6;
    const dh = Math.abs(after.hf - before.hf) / 0.25;
    const evidence = dp + 0.5 * dl + 0.5 * dh;
    if (dp >= 0.8 && evidence >= 1.3 - 0.2 * Math.min(pause, 1.5)) {
      cands.push({ t: (prev.e + next.s) / 2, strength: evidence });
    }
  }

  // Non-maximum suppression within minSep.
  const kept: { t: number; strength: number }[] = [];
  for (const c of cands) {
    const last = kept[kept.length - 1];
    if (last && c.t - last.t < minSep) {
      if (c.strength > last.strength) kept[kept.length - 1] = c;
    } else kept.push(c);
  }
  return kept.map((c) => round(c.t, 2));
}

export function deriveSignals(args: {
  frames: FrameSeries;
  words: readonly Word[];
  durationSec: number;
  silences: readonly Silence[];
  loudness: readonly Ebur128Sample[];
}): AudioSignals {
  const { frames, words, durationSec, silences, loudness } = args;
  return {
    hopSec: HOP_SEC,
    durationSec,
    loudness: loudnessSeries(loudness, durationSec),
    speechRate: speechRateSeries(words, durationSec),
    silences: silences.map((s) => ({ s: round(s.s, 3), e: round(s.e, 3) })),
    laughter: detectLaughter(frames, words),
    speakerChanges: detectSpeakerChanges(frames, words, silences),
    sceneCuts: [],
  };
}

/* ------------------------------------------------ entry point ------------------------------------------------ */

export async function computeSignals(args: ComputeSignalsArgs): Promise<AudioSignals> {
  if (args.signal?.aborted) throw new AbortError();
  args.onProgress?.(0, 'Analysing audio');
  const frames = await pass1Frames(args);
  const durationSec = args.durationSec > 0 ? args.durationSec : frames.count * FRAME_SEC;
  const thr = adaptiveSilenceDb(frames.levelDb);
  args.onProgress?.(0.6, 'Detecting silences and loudness');
  const { silences, loudness } = await pass2Silence({ ...args, durationSec }, thr);
  args.onProgress?.(0.95, 'Finding non-speech bursts');
  const out = deriveSignals({ frames, words: args.words, durationSec, silences, loudness });
  args.onProgress?.(1, 'Audio analysed');
  return out;
}

/* ------------------------------------------------- helpers -------------------------------------------------- */

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const round = (v: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
function stdev(a: readonly number[]): number {
  if (a.length < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}
