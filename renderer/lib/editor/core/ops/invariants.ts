import { TRACK_ACCEPTS, type Item, type Project, type Track } from '@shared/editor';
import { ANIMATED_PATHS, getAnimated } from './animate';
import { MIN_DUR, isMedia, layoutProblem } from './common';

/** All keyframe arrays of an item (animated numbers + speedCurve), named for messages. */
function keyframeLists(it: Item): [string, readonly { t: number }[]][] {
  const out: [string, readonly { t: number }[]][] = [];
  for (const path of ANIMATED_PATHS) {
    const a = getAnimated(it, path);
    if (a) out.push([path, a.kf]);
  }
  if (isMedia(it)) out.push(['speedCurve', it.speedCurve]);
  return out;
}

/**
 * Every structural invariant of a project as a list of human-readable violations (empty = healthy):
 * layout (sorted, no overlap except transitions), durations, keyframe order, subtitle word order, unique ids,
 * item types accepted by their track. Used by the fuzz tests; handy in dev tooling.
 */
export function projectProblems(p: Project): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const trackIds = new Set<string>();
  for (const tr of p.tracks as readonly Track[]) {
    if (trackIds.has(tr.id)) out.push(`duplicate track id ${tr.id}`);
    trackIds.add(tr.id);
    const lp = layoutProblem(tr.items);
    if (lp) out.push(`track ${tr.name}: ${lp}`);
    for (const it of tr.items) {
      if (ids.has(it.id)) out.push(`duplicate item id ${it.id}`);
      ids.add(it.id);
      if (!Number.isFinite(it.startSec) || it.startSec < -1e-9)
        out.push(`${it.id} start ${it.startSec}`);
      if (!Number.isFinite(it.durationSec) || it.durationSec < MIN_DUR - 1e-9)
        out.push(`${it.id} duration ${it.durationSec}`);
      if (!TRACK_ACCEPTS[tr.kind].includes(it.type))
        out.push(`${it.id} (${it.type}) not accepted by ${tr.kind}`);
      for (const [name, kf] of keyframeLists(it)) {
        for (let k = 0; k < kf.length; k++) {
          const cur = kf[k] as { t: number };
          if (cur.t < -1e-9 || !Number.isFinite(cur.t))
            out.push(`${it.id}.${name} kf time ${cur.t}`);
          if (k > 0 && cur.t < (kf[k - 1] as { t: number }).t - 1e-9)
            out.push(`${it.id}.${name} keyframes unsorted`);
        }
      }
      if (it.type === 'subtitle') {
        let last = -Infinity;
        for (const w of it.words) {
          if (w.s < -1e-9 || w.e < w.s - 1e-9) out.push(`${it.id} bad word ${w.w} ${w.s}-${w.e}`);
          if (w.s < last - 1e-6) out.push(`${it.id} words overlap/unsorted at ${w.w}`);
          last = Math.max(last, w.e);
        }
      }
    }
  }
  return out;
}
