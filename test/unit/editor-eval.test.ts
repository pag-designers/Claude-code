import { describe, expect, it } from 'vitest';
import {
  animatedSchema,
  projectSchema,
  trackSchema,
  videoItemSchema,
  textItemSchema,
  subtitleItemSchema,
  resolveExportSettings,
  type Project,
} from '@shared/editor';
import {
  activeOnTrack,
  animatedAt,
  applyColor,
  duckBreakpoints,
  duckGainAt,
  ease,
  fadeFactor,
  interpolate,
  isNeutralColor,
  itemGainAt,
  makeSourceOffset,
  makeSourceTime,
  naturalLayout,
  projectDuration,
  resolveColor,
  resolveCrop,
  resolveTransform,
  sourceSpan,
  speechRanges,
  textAnimAt,
  transitionOps,
  visibleChars,
  cubicBezier,
} from '@shared/editor-eval';

const video = (o: Record<string, unknown> = {}) =>
  videoItemSchema.parse({
    type: 'video',
    id: 'v',
    startSec: 0,
    durationSec: 10,
    assetId: 'a',
    ...o,
  });
import type { Easing } from '@shared/editor';
const kf = (t: number, v: number, ease: Easing = 'linear') => ({ t, v, ease });

describe('easing and keyframes', () => {
  it('linear, hold and CSS-style bezier presets', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3);
    expect(ease('hold', 0.99)).toBe(0);
    expect(ease('hold', 1)).toBe(1);
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 3);
    expect(ease('ease-in', 0.5)).toBeLessThan(0.5);
    expect(ease('ease-out', 0.5)).toBeGreaterThan(0.5);
    expect(ease({ type: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }, 0.5)).toBeCloseTo(
      cubicBezier(0.25, 0.1, 0.25, 1)(0.5),
      6,
    );
    expect(ease('ease-in', 0)).toBe(0);
    expect(ease('ease-in', 1)).toBe(1);
    expect(ease('ease-in', 7)).toBe(1); // clamps
  });
  it('bezier is monotonic and hits the endpoints for overshoot y control points', () => {
    const f = cubicBezier(0.34, 1.56, 0.64, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => f(i / 49)))).toBeGreaterThan(1); // overshoot allowed
  });
  it('interpolates between keyframes, clamps outside, honours per-segment easing and hold', () => {
    const k = [kf(0, 0), kf(2, 10, 'hold'), kf(4, 20)];
    expect(interpolate(k, -1, 5)).toBe(0);
    expect(interpolate(k, 1, 5)).toBeCloseTo(5);
    expect(interpolate(k, 3, 5)).toBe(10); // hold until the next keyframe
    expect(interpolate(k, 4, 5)).toBe(20);
    expect(interpolate(k, 99, 5)).toBe(20);
    expect(interpolate([], 1, 7)).toBe(7);
    expect(animatedAt(animatedSchema.parse({ v: 3 }), 5)).toBe(3);
    expect(animatedAt(animatedSchema.parse({ v: 3, kf: [kf(0, 1), kf(1, 2)] }), 0.5)).toBeCloseTo(
      1.5,
    );
  });
});

describe('schema defaults', () => {
  it('a minimal video / text / subtitle item parses with sensible defaults', () => {
    const v = video();
    expect(v.transform.scale).toEqual({ v: 1, kf: [] });
    expect(v.fit).toBe('cover');
    expect(v.color.filter).toBeNull();
    const t = textItemSchema.parse({
      type: 'text',
      id: 't',
      startSec: 1,
      durationSec: 2,
      text: 'hi',
    });
    expect(t.style.size).toBe(72);
    expect(t.animIn.type).toBe('none');
    const s = subtitleItemSchema.parse({
      type: 'subtitle',
      id: 's',
      startSec: 0,
      durationSec: 1,
      words: [{ w: 'a', s: 0, e: 0.5 }],
    });
    expect(s.styleId).toBe('clean-pop');
    const p = projectSchema.parse({ tracks: [], assets: [] });
    expect(p.canvas).toMatchObject({ aspect: '9:16', width: 1080, height: 1920, fps: 30 });
  });
  it('resolveExportSettings fills from the preset', () => {
    const s = resolveExportSettings(
      { preset: 'youtube-1080p' },
      { width: 1080, height: 1920, fps: 30 },
    );
    expect([s.width, s.height]).toEqual([1920, 1080]);
    expect(s.videoKbps).toBe(12000);
    const c = resolveExportSettings({ preset: 'custom' }, { width: 720, height: 720, fps: 24 });
    expect([c.width, c.height, c.fps]).toEqual([720, 720, 24]);
    expect(
      resolveExportSettings({ preset: 'tiktok', width: 540 }, { width: 1, height: 1, fps: 30 })
        .width,
    ).toBe(540);
  });
});

describe('source time (speed, ramp, reverse, freeze)', () => {
  it('constant speed consumes speed·t of source', () => {
    const it = video({ inSec: 5, speed: 2 });
    const f = makeSourceTime(it);
    expect(f(0)).toBe(5);
    expect(f(3)).toBeCloseTo(11);
    expect(sourceSpan(it)).toBeCloseTo(20);
  });
  it('reverse plays the covered source window backwards', () => {
    const it = video({ inSec: 5, speed: 1, durationSec: 4, reverse: true });
    const f = makeSourceTime(it);
    expect(f(0)).toBeCloseTo(9);
    expect(f(4)).toBeCloseTo(5);
    expect(f(1)).toBeCloseTo(8);
  });
  it('freeze shows one source time', () => {
    const f = makeSourceTime(video({ freezeAtSec: 12.5 }));
    expect(f(0)).toBe(12.5);
    expect(f(9)).toBe(12.5);
  });
  it('a speed ramp integrates: linear 1→3 over 2 s consumes 4 s of source', () => {
    const it = video({ durationSec: 2, speedCurve: [kf(0, 1), kf(2, 3)] });
    expect(makeSourceOffset(it)(2)).toBeCloseTo(4, 2);
    expect(makeSourceOffset(it)(1)).toBeCloseTo(1.5, 2); // ∫0..1 (1+t) = 1.5
    const f = makeSourceTime({ ...it, reverse: true, inSec: 10 });
    expect(f(0)).toBeCloseTo(14, 1);
    expect(f(2)).toBeCloseTo(10, 1);
  });
});

describe('fades, gain and ducking', () => {
  it('fade factor ramps in and out linearly and takes the min where they overlap', () => {
    const it = { durationSec: 10, fadeInSec: 2, fadeOutSec: 4 };
    expect(fadeFactor(it, 0)).toBe(0);
    expect(fadeFactor(it, 1)).toBeCloseTo(0.5);
    expect(fadeFactor(it, 5)).toBe(1);
    expect(fadeFactor(it, 8)).toBeCloseTo(0.5);
    expect(fadeFactor(it, 10)).toBe(0);
    expect(fadeFactor({ durationSec: 4, fadeInSec: 4, fadeOutSec: 4 }, 2)).toBeCloseTo(0.5);
  });
  it('item gain = volume keyframes × fades', () => {
    const it = video({ volume: { v: 1, kf: [kf(0, 0), kf(10, 2)] }, fadeInSec: 0 });
    expect(itemGainAt(it, 5)).toBeCloseTo(1);
  });
  const d = { enabled: true, reductionDb: 12, attackSec: 0.5, releaseSec: 1 };
  const g = Math.pow(10, -12 / 20);
  it('ducks inside speech, ramps before (attack, look-ahead) and after (release)', () => {
    const r = [{ s: 10, e: 20 }];
    expect(duckGainAt(r, d, 5)).toBe(1);
    expect(duckGainAt(r, d, 9.75)).toBeCloseTo((1 + g) / 2, 6);
    expect(duckGainAt(r, d, 10)).toBeCloseTo(g, 6);
    expect(duckGainAt(r, d, 15)).toBeCloseTo(g, 6);
    expect(duckGainAt(r, d, 20.5)).toBeCloseTo((1 + g) / 2, 6);
    expect(duckGainAt(r, d, 22)).toBe(1);
    expect(duckGainAt(r, { ...d, enabled: false }, 15)).toBe(1);
    expect(duckGainAt([], d, 15)).toBe(1);
  });
  it('breakpoints cover every slope change inside the duration', () => {
    expect(duckBreakpoints([{ s: 10, e: 20 }], d, 30)).toEqual([0, 9.5, 10, 20, 21, 30]);
  });
  it('speech comes from subtitle word spans (merged over small gaps), else from speech tracks', () => {
    const sub = (id: string, start: number, words: [number, number][]) => ({
      type: 'subtitle',
      id,
      startSec: start,
      durationSec: 5,
      words: words.map(([s, e]) => ({ w: 'x', s, e })),
    });
    const project = projectSchema.parse({
      assets: [],
      tracks: [
        trackSchema.parse({
          id: 't',
          kind: 'subtitle',
          name: 'Subs',
          items: [
            sub('a', 1, [
              [0, 1],
              [1.1, 2],
            ]),
            sub('b', 10, [[0, 1]]),
          ],
        }),
      ],
    });
    expect(speechRanges(project)).toEqual([
      { s: 1, e: 3 },
      { s: 10, e: 11 },
    ]);
    const noSubs = projectSchema.parse({
      assets: [],
      tracks: [
        trackSchema.parse({
          id: 'v',
          kind: 'video',
          name: 'V',
          speech: true,
          items: [video({ startSec: 2, durationSec: 4 })],
        }),
      ],
    });
    expect(speechRanges(noSubs)).toEqual([{ s: 2, e: 6 }]);
  });
});

describe('colour maths', () => {
  const neutral = resolveColor(video().color, 0);
  it('neutral colour is the identity', () => {
    expect(isNeutralColor(neutral)).toBe(true);
    const out = applyColor([0.2, 0.5, 0.8], neutral);
    expect(out[0]).toBeCloseTo(0.2);
    expect(out[2]).toBeCloseTo(0.8);
  });
  it('exposure doubles per 2/3 of the slider; contrast pivots on 0.5; saturation −1 gives luma; warm lifts red and drops blue', () => {
    const ex = resolveColor(video({ color: { exposure: { v: 2 / 3 } } }).color, 0);
    expect(applyColor([0.25, 0.25, 0.25], ex)[0]).toBeCloseTo(0.5, 5);
    const ct = resolveColor(video({ color: { contrast: { v: 1 } } }).color, 0);
    expect(applyColor([0.5, 0.5, 0.5], ct)[0]).toBeCloseTo(0.5);
    expect(applyColor([0.75, 0.75, 0.75], ct)[0]).toBeCloseTo(1);
    const mono = resolveColor(video({ color: { saturation: { v: -1 } } }).color, 0);
    const [r, g, b] = applyColor([1, 0, 0], mono);
    expect(r).toBeCloseTo(0.2126, 4);
    expect(g).toBeCloseTo(0.2126, 4);
    expect(b).toBeCloseTo(0.2126, 4);
    const warm = resolveColor(video({ color: { temperature: { v: 1 } } }).color, 0);
    const [wr, , wb] = applyColor([0.5, 0.5, 0.5], warm);
    expect(wr).toBeGreaterThan(0.5);
    expect(wb).toBeLessThan(0.5);
  });
  it('a filter preset adds to the values and clamps to the slider range', () => {
    const e = resolveColor(video({ color: { filter: 'mono', saturation: { v: -0.5 } } }).color, 0);
    expect(e.saturation).toBe(0); // −0.5 + −1 clamps to −1 → factor 0
    expect(resolveColor(video({ color: { filter: 'nope' } }).color, 0)).toEqual(neutral);
  });
});

describe('layout and transform', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  it('cover: dst is the canvas, src is the centre-cropped region', () => {
    const l = naturalLayout('cover', full, 1920, 1080, 1080, 1920);
    expect(l.dst).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(l.src.h).toBeCloseTo(1080);
    expect(l.src.w).toBeCloseTo(1080 * (1080 / 1920));
    expect(l.src.x).toBeCloseTo((1920 - l.src.w) / 2);
  });
  it('contain letterboxes and native is 1:1', () => {
    const c = naturalLayout('contain', full, 1920, 1080, 1080, 1920);
    expect(c.dst.w).toBeCloseTo(1080);
    expect(c.dst.h).toBeCloseTo(607.5);
    expect(c.dst.y).toBeCloseTo((1920 - 607.5) / 2);
    const n = naturalLayout('native', full, 400, 300, 1080, 1920);
    expect(n.dst).toEqual({ x: 340, y: 810, w: 400, h: 300 });
  });
  it('crop keyframes drive the sampled region (a reframe path)', () => {
    const it = video({
      crop: { x: { v: 0, kf: [kf(0, 0.1), kf(10, 0.4)] }, w: { v: 0.3 }, h: { v: 1 } },
    });
    const c = resolveCrop(it.crop, 5);
    expect(c.x).toBeCloseTo(0.25);
    expect(c.w).toBeCloseTo(0.3);
    expect(resolveCrop(it.crop, 10).x + resolveCrop(it.crop, 10).w).toBeLessThanOrEqual(1);
    const l = naturalLayout('cover', { x: 0.25, y: 0, w: 0.3, h: 1 }, 1920, 1080, 1080, 1920);
    expect(l.src.x).toBeGreaterThanOrEqual(0.25 * 1920 - 1e-6);
  });
  it('transform resolves animated values and multiplies opacity by the fades', () => {
    const it = video({
      fadeInSec: 2,
      transform: { x: { v: 0, kf: [kf(0, -100), kf(10, 100)] }, opacity: { v: 0.5 } },
    });
    const t = resolveTransform(it, 1);
    expect(t.x).toBeCloseTo(-80);
    expect(t.opacity).toBeCloseTo(0.25);
    expect(resolveTransform(it, 1, false).opacity).toBe(0.5);
  });
});

describe('transitions', () => {
  it('crossfade mixes A·(1−p)+B·p, dip goes through the veil, slides move both layers', () => {
    expect(transitionOps('crossfade', 0.25).to.opacity).toBe(0.25);
    expect(transitionOps('dip-black', 0.25)).toMatchObject({
      veil: { color: '#000000', alpha: 0.5 },
      from: { opacity: 1 },
      to: { opacity: 0 },
    });
    expect(transitionOps('dip-white', 0.75)).toMatchObject({
      veil: { color: '#FFFFFF', alpha: 0.5 },
      from: { opacity: 0 },
      to: { opacity: 1 },
    });
    const s = transitionOps('slide-left', 0.25);
    expect(s.from.dx).toBeCloseTo(-0.25);
    expect(s.to.dx).toBeCloseTo(0.75);
    expect(transitionOps('slide-down', 0.5).from.dy).toBeCloseTo(0.5);
  });
  it('every transition starts as the outgoing clip and ends as the incoming one', () => {
    for (const t of [
      'crossfade',
      'dip-black',
      'dip-white',
      'slide-left',
      'slide-right',
      'slide-up',
      'slide-down',
      'zoom',
      'blur',
      'whip-pan',
      'glitch',
    ] as const) {
      const a = transitionOps(t, 0);
      const b = transitionOps(t, 1);
      const shows = (o: ReturnType<typeof transitionOps>, which: 'from' | 'to') => {
        const l = o[which];
        return (
          l.opacity > 0.99 &&
          Math.abs(l.dx) < 1e-9 &&
          Math.abs(l.dy) < 1e-9 &&
          Math.abs(l.scale - 1) < 1e-9 &&
          l.blur < 1e-9 &&
          (!o.veil || o.veil.alpha < 1e-9)
        );
      };
      expect(shows(a, 'from'), `${t} start`).toBe(true);
      expect(shows(b, 'to'), `${t} end`).toBe(true);
    }
  });
  it('activeOnTrack reports the overlap progress and a "cut" transition is no blend', () => {
    const a = video({ id: 'a', startSec: 0, durationSec: 5 });
    const b = video({
      id: 'b',
      startSec: 4,
      durationSec: 5,
      transitionIn: { type: 'crossfade', durationSec: 1 },
    });
    const tr = trackSchema.parse({ id: 't', kind: 'video', name: 'V', items: [a, b] });
    expect(activeOnTrack(tr, 3).items.map((i) => i.id)).toEqual(['a']);
    const mid = activeOnTrack(tr, 4.5);
    expect(mid.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(mid.transition?.progress).toBeCloseTo(0.5);
    expect(activeOnTrack(tr, 5).items.map((i) => i.id)).toEqual(['b']);
    const cut = trackSchema.parse({
      id: 't',
      kind: 'video',
      name: 'V',
      items: [a, { ...b, transitionIn: { type: 'cut', durationSec: 1 } }],
    });
    expect(activeOnTrack(cut, 4.5)).toMatchObject({ transition: null });
    expect(projectDuration({ tracks: [tr] })).toBe(9);
  });
});

describe('text animation', () => {
  const t = (animIn: string, animOut = 'none') =>
    textItemSchema.parse({
      type: 'text',
      id: 't',
      startSec: 0,
      durationSec: 4,
      text: 'Hello',
      animIn: { type: animIn, durationSec: 1 },
      animOut: { type: animOut, durationSec: 1 },
    });
  it('typewriter reveals characters; fade/scale ramp; pop overshoots then settles', () => {
    expect(textAnimAt(t('typewriter'), 0.5).visible).toBeCloseTo(0.5);
    expect(visibleChars('Hello', 0.5)).toBe(3);
    expect(visibleChars('Hello', 1)).toBe(5);
    expect(visibleChars('Hello', 0)).toBe(0);
    expect(textAnimAt(t('fade'), 0.25).opacity).toBeCloseTo(0.25);
    expect(textAnimAt(t('scale'), 0).scale).toBeCloseTo(0.6);
    expect(
      Math.max(...[0.1, 0.4, 0.6, 0.8, 1].map((tl) => textAnimAt(t('pop'), tl).scale)),
    ).toBeGreaterThan(1.1);
    expect(textAnimAt(t('pop'), 1).scale).toBe(1);
    expect(textAnimAt(t('none'), 0).opacity).toBe(1);
  });
  it('out animation mirrors in, and in/out combine', () => {
    expect(textAnimAt(t('none', 'fade'), 3.75).opacity).toBeCloseTo(0.25);
    expect(textAnimAt(t('fade', 'fade'), 2).opacity).toBe(1);
  });
});

describe('determinism', () => {
  it('the evaluator is pure: same inputs, same outputs', () => {
    const p: Project = projectSchema.parse({ tracks: [], assets: [] });
    expect(JSON.stringify(transitionOps('glitch', 0.37))).toBe(
      JSON.stringify(transitionOps('glitch', 0.37)),
    );
    expect(projectDuration(p)).toBe(0);
  });
});
