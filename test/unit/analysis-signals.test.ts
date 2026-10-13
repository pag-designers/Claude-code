import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME_LEN,
  FRAME_SEC,
  FrameAnalyzer,
  SAMPLE_RATE,
  analyzeFrame,
  estimatePitch,
} from '../../electron/main/services/analysis/dsp';
import {
  HOP_SEC,
  LOUDNESS_FLOOR_LUFS,
  adaptiveSilenceDb,
  computeSignals,
  deriveSignals,
  detectLaughter,
  detectSpeakerChanges,
  hopCount,
  loudnessSeries,
  parseEbur128,
  parseSilenceLog,
  speechRateSeries,
} from '../../electron/main/services/analysis/signals';
import { createAnalysisService } from '../../electron/main/services/analysis';
import { audioSignalsSchema, type Word } from '../../shared/pipeline';
import { isAbortError } from '../../electron/main/services/media/proc';

const require_ = createRequire(import.meta.url);
const FFMPEG = require_('ffmpeg-static') as string;

/* ------------------------------------ in-memory PCM synthesis (no ffmpeg) ------------------------------------ */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A "voiced" surrogate: fundamental + 2 harmonics with syllable-rate tremolo, amplitude in dBFS RMS. */
function voiced(f0: number, sec: number, dbfs = -22): Float32Array {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const amp = Math.pow(10, dbfs / 20) * Math.SQRT2 * 0.8;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const trem = 0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t);
    out[i] =
      amp *
      trem *
      (Math.sin(2 * Math.PI * f0 * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.25 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return out;
}

function noise(sec: number, dbfs: number, seed = 1): Float32Array {
  const rnd = lcg(seed);
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const amp = Math.pow(10, dbfs / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) out[i] = amp * (rnd() * 2 - 1);
  return out;
}

const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SAMPLE_RATE));

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toPcm(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * 32768))), i * 2);
  }
  return b;
}

function analyze(x: Float32Array, chunk = 65536) {
  const pcm = toPcm(x);
  const fa = new FrameAnalyzer();
  for (let i = 0; i < pcm.length; i += chunk) fa.push(pcm.subarray(i, i + chunk));
  return fa.finish();
}

/** Evenly spaced words (`rate` per second) over [from,to); the last word ends with a full stop. */
function wordsOver(from: number, to: number, rate = 3): Word[] {
  const out: Word[] = [];
  const step = 1 / rate;
  for (let t = from + 0.1; t + 0.28 < to; t += step) out.push({ w: 'word', s: t, e: t + 0.28 });
  const last = out[out.length - 1];
  if (last) last.w = 'done.';
  return out;
}

/* ------------------------------------------------ dsp ------------------------------------------------------ */

describe('dsp frame features', () => {
  const frame = (x: Float32Array): Float32Array => x.subarray(0, FRAME_LEN);

  it('measures level in dBFS', () => {
    const f = analyzeFrame(frame(voiced(150, 0.2, -20)));
    expect(f.levelDb).toBeGreaterThan(-23);
    expect(f.levelDb).toBeLessThan(-17);
    expect(analyzeFrame(frame(silence(0.1))).levelDb).toBe(-140);
  });

  it('estimates F0 within 4 % for voiced signals and rejects noise / silence', () => {
    for (const f0 of [95, 150, 220, 330]) {
      const est = estimatePitch(frame(voiced(f0, 0.2)));
      expect(est).toBeGreaterThan(f0 * 0.96);
      expect(est).toBeLessThan(f0 * 1.04);
    }
    expect(estimatePitch(frame(noise(0.2, -20)))).toBe(0);
    expect(analyzeFrame(frame(silence(0.1))).f0).toBe(0);
  });

  it('brightness separates a low tone from white noise', () => {
    expect(analyzeFrame(frame(voiced(120, 0.2))).hf).toBeLessThan(0.2);
    expect(analyzeFrame(frame(noise(0.2, -20))).hf).toBeGreaterThan(1.5);
  });

  it('FrameAnalyzer gives identical frames for any chunking (odd byte counts included)', () => {
    const x = concat(voiced(150, 1), noise(0.5, -25), silence(0.5));
    const whole = analyze(x, 1 << 20);
    for (const chunk of [1, 3, 4097, 100001]) {
      const part = analyze(x, chunk);
      expect(part.count).toBe(whole.count);
      expect(Array.from(part.levelDb)).toEqual(Array.from(whole.levelDb));
      expect(Array.from(part.f0)).toEqual(Array.from(whole.f0));
    }
    expect(whole.count).toBe(Math.round(2 / FRAME_SEC));
  });
});

/* ------------------------------------------- parsers & series ----------------------------------------------- */

describe('parsers', () => {
  it('parses silencedetect log lines (recorded ffmpeg 7 output)', () => {
    const log = [
      '[silencedetect @ 0x7f2c8c003c80] silence_start: -0.00010002',
      '[silencedetect @ 0x7f2c8c003c80] silence_end: 1.52 | silence_duration: 1.52010',
      '[silencedetect @ 0x7f2c8c003c80] silence_start: 8.25',
      '[silencedetect @ 0x7f2c8c003c80] silence_end: 9.0125 | silence_duration: 0.7625',
      '[silencedetect @ 0x7f2c8c003c80] silence_start: 19.5',
    ];
    expect(parseSilenceLog(log, 20)).toEqual([
      { s: 0, e: 1.52 },
      { s: 8.25, e: 9.0125 },
      { s: 19.5, e: 20 }, // trailing silence with no end line is closed at the file end
    ]);
  });

  it('parses ametadata ebur128 output', () => {
    const lines = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.r128.M=-120.691',
      'frame:1    pts:1600    pts_time:0.1',
      'lavfi.r128.M=-33.1',
      'frame:2    pts:3200    pts_time:0.2',
      'lavfi.r128.M=-inf',
    ];
    const out = parseEbur128(lines);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ t: 0.2, lufs: -33.1 });
    expect(out[2]?.lufs).toBe(LOUDNESS_FLOOR_LUFS);
  });
});

describe('series', () => {
  it('hopCount covers the whole duration', () => {
    expect(hopCount(10)).toBe(20);
    expect(hopCount(10.1)).toBe(21);
    expect(hopCount(0)).toBe(1);
  });

  it('loudnessSeries power-averages samples per hop and carries values over holes', () => {
    const samples = [
      { t: 0.1, lufs: -20 },
      { t: 0.2, lufs: -20 },
      { t: 0.3, lufs: -20 },
      { t: 0.4, lufs: -20 },
      { t: 0.5, lufs: -20 },
      // hop 1 has no samples at all
      { t: 1.1, lufs: -30 },
      { t: 1.5, lufs: -50 },
    ];
    const l = loudnessSeries(samples, 1.5);
    expect(l).toHaveLength(3);
    expect(l[0]).toBeCloseTo(-20, 1);
    expect(l[1]).toBeCloseTo(-20, 1); // carried
    // hop 2: power mean of -30 and -50 LUFS
    expect(l[2]).toBeCloseTo(10 * Math.log10((1e-3 + 1e-5) / 2), 1);
    expect(loudnessSeries([{ t: 0.1, lufs: -300 }], 0.5)[0]).toBe(LOUDNESS_FLOOR_LUFS);
  });

  it('speechRateSeries counts words/s in a sliding window aligned to the hops', () => {
    const ws = wordsOver(0, 10, 4); // 4 words/s
    const r = speechRateSeries(ws, 10);
    expect(r).toHaveLength(20);
    expect(r[10]).toBeGreaterThan(3.2);
    expect(r[10]).toBeLessThan(4.8);
    const gapped = speechRateSeries(
      [...wordsOver(0, 3, 4), ...wordsOver(7, 10, 4)].map((w) => ({ ...w })),
      10,
    );
    expect(gapped[10]).toBe(0); // 5.25 s: nothing within +-1.5 s
    expect(gapped[2]).toBeGreaterThan(3);
  });

  it('adaptiveSilenceDb follows the noise floor and is clamped', () => {
    const quiet = Float32Array.from({ length: 200 }, (_, i) => (i < 40 ? -65 : -20));
    const noisy = Float32Array.from({ length: 200 }, (_, i) => (i < 40 ? -42 : -20));
    expect(adaptiveSilenceDb(quiet)).toBeLessThan(adaptiveSilenceDb(noisy));
    expect(adaptiveSilenceDb(quiet)).toBeGreaterThanOrEqual(-58);
    expect(adaptiveSilenceDb(noisy)).toBeLessThanOrEqual(-32);
    expect(adaptiveSilenceDb(new Float32Array(5))).toBe(-45);
  });
});

/* ------------------------------------------------ laughter ------------------------------------------------- */

describe('detectLaughter', () => {
  it('finds a loud broadband no-word burst, not the speech around it', () => {
    const x = concat(voiced(150, 6), noise(2.5, -22), voiced(150, 6));
    const fr = analyze(x);
    const words = [...wordsOver(0, 6), ...wordsOver(8.5, 14.5)];
    const hits = detectLaughter(fr, words);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.s).toBeGreaterThan(5.8);
    expect(hits[0]!.s).toBeLessThan(6.5);
    expect(hits[0]!.e).toBeGreaterThan(8.0);
    expect(hits[0]!.e).toBeLessThan(8.7);
    expect(hits[0]!.score).toBeGreaterThan(0.6);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
  });

  it('ignores steady tonal non-speech (music / hum) and quiet noise', () => {
    const steady = voiced(200, 3, -22).map(
      (v, i) => v / (0.75 + 0.25 * Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE)),
    ); // remove tremolo
    const x = concat(voiced(150, 5), steady, voiced(150, 5), noise(3, -50), voiced(150, 2));
    const words = [...wordsOver(0, 5), ...wordsOver(8, 13), ...wordsOver(16, 18)];
    expect(detectLaughter(analyze(x), words)).toEqual([]);
  });

  it('does not report a clean single voice that the ASR missed (strong pitch in most frames)', () => {
    const x = concat(voiced(150, 5), voiced(130, 2, -22), voiced(150, 5));
    const words = [...wordsOver(0, 5), ...wordsOver(7, 12)];
    expect(detectLaughter(analyze(x), words)).toEqual([]);
  });

  it('treats laughter tokens ("haha", "[laughter]") as non-speech', () => {
    const x = concat(voiced(150, 4), noise(2, -22), voiced(150, 4));
    const words: Word[] = [
      ...wordsOver(0, 4),
      { w: 'Haha', s: 4.1, e: 5.9 },
      { w: '[Laughter]', s: 5.9, e: 6 },
      ...wordsOver(6, 10),
    ];
    expect(detectLaughter(analyze(x), words)).toHaveLength(1);
  });

  it('with no words at all it still copes (reference falls back to overall loudness)', () => {
    const x = concat(voiced(150, 5), noise(2, -18), voiced(150, 5));
    const hits = detectLaughter(analyze(x), []);
    expect(hits.length).toBeLessThanOrEqual(1);
    expect(detectLaughter(analyze(new Float32Array(0)), [])).toEqual([]);
  });
});

/* -------------------------------------------- speaker changes ------------------------------------------------ */

describe('detectSpeakerChanges', () => {
  it('flags a turn change where F0 jumps after a sentence end + pause', () => {
    const x = concat(voiced(115, 5), silence(1), voiced(205, 5));
    const words = [...wordsOver(0, 5), ...wordsOver(6, 11)];
    const ch = detectSpeakerChanges(analyze(x), words, []);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toBeGreaterThan(4.9);
    expect(ch[0]).toBeLessThan(6.2);
  });

  it('does not flag the same voice after a pause', () => {
    const x = concat(voiced(130, 5), silence(1), voiced(135, 5));
    const words = [...wordsOver(0, 5), ...wordsOver(6, 11)];
    expect(detectSpeakerChanges(analyze(x), words, [])).toEqual([]);
  });

  it('does not flag a 15 % pitch move (same speaker, question intonation)', () => {
    const x = concat(voiced(130, 5), silence(1), voiced(150, 5));
    const words = [...wordsOver(0, 5), ...wordsOver(6, 11)];
    expect(detectSpeakerChanges(analyze(x), words, [])).toEqual([]);
  });

  it('needs a sentence end (or a long pause) before the change', () => {
    const x = concat(voiced(115, 5), silence(0.8), voiced(205, 5));
    const first = wordsOver(0, 5);
    first[first.length - 1]!.w = 'and'; // no full stop
    const words = [...first, ...wordsOver(5.8, 10.8)];
    expect(detectSpeakerChanges(analyze(x), words, [])).toEqual([]);
    // ... but a 1.4 s pause is enough on its own
    const x2 = concat(voiced(115, 5), silence(1.4), voiced(205, 5));
    const words2 = [...first, ...wordsOver(6.4, 11.4)];
    expect(detectSpeakerChanges(analyze(x2), words2, [])).toHaveLength(1);
  });

  it('skips pauses with too little voiced evidence on a side', () => {
    const x = concat(noise(5, -30), silence(1), voiced(205, 5));
    const words = [...wordsOver(0, 5), ...wordsOver(6, 11)];
    expect(detectSpeakerChanges(analyze(x), words, [])).toEqual([]);
  });
});

/* ------------------------------------------- deriveSignals / schema ------------------------------------------- */

describe('deriveSignals', () => {
  it('produces a schema-valid AudioSignals with aligned per-hop arrays', () => {
    const x = concat(voiced(115, 5), silence(1), voiced(205, 5), noise(2.5, -22), voiced(115, 3));
    const words = [...wordsOver(0, 5), ...wordsOver(6, 11), ...wordsOver(13.5, 16.5)];
    const duration = 16.5;
    const s = deriveSignals({
      frames: analyze(x),
      words,
      durationSec: duration,
      silences: [{ s: 5.02, e: 5.98 }],
      loudness: [{ t: 0.1, lufs: -23 }],
    });
    expect(() => audioSignalsSchema.parse(s)).not.toThrow();
    expect(s.hopSec).toBe(HOP_SEC);
    expect(s.loudness).toHaveLength(hopCount(duration));
    expect(s.speechRate).toHaveLength(hopCount(duration));
    expect(s.sceneCuts).toEqual([]);
    expect(s.laughter.length).toBe(1);
    expect(s.speakerChanges.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------- end-to-end with real ffmpeg ----------------------------------------- */

describe('computeSignals (real ffmpeg on synthetic WAV)', () => {
  let dir = '';
  let wav = '';
  const words: Word[] = [...wordsOver(0, 4), ...wordsOver(6, 10), ...wordsOver(14, 18)];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-signals-'));
    // 0-4 s voiced 120 Hz | 4-6 s digital silence | 6-10 s voiced 210 Hz | 10-12.5 s loud white noise
    // (no words) | 12.5-14 s quiet room noise -62 dB | 14-18 s voiced 120 Hz | 18-20 s silence
    const x = concat(
      voiced(120, 4),
      silence(2),
      voiced(210, 4),
      noise(2.5, -22),
      noise(1.5, -62, 9),
      voiced(120, 4),
      silence(2),
    );
    wav = path.join(dir, 'synth.wav');
    writeWav(wav, x);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('locates silences, loudness, speech rate, the noise burst and the turn change', async () => {
    const progress: number[] = [];
    const sig = await computeSignals({
      wavPath: wav,
      words,
      durationSec: 20,
      ffmpegPath: FFMPEG,
      onProgress: (f) => {
        if (f !== null) progress.push(f);
      },
    });
    audioSignalsSchema.parse(sig);
    expect(sig.durationSec).toBe(20);
    expect(sig.loudness).toHaveLength(40);
    expect(sig.speechRate).toHaveLength(40);

    // silences: [4,6], [12.5,14] (-62 dB room noise is below the adaptive threshold) and [18,20]
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.25;
    const has = (s: number, e: number): boolean =>
      sig.silences.some((x) => near(x.s, s) && near(x.e, e));
    expect(has(4, 6)).toBe(true);
    expect(has(12.5, 14)).toBe(true);
    expect(has(18, 20)).toBe(true);
    expect(sig.silences.some((x) => x.s > 0.5 && x.e < 3.5)).toBe(false); // none inside speech

    // loudness: speech ~ -22 dBFS RMS => around -20 LUFS; silence floor; noise burst
    const L = (t: number): number => sig.loudness[Math.floor(t / HOP_SEC)] ?? NaN;
    expect(L(2)).toBeGreaterThan(-30);
    expect(L(2)).toBeLessThan(-14);
    expect(L(5)).toBeLessThan(-60);
    expect(L(11)).toBeGreaterThan(-30);
    expect(L(5)).toBeLessThan(L(2) - 30);

    // speech rate: ~3 words/s in speech, 0 in the long silences
    const R = (t: number): number => sig.speechRate[Math.floor(t / HOP_SEC)] ?? NaN;
    expect(R(2)).toBeGreaterThan(2.3);
    expect(R(2)).toBeLessThan(3.8);
    expect(R(5)).toBeLessThan(1); // window +-1.5 s still touches the words either side of the pause
    expect(R(19.5)).toBeLessThan(1);

    // laughter heuristic: the white-noise burst [10, 12.5) and nothing else
    expect(sig.laughter).toHaveLength(1);
    expect(sig.laughter[0]!.s).toBeGreaterThan(9.7);
    expect(sig.laughter[0]!.s).toBeLessThan(10.6);
    expect(sig.laughter[0]!.e).toBeGreaterThan(12.0);
    expect(sig.laughter[0]!.e).toBeLessThan(12.8);
    expect(sig.laughter[0]!.score).toBeGreaterThan(0.6);

    // speaker changes: 120 -> 210 Hz at the 4-6 s pause, 210 -> 120 Hz across the noise (10-14 s)
    expect(sig.speakerChanges.length).toBe(2);
    expect(sig.speakerChanges[0]).toBeGreaterThan(4);
    expect(sig.speakerChanges[0]).toBeLessThan(6);
    expect(sig.speakerChanges[1]).toBeGreaterThan(10);
    expect(sig.speakerChanges[1]).toBeLessThan(14);

    expect(sig.sceneCuts).toEqual([]);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= (progress[i - 1] ?? 0) - 1e-9)).toBe(true);
  });

  it('is a pure function of its inputs (two runs are identical)', async () => {
    const args = { wavPath: wav, words, durationSec: 20, ffmpegPath: FFMPEG };
    const a = await computeSignals(args);
    const b = await createAnalysisService().computeSignals(args);
    expect(b).toEqual(a);
  });

  it('copes with no words and with a duration of 0 (derived from the audio)', async () => {
    const sig = await computeSignals({
      wavPath: wav,
      words: [],
      durationSec: 0,
      ffmpegPath: FFMPEG,
    });
    expect(sig.durationSec).toBeGreaterThan(19.9);
    expect(sig.speechRate.every((v) => v === 0)).toBe(true);
    expect(sig.speakerChanges).toEqual([]);
  });

  it('rejects with a readable error for a missing file', async () => {
    await expect(
      computeSignals({
        wavPath: path.join(dir, 'nope.wav'),
        words: [],
        durationSec: 5,
        ffmpegPath: FFMPEG,
      }),
    ).rejects.toThrow(/ffmpeg failed decoding/);
  });

  it('honours AbortSignal (pre-aborted and mid-run)', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(
      computeSignals({
        wavPath: wav,
        words,
        durationSec: 20,
        ffmpegPath: FFMPEG,
        signal: pre.signal,
      }),
    ).rejects.toSatisfy(isAbortError);

    // a 30-minute file takes a few seconds; abort shortly after start
    const long = path.join(dir, 'long.wav');
    writeWav(long, noise(60, -30), 1800);
    const ac = new AbortController();
    const p = computeSignals({
      wavPath: long,
      words: [],
      durationSec: 1800,
      ffmpegPath: FFMPEG,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toSatisfy(isAbortError);
  });
});

/** Writes a mono 16 kHz WAV; `repeat` loops the buffer (cheap long files). */
function writeWav(file: string, x: Float32Array, repeatToSec?: number): void {
  const pcm = toPcm(x);
  const total = repeatToSec ? Math.round(repeatToSec * SAMPLE_RATE) * 2 : pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + total, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(total, 40);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    let written = 0;
    while (written < total) {
      const n = Math.min(pcm.length, total - written);
      fs.writeSync(fd, pcm, 0, n);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}
