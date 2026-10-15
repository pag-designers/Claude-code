import type {
  AudioItem,
  Item,
  Keyframe,
  Project,
  SubtitleItem,
  SubtitleWord,
  VideoItem,
} from '@shared/editor';
import { itemEnd, makeSourceTime } from '@shared/editor-eval';

/* ------------------------------------------------------------------------------------------------
 * Timeline ↔ SOURCE time mapping used by Re-sync with AI, the Reframe tool and Cut-to-beats.
 * Everything goes through `makeSourceTime` (speed, ramps, reverse, freeze) — never re-derived.
 * ---------------------------------------------------------------------------------------------- */

export type MediaItem = VideoItem | AudioItem;
export const isMedia = (i: Item): i is MediaItem => i.type === 'video' || i.type === 'audio';

/**
 * Inverse of makeSourceTime on [0, durationSec]: the item-local time at which the item shows source time `src`, or
 * null when the item never reaches it (outside its window, or frozen). The map is monotonic (forward ↑, reverse ↓).
 */
export function sourceToLocal(item: MediaItem, src: number): number | null {
  if (item.freezeAtSec !== null) return null;
  const f = makeSourceTime(item);
  const a = f(0);
  const b = f(item.durationSec);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (src < lo - 1e-6 || src > hi + 1e-6) return null;
  const increasing = b >= a;
  let l = 0;
  let h = item.durationSec;
  for (let i = 0; i < 50; i++) {
    const m = (l + h) / 2;
    const v = f(m);
    if (increasing ? v < src : v > src) l = m;
    else h = m;
  }
  return (l + h) / 2;
}

/** The source window [start, end] an item covers (sorted, so reverse works too). */
export function sourceWindow(item: MediaItem): { start: number; end: number } {
  const f = makeSourceTime(item);
  const a = f(0);
  const b = f(item.durationSec);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/* ------------------------------------------------------------------ re-sync ------------------------ */

/** The media item that carries the speech behind a cue: the audible video / audio item overlapping it the most. */
export function findCueMedia(project: Project, cue: SubtitleItem): MediaItem | null {
  const s = cue.startSec;
  const e = itemEnd(cue);
  let best: { item: MediaItem; overlap: number } | null = null;
  for (const tr of project.tracks) {
    if (tr.muted) continue;
    for (const it of tr.items) {
      if (!isMedia(it) || it.freezeAtSec !== null) continue;
      if (it.type === 'video' && !it.audioEnabled) continue;
      const overlap = Math.min(e, itemEnd(it)) - Math.max(s, it.startSec);
      if (overlap <= 0) continue;
      // speech tracks win ties
      const w = overlap * (tr.speech ? 1.001 : 1);
      if (!best || w > best.overlap) best = { item: it, overlap: w };
    }
  }
  return best ? best.item : null;
}

/** The SOURCE range to re-transcribe for a cue (with `pad` seconds of context on both sides, clamped at 0). */
export function cueSourceRange(
  media: MediaItem,
  cue: Pick<SubtitleItem, 'startSec' | 'durationSec'>,
  pad = 0.25,
): { srcStartSec: number; srcEndSec: number } {
  const f = makeSourceTime(media);
  const l0 = Math.max(0, cue.startSec - media.startSec);
  const l1 = Math.min(media.durationSec, cue.startSec + cue.durationSec - media.startSec);
  const a = f(l0);
  const b = f(l1);
  return {
    srcStartSec: Math.max(0, Math.min(a, b) - pad),
    srcEndSec: Math.max(a, b) + pad,
  };
}

/**
 * Maps freshly transcribed SOURCE-time words back onto the cue: each source time is turned into a timeline time via
 * the inverse of the media item's source map, then made local to the cue. Words whose centre falls outside the cue are
 * dropped (they belong to the padding / a neighbouring cue). Highlight colours are kept by index when the word count
 * is unchanged.
 */
export function mapSourceWordsToCue(
  media: MediaItem,
  cue: Pick<SubtitleItem, 'startSec' | 'durationSec' | 'words'>,
  words: readonly { w: string; s: number; e: number }[],
): SubtitleWord[] {
  const out: SubtitleWord[] = [];
  const f = makeSourceTime(media);
  const w0 = f(0);
  const w1 = f(media.durationSec);
  const toLocal = (src: number): number => {
    const clamped = Math.min(Math.max(src, Math.min(w0, w1)), Math.max(w0, w1));
    const l = sourceToLocal(media, clamped);
    return (l ?? 0) + media.startSec - cue.startSec;
  };
  for (const word of words) {
    if (!word.w.trim()) continue;
    const a = toLocal(word.s);
    const b = toLocal(word.e);
    const s = Math.min(a, b);
    const e = Math.max(a, b);
    const mid = (s + e) / 2;
    if (mid < 0 || mid > cue.durationSec) continue;
    out.push({
      w: word.w.trim(),
      s: Math.max(0, Math.min(s, cue.durationSec)),
      e: Math.max(0, Math.min(Math.max(e, s + 0.02), cue.durationSec)),
      color: null,
    });
  }
  if (out.length === cue.words.length) {
    out.forEach((w, i) => {
      w.color = cue.words[i]?.color ?? null;
    });
  }
  // keep the words in time order and make sure none overlaps its successor
  out.sort((x, y) => x.s - y.s);
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i] as SubtitleWord;
    const nxt = out[i + 1] as SubtitleWord;
    if (cur.e > nxt.s) cur.e = Math.max(cur.s + 0.01, nxt.s);
  }
  return out;
}

/* ------------------------------------------------------------------ reframe ----------------------- */

export interface CropKey {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What to ask `editor:reframe` for: the source window the item covers (null when the item is a freeze frame). */
export function reframeWindow(item: VideoItem): { startSec: number; endSec: number } | null {
  if (item.freezeAtSec !== null) return null;
  const w = sourceWindow(item);
  return { startSec: w.start, endSec: Math.max(w.end, w.start + 0.04) };
}

/**
 * Ramer–Douglas–Peucker over the four crop channels at once: keeps the keyframes that matter, dropping the ones a
 * straight line between their neighbours reproduces within `tol` (normalised units).
 */
export function thinCropKeys(keys: readonly CropKey[], tol = 0.004, maxKeys = 80): CropKey[] {
  if (keys.length <= 2) return keys.map((k) => ({ ...k }));
  const keep = new Array<boolean>(keys.length).fill(false);
  keep[0] = true;
  keep[keys.length - 1] = true;
  const dev = (i: number, a: number, b: number): number => {
    const ka = keys[a] as CropKey;
    const kb = keys[b] as CropKey;
    const k = keys[i] as CropKey;
    const p = kb.t === ka.t ? 0 : (k.t - ka.t) / (kb.t - ka.t);
    const d = (key: 'x' | 'y' | 'w' | 'h') =>
      Math.abs(k[key] - (ka[key] + (kb[key] - ka[key]) * p));
    return Math.max(d('x'), d('y'), d('w'), d('h'));
  };
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let wd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = dev(i, a, b);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  let out = keys.filter((_, i) => keep[i]).map((k) => ({ ...k }));
  if (out.length > maxKeys) {
    // still too many: keep an even subset (always the ends)
    const step = (out.length - 1) / (maxKeys - 1);
    out = Array.from({ length: maxKeys }, (_, i) => out[Math.round(i * step)] as CropKey);
  }
  return out;
}

export interface CropTracks {
  x: Keyframe[];
  y: Keyframe[];
  w: Keyframe[];
  h: Keyframe[];
}

/**
 * Converts the keyframes `editor:reframe` returns (t = seconds from the requested source start, crop normalised to the
 * source frame) into crop keyframes at ITEM-LOCAL times. Source → local goes through the inverse source map, so speed,
 * ramps and reverse stay correct. Keys outside the item are dropped; the result is sorted, thinned and has at least
 * one key (so the path always animates something).
 */
export function reframeToCropTracks(
  item: VideoItem,
  keys: readonly CropKey[],
  startSec: number,
  opts: { tol?: number; maxKeys?: number } = {},
): CropTracks | null {
  const local: CropKey[] = [];
  for (const k of keys) {
    const l = sourceToLocal(item, startSec + k.t);
    if (l === null) continue;
    local.push({ ...k, t: l });
  }
  if (local.length === 0) return null;
  local.sort((a, b) => a.t - b.t);
  // two keys on the same local time (a speed ramp can squash time): keep the last
  const uniq = local.filter(
    (k, i) => i === local.length - 1 || (local[i + 1] as CropKey).t - k.t > 1e-4,
  );
  const thin = thinCropKeys(uniq, opts.tol, opts.maxKeys);
  const mk = (key: 'x' | 'y' | 'w' | 'h'): Keyframe[] =>
    thin.map((k) => ({
      t: Math.round(Math.min(item.durationSec, Math.max(0, k.t)) * 1000) / 1000,
      v: Math.round(k[key] * 10000) / 10000,
      ease: 'linear' as const,
    }));
  return { x: mk('x'), y: mk('y'), w: mk('w'), h: mk('h') };
}

/* ------------------------------------------------------------------ crop presets ------------------- */

export interface Rect01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Largest rect of aspect `aspect` (w/h in PIXELS) inside a src frame, normalised, centred on (cx, cy) (0..1). */
export function aspectCropRect(
  srcW: number,
  srcH: number,
  aspect: number,
  centre: { cx: number; cy: number } = { cx: 0.5, cy: 0.5 },
): Rect01 {
  const srcAspect = srcW / srcH;
  let w = 1;
  let h = 1;
  if (aspect > srcAspect) h = srcAspect / aspect;
  else w = aspect / srcAspect;
  const x = Math.min(1 - w, Math.max(0, centre.cx - w / 2));
  const y = Math.min(1 - h, Math.max(0, centre.cy - h / 2));
  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    w: Math.round(w * 10000) / 10000,
    h: Math.round(h * 10000) / 10000,
  };
}

/* ------------------------------------------------------------------ beats -------------------------- */

/** All beats of the project on the TIMELINE (audio items whose asset has detected beats), ascending, de-duplicated. */
export function timelineBeats(project: Project): number[] {
  const byAsset = new Map(project.assets.map((a) => [a.id, a]));
  const out: number[] = [];
  for (const tr of project.tracks) {
    if (tr.muted) continue;
    for (const it of tr.items) {
      if (!isMedia(it)) continue;
      const beats = byAsset.get(it.assetId)?.beats;
      if (!beats?.length) continue;
      for (const b of beats) {
        const l = sourceToLocal(it, b);
        if (l !== null) out.push(Math.round((it.startSec + l) * 1000) / 1000);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || v - (out[i - 1] as number) > 0.01);
}

/**
 * Times to cut a clip at: the next `n` beats strictly after `after` that fall inside the clip with at least `minGap`
 * of picture on both sides of each cut.
 */
export function beatCutTimes(
  item: Pick<Item, 'startSec' | 'durationSec'>,
  beats: readonly number[],
  after: number,
  n: number,
  minGap = 0.15,
): number[] {
  const lo = Math.max(after, item.startSec) + minGap;
  const hi = item.startSec + item.durationSec - minGap;
  const out: number[] = [];
  for (const b of beats) {
    if (b < lo || b > hi) continue;
    if (out.length && b - (out[out.length - 1] as number) < minGap) continue;
    out.push(b);
    if (out.length >= n) break;
  }
  return out;
}

/* ------------------------------------------------------------------ keyframe upsert ---------------- */

/**
 * Sets the value at item-local time `t` of a keyframe list: updates the keyframe within `tol` of `t`, else inserts one
 * (new keyframes take the easing of the segment they split, else linear). Pure twin of what store.setProp does at the
 * playhead, used where several channels must change in ONE undo step (the reframe mini-map).
 */
export function upsertKeyframe(
  kf: readonly Keyframe[],
  t: number,
  v: number,
  tol = 1 / 60,
): Keyframe[] {
  const idx = kf.findIndex((k) => Math.abs(k.t - t) <= tol);
  if (idx >= 0) return kf.map((k, i) => (i === idx ? { ...k, v } : k));
  const before = [...kf].reverse().find((k) => k.t < t);
  return [...kf, { t, v, ease: before?.ease ?? 'linear' }].sort((a, b) => a.t - b.t);
}
