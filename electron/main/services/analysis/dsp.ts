/**
 * Streaming frame analysis of 16 kHz mono signed-16-bit PCM.
 *
 * Nothing here keeps the PCM: samples are folded into fixed 50 ms frames and each frame is reduced to
 * four numbers, so a 1-hour file costs ~72k frames x 16 bytes regardless of how it is chunked.
 *
 *   levelDb  RMS level in dBFS (full-scale sine = -3.0).
 *   hf       energy of the first difference over energy of the signal. ~0 for low tones, ~0.1-0.6 for
 *            voiced speech, ~2 for white noise (hence "brightness / noisiness").
 *   zcr      zero crossings per sample (informational; noise ~0.5).
 *   f0       fundamental frequency in Hz from a normalised autocorrelation on a 4x decimated frame,
 *            0 when the frame is unvoiced/quiet. Accurate to a few percent, which is plenty for the
 *            speaker-change heuristic (it only compares medians of many frames).
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_SEC = 0.05;
export const FRAME_LEN = Math.round(SAMPLE_RATE * FRAME_SEC); // 800 samples

const DECIM = 4;
const PITCH_SR = SAMPLE_RATE / DECIM; // 4 kHz
const PITCH_MIN_LAG = Math.floor(PITCH_SR / 400); // 400 Hz
const PITCH_MAX_LAG = Math.ceil(PITCH_SR / 70); // 70 Hz
const MIN_PITCH_LEVEL_DB = -52;
const MIN_PITCH_CORR = 0.55;

export interface FrameSeries {
  frameSec: number;
  count: number;
  levelDb: Float32Array;
  hf: Float32Array;
  zcr: Float32Array;
  f0: Float32Array;
}

export interface FrameFeatures {
  levelDb: number;
  hf: number;
  zcr: number;
  f0: number;
}

/** Features of ONE frame of samples scaled to -1..1. Exported for unit tests. */
export function analyzeFrame(x: Float32Array): FrameFeatures {
  const n = x.length;
  let sum = 0;
  let diffSum = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i] ?? 0;
    sum += v * v;
    if (i > 0) {
      const d = v - prev;
      diffSum += d * d;
      if (v >= 0 !== prev >= 0) zc++;
    }
    prev = v;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const levelDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140;
  const hf = sum > 1e-12 ? Math.min(4, diffSum / sum) : 0;
  const f0 = levelDb >= MIN_PITCH_LEVEL_DB ? estimatePitch(x) : 0;
  return { levelDb, hf, zcr: zc / Math.max(1, n - 1), f0 };
}

/** Normalised-autocorrelation pitch on a 4x decimated copy. Returns Hz or 0 (unvoiced). */
export function estimatePitch(x: Float32Array): number {
  const m = Math.floor(x.length / DECIM);
  if (m < PITCH_MAX_LAG * 2) return 0;
  const d = new Float32Array(m);
  let mean = 0;
  for (let j = 0; j < m; j++) {
    const b = j * DECIM;
    const v = ((x[b] ?? 0) + (x[b + 1] ?? 0) + (x[b + 2] ?? 0) + (x[b + 3] ?? 0)) / DECIM;
    d[j] = v;
    mean += v;
  }
  mean /= m;
  for (let j = 0; j < m; j++) d[j] = (d[j] ?? 0) - mean;

  const lags = PITCH_MAX_LAG + 2;
  const r = new Float32Array(lags + 1);
  let best = 0;
  for (let l = PITCH_MIN_LAG - 1; l <= lags; l++) {
    let c = 0;
    let e1 = 0;
    let e2 = 0;
    for (let n = 0; n + l < m; n++) {
      const a = d[n] ?? 0;
      const b = d[n + l] ?? 0;
      c += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const den = Math.sqrt(e1 * e2);
    const v = den > 1e-12 ? c / den : 0;
    r[l] = v;
    if (l >= PITCH_MIN_LAG && l <= PITCH_MAX_LAG && v > best) best = v;
  }
  if (best < MIN_PITCH_CORR) return 0;
  // Smallest lag that is a local maximum and within 15 % of the global best (avoids octave-down errors).
  const need = best * 0.85;
  for (let l = PITCH_MIN_LAG; l <= PITCH_MAX_LAG; l++) {
    const v = r[l] ?? 0;
    if (v >= need && v >= (r[l - 1] ?? 0) && v >= (r[l + 1] ?? 0)) {
      const a = r[l - 1] ?? 0;
      const c = r[l + 1] ?? 0;
      const denom = a - 2 * v + c;
      const shift = Math.abs(denom) > 1e-9 ? (0.5 * (a - c)) / denom : 0;
      const lag = l + Math.max(-1, Math.min(1, shift));
      return PITCH_SR / lag;
    }
  }
  return 0;
}

/** Feed it arbitrary-sized Buffers of s16le PCM; call `finish()` once. */
export class FrameAnalyzer {
  private readonly frame = new Float32Array(FRAME_LEN);
  private fill = 0;
  private carry: number | null = null; // dangling low byte of an odd-sized chunk
  private readonly levelDb: number[] = [];
  private readonly hf: number[] = [];
  private readonly zcr: number[] = [];
  private readonly f0: number[] = [];
  /** Total samples seen (for progress / sanity checks). */
  samples = 0;

  push(chunk: Buffer): void {
    let i = 0;
    const len = chunk.length;
    if (this.carry !== null && len > 0) {
      this.addSample(toInt16(this.carry, chunk[0] ?? 0));
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < len; i += 2) this.addSample(chunk.readInt16LE(i));
    if (i < len) this.carry = chunk[i] ?? 0;
  }

  private addSample(v: number): void {
    this.samples++;
    this.frame[this.fill++] = v / 32768;
    if (this.fill === FRAME_LEN) {
      this.emit(this.frame);
      this.fill = 0;
    }
  }

  private emit(x: Float32Array): void {
    const f = analyzeFrame(x);
    this.levelDb.push(f.levelDb);
    this.hf.push(f.hf);
    this.zcr.push(f.zcr);
    this.f0.push(f.f0);
  }

  finish(): FrameSeries {
    // A trailing partial frame (>= half a frame) is analysed zero-padded so the tail is not lost.
    if (this.fill >= FRAME_LEN / 2) {
      this.frame.fill(0, this.fill);
      this.emit(this.frame);
    }
    this.fill = 0;
    return {
      frameSec: FRAME_SEC,
      count: this.levelDb.length,
      levelDb: Float32Array.from(this.levelDb),
      hf: Float32Array.from(this.hf),
      zcr: Float32Array.from(this.zcr),
      f0: Float32Array.from(this.f0),
    };
  }
}

function toInt16(lo: number, hi: number): number {
  const v = (hi << 8) | lo;
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Linear-interpolated percentile (0..100) of a numeric array; NaN-free input assumed. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (pos - lo);
}

export const median = (values: ArrayLike<number>): number => percentile(values, 50);
