import { describe, expect, it } from 'vitest';
import { assetSchema, projectSchema, textItemSchema } from '@shared/editor';
import {
  brandAssetSchema,
  brandKitSchema,
  brandTextStyleSchema,
  type BrandAssetView,
} from '@shared/brand';
import { applyBrandToProject, brandAssetToProjectAsset } from '@shared/brand-apply';
import {
  STICKER_WIDTH_FRACTION,
  brandRestylePatch,
  brandStickerItem,
  brandStyleName,
  brandTextItem,
  groupBrandAssets,
  partAvailability,
  previewBrandApply,
  projectAssetFor,
  selectionTranscript,
  videoRole,
} from '../../renderer/lib/editor-panels/brand';
import { mergeItemPatch } from '../../renderer/lib/editor/core/ops/items';
import { C, T, V, asset, proj, track } from './editor-core-fixtures';

const view = (
  id: string,
  kind: BrandAssetView['kind'],
  o: Record<string, unknown> = {},
): BrandAssetView =>
  ({
    ...brandAssetSchema.parse({
      id,
      kitId: 'k1',
      kind,
      name: id,
      ext: 'png',
      bytes: 1,
      storageKey: `brand/k1/${id}.png`,
      createdAt: 1,
      ...o,
    }),
    url: null,
    previewUrl: null,
    thumbUrl: null,
  }) as BrandAssetView;

const hook = brandTextStyleSchema.parse({
  id: 'hk',
  name: 'Big hook',
  kind: 'hook',
  style: {
    fontFamily: 'Anton',
    weight: 400,
    size: 120,
    color: '#FFE94D',
    stroke: { color: '#000000', width: 8 },
  },
  animIn: { type: 'pop', durationSec: 0.4 },
  yPct: 20,
});
const kit = brandKitSchema.parse({
  id: 'k1',
  name: 'Kit',
  isDefault: true,
  rev: 1,
  createdAt: 1,
  updatedAt: 1,
  spec: {
    introAssetId: 'intro',
    watermark: { assetId: 'logo' },
    textStyles: [hook],
    defaults: { hookTextStyleId: 'hk' },
  },
});

describe('groupBrandAssets / roles', () => {
  it('logos and images are both images; sorted by upload time then name', () => {
    const g = groupBrandAssets([
      view('b', 'image', { createdAt: 5 }),
      view('a', 'logo', { createdAt: 5 }),
      view('c', 'video'),
      view('d', 'audio'),
      view('e', 'font'),
      view('z', 'image', { createdAt: 1 }),
    ]);
    expect(g.images.map((a) => a.id)).toEqual(['z', 'a', 'b']);
    expect(g.videos.map((a) => a.id)).toEqual(['c']);
    expect(g.audio.map((a) => a.id)).toEqual(['d']);
    expect(g.fonts.map((a) => a.id)).toEqual(['e']);
  });
  it('video roles come from the kit', () => {
    expect(videoRole(kit, 'intro')).toBe('intro');
    expect(videoRole(kit, 'x')).toBeNull();
  });
  it('projectAssetFor reuses the asset already in the project', () => {
    const logo = view('logo', 'logo', { width: 10, height: 5 });
    const fresh = projectAssetFor({ assets: [] }, logo);
    expect(fresh.exists).toBe(false);
    expect(fresh.asset.id).toBe('ba_logo');
    const have = { ...brandAssetToProjectAsset(logo), beats: [1, 2] };
    const reused = projectAssetFor({ assets: [have] }, logo);
    expect(reused).toEqual({ asset: have, exists: true });
  });
});

describe('brandStickerItem', () => {
  const canvas = { width: 1080, height: 1920 };
  const logo = assetSchema.parse({
    ...brandAssetToProjectAsset(view('logo', 'logo', { width: 540, height: 270 })),
  });
  it('is 42 % of the canvas wide, native fit, 4 s', () => {
    const it = brandStickerItem(logo, canvas, 3, 'x');
    expect(it).toMatchObject({
      id: 'x',
      assetId: 'ba_logo',
      startSec: 3,
      durationSec: 4,
      fit: 'native',
    });
    expect(540 * it.transform.scale.v).toBeCloseTo(1080 * STICKER_WIDTH_FRACTION, 2);
  });
  it('without a known size: contained and halved', () => {
    const it = brandStickerItem({ ...logo, width: null, height: null }, canvas, 0, 'y');
    expect(it).toMatchObject({ fit: 'contain' });
    expect(it.transform.scale.v).toBe(0.5);
  });
});

describe('kit text styles', () => {
  const canvas = { width: 1080, height: 1920 };
  it('a new text item carries the style, ref, animation and y; hook styles are named "Hook"', () => {
    const t = brandTextItem(kit, hook, canvas, 2, 'i1');
    expect(textItemSchema.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({
      name: 'Hook',
      styleRef: 'brand:k1:hk',
      startSec: 2,
      durationSec: 3,
      text: 'Wait for it',
    });
    expect(t.style).toMatchObject({ fontFamily: 'Anton', size: 120 });
    expect(t.animIn).toEqual({ type: 'pop', durationSec: 0.4 });
    expect(t.transform.y.v).toBe(Math.round((0.2 - 0.5) * 1920));
    const title = brandTextItem(kit, { ...hook, kind: 'title', name: 'T' }, canvas, 0, 'i2', 'Hi');
    expect(title).toMatchObject({ name: 'T', text: 'Hi' });
  });
  it('the restyle patch changes the look only (merged into an existing layer)', () => {
    const base = textItemSchema.parse({
      type: 'text',
      id: 'a',
      startSec: 4,
      durationSec: 5,
      text: 'keep me',
      style: { box: { color: '#000000', opacity: 1, padding: 9, radius: 3 } },
    });
    const merged = mergeItemPatch(base, brandRestylePatch(kit, hook, canvas) as never);
    expect(merged).not.toBeNull();
    const m = merged as unknown as typeof base;
    expect(m).toMatchObject({
      text: 'keep me',
      startSec: 4,
      durationSec: 5,
      styleRef: 'brand:k1:hk',
    });
    expect(m.style.fontFamily).toBe('Anton');
    // the old box does not linger: the kit style has none
    expect(m.style.box).toBeNull();
    expect(m.style.stroke).toMatchObject({ width: 8 });
  });
  it('names the kit style a styleRef points at', () => {
    expect(brandStyleName(kit, 'brand:k1:hk')).toBe('Big hook');
    expect(brandStyleName(kit, 'brand:other:hk')).toBeNull();
    expect(brandStyleName(kit, 'hook')).toBeNull();
    expect(brandStyleName(kit, null)).toBeNull();
  });
});

describe('selectionTranscript', () => {
  const p = proj([
    track('v1', 'video', [V('a', 0, 5), V('b', 5, 5)]),
    track('st', 'subtitle', [
      C('c1', 0.5, 2, [
        ['hello', 0, 0.5],
        ['there', 0.6, 1],
      ]),
      C('c2', 4, 2, [['middle', 0, 0.5]]),
      C('c3', 7, 2, [
        ['far', 0, 0.5],
        ['away', 0.6, 1],
      ]),
    ]),
    track('tx', 'text', [T('t', 0, 3)]),
  ]);
  it('selected caption lines, in time order', () => {
    expect(selectionTranscript(p, ['c3', 'c1'])).toBe('hello there far away');
  });
  it('a clip selects the lines that overlap it', () => {
    expect(selectionTranscript(p, ['a'])).toBe('hello there middle');
    expect(selectionTranscript(p, ['b'])).toBe('middle far away');
  });
  it('nothing to read -> empty', () => {
    expect(selectionTranscript(p, [])).toBe('');
    expect(selectionTranscript(p, ['t'])).toBe(''); // a text layer has no transcript
    expect(selectionTranscript(proj([track('v1', 'video', [V('a', 0, 5)])]), ['a'])).toBe('');
  });
  it('never exceeds what broll:suggest accepts', () => {
    const words = Array.from(
      { length: 700 },
      (_, i) => [`word${i}`, i * 0.01, i * 0.01 + 0.005] as [string, number, number],
    );
    const big = proj([track('st', 'subtitle', [C('c', 0, 10, words)])]);
    expect(selectionTranscript(big, ['c']).length).toBe(2000);
  });
});

describe('Apply dialog logic', () => {
  it('parts the kit cannot supply are unavailable with a reason', () => {
    const a = partAvailability(kit);
    expect(a.watermark).toBeNull();
    expect(a.intro).toBeNull();
    expect(a.outro).toMatch(/no outro/);
    expect(a.music).toMatch(/no music/);
    expect(a.subtitles).toBeNull();
    expect(a.hook).toBeNull();
  });
  it('the preview describes each part in dialog order, without changing the project', () => {
    const p = projectSchema.parse(
      proj([track('v1', 'video', [V('a', 0, 10)]), track('st', 'subtitle', [C('c1', 1, 2)])], {
        assets: [asset('av', 'video', 60)],
      }),
    );
    const assets = [
      view('intro', 'video', { durationSec: 3, width: 100, height: 100, hasAudio: false }),
      view('logo', 'logo', { width: 200, height: 100 }),
    ];
    const { result, lines } = previewBrandApply({
      project: p,
      kit,
      assets,
      parts: ['music', 'intro', 'subtitles', 'watermark', 'hook'],
      newId: (x) => `${x}_p`,
    });
    expect(lines.map((l) => [l.part, l.status])).toEqual([
      ['watermark', 'applied'],
      ['intro', 'applied'],
      ['subtitles', 'applied'],
      ['hook', 'skipped'], // no hook text in this project
      ['music', 'skipped'], // the kit has no music bed
    ]);
    expect(lines.find((l) => l.part === 'intro')!.text).toMatch(/3\.0 s/);
    expect(p.tracks).toHaveLength(2);
    expect(result.project).not.toBe(p);
    // identical to the real apply
    const real = applyBrandToProject({
      project: p,
      kit,
      assets,
      parts: ['intro', 'watermark', 'subtitles'],
      newId: (x) => `${x}_p`,
    });
    expect(real.project).toEqual(result.project);
  });
});
