/**
 * EditorMediaService (CP3): probe, waveform, beats, thumbnail strips, 480p previews and a generic ffmpeg runner
 * for the export compiler's argument lists. Pure Node (child processes), no Electron imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Waveform } from '@shared/editor';
import type { CommonOpts } from '../../pipeline/contracts';
import type { EditorMediaService } from '../../pipeline/contracts3';
import { unpackedPath } from '../binaries';
import {
  FfmpegProgressParser,
  MediaError,
  humanizeFfmpegError,
  mediaInfoFromProbe,
} from '../media/ffmpeg';
import { AbortError, LineBuffer, runProcess } from '../media/proc';
import { detectBeats } from './beats';

export { detectBeats, estimateTempo, onsetEnvelope } from './beats';

export interface EditorMediaDeps {
  ffmpegPath?: () => string;
  ffprobePath?: () => string;
  log?: (m: string) => void;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const LUT_EXT = new Set(['.cube', '.3dl', '.csp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aiff', '.wma']);

function defaultFfmpeg(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('ffmpeg-static') as string | null;
  if (!p) throw new MediaError('Bundled ffmpeg binary not found.');
  return unpackedPath(p);
}

function defaultFfprobe(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = (require('ffprobe-static') as { path: string }).path;
  return unpackedPath(p);
}

const lastLines = (text: string, n = 12): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n');

const even = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

export function createEditorMedia(deps: EditorMediaDeps = {}): EditorMediaService {
  const ffmpeg = (): string => deps.ffmpegPath?.() ?? defaultFfmpeg();
  const ffprobe = (): string => deps.ffprobePath?.() ?? defaultFfprobe();

  async function probeJson(file: string): Promise<unknown> {
    if (!fs.existsSync(file)) throw new MediaError(`File not found: ${file}`);
    const chunks: string[] = [];
    const res = await runProcess(
      ffprobe(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { onStdout: (c) => chunks.push(c.toString('utf8')) },
    );
    if (res.code !== 0) {
      throw new MediaError(humanizeFfmpegError(res.stderrTail, 'Reading media info'), res.stderrTail);
    }
    try {
      return JSON.parse(chunks.join('')) as unknown;
    } catch {
      throw new MediaError('Reading media info failed: ffprobe returned unreadable output.');
    }
  }

  async function durationOf(file: string): Promise<number | null> {
    try {
      const info = mediaInfoFromProbe(await probeJson(file));
      return info.durationSec > 0 ? info.durationSec : null;
    } catch {
      return null;
    }
  }

  /** Generic runner: ffmpeg with `-progress pipe:1`, 0..1 progress against `durationSec`, abortable. */
  async function runFfmpeg(
    a: { ffmpegPath: string; args: string[]; durationSec: number } & CommonOpts,
  ): Promise<void> {
    const args = [...a.args];
    if (!args.includes('-progress')) args.unshift('-progress', 'pipe:1');
    if (!args.includes('-nostats')) args.unshift('-nostats');
    if (!args.includes('-nostdin')) args.unshift('-nostdin');
    const parser = new FfmpegProgressParser();
    let lastFraction = -1;
    const lines = new LineBuffer((line) => {
      const snap = parser.push(line);
      if (snap && snap.outTimeSec !== null && a.durationSec > 0 && a.onProgress) {
        const f = Math.min(0.999, Math.max(0, snap.outTimeSec / a.durationSec));
        if (f - lastFraction >= 0.002) {
          lastFraction = f;
          a.onProgress(f, snap.speed ? `${snap.speed.toFixed(1)}x` : undefined);
        }
      }
    });
    a.onProgress?.(0, 'Starting');
    const res = await runProcess(a.ffmpegPath, args, { signal: a.signal, onStdout: (c) => lines.push(c) });
    lines.flush();
    if (res.code !== 0) {
      throw new MediaError(
        `ffmpeg failed (exit ${res.code ?? res.signal}):\n${lastLines(res.stderrTail)}`,
        res.stderrTail.slice(-1500),
      );
    }
    a.onProgress?.(1, 'Done');
  }

  return {
    async probe(file) {
      const ext = path.extname(file).toLowerCase();
      if (LUT_EXT.has(ext)) {
        if (!fs.existsSync(file)) throw new MediaError(`File not found: ${file}`);
        return { kind: 'lut', width: null, height: null, fps: null, durationSec: null, hasAudio: false };
      }
      const json = await probeJson(file);
      const info = mediaInfoFromProbe(json);
      const fmt = (json as { format?: { format_name?: string } }).format?.format_name ?? '';
      const streams = (json as { streams?: { codec_type?: string; nb_frames?: string; disposition?: { attached_pic?: number } }[] }).streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
      const isImageFormat = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|avif|heif|mov,mp4)/.test(fmt) && IMAGE_EXT.has(ext);
      const singleFrame = v?.nb_frames !== undefined && Number(v.nb_frames) === 1;
      if (v && (IMAGE_EXT.has(ext) || /image2|_pipe/.test(fmt) || (ext === '.gif' && singleFrame))) {
        void isImageFormat;
        return { kind: 'image', width: info.width, height: info.height, fps: null, durationSec: null, hasAudio: false };
      }
      if (info.hasVideo) {
        return {
          kind: 'video',
          width: info.width,
          height: info.height,
          fps: info.fps,
          durationSec: info.durationSec > 0 ? info.durationSec : null,
          hasAudio: info.hasAudio,
        };
      }
      if (info.hasAudio || AUDIO_EXT.has(ext)) {
        return {
          kind: 'audio',
          width: null,
          height: null,
          fps: null,
          durationSec: info.durationSec > 0 ? info.durationSec : null,
          hasAudio: true,
        };
      }
      throw new MediaError(`Unrecognised media file: ${path.basename(file)} has no video or audio stream.`);
    },

    async waveform(file, rate, opts): Promise<Waveform> {
      const SR = 8000;
      if (!(rate > 0) || rate > SR) throw new MediaError(`Waveform rate must be between 0 and ${SR} windows per second.`);
      const dur = await durationOf(file);
      const peaks: number[] = [];
      let sample = 0;
      let winMax = 0;
      let nextEdge = SR / rate;
      let carry: Buffer | null = null;
      const eat = (buf: Buffer): void => {
        let b = buf;
        if (carry) {
          b = Buffer.concat([carry, b]);
          carry = null;
        }
        const n = b.length >> 1;
        for (let i = 0; i < n; i++) {
          const v = Math.abs(b.readInt16LE(i * 2)) / 32768;
          if (v > winMax) winMax = v;
          sample++;
          if (sample >= nextEdge) {
            peaks.push(winMax);
            winMax = 0;
            nextEdge += SR / rate;
          }
        }
        if (b.length & 1) carry = b.subarray(b.length - 1);
      };
      let seen = 0;
      const res = await runProcess(
        ffmpeg(),
        ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'],
        {
          signal: opts?.signal,
          onStdout: (c) => {
            eat(c);
            seen += c.length;
            if (dur && opts?.onProgress) opts.onProgress(Math.min(0.99, seen / 2 / SR / dur));
          },
        },
      );
      if (res.code !== 0) {
        throw new MediaError(humanizeFfmpegError(res.stderrTail, 'Reading the waveform'), res.stderrTail);
      }
      if (sample > 0 && (peaks.length === 0 || sample > (peaks.length * SR) / rate)) peaks.push(winMax);
      opts?.onProgress?.(1);
      return { rate, durationSec: sample / SR, peaks };
    },

    async beats(file, opts) {
      const SR = 22050;
      const dur = await durationOf(file);
      const chunks: Buffer[] = [];
      let seen = 0;
      const res = await runProcess(
        ffmpeg(),
        ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
        {
          signal: opts?.signal,
          onStdout: (c) => {
            chunks.push(c);
            seen += c.length;
            if (dur && opts?.onProgress) opts.onProgress(Math.min(0.7, (seen / 4 / SR / dur) * 0.7));
          },
        },
      );
      if (res.code !== 0) {
        throw new MediaError(humanizeFfmpegError(res.stderrTail, 'Detecting beats'), res.stderrTail);
      }
      const all = Buffer.concat(chunks);
      const pcm = new Float32Array(all.buffer.slice(all.byteOffset, all.byteOffset + (all.length - (all.length % 4))));
      if (opts?.signal?.aborted) throw new AbortError();
      const beats = detectBeats(pcm, SR);
      opts?.onProgress?.(1);
      return beats;
    },

    async thumbStrip(a) {
      const dur = Math.max(0.04, a.endSec - a.startSec);
      const info = mediaInfoFromProbe(await probeJson(a.file));
      const w = info.width ?? 16;
      const h = info.height ?? 9;
      const tileH = even(a.height);
      const tileW = even((tileH * w) / h);
      const count = Math.max(1, Math.floor(a.count));
      const cols = Math.min(count, 10);
      const rows = Math.ceil(count / cols);
      const times = Array.from({ length: count }, (_v, i) => a.startSec + (i * dur) / count);
      await fs.promises.mkdir(path.dirname(a.outJpg), { recursive: true });
      await runFfmpeg({
        ffmpegPath: ffmpeg(),
        durationSec: 0,
        signal: a.signal,
        onProgress: a.onProgress,
        args: [
          '-hide_banner', '-v', 'error', '-y',
          '-ss', a.startSec.toFixed(3), '-t', dur.toFixed(3), '-i', a.file,
          '-vf', `fps=fps=${(count / dur).toFixed(6)}:start_time=0:round=down,scale=${tileW}:${tileH}:flags=bilinear,tile=${cols}x${rows}:padding=0:margin=0`,
          '-frames:v', '1', '-q:v', '5', a.outJpg,
        ],
      });
      return { tileW, tileH, cols, rows, times };
    },

    async makePreview(src, out, opts) {
      const dur = await durationOf(src);
      const info = mediaInfoFromProbe(await probeJson(src));
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const ext = path.extname(out) || '.mp4';
      const tmp = `${out.slice(0, out.length - ext.length)}.partial${ext}`;
      try {
        await runFfmpeg({
          ffmpegPath: ffmpeg(),
          durationSec: dur ?? 0,
          signal: opts?.signal,
          onProgress: opts?.onProgress,
          args: [
            '-hide_banner', '-v', 'error', '-y', '-i', src,
            '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []),
            '-vf', `scale=-2:${even(Math.min(480, info.height ?? 480))}:flags=bicubic,format=yuv420p`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
            ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
            '-movflags', '+faststart', '-f', 'mp4', tmp,
          ],
        });
        await fs.promises.rename(tmp, out);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    },

    runFfmpeg,
  };
}
