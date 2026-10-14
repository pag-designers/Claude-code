import type { Asset, AudioItem, Item, VideoItem } from '@shared/editor';
import { makeSourceTime, speedAt } from '@shared/editor-eval';

type MediaItem = VideoItem | AudioItem;

export const isMediaItem = (i: Item): i is MediaItem => i.type === 'video' || i.type === 'audio';

const cache = new WeakMap<object, (tl: number) => number>();

/** Memoised `makeSourceTime(item)` (the speed-ramp integral table is built once per item object). */
export function sourceTimeFn(item: MediaItem): (tl: number) => number {
  let f = cache.get(item);
  if (!f) {
    f = makeSourceTime(item);
    cache.set(item, f);
  }
  return f;
}

/** Source time at TIMELINE time t, clamped to the asset (hold the first/last frame). */
export function sourceAt(item: MediaItem, asset: Pick<Asset, 'durationSec'> | undefined, t: number): number {
  const s = sourceTimeFn(item)(t - item.startSec);
  return clampToAsset(s, asset?.durationSec ?? null);
}

export function clampToAsset(srcSec: number, durationSec: number | null): number {
  const hi = durationSec !== null && durationSec > 0 ? Math.max(0, durationSec - 1e-3) : Infinity;
  return Math.min(hi, Math.max(0, srcSec));
}

/**
 * d(source time)/d(wall time) at timeline time t for a transport rate: positive = source advances, negative = it
 * runs backwards, 0 = a still (freeze). Combines speed (ramps included), reverse and the J/K/L rate.
 */
export function sourceRateAt(item: MediaItem, t: number, transportRate: number): number {
  if (item.freezeAtSec !== null) return 0;
  const s = speedAt(item, Math.max(0, t - item.startSec)) * transportRate;
  return item.reverse ? -s : s;
}
