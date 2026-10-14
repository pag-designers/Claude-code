import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoItem } from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import { createEditorStore, useEditorStore, emptyProject } from '../../renderer/lib/editor/core';
import { A, C, S, T, V, asset, fakeClock, item, items, makeStore, proj, spans, track } from './editor-core-fixtures';

const base = () =>
  proj([
    track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 10 }), V('c', 12, 3, { inSec: 30 })]),
    track('m', 'audio', [A('m1', 0, 20)]),
    track('t', 'text', [T('t1', 1, 2)]),
    track('s', 'subtitle', [C('c1', 0, 3, [['hello', 0, 1], ['world', 1.5, 2.5]])]),
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe('exports', () => {
  it('useEditorStore is a real zustand hook with the api surface; createEditorStore is independent', () => {
    expect(typeof useEditorStore.getState).toBe('function');
    expect(typeof useEditorStore.subscribe).toBe('function');
    const s = useEditorStore.getState();
    for (const k of ['load', 'saveNow', 'startAutosave', 'tick', 'split', 'trim', 'undo', 'redo', 'addAsset', 'setCueText'] as const)
      expect(typeof s[k]).toBe('function');
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().addMarker(1);
    expect(b.getState().project.markers.length).toBe(0);
  });

  it('starts blank with the default tracks', () => {
    const s = createEditorStore().getState();
    expect(s.project.tracks.map((t) => t.kind)).toEqual(['video', 'subtitle', 'text', 'audio']);
    expect(s.saveState).toBe('idle');
    expect(s.canUndo).toBe(false);
    expect(s.snapEnabled).toBe(true);
    expect(s.pxPerSec).toBeGreaterThan(0);
  });
});

describe('load', () => {
  it('replaces everything and clears history / selection / playhead', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    st.getState().setPlayhead(3);
    st.getState().split(null);
    expect(st.getState().canUndo).toBe(true);
    st.getState().load({ id: 'p2', name: 'Other', rev: 7, project: emptyProject('16:9'), updatedAt: 99 });
    const s = st.getState();
    expect([s.projectId, s.name, s.rev, s.playheadSec, s.canUndo, s.canRedo, s.saveState]).toEqual(['p2', 'Other', 7, 0, false, false, 'idle']);
    expect(s.selection).toEqual({ itemIds: [], trackId: null, keyframe: null });
    expect(s.project.canvas.aspect).toBe('16:9');
    expect(s.lastSavedAt).toBe(99);
  });
});

describe('history — undo / redo', () => {
  it('apply → undo → redo is exact for a spread of operations', () => {
    const ops: [string, (s: ReturnType<typeof createEditorStore>) => void][] = [
      ['split', (s) => { s.getState().select(['a']); s.getState().setPlayhead(2); s.getState().split(null); }],
      ['trim', (s) => s.getState().trim('a', 'end', 3, { snap: false })],
      ['delete', (s) => s.getState().deleteItems(['b'])],
      ['ripple delete', (s) => s.getState().deleteItems(['b'], { ripple: true })],
      ['gaps', (s) => s.getState().deleteGaps('v1')],
      ['dup', (s) => void s.getState().duplicateItems(['a'])],
      ['group', (s) => s.getState().group(['a', 'b'])],
      ['transition', (s) => s.getState().setTransition('b', { type: 'crossfade', durationSec: 1 })],
      ['speed', (s) => s.getState().setSpeed('a', 2)],
      ['freeze', (s) => s.getState().freezeFrame('a', 2, 1)],
      ['prop', (s) => { s.getState().select(['a']); s.getState().setProp('a', 'transform.x', 10); }],
      ['cue text', (s) => s.getState().setCueText('c1', 'hello brave new world')],
      ['marker', (s) => void s.getState().addMarker(2)],
      ['canvas', (s) => s.getState().setCanvas({ aspect: '1:1' })],
      ['track', (s) => void s.getState().addTrack('overlay')],
      ['move', (s) => s.getState().applyMoves([{ itemId: 'a', trackId: 'v1', startSec: 20 }])],
      ['assets', (s) => s.getState().addAssets([asset('zz', 'image', null)])],
      ['updateItem', (s) => s.getState().updateItem('t1', { text: 'changed' })],
    ];
    for (const [name, run] of ops) {
      const st = makeStore(base());
      const before = st.getState().project;
      run(st);
      const after = st.getState().project;
      expect(after, name).not.toBe(before);
      expect(st.getState().canUndo, name).toBe(true);
      st.getState().undo();
      expect(st.getState().project, name).toBe(before);
      expect(st.getState().canRedo, name).toBe(true);
      st.getState().redo();
      expect(st.getState().project, name).toBe(after);
    }
  });

  it('labels follow the stack', () => {
    const st = makeStore(base());
    expect(st.getState().undoLabel).toBeNull();
    st.getState().setPlayhead(2);
    st.getState().split('a');
    st.getState().deleteItems(['c']);
    expect(st.getState().undoLabel).toBe('Delete');
    expect(st.getState().redoLabel).toBeNull();
    st.getState().undo();
    expect([st.getState().undoLabel, st.getState().redoLabel]).toEqual(['Split', 'Delete']);
    st.getState().undo();
    expect([st.getState().undoLabel, st.getState().redoLabel, st.getState().canUndo]).toEqual([null, 'Split', false]);
    st.getState().redo();
    expect(st.getState().undoLabel).toBe('Split');
  });

  it('a new edit clears the redo stack', () => {
    const st = makeStore(base());
    st.getState().deleteItems(['c']);
    st.getState().undo();
    expect(st.getState().canRedo).toBe(true);
    st.getState().deleteItems(['b']);
    expect(st.getState().canRedo).toBe(false);
  });

  it('undo / redo with an empty stack do nothing', () => {
    const st = makeStore(base());
    const p = st.getState().project;
    st.getState().undo();
    st.getState().redo();
    expect(st.getState().project).toBe(p);
  });

  it('keeps 200 levels', () => {
    const st = makeStore(base());
    for (let i = 0; i < 230; i++) st.getState().addMarker(i * 0.5);
    let n = 0;
    while (st.getState().canUndo) {
      st.getState().undo();
      n++;
    }
    expect(n).toBe(200);
    expect(st.getState().project.markers.length).toBe(30);
  });

  it('undo-all returns the original project reference after a mixed session', () => {
    const st = makeStore(base());
    const orig = st.getState().project;
    st.getState().deleteItems(['c']);
    st.getState().setPlayhead(2);
    st.getState().split('a');
    st.getState().setSpeed('b', 2);
    st.getState().addMarker(1);
    st.getState().duplicateItems(['b']);
    while (st.getState().canUndo) st.getState().undo();
    expect(st.getState().project).toBe(orig);
  });

  it('rejected edits (locked track, invalid, no-op) leave no history entry and do not dirty the doc', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true }), track('o', 'overlay', [S('s', 0, 2)])]);
    const st = makeStore(p);
    const g = st.getState();
    g.trim('a', 'end', 2);
    g.deleteItems(['a']);
    g.setSpeed('a', 2);
    g.setProp('a', 'transform.x', 5);
    g.setTransition('a', { type: 'crossfade', durationSec: 1 });
    g.applyMoves([{ itemId: 'a', trackId: 'v1', startSec: 3 }]);
    g.updateItem('a', { fit: 'native' });
    g.split('a', 2);
    g.removeTrack('v1');
    g.deleteItems(['zzz']);
    expect(st.getState().canUndo).toBe(false);
    expect(st.getState().saveState).toBe('idle');
    expect(st.getState().project).toBe(p);
  });

  it('selection is restored by undo and pruned of deleted items', () => {
    const st = makeStore(base());
    st.getState().select(['b']);
    st.getState().deleteItems(['b']);
    expect(st.getState().selection.itemIds).toEqual([]);
    st.getState().undo();
    expect(st.getState().selection.itemIds).toEqual(['b']);
  });
});

describe('history — coalescing', () => {
  it('merges same-key edits within 600 ms into one step and undoes them together', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    const orig = st.getState().project;
    for (const v of [0.9, 0.8, 0.7, 0.6]) {
      st.getState().updateItem('a', { transform: { opacity: { v } } }, { coalesceKey: 'opacity:a' });
      clock.advance(200);
    }
    expect((item(st.getState().project, 'a') as VideoItem).transform.opacity.v).toBe(0.6);
    st.getState().undo();
    expect(st.getState().project).toBe(orig);
    expect(st.getState().canUndo).toBe(false);
  });

  it('the 600 ms window is measured from the previous edit (a long drag stays one step)', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    for (let i = 0; i < 20; i++) {
      st.getState().updateItem('a', { transform: { x: { v: i + 1 } } }, { coalesceKey: 'x' });
      clock.advance(500);
    }
    st.getState().undo();
    expect(st.getState().canUndo).toBe(false);
  });

  it('a gap longer than 600 ms starts a new step', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().updateItem('a', { transform: { x: { v: 1 } } }, { coalesceKey: 'x' });
    clock.advance(601);
    st.getState().updateItem('a', { transform: { x: { v: 2 } } }, { coalesceKey: 'x' });
    st.getState().undo();
    expect((item(st.getState().project, 'a') as VideoItem).transform.x.v).toBe(1);
    st.getState().undo();
    expect((item(st.getState().project, 'a') as VideoItem).transform.x.v).toBe(0);
  });

  it('different keys, and edits without a key, never merge', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().updateItem('a', { transform: { x: { v: 1 } } }, { coalesceKey: 'x' });
    st.getState().updateItem('a', { transform: { y: { v: 1 } } }, { coalesceKey: 'y' });
    st.getState().updateItem('a', { transform: { scale: { v: 2 } } });
    st.getState().updateItem('a', { transform: { rotation: { v: 5 } } });
    let n = 0;
    while (st.getState().canUndo) {
      st.getState().undo();
      n++;
    }
    expect(n).toBe(4);
  });

  it('an unrelated edit in between breaks the chain', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().updateItem('a', { transform: { x: { v: 1 } } }, { coalesceKey: 'x' });
    st.getState().addMarker(1);
    st.getState().updateItem('a', { transform: { x: { v: 2 } } }, { coalesceKey: 'x' });
    st.getState().undo();
    expect((item(st.getState().project, 'a') as VideoItem).transform.x.v).toBe(1);
  });

  it('after an undo the next edit does not merge into the older step', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().updateItem('a', { transform: { x: { v: 1 } } }, { coalesceKey: 'x' });
    st.getState().undo();
    st.getState().updateItem('a', { transform: { x: { v: 2 } } }, { coalesceKey: 'x' });
    st.getState().updateItem('a', { transform: { x: { v: 3 } } }, { coalesceKey: 'x' });
    st.getState().undo();
    expect((item(st.getState().project, 'a') as VideoItem).transform.x.v).toBe(0);
  });

  it('setProp with a coalesceKey merges like a slider drag', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    for (let v = 1; v <= 10; v++) {
      st.getState().setProp('a', 'transform.scale', 1 + v / 10, { coalesceKey: 'scale:a' });
      clock.advance(30);
    }
    st.getState().undo();
    expect(st.getState().canUndo).toBe(false);
    expect((item(st.getState().project, 'a') as VideoItem).transform.scale.v).toBe(1);
  });

  it('typing into a cue coalesces per cue', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().setCueText('c1', 'hello w');
    clock.advance(100);
    st.getState().setCueText('c1', 'hello wo');
    clock.advance(100);
    st.getState().setCueText('c1', 'hello wor');
    st.getState().undo();
    expect(st.getState().canUndo).toBe(false);
  });

  it('keyframe dragging coalesces', () => {
    const clock = fakeClock();
    const st = makeStore(base());
    const st2 = makeStore(base(), { clock });
    st2.getState().addKeyframe('a', 'transform.x', 1, 0);
    for (let i = 0; i < 5; i++) {
      st2.getState().moveKeyframe('a', 'transform.x', 0, 1 + i * 0.1, i);
      clock.advance(50);
    }
    st2.getState().undo();
    expect(st2.getState().canUndo).toBe(true); // the add itself
    expect(((item(st2.getState().project, 'a') as VideoItem).transform.x.kf[0])?.t).toBeCloseTo(1);
    void st;
  });
});

describe('item actions through the store', () => {
  it('split(null) uses selected items crossing the playhead, else the selected track, else any', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    // nothing selected, no track → first track with an item under the playhead (video)
    const ids = st.getState().split(null);
    expect(ids.length).toBe(1);
    expect(spans(st.getState().project, 'v1')).toEqual([[0, 2], [2, 5], [5, 10], [12, 15]]);
    // selected track audio
    st.getState().selectTrack('m');
    st.getState().split(null);
    expect(items(st.getState().project, 'm').length).toBe(2);
    // selected items win
    st.getState().select(['t1']);
    st.getState().split(null);
    expect(items(st.getState().project, 't').length).toBe(2);
    expect(items(st.getState().project, 'v1').length).toBe(4);
  });

  it('split(null) with several selected items splits them all in one undo step', () => {
    const st = makeStore(base());
    st.getState().select(['a', 'm1', 't1']);
    st.getState().setPlayhead(2);
    expect(st.getState().split(null).length).toBe(3);
    st.getState().undo();
    expect(st.getState().canUndo).toBe(false);
  });

  it('split of a grouped item splits the group members under the playhead', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5, { groupId: 'g' })]), track('o', 'overlay', [S('s', 0, 5, { groupId: 'g' })])]);
    const st = makeStore(p);
    expect(st.getState().split('a', 2).length).toBe(2);
  });

  it('split with an explicit item and time', () => {
    const st = makeStore(base());
    const ids = st.getState().split('c', 13);
    expect(ids.length).toBe(1);
    expect(spans(st.getState().project, 'v1').slice(-2)).toEqual([[12, 13], [13, 15]]);
    expect(st.getState().split('c', 100)).toEqual([]);
  });

  it('addAsset uses the playhead by default and selects the new item', () => {
    const p = proj([track('v1', 'video', [])], { assets: [asset('x', 'video', 4)] });
    const st = makeStore(p);
    st.getState().setPlayhead(6);
    const id = st.getState().addAsset('x');
    expect(id).toBeTruthy();
    expect(item(st.getState().project, id as string).startSec).toBe(6);
    expect(st.getState().selection.itemIds).toEqual([id]);
    expect(st.getState().selection.trackId).toBe('v1');
    expect(st.getState().addAsset('nope')).toBeNull();
  });

  it('addItem returns the id and creates a track when needed', () => {
    const st = makeStore(proj([track('v1', 'video', [])]));
    const id = st.getState().addItem(T('txt', 1, 2));
    expect(id).toBe('txt');
    expect(st.getState().project.tracks.some((t) => t.kind === 'text' && t.items.length === 1)).toBe(true);
  });

  it('duplicate selects the copies; paste selects the pasted items and works at the playhead', () => {
    const st = makeStore(base());
    const d = st.getState().duplicateItems(['c']);
    expect(st.getState().selection.itemIds).toEqual(d);
    st.getState().select(['a']);
    st.getState().copy();
    expect(st.getState().clipboard?.items.map((i) => i.id)).toEqual(['a']);
    st.getState().setPlayhead(40);
    const ids = st.getState().paste();
    expect(ids.length).toBe(1);
    expect(item(st.getState().project, ids[0] as string).startSec).toBe(40);
    expect(st.getState().selection.itemIds).toEqual(ids);
  });

  it('cut = copy + delete in one undo step', () => {
    const st = makeStore(base());
    st.getState().select(['b']);
    st.getState().cut();
    expect(st.getState().clipboard?.items[0]?.id).toBe('b');
    expect(items(st.getState().project, 'v1').map((i) => i.id)).toEqual(['a', 'c']);
    st.getState().undo();
    expect(items(st.getState().project, 'v1').length).toBe(3);
    expect(st.getState().canUndo).toBe(false);
  });

  it('the clipboard survives loading another project', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    st.getState().copy();
    st.getState().load({ id: 'x', name: 'x', rev: 1, project: emptyProject(), updatedAt: 1 });
    st.getState().setPlayhead(1);
    expect(st.getState().paste().length).toBe(1);
  });

  it('ripple flag drives delete / trim; explicit option overrides', () => {
    const st = makeStore(base());
    st.getState().toggleRipple();
    st.getState().deleteItems(['a']);
    expect(spans(st.getState().project, 'v1')[0]).toEqual([0, 5]); // b closed up to 0
    st.getState().undo();
    st.getState().deleteItems(['a'], { ripple: false });
    expect(spans(st.getState().project, 'v1')[0]).toEqual([5, 10]);
  });

  it('ripple flag on = all unlocked tracks shift; explicit ripple with the flag off = track only', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]), track('t', 'text', [T('t1', 6, 2)])]);
    const off = makeStore(q);
    off.getState().deleteItems(['a'], { ripple: true });
    expect(spans(off.getState().project, 't')).toEqual([[6, 8]]);
    const on = makeStore(q);
    on.getState().toggleRipple();
    on.getState().deleteItems(['a']);
    expect(spans(on.getState().project, 't')).toEqual([[1, 3]]);
  });

  it('trim snaps to the playhead and reports it via previewTrim', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(3.02);
    const pv = st.getState().previewTrim('a', 'end', 3.05, { pxPerSec: 100 });
    expect(pv.snappedTo).toBe(3.02);
    expect(pv.snapKind).toBe('playhead');
    st.getState().trim('a', 'end', 3.05);
    expect(item(st.getState().project, 'a').durationSec).toBeCloseTo(3.02);
    st.getState().trim('a', 'end', 2, { snap: false });
    expect(item(st.getState().project, 'a').durationSec).toBeCloseTo(2);
  });

  it('previewMove uses store playhead / zoom / snap toggle', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(8);
    const pv = st.getState().previewMove(['c'], -3.98, null, { pxPerSec: 100 });
    expect(pv.snappedTo).toBe(8);
    expect(pv.snapKind).toBe('playhead');
    st.getState().toggleSnap();
    expect(st.getState().previewMove(['c'], -3.98, null).snappedTo).toBeNull();
    expect(st.getState().previewMove(['c'], -3.98, null, { snap: true, pxPerSec: 100 }).snappedTo).toBe(8);
  });

  it('updateItem with transitionIn routes through setTransition', () => {
    const st = makeStore(base());
    st.getState().updateItem('b', { transitionIn: { type: 'slide-left', durationSec: 1 } } as never);
    const b = item(st.getState().project, 'b') as VideoItem;
    expect(b.transitionIn).toEqual({ type: 'slide-left', durationSec: 1 });
    expect(b.startSec).toBe(4);
    st.getState().updateItem('b', { transitionIn: { durationSec: 0.5 } } as never);
    expect((item(st.getState().project, 'b') as VideoItem).transitionIn).toEqual({ type: 'slide-left', durationSec: 0.5 });
    st.getState().updateItem('b', { transitionIn: null } as never);
    expect((item(st.getState().project, 'b') as VideoItem).transitionIn).toBeNull();
  });

  it('setProp keys at the playhead (item-local)', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(7);
    st.getState().setProp('b', 'transform.x', 5, { forceKeyframe: true });
    expect((item(st.getState().project, 'b') as VideoItem).transform.x.kf).toEqual([{ t: 2, v: 5, ease: 'linear' }]);
    st.getState().setProp('b', 'transform.x', 9);
    expect((item(st.getState().project, 'b') as VideoItem).transform.x.kf).toEqual([{ t: 2, v: 9, ease: 'linear' }]);
  });

  it('addKeyframe selects it; removing it clears the selection', () => {
    const st = makeStore(base());
    st.getState().addKeyframe('a', 'transform.x', 1, 5);
    expect(st.getState().selection.keyframe).toEqual({ itemId: 'a', prop: 'transform.x', index: 0 });
    st.getState().removeKeyframe('a', 'transform.x', 0);
    expect(st.getState().selection.keyframe).toBeNull();
  });

  it('moveKeyframe keeps the selection pointing at the moved keyframe', () => {
    const st = makeStore(base());
    st.getState().addKeyframe('a', 'transform.x', 1, 5);
    st.getState().addKeyframe('a', 'transform.x', 3, 6);
    st.getState().selectKeyframe({ itemId: 'a', prop: 'transform.x', index: 0 });
    st.getState().moveKeyframe('a', 'transform.x', 0, 4, 5);
    expect(st.getState().selection.keyframe?.index).toBe(1);
  });

  it('markers: playhead default, label default, update, remove', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2.5);
    const id = st.getState().addMarker();
    expect(st.getState().project.markers[0]).toMatchObject({ id, atSec: 2.5, label: 'Marker 1' });
    st.getState().updateMarker(id, { label: 'Intro', color: '#112233' });
    expect(st.getState().project.markers[0]).toMatchObject({ label: 'Intro', color: '#112233' });
    st.getState().removeMarker(id);
    expect(st.getState().project.markers).toEqual([]);
  });

  it('freezeFrame honours the ripple flag for other tracks', () => {
    const st = makeStore(base());
    st.getState().freezeFrame('a', 2, 1);
    expect(spans(st.getState().project, 'm')).toEqual([[0, 20]]);
    const q = proj([track('v1', 'video', [V('a', 0, 5)]), track('t', 'text', [T('t1', 6, 2)])]);
    const on = makeStore(q);
    on.getState().toggleRipple();
    on.getState().freezeFrame('a', 2, 1);
    expect(spans(on.getState().project, 't')).toEqual([[7, 9]]);
  });

  it('track actions: add / move / update / remove', () => {
    const st = makeStore(base());
    const id = st.getState().addTrack('overlay', { name: 'FX' });
    expect(st.getState().project.tracks.find((t) => t.id === id)?.name).toBe('FX');
    expect(st.getState().selection.trackId).toBe(id);
    st.getState().updateTrack(id, { muted: true, locked: true });
    expect(st.getState().project.tracks.find((t) => t.id === id)).toMatchObject({ muted: true, locked: true });
    st.getState().removeTrack(id); // locked → refused
    expect(st.getState().project.tracks.some((t) => t.id === id)).toBe(true);
    st.getState().updateTrack(id, { locked: false });
    st.getState().moveTrack(id, 0);
    expect(st.getState().project.tracks[0]?.id).toBe(id);
    st.getState().removeTrack(id);
    expect(st.getState().project.tracks.some((t) => t.id === id)).toBe(false);
    expect(st.getState().selection.trackId).toBeNull();
  });

  it('subtitle actions', () => {
    const st = makeStore(base());
    st.getState().setCueText('c1', 'hello there world');
    const nid = st.getState().splitCue('c1', 1);
    expect(nid).toBeTruthy();
    st.getState().mergeCueWithNext('c1');
    expect(items(st.getState().project, 's').length).toBe(1);
    st.getState().retimeCue('c1', 0.5, 3);
    expect(item(st.getState().project, 'c1').startSec).toBe(0.5);
    st.getState().replaceCues('s', []);
    expect(items(st.getState().project, 's')).toEqual([]);
  });
});

describe('selection', () => {
  const st0 = () => makeStore(base());

  it('replace / add / toggle', () => {
    const st = st0();
    st.getState().select(['a']);
    st.getState().select(['b'], 'add');
    expect(st.getState().selection.itemIds).toEqual(['a', 'b']);
    st.getState().select(['a'], 'toggle');
    expect(st.getState().selection.itemIds).toEqual(['b']);
    st.getState().select(['c'], 'toggle');
    expect(st.getState().selection.itemIds).toEqual(['b', 'c']);
    st.getState().select(['t1']);
    expect(st.getState().selection.itemIds).toEqual(['t1']);
    expect(st.getState().selection.trackId).toBe('t');
  });

  it('selecting a grouped item selects the group; toggling removes the whole group', () => {
    const st = makeStore(proj([track('v1', 'video', [V('a', 0, 2, { groupId: 'g' }), V('b', 2, 2, { groupId: 'g' }), V('c', 4, 2)])]));
    st.getState().select(['a']);
    expect(st.getState().selection.itemIds).toEqual(['a', 'b']);
    st.getState().select(['b'], 'toggle');
    expect(st.getState().selection.itemIds).toEqual([]);
  });

  it('ignores unknown ids', () => {
    const st = st0();
    st.getState().select(['zzz', 'a']);
    expect(st.getState().selection.itemIds).toEqual(['a']);
  });

  it('selectAll (project / track), clear, selectTrack, selectKeyframe', () => {
    const st = st0();
    st.getState().selectAll();
    expect(st.getState().selection.itemIds.length).toBe(3 + 1 + 1 + 1);
    st.getState().selectAll('v1');
    expect(st.getState().selection.itemIds).toEqual(['a', 'b', 'c']);
    st.getState().selectKeyframe({ itemId: 'a', prop: 'transform.x', index: 0 });
    expect(st.getState().selection.keyframe).not.toBeNull();
    st.getState().clearSelection();
    expect(st.getState().selection.itemIds).toEqual([]);
    expect(st.getState().selection.keyframe).toBeNull();
    st.getState().selectTrack('m');
    expect(st.getState().selection.trackId).toBe('m');
  });

  it('selection never changes the document or history', () => {
    const st = st0();
    const p = st.getState().project;
    st.getState().select(['a']);
    st.getState().clearSelection();
    expect(st.getState().project).toBe(p);
    expect(st.getState().canUndo).toBe(false);
    expect(st.getState().saveState).toBe('idle');
  });
});

describe('transport', () => {
  const dur = () => projectDuration(base());

  it('setPlayhead clamps at 0; play / pause / toggle', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(-5);
    expect(st.getState().playheadSec).toBe(0);
    st.getState().togglePlay();
    expect(st.getState().playing).toBe(true);
    st.getState().pause();
    expect(st.getState().playing).toBe(false);
    expect(st.getState().rate).toBe(1);
  });

  it('tick advances by dt × rate', () => {
    const st = makeStore(base());
    st.getState().play();
    st.getState().tick(0.5);
    expect(st.getState().playheadSec).toBeCloseTo(0.5);
    st.getState().setRate(2);
    st.getState().tick(0.5);
    expect(st.getState().playheadSec).toBeCloseTo(1.5);
    st.getState().tick(0);
    st.getState().tick(-1);
    expect(st.getState().playheadSec).toBeCloseTo(1.5);
  });

  it('tick does nothing while paused', () => {
    const st = makeStore(base());
    st.getState().tick(1);
    expect(st.getState().playheadSec).toBe(0);
  });

  it('pauses at the project end (clamped) and resets rate', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(dur() - 0.1);
    st.getState().play();
    st.getState().setRate(4);
    st.getState().tick(1);
    expect(st.getState().playheadSec).toBe(dur());
    expect(st.getState().playing).toBe(false);
    expect(st.getState().rate).toBe(1);
  });

  it('loops at the end when loop is on', () => {
    const st = makeStore(base());
    st.getState().setLoop(true);
    st.getState().setPlayhead(dur() - 0.25);
    st.getState().play();
    st.getState().tick(1);
    expect(st.getState().playing).toBe(true);
    expect(st.getState().playheadSec).toBeCloseTo(0.75);
  });

  it('reverse playback stops at 0 or wraps in loop mode', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(0.5);
    st.getState().shuttle('J');
    st.getState().tick(2);
    expect(st.getState().playheadSec).toBe(0);
    expect(st.getState().playing).toBe(false);
    st.getState().setLoop(true);
    st.getState().setPlayhead(0.5);
    st.getState().shuttle('J');
    st.getState().tick(1);
    expect(st.getState().playheadSec).toBeCloseTo(dur() - 0.5);
    expect(st.getState().playing).toBe(true);
  });

  it('play at the end restarts from 0; an empty project cannot play', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(dur());
    st.getState().play();
    expect(st.getState().playheadSec).toBe(0);
    const e = createEditorStore();
    e.getState().play();
    e.getState().tick(1);
    expect(e.getState().playing).toBe(false);
    expect(e.getState().playheadSec).toBe(0);
  });

  it('shuttle: L ramps 1 → 2 → 4 → 8 and stays at 8; K pauses; J goes negative and ramps', () => {
    const st = makeStore(base());
    const seq: number[] = [];
    for (let i = 0; i < 5; i++) {
      st.getState().shuttle('L');
      seq.push(st.getState().rate);
    }
    expect(seq).toEqual([1, 2, 4, 8, 8]);
    expect(st.getState().playing).toBe(true);
    st.getState().shuttle('K');
    expect([st.getState().playing, st.getState().rate]).toEqual([false, 1]);
    const back: number[] = [];
    st.getState().setPlayhead(10);
    for (let i = 0; i < 4; i++) {
      st.getState().shuttle('J');
      back.push(st.getState().rate);
    }
    expect(back).toEqual([-1, -2, -4, -8]);
    st.getState().shuttle('L'); // reversing → L switches to forward 1×
    expect(st.getState().rate).toBe(1);
    st.getState().shuttle('J');
    expect(st.getState().rate).toBe(-1);
  });

  it('setRate clamps to ±8; 0 pauses', () => {
    const st = makeStore(base());
    st.getState().setRate(20);
    expect(st.getState().rate).toBe(8);
    st.getState().setRate(-20);
    expect(st.getState().rate).toBe(-8);
    st.getState().setRate(0);
    expect(st.getState().playing).toBe(false);
  });

  it('stepFrames is frame accurate at the project fps', () => {
    for (const fps of [24, 25, 30, 50, 60] as const) {
      const p = proj([track('v1', 'video', [V('a', 0, 20)])], { fps });
      const st = makeStore(p);
      st.getState().setPlayhead(1.0123); // off the grid
      st.getState().stepFrames(1);
      const frame = Math.round(st.getState().playheadSec * fps);
      expect(frame).toBe(Math.round(1.0123 * fps) + 1);
      expect(st.getState().playheadSec).toBeCloseTo(frame / fps, 12);
      for (let i = 0; i < 100; i++) st.getState().stepFrames(1);
      st.getState().stepFrames(-100);
      expect(st.getState().playheadSec * fps).toBeCloseTo(frame, 6);
    }
  });

  it('stepFrames(10) and negative steps, clamped to [0, end]; pauses playback', () => {
    const st = makeStore(base());
    st.getState().play();
    st.getState().stepFrames(10);
    expect(st.getState().playing).toBe(false);
    expect(st.getState().playheadSec).toBeCloseTo(10 / 30);
    st.getState().stepFrames(-1000);
    expect(st.getState().playheadSec).toBe(0);
    st.getState().stepFrames(100000);
    expect(st.getState().playheadSec).toBeLessThanOrEqual(dur());
    expect(st.getState().playheadSec).toBeGreaterThan(dur() - 1 / 30 - 1e-9);
  });

  it('transport does not touch history or dirtiness', () => {
    const st = makeStore(base());
    st.getState().play();
    st.getState().tick(1);
    st.getState().stepFrames(3);
    st.getState().setZoom(200);
    expect(st.getState().canUndo).toBe(false);
    expect(st.getState().saveState).toBe('idle');
  });

  it('jumpToEdit goes to the neighbouring edit point', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    st.getState().jumpToEdit(1);
    expect(st.getState().playheadSec).toBe(3); // t1 end
    st.getState().jumpToEdit(1);
    expect(st.getState().playheadSec).toBe(5);
    st.getState().jumpToEdit(-1);
    expect(st.getState().playheadSec).toBe(3);
    st.getState().setPlayhead(0);
    st.getState().jumpToEdit(-1);
    expect(st.getState().playheadSec).toBe(0);
  });
});

describe('view state', () => {
  it('setZoom clamps to 1…600 and keeps the anchor fixed on screen', () => {
    const st = makeStore(base());
    st.getState().setScroll(10);
    st.getState().setZoom(200, 14); // anchor at x = (14-10)*100 = 400px
    const s = st.getState();
    expect(s.pxPerSec).toBe(200);
    expect((14 - s.scrollSec) * s.pxPerSec).toBeCloseTo(400);
    st.getState().setZoom(100000);
    expect(st.getState().pxPerSec).toBe(600);
    st.getState().setZoom(0);
    expect(st.getState().pxPerSec).toBe(1);
  });

  it('setZoom never scrolls before 0', () => {
    const st = makeStore(base());
    st.getState().setZoom(1, 0);
    expect(st.getState().scrollSec).toBe(0);
    st.getState().setScroll(-4);
    expect(st.getState().scrollSec).toBe(0);
  });

  it('zoomToFit fits the project into the viewport', () => {
    const st = makeStore(base());
    st.getState().zoomToFit(1000);
    expect(st.getState().pxPerSec).toBeCloseTo(1000 / (20 * 1.05));
    expect(st.getState().scrollSec).toBe(0);
    const e = createEditorStore();
    e.getState().zoomToFit(1000);
    expect(e.getState().pxPerSec).toBeLessThanOrEqual(600);
  });

  it('toggles', () => {
    const st = makeStore(base());
    st.getState().toggleSnap();
    expect(st.getState().snapEnabled).toBe(false);
    st.getState().toggleRipple();
    expect(st.getState().rippleEnabled).toBe(true);
    st.getState().toggleGrid();
    expect(st.getState().showGrid).toBe(true);
    st.getState().setSafeArea('tiktok');
    expect(st.getState().safeArea).toBe('tiktok');
    st.getState().setSafeArea(null);
    expect(st.getState().safeArea).toBeNull();
  });

  it('rename changes the name without history', () => {
    const st = makeStore(base());
    st.getState().rename('My edit');
    expect(st.getState().name).toBe('My edit');
    expect(st.getState().canUndo).toBe(false);
  });
});

describe('extras', () => {
  it('trimToPlayhead trims the selected items (or the item under the playhead)', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(3);
    st.getState().trimToPlayhead('end');
    expect(item(st.getState().project, 'a').durationSec).toBe(3);
    st.getState().setPlayhead(2);
    st.getState().select(['a', 'm1']);
    st.getState().trimToPlayhead('start');
    expect(item(st.getState().project, 'a').startSec).toBe(2);
    expect(item(st.getState().project, 'm1').startSec).toBe(2);
    st.getState().undo();
    expect(item(st.getState().project, 'a').startSec).toBe(0);
    expect(item(st.getState().project, 'm1').startSec).toBe(0);
  });

  it('trimToPlayhead with ripple closes up', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(3);
    st.getState().trimToPlayhead('end', { ripple: true });
    expect(spans(st.getState().project, 'v1')).toEqual([[0, 3], [3, 8], [10, 13]]);
  });

  it('freezeAtPlayhead freezes the video item under the playhead', () => {
    const st = makeStore(base());
    st.getState().setPlayhead(2);
    st.getState().freezeAtPlayhead(1.5);
    expect(spans(st.getState().project, 'v1')).toEqual([[0, 2], [2, 3.5], [3.5, 6.5], [6.5, 11.5], [13.5, 16.5]]);
    const q = createEditorStore();
    q.getState().freezeAtPlayhead();
    expect(q.getState().canUndo).toBe(false);
  });

  it('nudgeSelected moves by whole frames and coalesces rapid nudges', () => {
    const clock = fakeClock();
    const st = makeStore(base(), { clock });
    st.getState().select(['c']);
    st.getState().nudgeSelected(1);
    clock.advance(100);
    st.getState().nudgeSelected(10);
    expect(item(st.getState().project, 'c').startSec).toBeCloseTo(12 + 11 / 30);
    st.getState().undo();
    expect(item(st.getState().project, 'c').startSec).toBe(12);
  });

  it('nudgeSelected refuses to overlap or go below 0', () => {
    const st = makeStore(base());
    st.getState().select(['a']);
    st.getState().nudgeSelected(-5);
    expect(item(st.getState().project, 'a').startSec).toBe(0);
    st.getState().select(['a']);
    st.getState().nudgeSelected(3);
    expect(item(st.getState().project, 'a').startSec).toBe(0); // would hit b
  });

  it('deleteSelection removes a selected keyframe first, else the selected items', () => {
    const st = makeStore(base());
    st.getState().addKeyframe('a', 'transform.x', 1, 5);
    st.getState().select(['a']);
    st.getState().selectKeyframe({ itemId: 'a', prop: 'transform.x', index: 0 });
    st.getState().deleteSelection();
    expect(items(st.getState().project, 'v1').length).toBe(3);
    expect((item(st.getState().project, 'a') as VideoItem).transform.x.kf).toEqual([]);
    st.getState().deleteSelection();
    expect(items(st.getState().project, 'v1').length).toBe(2);
  });
});
