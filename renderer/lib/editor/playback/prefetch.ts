import type { Project } from '@shared/editor';
import { isActive } from '@shared/editor-eval';
import { clampToAsset, sourceTimeFn } from './src-time';

export interface UpcomingFrame {
  assetId: string;
  /** Source time of the item's first frame (forward) / last frame (reverse transport). */
  srcSec: number;
  itemId: string;
}

/**
 * Video items that become visible within `horizonSec` of wall time (forward transport: their start; reverse: their end).
 * The pool pre-seeks a spare decoder to their first frame so a hard cut shows the right picture on the very first frame.
 */
export function upcomingVideoFrames(
  project: Pick<Project, 'tracks' | 'assets'>,
  t: number,
  transportRate: number,
  horizonSec: number,
  visibleItemIds: ReadonlySet<string>,
  limit = 4,
): UpcomingFrame[] {
  const reach = horizonSec * Math.max(1, Math.abs(transportRate));
  const dur = new Map(project.assets.map((a) => [a.id, a.durationSec] as const));
  const out: { f: UpcomingFrame; dist: number }[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const it of track.items) {
      if (it.type !== 'video' || visibleItemIds.has(it.id) || isActive(it, t)) continue;
      const forward = transportRate >= 0;
      const dist = forward ? it.startSec - t : t - (it.startSec + it.durationSec);
      if (dist <= 0 || dist > reach) continue;
      const tl = forward ? 0 : it.durationSec;
      const src = clampToAsset(sourceTimeFn(it)(tl), dur.get(it.assetId) ?? null);
      out.push({ f: { assetId: it.assetId, srcSec: src, itemId: it.id }, dist });
    }
  }
  return out
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((o) => o.f);
}
