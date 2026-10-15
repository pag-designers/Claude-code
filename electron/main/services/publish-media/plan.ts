/**
 * The re-encode plan: pure maths from the probe + the platform spec to ffmpeg arguments. No process is started here.
 *
 * Size rule ("two-pass math from the duration, in one pass"): the video must fit
 *     budget = cap_bytes * 8 / duration - audio bit/s - muxing overhead.
 * ffmpeg then runs constant-quality (CRF) with a VBV ceiling of that budget (`-maxrate`/`-bufsize`): an easy clip keeps its
 * quality and stays far below the limit, a hard one cannot exceed `maxrate * duration` (+ one buffer), which is what
 * the margin covers. When the budget is too small for the picture size, the picture is scaled DOWN (never up) until
 * each pixel gets a watchable share of bits, and the fix is refused when even the smallest allowed picture cannot.
 */
import {
  PLATFORM_SPECS,
  formatBytes,
  formatClock,
  type PlatformSpec,
} from '@shared/platform-specs';
import type { MediaIssue, Platform } from '@shared/publish';
import { encoderArgs, type EncoderName } from '../render/encoder';
import type { ProbedMediaInfo } from './types';

/** Aim for this share of the platform's size limit (container overhead, VBV overshoot). */
export const SIZE_SAFETY = 0.92;
/** Aim for this share of the platform's bitrate ceiling. */
export const BITRATE_SAFETY = 0.9;
export const AUDIO_BPS_STEREO = 128_000;
export const AUDIO_BPS_MONO = 96_000;
export const AUDIO_SAMPLE_RATE = 48_000;
/** Bits per pixel per frame below which a picture looks bad; the picture is scaled down to get here. */
const TARGET_BPP = 0.045;
/** Below this, re-encoding is refused (it would be unwatchable). */
const MIN_BPP = 0.02;
/** Smallest short side used when a size limit forces a downscale and the platform sets no minimum. */
const FLOOR_SHORT_SIDE = 240;
/** Muxing overhead (moov, interleave) as a share of the stream. */
const MUX_OVERHEAD = 0.02;

export interface FixPlan {
  /** Output picture size (even numbers, display size, square pixels). */
  width: number;
  height: number;
  /** A scale filter is needed (size differs from the source's, or the source has non-square pixels / odd sides). */
  scale: boolean;
  /** Constant frame rate for the `fps` filter; null keeps the source timing. */
  fps: number | null;
  deinterlace: boolean;
  /** VBV ceiling for the video in bit/s; null = no ceiling. */
  videoCapBps: number | null;
  audio: { channels: 1 | 2; bitrateBps: number } | null;
  /** What changes, in plain words (logged / shown). */
  notes: string[];
}

const even = (n: number): number => Math.max(2, 2 * Math.floor(n / 2));

/** The fps to convert to so that `src` ends up inside [min, max] with an even cadence (every k-th frame / each frame k times). */
export function targetFps(
  src: number,
  min: number | null,
  max: number | null,
  variable: boolean,
): number | null {
  if (max !== null && src > max + 0.02) {
    return +(src / Math.ceil(src / max - 0.001)).toFixed(3);
  }
  if (min !== null && src < min - 0.02) {
    return +(src * Math.ceil(min / src - 0.001)).toFixed(3);
  }
  if (variable) return Math.max(1, Math.round(src));
  return null;
}

/** Plans the fix. Throws a plain Error when the size/bitrate limit cannot be met at a watchable quality. */
export function planFix(
  info: ProbedMediaInfo,
  platform: Platform,
  issues: readonly MediaIssue[],
): FixPlan {
  const spec: PlatformSpec = PLATFORM_SPECS[platform];
  const has = (code: MediaIssue['code']): boolean =>
    issues.some((i) => i.code === code && i.fixable);
  const notes: string[] = [];

  // ---- fps ------------------------------------------------------------------------------------------------
  let fps: number | null = null;
  if (has('fps') && info.fps !== null) {
    fps = targetFps(info.fps, spec.fps.min, spec.fps.max, info.variableFps === true);
    if (fps !== null) notes.push(`frame rate ${+info.fps.toFixed(2)} → constant ${fps} fps`);
  }
  const outFps = fps ?? info.fps ?? 30;

  // ---- picture size ---------------------------------------------------------------------------------------------
  const r = spec.resolution;
  let factor = 1;
  if (r.maxWidth !== null) factor = Math.min(factor, r.maxWidth / info.width);
  if (r.maxHeight !== null) factor = Math.min(factor, r.maxHeight / info.height);
  let width = even(info.width * factor);
  let height = even(info.height * factor);
  // the rounding above must not push a side over a maximum
  if (r.maxWidth !== null && width > r.maxWidth) width = even(r.maxWidth - 1);
  if (r.maxHeight !== null && height > r.maxHeight) height = even(r.maxHeight - 1);
  if (factor < 1) notes.push(`scaled down ${info.width}×${info.height} → ${width}×${height}`);

  // ---- rate ceiling ------------------------------------------------------------------------------------------------
  const channels: 1 | 2 = (info.audioChannels ?? 2) === 1 ? 1 : 2;
  const audioBps =
    info.audioCodec === null ? 0 : channels === 1 ? AUDIO_BPS_MONO : AUDIO_BPS_STEREO;
  let videoCapBps: number | null = null;
  if (has('size-large') && spec.maxSizeBytes !== null) {
    const total = (spec.maxSizeBytes * SIZE_SAFETY * 8) / info.durationSec;
    videoCapBps = Math.floor(total * (1 - MUX_OVERHEAD) - audioBps);
  }
  if (has('bitrate') && spec.maxVideoBitrateBps !== null) {
    const b = Math.floor(spec.maxVideoBitrateBps * BITRATE_SAFETY - audioBps);
    videoCapBps = videoCapBps === null ? b : Math.min(videoCapBps, b);
  }
  if (videoCapBps !== null) {
    const minW = r.minWidth ?? 0;
    const minH = r.minHeight ?? 0;
    const bpp = (w: number, h: number): number => videoCapBps! / (w * h * outFps);
    if (bpp(width, height) < TARGET_BPP) {
      const shrink = Math.sqrt(bpp(width, height) / TARGET_BPP);
      // never below the platform's minimum picture, nor a sane short side
      const sFloor = Math.min(
        1,
        Math.max(minW / width, minH / height, FLOOR_SHORT_SIDE / Math.min(width, height)),
      );
      const s = Math.max(shrink, sFloor);
      width = even(width * s);
      height = even(height * s);
      notes.push(`scaled to ${width}×${height} to fit the size limit`);
    }
    if (videoCapBps <= 0 || bpp(width, height) < MIN_BPP) {
      const what =
        spec.maxSizeBytes !== null && has('size-large')
          ? `${formatBytes(spec.maxSizeBytes)} limit`
          : 'bitrate limit';
      throw new Error(
        `A ${formatClock(info.durationSec)} clip cannot be squeezed into ${spec.label}'s ${what} at a watchable quality. Use a shorter clip.`,
      );
    }
    notes.push(`video limited to ${Math.round(videoCapBps / 1000)} kbit/s`);
  }

  const scale = width !== info.width || height !== info.height || (info.sar ?? 1) !== 1;
  const deinterlace = info.interlaced === true;
  if (deinterlace) notes.push('deinterlaced');
  if (info.pixFmt && !/^yuv420p$/.test(info.pixFmt))
    notes.push(`${info.pixFmt} → yuv420p (8-bit 4:2:0)`);

  return {
    width,
    height,
    scale,
    fps,
    deinterlace,
    videoCapBps,
    audio: info.audioCodec === null ? null : { channels, bitrateBps: audioBps },
    notes,
  };
}

/** Sets `key`'s value in a flat arg list (adds the pair when missing). */
function setArg(a: string[], key: string, value: string): void {
  const i = a.indexOf(key);
  if (i >= 0 && i + 1 < a.length) a[i + 1] = value;
  else a.push(key, value);
}

/** Video encoder arguments from the render module's choice, with the plan's rate ceiling applied. */
export function videoEncoderArgs(enc: EncoderName, fps: number, capBps: number | null): string[] {
  const a = encoderArgs(enc, fps);
  if (capBps === null) return a;
  const k = Math.max(100, Math.floor(capBps / 1000));
  if (enc === 'h264_videotoolbox') {
    setArg(a, '-b:v', `${Math.min(k, 10_000)}k`);
    setArg(a, '-maxrate', `${k}k`);
  } else {
    setArg(a, '-maxrate', `${k}k`);
    setArg(a, '-bufsize', `${2 * k}k`);
  }
  return a;
}

/** The full ffmpeg argument list for `plan` (output muxed as MP4 into `output`, which may be a `.partial` path). */
export function buildFixArgs(
  input: string,
  output: string,
  info: ProbedMediaInfo,
  plan: FixPlan,
  enc: EncoderName,
): string[] {
  const vf: string[] = [];
  if (plan.deinterlace) vf.push('yadif=mode=send_frame:parity=auto:deint=all');
  if (plan.scale) vf.push(`scale=${plan.width}:${plan.height}:flags=lanczos`);
  vf.push('setsar=1');
  if (plan.fps !== null) vf.push(`fps=${plan.fps}`);
  vf.push('format=yuv420p');
  const outFps = plan.fps ?? info.fps ?? 30;
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    input,
    '-map',
    '0:v:0',
    ...(plan.audio ? ['-map', '0:a:0'] : []),
    '-sn',
    '-dn',
    '-map_chapters',
    '-1',
    '-vf',
    vf.join(','),
    ...videoEncoderArgs(enc, outFps, plan.videoCapBps),
    '-pix_fmt',
    'yuv420p',
  ];
  if (plan.audio) {
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      String(plan.audio.bitrateBps),
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      '-ac',
      String(plan.audio.channels),
    );
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}
