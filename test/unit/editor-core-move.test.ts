import { describe, expect, it } from 'vitest';
import { projectSchema, type VideoItem } from '@shared/editor';
import {
  applyMovesOp,
  planMoves,
  previewMoveOp,
  projectProblems,
  setTransitionOp,
} from '../../renderer/lib/editor/core/ops';
import {
  baseSnapPoints,
  beatTimesOnTimeline,
  snapCandidates,
  snapDelta,
  snapThreshold,
  snapTime,
} from '../../renderer/lib/editor/core/snap';
import { A, T, V, asset, item, items, proj, spans, track } from './editor-core-fixtures';

const healthy = (p: Parameters<typeof projectProblems>[0]) => expect(projectProblems(p)).toEqual([]);
const ctx = (o: Partial<{ enabled: boolean; playhead: number; pxPerSec: number; fps: number }> = {}) => ({
  enabled: true,
  playhead: 0,
  pxPerSec: 100,
  fps: 30,
  ...o,
});

describe('previewMove — basics', () => {
  const p = proj([
    track('v1', 'video', [V('a', 0, 5), V('b', 10, 5)]),
    track('v2', 'overlay', [V('c', 2, 3)]),
    track('t', 'text', [T('tx', 6, 2)]),
  ]);

  it('moves by delta without snapping', () => {
    const r = previewMoveOp(p, ['a'], 2, null, ctx({ enabled: false }));
    expect(r.valid).toBe(true);
    expect(r.moves).toEqual([{ itemId: 'a', trackId: 'v1', startSec: 2 }]);
    expect(r.snappedTo).toBeNull();
    expect(r.snapKind).toBeNull();
  });

  it('does not mutate the project', () => {
    const before = JSON.stringify(p);
    previewMoveOp(p, ['a'], 3, 'v2', ctx());
    expect(JSON.stringify(p)).toBe(before);
  });

  it('clamps at 0', () => {
    const r = previewMoveOp(p, ['b'], -50, null, ctx({ enabled: false }));
    expect(r.moves[0]?.startSec).toBe(0 + 0);
    expect(r.valid).toBe(false); // lands on a
  });

  it('flags an overlap with a neighbour as invalid', () => {
    expect(previewMoveOp(p, ['a'], 7, null, ctx({ enabled: false })).valid).toBe(false);
    expect(previewMoveOp(p, ['a'], 5, null, ctx({ enabled: false })).valid).toBe(true); // adjacent
  });

  it('retargets to another compatible track', () => {
    const r = previewMoveOp(p, ['a'], 0, 'v2', ctx({ enabled: false }));
    expect(r.moves[0]?.trackId).toBe('v2');
    expect(r.valid).toBe(false); // collides with c at 2..5
    const ok = previewMoveOp(p, ['a'], 5, 'v2', ctx({ enabled: false }));
    expect(ok.valid).toBe(true);
  });

  it('rejects a track of the wrong kind or locked', () => {
    expect(previewMoveOp(p, ['a'], 0, 't', ctx({ enabled: false })).valid).toBe(false);
    const locked = proj([track('v1', 'video', [V('a', 0, 5)]), track('v2', 'overlay', [], { locked: true })]);
    expect(previewMoveOp(locked, ['a'], 0, 'v2', ctx({ enabled: false })).valid).toBe(false);
    expect(previewMoveOp(p, ['a'], 0, 'nope', ctx({ enabled: false })).valid).toBe(false);
  });

  it('is invalid when the item or its track is locked', () => {
    const l = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(previewMoveOp(l, ['a'], 3, null, ctx()).valid).toBe(false);
    const li = proj([track('v1', 'video', [V('a', 0, 5, { locked: true })])]);
    expect(previewMoveOp(li, ['a'], 3, null, ctx()).valid).toBe(false);
  });

  it('unknown ids give an empty invalid preview', () => {
    expect(previewMoveOp(p, ['zzz'], 1, null, ctx())).toEqual({ moves: [], snappedTo: null, snapKind: null, valid: false });
  });
});

describe('previewMove — snapping', () => {
  const p = projectSchema.parse({
    canvas: { fps: 30 },
    tracks: [
      track('v1', 'video', [V('a', 0, 5), V('b', 20, 5)]),
      track('v2', 'overlay', [V('c', 40, 3)]),
    ],
    assets: [],
    markers: [{ id: 'm1', atSec: 30, label: 'x' }],
  });

  it('snaps the start edge to another item\'s end within 8 px', () => {
    const r = previewMoveOp(p, ['b'], -14.95, null, ctx({ pxPerSec: 100 })); // start would be 5.05 → 0.05 s = 5 px from 5
    expect(r.snappedTo).toBe(5);
    expect(r.snapKind).toBe('item');
    expect(r.moves[0]?.startSec).toBeCloseTo(5);
    expect(r.valid).toBe(true);
  });

  it('does not snap beyond the threshold (8 px / pxPerSec)', () => {
    expect(snapThreshold(100)).toBeCloseTo(0.08);
    const r = previewMoveOp(p, ['b'], -14.88, null, ctx({ pxPerSec: 100, fps: 1 }));
    expect(r.snappedTo).toBeNull();
    expect(r.moves[0]?.startSec).toBeCloseTo(5.12);
  });

  it('threshold scales with zoom: 8 px is wider in time when zoomed out', () => {
    const r = previewMoveOp(p, ['b'], -14.5, null, ctx({ pxPerSec: 10, fps: 1 }));
    expect(r.snappedTo).toBe(5);
  });

  it('snaps the END edge of the moving item too', () => {
    // b is 5 long; end 24.97 + ... move so that end lands near c.start=40
    const r = previewMoveOp(p, ['b'], 14.96, null, ctx({ pxPerSec: 100 })); // end = 39.96
    expect(r.snappedTo).toBe(40);
    expect(r.moves[0]?.startSec).toBeCloseTo(35);
  });

  it('snaps to the playhead', () => {
    const r = previewMoveOp(p, ['b'], 3.04, null, ctx({ playhead: 28 })); // start 23.04 … end 28.04
    expect(r.snappedTo).toBe(28);
    expect(r.snapKind).toBe('playhead');
  });

  it('snaps to markers', () => {
    const r = previewMoveOp(p, ['b'], 9.97, null, ctx({ pxPerSec: 100 })); // start 29.97 → 30
    expect(r.snappedTo).toBe(30);
    expect(r.snapKind).toBe('marker');
  });

  it('snaps to the project start', () => {
    const q = proj([track('v1', 'video', [V('a', 3, 2)])]);
    const r = previewMoveOp(q, ['a'], -2.96, null, ctx({ playhead: 50 }));
    expect(r.snappedTo).toBe(0);
    expect(r.snapKind).toBe('start');
    expect(r.moves[0]?.startSec).toBe(0);
  });

  it('snapping can be switched off per call', () => {
    const r = previewMoveOp(p, ['b'], -14.95, null, ctx({ enabled: false }));
    expect(r.snappedTo).toBeNull();
  });

  it('ignores the moving item\'s own edges', () => {
    const r = previewMoveOp(p, ['b'], 0.03, null, ctx({ pxPerSec: 100 }));
    expect(r.snappedTo).not.toBe(20);
  });

  it('snaps to the 1-frame grid only when zoomed in far enough', () => {
    const q = proj([track('v1', 'video', [V('a', 0.5, 2)])]);
    const fine = previewMoveOp(q, ['a'], 10.1, null, ctx({ pxPerSec: 600, fps: 30 })); // frame = 20 px
    expect(fine.snapKind).toBe('grid');
    expect(Math.round((fine.moves[0]?.startSec as number) * 30)).toBeCloseTo((fine.moves[0]?.startSec as number) * 30, 6);
    const coarse = previewMoveOp(q, ['a'], 10.1, null, ctx({ pxPerSec: 20, fps: 30 })); // frame < 1 px
    expect(coarse.snapKind).toBeNull();
  });

  it('beat times of audio assets snap through inSec and speed', () => {
    const music = asset('aa', 'audio', 100, { beats: [10, 12, 14, 16] });
    const q = proj(
      [track('m', 'audio', [A('m1', 100, 30, { inSec: 8 })]), track('v1', 'video', [V('v', 0, 3)])],
      { assets: [music, asset('av', 'video', 60)] },
    );
    // beat 10 → 100 + (10-8) = 102; beat 14 → 106
    const pts = baseSnapPoints(q).filter((s) => s.kind === 'beat').map((s) => s.t);
    expect(pts).toEqual([102, 104, 106, 108]);
    const r = previewMoveOp(q, ['v'], 101.97, null, ctx({ pxPerSec: 100 }));
    expect(r.snappedTo).toBe(102);
    expect(r.snapKind).toBe('beat');
  });

  it('beats follow speed 2 and reverse', () => {
    const base = A('m', 10, 10, { inSec: 0, speed: 2 });
    expect(beatTimesOnTimeline(base, [2, 4, 25])).toEqual([11, 12]);
    const rev = A('m', 10, 10, { inSec: 0, speed: 2, reverse: true }); // window [0,20] played backwards
    expect(beatTimesOnTimeline(rev, [2, 18])).toEqual([19, 11]);
  });

  it('beats follow a speed ramp', () => {
    const ramp = A('m', 0, 10, { speedCurve: [{ t: 0, v: 1, ease: 'linear' }, { t: 10, v: 1, ease: 'linear' }] });
    expect(beatTimesOnTimeline(ramp, [3])[0]).toBeCloseTo(3, 2);
  });

  it('snapCandidates lists edges, playhead, markers and 0, minus excluded items', () => {
    const c = snapCandidates(p, 7.5, { exclude: new Set(['b']) });
    const ts = c.map((x) => x.t);
    expect(ts).toContain(7.5);
    expect(ts).toContain(30);
    expect(ts).toContain(0);
    expect(ts).toContain(5);
    expect(ts).not.toContain(25);
    expect(ts).toContain(43);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  });

  it('snapTime/snapDelta helpers', () => {
    expect(snapTime(p, 4.95, { playhead: null, pxPerSec: 100, fps: 30 })).toEqual({ t: 5, kind: 'item' });
    expect(snapTime(p, 100, { playhead: null, pxPerSec: 20, fps: 30 })).toBeNull();
    const d = snapDelta(p, [20, 25], -14.97, { playhead: null, pxPerSec: 100, fps: 30, exclude: new Set(['b']) });
    expect(d.to).toBe(5);
    expect(d.delta).toBeCloseTo(-15);
  });
});

describe('groups move together', () => {
  const p = proj([
    track('v1', 'video', [V('a', 0, 4, { groupId: 'g' })]),
    track('v2', 'overlay', [V('b', 1, 2, { groupId: 'g' }), V('c', 10, 2)]),
  ]);

  it('previewMove expands the group', () => {
    const r = previewMoveOp(p, ['a'], 3, null, ctx({ enabled: false }));
    expect(r.moves.map((m) => [m.itemId, m.startSec]).sort()).toEqual([['a', 3], ['b', 4]]);
    expect(r.valid).toBe(true);
  });

  it('applyMoves completes a partial group with the same shift', () => {
    const r = applyMovesOp(p, [{ itemId: 'a', trackId: 'v1', startSec: 2 }]);
    expect(item(r, 'a').startSec).toBe(2);
    expect(item(r, 'b').startSec).toBe(3);
    healthy(r);
  });

  it('a locked group member blocks the whole move', () => {
    const q = proj([
      track('v1', 'video', [V('a', 0, 4, { groupId: 'g' })]),
      track('v2', 'overlay', [V('b', 1, 2, { groupId: 'g' })], { locked: true }),
    ]);
    expect(previewMoveOp(q, ['a'], 3, null, ctx()).valid).toBe(false);
    expect(applyMovesOp(q, [{ itemId: 'a', trackId: 'v1', startSec: 3 }])).toBe(q);
  });

  it('the group is clamped at 0 together', () => {
    const r = previewMoveOp(p, ['b'], -5, null, ctx({ enabled: false }));
    const m = Object.fromEntries(r.moves.map((x) => [x.itemId, x.startSec]));
    expect(m.a).toBe(0);
    expect(m.b).toBe(1);
  });
});

describe('applyMoves', () => {
  it('applies a valid move and keeps the track sorted', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2), V('b', 3, 2), V('c', 6, 2)])]);
    const r = applyMovesOp(p, [{ itemId: 'a', trackId: 'v1', startSec: 8 }]);
    expect(items(r, 'v1').map((i) => i.id)).toEqual(['b', 'c', 'a']);
    healthy(r);
  });

  it('refuses an overlapping move (returns the same project)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4), V('b', 6, 4)])]);
    expect(applyMovesOp(p, [{ itemId: 'a', trackId: 'v1', startSec: 4 }])).toBe(p);
  });

  it('moves between tracks', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4)]), track('v2', 'overlay', [])]);
    const r = applyMovesOp(p, [{ itemId: 'a', trackId: 'v2', startSec: 1 }]);
    expect(items(r, 'v1')).toEqual([]);
    expect(spans(r, 'v2')).toEqual([[1, 5]]);
  });

  it('refuses incompatible and locked destinations', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4)]), track('a1', 'audio', []), track('x', 'overlay', [], { locked: true })]);
    expect(applyMovesOp(p, [{ itemId: 'a', trackId: 'x', startSec: 0 }])).toBe(p);
    const q = proj([track('v1', 'video', [V('a', 0, 4)]), track('t', 'text', [])]);
    expect(applyMovesOp(q, [{ itemId: 'a', trackId: 't', startSec: 0 }])).toBe(q);
  });

  it('a video can go onto an audio track (audio kind accepts video)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4)]), track('a1', 'audio', [])]);
    expect(applyMovesOp(p, [{ itemId: 'a', trackId: 'a1', startSec: 0 }])).not.toBe(p);
  });

  it('a no-change move returns a project with identical content', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4)])]);
    const r = applyMovesOp(p, [{ itemId: 'a', trackId: 'v1', startSec: 0 }]);
    expect(r.tracks[0]?.items).toEqual(p.tracks[0]?.items);
  });

  it('insert mode pushes existing items right instead of refusing', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4), V('b', 6, 3), V('c', 9, 3)]), track('v2', 'overlay', [V('x', 0, 2)])]);
    const r = applyMovesOp(p, [{ itemId: 'x', trackId: 'v1', startSec: 5 }], { insert: true });
    expect(spans(r, 'v1')).toEqual([[0, 4], [5, 7], [7, 10], [10, 13]]);
    healthy(r);
  });

  it('insert mode cannot split a straddling item (refused)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)]), track('v2', 'overlay', [V('x', 0, 2)])]);
    expect(applyMovesOp(p, [{ itemId: 'x', trackId: 'v1', startSec: 5 }], { insert: true })).toBe(p);
  });

  it('moving a transition pair together keeps the transition', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 3 }), V('c', 20, 2)])]);
    const withX = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, false);
    const g = projectSchema.parse({
      ...withX,
      tracks: [{ ...withX.tracks[0], items: items(withX, 'v1').map((i) => (i.id === 'c' ? i : { ...i, groupId: 'g' })) }],
    });
    const r = applyMovesOp(g, [{ itemId: 'a', trackId: 'v1', startSec: 10 }]);
    healthy(r);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1);
    expect(item(r, 'b').startSec).toBeCloseTo(14);
  });

  it('moving the later item of a pair away drops its transition', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 3 })])]);
    const withX = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, false);
    const r = applyMovesOp(withX, [{ itemId: 'b', trackId: 'v1', startSec: 12 }]);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('moving the earlier item away drops the later one\'s transition', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 3 })])]);
    const withX = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, false);
    const r = applyMovesOp(withX, [{ itemId: 'a', trackId: 'v1', startSec: 30 }]);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('dragging an item into a transition overlap is refused', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 3 }), V('c', 20, 4)])]);
    expect(applyMovesOp(base, [{ itemId: 'c', trackId: 'v1', startSec: 4 }])).toBe(base);
  });

  it('planMoves reports ok=false for unknown items', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2)])]);
    expect(planMoves(p, [{ itemId: 'nope', trackId: 'v1', startSec: 0 }]).ok).toBe(false);
    expect(planMoves(p, []).ok).toBe(false);
  });

  it('multi-select moves keep relative offsets', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2), V('b', 3, 2), V('c', 10, 2)])]);
    const pv = previewMoveOp(p, ['a', 'b'], 4, null, ctx({ enabled: false }));
    expect(pv.valid).toBe(true);
    const r = applyMovesOp(p, pv.moves);
    expect(spans(r, 'v1')).toEqual([[4, 6], [7, 9], [10, 12]]);
  });

  it('moving a block over its own old position is allowed', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 4), V('b', 4, 4)])]);
    const r = applyMovesOp(p, [
      { itemId: 'a', trackId: 'v1', startSec: 2 },
      { itemId: 'b', trackId: 'v1', startSec: 6 },
    ]);
    expect(spans(r, 'v1')).toEqual([[2, 6], [6, 10]]);
  });
});
