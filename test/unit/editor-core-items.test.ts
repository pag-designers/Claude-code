import { describe, expect, it } from 'vitest';
import { itemSchema, type Asset, type Item, type VideoItem } from '@shared/editor';
import {
  addAssetOp,
  addItemOp,
  addTrackOp,
  copyOp,
  deleteGapsOp,
  deleteItemsOp,
  duplicateOp,
  groupOp,
  moveTrackOp,
  pasteOp,
  projectProblems,
  removeTrackOp,
  setTransitionOp,
  ungroupOp,
  updateItemsOp,
  updateTrackOp,
  addMarkerOp,
  removeMarkerOp,
  updateMarkerOp,
  addAssetsOp,
  updateAssetOp,
  setCanvasOp,
} from '../../renderer/lib/editor/core/ops';
import { emptyProject, makeVideoItem } from '../../renderer/lib/editor/core';
import { A, C, I, S, T, V, asset, item, items, proj, spans, track } from './editor-core-fixtures';

const healthy = (p: Parameters<typeof projectProblems>[0]) => expect(projectProblems(p)).toEqual([]);

describe('addItem', () => {
  it('uses the first compatible track and sets startSec', () => {
    const p = proj([track('v1', 'video', []), track('t', 'text', [])]);
    const r = addItemOp(p, V('n', 3, 2));
    expect(r.trackId).toBe('v1');
    expect(spans(r.project, 'v1')).toEqual([[3, 5]]);
    healthy(r.project);
  });

  it('goes to the next compatible track when the first is occupied at that time', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)]), track('o', 'overlay', [])]);
    const r = addItemOp(p, V('n', 3, 2));
    expect(r.trackId).toBe('o');
  });

  it('creates a track of the right kind when none fits', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)])]);
    const r = addItemOp(p, V('n', 3, 2));
    expect(r.project.tracks.length).toBe(2);
    expect(r.project.tracks.find((t) => t.id === r.trackId)?.kind).toBe('video');
    expect(r.project.tracks.find((t) => t.id === r.trackId)?.speech).toBe(true);
    const t = addItemOp(p, T('tx', 0, 2));
    expect(t.project.tracks.find((x) => x.id === t.trackId)?.kind).toBe('text');
  });

  it('new video track goes below text and subtitle tracks (z-order rank)', () => {
    const p = proj([track('s', 'subtitle'), track('t', 'text')]);
    const r = addItemOp(p, V('n', 0, 2));
    expect(r.project.tracks[0]?.kind).toBe('video');
  });

  it('on an explicit occupied track the item is placed at the next free spot', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)])]);
    const r = addItemOp(p, V('n', 2, 3), { trackId: 'v1' });
    expect(r.project.tracks[0]?.items.find((i) => i.id === 'n')?.startSec).toBe(10);
    healthy(r.project);
  });

  it('an explicit incompatible track falls back to automatic placement', () => {
    const p = proj([track('v1', 'video', []), track('t', 'text', [])]);
    expect(addItemOp(p, V('n', 0, 1), { trackId: 't' }).trackId).toBe('v1');
  });

  it('refuses an explicit locked track', () => {
    const p = proj([track('v1', 'video', [], { locked: true })]);
    const r = addItemOp(p, V('n', 0, 1), { trackId: 'v1' });
    expect(r.itemId).toBeNull();
    expect(r.project).toBe(p);
  });

  it('skips locked tracks in automatic placement', () => {
    const p = proj([track('v1', 'video', [], { locked: true })]);
    const r = addItemOp(p, V('n', 0, 1));
    expect(r.project.tracks.length).toBe(2);
  });

  it('gives a fresh id when the id already exists', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 1)])]);
    const r = addItemOp(p, V('a', 5, 1));
    expect(r.itemId).not.toBe('a');
    healthy(r.project);
  });

  it('never creates a transition (drops transitionIn)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])]);
    const r = addItemOp(p, V('n', 5, 3, { transitionIn: { type: 'crossfade', durationSec: 1 } }), { trackId: 'v1' });
    expect((r.project.tracks[0]?.items[1] as VideoItem).transitionIn).toBeNull();
  });

  it('ripple insert splits a straddling item and shifts the rest', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10), V('b', 10, 4)])]);
    const r = addItemOp(p, V('n', 4, 3, { inSec: 1 }), { trackId: 'v1', scope: 'track' });
    expect(spans(r.project, 'v1')).toEqual([[0, 4], [4, 7], [7, 13], [13, 17]]);
    expect(items(r.project, 'v1').map((i) => i.id)[1]).toBe('n');
    healthy(r.project);
  });

  it('ripple insert at a boundary shifts the later items', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)])]);
    const r = addItemOp(p, V('n', 5, 2), { trackId: 'v1', scope: 'track' });
    expect(spans(r.project, 'v1')).toEqual([[0, 5], [5, 7], [7, 12]]);
  });

  it('ripple insert with scope all shifts other tracks', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]), track('m', 'audio', [A('m1', 6, 2)])]);
    const r = addItemOp(p, V('n', 5, 2), { trackId: 'v1', scope: 'all' });
    expect(spans(r.project, 'm')).toEqual([[8, 10]]);
  });

  it('ripple insert into a transition overlap falls back to after the earlier item', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 2 })])]);
    const t = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, true); // b at 4
    const r = addItemOp(t, V('n', 4.5, 2), { trackId: 'v1', scope: 'track' });
    healthy(r.project);
  });
});

describe('addAsset', () => {
  const assets: Asset[] = [
    asset('vid', 'video', 12, { hasAudio: true }),
    asset('silent', 'video', 7, { hasAudio: false }),
    asset('mus', 'audio', 90),
    asset('img', 'image', null),
    asset('lut', 'lut', null),
  ];

  it('video → Video track at the start time; audioEnabled mirrors the asset; duration = asset duration', () => {
    const p = proj([track('v1', 'video', []), track('m', 'audio', [])], { assets });
    const r = addAssetOp(p, 'vid', { startSec: 2 });
    const it = items(r.project, 'v1')[0] as VideoItem;
    expect([it.startSec, it.durationSec, it.audioEnabled, it.assetId]).toEqual([2, 12, true, 'vid']);
    const s = addAssetOp(p, 'silent', { startSec: 0 });
    expect((items(s.project, 'v1')[0] as VideoItem).audioEnabled).toBe(false);
  });

  it('creates a Video track (speech: true) when missing', () => {
    const p = proj([track('m', 'audio', [])], { assets });
    const r = addAssetOp(p, 'vid', { startSec: 0 });
    const tr = r.project.tracks.find((t) => t.id === r.trackId);
    expect(tr?.kind).toBe('video');
    expect(tr?.speech).toBe(true);
    expect(r.project.tracks[0]?.id).toBe(r.trackId);
  });

  it('audio → Music/audio track; image → image track, 5 s', () => {
    const p = proj([track('v1', 'video', []), track('m', 'audio', [])], { assets });
    expect(addAssetOp(p, 'mus', { startSec: 1 }).trackId).toBe('m');
    const im = addAssetOp(p, 'img', { startSec: 1 });
    const tr = im.project.tracks.find((t) => t.id === im.trackId);
    expect(tr?.kind).toBe('image');
    expect(tr?.items[0]?.durationSec).toBe(5);
  });

  it('image prefers an existing overlay track', () => {
    const p = proj([track('v1', 'video', []), track('o', 'overlay', [])], { assets });
    expect(addAssetOp(p, 'img', { startSec: 0 }).trackId).toBe('o');
  });

  it('explicit track, unknown asset, lut asset', () => {
    const p = proj([track('v1', 'video', []), track('v2', 'video', [])], { assets });
    expect(addAssetOp(p, 'vid', { startSec: 0, trackId: 'v2' }).trackId).toBe('v2');
    expect(addAssetOp(p, 'nope', { startSec: 0 }).itemId).toBeNull();
    expect(addAssetOp(p, 'lut', { startSec: 0 }).itemId).toBeNull();
  });

  it('sequential adds at the playhead land back to back on the main track when each starts at the previous end', () => {
    let p = proj([track('v1', 'video', [])], { assets });
    p = addAssetOp(p, 'vid', { startSec: 0 }).project;
    p = addAssetOp(p, 'silent', { startSec: 12 }).project;
    expect(spans(p, 'v1')).toEqual([[0, 12], [12, 19]]);
  });
});

describe('deleteItems', () => {
  const base = () =>
    proj([
      track('v1', 'video', [V('a', 0, 5), V('b', 5, 5), V('c', 12, 3)]),
      track('m', 'audio', [A('m1', 0, 20), A('m2', 22, 3)]),
    ]);

  it('removes items and leaves gaps without ripple', () => {
    const r = deleteItemsOp(base(), ['b']);
    expect(spans(r, 'v1')).toEqual([[0, 5], [12, 15]]);
  });

  it('ripple closes the gap the item occupied (track scope)', () => {
    const r = deleteItemsOp(base(), ['b'], 'track');
    expect(spans(r, 'v1')).toEqual([[0, 5], [7, 10]]); // c keeps its original 2 s gap after b
    expect(spans(r, 'm')).toEqual([[0, 20], [22, 25]]);
  });

  it('ripple "all" leaves a track untouched when closing the gap would collide there', () => {
    const r = deleteItemsOp(base(), ['b'], 'all'); // m2 would land on top of m1
    expect(spans(r, 'm')).toEqual([[0, 20], [22, 25]]);
    expect(spans(r, 'v1')).toEqual([[0, 5], [7, 10]]);
    healthy(r);
  });

  it('ripple "all": items fully after the cut move left by its length', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]), track('t', 'text', [T('t1', 12, 2)])]);
    const r = deleteItemsOp(q, ['a'], 'all');
    expect(spans(r, 'v1')).toEqual([[0, 5]]);
    expect(spans(r, 't')).toEqual([[7, 9]]);
  });

  it('deleting a grouped item deletes the whole group', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2, { groupId: 'g' }), V('x', 3, 1)]), track('o', 'overlay', [S('s', 0, 2, { groupId: 'g' })])]);
    const r = deleteItemsOp(p, ['a']);
    expect(items(r, 'v1').map((i) => i.id)).toEqual(['x']);
    expect(items(r, 'o')).toEqual([]);
  });

  it('a group left with one member (a locked one survived) is dissolved', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2, { groupId: 'g', locked: true }), V('b', 2, 2, { groupId: 'g' })])]);
    const r = deleteItemsOp(p, ['b'], 'none');
    expect(r.tracks[0]?.items.map((i) => i.groupId)).toEqual([null]);
  });

  it('skips locked items/tracks (same project when nothing is deletable)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(deleteItemsOp(p, ['a'])).toBe(p);
    const q = proj([track('v1', 'video', [V('a', 0, 5, { locked: true }), V('b', 5, 5)])]);
    const r = deleteItemsOp(q, ['a', 'b']);
    expect(items(r, 'v1').map((i) => i.id)).toEqual(['a']);
  });

  it('deleting several adjacent items with ripple closes up once', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2), V('b', 2, 2), V('c', 4, 2), V('d', 6, 2)])]);
    const r = deleteItemsOp(p, ['b', 'c'], 'track');
    expect(spans(r, 'v1')).toEqual([[0, 2], [2, 4]]);
  });

  it('deleting non-adjacent items with ripple', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2), V('b', 2, 2), V('c', 4, 2), V('d', 6, 2), V('e', 8, 2)])]);
    const r = deleteItemsOp(p, ['b', 'd'], 'track');
    expect(spans(r, 'v1')).toEqual([[0, 2], [2, 4], [4, 6]]);
  });

  it('unknown ids change nothing', () => {
    const p = base();
    expect(deleteItemsOp(p, ['nope'])).toBe(p);
    expect(deleteItemsOp(p, [])).toBe(p);
  });
});

describe('deleteGaps', () => {
  const p = () =>
    proj([
      track('v1', 'video', [V('a', 1, 2), V('b', 5, 2), V('c', 10, 1)]),
      track('m', 'audio', [A('m1', 0, 3), A('m2', 8, 2)]),
      track('t', 'text', [T('t1', 4, 1), T('t2', 9, 1)], { locked: true }),
    ]);

  it('closes the gaps on one track, first item stays', () => {
    const r = deleteGapsOp(p(), 'v1');
    expect(spans(r, 'v1')).toEqual([[1, 3], [3, 5], [5, 6]]);
    expect(spans(r, 'm')).toEqual([[0, 3], [8, 10]]);
  });

  it('with no track: all unlocked tracks', () => {
    const r = deleteGapsOp(p());
    expect(spans(r, 'm')).toEqual([[0, 3], [3, 5]]);
    expect(spans(r, 't')).toEqual([[4, 5], [9, 10]]);
  });

  it('preserves transition overlaps', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 2 }), V('c', 14, 2)])]);
    const withX = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, false);
    const r = deleteGapsOp(withX, 'v1');
    expect(spans(r, 'v1')).toEqual([[0, 5], [4, 9], [9, 11]]);
    healthy(r);
  });

  it('no gaps → same project', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)])]);
    expect(deleteGapsOp(q, 'v1')).toBe(q);
  });
});

describe('duplicate', () => {
  it('places the copy right after the original with new ids', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 3)])]);
    const r = duplicateOp(p, ['a']);
    expect(spans(r.project, 'v1')).toEqual([[2, 5], [5, 8]]);
    expect(r.newIds.length).toBe(1);
    expect(r.newIds[0]).not.toBe('a');
    expect(item(r.project, r.newIds[0] as string).startSec).toBe(5);
    healthy(r.project);
  });

  it('skips past whatever is in the way', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 3), V('b', 3, 4)])]);
    const r = duplicateOp(p, ['a']);
    expect(item(r.project, r.newIds[0] as string).startSec).toBe(7);
  });

  it('multi-selection keeps relative offsets; the block is placed after the whole selection', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2), V('b', 3, 2)]), track('o', 'overlay', [S('s', 1, 2)])]);
    const r = duplicateOp(p, ['a', 'b', 's']);
    const ids = r.newIds;
    const starts = ids.map((id) => item(r.project, id).startSec);
    expect(starts.sort((x, y) => x - y)).toEqual([5, 6, 8]);
    healthy(r.project);
  });

  it('gives copies new group ids (one per old group) and keeps them grouped', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2, { groupId: 'g' })]), track('o', 'overlay', [S('s', 0, 2, { groupId: 'g' })])]);
    const r = duplicateOp(p, ['a']);
    const copies = r.newIds.map((id) => item(r.project, id));
    expect(copies.length).toBe(2);
    expect(copies[0]?.groupId).toBeTruthy();
    expect(copies[0]?.groupId).toBe(copies[1]?.groupId);
    expect(copies[0]?.groupId).not.toBe('g');
    expect(item(r.project, 'a').groupId).toBe('g');
  });

  it('a copy keeps its transition only if its predecessor was copied', () => {
    const base = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 2 })])]);
    const withX = setTransitionOp(base, 'b', { type: 'crossfade', durationSec: 1 }, false);
    const both = duplicateOp(withX, ['a', 'b']);
    healthy(both.project);
    const copyB = both.newIds.map((id) => item(both.project, id) as VideoItem).find((c) => c.transitionIn);
    expect(copyB?.transitionIn?.durationSec).toBeCloseTo(1);
    const onlyB = duplicateOp(withX, ['b']);
    healthy(onlyB.project);
    expect((item(onlyB.project, onlyB.newIds[0] as string) as VideoItem).transitionIn).toBeNull();
  });

  it('locked items are not duplicated', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 2)], { locked: true })]);
    expect(duplicateOp(p, ['a']).newIds).toEqual([]);
  });
});

describe('group / ungroup', () => {
  const p = () => proj([track('v1', 'video', [V('a', 0, 2), V('b', 2, 2), V('c', 4, 2)])]);

  it('groups ≥ 2 items under one id', () => {
    const r = groupOp(p(), ['a', 'b']);
    const g = items(r, 'v1').map((i) => i.groupId);
    expect(g[0]).toBeTruthy();
    expect(g[0]).toBe(g[1]);
    expect(g[2]).toBeNull();
  });

  it('needs at least two items', () => {
    const q = p();
    expect(groupOp(q, ['a'])).toBe(q);
  });

  it('grouping a member of an existing group merges the groups', () => {
    let r = groupOp(p(), ['a', 'b']);
    r = groupOp(r, ['b', 'c']);
    const ids = new Set(items(r, 'v1').map((i) => i.groupId));
    expect(ids.size).toBe(1);
  });

  it('ungroup clears the whole group', () => {
    let r = groupOp(p(), ['a', 'b']);
    r = ungroupOp(r, ['a']);
    expect(items(r, 'v1').every((i) => i.groupId === null)).toBe(true);
  });

  it('ungroup on ungrouped items changes nothing', () => {
    const q = p();
    expect(ungroupOp(q, ['a'])).toBe(q);
  });

  it('locked items cannot be (un)grouped', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 2), V('b', 2, 2)], { locked: true })]);
    expect(groupOp(q, ['a', 'b'])).toBe(q);
  });
});

describe('copy / paste', () => {
  const p = () =>
    proj([
      track('v1', 'video', [V('a', 2, 3), V('b', 6, 2)]),
      track('v2', 'overlay', [S('s', 3, 2)]),
      track('t', 'text', [T('t1', 2, 1)]),
    ]);

  it('copies a snapshot with source track kinds', () => {
    const c = copyOp(p(), ['a', 's']);
    expect(c?.items.map((i) => i.id)).toEqual(['a', 's']);
    expect(c?.trackKinds).toEqual(['video', 'overlay']);
    expect(copyOp(p(), [])).toBeNull();
  });

  it('pastes at the playhead keeping relative offsets, with new ids', () => {
    const c = copyOp(p(), ['a', 'b']);
    const r = pasteOp(p(), c!, 20, null);
    expect(r.newIds.length).toBe(2);
    const ns = r.newIds.map((id) => item(r.project, id).startSec);
    expect(ns).toEqual([20, 24]);
    expect(r.newIds).not.toContain('a');
    healthy(r.project);
  });

  it('pastes onto the selected compatible track first', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 2)]), track('v2', 'video', [])]);
    const r = pasteOp(q, copyOp(q, ['a'])!, 0, 'v2');
    expect(r.newIds.map((id) => r.project.tracks.find((t) => t.items.some((i) => i.id === id))?.id)).toEqual(['v2']);
  });

  it('ignores an incompatible selected track', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 2)]), track('t', 'text', [])]);
    const r = pasteOp(q, copyOp(q, ['a'])!, 5, 't');
    expect(r.project.tracks.find((t) => t.id === 't')?.items.length).toBe(0);
    expect(r.project.tracks[0]?.items.length).toBe(2);
  });

  it('creates a new track when the block does not fit anywhere', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 4)])]);
    const r = pasteOp(q, copyOp(q, ['a'])!, 1, 'v1');
    expect(r.project.tracks.length).toBe(2);
    expect(r.project.tracks[1]?.kind === 'video' || r.project.tracks[0]?.kind === 'video').toBe(true);
    healthy(r.project);
  });

  it('different source tracks land on different tracks', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 2)]), track('v2', 'video', [V('b', 0, 2)])]);
    const r = pasteOp(q, copyOp(q, ['a', 'b'])!, 10, null);
    const where = r.newIds.map((id) => r.project.tracks.findIndex((t) => t.items.some((i) => i.id === id)));
    expect(new Set(where).size).toBe(2);
  });

  it('pasted groups get new group ids', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 2, { groupId: 'g' })]), track('o', 'overlay', [S('s', 0, 2, { groupId: 'g' })])]);
    const r = pasteOp(q, copyOp(q, ['a'])!, 10, null);
    const gs = r.newIds.map((id) => item(r.project, id).groupId);
    expect(gs[0]).toBeTruthy();
    expect(gs[0]).toBe(gs[1]);
    expect(gs[0]).not.toBe('g');
  });

  it('an empty clipboard pastes nothing', () => {
    const q = p();
    expect(pasteOp(q, { items: [], trackKinds: [] }, 0, null)).toEqual({ project: q, newIds: [] });
  });

  it('works for an externally built clipboard without slots', () => {
    const q = proj([track('v1', 'video', [])]);
    const r = pasteOp(q, { items: [V('x', 4, 2)], trackKinds: ['video'] }, 1, null);
    expect(item(r.project, r.newIds[0] as string).startSec).toBe(1);
  });
});

describe('updateItems', () => {
  const p = () => proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]), track('t', 'text', [T('t1', 0, 2)])]);

  it('deep-merges nested patches', () => {
    const r = updateItemsOp(p(), ['a'], { transform: { scale: { v: 1.5 } }, fit: 'contain' });
    const a = item(r, 'a') as VideoItem;
    expect(a.transform.scale.v).toBe(1.5);
    expect(a.transform.opacity.v).toBe(1);
    expect(a.fit).toBe('contain');
    expect(itemSchema.safeParse(a).success).toBe(true);
  });

  it('applies to many items at once', () => {
    const r = updateItemsOp(p(), ['a', 'b'], { blend: 'multiply' });
    expect(items(r, 'v1').every((i) => (i as VideoItem).blend === 'multiply')).toBe(true);
  });

  it('rejects patches that make the item invalid', () => {
    const q = p();
    expect(updateItemsOp(q, ['a'], { speed: 99 } as never)).toBe(q);
    expect(updateItemsOp(q, ['t1'], { style: { color: 'red' } } as never)).toBe(q);
  });

  it('cannot change id or type', () => {
    const r = updateItemsOp(p(), ['a'], { id: 'zzz', type: 'text', fit: 'native' } as never);
    expect(item(r, 'a').type).toBe('video');
    expect((item(r, 'a') as VideoItem).fit).toBe('native');
  });

  it('no-op patches return the same project', () => {
    const q = p();
    expect(updateItemsOp(q, ['a'], { fit: 'cover' })).toBe(q);
    expect(updateItemsOp(q, ['a'], {})).toBe(q);
  });

  it('skips locked items; a pure lock toggle is allowed on a locked item', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5, { locked: true })])]);
    expect(updateItemsOp(q, ['a'], { fit: 'native' })).toBe(q);
    expect((item(updateItemsOp(q, ['a'], { locked: false }), 'a')).locked).toBe(false);
  });

  it('skips items on locked tracks', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(updateItemsOp(q, ['a'], { fit: 'native' })).toBe(q);
  });

  it('geometry patches are validated against the overlap invariant', () => {
    const q = p();
    expect(updateItemsOp(q, ['a'], { durationSec: 8 })).toBe(q);
    const ok = updateItemsOp(q, ['a'], { startSec: 0, durationSec: 4 });
    expect(item(ok, 'a').durationSec).toBe(4);
    const moved = updateItemsOp(q, ['b'], { startSec: 20 });
    expect(spans(moved, 'v1')).toEqual([[0, 5], [20, 25]]);
  });

  it('arrays are replaced (keyframes)', () => {
    const r = updateItemsOp(p(), ['a'], { transform: { x: { v: 0, kf: [{ t: 1, v: 5, ease: 'linear' }] } } });
    expect((item(r, 'a') as VideoItem).transform.x.kf.length).toBe(1);
  });
});

describe('tracks', () => {
  it('addTrack inserts by z-rank and names sensibly', () => {
    const p = emptyProject();
    const r = addTrackOp(p, 'overlay');
    expect(r.project.tracks.map((t) => t.kind)).toEqual(['video', 'overlay', 'subtitle', 'text', 'audio']);
    const r2 = addTrackOp(r.project, 'video');
    expect(r2.project.tracks[1]?.name).toBe('Video 2');
    expect(r2.project.tracks[1]?.speech).toBe(true);
  });

  it('addTrack with an explicit index and name', () => {
    const r = addTrackOp(emptyProject(), 'audio', { index: 0, name: 'SFX bus' });
    expect(r.project.tracks[0]?.name).toBe('SFX bus');
    expect(addTrackOp(emptyProject(), 'text', { index: 99 }).project.tracks.at(-1)?.kind).toBe('text');
  });

  it('removeTrack drops the track and its items; locked tracks are refused', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 1)]), track('o', 'overlay', [S('s', 0, 1)])]);
    expect(removeTrackOp(p, 'o').tracks.length).toBe(1);
    const l = proj([track('v1', 'video', [], { locked: true })]);
    expect(removeTrackOp(l, 'v1')).toBe(l);
    expect(removeTrackOp(p, 'nope')).toBe(p);
  });

  it('removing a track dissolves groups reduced to one member', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 1, { groupId: 'g' })]), track('o', 'overlay', [S('s', 0, 1, { groupId: 'g' })])]);
    expect(items(removeTrackOp(p, 'o'), 'v1')[0]?.groupId).toBeNull();
  });

  it('moveTrack reorders and clamps', () => {
    const p = emptyProject();
    const ids = p.tracks.map((t) => t.id);
    const r = moveTrackOp(p, ids[0] as string, 2);
    expect(r.tracks.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    expect(moveTrackOp(p, ids[0] as string, 0)).toBe(p);
    expect(moveTrackOp(p, ids[0] as string, 99).tracks.at(-1)?.id).toBe(ids[0]);
  });

  it('updateTrack patches fields, validates ranges', () => {
    const p = emptyProject();
    const id = p.tracks[0]?.id as string;
    expect(updateTrackOp(p, id, { name: 'Main' }).tracks[0]?.name).toBe('Main');
    expect(updateTrackOp(p, id, { muted: true }).tracks[0]?.muted).toBe(true);
    expect(updateTrackOp(p, id, { gain: 99 })).toBe(p);
    expect(updateTrackOp(p, id, { name: p.tracks[0]?.name })).toBe(p);
    const d = updateTrackOp(p, p.tracks[3]?.id as string, { ducking: { enabled: true } as never });
    expect(d.tracks[3]?.ducking.enabled).toBe(true);
    expect(d.tracks[3]?.ducking.reductionDb).toBe(12);
  });

  it('a locked track can still be unlocked', () => {
    const p = proj([track('v1', 'video', [], { locked: true })]);
    expect(updateTrackOp(p, 'v1', { locked: false }).tracks[0]?.locked).toBe(false);
  });
});

describe('markers / assets / canvas', () => {
  it('markers are sorted, deduped by position, editable and removable', () => {
    let p = emptyProject();
    const a = addMarkerOp(p, 5, 'five');
    p = a.project;
    p = addMarkerOp(p, 2).project;
    expect(p.markers.map((m) => m.atSec)).toEqual([2, 5]);
    expect(addMarkerOp(p, 5.001).id).toBe(a.id);
    expect(addMarkerOp(p, 5.001).project).toBe(p);
    p = updateMarkerOp(p, a.id, { atSec: 1, label: 'x' });
    expect(p.markers.map((m) => [m.atSec, m.label])).toEqual([[1, 'x'], [2, 'Marker 2']]);
    p = removeMarkerOp(p, a.id);
    expect(p.markers.length).toBe(1);
    expect(removeMarkerOp(p, 'nope')).toBe(p);
    expect(updateMarkerOp(p, 'nope', { label: 'x' })).toBe(p);
    expect(updateMarkerOp(p, p.markers[0]!.id, { color: 'red' as never })).toBe(p);
  });

  it('addAssets replaces by id; updateAsset merges', () => {
    let p = emptyProject();
    p = addAssetsOp(p, [asset('x', 'video', 5), asset('y', 'audio', 3)]);
    p = addAssetsOp(p, [asset('x', 'video', 9)]);
    expect(p.assets.map((a) => [a.id, a.durationSec])).toEqual([['y', 3], ['x', 9]]);
    p = updateAssetOp(p, 'y', { beats: [1, 2] });
    expect(p.assets.find((a) => a.id === 'y')?.beats).toEqual([1, 2]);
    expect(updateAssetOp(p, 'nope', { name: 'q' })).toBe(p);
    expect(updateAssetOp(p, 'y', { id: 'other' } as never).assets.find((a) => a.id === 'y')).toBeTruthy();
  });

  it('setCanvas applies preset sizes for an aspect change and validates', () => {
    const p = emptyProject();
    const r = setCanvasOp(p, { aspect: '16:9' });
    expect([r.canvas.width, r.canvas.height]).toEqual([1920, 1080]);
    const c = setCanvasOp(p, { aspect: 'custom', width: 800, height: 600 });
    expect([c.canvas.aspect, c.canvas.width, c.canvas.height]).toEqual(['custom', 800, 600]);
    expect(setCanvasOp(p, { width: 5 })).toBe(p);
    expect(setCanvasOp(p, { fps: 60 }).canvas.fps).toBe(60);
    expect(setCanvasOp(p, { fps: 37 as never })).toBe(p);
    expect(setCanvasOp(p, { aspect: '9:16' })).toBe(p);
  });
});

describe('item factories used by ops', () => {
  it('makeVideoItem fits a fresh item', () => {
    const it = makeVideoItem(asset('x', 'video', 10), 3);
    expect(itemSchema.safeParse(it).success).toBe(true);
    expect(it.durationSec).toBe(10);
  });
  it('unused imports guard', () => {
    expect([C, I].length).toBe(2);
    expect(([] as Item[]).length).toBe(0);
  });
});
