/**
 * Small ffmpeg / ffprobe helpers shared by the brand-media modules: probing, a progress-aware ffmpeg runner that can
 * keep ffmpeg's info-level output (loudnorm prints its measurement there), loudness measurement, image thumbnails.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MediaInfo } from '../../pipeline/contracts';
import { FfmpegProgressParser, describeProgress, mediaInfoFromProbe } from '../media/ffmpeg';
import { LineBuffer, runProcess } from '../media/proc';

export { AbortError } from '../media/proc';

/** A user-readable failure (the message is shown to the person who uploaded the file). */
export class BrandMediaError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'BrandMediaError';
  }
}

export interface FfCtx {
  ffmpegPath: string;
  ffprobePath: string;
  log: (m: string) => void;
}

export type Fraction = (fraction: number | null) => void;

export const baseName = (file: string): string => path.basename(file);

/** "Clipfern could not read 'x.png'. Is it a valid PNG?" */
export const unreadable = (file: string, what: string): BrandMediaError =>
  new BrandMediaError(`Clipfern could not read '${baseName(file)}'. Is it a valid ${what}?`);

const lastLine = (text: string): string => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
};

export interface ProbeResult {
  info: MediaInfo;
  /** ffprobe's raw JSON (streams + format). */
  raw: unknown;
}

/** ffprobe a file. Returns null when ffprobe cannot parse it at all. */
export async function probeFile(
  ctx: FfCtx,
  file: string,
  signal?: AbortSignal,
): Promise<ProbeResult | null> {
  const chunks: string[] = [];
  const res = await runProcess(
    ctx.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
    { signal, onStdout: (c) => chunks.push(c.toString('utf8')) },
  );
  if (res.code !== 0) {
    ctx.log(`[brand-media] ffprobe failed for ${baseName(file)}: ${lastLine(res.stderrTail)}`);
    return null;
  }
  try {
    const raw = JSON.parse(chunks.join('')) as unknown;
    return { info: mediaInfoFromProbe(raw), raw };
  } catch {
    return null;
  }
}

export interface RunFfOpts {
  signal?: AbortSignal;
  /** Length of the output in seconds, enables a real 0..1 fraction. */
  durationSec?: number | null;
  onFraction?: Fraction;
  /** ffmpeg `-v` level. Default `error`; `info` keeps filter output such as loudnorm's JSON. */
  verbosity?: 'error' | 'info' | 'verbose';
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs ffmpeg and resolves with the stderr tail on exit 0. Failure throws a BrandMediaError whose message ends with
 * ffmpeg's last line (callers wrap it into a friendlier message when they can).
 */
export async function runFf(
  ctx: FfCtx,
  args: readonly string[],
  opts: RunFfOpts = {},
): Promise<{ stderr: string }> {
  const parser = new FfmpegProgressParser();
  const lines = new LineBuffer((line) => {
    const snap = parser.push(line);
    if (snap && opts.onFraction)
      opts.onFraction(describeProgress(snap, opts.durationSec ?? null).fraction);
  });
  const full = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-v',
    opts.verbosity ?? 'error',
    '-progress',
    'pipe:1',
    '-y',
    ...args,
  ];
  const res = await runProcess(ctx.ffmpegPath, full, {
    signal: opts.signal,
    onStdout: (c) => lines.push(c),
    stderrTailBytes: 64 * 1024,
    env: opts.env,
  });
  lines.flush();
  if (res.code !== 0) {
    throw new BrandMediaError(
      `ffmpeg failed: ${lastLine(res.stderrTail).slice(0, 240)}`,
      res.stderrTail.slice(-1500),
    );
  }
  return { stderr: res.stderrTail };
}

/** Removes a partial output, ignoring errors. */
export async function rmQuiet(...files: string[]): Promise<void> {
  await Promise.all(
    files.map((f) => fs.promises.rm(f, { force: true, recursive: true }).catch(() => undefined)),
  );
}

/** Runs `work(tmp)` and renames `tmp` to `out`; the partial file never survives a failure. */
export async function atomicOut(out: string, work: (tmp: string) => Promise<void>): Promise<void> {
  const ext = path.extname(out);
  const tmp = `${out.slice(0, out.length - ext.length)}.partial${ext}`;
  try {
    await work(tmp);
    const st = await fs.promises.stat(tmp).catch(() => null);
    if (!st || st.size === 0) throw new BrandMediaError('ffmpeg finished but produced no output.');
    await fs.promises.rename(tmp, out);
  } catch (e) {
    await rmQuiet(tmp);
    throw e;
  }
}

/* ------------------------------------------------------------------------------------ loudness ---- */

export interface Loudness {
  /** Integrated loudness, LUFS. */
  inputI: number;
  /** True peak, dBTP. */
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Pulls loudnorm's `print_format=json` block out of ffmpeg's stderr. null when absent or the audio is silent. */
export function parseLoudnorm(stderr: string): Loudness | null {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const inputI = num(j.input_i);
    const inputTp = num(j.input_tp);
    // "-inf" (digital silence) parses to -Infinity which Number() accepts but isFinite rejects: both end up null
    if (inputI === null || inputTp === null || inputI <= -70) return null;
    return {
      inputI,
      inputTp,
      inputLra: num(j.input_lra) ?? 0,
      inputThresh: num(j.input_thresh) ?? inputI - 10,
      targetOffset: num(j.target_offset) ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Measures integrated loudness + true peak of the first audio stream with loudnorm's analysis pass.
 * null = silent / too short to measure.
 */
export async function measureLoudness(
  ctx: FfCtx,
  file: string,
  opts: { durationSec?: number | null; signal?: AbortSignal; onFraction?: Fraction } = {},
): Promise<Loudness | null> {
  const { stderr } = await runFf(
    ctx,
    [
      '-i',
      file,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ],
    {
      verbosity: 'info',
      signal: opts.signal,
      durationSec: opts.durationSec,
      onFraction: opts.onFraction,
    },
  );
  return parseLoudnorm(stderr);
}

/* ------------------------------------------------------------------------------------ thumbnails -- */

export const THUMB_MAX = 480;

/** Neutral two-tone checker so transparent logos stay legible in a JPEG. */
const CHECKER_FILTER = "format=gray,geq=lum='if(lt(mod(floor(X/16)+floor(Y/16),2),1),96,120)'";

/**
 * Writes a JPEG no larger than THUMB_MAX on the long side (never upscaled). `onChecker` composites alpha over a neutral
 * checker ground first. `seekSec` grabs a frame from a video.
 */
export async function makeThumbJpeg(
  ctx: FfCtx,
  a: { input: string; out: string; seekSec?: number; onChecker?: boolean; signal?: AbortSignal },
): Promise<void> {
  const scale = `scale='min(${THUMB_MAX},iw)':'min(${THUMB_MAX},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
  const vf = a.onChecker
    ? `format=rgba,${scale},split[fg][bg];[bg]${CHECKER_FILTER}[ground];[ground][fg]overlay=format=auto,format=yuvj420p`
    : `${scale},format=yuvj420p`;
  const args = [
    ...(a.seekSec && a.seekSec > 0 ? ['-ss', a.seekSec.toFixed(3)] : []),
    '-i',
    a.input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    vf,
    '-q:v',
    '3',
    '-f',
    'image2',
    '-update',
    '1',
  ];
  await atomicOut(a.out, (tmp) =>
    runFf(ctx, [...args, tmp], { signal: a.signal }).then(() => undefined),
  );
}
