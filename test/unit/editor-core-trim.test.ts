import { describe, expect, it } from 'vitest';
import type { VideoItem, AudioItem, TextItem } from '@shared/editor';
import { makeSourceTime, sourceSpan, animatedAt } from '@shared/editor-eval';
import { trimOp, setSpeedOp, splitOp, projectProblems } from '../../renderer/lib/editor/core/ops';
import { A, T, V, asset, item, proj, spans, track, C } from './editor-core-fixtures';

const kf = (t: number, v: number, ease: 'linear' | 'hold' = 'linear') => ({ t, v, ease });
const anim = (v: number, ks: ReturnType<typeof kf>[] = []) => ({ v, kf: ks });
const healthy = (p: Parameters<typeof projectProblems>[0]) =>
  expect(projectProblems(p)).toEqual([]);

describe('trim — start edge', () => {
  it('changes startSec + inSec + duration so the content stays where it is', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 10, { inSec: 5 })])]);
    const r = trimOp(p, 'a', 'start', 4);
    const a = item(r, 'a') as VideoItem;
    expect(a.startSec).toBeCloseTo(4);
    expect(a.durationSec).toBeCloseTo(8);
    expect(a.inSec).toBeCloseTo(7);
    // the frame at timeline 6 is the same source frame before and after
    const before = makeSourceTime(item(p, 'a') as VideoItem)(6 - 2);
    const after = makeSourceTime(a)(6 - a.startSec);
    expect(after).toBeCloseTo(before);
    healthy(r);
  });

  it('respects speed when advancing inSec', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 0, speed: 2 })])]);
    const a = item(trimOp(p, 'a', 'start', 3), 'a') as VideoItem;
    expect(a.inSec).toBeCloseTo(6);
    expect(a.durationSec).toBeCloseTo(7);
  });

  it('extending the start is limited by the asset start (inSec)', () => {
    const p = proj([track('v1', 'video', [V('a', 10, 5, { inSec: 3 })])]);
    const a = item(trimOp(p, 'a', 'start', 0), 'a') as VideoItem;
    expect(a.inSec).toBeCloseTo(0);
    expect(a.startSec).toBeCloseTo(7);
    expect(a.durationSec).toBeCloseTo(8);
  });

  it('extending with speed 2 gives only inSec/speed seconds', () => {
    const p = proj([track('v1', 'video', [V('a', 10, 5, { inSec: 4, speed: 2 })])]);
    const a = item(trimOp(p, 'a', 'start', 0), 'a') as VideoItem;
    expect(a.startSec).toBeCloseTo(8);
    expect(a.inSec).toBeCloseTo(0);
  });

  it('cannot cross the previous item', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 10 })])]);
    const b = item(trimOp(p, 'b', 'start', 2), 'b');
    expect(b.startSec).toBeCloseTo(5);
    expect(trimOp(p, 'b', 'start', 2)).toBe(p);
  });

  it('cannot shrink below the 0.04 s minimum', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])]);
    const a = item(trimOp(p, 'a', 'start', 99), 'a');
    expect(a.durationSec).toBeCloseTo(0.04);
  });

  it('clamps at 0', () => {
    const p = proj([track('v1', 'video', [V('a', 1, 5, { inSec: 10 })])]);
    expect(item(trimOp(p, 'a', 'start', -4), 'a').startSec).toBeCloseTo(0);
  });

  it('images, text and shapes extend freely', () => {
    const p = proj([track('o', 'overlay', [T('t', 5, 2)])]);
    const t = item(trimOp(p, 't', 'start', 1), 't') as TextItem;
    expect(t.startSec).toBeCloseTo(1);
    expect(t.durationSec).toBeCloseTo(6);
  });

  it('reverse items keep inSec when the head is cut (the head is the top of the window)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 20, reverse: true })])]);
    const a = item(trimOp(p, 'a', 'start', 4), 'a') as VideoItem;
    expect(a.inSec).toBeCloseTo(20);
    expect(a.durationSec).toBeCloseTo(6);
    // frame at timeline 6 identical
    expect(makeSourceTime(a)(6 - a.startSec)).toBeCloseTo(
      makeSourceTime(item(p, 'a') as VideoItem)(6),
    );
  });

  it('a locked track rejects the edit and returns the same project', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(trimOp(p, 'a', 'start', 2)).toBe(p);
    const q = proj([track('v1', 'video', [V('a', 0, 5, { locked: true })])]);
    expect(trimOp(q, 'a', 'end', 2)).toBe(q);
  });
});

describe('trim — keyframes shift with a start trim', () => {
  const base = V('a', 0, 10, {
    transform: { opacity: anim(1, [kf(0, 0), kf(4, 1), kf(8, 0.5)]), x: anim(5) },
  });

  it('shifts item-local keyframe times down and keeps the animation continuous', () => {
    const p = proj([track('v1', 'video', [base])]);
    const r = item(trimOp(p, 'a', 'start', 2), 'a') as VideoItem;
    const o = r.transform.opacity;
    // value at timeline time 3 is unchanged: before local 3, after local 1
    expect(animatedAt(o, 1)).toBeCloseTo(animatedAt((base as VideoItem).transform.opacity, 3));
    expect(o.kf[0]?.t).toBe(0);
    expect(o.kf.map((k) => k.t)).toEqual([0, 2, 6]);
    expect(o.kf[0]?.v).toBeCloseTo(0.5);
  });

  it('drops keyframes before 0 and inserts an interpolated keyframe at 0', () => {
    const p = proj([track('v1', 'video', [base])]);
    const r = item(trimOp(p, 'a', 'start', 5), 'a') as VideoItem;
    const o = r.transform.opacity;
    expect(o.kf.length).toBe(2);
    expect(o.kf[0]).toMatchObject({ t: 0 });
    expect(o.kf[0]?.v).toBeCloseTo(1 + (0.5 - 1) * 0.25);
    expect(o.kf[1]).toMatchObject({ t: 3, v: 0.5 });
  });

  it('does not insert a keyframe when one lands exactly on the new start', () => {
    const p = proj([track('v1', 'video', [base])]);
    const r = item(trimOp(p, 'a', 'start', 4), 'a') as VideoItem;
    expect(r.transform.opacity.kf.map((k) => k.t)).toEqual([0, 4]);
  });

  it('a start trim past the last keyframe keeps one keyframe holding the final value', () => {
    const p = proj([track('v1', 'video', [base])]);
    const r = item(trimOp(p, 'a', 'start', 9), 'a') as VideoItem;
    expect(r.transform.opacity.kf).toEqual([{ t: 0, v: 0.5, ease: 'linear' }]);
  });

  it('extending the head shifts keyframes right', () => {
    const q = proj([
      track('v1', 'video', [
        V('a', 5, 10, { inSec: 5, transform: { opacity: anim(1, [kf(0, 0), kf(4, 1)]) } }),
      ]),
    ]);
    const r = item(trimOp(q, 'a', 'start', 3), 'a') as VideoItem;
    expect(r.transform.opacity.kf.map((k) => k.t)).toEqual([2, 6]);
  });

  it('shifts the speed ramp too', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 10, { speedCurve: [kf(0, 1), kf(10, 3)] })])]);
    const r = item(trimOp(q, 'a', 'start', 5), 'a') as VideoItem;
    expect(r.speedCurve[0]?.t).toBe(0);
    expect(r.speedCurve[0]?.v).toBeCloseTo(2);
    // continuity: source time at timeline 7 is the same
    const was = makeSourceTime(item(q, 'a') as VideoItem)(7);
    expect(makeSourceTime(r)(7 - r.startSec)).toBeCloseTo(was, 2);
  });
});

describe('trim — end edge', () => {
  it('changes only the duration and keeps keyframes beyond the end', () => {
    const a = V('a', 0, 10, { transform: { opacity: anim(1, [kf(0, 0), kf(9, 1)]) } });
    const p = proj([track('v1', 'video', [a])]);
    const r = item(trimOp(p, 'a', 'end', 4), 'a') as VideoItem;
    expect(r.durationSec).toBeCloseTo(4);
    expect(r.startSec).toBe(0);
    expect(r.inSec).toBe(0);
    expect(r.transform.opacity.kf.map((k) => k.t)).toEqual([0, 9]);
  });

  it('cannot extend past the asset (speed 1)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 50 })])]);
    const a = item(trimOp(p, 'a', 'end', 100), 'a');
    expect(a.durationSec).toBeCloseTo(10); // asset is 60 s, inSec 50 → exactly 10 s available
  });

  it('cannot extend past the asset at 2× speed (half the timeline time)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5, { inSec: 40, speed: 2 })])]);
    const a = item(trimOp(p, 'a', 'end', 100), 'a');
    expect(a.durationSec).toBeCloseTo(10); // (60-40)/2
  });

  it('respects a speed ramp when extending (bisection)', () => {
    const it0 = V('a', 0, 10, { inSec: 0, speedCurve: [kf(0, 2), kf(10, 2)] }); // 2x constant via ramp
    const p = proj([track('v1', 'video', [it0])], { assets: [asset('av', 'video', 30)] });
    const a = item(trimOp(p, 'a', 'end', 100), 'a') as VideoItem;
    expect(sourceSpan(a)).toBeLessThanOrEqual(30 + 1e-6);
    expect(a.durationSec).toBeGreaterThan(14.9);
    expect(a.durationSec).toBeLessThan(15.01);
  });

  it('reverse items extend the end by lowering inSec', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5, { inSec: 8, reverse: true })])]);
    const a = item(trimOp(p, 'a', 'end', 100), 'a') as VideoItem;
    expect(a.inSec).toBeCloseTo(0);
    expect(a.durationSec).toBeCloseTo(13);
    // first frame unchanged (top of window)
    expect(makeSourceTime(a)(0)).toBeCloseTo(makeSourceTime(item(p, 'a') as VideoItem)(0));
  });

  it('reverse items cut at the end raise inSec so the picture stays', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 8, reverse: true })])]);
    const a = item(trimOp(p, 'a', 'end', 6), 'a') as VideoItem;
    expect(a.inSec).toBeCloseTo(12);
    expect(makeSourceTime(a)(3)).toBeCloseTo(makeSourceTime(item(p, 'a') as VideoItem)(3));
  });

  it('cannot run into the next item', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 6, 4)])]);
    expect(item(trimOp(p, 'a', 'end', 9), 'a').durationSec).toBeCloseTo(6);
  });

  it('images extend freely up to the neighbour; asset duration is irrelevant', () => {
    const p = proj([track('v1', 'video', [{ ...V('x', 0, 1), type: 'video' } as VideoItem])]);
    expect(item(trimOp(p, 'x', 'end', 3), 'x').durationSec).toBeCloseTo(3);
  });

  it('keeps a minimum duration of 0.04', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 5)])]);
    expect(item(trimOp(p, 'a', 'end', 0), 'a').durationSec).toBeCloseTo(0.04);
  });

  it('unknown asset duration means unlimited extension', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])], {
      assets: [asset('av', 'video', null)],
    });
    expect(item(trimOp(p, 'a', 'end', 500), 'a').durationSec).toBeCloseTo(500);
  });

  it('subtitle cue words are clamped when the cue shrinks', () => {
    const p = proj([
      track('s', 'subtitle', [
        C('c', 0, 3, [
          ['a', 0, 1],
          ['b', 1, 2],
          ['c', 2, 3],
        ]),
      ]),
    ]);
    const c = item(trimOp(p, 'c', 'end', 1.5), 'c');
    expect(c.type === 'subtitle' && c.words.map((w) => [w.w, w.e])).toEqual([
      ['a', 1],
      ['b', 1.5],
    ]);
  });
});

describe('trim — ripple', () => {
  const p0 = () =>
    proj([
      track('v1', 'video', [V('a', 0, 5), V('b', 5, 5), V('c', 12, 3)]),
      track('m', 'audio', [A('m1', 0, 20), A('m2', 22, 3)]),
    ]);

  it('end ripple shifts later items on the track (shrink)', () => {
    const r = trimOp(p0(), 'a', 'end', 3, { ripple: 'track' });
    expect(spans(r, 'v1')).toEqual([
      [0, 3],
      [3, 8],
      [10, 13],
    ]);
    expect(spans(r, 'm')).toEqual([
      [0, 20],
      [22, 25],
    ]);
    healthy(r);
  });

  it('end ripple shifts later items (grow)', () => {
    const r = trimOp(p0(), 'a', 'end', 7, { ripple: 'track' });
    expect(spans(r, 'v1')).toEqual([
      [0, 7],
      [7, 12],
      [14, 17],
    ]);
  });

  it('ripple "all" shifts later items on other unlocked tracks too', () => {
    const r = trimOp(p0(), 'a', 'end', 3, { ripple: 'all' });
    expect(spans(r, 'm')).toEqual([
      [0, 20],
      [20, 23],
    ]);
    healthy(r);
  });

  it('ripple "all" leaves locked tracks alone', () => {
    const q = proj([
      track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]),
      track('m', 'audio', [A('m2', 7, 3)], { locked: true }),
    ]);
    const r = trimOp(q, 'a', 'end', 3, { ripple: 'all' });
    expect(spans(r, 'm')).toEqual([[7, 10]]);
  });

  it('ripple "all" skips a track where the shift would collide', () => {
    const q = proj([
      track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]),
      track('m', 'audio', [A('m1', 0, 6.5), A('m2', 7, 3)]),
    ]);
    const r = trimOp(q, 'a', 'end', 1, { ripple: 'all' }); // shift -4: m2 would land at 3 inside m1
    expect(spans(r, 'm')).toEqual([
      [0, 6.5],
      [7, 10],
    ]);
    healthy(r);
  });

  it('head ripple keeps the start, removes the head and closes up', () => {
    const r = trimOp(p0(), 'b', 'start', 7, { ripple: 'track' });
    const b = item(r, 'b') as VideoItem;
    expect(b.startSec).toBeCloseTo(5);
    expect(b.durationSec).toBeCloseTo(3);
    expect(b.inSec).toBeCloseTo(2);
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [5, 8],
      [10, 13],
    ]);
  });

  it('head ripple can extend (earlier source) and pushes later items right', () => {
    const q = proj([
      track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 10 }), V('c', 10, 3)]),
    ]);
    const r = trimOp(q, 'b', 'start', 3, { ripple: 'track' });
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [5, 12],
      [12, 15],
    ]);
    expect((item(r, 'b') as VideoItem).inSec).toBeCloseTo(8);
  });

  it('ripple extension still stops at the asset boundary', () => {
    const q = proj([track('v1', 'video', [V('a', 0, 5, { inSec: 55 }), V('b', 5, 5)])]);
    const r = trimOp(q, 'a', 'end', 50, { ripple: 'track' });
    expect(item(r, 'a').durationSec).toBeCloseTo(5);
  });
});

describe('trim — roll', () => {
  it('moves the shared boundary of two adjacent items', () => {
    const p = proj([
      track('v1', 'video', [V('a', 0, 5, { inSec: 0 }), V('b', 5, 5, { inSec: 20 })]),
    ]);
    const r = trimOp(p, 'a', 'end', 7, { roll: true });
    expect(spans(r, 'v1')).toEqual([
      [0, 7],
      [7, 10],
    ]);
    const b = item(r, 'b') as VideoItem;
    expect(b.inSec).toBeCloseTo(22);
    healthy(r);
  });

  it('works from the start edge of the later item and backwards', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 20 })])]);
    const r = trimOp(p, 'b', 'start', 3, { roll: true });
    expect(spans(r, 'v1')).toEqual([
      [0, 3],
      [3, 10],
    ]);
    expect((item(r, 'b') as VideoItem).inSec).toBeCloseTo(18);
  });

  it('is limited by the source of the item that grows', () => {
    const p = proj([
      track('v1', 'video', [V('a', 0, 5, { inSec: 55 }), V('b', 5, 5, { inSec: 20 })]),
    ]);
    const r = trimOp(p, 'a', 'end', 9, { roll: true });
    expect(spans(r, 'v1')[0]?.[1]).toBeCloseTo(5);
  });

  it('is limited by the minimum duration of the shrinking item', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 5, 5, { inSec: 20 })])]);
    const r = trimOp(p, 'a', 'end', 99, { roll: true });
    expect(item(r, 'b').durationSec).toBeCloseTo(0.04);
    healthy(r);
  });

  it('falls back to a plain trim when there is no adjacent neighbour', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 8, 5)])]);
    const r = trimOp(p, 'a', 'end', 3, { roll: true });
    expect(spans(r, 'v1')).toEqual([
      [0, 3],
      [8, 13],
    ]);
  });

  it('rolls a transition pair keeping the overlap', () => {
    const p = proj([
      track('v1', 'video', [
        V('a', 0, 5),
        V('b', 4, 6, { inSec: 10, transitionIn: { type: 'crossfade', durationSec: 1 } }),
      ]),
    ]);
    const r = trimOp(p, 'a', 'end', 6, { roll: true });
    expect(spans(r, 'v1')).toEqual([
      [0, 6],
      [5, 10],
    ]);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1);
    healthy(r);
  });
});

describe('trim — transitions stay consistent', () => {
  const pair = () =>
    proj([
      track('v1', 'video', [
        V('a', 0, 5),
        V('b', 4, 6, { inSec: 10, transitionIn: { type: 'crossfade', durationSec: 1 } }),
        V('c', 12, 3),
      ]),
    ]);

  it('trimming the earlier item shorter shrinks the transition', () => {
    const r = trimOp(pair(), 'a', 'end', 4.5);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(0.5);
    healthy(r);
  });

  it('trimming the earlier item to before the later one drops the transition', () => {
    const r = trimOp(pair(), 'a', 'end', 3);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('a sub-minimum overlap collapses to adjacency (transition removed)', () => {
    const r = trimOp(pair(), 'a', 'end', 4.02);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    expect(item(r, 'a').durationSec).toBeCloseTo(4);
    healthy(r);
  });

  it('extending the earlier item into the later one lengthens the transition', () => {
    const r = trimOp(pair(), 'a', 'end', 5.5);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1.5);
    healthy(r);
  });

  it('extending the earlier item cannot swallow the later one', () => {
    const r = trimOp(pair(), 'a', 'end', 20);
    expect(item(r, 'a').durationSec).toBeLessThanOrEqual(4 + 6 - 0.04 + 1e-6);
    healthy(r);
  });

  it('cutting the later item start past the overlap drops the transition', () => {
    const r = trimOp(pair(), 'b', 'start', 5.5);
    expect((item(r, 'b') as VideoItem).transitionIn).toBeNull();
    healthy(r);
  });

  it('extending the later item start grows the transition', () => {
    const r = trimOp(pair(), 'b', 'start', 3);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(2);
    healthy(r);
  });

  it('ripple end-trim moves the whole chain', () => {
    const r = trimOp(pair(), 'a', 'end', 3, { ripple: 'track' });
    expect(spans(r, 'v1')).toEqual([
      [0, 3],
      [2, 8],
      [10, 13],
    ]);
    expect((item(r, 'b') as VideoItem).transitionIn?.durationSec).toBeCloseTo(1);
    healthy(r);
  });

  it('the middle item of a chain cannot be trimmed shorter than its two transitions', () => {
    const q = proj([
      track('v1', 'video', [
        V('a', 0, 5),
        V('b', 4, 4, { inSec: 10, transitionIn: { type: 'crossfade', durationSec: 1 } }),
        V('c', 7, 4, { inSec: 20, transitionIn: { type: 'dip-black', durationSec: 1 } }),
      ]),
    ]);
    const r = trimOp(q, 'b', 'end', 4.1, { ripple: 'track' });
    expect(item(r, 'b').durationSec).toBeGreaterThanOrEqual(2.04 - 1e-6);
    healthy(r);
  });
});

describe('setSpeed', () => {
  it('keeps the source span (duration changes)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 5 })])]);
    const a = item(setSpeedOp(p, 'a', 2), 'a') as VideoItem;
    expect(a.speed).toBe(2);
    expect(a.durationSec).toBeCloseTo(5);
    expect(a.inSec).toBe(5);
    expect(sourceSpan(a)).toBeCloseTo(10);
  });

  it('slowing down lengthens (0.5×)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)])]);
    expect(item(setSpeedOp(p, 'a', 0.5), 'a').durationSec).toBeCloseTo(20);
  });

  it('keepDuration consumes more source instead', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)])]);
    const a = item(setSpeedOp(p, 'a', 3, { keepDuration: true }), 'a') as VideoItem;
    expect(a.durationSec).toBeCloseTo(10);
    expect(sourceSpan(a)).toBeCloseTo(30);
  });

  it('keepDuration is shortened to fit the asset', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { inSec: 40 })])]);
    const a = item(setSpeedOp(p, 'a', 4, { keepDuration: true }), 'a') as VideoItem;
    expect(a.durationSec).toBeCloseTo(5); // (60-40)/4
  });

  it('clamps to 0.1–10', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)])]);
    expect((item(setSpeedOp(p, 'a', 99), 'a') as VideoItem).speed).toBe(10);
    expect((item(setSpeedOp(p, 'a', 0.001), 'a') as VideoItem).speed).toBe(0.1);
  });

  it('a longer result cannot run into the next item (source window shortened)', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5), V('b', 7, 3)])]);
    const a = item(setSpeedOp(p, 'a', 0.5), 'a') as VideoItem;
    expect(a.durationSec).toBeCloseTo(7);
    healthy(setSpeedOp(p, 'a', 0.5));
  });

  it('ripple moves later items with the new end', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10), V('b', 10, 4)])]);
    const r = setSpeedOp(p, 'a', 2, { ripple: 'track' });
    expect(spans(r, 'v1')).toEqual([
      [0, 5],
      [5, 9],
    ]);
  });

  it('replaces a speed ramp by the constant speed', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10, { speedCurve: [kf(0, 1), kf(10, 2)] })])]);
    const a = item(setSpeedOp(p, 'a', 1), 'a') as VideoItem;
    expect(a.speedCurve).toEqual([]);
  });

  it('works on audio items and ignores images/text', () => {
    const p = proj([track('m', 'audio', [A('m1', 0, 8)])]);
    expect((item(setSpeedOp(p, 'm1', 2), 'm1') as AudioItem).durationSec).toBeCloseTo(4);
    const q = proj([track('o', 'overlay', [T('t', 0, 2)])]);
    expect(setSpeedOp(q, 't', 2)).toBe(q);
  });

  it('is a no-op on locked tracks', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)], { locked: true })]);
    expect(setSpeedOp(p, 'a', 2)).toBe(p);
  });
});

describe('trim — misc', () => {
  it('no-op trims return the same project reference', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])]);
    expect(trimOp(p, 'a', 'end', 5)).toBe(p);
    expect(trimOp(p, 'a', 'start', 0)).toBe(p);
    expect(trimOp(p, 'nope', 'start', 1)).toBe(p);
    expect(trimOp(p, 'a', 'end', Number.NaN)).toBe(p);
  });

  it('structural sharing: untouched tracks keep their identity', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)]), track('m', 'audio', [A('m1', 0, 5)])]);
    const r = trimOp(p, 'a', 'end', 3);
    expect(r.tracks[1]).toBe(p.tracks[1]);
    expect(r.tracks[0]).not.toBe(p.tracks[0]);
  });
});

describe('property: trimming and splitting never move the picture', () => {
  // deterministic LCG
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const f = (lo: number, hi: number) => lo + rnd() * (hi - lo);

  it('start trim, end trim and split keep the source frame at every surviving timeline time', () => {
    for (let n = 0; n < 150; n++) {
      const dur = f(1, 12);
      const ramp = rnd() < 0.3;
      const it = V('a', f(0, 5), dur, {
        inSec: f(5, 25),
        speed: ramp ? 1 : [0.5, 1, 1, 2, 1.5][Math.floor(rnd() * 5)],
        reverse: rnd() < 0.4,
        speedCurve: ramp ? [kf(0, f(0.5, 2)), kf(dur, f(0.5, 2.5))] : [],
      }) as VideoItem;
      const p = proj([track('v1', 'video', [it])]);
      const was = makeSourceTime(it);
      const tol = ramp ? 0.03 : 1e-6;

      const s = f(it.startSec - 3, it.startSec + dur - 0.3);
      const r1 = item(trimOp(p, 'a', 'start', s), 'a') as VideoItem;
      const e = f(it.startSec + 0.3, it.startSec + dur + 3);
      const r2 = item(trimOp(p, 'a', 'end', e), 'a') as VideoItem;
      const at = f(it.startSec + 0.1, it.startSec + dur - 0.1);
      const halves = splitOp(p, ['a'], at).project.tracks[0]!.items as VideoItem[];

      for (const r of [r1, r2, ...halves]) {
        expect(sourceSpan(r) + r.inSec).toBeLessThanOrEqual(60 + 1e-3);
        expect(r.inSec).toBeGreaterThanOrEqual(0);
        for (let k = 0; k <= 8; k++) {
          const t = r.startSec + (r.durationSec * (k + 0.01)) / 8.02;
          const old = t - it.startSec;
          if (old < 0 || old > dur) continue; // extended region has no "before"
          expect(makeSourceTime(r)(t - r.startSec)).toBeCloseTo(was(old), tol < 1e-3 ? 5 : 1);
        }
      }
    }
  });
});
