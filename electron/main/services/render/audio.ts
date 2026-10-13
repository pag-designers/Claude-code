/** Loudness measurement (loudnorm pass 1) and the linear normalisation filter (pass 2). */
import { lastLines, RenderError, runFfmpeg } from './ffmpeg';

export const TRUE_PEAK_LIMIT = -1.5;

export interface LoudnormMeasure {
  inputI: number;
  inputTP: number;
  inputLRA: number;
  inputThresh: number;
  targetOffset: number;
}

/** Extracts the JSON block `loudnorm` prints at the end of its stderr. */
export function parseLoudnormJson(stderr: string): LoudnormMeasure | null {
  const end = stderr.lastIndexOf('}');
  const start = end >= 0 ? stderr.lastIndexOf('{', end) : -1;
  if (start < 0 || end < 0) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (k: string): number => {
    const v = obj[k];
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return n;
  };
  const m: LoudnormMeasure = {
    inputI: num('input_i'),
    inputTP: num('input_tp'),
    inputLRA: num('input_lra'),
    inputThresh: num('input_thresh'),
    targetOffset: num('target_offset'),
  };
  // "-inf" (silent audio) parses to -Infinity/NaN: not usable
  return [m.inputI, m.inputTP, m.inputLRA, m.inputThresh, m.targetOffset].every(Number.isFinite)
    ? m
    : null;
}

/**
 * Measures the loudness of the clip's audio window. Returns null when the audio is silent / cannot be
 * measured (the caller then skips normalisation instead of amplifying noise).
 */
export async function measureLoudness(
  ffmpegPath: string,
  sourcePath: string,
  startSec: number,
  durSec: number,
  targetLufs: number,
  signal?: AbortSignal,
): Promise<LoudnormMeasure | null> {
  const r = await runFfmpeg(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      '-ss',
      startSec.toFixed(3),
      '-t',
      durSec.toFixed(3),
      '-i',
      sourcePath,
      '-vn',
      '-sn',
      '-af',
      `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK_LIMIT}:LRA=11:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    { signal, timeoutMs: 300_000 },
  );
  if (r.code !== 0) {
    throw new RenderError('Loudness measurement failed', lastLines(r.stderr));
  }
  return parseLoudnormJson(r.stderr);
}

/**
 * Audio filter chain: linear loudnorm using the measured values (true peak <= -1.5 dBTP), back to
 * 48 kHz (loudnorm works at 192 kHz), 10 ms/30 ms edge fades so a cut never clicks.
 */
export function buildAudioFilter(
  m: LoudnormMeasure | null,
  targetLufs: number,
  durSec: number,
): string {
  const parts: string[] = [];
  if (m) {
    // linear mode only engages when the clip's own LRA fits the target LRA
    const lra = Math.min(50, Math.max(11, Math.ceil(m.inputLRA + 1)));
    parts.push(
      `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK_LIMIT}:LRA=${lra}` +
        `:measured_I=${m.inputI}:measured_TP=${m.inputTP}:measured_LRA=${m.inputLRA}` +
        `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=none`,
    );
  }
  parts.push('aresample=48000');
  parts.push('afade=t=in:st=0:d=0.01');
  const fadeOut = Math.min(0.03, durSec / 4);
  parts.push(`afade=t=out:st=${Math.max(0, durSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return parts.join(',');
}
