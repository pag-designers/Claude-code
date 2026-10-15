/**
 * Pure media validation against shared/platform-specs. Each violated limit is a `MediaIssue`:
 *   error   = the platform would reject the file (or not treat it as the product: a "Short")
 *   warning = it works but is suboptimal
 * `fixable` = ONE re-encode (codec, container, fps, bitrate, size, resolution-down) removes it. Duration and aspect are
 * never "fixed": that would mean trimming or cropping the person's clip.
 */
import {
  aspectOf,
  formatBytes,
  formatClock,
  isRecommendedAspect,
  PLATFORM_SPECS,
  type PlatformSpec,
} from '@shared/platform-specs';
import type { MediaIssue, MediaReport, Platform, PostMediaInfo } from '@shared/publish';
import type { ProbedMediaInfo, SpecOverrides } from './types';

/** Slack so a 3:00.02 clip (frame alignment) is not rejected for a 180 s limit. */
const DURATION_EPS = 0.05;
const FPS_EPS = 0.02;
const ASPECT_EPS = 0.005;

const norm = (codec: string | null): string | null =>
  codec === null ? null : codec === 'h265' ? 'hevc' : codec.toLowerCase();

const list = (xs: readonly string[]): string =>
  xs.map((x) => x.toUpperCase()).join(xs.length === 2 ? ' or ' : ', ');

const fpsText = (n: number): string => `${+n.toFixed(2)} fps`;

/** Pixel format → "4:2:0" / "4:4:4" / "4:2:2" (null when unknown). */
export function chromaOf(pixFmt: string | null | undefined): string | null {
  if (!pixFmt) return null;
  if (/^(yuvj?a?420|nv12|nv21|p01)/.test(pixFmt)) return '4:2:0';
  if (/^(yuvj?a?422|uyvy422|yuyv422|nv16)/.test(pixFmt)) return '4:2:2';
  if (/^(yuvj?a?444|gbr|rgb|bgr|argb|abgr|nv24)/.test(pixFmt)) return '4:4:4';
  if (/^yuv411/.test(pixFmt)) return '4:1:1';
  return null;
}

/** Bits per second of the whole file (video + audio), 0 when the duration is unknown. */
export const averageBitrateBps = (info: PostMediaInfo): number =>
  info.durationSec > 0 ? (info.sizeBytes * 8) / info.durationSec : 0;

export function validateMedia(
  info: ProbedMediaInfo,
  platform: Platform,
  overrides: SpecOverrides = {},
): MediaReport {
  const spec: PlatformSpec = PLATFORM_SPECS[platform];
  const name = spec.label;
  const issues: MediaIssue[] = [];
  const add = (
    severity: MediaIssue['severity'],
    code: MediaIssue['code'],
    message: string,
    fixable: boolean,
  ): void => {
    issues.push({ severity, code, message, fixable });
  };

  // ---- duration (never fixable) ---------------------------------------------------------------------
  const maxDur =
    overrides.maxDurationSec !== undefined && overrides.maxDurationSec !== null
      ? overrides.maxDurationSec
      : spec.durationSec.max;
  const minDur = spec.durationSec.min;
  if (minDur !== null && info.durationSec < minDur - DURATION_EPS) {
    add(
      'error',
      'duration-short',
      `Your clip is ${formatClock(info.durationSec)} long; ${name} needs at least ${formatClock(minDur)}.`,
      false,
    );
  }
  if (maxDur !== null && info.durationSec > maxDur + DURATION_EPS) {
    const asShort =
      platform === 'shorts' ? ' Longer videos are published as regular videos, not Shorts.' : '';
    add(
      'error',
      'duration-long',
      `Your clip is ${formatClock(info.durationSec)} long; ${name} accepts up to ${formatClock(maxDur)}.${asShort}`,
      false,
    );
  }

  // ---- size -------------------------------------------------------------------------------------------
  if (spec.maxSizeBytes !== null && info.sizeBytes > spec.maxSizeBytes) {
    add(
      'error',
      'size-large',
      `The file is ${formatBytes(info.sizeBytes)}; ${name} accepts up to ${formatBytes(spec.maxSizeBytes)}. It can be re-encoded smaller.`,
      true,
    );
  }

  // ---- container ----------------------------------------------------------------------------------------
  if (spec.containers && info.container && info.container.length > 0) {
    if (!info.container.some((c) => spec.containers!.includes(c))) {
      add(
        'error',
        'container',
        `The file is ${info.container.join('/').toUpperCase()}; ${name} needs ${list(spec.containers)}.`,
        true,
      );
    }
  }

  // ---- video codec / chroma / scan ------------------------------------------------------------------------
  const vc = norm(info.videoCodec);
  if (spec.videoCodecs && vc !== null && !spec.videoCodecs.includes(vc)) {
    add(
      'error',
      'codec',
      `The video is ${vc.toUpperCase()}; ${name} needs ${list(spec.videoCodecs)}.`,
      true,
    );
  }
  if (spec.requires420Progressive) {
    const chroma = chromaOf(info.pixFmt);
    if (chroma !== null && chroma !== '4:2:0') {
      add('error', 'codec', `The video uses ${chroma} colour sampling; ${name} needs 4:2:0.`, true);
    } else if (info.pixFmt && /(10|12|16)(le|be)$/.test(info.pixFmt)) {
      add(
        'error',
        'codec',
        `The video is ${info.pixFmt.match(/(10|12|16)/)![1]}-bit; ${name} needs 8-bit 4:2:0.`,
        true,
      );
    }
    if (info.interlaced) {
      add('error', 'codec', `The video is interlaced; ${name} needs progressive video.`, true);
    }
  }

  // ---- audio ----------------------------------------------------------------------------------------------------
  const ac = info.audioCodec?.toLowerCase() ?? null;
  if (spec.audioCodecs && ac !== null && !spec.audioCodecs.includes(ac)) {
    add(
      'error',
      'audio-codec',
      `The audio is ${ac.toUpperCase()}; ${name} needs ${list(spec.audioCodecs)}.`,
      true,
    );
  }
  if (
    ac !== null &&
    spec.maxAudioSampleRate !== null &&
    info.audioSampleRate &&
    info.audioSampleRate > spec.maxAudioSampleRate
  ) {
    add(
      'error',
      'audio-codec',
      `The audio sample rate is ${+(info.audioSampleRate / 1000).toFixed(1)} kHz; ${name} accepts up to ${spec.maxAudioSampleRate / 1000} kHz.`,
      true,
    );
  }
  if (
    ac !== null &&
    spec.maxAudioChannels !== null &&
    info.audioChannels &&
    info.audioChannels > spec.maxAudioChannels
  ) {
    add(
      'error',
      'audio-codec',
      `The audio has ${info.audioChannels} channels; ${name} accepts mono or stereo.`,
      true,
    );
  }

  // ---- frame rate -----------------------------------------------------------------------------------------------
  const { min: fMin, max: fMax } = spec.fps;
  let fpsError = false;
  if (info.fps !== null) {
    if (fMin !== null && info.fps < fMin - FPS_EPS) {
      fpsError = true;
      add(
        'error',
        'fps',
        `The frame rate is ${fpsText(info.fps)}; ${name} needs ${fMin}–${fMax ?? '∞'} fps.`,
        true,
      );
    } else if (fMax !== null && info.fps > fMax + FPS_EPS) {
      fpsError = true;
      add(
        'error',
        'fps',
        `The frame rate is ${fpsText(info.fps)}; ${name} accepts at most ${fMax} fps.`,
        true,
      );
    }
  }
  if (!fpsError && info.variableFps) {
    add(
      'warning',
      'fps',
      'The video has a variable frame rate (typical for screen recordings); a constant rate plays and processes more reliably.',
      true,
    );
  }

  // ---- aspect (never fixable) ---------------------------------------------------------------------------------------
  const ratio = aspectOf(info.width, info.height);
  const { min: aMin, max: aMax } = spec.aspect;
  const shape = `${info.width}×${info.height}`;
  if (aMax !== null && ratio > aMax + ASPECT_EPS) {
    add(
      'error',
      'aspect',
      platform === 'shorts'
        ? `The video is ${shape} (wider than tall). YouTube only treats vertical or square videos as Shorts; this would be published as a regular video.`
        : `The video is ${shape}; ${name} needs a width-to-height ratio of at most ${aMax}:1.`,
      false,
    );
  } else if (aMin !== null && ratio < aMin - ASPECT_EPS) {
    add(
      'error',
      'aspect',
      `The video is ${shape}; ${name} needs a width-to-height ratio of at least ${aMin}:1.`,
      false,
    );
  } else if (!isRecommendedAspect(spec, ratio)) {
    add(
      'warning',
      'aspect',
      `The video is ${shape}; 9:16 (vertical) is recommended on ${name}, other shapes get cropped or shown with bars.`,
      false,
    );
  }

  // ---- resolution -------------------------------------------------------------------------------------------------------
  const r = spec.resolution;
  const tooBig =
    (r.maxWidth !== null && info.width > r.maxWidth) ||
    (r.maxHeight !== null && info.height > r.maxHeight);
  const tooSmall =
    (r.minWidth !== null && info.width < r.minWidth) ||
    (r.minHeight !== null && info.height < r.minHeight);
  if (tooBig) {
    const lim = [
      r.maxWidth !== null ? `${r.maxWidth} px wide` : null,
      r.maxHeight !== null ? `${r.maxHeight} px tall` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    add(
      'error',
      'resolution',
      `The video is ${shape}; ${name} accepts at most ${lim}. It can be scaled down.`,
      true,
    );
  }
  if (tooSmall) {
    add(
      'error',
      'resolution',
      `The video is ${shape}; ${name} needs at least ${r.minWidth ?? r.minHeight}×${r.minHeight ?? r.minWidth} px. Auto-fix never scales up.`,
      false,
    );
  }

  // ---- bitrate ---------------------------------------------------------------------------------------------------------------
  if (spec.maxVideoBitrateBps !== null) {
    const bps = averageBitrateBps(info);
    if (bps > spec.maxVideoBitrateBps) {
      add(
        'error',
        'bitrate',
        `The average bitrate is ${+(bps / 1e6).toFixed(1)} Mbit/s; ${name} accepts up to ${spec.maxVideoBitrateBps / 1e6} Mbit/s.`,
        true,
      );
    }
  }

  return {
    platform,
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    media: info,
  };
}
