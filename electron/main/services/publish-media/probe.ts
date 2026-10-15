/** ffprobe → `ProbedMediaInfo`. Failure messages are written for the person who picked the file. */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { containersOf } from '@shared/platform-specs';
import type { ProbedMediaInfo } from './types';

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  field_order?: string;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
}
interface FfProbe {
  streams?: FfStream[];
  format?: { format_name?: string; duration?: string; size?: string };
}

/** "30000/1001" → 29.97; "0/0" → null. */
export function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(r);
  const v = m ? Number(m[1]) / Number(m[2]) : Number(r);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** "1:1" or "N/A" → 1; "4:3" → 1.333. */
function parseSar(s: string | undefined): number {
  const m = /^(\d+):(\d+)$/.exec(s ?? '');
  if (!m || Number(m[2]) === 0 || Number(m[1]) === 0) return 1;
  return Number(m[1]) / Number(m[2]);
}

function rotationOf(v: FfStream): number {
  const raw = v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate;
  const n = Number(raw);
  return Number.isFinite(n) ? ((Math.round(n) % 360) + 360) % 360 : 0;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Pure part of the probe: ffprobe's JSON → info. Throws a plain Error when there is no video. */
export function infoFromFfprobe(
  json: FfProbe,
  sizeBytes: number,
  fileExt: string,
): ProbedMediaInfo {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error('This file has no video track.');
  const a = streams.find((s) => s.codec_type === 'audio');
  const w = v.width ?? 0;
  const h = v.height ?? 0;
  if (!(w > 0 && h > 0)) throw new Error('The video track has no picture size.');
  const durationRaw = Number(json.format?.duration ?? v.duration);
  if (!Number.isFinite(durationRaw) || durationRaw <= 0) {
    throw new Error('The video has no readable duration (it may be empty or damaged).');
  }
  const sar = parseSar(v.sample_aspect_ratio);
  const rot = rotationOf(v);
  const displayW = Math.round(w * sar);
  const [dw, dh] = rot === 90 || rot === 270 ? [h, displayW] : [displayW, h];
  const avg = parseRate(v.avg_frame_rate);
  const nominal = parseRate(v.r_frame_rate);
  const fps = avg ?? nominal;
  const field = v.field_order ?? 'progressive';
  return {
    durationSec: round3(durationRaw),
    width: dw,
    height: dh,
    fps: fps === null ? null : round3(fps),
    sizeBytes,
    videoCodec: v.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    container: containersOf(json.format?.format_name, fileExt),
    pixFmt: v.pix_fmt ?? null,
    interlaced: ['tt', 'bb', 'tb', 'bt'].includes(field),
    // an average well below the nominal rate means frames are missing/irregular: a variable-frame-rate file
    variableFps: avg !== null && nominal !== null && Math.abs(avg - nominal) / nominal > 0.03,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    audioChannels: a?.channels ?? null,
    sar,
  };
}

/** Runs ffprobe on `file`. */
export async function probeFile(
  ffprobePath: string,
  file: string,
  signal?: AbortSignal,
): Promise<ProbedMediaInfo> {
  const st = await stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`The video file could not be found (${file}).`);
  if (st.size === 0) throw new Error('The video file is empty.');
  const json = await new Promise<FfProbe>((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if (err.name === 'AbortError' || signal?.aborted) {
            const e = new Error('Canceled');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`ffprobe is not available (${ffprobePath}).`));
            return;
          }
          const why =
            (stderr || err.message).split(/\r?\n/).find((l) => l.trim()) ?? 'unknown error';
          reject(
            new Error(`This file is not a readable video (${why.replace(/^.*?:\s*/, '').trim()}).`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as FfProbe);
        } catch {
          reject(new Error('This file is not a readable video (ffprobe gave no usable answer).'));
        }
      },
    );
  });
  return infoFromFfprobe(json, st.size, path.extname(file));
}
