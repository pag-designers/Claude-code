import { describe, expect, it } from 'vitest';
import type { VideoItem, TextItem, AudioItem } from '@shared/editor';
import { animatedAt } from '@shared/editor-eval';
import {
  addKeyframeOp,
  clearKeyframesOp,
  moveKeyframeOp,
  removeKeyframeOp,
  setKeyframeEaseOp,
  setPropOp,
  getAnimated,
  keyframesAfterCut,
  keyframesUpTo,
  upsertKeyframe,
  clampPropValue,
  ANIMATED_PATHS,
  projectProblems,
} from '../../renderer/lib/editor/core/ops';
import { A, S, T, V, item, proj, track, C, I } from './editor-core-fixtures';

const kf = (t: number, v: number, ease: 'linear' | 'hold' = 'linear') => ({ t, v, ease });
const anim = (v: number, ks: ReturnType<typeof kf>[] = []) => ({ v, kf: ks });
const P = () =>
  proj([
    track('v1', 'video', [
      V('a', 0, 10, { transform: { opacity: anim(1, [kf(0, 0), kf(10, 1)]) } }),
      V('b', 10, 4),
    ]),
    track('o', 'overlay', [T('t', 0, 4), S('s', 4, 2)]),
    track('m', 'audio', [A('m1', 0, 8)]),
  ]);
const vi = (p: ReturnType<typeof P>, id = 'a') => item(p, id) as VideoItem;

describe('setProp', () => {
  it('sets the base value when the property has no keyframes', () => {
    const r = setPropOp(P(), 'a', 'transform.scale', 2, 5);
    expect(vi(r).transform.scale).toEqual(anim(2));
  });

  it('adds a keyframe at the local time when the property already has keyframes', () => {
    const r = setPropOp(P(), 'a', 'transform.opacity', 0.25, 5);
    expect(vi(r).transform.opacity.kf).toEqual([kf(0, 0), kf(5, 0.25), kf(10, 1)]);
  });

  it('updates an existing keyframe at the same time (keeps its easing)', () => {
    const p = setKeyframeEaseOp(P(), 'a', 'transform.opacity', 0, 'ease-in');
    const r = setPropOp(p, 'a', 'transform.opacity', 0.5, 0.001);
    expect(vi(r).transform.opacity.kf[0]).toEqual({ t: 0, v: 0.5, ease: 'ease-in' });
    expect(vi(r).transform.opacity.kf.length).toBe(2);
  });

  it('forceKeyframe creates the first keyframe', () => {
    const r = setPropOp(P(), 'a', 'transform.x', 40, 3, { forceKeyframe: true, ease: 'ease-out' });
    expect(vi(r).transform.x.kf).toEqual([kf(3, 40, 'ease-out' as never)]);
  });

  it('clamps the time to the item and values to sane ranges', () => {
    const r = setPropOp(P(), 'a', 'transform.opacity', 5, 99);
    expect(vi(r).transform.opacity.kf.at(-1)).toMatchObject({ t: 10, v: 1 });
    expect(vi(setPropOp(P(), 'a', 'transform.opacity', -3, 5)).transform.opacity.kf[1]?.v).toBe(0);
    expect(clampPropValue('color.exposure', 7)).toBe(1);
    expect(clampPropValue('crop.w', 0)).toBe(0.01);
    expect(clampPropValue('volume', -1)).toBe(0);
    expect(clampPropValue('transform.x', -500)).toBe(-500);
    expect(clampPropValue('blur', Number.NaN)).toBe(0);
  });

  it('works on text, shapes and audio (volume)', () => {
    expect((item(setPropOp(P(), 't', 'transform.y', 100, 1), 't') as TextItem).transform.y.v).toBe(
      100,
    );
    expect((item(setPropOp(P(), 'm1', 'volume', 0.5, 1), 'm1') as AudioItem).volume.v).toBe(0.5);
  });

  it('ignores properties the item type does not have', () => {
    const p = P();
    expect(setPropOp(p, 't', 'volume', 1, 0)).toBe(p);
    expect(setPropOp(p, 'm1', 'transform.x', 1, 0)).toBe(p);
    expect(setPropOp(p, 't', 'crop.x', 0.1, 0)).toBe(p);
  });

  it('same value → same project', () => {
    const p = P();
    expect(setPropOp(p, 'a', 'transform.x', 0, 2)).toBe(p);
  });

  it('locked tracks/items reject', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    expect(setPropOp(p, 'a', 'transform.x', 3, 1)).toBe(p);
  });
});

describe('add / move / ease / remove / clear', () => {
  it('addKeyframe defaults the value to the current value at that time', () => {
    const r = addKeyframeOp(P(), 'a', 'transform.opacity', 5);
    expect(r.index).toBe(1);
    expect(vi(r.project).transform.opacity.kf[1]).toEqual(kf(5, 0.5));
  });

  it('addKeyframe on a static property uses the base value', () => {
    const r = addKeyframeOp(P(), 'a', 'transform.scale', 2);
    expect(vi(r.project).transform.scale.kf).toEqual([kf(2, 1)]);
  });

  it('addKeyframe with explicit value and ease; keeps keyframes sorted', () => {
    let p = addKeyframeOp(P(), 'a', 'transform.x', 6, 10, 'ease-in').project;
    p = addKeyframeOp(p, 'a', 'transform.x', 2, 20).project;
    p = addKeyframeOp(p, 'a', 'transform.x', 4, 30).project;
    expect(vi(p).transform.x.kf.map((k) => k.t)).toEqual([2, 4, 6]);
    expect(vi(p).transform.x.kf[2]?.ease).toBe('ease-in');
  });

  it('adding at the same time updates instead of duplicating', () => {
    let p = addKeyframeOp(P(), 'a', 'transform.x', 2, 10).project;
    p = addKeyframeOp(p, 'a', 'transform.x', 2.002, 99).project;
    expect(vi(p).transform.x.kf).toEqual([kf(2, 99)]);
  });

  it('moveKeyframe changes time and value, re-sorts, returns the new index', () => {
    const r = moveKeyframeOp(P(), 'a', 'transform.opacity', 0, 6, 0.3);
    expect(vi(r.project).transform.opacity.kf.map((k) => [k.t, k.v])).toEqual([
      [6, 0.3],
      [10, 1],
    ]);
    expect(r.index).toBe(0);
    const r2 = moveKeyframeOp(P(), 'a', 'transform.opacity', 0, 12, 0.3);
    expect(r2.index).toBe(0); // clamped to the item end (10) → replaces the keyframe there
    expect(vi(r2.project).transform.opacity.kf.length).toBe(1);
  });

  it('moveKeyframe onto another keyframe replaces it', () => {
    const p = addKeyframeOp(P(), 'a', 'transform.opacity', 5, 0.7).project;
    const r = moveKeyframeOp(p, 'a', 'transform.opacity', 1, 10, 0.2);
    expect(vi(r.project).transform.opacity.kf.map((k) => [k.t, k.v])).toEqual([
      [0, 0],
      [10, 0.2],
    ]);
  });

  it('moveKeyframe clamps time ≥ 0 and rejects bad indices', () => {
    const r = moveKeyframeOp(P(), 'a', 'transform.opacity', 1, -4, 0.9);
    expect(vi(r.project).transform.opacity.kf[0]).toMatchObject({ t: 0, v: 0.9 });
    const p = P();
    expect(moveKeyframeOp(p, 'a', 'transform.opacity', 9, 1, 1).project).toBe(p);
  });

  it('setKeyframeEase supports presets and bezier', () => {
    const bz = { type: 'bezier', x1: 0.2, y1: 0.8, x2: 0.4, y2: 1.2 } as const;
    const r = setKeyframeEaseOp(P(), 'a', 'transform.opacity', 0, bz);
    expect(vi(r).transform.opacity.kf[0]?.ease).toEqual(bz);
    const hold = setKeyframeEaseOp(P(), 'a', 'transform.opacity', 0, 'hold');
    expect(animatedAt(vi(hold).transform.opacity, 5)).toBe(0);
    const p = P();
    expect(setKeyframeEaseOp(p, 'a', 'transform.opacity', 0, 'linear')).toBe(p);
    expect(setKeyframeEaseOp(p, 'a', 'transform.opacity', 7, 'hold')).toBe(p);
  });

  it('removeKeyframe removes one; removing the last leaves its value as the static value', () => {
    let p = removeKeyframeOp(P(), 'a', 'transform.opacity', 0);
    expect(vi(p).transform.opacity.kf).toEqual([kf(10, 1)]);
    p = removeKeyframeOp(p, 'a', 'transform.opacity', 0);
    expect(vi(p).transform.opacity).toEqual(anim(1));
    const q = P();
    expect(removeKeyframeOp(q, 'a', 'transform.opacity', 5)).toBe(q);
  });

  it('clearKeyframes keeps the value at the playhead', () => {
    const r = clearKeyframesOp(P(), 'a', 'transform.opacity', 2.5);
    expect(vi(r).transform.opacity).toEqual(anim(0.25));
    const p = P();
    expect(clearKeyframesOp(p, 'a', 'transform.x', 0)).toBe(p);
  });

  it('every animated path is addressable on a video item', () => {
    let p = P();
    for (const path of ANIMATED_PATHS) {
      p = addKeyframeOp(p, 'b', path, 1, path.startsWith('crop') ? 0.5 : 0.5).project;
      expect(getAnimated(item(p, 'b'), path)?.kf.length).toBe(1);
    }
    expect(projectProblems(p)).toEqual([]);
  });

  it('images have transform/crop/color but no volume; subtitles have none', () => {
    const p = proj([track('v1', 'video', [I('i', 0, 3)]), track('s', 'subtitle', [C('c', 0, 2)])]);
    expect(getAnimated(item(p, 'i'), 'transform.x')).not.toBeNull();
    expect(getAnimated(item(p, 'i'), 'volume')).toBeNull();
    expect(getAnimated(item(p, 'c'), 'transform.x')).toBeNull();
  });
});

describe('keyframe array helpers', () => {
  it('keyframesAfterCut with hold easing keeps the held value', () => {
    const out = keyframesAfterCut([kf(0, 1, 'hold'), kf(10, 5)], 4, 0);
    expect(out[0]).toEqual({ t: 0, v: 1, ease: 'hold' });
  });
  it('keyframesAfterCut(0) is identity', () => {
    const k = [kf(1, 1)];
    expect(keyframesAfterCut(k, 0, 0)).toBe(k);
  });
  it('keyframesUpTo keeps everything when nothing is after the cut', () => {
    const k = [kf(1, 1), kf(2, 2)];
    expect(keyframesUpTo(k, 5, 0)).toBe(k);
  });
  it('keyframesUpTo adds nothing when a keyframe sits exactly at the cut', () => {
    expect(keyframesUpTo([kf(1, 1), kf(2, 2), kf(3, 3)], 2, 0)).toEqual([kf(1, 1), kf(2, 2)]);
  });
  it('upsertKeyframe appends at the end and reports the index', () => {
    const r = upsertKeyframe(anim(0, [kf(1, 1)]), 5, 9);
    expect(r.index).toBe(1);
  });
});
