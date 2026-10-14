import { describe, expect, it } from 'vitest';
import type { SubtitleItem, TextItem, VideoItem } from '@shared/editor';
import { animatedAt, makeSourceTime, sourceSpan } from '@shared/editor-eval';
import { freezeFrameOp, projectProblems, splitItemAt, splitOp } from '../../renderer/lib/editor/core/ops';
import { A, C, T, V, I, item, items, proj, spans, track } from './editor-core-fixtures';

const kf = (t: number, v: number, ease: 'linear' | 'hold' = 'linear') => ({ t, v, ease });
const anim = (v: number, ks: ReturnType<typeof kf>[] = []) => ({ v, kf: ks });
const healthy = (p: Parameters<typeof projectProblems>[0]) => expect(projectProblems(p)).toEqual([]);

describe('split — geometry and source mapping', () => {
  it('splits a clip into two adjacent pieces; the right half advances inSec', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 10, { inSec: 5 })])]);
    const { project: r, newIds } = splitOp(p, ['a'], 6);
    expect(newIds.length).toBe(1);
    const [l, rt] = items(r, 'v1') as VideoItem[];
    expect([l?.startSec, l?.durationSec, l?.inSec]).toEqual([2, 4, 5]);
    expect([rt?.startSec, rt?.durationSec]).toEqual([6, 6]);
    expect(rt?.inSec).toBeCloseTo(9);
    expect(rt?.id).toBe(newIds[0]);
    expect(l?.id).toBe('a');
    healthy(r);
  });

  it('the picture on both sides of the cut is the original picture', () => {
    const a = V('a', 0, 10, { inSec: 3, speed: 1.5 });
    const p = proj([track('v1', 'video', [a])]);
    const r = splitOp(p, ['a'], 4).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    const orig = makeSourceTime(a);
    for (const t of [0.5, 2, 3.9]) expect(makeSourceTime(l as VideoItem)(t)).toBeCloseTo(orig(t));
    for (const t of [4.1, 7, 9.9]) expect(makeSourceTime(rt as VideoItem)(t - 4)).toBeCloseTo(orig(t));
  });

  it('speed ramps: both halves reproduce the original source times', () => {
    const a = V('a', 0, 10, { inSec: 2, speedCurve: [kf(0, 1), kf(10, 3)] });
    const p = proj([track('v1', 'video', [a])]);
    const r = splitOp(p, ['a'], 6).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    const orig = makeSourceTime(a);
    for (const t of [1, 3, 5.5]) expect(makeSourceTime(l as VideoItem)(t)).toBeCloseTo(orig(t), 1);
    for (const t of [6.5, 8, 9.9]) expect(makeSourceTime(rt as VideoItem)(t - 6)).toBeCloseTo(orig(t), 1);
    // total source span is preserved
    expect(sourceSpan(l as VideoItem) + sourceSpan(rt as VideoItem)).toBeCloseTo(sourceSpan(a), 1);
  });

  it('reverse: the right half in time is the EARLIER source window', () => {
    const a = V('a', 0, 10, { inSec: 20, reverse: true });
    const p = proj([track('v1', 'video', [a])]);
    const r = splitOp(p, ['a'], 4).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    expect(rt?.inSec).toBeCloseTo(20); // earlier window: [20, 26]
    expect(l?.inSec).toBeCloseTo(26); // later window: [26, 30]
    expect(rt?.reverse && l?.reverse).toBe(true);
    const orig = makeSourceTime(a);
    expect(makeSourceTime(l as VideoItem)(1)).toBeCloseTo(orig(1));
    expect(makeSourceTime(rt as VideoItem)(7 - 4)).toBeCloseTo(orig(7));
    expect(makeSourceTime(l as VideoItem)(0)).toBeCloseTo(orig(0));
  });

  it('reverse + speed 2', () => {
    const a = V('a', 0, 10, { inSec: 0, reverse: true, speed: 2 });
    const p = proj([track('v1', 'video', [a])]);
    const r = splitOp(p, ['a'], 3).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    const orig = makeSourceTime(a);
    expect(makeSourceTime(l as VideoItem)(1.5)).toBeCloseTo(orig(1.5));
    expect(makeSourceTime(rt as VideoItem)(8 - 3)).toBeCloseTo(orig(8));
  });

  it('freeze-frame items keep their freeze time on both halves', () => {
    const a = V('a', 0, 4, { freezeAtSec: 12 });
    const r = splitOp(proj([track('v1', 'video', [a])]), ['a'], 1).project;
    for (const it of items(r, 'v1') as VideoItem[]) expect(it.freezeAtSec).toBe(12);
  });

  it('audio items split the same way', () => {
    const p = proj([track('m', 'audio', [A('m1', 0, 10, { inSec: 4 })])]);
    const r = splitOp(p, ['m1'], 2.5).project;
    expect((items(r, 'm')[1] as { inSec: number }).inSec).toBeCloseTo(6.5);
  });

  it('refuses a split that would leave a half shorter than 0.04 s, or outside the item', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])]);
    expect(splitOp(p, ['a'], 0.01).project).toBe(p);
    expect(splitOp(p, ['a'], 4.99).project).toBe(p);
    expect(splitOp(p, ['a'], 0).project).toBe(p);
    expect(splitOp(p, ['a'], 9).project).toBe(p);
    expect(splitItemAt(V('x', 0, 5), 0.02, 'n')).toBeNull();
  });

  it('refuses locked items and tracks', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(splitOp(p, ['a'], 2).project).toBe(p);
    const q = proj([track('v1', 'video', [V('a', 0, 5, { locked: true })])]);
    expect(splitOp(q, ['a'], 2).project).toBe(q);
  });

  it('keeps group ids on both halves', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5, { groupId: 'g1' })])]);
    const r = items(splitOp(p, ['a'], 2).project, 'v1');
    expect(r.map((i) => i.groupId)).toEqual(['g1', 'g1']);
  });

  it('splits several items at once on different tracks', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10)]), track('m', 'audio', [A('m1', 0, 10)])]);
    const r = splitOp(p, ['a', 'm1'], 5);
    expect(r.newIds.length).toBe(2);
    expect(items(r.project, 'v1').length).toBe(2);
    expect(items(r.project, 'm').length).toBe(2);
  });

  it('images, text and shapes split too', () => {
    const p = proj([track('o', 'overlay', [I('i', 0, 4), T('t', 4, 4)])]);
    const r = splitOp(p, ['i', 't'], 5).project; // only t crosses
    expect(items(r, 'o').length).toBe(3);
    expect(splitOp(p, ['i'], 2).project.tracks[0]?.items.length).toBe(3);
  });
});

describe('split — keyframes, fades, transitions, animations', () => {
  it('redistributes keyframes: right shifted with an interpolated key at 0, left gets one at its end', () => {
    const a = V('a', 0, 10, { transform: { opacity: anim(1, [kf(0, 0), kf(10, 1)]) } });
    const r = splitOp(proj([track('v1', 'video', [a])]), ['a'], 4).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    expect(l?.transform.opacity.kf).toEqual([kf(0, 0), kf(4, 0.4)]);
    expect(rt?.transform.opacity.kf.length).toBe(2);
    expect(rt?.transform.opacity.kf[0]).toMatchObject({ t: 0 });
    expect(rt?.transform.opacity.kf[0]?.v).toBeCloseTo(0.4);
    expect(rt?.transform.opacity.kf[1]).toMatchObject({ t: 6, v: 1 });
  });

  it('the animation continues unchanged across the cut', () => {
    const a = V('a', 0, 10, {
      transform: { x: anim(0, [kf(0, 0), kf(5, 100), kf(10, -50)]), scale: anim(1, [kf(2, 1), kf(8, 2)]) },
    });
    const r = splitOp(proj([track('v1', 'video', [a])]), ['a'], 3.5).project;
    const [l, rt] = items(r, 'v1') as VideoItem[];
    for (const t of [0.5, 2, 3.4]) {
      expect(animatedAt((l as VideoItem).transform.x, t)).toBeCloseTo(animatedAt(a.transform.x, t));
      expect(animatedAt((l as VideoItem).transform.scale, t)).toBeCloseTo(animatedAt(a.transform.scale, t));
    }
    for (const t of [3.6, 5, 9.9]) {
      expect(animatedAt((rt as VideoItem).transform.x, t - 3.5)).toBeCloseTo(animatedAt(a.transform.x, t));
      expect(animatedAt((rt as VideoItem).transform.scale, t - 3.5)).toBeCloseTo(animatedAt(a.transform.scale, t));
    }
  });

  it('static properties are copied to both halves untouched', () => {
    const a = V('a', 0, 10, { transform: { x: anim(42) } });
    const [l, rt] = items(splitOp(proj([track('v1', 'video', [a])]), ['a'], 5).project, 'v1') as VideoItem[];
    expect(l?.transform.x).toEqual(anim(42));
    expect(rt?.transform.x).toEqual(anim(42));
  });

  it('keyframes entirely on one side: the other side keeps a held value', () => {
    const a = V('a', 0, 10, { transform: { opacity: anim(1, [kf(8, 0), kf(9, 1)]) } });
    const [l, rt] = items(splitOp(proj([track('v1', 'video', [a])]), ['a'], 4).project, 'v1') as VideoItem[];
    expect(animatedAt((l as VideoItem).transform.opacity, 2)).toBeCloseTo(0);
    expect((rt as VideoItem).transform.opacity.kf.map((k) => k.t)).toEqual([4, 5]);
  });

  it('fadeIn stays on the left half, fadeOut on the right half', () => {
    const a = V('a', 0, 10, { fadeInSec: 1, fadeOutSec: 2 });
    const [l, rt] = items(splitOp(proj([track('v1', 'video', [a])]), ['a'], 5).project, 'v1') as VideoItem[];
    expect([l?.fadeInSec, l?.fadeOutSec]).toEqual([1, 0]);
    expect([rt?.fadeInSec, rt?.fadeOutSec]).toEqual([0, 2]);
  });

  it('transitionIn stays on the left half; the right half has none', () => {
    const p = proj([
      track('v1', 'video', [V('x', 0, 5), V('a', 4, 10, { inSec: 3, transitionIn: { type: 'crossfade', durationSec: 1 } })]),
    ]);
    const r = splitOp(p, ['a'], 8).project;
    const [, l, rt] = items(r, 'v1') as VideoItem[];
    expect(l?.transitionIn).toMatchObject({ type: 'crossfade', durationSec: 1 });
    expect(rt?.transitionIn).toBeNull();
    healthy(r);
  });

  it('a split inside the transition overlap is refused', () => {
    const p = proj([
      track('v1', 'video', [V('x', 0, 5), V('a', 4, 10, { inSec: 3, transitionIn: { type: 'crossfade', durationSec: 1 } })]),
    ]);
    expect(splitOp(p, ['a'], 4.5).project).toBe(p);
    expect(splitOp(p, ['x'], 4.5).project).toBe(p); // x's tail is the overlap too
    healthy(splitOp(p, ['x'], 3).project);
  });

  it('the next item\'s transition attaches to the right half', () => {
    const p = proj([
      track('v1', 'video', [V('a', 0, 10), V('b', 9, 5, { inSec: 3, transitionIn: { type: 'dip-black', durationSec: 1 } })]),
    ]);
    const r = splitOp(p, ['a'], 5).project;
    healthy(r);
    expect(items(r, 'v1').length).toBe(3);
  });

  it('text: animIn stays left, animOut goes right', () => {
    const t = T('t', 0, 6, { animIn: { type: 'pop', durationSec: 0.4 }, animOut: { type: 'fade', durationSec: 0.5 } });
    const [l, rt] = items(splitOp(proj([track('o', 'overlay', [t])]), ['t'], 3).project, 'o') as TextItem[];
    expect([l?.animIn.type, l?.animOut.type]).toEqual(['pop', 'none']);
    expect([rt?.animIn.type, rt?.animOut.type]).toEqual(['none', 'fade']);
  });

  it('long fades are clamped to the half they live on', () => {
    const a = V('a', 0, 10, { fadeInSec: 6, fadeOutSec: 6 });
    const [l, rt] = items(splitOp(proj([track('v1', 'video', [a])]), ['a'], 2).project, 'v1') as VideoItem[];
    expect(l?.fadeInSec).toBeCloseTo(2);
    expect(rt?.fadeOutSec).toBeCloseTo(6);
  });
});

describe('split — subtitle cues', () => {
  const cue = C('c', 10, 4, [
    ['one', 0, 0.8],
    ['two', 0.9, 1.7],
    ['three', 1.8, 2.6],
    ['four', 2.8, 3.9],
  ]);

  it('divides words at the time', () => {
    const r = splitOp(proj([track('s', 'subtitle', [cue])]), ['c'], 12).project;
    const [l, rt] = items(r, 's') as SubtitleItem[];
    expect(l?.words.map((w) => w.w)).toEqual(['one', 'two']);
    expect(rt?.words.map((w) => w.w)).toEqual(['three', 'four']);
    expect(rt?.words[0]).toMatchObject({ w: 'three' });
    expect(rt?.words[0]?.s).toBeCloseTo(0);
    expect(rt?.words[1]?.s).toBeCloseTo(0.8);
    expect(l?.durationSec).toBeCloseTo(2);
    expect(rt?.durationSec).toBeCloseTo(2);
    healthy(r);
  });

  it('a word straddling the cut goes to the side holding more of it', () => {
    const r = splitOp(proj([track('s', 'subtitle', [cue])]), ['c'], 12.3).project; // "three" 1.8–2.6 cut at 2.3
    const [l, rt] = items(r, 's') as SubtitleItem[];
    expect(l?.words.map((w) => w.w)).toEqual(['one', 'two', 'three']);
    expect(l?.words[2]?.e).toBeCloseTo(2.3);
    expect(rt?.words.map((w) => w.w)).toEqual(['four']);
    healthy(r);
  });

  it('refuses when a half would be empty', () => {
    const p = proj([track('s', 'subtitle', [cue])]);
    expect(splitOp(p, ['c'], 10.2).project.tracks[0]?.items.length).toBe(1);
  });

  it('keeps style on both halves', () => {
    const c2 = C('c2', 0, 4, [['a', 0, 1], ['b', 2, 3]], { styleId: 'bold-box' });
    const r = splitOp(proj([track('s', 'subtitle', [c2])]), ['c2'], 1.5).project;
    expect((items(r, 's') as SubtitleItem[]).map((c) => c.styleId)).toEqual(['bold-box', 'bold-box']);
  });
});

describe('freezeFrame', () => {
  const base = () =>
    proj([
      track('v1', 'video', [V('a', 0, 10, { inSec: 5 }), V('b', 10, 4, { inSec: 30 })]),
      track('m', 'audio', [A('m1', 12, 3)]),
    ]);

  it('splits and inserts a still of holdSec, rippling later items on the track', () => {
    const { project: r, freezeId } = freezeFrameOp(base(), 'a', 4, 2);
    expect(spans(r, 'v1')).toEqual([[0, 4], [4, 6], [6, 12], [12, 16]]);
    const f = items(r, 'v1')[1] as VideoItem;
    expect(f.id).toBe(freezeId);
    expect(f.freezeAtSec).toBeCloseTo(9); // inSec 5 + 4
    expect(f.audioEnabled).toBe(false);
    expect((items(r, 'v1')[2] as VideoItem).inSec).toBeCloseTo(9);
    // other tracks untouched unless scope 'all'
    expect(spans(r, 'm')).toEqual([[12, 15]]);
    healthy(r);
  });

  it('scope "all" ripples other tracks too', () => {
    const { project: r } = freezeFrameOp(base(), 'a', 4, 2, 'all');
    expect(spans(r, 'm')).toEqual([[14, 17]]);
    healthy(r);
  });

  it('the still holds the animated pose at that time', () => {
    const a = V('a', 0, 10, { transform: { scale: anim(1, [kf(0, 1), kf(10, 2)]) } });
    const { project: r } = freezeFrameOp(proj([track('v1', 'video', [a])]), 'a', 5, 1);
    const f = items(r, 'v1')[1] as VideoItem;
    expect(f.transform.scale).toEqual(anim(1.5));
  });

  it('reverse items freeze on the right source frame', () => {
    const a = V('a', 0, 10, { inSec: 20, reverse: true });
    const { project: r } = freezeFrameOp(proj([track('v1', 'video', [a])]), 'a', 3, 1);
    expect((items(r, 'v1')[1] as VideoItem).freezeAtSec).toBeCloseTo(makeSourceTime(a)(3));
  });

  it('at the very start the still goes before the item; at the end after it', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 6, { inSec: 4 })])]);
    const s = freezeFrameOp(p, 'a', 2, 1).project;
    expect(spans(s, 'v1')).toEqual([[2, 3], [3, 9]]);
    expect((items(s, 'v1')[0] as VideoItem).freezeAtSec).toBeCloseTo(4);
    const e = freezeFrameOp(p, 'a', 8, 1).project;
    expect(spans(e, 'v1')).toEqual([[2, 8], [8, 9]]);
    expect((items(e, 'v1')[1] as VideoItem).freezeAtSec).toBeCloseTo(10);
    healthy(s);
    healthy(e);
  });

  it('only video items; locked tracks refused', () => {
    const p = proj([track('m', 'audio', [A('m1', 0, 5)])]);
    expect(freezeFrameOp(p, 'm1', 2, 1).project).toBe(p);
    const q = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(freezeFrameOp(q, 'a', 2, 1).project).toBe(q);
  });

  it('keeps group id and ids are unique', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5, { groupId: 'g' })])]);
    const r = freezeFrameOp(p, 'a', 2, 1).project;
    expect(items(r, 'v1').every((i) => i.groupId === 'g')).toBe(true);
    expect(new Set(items(r, 'v1').map((i) => i.id)).size).toBe(3);
  });
});
