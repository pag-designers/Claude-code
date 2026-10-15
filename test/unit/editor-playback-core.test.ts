import { describe, expect, it } from 'vitest';
import { LruCache } from '../../renderer/lib/editor/playback/lru';
import { MasterClock } from '../../renderer/lib/editor/playback/clock';
import { AssetCaches, quantizeRange, stripKey } from '../../renderer/lib/editor/playback/caches';
import { PreviewUrls } from '../../renderer/lib/editor/playback/urls';
import { FrameStats } from '../../renderer/lib/editor/playback/frame-stats';

describe('LruCache', () => {
  it('evicts the least recently used entry beyond maxEntries', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>({ maxEntries: 2, onEvict: (k) => evicted.push(k) });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a is now newest
    c.set('c', 3);
    expect(c.keys()).toEqual(['a', 'c']);
    expect(evicted).toEqual(['b']);
  });
  it('peek does not refresh recency, get does', () => {
    const c = new LruCache<string, number>({ maxEntries: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.peek('a');
    c.set('c', 3);
    expect(c.has('a')).toBe(false);
    const d = new LruCache<string, number>({ maxEntries: 2 });
    d.set('a', 1);
    d.set('b', 2);
    d.get('a');
    d.set('c', 3);
    expect(d.has('a')).toBe(true);
    expect(d.has('b')).toBe(false);
  });
  it('re-setting a key replaces the value and the cost', () => {
    const c = new LruCache<string, number>({ maxEntries: 5, maxCost: 100, cost: (v) => v });
    c.set('a', 40);
    c.set('a', 10);
    expect(c.size).toBe(1);
    expect(c.totalCost).toBe(10);
  });
  it('enforces the cost cap but never evicts the entry just set', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>({
      maxEntries: 10,
      maxCost: 100,
      cost: (v) => v,
      onEvict: (k) => evicted.push(k),
    });
    c.set('a', 60);
    c.set('b', 30);
    c.set('c', 50); // 140 > 100 → evict a (oldest)
    expect(evicted).toEqual(['a']);
    c.set('huge', 500); // alone over the cap, still kept
    expect(c.keys()).toEqual(['huge']);
    expect(c.totalCost).toBe(500);
  });
  it('delete, clear and retain call onEvict and keep the cost in sync', () => {
    const evicted: string[] = [];
    const c = new LruCache<string, number>({
      maxEntries: 10,
      cost: (v) => v,
      maxCost: 1000,
      onEvict: (k) => evicted.push(k),
    });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.delete('a')).toBe(true);
    expect(c.delete('zzz')).toBe(false);
    c.retain((k) => k !== 'b');
    expect(c.keys()).toEqual(['c']);
    c.clear();
    expect(evicted.sort()).toEqual(['a', 'b', 'c']);
    expect(c.totalCost).toBe(0);
    expect(c.size).toBe(0);
  });
  it('rejects a cache with no room', () => {
    expect(() => new LruCache({ maxEntries: 0 })).toThrow();
  });
});

describe('MasterClock', () => {
  const make = (audio: { v: number | null }, perf = { v: 0 }, opts = {}) => {
    const clock = new MasterClock(
      { perfNow: () => perf.v, audioNow: () => audio.v },
      { smoothing: 0.5, ...opts },
    );
    return { clock, perf, audio };
  };
  it('returns perf-clock deltas when there is no audio clock', () => {
    const { clock, perf } = make({ v: null });
    clock.start();
    perf.v = 16.667;
    expect(clock.step()).toBeCloseTo(0.016667, 5);
    perf.v = 33.333;
    expect(clock.step()).toBeCloseTo(0.016667, 5);
    expect(clock.source).toBe('perf');
  });
  it('step is 0 before start and after stop', () => {
    const { clock, perf } = make({ v: null });
    perf.v = 100;
    expect(clock.step()).toBe(0);
    clock.start();
    clock.stop();
    perf.v = 200;
    expect(clock.step()).toBe(0);
  });
  it('follows the audio clock: a steadily faster audio clock shortens wall steps → total time tracks audio', () => {
    const audio = { v: 5 as number | null };
    const perf = { v: 0 };
    const { clock } = make(audio, perf, { smoothing: 1 });
    clock.start();
    let total = 0;
    // audio runs 0.5 % faster than the display clock
    for (let i = 1; i <= 120; i++) {
      perf.v = i * (1000 / 60);
      audio.v = 5 + (i / 60) * 1.005;
      total += clock.step();
    }
    expect(clock.source).toBe('audio');
    expect(total).toBeCloseTo(2 * 1.005, 3);
  });
  it('smooths coarse audio clock updates (render quanta) instead of passing jitter on', () => {
    const audio = { v: 0 as number | null };
    const perf = { v: 0 };
    const clock = new MasterClock(
      { perfNow: () => perf.v, audioNow: () => audio.v },
      { smoothing: 0.15 },
    );
    clock.start();
    const steps: number[] = [];
    for (let i = 1; i <= 60; i++) {
      perf.v = i * (1000 / 60);
      // the audio clock only moves in 10 ms chunks
      audio.v = Math.floor((i / 60) * 100) / 100;
      steps.push(clock.step());
    }
    const max = Math.max(...steps.slice(5));
    const min = Math.min(...steps.slice(5));
    expect(max - min).toBeLessThan(0.006);
  });
  it('a suspended audio clock (not advancing) falls back to the display clock and keeps time moving', () => {
    const audio = { v: 3 as number | null };
    const perf = { v: 0 };
    const { clock } = make(audio, perf);
    clock.start();
    let total = 0;
    for (let i = 1; i <= 60; i++) {
      perf.v = i * (1000 / 60);
      total += clock.step(); // audio stays at 3
    }
    expect(total).toBeGreaterThan(0.95);
    expect(clock.source).toBe('perf');
  });
  it('re-anchors when the audio clock jumps (context resumed)', () => {
    const audio = { v: 0 as number | null };
    const perf = { v: 0 };
    const { clock } = make(audio, perf);
    clock.start();
    perf.v = 16;
    clock.step();
    audio.v = 50; // jump
    perf.v = 32;
    const dt = clock.step();
    expect(dt).toBeLessThan(0.05);
    expect(clock.source).toBe('perf');
    perf.v = 48;
    audio.v = 50.016;
    expect(clock.step()).toBeCloseTo(0.016, 3);
  });
  it('a slow frame (software GL, 250 ms) advances the full wall time, so the playhead never falls behind the sound', () => {
    const { clock, perf } = make({ v: null });
    clock.start();
    let total = 0;
    for (let i = 1; i <= 8; i++) {
      perf.v = i * 250;
      total += clock.step();
    }
    expect(total).toBeCloseTo(2, 5);
  });
  it('caps a step after a stall at maxStepSec and keeps going afterwards', () => {
    const { clock, perf } = make({ v: null });
    clock.start();
    perf.v = 16;
    clock.step();
    perf.v = 5016; // 5 s stall (hidden tab)
    expect(clock.step()).toBeCloseTo(0.5, 5);
    perf.v = 5032;
    expect(clock.step()).toBeCloseTo(0.016, 3);
  });
  it('adopts an audio clock that appears after start (context resumed after the first gesture)', () => {
    const audio = { v: null as number | null };
    const perf = { v: 0 };
    const { clock } = make(audio, perf, { smoothing: 1 });
    clock.start();
    perf.v = 16;
    clock.step();
    audio.v = 9;
    perf.v = 32;
    clock.step();
    audio.v = 9.016;
    perf.v = 48;
    clock.step();
    expect(clock.source).toBe('audio');
  });
  it('never returns a negative step', () => {
    const audio = { v: 0 as number | null };
    const perf = { v: 0 };
    const { clock } = make(audio, perf, { smoothing: 1 });
    clock.start();
    for (let i = 1; i < 30; i++) {
      perf.v = i * 16;
      audio.v = i * 0.016 + (i % 2 ? 0.1 : -0.1) * 0.5;
      expect(clock.step()).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('PreviewUrls', () => {
  const setup = (results: ({ url: string | null; reason: string | null } | Error)[]) => {
    const now = { v: 1_000 };
    let changes = 0;
    let calls = 0;
    const urls = new PreviewUrls({
      fetch: async () => {
        const r = results[Math.min(calls++, results.length - 1)] as
          { url: string | null; reason: string | null } | Error;
        if (r instanceof Error) throw r;
        return r;
      },
      now: () => now.v,
      onChange: () => changes++,
      ttlMs: 1000,
      retryErrorAfterMs: 500,
    });
    return { urls, now, calls: () => calls, changes: () => changes };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('starts loading on first get and becomes ready', async () => {
    const s = setup([{ url: 'u1', reason: null }]);
    expect(s.urls.get('a').status).toBe('loading');
    await flush();
    const st = s.urls.get('a');
    expect(st.status).toBe('ready');
    expect(st.url).toBe('u1');
    expect(s.calls()).toBe(1);
  });
  it('does not fetch twice while one is in flight', async () => {
    const s = setup([{ url: 'u1', reason: null }]);
    s.urls.get('a');
    s.urls.get('a');
    s.urls.get('a');
    await flush();
    expect(s.calls()).toBe(1);
  });
  it('surfaces {url:null, reason} as an error state with the reason', async () => {
    const s = setup([{ url: null, reason: 'this video has no 480p proxy' }]);
    s.urls.get('a');
    await flush();
    const st = s.urls.get('a');
    expect(st.status).toBe('error');
    expect(st.reason).toBe('this video has no 480p proxy');
  });
  it('turns a rejected fetch into an error state', async () => {
    const s = setup([new Error('offline')]);
    s.urls.get('a');
    await flush();
    expect(s.urls.get('a')).toMatchObject({ status: 'error', reason: 'offline' });
  });
  it('refreshes a ready URL after the ttl but keeps serving the old one until the new arrives', async () => {
    const s = setup([
      { url: 'u1', reason: null },
      { url: 'u2', reason: null },
    ]);
    s.urls.get('a');
    await flush();
    s.now.v += 1500;
    expect(s.urls.get('a').url).toBe('u1'); // stale but still served
    await flush();
    expect(s.urls.get('a').url).toBe('u2');
    expect(s.calls()).toBe(2);
  });
  it('keeps the version when a refresh returns the same URL (no reload)', async () => {
    const s = setup([{ url: 'same', reason: null }]);
    s.urls.get('a');
    await flush();
    const v1 = s.urls.get('a').version;
    s.now.v += 1500;
    s.urls.get('a');
    await flush();
    expect(s.urls.get('a').version).toBe(v1);
  });
  it('a failed background refresh keeps the old URL', async () => {
    const s = setup([{ url: 'u1', reason: null }, new Error('x')]);
    s.urls.get('a');
    await flush();
    s.now.v += 1500;
    s.urls.get('a');
    await flush();
    expect(s.urls.get('a')).toMatchObject({ status: 'ready', url: 'u1' });
  });
  it('invalidate drops a ready URL and fetches a fresh one', async () => {
    const s = setup([
      { url: 'u1', reason: null },
      { url: 'u2', reason: null },
    ]);
    s.urls.get('a');
    await flush();
    s.urls.invalidate('a');
    expect(s.urls.get('a').status).toBe('loading');
    await flush();
    expect(s.urls.get('a').url).toBe('u2');
  });
  it('retries an error automatically after the retry delay, and on demand', async () => {
    const s = setup([
      { url: null, reason: 'nope' },
      { url: 'u2', reason: null },
    ]);
    s.urls.get('a');
    await flush();
    expect(s.urls.get('a').status).toBe('error');
    s.now.v += 600;
    s.urls.get('a');
    await flush();
    expect(s.urls.get('a').status).toBe('ready');
    const t = setup([
      { url: null, reason: 'x' },
      { url: 'ok', reason: null },
    ]);
    t.urls.get('b');
    await flush();
    t.urls.retry('b');
    await flush();
    expect(t.urls.get('b').url).toBe('ok');
  });
});

describe('AssetCaches', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const wave = { rate: 50, durationSec: 4, peaks: [0.1, 0.5, 0.2] };
  const make = (over: Partial<ConstructorParameters<typeof AssetCaches>[0]> = {}) => {
    const log = { w: [] as string[], t: [] as string[], closed: 0, decoded: 0 };
    const now = { v: 0 };
    const caches = new AssetCaches({
      fetchWaveform: async (id) => {
        log.w.push(id);
        return id === 'bad' ? null : wave;
      },
      fetchThumbStrip: async (id, s, e, c) => {
        log.t.push(`${id}|${s}|${e}|${c}`);
        return {
          dataUrl: 'data:image/png;base64,AA',
          tileW: 36,
          tileH: 64,
          cols: c,
          times: [s, e],
        };
      },
      decodeImage: async () => {
        log.decoded++;
        return { close: () => void log.closed++ } as unknown as ImageBitmap;
      },
      now: () => now.v,
      schedule: (fn) => fn(),
      ...over,
    });
    return { caches, log, now };
  };

  it('returns null while loading, the waveform after, and notifies listeners', async () => {
    const { caches } = make();
    let changes = 0;
    caches.onChange(() => changes++);
    expect(caches.waveform('a')).toBeNull();
    await flush();
    expect(caches.waveform('a')).toBe(wave);
    expect(changes).toBe(1);
  });
  it('fetches a waveform once even when polled every frame', async () => {
    const { caches, log } = make();
    for (let i = 0; i < 20; i++) caches.waveform('a');
    await flush();
    for (let i = 0; i < 20; i++) caches.waveform('a');
    expect(log.w).toEqual(['a']);
  });
  it('backs off after a failed waveform fetch, then retries', async () => {
    const { caches, log, now } = make();
    caches.waveform('bad');
    await flush();
    caches.waveform('bad');
    expect(log.w).toHaveLength(1);
    now.v += 9000;
    caches.waveform('bad');
    await flush();
    expect(log.w).toHaveLength(2);
  });
  it('quantises thumbnail requests so near-identical ranges share one entry', async () => {
    const { caches, log } = make();
    expect(caches.thumbStrip('a', 1.01, 4.02, 6)).toBeNull();
    caches.thumbStrip('a', 1.04, 4.05, 6);
    await flush();
    await flush();
    expect(log.t).toEqual(['a|1|4.1|6']);
    const hit = caches.thumbStrip('a', 1.02, 4.07, 6);
    expect(hit).not.toBeNull();
    expect(hit?.cols).toBe(6);
  });
  it('limits thumbnail concurrency and serves the newest request first', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const { caches } = make({
      maxConcurrentThumbs: 2,
      fetchThumbStrip: async (id) => {
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { dataUrl: 'data:x', tileW: 1, tileH: 1, cols: 1, times: [0] };
      },
    });
    ['a', 'b', 'c', 'd'].forEach((id) => caches.thumbStrip(id, 0, 1, 1));
    await new Promise((r) => setTimeout(r, 60));
    expect(peak).toBeLessThanOrEqual(2);
    expect(order).toHaveLength(4);
    // 'a' ran immediately, 'b' too (two slots); then the queue is LIFO: d before c
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'));
  });
  it('evicts the least recently used strip and closes its bitmap', async () => {
    const { caches, log } = make({ maxStrips: 2 });
    for (const id of ['a', 'b', 'c']) {
      caches.thumbStrip(id, 0, 1, 1);
      await flush();
      await flush();
    }
    expect(caches.sizes.strips).toBe(2);
    expect(log.closed).toBe(1);
  });
  it('invalidate drops an asset’s waveform and strips', async () => {
    const { caches } = make();
    caches.waveform('a');
    caches.thumbStrip('a', 0, 1, 1);
    caches.thumbStrip('b', 0, 1, 1);
    await flush();
    await flush();
    caches.invalidate('a');
    expect(caches.sizes).toEqual({ waveforms: 0, strips: 1 });
  });
  it('clear() discards in-flight results (generation check) and disposed caches stay silent', async () => {
    const { caches, log } = make();
    let changes = 0;
    caches.onChange(() => changes++);
    caches.thumbStrip('a', 0, 1, 1);
    caches.clear();
    await flush();
    await flush();
    expect(caches.sizes.strips).toBe(0);
    expect(changes).toBe(0);
    expect(log.closed).toBe(1);
    caches.dispose();
    caches.waveform('z');
    await flush();
    expect(changes).toBe(0);
  });
  it('coalesces notifications into one callback per scheduling tick', async () => {
    const pending: (() => void)[] = [];
    const { caches } = make({ schedule: (fn) => pending.push(fn) });
    let changes = 0;
    caches.onChange(() => changes++);
    caches.waveform('a');
    caches.waveform('b');
    await flush();
    expect(pending).toHaveLength(1);
    pending.forEach((f) => f());
    expect(changes).toBe(1);
  });
  it('quantizeRange and stripKey are stable', () => {
    expect(quantizeRange(1.04, 4.02, 6.4)).toEqual({ start: 1, end: 4.1, count: 6 });
    expect(quantizeRange(0, 0, 0)).toEqual({ start: 0, end: 0.1, count: 1 });
    expect(quantizeRange(2, 3, 999).count).toBe(60);
    expect(stripKey('a', 1, 4.1, 6)).toBe('a|1.0|4.1|6');
  });
});

describe('FrameStats', () => {
  it('computes fps and p95 from frame intervals and ignores idle gaps after gap()', () => {
    const s = new FrameStats(120);
    for (let i = 0; i < 61; i++) s.tick(i * (1000 / 60));
    s.gap();
    s.tick(100_000); // after a pause: must not count as a 100 s frame
    const sum = s.summary();
    expect(sum.fps).toBeGreaterThan(59);
    expect(sum.fps).toBeLessThan(61);
    expect(sum.maxFrameMs).toBeLessThan(20);
    expect(sum.slowFrames).toBe(0);
    expect(sum.frames).toBe(62);
  });
  it('counts slow frames and records render time', () => {
    const s = new FrameStats();
    s.tick(0);
    s.tick(16);
    s.tick(66);
    s.render(4);
    s.render(6);
    const sum = s.summary();
    expect(sum.slowFrames).toBe(1);
    expect(sum.avgRenderMs).toBe(5);
    expect(sum.lastRenderMs).toBe(6);
  });
});
