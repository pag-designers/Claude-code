/**
 * Beat detection in pure TypeScript (no dependencies): spectral-flux onset envelope → tempo by
 * autocorrelation (log-Gaussian prior around 120 BPM) → grid phase by comb scoring → beat times.
 *
 * Input: mono PCM. Output: beat times in seconds (empty when the audio has no steady pulse).
 */

const N = 512;
const HOP = 128;

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Onset strength per hop (frames/s = sampleRate / HOP). */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): { env: Float64Array; fps: number } {
  const frames = Math.max(0, Math.floor((pcm.length - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const bins = N / 2;
  const maxBin = Math.min(bins, Math.floor((10000 / sampleRate) * N));
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = (pcm[off + i] as number) * (win[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < maxBin; k++) {
      const mag = Math.hypot(re[k] as number, im[k] as number);
      const c = Math.log1p(100 * mag); // log compression: soft hits count too
      cur[k] = c;
      const d = c - (prev[k] as number);
      if (d > 0) s += d;
    }
    flux[f] = f === 0 ? 0 : s;
    [prev, cur] = [cur, prev];
  }
  // remove the slowly varying part, half-wave rectify
  const fps = sampleRate / HOP;
  const w = Math.max(3, Math.round(fps * 0.4));
  const env = new Float64Array(frames);
  let acc = 0;
  const csum = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) {
    acc += flux[i] as number;
    csum[i + 1] = acc;
  }
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(frames, i + w + 1);
    const mean = ((csum[b] as number) - (csum[a] as number)) / (b - a);
    env[i] = Math.max(0, (flux[i] as number) - mean);
  }
  return { env, fps };
}

export interface TempoEstimate {
  bpm: number;
  /** Period in envelope frames (fractional). */
  period: number;
  /** 0..1 strength of the autocorrelation peak. */
  confidence: number;
}

export function estimateTempo(env: Float64Array, fps: number, minBpm = 60, maxBpm = 200): TempoEstimate | null {
  const n = env.length;
  if (n < fps * 4) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i] as number;
  mean /= n;
  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = (env[i] as number) - mean;
    energy += (x[i] as number) ** 2;
  }
  if (energy <= 1e-9) return null;
  const lagMin = Math.floor((fps * 60) / maxBpm);
  const lagMax = Math.ceil((fps * 60) / minBpm);
  const ac = new Float64Array(lagMax + 2);
  for (let lag = Math.max(1, lagMin - 1); lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (x[i] as number) * (x[i - lag] as number);
    ac[lag] = s / energy;
  }
  // tempo prior: log-Gaussian around 120 BPM, sigma = 0.9 octave, plus a bonus for the 2x period (strong pulse)
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const two = lag * 2 <= lagMax + 1 ? Math.max(0, ac[lag * 2] as number) * 0.5 : 0;
    const score = ((ac[lag] as number) + two) * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const raw = ac[bestLag] as number;
  if (bestLag === 0 || raw < 0.08) return null;
  // parabolic refinement on the raw autocorrelation
  const a0 = ac[bestLag - 1] as number;
  const a1 = ac[bestLag] as number;
  const a2 = ac[bestLag + 1] as number;
  const denom = a0 - 2 * a1 + a2;
  const shift = Math.abs(denom) > 1e-12 ? (0.5 * (a0 - a2)) / denom : 0;
  const period = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  return { bpm: (fps * 60) / period, period, confidence: Math.min(1, raw) };
}

/** Comb score of a beat grid (period p frames, phase φ frames) over the envelope. */
function gridScore(env: Float64Array, p: number, phase: number): number {
  let s = 0;
  let count = 0;
  for (let t = phase; t < env.length - 1; t += p) {
    const i = Math.round(t);
    // tolerance of ±1 frame for jitter
    const v = Math.max(env[Math.max(0, i - 1)] as number, env[i] as number, env[Math.min(env.length - 1, i + 1)] as number);
    s += v;
    count++;
  }
  return count > 0 ? s / Math.sqrt(count) : 0;
}

/** Envelope frame i starts at i·HOP; a transient is detected ~N/2 later than the frame start (calibrated on click tracks: +24 ms). */
export const BEAT_LATENCY_SEC = -0.024;

/**
 * Beat times (s) of `pcm` (mono). `latency` compensates the analysis window delay (seconds); the default is
 * calibrated on synthetic click tracks (see tests).
 */
export function detectBeats(pcm: Float32Array, sampleRate: number, latency = BEAT_LATENCY_SEC): number[] {
  const { env, fps } = onsetEnvelope(pcm, sampleRate);
  const tempo = estimateTempo(env, fps);
  if (!tempo) return [];
  // refine period + phase jointly
  let bestScore = -Infinity;
  let bestP = tempo.period;
  let bestPhase = 0;
  for (let dp = -0.03; dp <= 0.03001; dp += 0.005) {
    const p = tempo.period * (1 + dp);
    const steps = Math.max(8, Math.ceil(p));
    for (let k = 0; k < steps * 2; k++) {
      const phase = (k / (steps * 2)) * p;
      const sc = gridScore(env, p, phase);
      if (sc > bestScore) {
        bestScore = sc;
        bestP = p;
        bestPhase = phase;
      }
    }
  }
  // local refinement of the phase (sub-frame): evaluate with a fine search
  for (let k = -10; k <= 10; k++) {
    const ph = bestPhase + k * 0.1;
    const sc = gridScore(env, bestP, ph);
    if (sc > bestScore) {
      bestScore = sc;
      bestPhase = ph;
    }
  }
  const out: number[] = [];
  const dur = pcm.length / sampleRate;
  for (let t = bestPhase; ; t += bestP) {
    const sec = t / fps - latency;
    if (sec > dur) break;
    if (sec >= 0) out.push(Math.round(sec * 1000) / 1000);
  }
  return out;
}
