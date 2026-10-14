import { describe, expect, it } from 'vitest';
import {
  duckGainAt,
  itemGainAt,
  makeSourceTime,
  sourceSpan,
  speechRanges,
} from '../../shared/editor-eval';
import {
  audioEntries,
  ctxAt,
  duckPoints,
  elementRateAt,
  entriesActiveAt,
  entriesInWindow,
  grainEnvelope,
  itemGainPoints,
  ratePoints,
  reverseBufferPos,
  reverseWindow,
  scheduleLinear,
  speedExtent,
  tlAt,
  trackLevel,
  voiceKind,
} from '../../renderer/lib/editor/playback/mixer-math';
import { aItem, asset, cue, FakeParam, project, track, vItem } from './editor-playback-fakes';

/** Linear interpolation through breakpoints. */
const evalPts = (pts: { t: number; v: number }[], t: number) => {
  if (t <= pts[0]!.t) return pts[0]!.v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return pts[pts.length - 1]!.v;
};

describe('which items make sound', () => {
  const a = asset({ id: 'a1', hasAudio: true });
  const silent = asset({ id: 'a2', hasAudio: false });
  const m = asset({ id: 'm1', kind: 'audio', hasAudio: true });
  const img = asset({ id: 'img', kind: 'image', hasAudio: false });
  const mk = (tracks: unknown[]) => project(tracks, [a, silent, m, img]);

  it('includes audio items and video items with audio', () => {
    const p = mk([
      track({ id: 'v', items: [vItem({ id: 'v1' }), vItem({ id: 'v2', assetId: 'a2' })] }),
      track({ id: 'm', kind: 'audio', items: [aItem({ id: 'au' })] }),
    ]);
    expect(audioEntries(p).map((e) => e.item.id)).toEqual(['v1', 'au']);
  });
  it('excludes audioEnabled=false, freeze frames, muted / hidden / zero-gain tracks and unknown assets', () => {
    const p = mk([
      track({
        id: 'v',
        items: [
          vItem({ id: 'noaudio', audioEnabled: false }),
          vItem({ id: 'freeze', freezeAtSec: 2, startSec: 10 }),
          vItem({ id: 'ghost', assetId: 'missing', startSec: 20 }),
        ],
      }),
      track({ id: 'mu', kind: 'audio', muted: true, items: [aItem({ id: 'x1' })] }),
      track({ id: 'hi', kind: 'audio', hidden: true, items: [aItem({ id: 'x2' })] }),
      track({ id: 'z', kind: 'audio', gain: 0, items: [aItem({ id: 'x3' })] }),
    ]);
    expect(audioEntries(p)).toEqual([]);
  });
  it('track level: mute / hidden → 0, else gain', () => {
    expect(trackLevel({ muted: false, hidden: false, gain: 0.7 })).toBe(0.7);
    expect(trackLevel({ muted: true, hidden: false, gain: 1 })).toBe(0);
    expect(trackLevel({ muted: false, hidden: true, gain: 1 })).toBe(0);
    expect(trackLevel({ muted: false, hidden: false, gain: -1 })).toBe(0);
  });
  it('windowing: only entries overlapping [t0, t1)', () => {
    const p = mk([
      track({
        id: 'm',
        kind: 'audio',
        items: [
          aItem({ id: 'early', startSec: 0, durationSec: 2 }),
          aItem({ id: 'mid', startSec: 5, durationSec: 2 }),
          aItem({ id: 'late', startSec: 12, durationSec: 2 }),
        ],
      }),
    ]);
    const es = audioEntries(p);
    expect(entriesInWindow(es, 4, 6).map((e) => e.item.id)).toEqual(['mid']);
    expect(entriesInWindow(es, 6.9, 12).map((e) => e.item.id)).toEqual(['mid']);
    expect(entriesInWindow(es, 7, 12).map((e) => e.item.id)).toEqual([]);
    expect(entriesInWindow(es, 11, 13).map((e) => e.item.id)).toEqual(['late']);
    expect(entriesActiveAt(es, 5).map((e) => e.item.id)).toEqual(['mid']);
    expect(entriesActiveAt(es, 7).map((e) => e.item.id)).toEqual([]);
  });
});

describe('time mapping', () => {
  it('ctxAt / tlAt are inverse and honour the rate', () => {
    const a = { tl0: 10, ctx0: 100, rate: 2 };
    expect(ctxAt(a, 10)).toBe(100);
    expect(ctxAt(a, 14)).toBe(102);
    expect(tlAt(a, 102)).toBe(14);
    expect(tlAt(a, ctxAt(a, 37.3))).toBeCloseTo(37.3, 9);
  });
});

describe('item gain breakpoints', () => {
  it('constant volume → 2 points; the curve is flat', () => {
    const it = aItem({ durationSec: 8 });
    const pts = itemGainPoints(it, 0, 8);
    expect(pts).toEqual([
      { t: 0, v: 1 },
      { t: 8, v: 1 },
    ]);
  });
  it('fade in / out are exact breakpoints and ramp linearly', () => {
    const it = aItem({ durationSec: 10, fadeInSec: 2, fadeOutSec: 3 });
    const pts = itemGainPoints(it, 0, 10);
    expect(pts.map((p) => p.t)).toEqual([0, 2, 7, 10]);
    expect(pts.map((p) => p.v)).toEqual([0, 1, 1, 0]);
    expect(evalPts(pts, 1)).toBeCloseTo(0.5, 9);
    expect(evalPts(pts, 8.5)).toBeCloseTo(0.5, 9);
  });
  it('matches itemGainAt everywhere for volume keyframes with easing and overlapping fades', () => {
    const it = aItem({
      durationSec: 10,
      fadeInSec: 3,
      fadeOutSec: 2,
      volume: {
        v: 1,
        kf: [
          { t: 0, v: 0.2, ease: 'ease-in-out' },
          { t: 4, v: 1.5, ease: 'linear' },
          { t: 8, v: 0.4, ease: 'ease-out' },
          { t: 10, v: 0.9, ease: 'linear' },
        ],
      },
    });
    const pts = itemGainPoints(it, 0, 10);
    let worst = 0;
    for (let t = 0; t <= 10; t += 0.05)
      worst = Math.max(worst, Math.abs(evalPts(pts, t) - itemGainAt(it, t)));
    expect(worst).toBeLessThan(0.01);
  });
  it('a hold keyframe becomes a near-instant step', () => {
    const it = aItem({
      durationSec: 6,
      volume: {
        v: 1,
        kf: [
          { t: 0, v: 1, ease: 'hold' },
          { t: 3, v: 0.25, ease: 'linear' },
        ],
      },
    });
    const pts = itemGainPoints(it, 0, 6);
    expect(evalPts(pts, 2.9)).toBeCloseTo(1, 2);
    expect(evalPts(pts, 3.0)).toBeCloseTo(0.25, 2);
  });
  it('windows [from, to] clamp to the item and begin / end exactly there', () => {
    const it = aItem({ durationSec: 10, fadeInSec: 4 });
    const pts = itemGainPoints(it, 1, 3);
    expect(pts[0]).toEqual({ t: 1, v: 0.25 });
    expect(pts[pts.length - 1]).toEqual({ t: 3, v: 0.75 });
    expect(itemGainPoints(it, -5, 99)[0]!.t).toBe(0);
    expect(itemGainPoints(it, 5, 99).at(-1)!.t).toBe(10);
    expect(itemGainPoints(it, 6, 5)).toEqual([]);
  });
});

describe('ducking breakpoints', () => {
  const words: [string, number, number][] = [['hi', 0, 1]];
  const sub = track({
    id: 's',
    kind: 'subtitle',
    items: [cue('c1', 4, words), cue('c2', 12, words)],
  });
  const m = track({
    id: 'm',
    kind: 'audio',
    ducking: { enabled: true, reductionDb: 12, attackSec: 0.2, releaseSec: 0.6 },
    items: [aItem({ durationSec: 30 })],
  });
  const p = project([sub, m], [asset({ id: 'm1', kind: 'audio' })]);
  const ranges = speechRanges(p);
  const d = m.ducking;

  it('speech ranges come from the subtitle words', () => {
    expect(ranges).toEqual([
      { s: 4, e: 5 },
      { s: 12, e: 13 },
    ]);
  });
  it('the piecewise-linear curve equals duckGainAt at every sample', () => {
    const pts = duckPoints(ranges, d, 30, 0, 30);
    let worst = 0;
    for (let t = 0; t <= 30; t += 0.01)
      worst = Math.max(worst, Math.abs(evalPts(pts, t) - duckGainAt(ranges, d, t)));
    expect(worst).toBeLessThan(1e-3);
  });
  it('dips to −12 dB inside speech, recovers after the release', () => {
    const pts = duckPoints(ranges, d, 30, 0, 30);
    expect(evalPts(pts, 3.7)).toBeCloseTo(1, 6);
    expect(evalPts(pts, 4.5)).toBeCloseTo(Math.pow(10, -12 / 20), 4);
    expect(evalPts(pts, 5.6)).toBeCloseTo(1, 6);
  });
  it('windowed curves start and end exactly at the window bounds with the right value', () => {
    const pts = duckPoints(ranges, d, 30, 4.4, 5.2);
    expect(pts[0]!.t).toBe(4.4);
    expect(pts.at(-1)!.t).toBe(5.2);
    expect(pts[0]!.v).toBeCloseTo(duckGainAt(ranges, d, 4.4), 9);
    expect(pts.at(-1)!.v).toBeCloseTo(duckGainAt(ranges, d, 5.2), 9);
  });
  it('disabled ducking is flat 1', () => {
    const pts = duckPoints(ranges, { ...d, enabled: false }, 30, 0, 30);
    expect(pts.every((q) => q.v === 1)).toBe(true);
  });
});

describe('speed → playback rate', () => {
  it('element rate = item speed × transport rate, clamped to the clean range', () => {
    expect(elementRateAt(aItem({ speed: 1.5 }), 1, 1)).toBe(1.5);
    expect(elementRateAt(aItem({ speed: 1.5 }), 1, 2)).toBe(3);
    expect(elementRateAt(aItem({ speed: 3 }), 1, 2)).toBe(4);
    expect(elementRateAt(aItem({ speed: 0.1 }), 1, 1)).toBe(0.25);
  });
  it('speed ramps vary the rate along the curve', () => {
    const it = aItem({
      speedCurve: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 10, v: 3, ease: 'linear' },
      ],
    });
    expect(elementRateAt(it, 0, 1)).toBeCloseTo(1, 6);
    expect(elementRateAt(it, 5, 1)).toBeCloseTo(2, 6);
    expect(elementRateAt(it, 10, 1)).toBeCloseTo(3, 6);
  });
  it('speed extent covers constant speed and curves', () => {
    expect(speedExtent(aItem({ speed: 2 }))).toEqual({ min: 2, max: 2 });
    expect(
      speedExtent(
        aItem({
          speedCurve: [
            { t: 0, v: 0.5, ease: 'linear' },
            { t: 4, v: 6, ease: 'linear' },
          ],
        }),
      ),
    ).toEqual({ min: 0.5, max: 6 });
  });
  it('voice kind: elements in range; buffers for reverse and for speeds the media pipeline would mute', () => {
    expect(voiceKind(aItem({ speed: 1 }), 1)).toBe('element');
    expect(voiceKind(aItem({ speed: 3.9 }), 1)).toBe('element');
    expect(voiceKind(aItem({ speed: 5 }), 1)).toBe('buffer');
    expect(voiceKind(aItem({ speed: 0.2 }), 1)).toBe('buffer');
    expect(voiceKind(aItem({ speed: 2 }), 2)).toBe('element');
    expect(voiceKind(aItem({ speed: 3 }), 2)).toBe('buffer');
    expect(voiceKind(aItem({ reverse: true }), 1)).toBe('buffer');
    expect(
      voiceKind(
        aItem({
          speedCurve: [
            { t: 0, v: 1, ease: 'linear' },
            { t: 4, v: 8, ease: 'linear' },
          ],
        }),
        1,
      ),
    ).toBe('buffer');
  });
  it('rate breakpoints: constant speed → a single point; ramps are sampled and end exactly', () => {
    expect(ratePoints(aItem({ speed: 2 }), 0, 10, 1)).toEqual([{ t: 0, v: 2 }]);
    const it = aItem({
      durationSec: 10,
      speedCurve: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 10, v: 3, ease: 'linear' },
      ],
    });
    const pts = ratePoints(it, 0, 10, 1);
    expect(pts[0]).toEqual({ t: 0, v: 1 });
    expect(pts.at(-1)).toEqual({ t: 10, v: 3 });
    expect(pts.length).toBeGreaterThan(10);
    expect(ratePoints(it, 0, 10, 2).at(-1)!.v).toBe(6);
  });
});

describe('reverse windowing', () => {
  it('the window is the source span from inSec, clamped to the asset', () => {
    const it = aItem({ inSec: 2, durationSec: 4, speed: 2 });
    expect(sourceSpan(it)).toBe(8);
    expect(reverseWindow(it, 60)).toEqual({ startSrc: 2, endSrc: 10 });
    expect(reverseWindow(it, 7)).toEqual({ startSrc: 2, endSrc: 7 });
    expect(reverseWindow(it, null)).toEqual({ startSrc: 2, endSrc: 10 });
  });
  it('position in the reversed buffer equals window end − source time (constant speed)', () => {
    const it = aItem({ inSec: 2, durationSec: 4, reverse: true });
    const src = makeSourceTime(it);
    const { endSrc } = reverseWindow(it, 60);
    for (const tl of [0, 0.5, 1, 2.5, 4])
      expect(reverseBufferPos(it, 60, tl)).toBeCloseTo(endSrc - src(tl), 9);
    expect(reverseBufferPos(it, 60, 0)).toBeCloseTo(0, 9);
    expect(reverseBufferPos(it, 60, 4)).toBeCloseTo(4, 9);
  });
  it('with a speed: the reversed buffer is consumed at the item speed', () => {
    const it = aItem({ inSec: 1, durationSec: 4, speed: 2, reverse: true });
    expect(reverseBufferPos(it, 60, 1)).toBeCloseTo(2, 9);
    expect(reverseBufferPos(it, 60, 4)).toBeCloseTo(8, 9);
  });
  it('speed ramps integrate', () => {
    const it = aItem({
      inSec: 0,
      durationSec: 4,
      reverse: true,
      speedCurve: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 4, v: 3, ease: 'linear' },
      ],
    });
    const src = makeSourceTime(it);
    const { endSrc } = reverseWindow(it, 60);
    for (const tl of [0, 1, 2, 3.5, 4])
      expect(reverseBufferPos(it, 60, tl)).toBeCloseTo(endSrc - src(tl), 6);
  });
  it('a window cut short by the asset end gives a NEGATIVE start position (wait before sound)', () => {
    const it = aItem({ inSec: 5, durationSec: 6, reverse: true });
    // the item reaches 11 s but the asset has 8 s: the first 3 s of the reversed item are silent
    expect(reverseBufferPos(it, 8, 0)).toBeCloseTo(-3, 9);
    expect(reverseBufferPos(it, 8, 3)).toBeCloseTo(0, 9);
    expect(reverseBufferPos(it, 8, 6)).toBeCloseTo(3, 9);
  });
});

describe('AudioParam scheduling and grains', () => {
  const ctx = { currentTime: 0 };
  it('scheduleLinear writes a set followed by ramps and the param evaluates through them', () => {
    const p = new FakeParam(ctx, 0);
    scheduleLinear(p, [
      { ctx: 1, v: 0 },
      { ctx: 3, v: 1 },
      { ctx: 5, v: 0.5 },
    ]);
    expect(p.valueAt(0)).toBe(0);
    expect(p.valueAt(2)).toBeCloseTo(0.5, 9);
    expect(p.valueAt(3)).toBeCloseTo(1, 9);
    expect(p.valueAt(4)).toBeCloseTo(0.75, 9);
    expect(p.valueAt(9)).toBe(0.5);
  });
  it('restartAt cancels what was scheduled later and pins the start value', () => {
    const p = new FakeParam(ctx, 1);
    scheduleLinear(p, [{ ctx: 10, v: 0 }], { restartAt: 0, startValue: 1 });
    scheduleLinear(
      p,
      [
        { ctx: 4, v: 0.2 },
        { ctx: 6, v: 0.8 },
      ],
      { restartAt: 2, startValue: 0.6 },
    );
    expect(p.valueAt(2)).toBeCloseTo(0.6, 9);
    expect(p.valueAt(4)).toBeCloseTo(0.2, 9);
    expect(p.valueAt(5)).toBeCloseTo(0.5, 9);
    expect(p.valueAt(8)).toBeCloseTo(0.8, 9);
  });
  it('continueFrom ramps on from the previous end; equal times become steps', () => {
    const p = new FakeParam(ctx, 0);
    scheduleLinear(p, [
      { ctx: 0, v: 0 },
      { ctx: 2, v: 1 },
    ]);
    scheduleLinear(
      p,
      [
        { ctx: 2, v: 0.2 },
        { ctx: 4, v: 0.4 },
      ],
      { continueFrom: 2 },
    );
    expect(p.valueAt(1)).toBeCloseTo(0.5, 9);
    expect(p.valueAt(2)).toBeCloseTo(0.2, 9);
    expect(p.valueAt(3)).toBeCloseTo(0.3, 9);
  });
  it('grain envelope: ramps up, holds, ramps down to 0 within 80 ms', () => {
    const env = grainEnvelope(0.8);
    expect(env[0]).toEqual({ t: 0, v: 0 });
    expect(env.at(-1)).toEqual({ t: 0.08, v: 0 });
    expect(Math.max(...env.map((e) => e.v))).toBe(0.8);
    expect(env[1]!.t).toBeLessThan(0.01);
    expect(env[2]!.t).toBeGreaterThan(0.05);
  });
});
