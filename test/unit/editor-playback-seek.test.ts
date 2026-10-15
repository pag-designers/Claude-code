import { describe, expect, it } from 'vitest';
import {
  canPlayNatively,
  DEFAULT_SEEK_CONFIG,
  planVideoSync,
  quantizeToFrame,
  staleToleranceSec,
  type ElementState,
  type SeekWant,
} from '../../renderer/lib/editor/playback/seek-policy';
import { clampToAsset, sourceAt, sourceRateAt } from '../../renderer/lib/editor/playback/src-time';
import { upcomingVideoFrames } from '../../renderer/lib/editor/playback/prefetch';
import { asset, project, track, vItem } from './editor-playback-fakes';

const el = (o: Partial<ElementState> = {}): ElementState => ({
  currentTime: 0,
  paused: true,
  seeking: false,
  ended: false,
  playbackRate: 1,
  readyState: 4,
  duration: 60,
  ...o,
});
const want = (o: Partial<SeekWant> = {}): SeekWant => ({
  srcSec: 5,
  rate: 1,
  playing: true,
  frameSec: 1 / 30,
  inFlight: null,
  ...o,
});

describe('seek policy: forward playback lets the element play (no seek per frame)', () => {
  it('starts a paused element: seeks once to the frame, plays at the wanted rate', () => {
    const p = planVideoSync(el({ currentTime: 0 }), want({ srcSec: 5, rate: 2 }));
    expect(p).toMatchObject({ mode: 'play', seekTo: 5, play: true, rate: 2 });
  });
  it('a playing element that is on time is left alone', () => {
    const p = planVideoSync(el({ paused: false, currentTime: 5.01 }), want({ srcSec: 5 }));
    expect(p).toMatchObject({ mode: 'play', seekTo: null, play: true, rate: null });
  });
  it('small drift is steered with a rate nudge, never a seek (element ahead → slower)', () => {
    const ahead = planVideoSync(el({ paused: false, currentTime: 5.1 }), want({ srcSec: 5 }));
    expect(ahead.seekTo).toBeNull();
    expect(ahead.rate as number).toBeLessThan(1);
    expect(ahead.rate as number).toBeGreaterThanOrEqual(0.9);
    const behind = planVideoSync(el({ paused: false, currentTime: 4.9 }), want({ srcSec: 5 }));
    expect(behind.seekTo).toBeNull();
    expect(behind.rate as number).toBeGreaterThan(1);
    expect(behind.rate as number).toBeLessThanOrEqual(1.1);
  });
  it('the nudge is capped at ±10 %', () => {
    const p = planVideoSync(el({ paused: false, currentTime: 5.25 }), want({ srcSec: 5 }));
    expect(p.rate as number).toBeCloseTo(0.9, 5);
  });
  it('a large drift hard-seeks (and keeps playing)', () => {
    const p = planVideoSync(el({ paused: false, currentTime: 7 }), want({ srcSec: 5 }));
    expect(p).toMatchObject({ mode: 'play', seekTo: 5, play: true, rate: 1 });
  });
  it('the hard-drift threshold scales with the playback rate', () => {
    const slow = planVideoSync(
      el({ paused: false, currentTime: 5.4, playbackRate: 4 }),
      want({ srcSec: 5, rate: 4 }),
    );
    expect(slow.seekTo).toBeNull(); // 0.4 s at 4× is under 0.3·4
    const far = planVideoSync(
      el({ paused: false, currentTime: 6.5, playbackRate: 4 }),
      want({ srcSec: 5, rate: 4 }),
    );
    expect(far.seekTo).toBe(5);
  });
  it('does not re-seek while a seek is in flight near the target, but re-targets if the target moved far', () => {
    const wait = planVideoSync(
      el({ seeking: true, paused: false }),
      want({ srcSec: 5, inFlight: 4.9 }),
    );
    expect(wait).toMatchObject({ seekTo: null, deferSeek: null });
    const moved = planVideoSync(
      el({ seeking: true, paused: false }),
      want({ srcSec: 9, inFlight: 4.9 }),
    );
    expect(moved.seekTo).toBeNull();
    expect(moved.deferSeek).toBe(9);
  });
  it('updates the playbackRate when a speed ramp changes it', () => {
    const p = planVideoSync(
      el({ paused: false, currentTime: 5, playbackRate: 1 }),
      want({ srcSec: 5, rate: 1.5 }),
    );
    expect(p.rate).toBe(1.5);
  });
  it('plays natively only inside the supported rate range', () => {
    expect(canPlayNatively(1)).toBe(true);
    expect(canPlayNatively(8)).toBe(true);
    expect(canPlayNatively(10)).toBe(false);
    expect(canPlayNatively(0.05)).toBe(false);
    expect(canPlayNatively(-1)).toBe(false);
    expect(canPlayNatively(0)).toBe(false);
  });
});

describe('seek policy: discrete cases (reverse, freeze, scrub, out-of-range speed)', () => {
  it('reverse pauses and seeks to the frame', () => {
    const p = planVideoSync(el({ paused: false, currentTime: 6 }), want({ srcSec: 4, rate: -1 }));
    expect(p.mode).toBe('discrete');
    expect(p.play).toBe(false);
    expect(p.seekTo).toBeCloseTo(quantizeToFrame(4, 1 / 30), 9);
  });
  it('freeze (rate 0) seeks once, then is settled', () => {
    const first = planVideoSync(el({ currentTime: 0 }), want({ srcSec: 3, rate: 0 }));
    expect(first.seekTo).not.toBeNull();
    const t = first.seekTo as number;
    const second = planVideoSync(el({ currentTime: t }), want({ srcSec: 3, rate: 0 }));
    expect(second).toMatchObject({ seekTo: null, deferSeek: null, play: false });
  });
  it('paused transport (scrubbing) is discrete even for forward items', () => {
    const p = planVideoSync(el({ paused: true }), want({ playing: false, srcSec: 2 }));
    expect(p.mode).toBe('discrete');
    expect(p.seekTo).not.toBeNull();
  });
  it('speeds above the native range are seeked, not played', () => {
    const p = planVideoSync(el({ paused: false }), want({ rate: 10, srcSec: 7 }));
    expect(p.mode).toBe('discrete');
    expect(p.play).toBe(false);
  });
  it('at most one seek is in flight: a new target while seeking is deferred (latest wins)', () => {
    const p = planVideoSync(
      el({ seeking: true }),
      want({ playing: false, srcSec: 8, inFlight: 5 }),
    );
    expect(p.seekTo).toBeNull();
    expect(p.deferSeek).toBe(quantizeToFrame(8, 1 / 30));
  });
  it('no deferral when the seek in flight already goes to the wanted frame', () => {
    const t = quantizeToFrame(8, 1 / 30);
    const p = planVideoSync(
      el({ seeking: true }),
      want({ playing: false, srcSec: 8, inFlight: t }),
    );
    expect(p).toMatchObject({ seekTo: null, deferSeek: null });
  });
  it('a pause is requested when the element still plays', () => {
    const p = planVideoSync(
      el({ paused: false, currentTime: 3 }),
      want({ playing: false, srcSec: 3, rate: 1 }),
    );
    expect(p.play).toBe(false);
  });
  it('frame tolerance: half a frame from the target counts as settled', () => {
    const t = quantizeToFrame(2, 1 / 30);
    const near = planVideoSync(el({ currentTime: t + 0.015 }), want({ playing: false, srcSec: 2 }));
    expect(near.seekTo).toBeNull();
    const off = planVideoSync(el({ currentTime: t + 0.05 }), want({ playing: false, srcSec: 2 }));
    expect(off.seekTo).not.toBeNull();
  });
});

describe('frame maths', () => {
  it('quantizeToFrame lands a quarter frame into the frame, robust to float noise', () => {
    const f = 1 / 30;
    expect(quantizeToFrame(1, f)).toBeCloseTo(1 + 0.25 * f, 9);
    expect(quantizeToFrame(1 - 1e-9, f)).toBeCloseTo(1 + 0.25 * f, 9);
    expect(quantizeToFrame(0.5, f)).toBeCloseTo(0.5 + 0.25 * f, 9);
    expect(quantizeToFrame(3, 0)).toBe(3);
  });
  it('stale tolerance grows with the speed while playing and is generous when paused', () => {
    expect(staleToleranceSec(1, true, 1 / 30)).toBeCloseTo(0.25, 5);
    expect(staleToleranceSec(8, true, 1 / 30)).toBeCloseTo(2, 5);
    expect(staleToleranceSec(0, false, 1 / 30)).toBeCloseTo(0.25, 5);
  });
  it('default config sane', () => {
    expect(DEFAULT_SEEK_CONFIG.maxPlayRate).toBeGreaterThanOrEqual(4);
  });
});

describe('source time mapping (speed / reverse / freeze)', () => {
  const a = asset({ durationSec: 20 });
  it('constant speed', () => {
    const it = vItem({ speed: 2, inSec: 1, durationSec: 5, startSec: 3 });
    expect(sourceAt(it, a, 3)).toBeCloseTo(1, 6);
    expect(sourceAt(it, a, 5)).toBeCloseTo(5, 6); // 2 s of timeline × 2
    expect(sourceRateAt(it, 4, 1)).toBe(2);
    expect(sourceRateAt(it, 4, 2)).toBe(4);
    expect(sourceRateAt(it, 4, -1)).toBe(-2);
  });
  it('reverse plays the window backwards', () => {
    const it = vItem({ reverse: true, inSec: 2, durationSec: 4 });
    expect(sourceAt(it, a, 0)).toBeCloseTo(6, 6);
    expect(sourceAt(it, a, 3)).toBeCloseTo(3, 6);
    expect(sourceRateAt(it, 1, 1)).toBe(-1);
  });
  it('freeze holds one frame and has rate 0', () => {
    const it = vItem({ freezeAtSec: 7.5, durationSec: 4, speed: 3 });
    expect(sourceAt(it, a, 0)).toBe(7.5);
    expect(sourceAt(it, a, 3.9)).toBe(7.5);
    expect(sourceRateAt(it, 1, 1)).toBe(0);
  });
  it('speed ramp: instantaneous rate follows the curve', () => {
    const it = vItem({
      speedCurve: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 10, v: 3, ease: 'linear' },
      ],
    });
    expect(sourceRateAt(it, 0, 1)).toBeCloseTo(1, 6);
    expect(sourceRateAt(it, 5, 1)).toBeCloseTo(2, 6);
    expect(sourceRateAt(it, 10, 1)).toBeCloseTo(3, 6);
  });
  it('clamps to the asset (hold first / last frame)', () => {
    expect(clampToAsset(-3, 20)).toBe(0);
    expect(clampToAsset(25, 20)).toBeLessThan(20);
    expect(clampToAsset(25, null)).toBe(25);
    const it = vItem({ speed: 10, durationSec: 10 });
    expect(sourceAt(it, a, 9)).toBeLessThan(20);
  });
});

describe('prefetch of upcoming cuts', () => {
  const a = asset({ durationSec: 30 });
  const t1 = track({
    id: 'v',
    items: [
      vItem({ id: 'one', startSec: 0, durationSec: 4 }),
      vItem({ id: 'two', startSec: 4, durationSec: 4, inSec: 12 }),
      vItem({ id: 'far', startSec: 20, durationSec: 4 }),
    ],
  });
  const proj = project([t1], [a]);
  it('returns items starting within the horizon with their first source frame', () => {
    const up = upcomingVideoFrames(proj, 3.5, 1, 0.75, new Set(['one']));
    expect(up).toEqual([{ assetId: 'a1', srcSec: 12, itemId: 'two' }]);
  });
  it('ignores visible items, far items and items already past', () => {
    expect(upcomingVideoFrames(proj, 3.5, 1, 0.75, new Set(['one', 'two']))).toEqual([]);
    expect(upcomingVideoFrames(proj, 1, 1, 0.75, new Set())).toEqual([]);
  });
  it('widens the horizon with the transport rate', () => {
    expect(upcomingVideoFrames(proj, 2.5, 4, 0.75, new Set(['one'])).map((u) => u.itemId)).toEqual([
      'two',
    ]);
  });
  it('looks backwards in reverse transport, at the last frame of the earlier item', () => {
    const up = upcomingVideoFrames(proj, 4.2, -1, 0.75, new Set(['two']));
    expect(up).toEqual([{ assetId: 'a1', srcSec: 4, itemId: 'one' }]);
  });
  it('skips hidden tracks and respects the limit', () => {
    const hidden = project([{ ...t1, hidden: true }], [a]);
    expect(upcomingVideoFrames(hidden, 3.5, 1, 0.75, new Set())).toEqual([]);
    const many = project(
      [
        track({
          id: 'v',
          items: Array.from({ length: 6 }, (_, i) =>
            vItem({ id: `x${i}`, startSec: 10 + i * 0.1, durationSec: 1 }),
          ),
        }),
      ],
      [a],
    );
    expect(upcomingVideoFrames(many, 9.5, 1, 1, new Set(), 3)).toHaveLength(3);
  });
});
