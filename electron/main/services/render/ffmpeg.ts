/** Thin ffmpeg process helpers: run with progress/abort/stderr tail, probe streams from `ffmpeg -i`. */
import { spawn } from 'node:child_process';

export class RenderError extends Error {
  constructor(
    message: string,
    /** Last lines of ffmpeg's stderr (empty when ffmpeg never started). */
    readonly stderrTail: string = '',
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export class RenderAbortError extends Error {
  constructor(message = 'Render canceled') {
    super(message);
    this.name = 'AbortError';
  }
}

const TAIL_LINES = 14;

const lastLines = (text: string, n = TAIL_LINES): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join('\n');

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with the output time (seconds) reported by `-progress pipe:1`. */
  onOutTime?: (sec: number) => void;
  /** Kill the process after this long. */
  timeoutMs?: number;
  /** Collect stdout into a Buffer (for raw frames). */
  captureStdout?: boolean;
  cwd?: string;
}

export interface RunResult {
  code: number;
  stderr: string;
  stdout: Buffer;
}

/**
 * Runs ffmpeg to completion. Resolves with the result for ANY exit code (callers decide); rejects only
 * on spawn failure or abort.
 */
export function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new RenderAbortError());
      return;
    }
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: opts.cwd,
    });
    let stderr = '';
    const outChunks: Buffer[] = [];
    let progressBuf = '';
    let aborted = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2500);
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = opts.timeoutMs
      ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs)
      : undefined;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.stdout.on('data', (c: Buffer) => {
      if (opts.captureStdout) {
        outChunks.push(c);
        return;
      }
      if (!opts.onOutTime) return;
      progressBuf += c.toString('utf8');
      let nl: number;
      while ((nl = progressBuf.indexOf('\n')) >= 0) {
        const line = progressBuf.slice(0, nl).trim();
        progressBuf = progressBuf.slice(nl + 1);
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        // Both out_time_us and (misnamed) out_time_ms are microseconds.
        if (m?.[1]) opts.onOutTime(Number(m[1]) / 1e6);
      }
    });
    child.once('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      reject(new RenderError(`Could not start ffmpeg (${ffmpegPath}): ${err.message}`));
    });
    child.once('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (aborted) {
        reject(new RenderAbortError());
        return;
      }
      if (timedOut) {
        reject(new RenderError('ffmpeg timed out', lastLines(stderr)));
        return;
      }
      resolve({ code: code ?? -1, stderr, stdout: Buffer.concat(outChunks) });
    });
  });
}

export { lastLines };

/* ------------------------------------------------- probing ----------------------------------------- */

export interface StreamInfo {
  durationSec: number | null;
  /** Container start time (seconds). */
  startTime: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  /** Average fps as printed by ffmpeg (`N fps`). */
  fps: number | null;
  /** Guessed real frame rate (`N tbr`). A value different from `fps` suggests variable frame rate. */
  tbr: number | null;
}

/** Parses the banner of `ffmpeg -i file` (ffprobe may not be available next to the ffmpeg binary). */
export function parseStreamInfo(banner: string): StreamInfo {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?),\s*start:\s*(-?\d+(?:\.\d+)?)/.exec(banner);
  const videoLine = /Stream #\d+:\d+[^\n]*Video:[^\n]*/.exec(banner)?.[0] ?? '';
  const size = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,[])/.exec(videoLine);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(videoLine);
  const tbr = /(\d+(?:\.\d+)?)(k?)\s*tbr/.exec(videoLine);
  return {
    durationSec: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    startTime: dur?.[4] ? Number(dur[4]) : 0,
    hasVideo: videoLine !== '',
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(banner),
    width: size?.[1] ? Number(size[1]) : null,
    height: size?.[2] ? Number(size[2]) : null,
    fps: fps?.[1] ? Number(fps[1]) : null,
    tbr: tbr?.[1] ? Number(tbr[1]) * (tbr[2] === 'k' ? 1000 : 1) : null,
  };
}

export async function probeStreams(
  ffmpegPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<StreamInfo> {
  const r = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], {
    signal,
    timeoutMs: 30_000,
  });
  // `ffmpeg -i file` without an output exits with 1 after printing the banner.
  const info = parseStreamInfo(r.stderr);
  if (!info.hasVideo && !info.hasAudio) {
    throw new RenderError(`ffmpeg could not read ${file}`, lastLines(r.stderr));
  }
  return info;
}
