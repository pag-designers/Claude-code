/** Track operations (pure). */
import { trackSchema, type Project, type Track, type TrackKind } from '@shared/editor';
import { defaultTrackIndex, makeTrack, nextTrackName } from '../helpers';
import { clamp, trackIndexOf } from './common';

export function addTrackOp(
  p: Project,
  kind: TrackKind,
  opts: { index?: number; name?: string; id?: string; speech?: boolean } = {},
): { project: Project; trackId: string } {
  const track = makeTrack(kind, opts.name ?? nextTrackName(p.tracks, kind), {
    id: opts.id,
    speech: opts.speech,
  });
  const index =
    opts.index === undefined
      ? defaultTrackIndex(p.tracks, kind)
      : clamp(Math.round(opts.index), 0, p.tracks.length);
  const tracks = p.tracks.slice();
  tracks.splice(index, 0, track);
  return { project: { ...p, tracks }, trackId: track.id };
}

/** Removes a track and its items. A locked track (or one holding locked items) is refused. */
export function removeTrackOp(p: Project, trackId: string): Project {
  const ti = trackIndexOf(p, trackId);
  if (ti < 0) return p;
  const tr = p.tracks[ti] as Track;
  if (tr.locked || tr.items.some((i) => i.locked)) return p;
  const removed = new Set(tr.items.map((i) => i.id));
  const tracks = p.tracks.filter((_, k) => k !== ti);
  const out: Project = { ...p, tracks };
  return removed.size ? cleanSingletonGroups(out) : out;
}

export function moveTrackOp(p: Project, trackId: string, toIndex: number): Project {
  const ti = trackIndexOf(p, trackId);
  if (ti < 0) return p;
  const to = clamp(Math.round(toIndex), 0, p.tracks.length - 1);
  if (to === ti) return p;
  const tracks = p.tracks.slice();
  const [tr] = tracks.splice(ti, 1);
  tracks.splice(to, 0, tr as Track);
  return { ...p, tracks };
}

export type TrackPatch = Partial<
  Pick<Track, 'name' | 'locked' | 'muted' | 'hidden' | 'gain' | 'speech' | 'ducking'>
>;

export function updateTrackOp(p: Project, trackId: string, patch: TrackPatch): Project {
  const ti = trackIndexOf(p, trackId);
  if (ti < 0) return p;
  const tr = p.tracks[ti] as Track;
  const next: Track = {
    ...tr,
    ...patch,
    ducking: patch.ducking ? { ...tr.ducking, ...patch.ducking } : tr.ducking,
  };
  const keys = Object.keys(patch) as (keyof TrackPatch)[];
  if (keys.every((k) => Object.is(next[k], tr[k]) || (k === 'ducking' && sameDucking(next.ducking, tr.ducking))))
    return p;
  if (!trackSchema.safeParse(next).success) return p;
  const tracks = p.tracks.slice();
  tracks[ti] = next;
  return { ...p, tracks };
}

function sameDucking(a: Track['ducking'], b: Track['ducking']): boolean {
  return (
    a.enabled === b.enabled &&
    a.reductionDb === b.reductionDb &&
    a.attackSec === b.attackSec &&
    a.releaseSec === b.releaseSec
  );
}

/** A group with a single remaining member is not a group: clear its id. */
export function cleanSingletonGroups(p: Project): Project {
  const counts = new Map<string, number>();
  for (const tr of p.tracks)
    for (const it of tr.items) if (it.groupId) counts.set(it.groupId, (counts.get(it.groupId) ?? 0) + 1);
  let single = false;
  for (const n of counts.values()) if (n < 2) single = true;
  if (!single) return p;
  const tracks = p.tracks.map((tr) => {
    if (!tr.items.some((it) => it.groupId && (counts.get(it.groupId) ?? 0) < 2)) return tr;
    return {
      ...tr,
      items: tr.items.map((it) =>
        it.groupId && (counts.get(it.groupId) ?? 0) < 2 ? { ...it, groupId: null } : it,
      ),
    };
  });
  return { ...p, tracks };
}
