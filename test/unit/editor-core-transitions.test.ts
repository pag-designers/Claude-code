import { describe, expect, it } from 'vitest';
import type { VideoItem } from '@shared/editor';
import { activeOnTrack } from '@shared/editor-eval';
import {
  projectProblems,
  setTransitionOp,
  deleteItemsOp,
  trimOp,
} from '../../renderer/lib/editor/core/ops';
import { A, I, V, item, items, proj, spans, track } from './editor-core-fixtures';

const healthy = (p: Parameters<typeof projectProblems>[0]) =>
  expect(projectProblems(p)).toEqual([]);
const xf = (d: number, type: 'crossfade' | 'slide-left' | 'dip-black' = 'crossfade') => ({
  type,
  durationSec: d,
});

const three = () =>
  proj([
    track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 10 }), V('c', 10, 4, { inSec: 20 })]),
  ]);

describe('setTransition — apply', () => {
  it('moves the later item earlier by the duration (no ripple: followers stay)', () => {
    const r = setTransitionOp(three(), 'b', xf(1), false);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [4, 9],
      [10, 14],
    ]);
    expect((item(r, 'b') as VideoItem).transitionIn).toEqual(xf(1));
    healthy(r);
  });

  it('ripple moves everything after it as well', () => {
    const r = setTransitionOp(three(), 'b', xf(1), true);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [4, 9],
      [9, 13],
    ]);
    healthy(r);
  });

  it('keeps startSec ordering and evaluates as an overlap in the shared evaluator', () => {
    const r = setTransitionOp(three(), 'b', xf(1, 'slide-left'), true);
    const act = activeOnTrack(r.tracks[0] as never, 4.5);
    expect(act.transition?.type).toBe('slide-left');
    expect(act.transition?.progress).toBeCloseTo(0.5);
    const starts = items(r, 'v1').map((i) => i.startSec);
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it('closes a gap between the pair', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 8, 4, { inSec: 3 })])]);
    const r = setTransitionOp(p, 'b', xf(1), false);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [4, 8],
    ]);
    healthy(r);
  });

  it('clamps the duration to the earlier item (no room)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 0.5), V('b', 0.5, 5, { inSec: 3 })])]);
    const r = setTransitionOp(p, 'b', xf(2), false);
    const d = (item(r, 'b') as VideoItem).transitionIn?.durationSec as number;
    expect(d).toBeLessThanOrEqual(0.46 + 1e-9);
    expect(d).toBeGreaterThanOrEqual(0.05);
    healthy(r);
  });

  it('clamps to the later item too, leaving room for its own outgoing transition', () => {
    const p = proj([
      track('v1', 'video', [
        V('a', 0, 5),
        V('b', 4, 2, { inSec: 3, transitionIn: xf(1) }),
        V('c', 5.5, 3, { inSec: 9, transitionIn: xf(0.5) }),
      ]),
    ]);
    healthy(p);
    const r = setTransitionOp(p, 'b', xf(4), false);
    healthy(r);
    expect((item(r, 'b') as VideoItem).transitionIn!.durationSec).toBeLessThan(2);
  });

  it('does nothing when even the minimum would not fit', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 0.06), V('b', 0.06, 2)])]);
    expect(setTransitionOp(p, 'b', xf(1), false)).toBe(p);
  });

  it('is not allowed on the first item, on locked tracks, or for items without transitionIn', () => {
    const p = three();
    expect(setTransitionOp(p, 'a', xf(1), false)).toBe(p);
    const l = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)], { locked: true })]);
    expect(setTransitionOp(l, 'b', xf(1), false)).toBe(l);
    const t = proj([track('o', 'overlay', [I('i1', 0, 3), I('i2', 3, 3)])]);
    expect(setTransitionOp(t, 'i2', xf(1), false)).not.toBe(t); // images can have transitions
  });

  it('a "cut" is the same as no transition', () => {
    const p = three();
    expect(setTransitionOp(p, 'b', { type: 'cut', durationSec: 1 }, false)).toBe(p);
  });
});

describe('setTransition — change and remove', () => {
  const withX = () => setTransitionOp(three(), 'b', xf(1), true);

  it('changing the type keeps the geometry', () => {
    const r = setTransitionOp(withX(), 'b', xf(1, 'dip-black'), true);
    expect(spans(r, 'v1')).toEqual(spans(withX(), 'v1'));
    expect((item(r, 'b') as VideoItem).transitionIn?.type).toBe('dip-black');
  });

  it('lengthening moves the item earlier again', () => {
    const r = setTransitionOp(withX(), 'b', xf(2), true);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [3, 8],
      [8, 12],
    ]);
    healthy(r);
  });

  it('shortening moves it back later', () => {
    const r = setTransitionOp(withX(), 'b', xf(0.5), true);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [4.5, 9.5],
      [9.5, 13.5],
    ]);
    healthy(r);
  });

  it('removing restores adjacency (later item + followers shift back right)', () => {
    const r = setTransitionOp(withX(), 'b', null, true);
    expect(spans(r, 'v1')).toEqual(spans(three(), 'v1'));
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('removing without ripple pushes only what now collides', () => {
    const noRipple = setTransitionOp(three(), 'b', xf(1), false); // a|b overlap, b..c gap of 1
    const r = setTransitionOp(noRipple, 'b', null, false);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [5, 10],
      [10, 14],
    ]); // c was exactly adjacent after b again
    healthy(r);
    const rippled = setTransitionOp(withX(), 'b', null, false); // c at 9 → pushed to 10
    expect(spans(rippled, 'v1')).toEqual([
      [0, 5],
      [5, 10],
      [10, 14],
    ]);
    healthy(rippled);
  });

  it('removing a transition that does not exist changes nothing', () => {
    const p = three();
    expect(setTransitionOp(p, 'b', null, true)).toBe(p);
  });

  it('shortening without ripple cannot grow into the following item', () => {
    const p = proj([
      track('v1', 'video', [
        V('a', 0, 5),
        V('b', 4, 5, { inSec: 10, transitionIn: xf(1) }),
        V('c', 9, 3, { inSec: 20 }),
      ]),
    ]);
    healthy(p);
    const r = setTransitionOp(p, 'b', xf(0.5), false);
    healthy(r);
    const b = item(r, 'b') as VideoItem;
    expect(b.startSec + b.durationSec).toBeLessThanOrEqual(9 + 1e-9);
  });
});

describe('moves, trims and deletes keep or cleanly drop transitions', () => {
  const chain = () =>
    setTransitionOp(setTransitionOp(three(), 'b', xf(1), true), 'c', xf(1, 'slide-left'), true);

  it('chain is healthy', () => {
    const c = chain();
    expect(spans(c, 'v1')).toEqual([
      [0, 5],
      [4, 9],
      [8, 12],
    ]);
    healthy(c);
  });

  it("deleting the earlier item removes the later item's transition", () => {
    const r = deleteItemsOp(chain(), ['a']);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('deleting the middle item removes the next transition (b gone → c has no partner)', () => {
    const r = deleteItemsOp(chain(), ['b']);
    expect((item(r, 'c') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it("ripple deleting the middle item closes up to the neighbour's end", () => {
    const r = deleteItemsOp(chain(), ['b'], 'track');
    healthy(r);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [5, 9],
    ]);
  });

  it('deleting the later item leaves the first intact', () => {
    const r = deleteItemsOp(chain(), ['c']);
    expect(items(r, 'v1').length).toBe(2);
    healthy(r);
  });

  it('the transitions survive trimming the far ends', () => {
    const r = trimOp(trimOp(chain(), 'a', 'start', 0.5), 'c', 'end', 13);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1);
    expect((item(r, 'c') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1);
    healthy(r);
  });

  it('audio items never carry transitions', () => {
    const p = proj([track('m', 'audio', [A('m1', 0, 5), A('m2', 5, 5)])]);
    expect(setTransitionOp(p, 'm2', xf(1), false)).toBe(p);
  });
});
