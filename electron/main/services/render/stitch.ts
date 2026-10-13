/**
 * Pure builders for stitching highlight segments: transition names, effective overlap, the xfade /
 * acrossfade chains and the resulting duration (sum of segments minus the sum of overlaps).
 */
import type { Transition } from '@shared/cp2';

/** FFmpeg `xfade` transition for each of our transitions ('cut' has none: plain concat). */
export const XFADE_NAME: Record<Exclude<Transition, 'cut'>, string> = {
  crossfade: 'fade',
  'dip-black': 'fadeblack',
  'dip-white': 'fadewhite',
  slide: 'slideleft',
  zoom: 'zoomin',
};

export const DEFAULT_TRANSITION_SEC = 0.35;
/** A transition never overlaps more than this share of the shortest segment. */
const MAX_OVERLAP_SHARE = 0.4;
const MIN_TRANSITION_SEC = 0.1;

/** Overlap actually used: 0 for 'cut', else the requested time (default 0.35) limited by the segments. */
export function effectiveTransitionSec(
  transition: Transition,
  requested: number | null | undefined,
  durations: number[],
): number {
  if (transition === 'cut' || durations.length < 2) return 0;
  const want =
    Number.isFinite(requested) && (requested ?? 0) > 0
      ? (requested as number)
      : DEFAULT_TRANSITION_SEC;
  const shortest = Math.min(...durations);
  const cap = Math.max(0, shortest * MAX_OVERLAP_SHARE);
  const t = Math.min(want, cap);
  return t < MIN_TRANSITION_SEC ? 0 : Math.round(t * 1000) / 1000;
}

/** Σ segments − Σ overlaps. */
export function stitchedDuration(durations: number[], transitionSec: number): number {
  const sum = durations.reduce((a, b) => a + b, 0);
  return Math.max(0, sum - Math.max(0, durations.length - 1) * transitionSec);
}

/** Video chain over the labelled segment streams -> `[outLabel]`. */
export function videoStitchGraph(
  labels: string[],
  durations: number[],
  transition: Transition,
  transitionSec: number,
  outLabel: string,
): string {
  if (labels.length === 1) return `[${labels[0]}]null[${outLabel}]`;
  if (transition === 'cut' || transitionSec <= 0) {
    return `${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=1:a=0[${outLabel}]`;
  }
  const name = XFADE_NAME[transition];
  const parts: string[] = [];
  let prev = labels[0] ?? '';
  let acc = durations[0] ?? 0;
  for (let i = 1; i < labels.length; i++) {
    const out = i === labels.length - 1 ? outLabel : `xf${i}`;
    const offset = Math.max(0, acc - transitionSec);
    parts.push(
      `[${prev}][${labels[i]}]xfade=transition=${name}:duration=${transitionSec.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`,
    );
    prev = out;
    acc = acc + (durations[i] ?? 0) - transitionSec;
  }
  return parts.join(';');
}

/** Audio chain over the labelled segment streams -> `[outLabel]` (acrossfade, or concat for cuts). */
export function audioStitchGraph(
  labels: string[],
  transition: Transition,
  transitionSec: number,
  outLabel: string,
): string {
  if (labels.length === 1) return `[${labels[0]}]anull[${outLabel}]`;
  if (transition === 'cut' || transitionSec <= 0) {
    return `${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=0:a=1[${outLabel}]`;
  }
  const parts: string[] = [];
  let prev = labels[0] ?? '';
  for (let i = 1; i < labels.length; i++) {
    const out = i === labels.length - 1 ? outLabel : `ax${i}`;
    parts.push(
      `[${prev}][${labels[i]}]acrossfade=d=${transitionSec.toFixed(3)}:c1=qsin:c2=qsin[${out}]`,
    );
    prev = out;
  }
  return parts.join(';');
}

/** Per-segment audio preparation: 48 kHz stereo, plus short edge fades when segments are cut together. */
export function segmentAudioChain(index: number, durationSec: number, fadeEdges: boolean): string {
  const parts = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
  if (fadeEdges) {
    const out = Math.min(0.02, durationSec / 4);
    parts.push('afade=t=in:st=0:d=0.01');
    parts.push(`afade=t=out:st=${Math.max(0, durationSec - out).toFixed(3)}:d=${out.toFixed(3)}`);
  }
  return `[${index}:a]${parts.join(',')}[a${index}]`;
}
