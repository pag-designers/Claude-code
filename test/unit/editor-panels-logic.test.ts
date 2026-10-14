import { describe, expect, it } from 'vitest';
import {
  ASPECT_SIZES,
  assetSchema,
  imageItemSchema,
  projectSchema,
  shapeItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  type Item,
  type Project,
} from '../../shared/editor';
import { FILTER_PRESETS } from '../../shared/editor-eval';
import type { ClipView, VideoView } from '../../shared/pipeline';
import {
  ASSET_MIME,
  TRANSITION_MIME,
  assetDragPayload,
  parseAssetDrag,
  parseTransitionDrag,
  startAssetDrag,
  startTransitionDrag,
  transitionDragPayload,
} from '../../renderer/lib/editor-panels/drag';
import {
  assetFromClip,
  assetFromVideo,
  clipHasMedia,
  findAssetBySource,
  libraryCounts,
  libraryRows,
  videoHasMedia,
} from '../../renderer/lib/editor-panels/library-assets';
import {
  CTA_STICKERS,
  SHAPE_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_PRESETS,
  TRANSITIONS,
  animationPreset,
  ctaPatch,
  shapePatch,
  textPatch,
  transitionLabel,
} from '../../renderer/lib/editor-panels/presets';
import {
  estimateBpm,
  remainingSec,
  resolveTransitionTarget,
  selectedVisualItems,
  sharedFilter,
  sharedLut,
  transitionFor,
  visualUnderPlayhead,
} from '../../renderer/lib/editor-panels/edit-targets';
import {
  filterColors,
  filterSwatchBackground,
} from '../../renderer/lib/editor-panels/filter-swatch';

/* ---------------------------------------------------------------------------------- fixtures */

const clip = (id: string, over: Partial<ClipView> = {}): ClipView =>
  ({
    id,
    videoId: 'v1',
    videoTitle: 'Interview',
    title: `Clip ${id}`,
    hook: null,
    startSec: 10,
    endSec: 40,
    durationSec: 30,
    score: 80,
    status: 'rendered',
    hasRender: true,
    hasThumb: true,
    aspect: '9:16',
    createdAt: 1000,
    kind: 'clip',
    ...over,
  }) as ClipView;
const video = (id: string, over: Partial<VideoView> = {}): VideoView =>
  ({
    id,
    title: `Video ${id}`,
    channel: 'Chan',
    durationSec: 900,
    thumbnail: null,
    status: 'ready',
    hasProxy: true,
    createdAt: 1000,
    ...over,
  }) as VideoView;

const vid = (
  id: string,
  startSec: number,
  durationSec: number,
  over: Record<string, unknown> = {},
) =>
  videoItemSchema.parse({
    type: 'video',
    id,
    assetId: 'a1',
    startSec,
    durationSec,
    name: id,
    ...over,
  });
const track = (id: string, kind: 'video' | 'overlay' | 'text', items: Item[], over = {}) =>
  trackSchema.parse({ id, kind, name: id, items, ...over });
const proj = (tracks: ReturnType<typeof track>[]): Project =>
  projectSchema.parse({ tracks, assets: [] });

/* ---------------------------------------------------------------------------- drag payloads */

describe('drag payloads', () => {
  it('use the documented MIME types and JSON shapes', () => {
    expect(ASSET_MIME).toBe('application/x-clipfern-asset');
    expect(TRANSITION_MIME).toBe('application/x-clipfern-transition');
    expect(JSON.parse(assetDragPayload('as_1'))).toEqual({ assetId: 'as_1' });
    expect(JSON.parse(transitionDragPayload('whip-pan'))).toEqual({ type: 'whip-pan' });
  });
  it('round-trip, and reject anything that is not ours', () => {
    expect(parseAssetDrag(assetDragPayload('as_1'))).toEqual({ assetId: 'as_1' });
    expect(parseTransitionDrag(transitionDragPayload('glitch'))).toEqual({ type: 'glitch' });
    for (const bad of [
      null,
      undefined,
      '',
      'plain text',
      '{}',
      '{"assetId":1}',
      '{"assetId":""}',
      '[1]',
      'null',
    ])
      expect(parseAssetDrag(bad as string | null)).toBeNull();
    for (const bad of [null, '', '{"type":"explode"}', '{"assetId":"x"}', '7'])
      expect(parseTransitionDrag(bad as string | null)).toBeNull();
  });
  it('every transition type survives the transition payload', () => {
    for (const t of TRANSITIONS)
      expect(parseTransitionDrag(transitionDragPayload(t.type))).toEqual({ type: t.type });
  });
  it('drag sources write the payload into a DataTransfer-like sink', () => {
    const data: Record<string, string> = {};
    const dt = { effectAllowed: 'none', setData: (f: string, v: string) => void (data[f] = v) };
    startAssetDrag(dt, 'as_9', 'My clip');
    expect(data[ASSET_MIME]).toBe('{"assetId":"as_9"}');
    expect(data['text/plain']).toBe('My clip');
    expect(dt.effectAllowed).toBe('copy');
    startTransitionDrag(dt, 'zoom');
    expect(data[TRANSITION_MIME]).toBe('{"type":"zoom"}');
  });
});

/* ------------------------------------------------------------------ library → project assets */

describe('library assets', () => {
  it('a rendered clip becomes a video asset with its real duration and render size', () => {
    const a = assetFromClip(clip('c1', { durationSec: 27.5 }), 'as_1');
    expect(() => assetSchema.parse(a)).not.toThrow();
    expect(a).toMatchObject({
      id: 'as_1',
      kind: 'video',
      name: 'Clip c1',
      source: { kind: 'clip', clipId: 'c1' },
      durationSec: 27.5,
      width: 1080,
      height: 1920,
      hasAudio: true,
      beats: null,
    });
  });
  it('clip size follows the clip aspect', () => {
    for (const aspect of ['9:16', '1:1', '16:9', '4:5'] as const) {
      const a = assetFromClip(clip('c', { aspect }), 'x');
      expect([a.width, a.height]).toEqual([
        ASPECT_SIZES[aspect].width,
        ASPECT_SIZES[aspect].height,
      ]);
    }
  });
  it('a source video keeps its duration and does not invent pixel dimensions', () => {
    const a = assetFromVideo(video('v9', { durationSec: 1234 }), 'as_2');
    expect(() => assetSchema.parse(a)).not.toThrow();
    expect(a).toMatchObject({
      source: { kind: 'video', videoId: 'v9' },
      durationSec: 1234,
      width: null,
      height: null,
      kind: 'video',
    });
    expect(assetFromVideo(video('v8', { durationSec: null }), 'x').durationSec).toBeNull();
  });
  it('finds an existing asset for the same source so one clip is never added twice', () => {
    const a = assetFromClip(clip('c1'), 'as_1');
    const b = assetFromVideo(video('v1'), 'as_2');
    const up = assetSchema.parse({
      id: 'as_3',
      kind: 'audio',
      name: 'm.mp3',
      source: { kind: 'upload', key: 'k', fileName: 'm.mp3' },
    });
    expect(findAssetBySource([a, b, up], { kind: 'clip', clipId: 'c1' })?.id).toBe('as_1');
    expect(findAssetBySource([a, b, up], { kind: 'video', videoId: 'v1' })?.id).toBe('as_2');
    expect(findAssetBySource([a, b, up], { kind: 'upload', key: 'k', fileName: 'x' })?.id).toBe(
      'as_3',
    );
    expect(findAssetBySource([a, b], { kind: 'clip', clipId: 'nope' })).toBeUndefined();
    expect(findAssetBySource([a], { kind: 'video', videoId: 'c1' })).toBeUndefined();
  });
  it('only items with media available are offered', () => {
    expect(clipHasMedia(clip('a'))).toBe(true);
    expect(clipHasMedia(clip('a', { status: 'rendering' }))).toBe(false);
    expect(clipHasMedia(clip('a', { hasRender: false }))).toBe(false);
    expect(clipHasMedia(clip('a', { status: 'candidate', hasRender: false }))).toBe(false);
    expect(videoHasMedia(video('a'))).toBe(true);
    expect(videoHasMedia(video('a', { hasProxy: false }))).toBe(false);
    expect(videoHasMedia(video('a', { status: 'failed' }))).toBe(false);
    const clips = [
      clip('1'),
      clip('2', { status: 'failed', hasRender: false }),
      clip('3', { createdAt: 5000 }),
    ];
    const videos = [video('a'), video('b', { hasProxy: false })];
    expect(libraryCounts(clips, videos)).toEqual({ clips: 2, videos: 1 });
    // newest first
    expect(libraryRows('clips', clips, videos, '').map((r) => r.key)).toEqual(['3', '1']);
    expect(libraryRows('videos', clips, videos, '').map((r) => r.key)).toEqual(['a']);
  });
  it('search matches title and parent video, ignoring case and accents', () => {
    const clips = [
      clip('1', { title: 'Pricing mistakes', videoTitle: 'Founder Café Talk' }),
      clip('2', { title: 'Hiring', videoTitle: 'Other' }),
    ];
    expect(libraryRows('clips', clips, [], 'PRICING').map((r) => r.key)).toEqual(['1']);
    expect(libraryRows('clips', clips, [], 'cafe').map((r) => r.key)).toEqual(['1']);
    expect(libraryRows('clips', clips, [], '  other ').map((r) => r.key)).toEqual(['2']);
    expect(libraryRows('clips', clips, [], 'zzz')).toEqual([]);
    expect(
      libraryRows('videos', [], [video('a', { title: 'Cats', channel: 'Dogs' })], 'dogs'),
    ).toHaveLength(1);
  });
});

/* ----------------------------------------------------------------------------------- presets */

describe('text presets', () => {
  const canvas = { width: 1080, height: 1920 };
  const base = textItemSchema.parse({
    type: 'text',
    id: 't',
    startSec: 0,
    durationSec: 3,
    text: 'x',
  });
  it('ships Title, Subtitle, Lower third, Quote, Counter and the six animations', () => {
    expect(TEXT_PRESETS.map((p) => p.label)).toEqual([
      'Title',
      'Subtitle',
      'Lower third',
      'Quote',
      'Counter',
    ]);
    expect(TEXT_ANIMATIONS.map((a) => a.type).sort()).toEqual([
      'bounce',
      'fade',
      'pop',
      'scale',
      'slide',
      'typewriter',
    ]);
  });
  it('every preset (and animation preset) produces a schema-valid text item', () => {
    for (const preset of [...TEXT_PRESETS, ...TEXT_ANIMATIONS.map(animationPreset)]) {
      const p = textPatch(preset, canvas);
      const item = textItemSchema.parse({
        ...base,
        name: p.name,
        text: p.text,
        style: { ...base.style, ...p.style },
        transform: { ...base.transform, y: { v: p.y, kf: [] } },
        ...(p.animIn ? { animIn: p.animIn } : {}),
      });
      expect(item.text).toBe(preset.text);
    }
  });
  it('animation presets set animIn to the chosen animation', () => {
    for (const a of TEXT_ANIMATIONS) {
      const p = textPatch(animationPreset(a), canvas);
      expect(p.animIn).toEqual({ type: a.type, durationSec: a.durationSec });
    }
    expect(textPatch(TEXT_PRESETS[0]!, canvas).animIn).toBeUndefined();
  });
  it('sizes scale with the short side of the canvas and offsets with its height', () => {
    const title = TEXT_PRESETS[0]!;
    expect(textPatch(title, canvas).style.size).toBe(112);
    expect(textPatch(title, { width: 540, height: 960 }).style.size).toBe(56);
    // landscape 1080p keeps the same size as the vertical canvas (short side = 1080)
    expect(textPatch(title, { width: 1920, height: 1080 }).style.size).toBe(112);
    expect(textPatch(title, canvas).y).toBe(Math.round(-0.22 * 1920));
    expect(textPatch(title, { width: 1080, height: 1080 }).y).toBe(Math.round(-0.22 * 1080));
    expect(textPatch(title, canvas).style.maxWidth).toBe(Math.round(1080 * 0.84));
  });
  it('lower third has a box and left alignment; counter has a stroke', () => {
    const lt = textPatch(
      TEXT_PRESETS.find((p) => p.id === 'lower-third')!,
      canvas,
    );
    expect(lt.style.align).toBe('left');
    expect(lt.style.box).toMatchObject({ opacity: 0.66, padding: 28, radius: 14 });
    expect(lt.text).toContain('\n');
    expect(
      textPatch(
        TEXT_PRESETS.find((p) => p.id === 'counter')!,
        canvas,
      ).style.stroke?.width,
    ).toBe(8);
  });
});

describe('sticker presets', () => {
  const canvas = { width: 1080, height: 1920 };
  const base = shapeItemSchema.parse({
    type: 'shape',
    id: 's',
    startSec: 0,
    durationSec: 3,
    shape: 'rect',
  });
  it('offers rect, ellipse, line, arrow and the progress bar', () => {
    expect(SHAPE_PRESETS.map((s) => s.kind)).toEqual([
      'rect',
      'ellipse',
      'line',
      'arrow',
      'progress-bar',
    ]);
  });
  it('every shape patch is schema-valid', () => {
    for (const s of SHAPE_PRESETS) {
      const p = shapePatch(s.kind, canvas);
      expect(() =>
        shapeItemSchema.parse({
          ...base,
          shape: s.kind,
          width: p.width,
          height: p.height,
          fill: p.fill,
          radius: p.radius,
        }),
      ).not.toThrow();
    }
  });
  it('the progress bar is a thin full-width bar at the bottom that spans the project', () => {
    const p = shapePatch('progress-bar', canvas);
    expect(p.spansProject).toBe(true);
    expect(p.width).toBe(Math.round(1080 * 0.92));
    expect(p.height).toBeLessThan(30);
    expect(p.radius).toBe(Math.round(p.height / 2));
    expect(p.y).toBeGreaterThan(0.4 * 1920);
    for (const k of ['rect', 'ellipse', 'line', 'arrow'] as const)
      expect(shapePatch(k, canvas).spansProject).toBe(false);
  });
  it('CTA stickers are a pill sized to the label above the platform UI', () => {
    expect(CTA_STICKERS.map((c) => c.label)).toEqual(['Swipe up', 'Follow', 'Link in bio']);
    const short = ctaPatch('Follow', canvas);
    const long = ctaPatch('Link in bio', canvas);
    expect(long.pill.width).toBeGreaterThan(short.pill.width);
    expect(short.pill.radius).toBe(short.pill.height / 2);
    // below the centre but above the bottom 20 % that TikTok / Reels cover
    expect(short.y).toBeGreaterThan(0);
    expect(short.y + short.pill.height / 2).toBeLessThan(0.3 * 1920);
    expect(short.text.animIn.type).toBe('pop');
    expect(short.text.style.size).toBeLessThan(short.pill.height);
  });
});

describe('transitions list', () => {
  it('lists all twelve transition types once, with labels', () => {
    expect(TRANSITIONS).toHaveLength(12);
    expect(new Set(TRANSITIONS.map((t) => t.type)).size).toBe(12);
    expect(transitionLabel('whip-pan')).toBe('Whip pan');
    expect(transitionLabel('dip-black')).toBe('Dip to black');
  });
});

/* ---------------------------------------------------------------------------- edit targets */

describe('transition targets', () => {
  const a = vid('a', 0, 5);
  const b = vid('b', 5, 5);
  const c = vid('c', 10, 5);
  const p = proj([track('v1', 'video', [a, b, c])]);

  it('the selected clip is the target when a clip precedes it', () => {
    const t = resolveTransitionTarget(p, ['b'], 0);
    expect(t).toMatchObject({ ok: true, item: { id: 'b' }, previous: { id: 'a' }, existing: null });
  });
  it('the first clip of a pair hands the transition to its neighbour', () => {
    const t = resolveTransitionTarget(p, ['a'], 0);
    expect(t).toMatchObject({ ok: true, item: { id: 'b' }, previous: { id: 'a' } });
  });
  it('with nothing selected, the clip under the playhead is used', () => {
    expect(resolveTransitionTarget(p, [], 12)).toMatchObject({ ok: true, item: { id: 'c' } });
    expect(resolveTransitionTarget(p, [], 7)).toMatchObject({ ok: true, item: { id: 'b' } });
  });
  it('reports what to do when there is no clip or no neighbour', () => {
    const none = resolveTransitionTarget(p, [], 99);
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toMatch(/Select a clip/);
    const lone = proj([track('v1', 'video', [vid('x', 0, 5)])]);
    const r = resolveTransitionTarget(lone, ['x'], 0);
    expect(!r.ok && r.reason).toMatch(/touch/);
    const gap = proj([track('v1', 'video', [vid('x', 0, 5), vid('y', 8, 5)])]);
    expect(resolveTransitionTarget(gap, ['y'], 0).ok).toBe(false);
  });
  it('clips that already overlap by a transition are adjacent and report the existing transition', () => {
    const q = proj([
      track('v1', 'video', [
        vid('a', 0, 5),
        vid('b', 4.5, 5, { transitionIn: { type: 'crossfade', durationSec: 0.5 } }),
      ]),
    ]);
    const t = resolveTransitionTarget(q, ['b'], 0);
    expect(t).toMatchObject({
      ok: true,
      item: { id: 'b' },
      existing: { type: 'crossfade', durationSec: 0.5 },
    });
  });
  it('a small gap (≤ 0.1 s) still counts as adjacent', () => {
    const q = proj([track('v1', 'video', [vid('a', 0, 5), vid('b', 5.08, 5)])]);
    expect(resolveTransitionTarget(q, ['b'], 0).ok).toBe(true);
  });
  it('ignores non-visual selections and locked tracks', () => {
    const txt = textItemSchema.parse({
      type: 'text',
      id: 't1',
      startSec: 0,
      durationSec: 3,
      text: 'hi',
    });
    const q = proj([track('v1', 'video', [a, b]), track('t1', 'text', [txt])]);
    expect(resolveTransitionTarget(q, ['t1'], 50).ok).toBe(false);
    const locked = proj([track('v1', 'video', [a, b], { locked: true })]);
    const r = resolveTransitionTarget(locked, ['b'], 0);
    expect(!r.ok && r.reason).toMatch(/locked/);
  });
  it('the maximum length is half of the shorter clip', () => {
    const q = proj([track('v1', 'video', [vid('a', 0, 4), vid('b', 4, 1)])]);
    const t = resolveTransitionTarget(q, ['b'], 0);
    expect(t.ok && t.maxSec).toBe(0.5);
  });
  it('builds the transition value; Cut removes it; length is clamped', () => {
    expect(transitionFor('cut', 0.5, 2)).toBeNull();
    expect(transitionFor('crossfade', 0.5, 2)).toEqual({ type: 'crossfade', durationSec: 0.5 });
    expect(transitionFor('zoom', 3, 1.2)).toEqual({ type: 'zoom', durationSec: 1.2 });
    expect(transitionFor('zoom', 0, 1.2)).toEqual({ type: 'zoom', durationSec: 0.05 });
  });
  it('finds the visual item under the playhead on the top-most visible track', () => {
    const ov = vid('ov', 0, 20);
    const q = proj([track('v1', 'video', [a]), track('o1', 'overlay', [ov])]);
    expect(visualUnderPlayhead(q, 2)?.id).toBe('ov');
    const hidden = proj([
      track('v1', 'video', [a]),
      track('o1', 'overlay', [ov], { hidden: true }),
    ]);
    expect(visualUnderPlayhead(hidden, 2)?.id).toBe('a');
    expect(visualUnderPlayhead(q, 99)).toBeNull();
  });
});

describe('effects targets', () => {
  const img = imageItemSchema.parse({
    type: 'image',
    id: 'i1',
    assetId: 'a',
    startSec: 0,
    durationSec: 3,
  });
  const txt = textItemSchema.parse({
    type: 'text',
    id: 't1',
    startSec: 0,
    durationSec: 3,
    text: 'hi',
  });
  const p = proj([
    track('v1', 'video', [
      vid('a', 0, 5, { color: { filter: 'warm' } }),
      vid('b', 5, 5, { color: { filter: 'warm' } }),
    ]),
    track('o1', 'overlay', [img, txt]),
  ]);
  it('only video and image items can take a look', () => {
    expect(selectedVisualItems(p, ['a', 'i1', 't1', 'nope']).map((i) => i.id)).toEqual(['a', 'i1']);
    expect(selectedVisualItems(p, [])).toEqual([]);
  });
  it('reports a shared filter, none, or mixed', () => {
    expect(sharedFilter(selectedVisualItems(p, ['a', 'b']))).toBe('warm');
    expect(sharedFilter(selectedVisualItems(p, ['a', 'i1']))).toBe('mixed');
    expect(sharedFilter(selectedVisualItems(p, ['i1']))).toBeNull();
    expect(sharedFilter([])).toBeNull();
    expect(sharedLut(selectedVisualItems(p, ['a', 'b']))).toBeNull();
  });
});

describe('beats and spans', () => {
  it('estimates the tempo from beat times (median interval, folded into 70–180)', () => {
    const at = (bpm: number, n = 16) => Array.from({ length: n }, (_, i) => (i * 60) / bpm);
    expect(estimateBpm(at(120))).toBe(120);
    expect(estimateBpm(at(90))).toBe(90);
    expect(estimateBpm(at(60))).toBe(120); // half-time folds up
    expect(estimateBpm(at(240))).toBe(120); // double-time folds down
    expect(estimateBpm([0, 1, 2])).toBeNull();
    expect(estimateBpm(null)).toBeNull();
    // one dropped beat does not move the median
    const dropped = at(128).filter((_, i) => i !== 5);
    expect(estimateBpm(dropped)).toBe(128);
  });
  it('a progress bar spans the rest of the project, never less than the floor', () => {
    const p = proj([track('v1', 'video', [vid('a', 0, 30)])]);
    expect(remainingSec(p, 0)).toBe(30);
    expect(remainingSec(p, 12.5)).toBe(17.5);
    expect(remainingSec(p, 29)).toBe(5);
    expect(remainingSec(proj([track('v1', 'video', [])]), 0)).toBe(5);
  });
});

describe('filter swatches', () => {
  it('the unfiltered swatch shows the original colours; every look changes them', () => {
    const none = filterColors(null);
    expect(none.samples).toHaveLength(8);
    expect(none.ramp[0]).toBe('rgb(0 0 0)');
    expect(none.ramp[4]).toBe('rgb(255 255 255)');
    for (const key of Object.keys(FILTER_PRESETS)) {
      const f = filterColors(key);
      expect(f.samples.join()).not.toBe(none.samples.join());
    }
  });
  it('Mono has no colour left and Noir is darker than the original', () => {
    const mono = filterColors('mono').samples.map((s) => s.match(/\d+/g)!.map(Number));
    for (const [r, g, b] of mono)
      expect(Math.max(Math.abs(r! - g!), Math.abs(g! - b!))).toBeLessThanOrEqual(1);
    const lum = (s: string) =>
      s
        .match(/\d+/g)!
        .map(Number)
        .reduce((a, b) => a + b, 0);
    expect(lum(filterColors('noir').samples[5]!)).toBeLessThan(lum(filterColors(null).samples[5]!));
  });
  it('builds a CSS background', () => {
    expect(filterSwatchBackground('warm')).toMatch(/^linear-gradient\(90deg, rgb\(/);
    expect(filterSwatchBackground(null)).toContain('no-repeat');
  });
});
