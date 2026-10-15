/** Probing + decode checks for the finisher's inputs (ffmpeg only: ffprobe is not guaranteed to ship next to it). */
import { stat } from 'node:fs/promises';
import {
  lastLines,
  parseStreamInfo,
  RenderError,
  runFfmpeg,
  type StreamInfo,
} from '../render/ffmpeg';

export interface MediaProbe extends StreamInfo {
  audioCodec: string | null;
  videoCodec: string | null;
}

/** Reads the header of `file`. Throws a plain `Error` with ffmpeg's reason when it is missing / not media. */
export async function probeMedia(
  ffmpegPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  const st = await stat(file).catch(() => null);
  if (!st) throw new Error(`file not found: ${file}`);
  if (st.size === 0) throw new Error('file is empty');
  const r = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], {
    signal,
    timeoutMs: 30_000,
  });
  const info = parseStreamInfo(r.stderr);
  if (!info.hasVideo && !info.hasAudio) {
    const why = lastLines(r.stderr, 2).split('\n').pop() ?? 'unreadable';
    throw new Error(`not a readable media file (${why.replace(/^.*?:\s*/, '')})`);
  }
  return {
    ...info,
    audioCodec: /Stream #\d+:\d+[^\n]*Audio:\s*([a-z0-9_]+)/.exec(r.stderr)?.[1] ?? null,
    videoCodec: /Stream #\d+:\d+[^\n]*Video:\s*([a-z0-9_]+)/.exec(r.stderr)?.[1] ?? null,
  };
}

/**
 * Decodes (up to `seconds` of) the file and returns ffmpeg's first error line, or null when it decodes cleanly.
 * Catches files whose header is fine but whose data is damaged.
 */
export async function decodeCheck(
  ffmpegPath: string,
  file: string,
  opts: { seconds: number; video: boolean; audio: boolean; signal?: AbortSignal },
): Promise<string | null> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-xerror',
    '-t',
    String(opts.seconds),
    '-i',
    file,
  ];
  if (!opts.video) args.push('-vn');
  if (!opts.audio) args.push('-an');
  args.push('-f', 'null', '-');
  try {
    const r = await runFfmpeg(ffmpegPath, args, { signal: opts.signal, timeoutMs: 120_000 });
    if (r.code === 0) return null;
    return lastLines(r.stderr, 1) || `ffmpeg exited with ${r.code}`;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return err instanceof RenderError ? err.message : String(err);
  }
}
