import { describe, expect, it } from 'vitest';
import {
  itemFrames,
  makeGrid,
  trackFrames,
} from '../../../electron/main/services/editor-export/timeline';
import { isActive } from '../../../shared/editor-eval';
import { makeProject, track, vitem } from './helpers';

const item = (startSec: number, durationSec: number) => ({ startSec, durationSec });

describe('frame grid', () => {
  it('n = round(duration * fps), min 1; frame times start at r0', () => {
    const g = makeGrid(30, 2, 1);
    expect(g.n).toBe(30);
    expect(g.time(0)).toBe(2);
    expect(g.time(15)).toBeCloseTo(2.5, 12);
    expect(g.out(15)).toBe(0.5);
    expect(makeGrid(30, 0, 0.001).n).toBe(1);
    expect(makeGrid(24, 0, 10.02).n).toBe(240);
  });

  it('itemFrames follows the evaluator half-open rule exactly', () => {
    const g = makeGrid(30, 0, 5);
    for (const [s, d] of [
      [0, 1],
      [0.5, 1],
      [0.41, 1],
      [1 / 30, 2 / 30],
      [2.2, 0.0667],
      [1.0 / 3, 1 / 3],
    ] as const) {
      const it0 = item(s, d);
      const fr = itemFrames(g, it0);
      const brute: number[] = [];
      for (let j = 0; j < g.n; j++) if (isActive(it0, g.time(j))) brute.push(j);
      if (brute.length === 0) expect(fr).toBeNull();
      else expect([fr?.ja, fr?.jb]).toEqual([brute[0], (brute[brute.length - 1] as number) + 1]);
    }
  });

  it('an item outside the window has no frames; one straddling the window is clipped', () => {
    const g = makeGrid(30, 10, 2); // timeline 10..12
    expect(itemFrames(g, item(0, 5))).toBeNull();
    expect(itemFrames(g, item(13, 1))).toBeNull();
    expect(itemFrames(g, item(9, 2))).toEqual({ ja: 0, jb: 30 });
    expect(itemFrames(g, item(11.5, 5))).toEqual({ ja: 45, jb: 60 });
  });

  it('range start not on the frame grid: frame j is at r0 + j/fps', () => {
    const g = makeGrid(30, 1.0123, 1);
    expect(g.time(3)).toBeCloseTo(1.0123 + 0.1, 12);
    const fr = itemFrames(g, item(1.2, 0.5));
    expect(fr).not.toBeNull();
    expect(g.time((fr as { ja: number }).ja)).toBeGreaterThanOrEqual(1.2 - 1e-6);
    expect(g.time((fr as { ja: number }).ja - 1)).toBeLessThan(1.2);
  });
});

describe('trackFrames (activeOnTrack + transitionOps per frame)', () => {
  const specs = [{ id: 'q', kind: 'video' as const, path: '/x.mp4', w: 10, h: 10 }];
  const build = (type: string) =>
    makeProject(
      [
        track('video', [
          vitem('a', 'q', 0, 1),
          vitem('b', 'q', 0.5, 1, { transitionIn: { type, durationSec: 0.5 } }),
        ]),
      ],
      specs,
    ).tracks[0]!;

  it('crossfade: ops on both items only inside the overlap, p = (t - start)/dur', () => {
    const g = makeGrid(30, 0, 1.5);
    const tf = trackFrames(build('crossfade'), g);
    const a = tf.items.get('a')!;
    const b = tf.items.get('b')!;
    expect(a.ja).toBe(0);
    expect(a.jb).toBe(30);
    expect(a.ops[14]).toBeNull();
    expect(a.ops[15]?.opacity).toBe(1);
    expect(b.ops[0]?.opacity).toBe(0); // p = 0
    expect(b.ops[7]?.opacity).toBeCloseTo(7 / 15, 9);
    expect(b.ops[15]).toBeNull(); // overlap over
  });

  it('dip transitions carry a veil that ramps 0 → 1 → 0', () => {
    const tf = trackFrames(build('dip-black'), makeGrid(30, 0, 1.5));
    const v = (j: number) => tf.veils.get(j)?.alpha;
    expect(v(14)).toBeUndefined();
    expect(v(15)).toBe(0);
    expect(v(22)).toBeCloseTo((7 / 15) * 2, 9);
    expect(v(29)).toBeCloseTo((1 - 14 / 15) * 2, 9);
  });

  it("'cut' with an overlap hides the outgoing item", () => {
    const tf = trackFrames(build('cut'), makeGrid(30, 0, 1.5));
    const a = tf.items.get('a')!;
    expect(a.hidden[14]).toBe(false);
    expect(a.hidden[15]).toBe(true);
    expect(a.hidden[29]).toBe(true);
  });

  it('without an overlap nothing carries ops', () => {
    const t = makeProject(
      [
        track('video', [
          vitem('a', 'q', 0, 0.5),
          vitem('b', 'q', 0.5, 0.5, { transitionIn: { type: 'crossfade', durationSec: 0.3 } }),
        ]),
      ],
      specs,
    ).tracks[0]!;
    const tf = trackFrames(t, makeGrid(30, 0, 1));
    expect(tf.items.get('a')!.ops.every((o) => o === null)).toBe(true);
    expect(tf.items.get('b')!.ops.every((o) => o === null)).toBe(true);
    expect(tf.veils.size).toBe(0);
  });
});
