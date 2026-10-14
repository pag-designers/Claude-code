import type {
  Asset,
  AudioItem,
  Ducking,
  Project,
  Track,
  TransitionType,
  VideoItem,
} from '@shared/editor';
import {
  duckBreakpoints,
  duckGainAt,
  isActive,
  itemEnd,
  itemGainAt,
  transitionAudioGains,
  makeSourceOffset,
  sourceSpan,
  speedAt,
  type TimeRange,
} from '@shared/editor-eval';

/**
 * Pure scheduling maths of the Web Audio mixer: which items are audible, gain / duck / rate breakpoints, the
 * timeline→AudioContext time mapping and the reversed-window arithmetic. No DOM, no AudioContext — unit-tested with a
 * fake AudioParam that evaluates the automation it is given.
 */
export type MediaItem = VideoItem | AudioItem;

export interface AudioEntry {
  item: MediaItem;
  track: Track;
  asset: Asset;
  /** Transition overlaps this item takes part in (audio crossfade, see `transitionWindows`). */
  xfades: Crossfade[];
}

/**
 * One transition overlap seen from one of its two items. The later item carries `transitionIn`; the overlap runs from its
 * start to the end of the earlier item, and the progress p = (t − start) / dur (dur = the transition's duration, capped by
 * the overlap). Audio follows `transitionAudioGains` (a linear crossfade; a 'cut' overlap mutes the outgoing item) — the
 * same rule the exporter uses.
 */
export interface Crossfade {
  role: 'from' | 'to';
  type: TransitionType;
  /** Timeline seconds. */
  start: number;
  end: number;
  dur: number;
}

/** Transition overlaps of a track, keyed by item id (each overlap yields a 'from' entry and a 'to' entry). */
export function transitionWindows(track: Pick<Track, 'items'>): Map<string, Crossfade[]> {
  const out = new Map<string, Crossfade[]>();
  const push = (id: string, cf: Crossfade) => {
    const l = out.get(id);
    if (l) l.push(cf);
    else out.set(id, [cf]);
  };
  for (const to of track.items) {
    const tin = 'transitionIn' in to ? to.transitionIn : null;
    if (!tin) continue;
    let from: (typeof track.items)[number] | null = null;
    for (const c of track.items) {
      if (c === to || c.startSec >= to.startSec || itemEnd(c) <= to.startSec + 1e-6) continue;
      if (!from || c.startSec > from.startSec) from = c;
    }
    if (!from) continue;
    const end = Math.min(itemEnd(from), itemEnd(to));
    const overlap = end - to.startSec;
    if (overlap <= 1e-6) continue;
    const dur = tin.type === 'cut' ? overlap : Math.min(tin.durationSec, overlap);
    const base = { type: tin.type, start: to.startSec, end, dur };
    push(from.id, { ...base, role: 'from' });
    push(to.id, { ...base, role: 'to' });
  }
  return out;
}

/** Audio gain multiplier of one crossfade at timeline time t (1 outside the overlap). */
export function crossfadeGain(cf: Crossfade, t: number): number {
  if (t < cf.start || t >= cf.end) return 1;
  const p = cf.dur > 1e-9 ? Math.min(1, Math.max(0, (t - cf.start) / cf.dur)) : 1;
  return transitionAudioGains(cf.type, p)[cf.role];
}

export const crossfadeMult = (cfs: readonly Crossfade[], t: number): number =>
  cfs.reduce((m, cf) => m * crossfadeGain(cf, t), 1);

/** Linear media gain of a track: mute / hidden → 0, otherwise `track.gain`. */
export const trackLevel = (track: Pick<Track, 'muted' | 'hidden' | 'gain'>): number =>
  track.muted || track.hidden ? 0 : Math.max(0, track.gain);

/**
 * Every item that can make sound: audio items, and video items with `audioEnabled` whose asset has an audio stream, on
 * tracks that are neither muted nor hidden and have a non-zero gain. Freeze frames are silent.
 */
export function audioEntries(project: Pick<Project, 'tracks' | 'assets'>): AudioEntry[] {
  const assets = new Map(project.assets.map((a) => [a.id, a] as const));
  const out: AudioEntry[] = [];
  for (const track of project.tracks) {
    if (trackLevel(track) <= 0) continue;
    const windows = transitionWindows(track);
    for (const item of track.items) {
      if (item.type !== 'video' && item.type !== 'audio') continue;
      if (item.freezeAtSec !== null) continue;
      const asset = assets.get(item.assetId);
      if (!asset) continue;
      if (item.type === 'video' && (!item.audioEnabled || !asset.hasAudio)) continue;
      if (item.type === 'audio' && asset.kind === 'image') continue;
      out.push({ item, track, asset, xfades: windows.get(item.id) ?? [] });
    }
  }
  return out;
}

/** Entries overlapping the timeline window [t0, t1). */
export function entriesInWindow(
  entries: readonly AudioEntry[],
  t0: number,
  t1: number,
): AudioEntry[] {
  return entries.filter((e) => e.item.startSec < t1 && itemEnd(e.item) > t0);
}

export const entriesActiveAt = (entries: readonly AudioEntry[], t: number): AudioEntry[] =>
  entries.filter((e) => isActive(e.item, t));

/* ------------------------------------------------------------------ time mapping ------------ */

/** Timeline time `tl0` plays at AudioContext time `ctx0`, `rate` timeline seconds per context second. */
export interface Anchor {
  tl0: number;
  ctx0: number;
  rate: number;
}
export const ctxAt = (a: Anchor, tl: number): number => a.ctx0 + (tl - a.tl0) / a.rate;
export const tlAt = (a: Anchor, ctx: number): number => a.tl0 + (ctx - a.ctx0) * a.rate;

/* ------------------------------------------------------------------ gain curves ------------- */

export interface Point {
  /** Time (item-local seconds for item curves, timeline seconds for duck curves). */
  t: number;
  v: number;
}

const GAIN_TOL = 2e-3;

/**
 * Piecewise-linear approximation of `itemGainAt` × the transition crossfade gain over item-local [from, to]. Kinks (keyframes, fade ends) are exact
 * breakpoints; spans between them are bisected until the midpoint is within 2e-3 of the chord, so eased keyframes and the
 * product of a ramp with a fade stay accurate.
 */
export function itemGainPoints(
  item: MediaItem,
  from: number,
  to: number,
  xfades: readonly Crossfade[] = [],
): Point[] {
  const lo = Math.max(0, from);
  const hi = Math.min(item.durationSec, to);
  if (hi < lo) return [];
  const g = (tl: number) => itemGainAt(item, tl) * crossfadeMult(xfades, item.startSec + tl);
  const cand = new Set<number>([lo, hi]);
  const add = (t: number) => {
    if (t > lo && t < hi) cand.add(Math.round(t * 1e6) / 1e6);
  };
  for (const k of item.volume.kf) {
    add(k.t);
    if (k.ease === 'hold') add(k.t - 0.001);
  }
  if (item.fadeInSec > 0) add(item.fadeInSec);
  if (item.fadeOutSec > 0) add(item.durationSec - item.fadeOutSec);
  for (const cf of xfades) {
    // kinks of the crossfade ramp; a 'cut' overlap is a near-instant step
    for (const t of [cf.start, cf.start + cf.dur, cf.end]) add(t - item.startSec);
    if (cf.type === 'cut') add(cf.start - item.startSec - 0.001);
  }
  const times = [...cand].sort((a, b) => a - b);
  const out: Point[] = [{ t: times[0] as number, v: g(times[0] as number) }];
  const refine = (a: number, b: number, ga: number, gb: number, depth: number) => {
    if (depth > 0 && b - a > 0.004) {
      const m = (a + b) / 2;
      const gm = g(m);
      if (Math.abs(gm - (ga + gb) / 2) > GAIN_TOL) {
        refine(a, m, ga, gm, depth - 1);
        refine(m, b, gm, gb, depth - 1);
        return;
      }
    }
    out.push({ t: b, v: gb });
  };
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1] as number;
    const b = times[i] as number;
    refine(a, b, g(a), g(b), 7);
  }
  return out;
}

/** Duck gain breakpoints (timeline seconds) within [from, to]; exact because `duckGainAt` is linear between them. */
export function duckPoints(
  ranges: readonly TimeRange[],
  d: Pick<Ducking, 'enabled' | 'reductionDb' | 'attackSec' | 'releaseSec'>,
  projectDuration: number,
  from: number,
  to: number,
): Point[] {
  const pts = new Set<number>([from, to]);
  for (const t of duckBreakpoints(ranges, d, Math.max(projectDuration, to)))
    if (t > from && t < to) pts.add(t);
  return [...pts].sort((a, b) => a - b).map((t) => ({ t, v: duckGainAt(ranges, d, t) }));
}

/* ------------------------------------------------------------------ playback rate ----------- */

/** Chromium plays <audio> cleanly only inside this rate range (outside it the media pipeline mutes). */
export const ELEMENT_RATE_RANGE = { min: 0.25, max: 4 } as const;

/** Min / max of the item's speed over its duration (curve keyframes included). */
export function speedExtent(item: MediaItem): { min: number; max: number } {
  if (!item.speedCurve.length) return { min: item.speed, max: item.speed };
  let min = Infinity;
  let max = -Infinity;
  for (const k of item.speedCurve) {
    const v = Math.min(10, Math.max(0.1, k.v));
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { min, max };
}

/**
 * 'element' = an <audio> element through MediaElementSource (streams, pitch-preserving time-stretch);
 * 'buffer'  = a decoded AudioBuffer (reverse, and speeds the media pipeline would mute — pitch follows the speed).
 */
export function voiceKind(item: MediaItem, transportRate: number): 'element' | 'buffer' {
  if (item.reverse) return 'buffer';
  const { min, max } = speedExtent(item);
  const r = Math.abs(transportRate) || 1;
  return min * r < ELEMENT_RATE_RANGE.min || max * r > ELEMENT_RATE_RANGE.max
    ? 'buffer'
    : 'element';
}

/** Playback rate of an element voice at item-local time tl for a transport rate (clamped into the clean range). */
export function elementRateAt(item: MediaItem, tl: number, transportRate: number): number {
  const r = speedAt(item, tl) * transportRate;
  return Math.min(ELEMENT_RATE_RANGE.max, Math.max(ELEMENT_RATE_RANGE.min, r));
}

/** Speed ramp → rate breakpoints (item-local seconds) for a buffer voice's playbackRate automation. */
export function ratePoints(
  item: MediaItem,
  from: number,
  to: number,
  transportRate: number,
  maxPoints = 400,
): Point[] {
  const lo = Math.max(0, from);
  const hi = Math.min(item.durationSec, to);
  if (!item.speedCurve.length || hi <= lo) return [{ t: lo, v: item.speed * transportRate }];
  const step = Math.max(0.05, (hi - lo) / maxPoints);
  const out: Point[] = [];
  for (let t = lo; t < hi; t += step) out.push({ t, v: speedAt(item, t) * transportRate });
  out.push({ t: hi, v: speedAt(item, hi) * transportRate });
  return out;
}

/* ------------------------------------------------------------------ reverse ------------------ */

/**
 * The window of the asset a reversed item plays, in SOURCE seconds. The decoded buffer is cut to [startSrc, endSrc] and
 * time-reversed, so index k of the reversed buffer = asset time endSrc − k.
 */
export function reverseWindow(
  item: MediaItem,
  assetDurationSec: number | null,
): { startSrc: number; endSrc: number } {
  const span = sourceSpan(item);
  const startSrc = item.inSec;
  const endSrc = Math.min(assetDurationSec ?? Infinity, item.inSec + span);
  return { startSrc, endSrc: Math.max(startSrc, endSrc) };
}

/**
 * Position (seconds) in the reversed buffer at item-local time tl. Negative while the item still points beyond the end of
 * the asset (the player waits that long before the sound begins).
 */
export function reverseBufferPos(
  item: MediaItem,
  assetDurationSec: number | null,
  tl: number,
): number {
  const { endSrc } = reverseWindow(item, assetDurationSec);
  const span = sourceSpan(item);
  // source time at tl = inSec + span − consumed(tl); position = endSrc − that.
  return endSrc - (item.inSec + span - makeSourceOffset(item)(tl));
}

/* ------------------------------------------------------------------ AudioParam scheduling ---- */

export interface ParamLike {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

/**
 * Applies breakpoints (already in AudioContext time) to a param.
 *  - `restartAt`: cancel everything scheduled from that time on, pin `startValue` there, then ramp through the points;
 *  - `continueFrom`: the ctx time of the previous automation event; the points ramp on from it;
 *  - neither: the first point is a `setValueAtTime`, the rest ramp.
 * Two points at the same time make a step.
 */
export function scheduleLinear(
  param: ParamLike,
  pts: readonly { ctx: number; v: number }[],
  opts: { restartAt?: number; startValue?: number; continueFrom?: number } = {},
): void {
  let prev = -Infinity;
  if (opts.restartAt !== undefined) {
    param.cancelScheduledValues(opts.restartAt);
    param.setValueAtTime(opts.startValue ?? pts[0]?.v ?? 0, opts.restartAt);
    prev = opts.restartAt;
  } else if (opts.continueFrom !== undefined) prev = opts.continueFrom;
  for (const p of pts) {
    if (prev === -Infinity) {
      param.setValueAtTime(p.v, p.ctx);
      prev = p.ctx;
      continue;
    }
    const t = Math.max(p.ctx, prev);
    if (t - prev < 1e-6) param.setValueAtTime(p.v, t);
    else param.linearRampToValueAtTime(p.v, t);
    prev = t;
  }
}

/** Scrub grain envelope: 6 ms attack, hold, 20 ms release over `durSec`. */
export function grainEnvelope(peak: number, durSec = 0.08): Point[] {
  const a = 0.006;
  const r = 0.02;
  return [
    { t: 0, v: 0 },
    { t: a, v: peak },
    { t: Math.max(a, durSec - r), v: peak },
    { t: durSec, v: 0 },
  ];
}

/** Product used for the debug "expected" gain of an item: volume × fades × transition crossfade × track level × duck. */
export function expectedGain(entry: AudioEntry, ranges: readonly TimeRange[], t: number): number {
  const { item, track } = entry;
  const tl = t - item.startSec;
  if (tl < 0 || tl > item.durationSec) return 0;
  return (
    itemGainAt(item, tl) *
    crossfadeMult(entry.xfades, t) *
    trackLevel(track) *
    duckGainAt(ranges, track.ducking, t)
  );
}
