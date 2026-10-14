import { describe, expect, it } from 'vitest';
import { duckGainAt, itemGainAt, makeSourceTime, speechRanges } from '../../shared/editor-eval';
import { AudioMixer } from '../../renderer/lib/editor/playback/mixer';
import { AudioBuffers } from '../../renderer/lib/editor/playback/audio-buffers';
import { reverseBufferPos } from '../../renderer/lib/editor/playback/mixer-math';
import {
  aItem,
  asset,
  cue,
  FakeBuffer,
  FakeCtx,
  FakeMedia,
  project,
  track,
  vItem,
} from './editor-playback-fakes';
import type { Project } from '../../shared/editor';

interface Harness {
  ctx: FakeCtx;
  mixer: AudioMixer;
  els: FakeMedia[];
  timers: (() => void)[];
  perf: { v: number };
  buffers: AudioBuffers;
  decoded: Map<string, FakeBuffer>;
  /** Plays the transport forward in `step` increments, syncing like the engine's rAF loop. */
  run(opts: { from: number; to: number; step?: number; rate?: number }): void;
  setProject(p: Project): void;
  flushTimers(): void;
}

function harness(p: Project, opts: { lookaheadSec?: number } = {}): Harness {
  const ctx = new FakeCtx();
  const els: FakeMedia[] = [];
  const timers: (() => void)[] = [];
  const perf = { v: 1000 };
  const decoded = new Map<string, FakeBuffer>();
  const buffers = new AudioBuffers({
    decode: async (id) => (decoded.get(id) as unknown as AudioBuffer) ?? null,
    createBuffer: (c, l, s) => ctx.createBuffer(c, l, s) as unknown as AudioBuffer,
    onReady: () => {},
  });
  const mixer = new AudioMixer(
    {
      ctx: ctx as unknown as AudioContext,
      createElement: () => {
        const e = new FakeMedia();
        els.push(e);
        return e as unknown as HTMLMediaElement;
      },
      urlFor: (id) => `http://media/${id}`,
      buffers,
      perfNow: () => perf.v,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
    },
    opts,
  );
  mixer.setProject(p);
  const h: Harness = {
    ctx,
    mixer,
    els,
    timers,
    perf,
    buffers,
    decoded,
    run({ from, to, step = 0.1, rate = 1 }) {
      let t = from;
      while (t <= to + 1e-9) {
        mixer.sync({ tSec: t, playing: true, rate });
        t += step;
        ctx.currentTime += step / rate;
        for (const e of els)
          if (!e.paused) e.advanceTo(e.currentTime + (step / rate) * e.playbackRate);
        while (timers.length) timers.shift()?.(); // short release timers fire between frames
        perf.v += (step / rate) * 1000;
      }
    },
    setProject(np) {
      mixer.setProject(np);
    },
    flushTimers() {
      while (timers.length) timers.shift()?.();
    },
  };
  return h;
}

/** Gain nodes in creation order: master, then (level, duck) per track, then the voices. */
const trackCount = (h: Harness) => h.mixer.snapshot().tracks.length;
const gainParamOf = (h: Harness, i: number) => ({
  gain: h.ctx.gains[1 + 2 * trackCount(h) + i]!.gain,
});
const busOf = (h: Harness, trackIndex: number) => ({
  level: h.ctx.gains[1 + 2 * trackIndex]!.gain,
  duck: h.ctx.gains[2 + 2 * trackIndex]!.gain,
});

describe('mixer graph', () => {
  const a = asset({ id: 'm1', kind: 'audio' });
  const p = project(
    [track({ id: 'm', kind: 'audio', gain: 0.5, items: [aItem({ durationSec: 20 })] })],
    [a],
  );

  it('master chain: master → limiter (configured as a limiter) → destination', () => {
    const h = harness(p);
    expect(h.ctx.compressor.threshold.value).toBeLessThanOrEqual(-1);
    expect(h.ctx.compressor.ratio.value).toBeGreaterThanOrEqual(10);
    expect(h.ctx.compressor.knee.value).toBe(0);
    expect(h.ctx.compressor.out).toContain(h.ctx.destination);
  });
  it('creates a bus per track with the track gain; muting sets it to 0 and removes the voice', () => {
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const snap = h.mixer.snapshot();
    expect(snap.tracks).toHaveLength(1);
    expect(snap.tracks[0]!.level).toBe(0.5);
    expect(snap.voices).toHaveLength(1);
    h.setProject(project([{ ...p.tracks[0]!, muted: true }], p.assets));
    h.flushTimers();
    const s2 = h.mixer.snapshot();
    expect(s2.tracks[0]!.level).toBe(0);
    expect(s2.voices).toHaveLength(0);
  });
  it('removing a track disconnects its bus', () => {
    const h = harness(p);
    h.setProject(project([], p.assets));
    expect(h.mixer.snapshot().tracks).toHaveLength(0);
  });
});

describe('voice start and item gain', () => {
  const a = asset({ id: 'm1', kind: 'audio' });

  it('starts an element voice for the item under the playhead with the right pitch flag and rate', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ durationSec: 20, speed: 1.5, preservePitch: false })],
        }),
      ],
      [a],
    );
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.els).toHaveLength(1);
    const el = h.els[0]!;
    expect(el.playCalls).toBe(1);
    expect(el.playbackRate).toBeCloseTo(1.5, 6);
    expect(el.preservesPitch).toBe(false);
    expect(el.src).toBe('http://media/m1');
    expect(el.crossOrigin).toBe('anonymous');
  });
  it('seeks the element to the source position when starting mid-item (inSec + speed)', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ startSec: 2, durationSec: 20, inSec: 3, speed: 2 })],
        }),
      ],
      [a],
    );
    const h = harness(p);
    h.mixer.sync({ tSec: 5, playing: true, rate: 1 });
    const el = h.els[0]!;
    const expected = makeSourceTime(p.tracks[0]!.items[0] as never)(3);
    expect(el.currentTime).toBeGreaterThanOrEqual(expected);
    expect(el.currentTime).toBeLessThan(expected + 0.2);
  });
  it('gain is 0 until the item starts, then volume (automation evaluated in context time)', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ startSec: 1, durationSec: 4, volume: { v: 0.6, kf: [] } })],
        }),
      ],
      [a],
    );
    const h = harness(p);
    const c0 = h.ctx.currentTime;
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const g = gainParamOf(h, 0)!.gain;
    expect(g.valueAt(c0 + 0.5)).toBe(0);
    expect(g.valueAt(c0 + 1.2)).toBeCloseTo(0.6, 6);
  });
  it('fades: ramps in and out and is silent after the item ends', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ startSec: 0, durationSec: 6, fadeInSec: 2, fadeOutSec: 2 })],
        }),
      ],
      [a],
    );
    const h = harness(p);
    const c0 = h.ctx.currentTime;
    h.run({ from: 0, to: 6.5 });
    const g = gainParamOf(h, 0)!.gain;
    expect(g.valueAt(c0 + 1)).toBeCloseTo(0.5, 2);
    expect(g.valueAt(c0 + 3)).toBeCloseTo(1, 2);
    expect(g.valueAt(c0 + 5)).toBeCloseTo(0.5, 2);
    expect(g.valueAt(c0 + 6.2)).toBe(0);
  });
  it('automation equals itemGainAt across a keyframed volume curve', () => {
    const item = aItem({
      durationSec: 8,
      fadeInSec: 1,
      volume: {
        v: 1,
        kf: [
          { t: 0, v: 0.3, ease: 'ease-in-out' },
          { t: 5, v: 1.2, ease: 'linear' },
          { t: 8, v: 0.5, ease: 'linear' },
        ],
      },
    });
    const h = harness(project([track({ id: 'm', kind: 'audio', items: [item] })], [a]));
    const c0 = h.ctx.currentTime;
    h.run({ from: 0, to: 8.2 });
    const g = gainParamOf(h, 0)!.gain;
    for (let t = 0.05; t < 7.95; t += 0.1)
      expect(Math.abs(g.valueAt(c0 + t) - itemGainAt(item, t)), `t=${t}`).toBeLessThan(0.02);
  });
  it('the gain schedule is extended as the playhead advances (lookahead), not all at once', () => {
    const item = aItem({
      durationSec: 100,
      volume: {
        v: 1,
        kf: [
          { t: 0, v: 1, ease: 'linear' },
          { t: 90, v: 0.2, ease: 'linear' },
        ],
      },
    });
    const h = harness(project([track({ id: 'm', kind: 'audio', items: [item] })], [a]), {
      lookaheadSec: 2,
    });
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const evs = () => gainParamOf(h, 0)!.gain.events.length;
    const first = evs();
    expect(first).toBeLessThan(12);
    h.run({ from: 0.1, to: 30 });
    expect(evs()).toBeGreaterThan(first);
    const g = gainParamOf(h, 0)!.gain;
    expect(g.valueAt(h.ctx.currentTime)).toBeCloseTo(itemGainAt(item, 30), 1);
  });
  it('only schedules audio for items inside the lookahead window', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [
            aItem({ id: 'far', startSec: 10, durationSec: 4 }),
            aItem({ id: 'near', startSec: 1.5, durationSec: 4 }),
          ],
        }),
      ],
      [a],
    );
    const h = harness(p, { lookaheadSec: 2 });
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices.map((v) => v.itemId)).toEqual(['near']);
    h.run({ from: 0.1, to: 8.6 });
    expect(h.mixer.snapshot().voices.map((v) => v.itemId)).toContain('far');
  });
  it('the element of a future item is pre-rolled but not played until it is due', () => {
    const p = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ startSec: 1.5, durationSec: 4, inSec: 7 })],
        }),
      ],
      [a],
    );
    const h = harness(p, { lookaheadSec: 2 });
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const el = h.els[0]!;
    expect(el.playCalls).toBe(0);
    expect(el.currentTime).toBeCloseTo(7, 3);
    h.ctx.currentTime += 0.1;
    h.run({ from: 0.1, to: 1.5 });
    expect(el.playCalls).toBeGreaterThanOrEqual(1);
  });
  it('item volume stays exact when the transport runs at 2×', () => {
    const item = aItem({ durationSec: 10, fadeInSec: 4 });
    const h = harness(project([track({ id: 'm', kind: 'audio', items: [item] })], [a]));
    const c0 = h.ctx.currentTime;
    h.run({ from: 0, to: 6, step: 0.2, rate: 2 });
    const g = gainParamOf(h, 0)!.gain;
    // timeline 2 s is reached after 1 s of context time at 2×
    expect(g.valueAt(c0 + 1)).toBeCloseTo(itemGainAt(item, 2), 2);
    expect(h.els[0]!.playbackRate).toBeCloseTo(2, 6);
  });
  it('video items with audio get a voice; audioEnabled=false and silent assets do not', () => {
    const va = asset({ id: 'a1', hasAudio: true });
    const vs = asset({ id: 'a2', hasAudio: false });
    const p = project(
      [
        track({
          id: 'v',
          kind: 'video',
          speech: true,
          items: [
            vItem({ id: 'with' }),
            vItem({ id: 'off', audioEnabled: false, startSec: 0 }),
            vItem({ id: 'mute', assetId: 'a2' }),
          ],
        }),
      ],
      [va, vs],
    );
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices.map((v) => v.itemId)).toEqual(['with']);
  });
  it('freeze frames are silent', () => {
    const p = project([track({ id: 'v', items: [vItem({ freezeAtSec: 2 })] })], [asset()]);
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices).toHaveLength(0);
  });
});

describe('ducking', () => {
  const words: [string, number, number][] = [['hello', 0, 0.8]];
  const music = asset({ id: 'm1', kind: 'audio' });
  const mk = (ducking: Record<string, unknown>) =>
    project(
      [
        track({ id: 'm', kind: 'audio', ducking, items: [aItem({ durationSec: 30 })] }),
        track({ id: 's', kind: 'subtitle', items: [cue('c1', 4, words), cue('c2', 10, words)] }),
      ],
      [music],
    );
  const d = { enabled: true, reductionDb: 14, attackSec: 0.3, releaseSec: 0.7 };

  it('the duck node follows duckGainAt exactly (breakpoints from duckBreakpoints)', () => {
    const p = mk(d);
    const h = harness(p);
    const c0 = h.ctx.currentTime;
    h.run({ from: 0, to: 16, step: 0.1 });
    const ranges = speechRanges(p);
    const duck = busOf(h, 0).duck;
    expect(duck.events.length).toBeGreaterThan(4);
    let worst = 0;
    for (let t = 0; t < 15; t += 0.02)
      worst = Math.max(worst, Math.abs(duck.valueAt(c0 + t) - duckGainAt(ranges, d, t)));
    expect(worst).toBeLessThan(2e-3);
  });
  it('the snapshot reports measured vs expected duck and effective gain', () => {
    const p = mk(d);
    const h = harness(p);
    h.run({ from: 0, to: 4.3, step: 0.1 });
    const s = h.mixer.snapshot();
    const tr = s.tracks.find((x) => x.trackId === 'm')!;
    expect(tr.duckEnabled).toBe(true);
    expect(tr.duck).toBeCloseTo(tr.expectedDuck, 2);
    expect(tr.duck).toBeLessThan(1);
    const v = s.voices[0]!;
    expect(v.effectiveGain).toBeCloseTo(v.expectedGain, 2);
  });
  it('tracks without ducking enabled keep the duck node at 1', () => {
    const p = mk({ ...d, enabled: false });
    const h = harness(p);
    h.run({ from: 0, to: 6, step: 0.1 });
    const tr = h.mixer.snapshot().tracks.find((x) => x.trackId === 'm')!;
    expect(tr.duck).toBe(1);
  });
  it('turning ducking off during playback restores unity', () => {
    const p = mk(d);
    const h = harness(p);
    h.run({ from: 0, to: 4.5, step: 0.1 });
    expect(h.mixer.snapshot().tracks.find((x) => x.trackId === 'm')!.duck).toBeLessThan(1);
    h.setProject(mk({ ...d, enabled: false }));
    h.mixer.sync({ tSec: 4.6, playing: true, rate: 1 });
    expect(h.mixer.snapshot().tracks.find((x) => x.trackId === 'm')!.duck).toBe(1);
  });
  it('speech from tracks marked `speech` ducks music when there are no subtitles', () => {
    const va = asset({ id: 'a1' });
    const p = project(
      [
        track({ id: 'v', speech: true, items: [vItem({ startSec: 2, durationSec: 3 })] }),
        track({ id: 'm', kind: 'audio', ducking: d, items: [aItem({ durationSec: 20 })] }),
      ],
      [va, music],
    );
    const h = harness(p);
    const c0 = h.ctx.currentTime;
    h.run({ from: 0, to: 6, step: 0.1 });
    const duck = busOf(h, 1).duck;
    expect(duck.valueAt(c0 + 3)).toBeCloseTo(Math.pow(10, -14 / 20), 3);
    expect(duck.valueAt(c0 + 0.5)).toBe(1);
  });
});

describe('speed and pitch', () => {
  const a = asset({ id: 'm1', kind: 'audio' });
  it('speed 2 → element playbackRate 2; transport 2× → 4', () => {
    const h = harness(
      project(
        [track({ id: 'm', kind: 'audio', items: [aItem({ speed: 2, durationSec: 20 })] })],
        [a],
      ),
    );
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.els[0]!.playbackRate).toBe(2);
    const h2 = harness(
      project(
        [track({ id: 'm', kind: 'audio', items: [aItem({ speed: 2, durationSec: 20 })] })],
        [a],
      ),
    );
    h2.mixer.sync({ tSec: 0, playing: true, rate: 2 });
    expect(h2.els[0]!.playbackRate).toBe(4);
  });
  it('a speed ramp updates the element rate as the playhead moves', () => {
    const item = aItem({
      durationSec: 10,
      speedCurve: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 10, v: 3, ease: 'linear' },
      ],
    });
    const h = harness(project([track({ id: 'm', kind: 'audio', items: [item] })], [a]));
    const rates: number[] = [];
    let t = 0;
    for (let i = 0; i < 80; i++) {
      h.mixer.sync({ tSec: t, playing: true, rate: 1 });
      const el = h.els[0]!;
      rates.push(el.playbackRate);
      t += 0.1;
      h.ctx.currentTime += 0.1;
      if (!el.paused) el.advanceTo(el.currentTime + 0.1 * el.playbackRate);
    }
    expect(rates[1]).toBeCloseTo(1, 1);
    expect(rates[40]).toBeGreaterThan(1.6);
    expect(rates[40]).toBeLessThan(2.4);
    expect(rates[79]).toBeGreaterThan(2.5);
    expect(rates[79]!).toBeGreaterThan(rates[40]!);
  });
  it('speeds the media pipeline would mute use a decoded buffer with that playbackRate', () => {
    const buf = new FakeBuffer(1, 48000 * 30, 48000);
    const h = harness(
      project(
        [track({ id: 'm', kind: 'audio', items: [aItem({ speed: 8, durationSec: 4 })] })],
        [a],
      ),
    );
    h.decoded.set('m1', buf);
    h.buffers.requestAsset('m1');
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
      expect(h.els).toHaveLength(0);
      const src = h.ctx.sources[0]!;
      expect(src.started).not.toBeNull();
      expect(src.playbackRate.valueAt(h.ctx.currentTime + 1)).toBe(8);
    });
  });
  it('drift correction: a small drift nudges the rate, a large one seeks (rate-limited)', () => {
    const item = aItem({ durationSec: 20 });
    const h = harness(project([track({ id: 'm', kind: 'audio', items: [item] })], [a]));
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const el = h.els[0]!;
    h.ctx.currentTime += 1;
    el.advanceTo(1.08); // 80 ms ahead of tl=1
    h.mixer.sync({ tSec: 1, playing: true, rate: 1 });
    expect(el.playbackRate).toBeLessThan(1);
    expect(el.playbackRate).toBeGreaterThan(0.94);
    const seeks = el.seekWrites.length;
    h.ctx.currentTime += 1;
    h.perf.v += 5000;
    el.advanceTo(3.6); // far ahead of tl=2
    h.mixer.sync({ tSec: 2, playing: true, rate: 1 });
    expect(el.seekWrites.length).toBe(seeks + 1);
    expect(el.currentTime).toBeCloseTo(2.03, 2);
    // immediately drifting again does not seek again within 400 ms
    h.perf.v += 100;
    el.advanceTo(5);
    h.ctx.currentTime += 0.05;
    h.mixer.sync({ tSec: 2.05, playing: true, rate: 1 });
    expect(el.seekWrites.length).toBe(seeks + 1);
  });
});

describe('reverse', () => {
  const a = asset({ id: 'm1', kind: 'audio', durationSec: 30 });
  const item = aItem({ id: 'r', startSec: 0, durationSec: 6, inSec: 4, reverse: true });
  const p = project([track({ id: 'm', kind: 'audio', items: [item] })], [a]);

  it('waits for the decoded, reversed buffer; no element is used', async () => {
    const h = harness(p);
    h.decoded.set('m1', Object.assign(new FakeBuffer(1, 48000 * 30, 48000)));
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.els).toHaveLength(0);
    expect(h.ctx.sources).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    h.ctx.currentTime += 0.1;
    h.mixer.sync({ tSec: 0.1, playing: true, rate: 1 });
    expect(h.ctx.sources).toHaveLength(1);
  });
  it('the reversed buffer holds the window backwards (frame k of the copy = last frame − k of the window)', async () => {
    const h = harness(p);
    const src = new FakeBuffer(1, 48000 * 30, 48000);
    const d = src.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = i / d.length;
    h.decoded.set('m1', src);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    await new Promise((r) => setTimeout(r, 0));
    h.mixer.sync({ tSec: 0.1, playing: true, rate: 1 });
    const rb = h.ctx.sources[0]!.buffer!;
    expect(rb.duration).toBeCloseTo(6, 3);
    const r = rb.getChannelData(0);
    expect(r[0]!).toBeCloseTo((10 * 48000 - 1) / d.length, 6); // window end (4 + 6) − 1 sample
    expect(r[r.length - 1]!).toBeCloseTo((4 * 48000) / d.length, 6); // window start
    expect(r[1000]!).toBeGreaterThan(r[2000]!);
  });
  it('starting mid-item begins at the right offset in the reversed copy', async () => {
    const h = harness(p);
    h.decoded.set('m1', new FakeBuffer(1, 48000 * 30, 48000));
    h.buffers.requestAsset('m1');
    await new Promise((r) => setTimeout(r, 0));
    h.mixer.sync({ tSec: 2.5, playing: true, rate: 1 });
    await new Promise((r) => setTimeout(r, 0));
    h.ctx.currentTime += 0.05;
    h.mixer.sync({ tSec: 2.55, playing: true, rate: 1 });
    const s = h.ctx.sources.at(-1)!;
    expect(s.started!.offset).toBeCloseTo(reverseBufferPos(item, 30, 2.55), 2);
    expect(s.stopped).not.toBeNull();
  });
  it('decoded buffers of reverse items are freed when the project no longer needs them', async () => {
    const h = harness(p);
    h.decoded.set('m1', new FakeBuffer(1, 48000 * 30, 48000));
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    await new Promise((r) => setTimeout(r, 0));
    h.mixer.sync({ tSec: 0.1, playing: true, rate: 1 });
    expect(h.buffers.stats.reversed).toBe(1);
    h.setProject(
      project(
        [track({ id: 'm', kind: 'audio', items: [aItem({ id: 'r', durationSec: 6 })] })],
        [a],
      ),
    );
    expect(h.buffers.stats.reversed).toBe(0);
    h.setProject(project([], [a]));
    expect(h.buffers.stats.assets).toBe(0);
  });
});

describe('transport states and re-anchoring', () => {
  const a = asset({ id: 'm1', kind: 'audio' });
  const p = project([track({ id: 'm', kind: 'audio', items: [aItem({ durationSec: 30 })] })], [a]);

  it('pause silences everything', () => {
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices).toHaveLength(1);
    h.mixer.sync({ tSec: 0.2, playing: false, rate: 1 });
    h.flushTimers();
    expect(h.mixer.snapshot().voices).toHaveLength(0);
    expect(h.els[0]!.paused).toBe(true);
  });
  it('reverse and fast shuttle are silent; 1× and 2× are audible', () => {
    for (const [rate, voices] of [
      [-1, 0],
      [4, 0],
      [8, 0],
      [1, 1],
      [2, 1],
      [0.5, 1],
    ] as const) {
      const h = harness(p);
      h.mixer.sync({ tSec: 1, playing: true, rate });
      expect(h.mixer.snapshot().voices.length, `rate ${rate}`).toBe(voices);
    }
  });
  it('a seek re-anchors: the element is moved to the new position', () => {
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    h.ctx.currentTime += 0.1;
    h.mixer.sync({ tSec: 12, playing: true, rate: 1 });
    h.flushTimers();
    const els = h.els;
    const playing = els.filter((e) => !e.paused);
    expect(playing.length).toBeGreaterThanOrEqual(1);
    expect(playing[0]!.currentTime).toBeGreaterThan(11.9);
    expect(h.mixer.snapshot().anchor!.tl0).toBe(12);
  });
  it('changing the transport rate re-anchors with the new rate', () => {
    const h = harness(p);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    h.mixer.sync({ tSec: 0.05, playing: true, rate: 2 });
    expect(h.mixer.snapshot().anchor!.rate).toBe(2);
  });
  it('a suspended context is resumed and nothing is scheduled meanwhile', () => {
    const h = harness(p);
    h.ctx.state = 'suspended';
    h.ctx.resume = () => {
      return Promise.resolve();
    };
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices).toHaveLength(0);
  });
  it('an edited item replaces its voice; unchanged items keep playing', () => {
    const two = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [
            aItem({ id: 'one', durationSec: 30 }),
            aItem({ id: 'two', startSec: 0, durationSec: 30 }),
          ],
        }),
      ],
      [a],
    );
    const h = harness(two);
    h.mixer.sync({ tSec: 0, playing: true, rate: 1 });
    const before = h.els.length;
    const edited = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [
            two.tracks[0]!.items[0]!,
            { ...two.tracks[0]!.items[1]!, volume: { v: 0.3, kf: [] } } as never,
          ],
        }),
      ],
      [a],
    );
    h.setProject(edited);
    h.mixer.sync({ tSec: 0.05, playing: true, rate: 1 });
    const s = h.mixer.snapshot();
    expect(s.voices.map((v) => v.itemId).sort()).toEqual(['one', 'two']);
    expect(h.els.length).toBeGreaterThanOrEqual(before); // a voice was rebuilt for 'two'
  });
  it('items that end are released and their nodes recycled', () => {
    const short = project(
      [
        track({
          id: 'm',
          kind: 'audio',
          items: [aItem({ durationSec: 1 }), aItem({ id: 'b', startSec: 3, durationSec: 1 })],
        }),
      ],
      [a],
    );
    const h = harness(short);
    h.run({ from: 0, to: 2.5, step: 0.1 });
    h.flushTimers();
    // the first item is gone; the second is already pre-rolled (inside the lookahead)
    expect(h.mixer.snapshot().voices.map((v) => v.itemId)).toEqual(['b']);
    h.run({ from: 2.6, to: 4.5, step: 0.1 });
    h.flushTimers();
    expect(h.mixer.snapshot().voices).toHaveLength(0);
    // at most one extra element (the released one is still draining for ~12 ms when the next item arrives)
    expect(h.els.length).toBeLessThanOrEqual(2);
    h.run({ from: 4.6, to: 4.7, step: 0.1 });
  });
});

describe('scrub grains', () => {
  const a = asset({ id: 'm1', kind: 'audio', durationSec: 30 });
  const item = aItem({ startSec: 2, durationSec: 10, inSec: 1, volume: { v: 0.8, kf: [] } });
  const p = project([track({ id: 'm', kind: 'audio', items: [item] })], [a]);

  it('plays an 80 ms grain of the decoded asset at the scrubbed source position', async () => {
    const h = harness(p);
    h.decoded.set('m1', new FakeBuffer(1, 48000 * 30, 48000));
    h.buffers.requestAsset('m1');
    await new Promise((r) => setTimeout(r, 0));
    h.mixer.scrub(5);
    const s = h.ctx.sources.at(-1)!;
    expect(s.started!.offset).toBeCloseTo(1 + 3, 6);
    expect(s.started!.dur).toBeCloseTo(0.09, 6);
    const g = h.ctx.gains.at(-1)!.gain;
    expect(g.valueAt(h.ctx.currentTime + 0.04)).toBeCloseTo(0.8, 6);
    expect(g.valueAt(h.ctx.currentTime + 0.08)).toBeCloseTo(0, 6);
    expect(g.valueAt(h.ctx.currentTime)).toBe(0);
  });
  it('throttles grains (one per 45 ms) and ignores positions with no audio', async () => {
    const h = harness(p);
    h.decoded.set('m1', new FakeBuffer(1, 48000 * 30, 48000));
    h.buffers.requestAsset('m1');
    await new Promise((r) => setTimeout(r, 0));
    h.mixer.scrub(5);
    h.perf.v += 20;
    h.mixer.scrub(5.02);
    expect(h.ctx.sources).toHaveLength(1);
    h.perf.v += 30;
    h.mixer.scrub(5.04);
    expect(h.ctx.sources).toHaveLength(2);
    h.perf.v += 100;
    h.mixer.scrub(0.5); // before the item
    expect(h.ctx.sources).toHaveLength(2);
  });
  it('requests the decode on the first scrub so later grains have sound', async () => {
    const h = harness(p);
    h.decoded.set('m1', new FakeBuffer(1, 48000 * 30, 48000));
    h.mixer.scrub(5);
    expect(h.ctx.sources).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    h.perf.v += 100;
    h.mixer.scrub(5.1);
    expect(h.ctx.sources).toHaveLength(1);
  });
});

describe('snapshot', () => {
  it('reports rate, pitch flag, source time and gains per voice', () => {
    const a = asset({ id: 'm1', kind: 'audio' });
    const item = aItem({ durationSec: 20, speed: 1.25, volume: { v: 0.5, kf: [] } });
    const h = harness(project([track({ id: 'm', kind: 'audio', gain: 0.8, items: [item] })], [a]));
    h.run({ from: 0, to: 1, step: 0.1 });
    const v = h.mixer.snapshot().voices[0]!;
    expect(v.kind).toBe('element');
    expect(v.preservesPitch).toBe(true);
    expect(v.playbackRate).toBeCloseTo(v.expectedRate, 2);
    expect(v.expectedItemGain).toBeCloseTo(0.5, 6);
    expect(v.effectiveGain).toBeCloseTo(0.4, 2);
    expect(v.expectedGain).toBeCloseTo(0.4, 6);
  });
});

describe('transition crossfade in the audio graph', () => {
  const a = asset({ id: 'a1', hasAudio: true });
  const mk = (type: string) =>
    project(
      [
        track({
          id: 'v',
          speech: true,
          items: [
            vItem({ id: 'one', startSec: 0, durationSec: 5 }),
            vItem({
              id: 'two',
              startSec: 4,
              durationSec: 5,
              transitionIn: { type, durationSec: 1 },
            }),
          ],
        }),
      ],
      [a],
    );
  const voiceGain = (h: Harness, i: number) => ({
    gain: h.ctx.gains[1 + 2 * trackCount(h) + i]!.gain,
  });

  it('both voices ramp against each other across the overlap and sum to unity gain', () => {
    const h = harness(mk('crossfade'));
    const c0 = h.ctx.currentTime;
    h.run({ from: 3, to: 5.2, step: 0.1 });
    const g = (id: string) => (id === 'one' ? voiceGain(h, 0) : voiceGain(h, 1)).gain;
    // voice gain nodes are created in order of appearance (one first, two second)
    for (const t of [4.1, 4.25, 4.5, 4.75]) {
      const o = g('one').valueAt(c0 + (t - 3));
      const n = g('two').valueAt(c0 + (t - 3));
      expect(o).toBeCloseTo(5 - 4 - (t - 4) > 0 ? 1 - (t - 4) : 0, 1);
      expect(n).toBeCloseTo(t - 4, 1);
      expect(o + n).toBeCloseTo(1, 1);
    }
  });
  it('the snapshot reports the crossfade and an effective gain that includes it', () => {
    const h = harness(mk('crossfade'));
    h.run({ from: 3, to: 4.5, step: 0.1 });
    const s = h.mixer.snapshot();
    const one = s.voices.find((v) => v.itemId === 'one')!;
    const two = s.voices.find((v) => v.itemId === 'two')!;
    expect(one.transitionGain).toBeCloseTo(
      1 - (s.anchor!.tl0 + (s.currentTime - s.anchor!.ctx0) - 4),
      1,
    );
    expect(one.expectedGain).toBeCloseTo(one.transitionGain, 6);
    expect(two.expectedGain).toBeCloseTo(two.transitionGain, 6);
    expect(one.transitionGain + two.transitionGain).toBeCloseTo(1, 6);
    expect(one.effectiveGain).toBeCloseTo(one.expectedGain, 1);
  });
  it('a cut overlap silences the outgoing voice from the incoming start', () => {
    const h = harness(mk('cut'));
    const c0 = h.ctx.currentTime;
    h.run({ from: 3, to: 5.2, step: 0.1 });
    expect(voiceGain(h, 0).gain.valueAt(c0 + 0.9)).toBeCloseTo(1, 6);
    expect(voiceGain(h, 0).gain.valueAt(c0 + 1.2)).toBeCloseTo(0, 6);
    expect(voiceGain(h, 1).gain.valueAt(c0 + 1.2)).toBeCloseTo(1, 6);
  });
  it('outside a transition the multiplier is 1', () => {
    const h = harness(mk('crossfade'));
    h.run({ from: 1, to: 2, step: 0.1 });
    expect(h.mixer.snapshot().voices[0]!.transitionGain).toBe(1);
  });
  it('hidden tracks, muted tracks and freeze frames stay silent (exporter rules)', () => {
    const base = mk('crossfade');
    for (const patch of [{ hidden: true }, { muted: true }]) {
      const h = harness(project([{ ...base.tracks[0]!, ...patch }], [a]));
      h.mixer.sync({ tSec: 4.2, playing: true, rate: 1 });
      expect(h.mixer.snapshot().voices).toHaveLength(0);
    }
    const frozen = project(
      [track({ id: 'v', items: [vItem({ id: 'f', freezeAtSec: 1, durationSec: 5 })] })],
      [a],
    );
    const h = harness(frozen);
    h.mixer.sync({ tSec: 1, playing: true, rate: 1 });
    expect(h.mixer.snapshot().voices).toHaveLength(0);
  });
});
