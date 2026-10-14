import { describe, expect, it, vi } from 'vitest';
import type { FrameRequest } from '../../renderer/lib/editor/compositor/api';
import { MediaPool } from '../../renderer/lib/editor/playback/pool';
import { quantizeToFrame } from '../../renderer/lib/editor/playback/seek-policy';
import { asset, FakeMedia, project, track, vItem } from './editor-playback-fakes';

type UrlState =
  | { status: 'ready'; url: string; version: number; reason: null }
  | { status: 'loading'; url: null; version: number; reason: null }
  | { status: 'error'; url: null; version: number; reason: string | null };

function setup(opts: { assets?: ReturnType<typeof asset>[]; maxTotal?: number } = {}) {
  const urlState = new Map<string, UrlState>();
  const invalidated: string[] = [];
  const els: FakeMedia[] = [];
  const imgs: (FakeMedia & { complete?: boolean })[] = [];
  const renders = { n: 0, status: 0 };
  const getUrl = (id: string): UrlState =>
    urlState.get(id) ?? { status: 'ready', url: `http://m/${id}`, version: 1, reason: null };
  const pool = new MediaPool({
    createVideo: () => {
      const e = new FakeMedia();
      els.push(e);
      return e as unknown as HTMLVideoElement;
    },
    createImage: () => {
      const e = new FakeMedia();
      imgs.push(e);
      return e as unknown as HTMLImageElement;
    },
    urls: {
      get: (id: string) => getUrl(id),
      invalidate: (id: string) => void invalidated.push(id),
    },
    requestRender: () => void renders.n++,
    onStatus: () => void renders.status++,
    fetchText: async () => 'LUT',
    parseCube: () => ({ size: 2, data: new Float32Array(24) }),
    perfNow: () => 0,
    maxTotal: opts.maxTotal,
  });
  const assets = opts.assets ?? [asset({ id: 'a1' })];
  const items = [
    vItem({ id: 'i1', assetId: 'a1', startSec: 0, durationSec: 10 }),
    vItem({ id: 'i2', assetId: 'a1', startSec: 0, durationSec: 10, inSec: 20 }),
    vItem({ id: 'i3', assetId: 'a1', startSec: 0, durationSec: 10, inSec: 30 }),
    vItem({ id: 'i4', assetId: 'a1', startSec: 0, durationSec: 10, inSec: 40 }),
  ];
  const proj = project([track({ id: 'v', items })], assets);
  pool.setProject(proj);
  const req = (itemId: string, srcSec: number, assetId = 'a1'): FrameRequest => ({
    assetId,
    srcSec,
    itemId,
  });
  const update = (
    requests: FrameRequest[],
    o: {
      t?: number;
      playing?: boolean;
      rate?: number;
      upcoming?: { assetId: string; srcSec: number; itemId: string }[];
      project?: typeof proj;
    } = {},
  ) =>
    pool.update({
      project: o.project ?? proj,
      tSec: o.t ?? 0,
      playing: o.playing ?? false,
      rate: o.rate ?? 1,
      requests,
      upcoming: o.upcoming ?? [],
    });
  return { pool, els, imgs, urlState, invalidated, renders, req, update, proj };
}

describe('slots', () => {
  it('gives each visible item of the same asset its own decoder, up to three', () => {
    const s = setup();
    s.update([s.req('i1', 1), s.req('i2', 21), s.req('i3', 31), s.req('i4', 41)]);
    expect(s.els).toHaveLength(3);
    expect(s.pool.slotCount('a1')).toBe(3);
    expect(s.pool.frameSource.video('a1', 41)).toBeNull(); // the 4th has no decoder
  });
  it('ownership is sticky: the same item keeps its element across frames', () => {
    const s = setup();
    s.update([s.req('i1', 1), s.req('i2', 21)]);
    const first = s.pool.debug().map((d) => `${d.itemId}`);
    s.update([s.req('i2', 21.03), s.req('i1', 1.03)]);
    expect(s.pool.debug().map((d) => `${d.itemId}`)).toEqual(first);
    expect(s.els).toHaveLength(2);
  });
  it('frame lookups pick the element serving that source time', () => {
    const s = setup();
    s.update([s.req('i1', 1), s.req('i2', 21)]);
    s.els[0]!.advanceTo(1);
    s.els[1]!.advanceTo(21);
    expect(s.pool.frameSource.video('a1', 1)).toBe(s.els[0]);
    expect(s.pool.frameSource.video('a1', 21)).toBe(s.els[1]);
  });
  it('reuses the least recently used slot of an item that is no longer needed', () => {
    const s = setup();
    s.update([s.req('i1', 1), s.req('i2', 21), s.req('i3', 31)]);
    s.update([s.req('i2', 21), s.req('i3', 31), s.req('i4', 41)]);
    expect(s.els).toHaveLength(3);
    expect(
      s.pool
        .debug()
        .map((d) => d.itemId)
        .sort(),
    ).toEqual(['i2', 'i3', 'i4']);
  });
  it('ignores image and audio assets for video slots', () => {
    const s = setup({ assets: [asset({ id: 'a1' }), asset({ id: 'img', kind: 'image' })] });
    s.update([s.req('x', 0, 'img')]);
    expect(s.els).toHaveLength(0);
  });
  it('evicts an idle decoder of another asset when the global cap is reached', () => {
    const s = setup({
      assets: [asset({ id: 'a1' }), asset({ id: 'a2' }), asset({ id: 'a3' })],
      maxTotal: 2,
    });
    s.update([s.req('p', 0, 'a1')]);
    s.update([s.req('q', 0, 'a2')]);
    s.update([s.req('q', 0, 'a2')]);
    s.update([s.req('q', 0, 'a2')]);
    s.update([s.req('r', 0, 'a3')]);
    expect(s.pool.slotCount()).toBe(2);
    expect(s.pool.slotCount('a1')).toBe(0);
  });
  it('removing an asset from the project drops its decoders', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    s.pool.setProject({ assets: [] });
    expect(s.pool.slotCount()).toBe(0);
  });
});

describe('seeking vs playing', () => {
  it('forward playback: seeks once to the start, then plays at the item speed without further seeks', () => {
    const s = setup();
    s.update([s.req('i1', 4)], { playing: true });
    const el = s.els[0]!;
    el.advanceTo(0);
    s.update([s.req('i1', 4)], { playing: true });
    expect(el.playCalls).toBeGreaterThanOrEqual(1);
    expect(el.seekWrites.at(-1)).toBeCloseTo(4, 6);
    const seeks = el.seekWrites.length;
    for (let i = 1; i <= 30; i++) {
      el.advanceTo(4 + i / 30);
      el.paused = false;
      s.update([s.req('i1', 4 + i / 30)], { playing: true, t: i / 30 });
    }
    expect(el.seekWrites.length).toBe(seeks);
  });
  it('speed 2×: the element plays at playbackRate 2', () => {
    const asset1 = asset({ id: 'a1' });
    const item = vItem({ id: 'i1', speed: 2, durationSec: 10 });
    const proj = project([track({ id: 'v', items: [item] })], [asset1]);
    const s = setup();
    s.update([s.req('i1', 0)], { playing: true, project: proj });
    expect(s.els[0]!.playbackRate).toBe(2);
  });
  it('reverse: pauses and steps by seeking to quantised frames', () => {
    const item = vItem({ id: 'i1', reverse: true, durationSec: 10, inSec: 0 });
    const proj = project([track({ id: 'v', items: [item] })], [asset({ id: 'a1' })]);
    const s = setup();
    s.update([s.req('i1', 10)], { playing: true, project: proj, t: 0 });
    const el = s.els[0]!;
    expect(el.paused).toBe(true);
    expect(el.seekWrites.at(-1)).toBeCloseTo(quantizeToFrame(10, 1 / 30), 9);
    el.emit('seeked');
    s.update([s.req('i1', 9.5)], { playing: true, project: proj, t: 0.5 });
    expect(el.seekWrites.at(-1)).toBeCloseTo(quantizeToFrame(9.5, 1 / 30), 9);
  });
  it('freeze: seeks once and never again', () => {
    const item = vItem({ id: 'i1', freezeAtSec: 7, durationSec: 10 });
    const proj = project([track({ id: 'v', items: [item] })], [asset({ id: 'a1' })]);
    const s = setup();
    s.update([s.req('i1', 7)], { playing: true, project: proj });
    const el = s.els[0]!;
    el.emit('seeked');
    el.advanceTo(el.seekWrites.at(-1)!);
    const n = el.seekWrites.length;
    for (let i = 0; i < 20; i++)
      s.update([s.req('i1', 7)], { playing: true, project: proj, t: i / 30 });
    expect(el.seekWrites.length).toBe(n);
    expect(el.paused).toBe(true);
  });
  it('scrubbing: one seek in flight, the latest target applied on `seeked`', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    const el = s.els[0]!;
    el.advanceTo(0.5);
    el.seeking = true; // first seek running
    s.update([s.req('i1', 2)]);
    s.update([s.req('i1', 3)]);
    s.update([s.req('i1', 4)]);
    const before = el.seekWrites.length;
    el.seeking = false;
    el.emit('seeked');
    expect(el.seekWrites.length).toBe(before + 1);
    expect(el.seekWrites.at(-1)).toBeCloseTo(quantizeToFrame(4, 1 / 30), 9);
  });
  it('requests a render when a seek lands', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    const n = s.renders.n;
    s.els[0]!.emit('seeked');
    expect(s.renders.n).toBeGreaterThan(n);
  });
  it('parks decoders nobody asked for this frame', () => {
    const s = setup();
    s.update([s.req('i1', 1)], { playing: true });
    s.els[0]!.paused = false;
    s.update([], { playing: true });
    expect(s.els[0]!.paused).toBe(true);
  });
  it('pre-seeks a spare decoder to an upcoming cut (paused, on its first frame)', () => {
    const s = setup();
    s.update([s.req('i1', 4)], {
      playing: true,
      upcoming: [{ assetId: 'a1', srcSec: 12, itemId: 'i2' }],
    });
    expect(s.els).toHaveLength(2);
    const spare = s.els[1]!;
    expect(spare.paused).toBe(true);
    expect(spare.seekWrites.at(-1)).toBeCloseTo(quantizeToFrame(12, 1 / 30), 9);
    // when the cut arrives the item already owns that decoder: no new element
    s.els[1]!.advanceTo(12);
    s.update([s.req('i2', 12)], { playing: true });
    expect(s.els).toHaveLength(2);
    expect(s.pool.debug().find((d) => d.itemId === 'i2')!.currentTime).toBeCloseTo(12, 1);
  });
});

describe('readiness and the “keep the previous frame” policy', () => {
  it('a decoder without data (readyState < 2) is not ready', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    s.els[0]!.readyState = 0;
    expect(s.pool.frameSource.video('a1', 1)).toBeNull();
    expect(s.pool.missing([s.req('i1', 1)])).toHaveLength(1);
    s.els[0]!.readyState = 4;
    s.els[0]!.advanceTo(1);
    expect(s.pool.missing([s.req('i1', 1)])).toHaveLength(0);
  });
  it('a decoder far from the wanted time is stale → null (not the wrong picture)', () => {
    const s = setup();
    s.update([s.req('i1', 10)]);
    s.els[0]!.advanceTo(2);
    expect(s.pool.frameSource.video('a1', 10)).toBeNull();
    s.els[0]!.advanceTo(10.1);
    expect(s.pool.frameSource.video('a1', 10)).not.toBeNull();
  });
  it('a stale tolerance of a quarter second applies at 1× playback', () => {
    const s = setup();
    s.update([s.req('i1', 10)], { playing: true });
    s.els[0]!.advanceTo(10.2);
    expect(s.pool.frameSource.video('a1', 10)).not.toBeNull();
    s.els[0]!.advanceTo(10.4);
    expect(s.pool.frameSource.video('a1', 10)).toBeNull();
  });
  it('images are ready after their load event; loading images are reported missing', () => {
    const s = setup({ assets: [asset({ id: 'img', kind: 'image' })] });
    s.update([s.req('x', 0, 'img')]);
    expect(s.imgs).toHaveLength(1);
    expect(s.pool.frameSource.image('img')).toBeNull();
    expect(s.pool.missing([s.req('x', 0, 'img')])).toHaveLength(1);
    s.imgs[0]!.emit('load');
    expect(s.pool.frameSource.image('img')).toBe(s.imgs[0]);
    expect(s.pool.missing([s.req('x', 0, 'img')])).toHaveLength(0);
    expect(s.imgs[0]!.src).toBe('http://m/img');
  });
  it('parses .cube LUTs asynchronously', async () => {
    const s = setup({ assets: [asset({ id: 'lut1', kind: 'lut' })] });
    expect(s.pool.frameSource.lut('lut1')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.pool.frameSource.lut('lut1')?.size).toBe(2);
  });
});

describe('asset status, URL refresh and errors', () => {
  it('loading → ready once a decoder has a frame', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    s.els[0]!.readyState = 0;
    expect(s.pool.status('a1').state).toBe('loading');
    s.els[0]!.readyState = 3;
    expect(s.pool.status('a1').state).toBe('ready');
  });
  it('url loading / error states pass through with the reason', () => {
    const s = setup();
    s.urlState.set('a1', { status: 'loading', url: null, version: 1, reason: null });
    expect(s.pool.status('a1')).toEqual({ state: 'loading', reason: null });
    s.urlState.set('a1', {
      status: 'error',
      url: null,
      version: 2,
      reason: 'this video has no 480p proxy',
    });
    expect(s.pool.status('a1')).toEqual({ state: 'error', reason: 'this video has no 480p proxy' });
  });
  it('no element is created or loaded until the URL is ready', () => {
    const s = setup();
    s.urlState.set('a1', { status: 'loading', url: null, version: 1, reason: null });
    s.update([s.req('i1', 1)]);
    expect(s.els[0]?.src ?? '').toBe('');
    s.urlState.set('a1', { status: 'ready', url: 'http://m/new', version: 2, reason: null });
    s.update([s.req('i1', 1)]);
    expect(s.els[0]!.src).toBe('http://m/new');
  });
  it('a refreshed URL is not swapped under a playing decoder, but is when it is idle', () => {
    const s = setup();
    s.update([s.req('i1', 1)], { playing: true });
    const el = s.els[0]!;
    el.paused = false;
    s.urlState.set('a1', { status: 'ready', url: 'http://m/fresh', version: 2, reason: null });
    s.update([s.req('i1', 1.03)], { playing: true });
    expect(el.src).toBe('http://m/a1');
    el.paused = true;
    s.update([s.req('i1', 1.03)], { playing: false });
    expect(el.src).toBe('http://m/fresh');
  });
  it('the first media error asks for a fresh URL; the second marks the asset failed', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    const el = s.els[0]!;
    el.readyState = 0;
    el.emit('error');
    expect(s.invalidated).toEqual(['a1']);
    expect(s.pool.status('a1').state).toBe('loading');
    el.emit('error');
    expect(s.pool.status('a1')).toEqual({
      state: 'error',
      reason: 'the media could not be decoded',
    });
  });
  it('reload() clears a failure so the decoder is retried', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    const el = s.els[0]!;
    el.readyState = 0;
    el.emit('error');
    el.emit('error');
    s.pool.reload('a1');
    s.urlState.set('a1', { status: 'ready', url: 'http://m/retry', version: 3, reason: null });
    s.update([s.req('i1', 1)]);
    expect(el.src).toBe('http://m/retry');
  });
  it('warmup creates one decoder per video asset and loads images', () => {
    const s = setup({
      assets: [
        asset({ id: 'a1' }),
        asset({ id: 'img', kind: 'image' }),
        asset({ id: 'au', kind: 'audio' }),
      ],
    });
    s.pool.warmup();
    expect(s.els).toHaveLength(1);
    expect(s.els[0]!.src).toBe('http://m/a1');
    expect(s.imgs).toHaveLength(1);
  });
  it('dispose releases every element', () => {
    const s = setup();
    s.update([s.req('i1', 1)]);
    const spy = vi.spyOn(s.els[0]!, 'pause');
    s.pool.dispose();
    expect(spy).toHaveBeenCalled();
    expect(s.pool.slotCount()).toBe(0);
  });
});
