import fs from 'node:fs';
import path from 'node:path';
import type { MediaInfo, MediaService, OnProgress } from '../../pipeline/contracts';
import { AbortError, LineBuffer, runProcess } from './proc';

/**
 * ffmpeg / ffprobe wrapper (BRIEF §4.2). `runFfmpeg` is exported for other modules: it adds the flags
 * every long job needs (`-nostdin -progress pipe:1`), turns ffmpeg's key=value progress into a 0..1
 * fraction with speed/ETA, honours AbortSignal (kills the process group) and converts failures into
 * readable errors. Outputs are written to `<out>.partial.<ext>` and renamed on success, so a canceled
 * or failed job never leaves a half-written file under the final name.
 */

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface MediaDeps {
  ffmpegPath: () => string;
  ffprobePath: () => string;
  log: (m: string) => void;
}

/* ---------------------------------------------- pure helpers ---------------------------------------------- */

export interface FfmpegProgress {
  /** Encoded media time in seconds, null until ffmpeg reports one. */
  outTimeSec: number | null;
  /** Realtime multiple ("2.5x" -> 2.5). */
  speed: number | null;
  /** Set when ffmpeg printed `progress=end`. */
  ended: boolean;
}

/** Accumulates `key=value` lines of `-progress` output; `push` returns a snapshot at every `progress=` line. */
export class FfmpegProgressParser {
  private outTime: number | null = null;
  private speed: number | null = null;

  push(line: string): FfmpegProgress | null {
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    switch (key) {
      case 'out_time_us':
      case 'out_time_ms': {
        // Both are microseconds in practice (out_time_ms is a long-standing misnomer).
        const n = Number(val);
        if (Number.isFinite(n) && n >= 0) this.outTime = n / 1_000_000;
        break;
      }
      case 'out_time': {
        const m = /^(-?)(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(val);
        if (m && this.outTime === null) {
          this.outTime = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
        }
        break;
      }
      case 'speed': {
        const n = Number.parseFloat(val.replace('x', ''));
        this.speed = Number.isFinite(n) && n > 0 ? n : null;
        break;
      }
      case 'progress':
        return {
          outTimeSec: this.outTime,
          speed: this.speed,
          ended: val === 'end',
        };
      default:
        break;
    }
    return null;
  }
}

export function formatEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** progress snapshot + known output duration -> (fraction, "12.3x · 00:41 left"). */
export function describeProgress(
  p: FfmpegProgress,
  durationSec: number | null,
): { fraction: number | null; message: string } {
  if (p.ended) return { fraction: 1, message: 'Done' };
  const speedText = p.speed ? `${p.speed >= 10 ? p.speed.toFixed(0) : p.speed.toFixed(1)}x` : null;
  if (durationSec && durationSec > 0 && p.outTimeSec !== null) {
    const fraction = Math.min(0.999, Math.max(0, p.outTimeSec / durationSec));
    const left = p.speed ? (durationSec - p.outTimeSec) / p.speed : null;
    const parts = [speedText, left !== null ? `${formatEta(left)} left` : null].filter(Boolean);
    return { fraction, message: parts.join(' · ') || 'Working' };
  }
  return { fraction: null, message: speedText ?? 'Working' };
}

/** Turns ffmpeg's stderr into a short, human-readable reason. */
export function humanizeFfmpegError(stderr: string, action: string): string {
  const text = stderr.trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1]?.trim() ?? '';
  const has = (re: RegExp): boolean => re.test(text);
  if (has(/No such file or directory/i))
    return `${action}: the input file does not exist or was moved.`;
  if (has(/Permission denied/i)) return `${action}: permission denied writing or reading a file.`;
  if (has(/No space left on device/i)) return `${action}: the disk is full.`;
  if (has(/Invalid data found when processing input|moov atom not found/i)) {
    return `${action}: the file is corrupt or not a supported media file.`;
  }
  if (has(/does not contain any stream|Output file #0 does not contain any stream/i)) {
    return `${action}: the file has no usable audio or video stream.`;
  }
  if (has(/Stream map '.*' matches no streams|matches no streams/i)) {
    return `${action}: the file has no audio track.`;
  }
  if (has(/Unknown encoder|Encoder .* not found/i)) {
    return `${action}: this ffmpeg build lacks a required encoder (${last.slice(0, 100)}).`;
  }
  if (has(/Cannot allocate memory|Out of memory/i)) return `${action}: ran out of memory.`;
  return `${action} failed${last ? `: ${last.slice(0, 220)}` : ''}`;
}

/** "30000/1001" -> 29.97. */
export function parseFrameRate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const den = Number(m[2]);
  const fps = den > 0 ? Number(m[1]) / den : 0;
  return fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

/** ffprobe `-print_format json -show_format -show_streams` -> MediaInfo. */
export function mediaInfoFromProbe(json: unknown): MediaInfo {
  const j = (json ?? {}) as ProbeJson;
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const num = (v: string | undefined): number | null => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const durations = [num(j.format?.duration), ...streams.map((s) => num(s.duration))].filter(
    (d): d is number => d !== null && d > 0,
  );
  const durationSec = durations.length ? Math.max(...durations) : 0;

  let width = video?.width ?? null;
  let height = video?.height ?? null;
  const rot = video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const rotation = Math.abs(Number(rot ?? video?.tags?.rotate ?? 0)) % 180;
  if (rotation === 90 && width !== null && height !== null) [width, height] = [height, width];

  return {
    durationSec,
    width,
    height,
    fps: video
      ? (parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate))
      : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    sizeBytes: num(j.format?.size),
  };
}

/** Even output height for a proxy: min(target, source), rounded down to even, never upscaling. */
export function proxyHeight(srcHeight: number | null, target: number): number {
  const h = srcHeight && srcHeight > 0 ? Math.min(srcHeight, target) : target;
  return Math.max(2, Math.floor(h / 2) * 2);
}

/* ---------------------------------------------- runFfmpeg -------------------------------------------------- */

export interface RunFfmpegOpts {
  signal?: AbortSignal;
  /** Length of the OUTPUT in seconds; enables a real 0..1 fraction. */
  durationSec?: number | null;
  onProgress?: OnProgress;
  /** Shown in error messages, e.g. "Extracting audio". */
  action?: string;
  log?: (m: string) => void;
}

/**
 * Runs ffmpeg with progress. `args` must NOT contain global flags (-y/-nostdin/-progress) - they are
 * added here. Resolves on exit code 0; rejects with MediaError (readable message) or AbortError.
 */
export async function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  opts: RunFfmpegOpts = {},
): Promise<void> {
  const action = opts.action ?? 'ffmpeg';
  const parser = new FfmpegProgressParser();
  const lines = new LineBuffer((line) => {
    const snap = parser.push(line);
    if (snap && opts.onProgress) {
      const d = describeProgress(snap, opts.durationSec ?? null);
      opts.onProgress(d.fraction, d.message);
    }
  });
  const full = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-v',
    'error',
    '-progress',
    'pipe:1',
    '-y',
    ...args,
  ];
  opts.log?.(`[ffmpeg] ${action}`);
  const res = await runProcess(ffmpegPath, full, {
    signal: opts.signal,
    onStdout: (c) => lines.push(c),
  });
  lines.flush();
  if (res.code !== 0) {
    throw new MediaError(humanizeFfmpegError(res.stderrTail, action), res.stderrTail.slice(-1500));
  }
  opts.onProgress?.(1, 'Done');
}

/** Writes via `<out>.partial<ext>` then renames; removes the partial file on any failure. */
async function withAtomicOutput(
  out: string,
  work: (tmp: string) => Promise<void>,
  expectNonEmpty = true,
): Promise<void> {
  const ext = path.extname(out);
  const tmp = `${out.slice(0, out.length - ext.length)}.partial${ext}`;
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  try {
    await work(tmp);
    const st = await fs.promises.stat(tmp).catch(() => null);
    if (!st || (expectNonEmpty && st.size === 0)) {
      throw new MediaError('ffmpeg finished but produced no output file.');
    }
    await fs.promises.rename(tmp, out);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/* ---------------------------------------------- service ---------------------------------------------------- */

export function createMediaService(deps: MediaDeps): MediaService {
  async function probe(file: string): Promise<MediaInfo> {
    if (!fs.existsSync(file)) throw new MediaError(`File not found: ${file}`);
    const chunks: string[] = [];
    const res = await runProcess(
      deps.ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { onStdout: (c) => chunks.push(c.toString('utf8')) },
    );
    if (res.code !== 0) {
      throw new MediaError(
        humanizeFfmpegError(res.stderrTail, 'Reading media info'),
        res.stderrTail,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(chunks.join(''));
    } catch {
      throw new MediaError('Reading media info failed: ffprobe returned unreadable output.');
    }
    const info = mediaInfoFromProbe(json);
    if (!info.hasAudio && !info.hasVideo) {
      throw new MediaError('Reading media info failed: the file has no audio or video stream.');
    }
    return info;
  }

  async function extractAudio16k(
    src: string,
    out: string,
    opts: {
      startSec?: number;
      durSec?: number;
      signal?: AbortSignal;
      onProgress?: OnProgress;
    } = {},
  ): Promise<void> {
    const info = await probe(src);
    if (!info.hasAudio)
      throw new MediaError('Extracting audio failed: the file has no audio track.');
    const start = Math.max(0, opts.startSec ?? 0);
    const available = Math.max(0, info.durationSec - start);
    const dur = opts.durSec !== undefined ? Math.min(opts.durSec, available) : available;
    if (dur <= 0) throw new MediaError('Extracting audio failed: the requested window is empty.');
    await withAtomicOutput(out, (tmp) =>
      runFfmpeg(
        deps.ffmpegPath(),
        [
          ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
          '-i',
          src,
          ...(opts.durSec !== undefined ? ['-t', dur.toFixed(3)] : []),
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          tmp,
        ],
        {
          signal: opts.signal,
          durationSec: dur,
          onProgress: opts.onProgress,
          action: 'Extracting audio',
          log: deps.log,
        },
      ),
    );
  }

  async function makeProxy(
    src: string,
    out: string,
    opts: { height?: number; signal?: AbortSignal; onProgress?: OnProgress } = {},
  ): Promise<void> {
    const info = await probe(src);
    if (!info.hasVideo)
      throw new MediaError('Creating the preview failed: the file has no video stream.');
    const h = proxyHeight(info.height, opts.height ?? 480);
    // scale=-2:h keeps the aspect ratio with an even width; fps is preserved.
    const vf = `scale=-2:${h}:flags=bicubic,format=yuv420p`;
    await withAtomicOutput(out, (tmp) =>
      runFfmpeg(
        deps.ffmpegPath(),
        [
          '-i',
          src,
          '-map',
          '0:v:0',
          ...(info.hasAudio ? ['-map', '0:a:0'] : []),
          '-sn',
          '-dn',
          '-map_metadata',
          '-1',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          // A keyframe every 2 s keeps seeking in the proxy snappy.
          '-force_key_frames',
          'expr:gte(t,n_forced*2)',
          ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'] : []),
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          tmp,
        ],
        {
          signal: opts.signal,
          durationSec: info.durationSec,
          onProgress: opts.onProgress,
          action: 'Creating the 480p preview',
          log: deps.log,
        },
      ),
    );
  }

  async function extractFrame(
    src: string,
    t: number,
    out: string,
    opts: { maxWidth?: number } = {},
  ): Promise<void> {
    const maxW = Math.max(16, Math.round(opts.maxWidth ?? 1280));
    await withAtomicOutput(out, (tmp) =>
      runFfmpeg(
        deps.ffmpegPath(),
        [
          '-ss',
          Math.max(0, t).toFixed(3),
          '-i',
          src,
          '-an',
          '-frames:v',
          '1',
          // Never upscale; -2 keeps the height even.
          '-vf',
          `scale='min(${maxW},iw)':-2`,
          '-q:v',
          '3',
          '-f',
          'image2',
          '-update',
          '1',
          tmp,
        ],
        { action: 'Extracting a frame', log: deps.log },
      ),
    ).catch((e: unknown) => {
      if (e instanceof MediaError && /produced no output/.test(e.message)) {
        throw new MediaError(
          `Extracting a frame failed: there is no video frame at ${t.toFixed(2)} s.`,
        );
      }
      throw e;
    });
  }

  return { probe, extractAudio16k, makeProxy, extractFrame };
}

export { AbortError };
