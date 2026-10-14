import { describe, expect, it } from 'vitest';
import {
  assetSchema,
  projectSchema,
  textStyleSchema,
  type Asset,
  type Item,
  type Project,
  type TextItem,
  type Track,
} from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import {
  brandAssetSchema,
  brandKitSchema,
  watermarkRect,
  type BrandAsset,
  type BrandKit,
  type BrandPart,
} from '@shared/brand';
import {
  BRAND_ITEM_IDS,
  BRAND_TRACK_IDS,
  applyBrandToProject,
  brandAssetToProjectAsset,
  brandPartsFromDefaults,
  brandStyleRef,
  brandTextPatch,
  type ApplyBrandResult,
} from '@shared/brand-apply';
import { projectProblems } from '../../renderer/lib/editor/core/ops/invariants';
import { A, C, I, T, V, asset, find, items, proj, track } from './editor-core-fixtures';

/* ------------------------------------------------------------------------------------ fixtures -- */

const baseAsset = (id: string, kind: BrandAsset['kind'], o: Partial<BrandAsset> = {}): BrandAsset =>
  brandAssetSchema.parse({
    id,
    kitId: 'kitA',
    kind,
    name: id,
    ext: kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : kind === 'font' ? 'ttf' : 'png',
    bytes: 100,
    storageKey: `brand/kitA/${id}.${kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png'}`,
    createdAt: 1,
    ...o,
  });

const ASSETS: BrandAsset[] = [
  baseAsset('logo', 'logo', { width: 400, height: 200 }),
  baseAsset('logo2', 'logo', { width: 300, height: 300 }),
  baseAsset('intro', 'video', {
    durationSec: 4,
    width: 1920,
    height: 1080,
    hasAudio: true,
    fps: 30,
  }),
  baseAsset('intro2', 'video', { durationSec: 2.5, width: 1080, height: 1920, hasAudio: false }),
  baseAsset('outro', 'video', { durationSec: 3, width: 1080, height: 1920, hasAudio: true }),
  baseAsset('music', 'audio', { durationSec: 10 }),
  baseAsset('music2', 'audio', { durationSec: 7.3 }),
  baseAsset('img', 'image', { width: 100, height: 100 }),
];

const HOOK_STYLE = {
  id: 'hk1',
  name: 'Big hook',
  kind: 'hook',
  style: textStyleSchema.parse({
    fontFamily: 'Anton',
    weight: 400,
    size: 120,
    color: '#FFE94D',
    stroke: { color: '#000000', width: 8 },
    shadow: { color: '#000000', opacity: 0.5, blur: 20, offsetX: 0, offsetY: 8 },
    maxWidth: 900,
  }),
  animIn: { type: 'bounce', durationSec: 0.6 },
  animOut: { type: 'fade', durationSec: 0.3 },
  yPct: 22,
} as const;

function makeKit(id: string, spec: Record<string, unknown> = {}): BrandKit {
  return brandKitSchema.parse({
    id,
    name: `Kit ${id}`,
    isDefault: false,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    spec: {
      watermark: {
        assetId: 'logo',
        position: 'top-right',
        sizePct: 20,
        opacity: 0.7,
        marginPct: 4,
        safeArea: 'all',
      },
      introAssetId: 'intro',
      outroAssetId: 'outro',
      musicBed: {
        assetId: 'music',
        gainDb: -18,
        duckEnabled: true,
        duckAmountDb: 12,
        fadeInSec: 0.8,
        fadeOutSec: 1.5,
      },
      textStyles: [HOOK_STYLE],
      defaults: { captionStyleId: 'hormozi-bold', hookTextStyleId: 'hk1' },
      ...spec,
    },
  });
}
const KIT_A = makeKit('kitA');
const KIT_B = makeKit('kitB', {
  watermark: {
    assetId: 'logo2',
    position: 'bottom-left',
    sizePct: 10,
    opacity: 1,
    marginPct: 2,
    safeArea: 'none',
  },
  introAssetId: 'intro2',
  outroAssetId: null,
  musicBed: {
    assetId: 'music2',
    gainDb: -24,
    duckEnabled: false,
    duckAmountDb: 6,
    fadeInSec: 0,
    fadeOutSec: 2,
  },
  textStyles: [
    {
      ...HOOK_STYLE,
      id: 'hk2',
      yPct: 80,
      style: { ...HOOK_STYLE.style, fontFamily: 'Poppins', size: 60 },
    },
  ],
  defaults: { captionStyleId: 'clean-pop', hookTextStyleId: 'hk2' },
});
const ALL: BrandPart[] = ['watermark', 'intro', 'outro', 'subtitles', 'hook', 'music'];

let counter = 0;
const newId = (p: string) => `${p}_t${++counter}`;
const hookItem = (id: string, o: Record<string, unknown> = {}) =>
  T(id, 0, 3, { text: 'Wait for it', styleRef: 'hook', name: 'Hook', ...o }) as TextItem;

/** 9:16 project: main video (two clips, 0.5 s crossfade), an overlay image, hook text, captions, markers, user music. */
function sample(o: { aspect?: '9:16' | '1:1' | '16:9' } = {}): Project {
  const base = proj(
    [
      track('v1', 'video', [
        V('c1', 0, 10),
        V('c2', 9.5, 10.5, { transitionIn: { type: 'crossfade', durationSec: 0.5 }, inSec: 20 }),
      ]),
      track('ov', 'overlay', [I('ov1', 2, 4)]),
      track('tx', 'text', [hookItem('hook1'), T('title', 5, 3, { text: 'Chapter' })]),
      track('st', 'subtitle', [
        C('cue1', 0.2, 1.5, [
          ['hello', 0, 0.5],
          ['world', 0.6, 1.2],
        ]),
        C('cue2', 2, 1.5, [['again', 0, 0.8]], { styleOverride: null, styleId: 'karaoke' }),
      ]),
      track('au', 'audio', [A('mus', 0, 20)]),
    ],
    { assets: [asset('av', 'video', 60), asset('aa', 'audio', 120), asset('ai', 'image', null)] },
  );
  const size = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }[
    o.aspect ?? '9:16'
  ]!;
  return projectSchema.parse({
    ...base,
    canvas: { ...base.canvas, aspect: o.aspect ?? '9:16', width: size[0], height: size[1] },
    markers: [
      { id: 'm1', atSec: 0, label: 'start' },
      { id: 'm2', atSec: 12.25, label: 'mid' },
    ],
  });
}

function run(
  project: Project,
  kit: BrandKit,
  parts: BrandPart[] = ALL,
  extra: Partial<Parameters<typeof applyBrandToProject>[0]> = {},
) {
  return applyBrandToProject({ project, kit, assets: ASSETS, parts, newId, ...extra });
}
const healthy = (p: Project) => {
  expect(projectSchema.safeParse(p).success).toBe(true);
  expect(projectProblems(p)).toEqual([]);
};
const itemById = (p: Project, id: string): Item => {
  const f = find(p, id);
  if (!f) throw new Error(`no ${id}`);
  return f;
};
const trackById = (p: Project, id: string): Track => p.tracks.find((t) => t.id === id) as Track;
const sortById = <T extends { id: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));
const skippedParts = (r: ApplyBrandResult) => r.skipped.map((s) => s.part);

/* ------------------------------------------------------------------------------------ assets ----- */

describe('brandAssetToProjectAsset', () => {
  it('maps kinds, ids and the usable key', () => {
    const v = brandAssetToProjectAsset(ASSETS[2] as BrandAsset);
    expect(v).toMatchObject({
      id: 'ba_intro',
      kind: 'video',
      durationSec: 4,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      beats: null,
      source: { kind: 'upload', key: 'brand/kitA/intro.mp4', fileName: 'intro.mp4' },
    });
    expect(assetSchema.safeParse(v).success).toBe(true);
    const a = brandAssetToProjectAsset(ASSETS[5] as BrandAsset);
    expect(a).toMatchObject({
      kind: 'audio',
      durationSec: 10,
      hasAudio: true,
      width: null,
      height: null,
    });
    // logo / image / font all become still images
    expect(brandAssetToProjectAsset(ASSETS[0] as BrandAsset)).toMatchObject({
      kind: 'image',
      width: 400,
      height: 200,
      durationSec: null,
      hasAudio: false,
    });
    expect(
      brandAssetToProjectAsset(
        baseAsset('f1', 'font', {
          name: 'Poppins.woff2',
          ext: 'woff2',
          storageKey: 'brand/kitA/f1.woff2',
          usableKey: 'brand/kitA/f1.usable.ttf',
        }),
      ).kind,
    ).toBe('image');
  });
  it('prefers usableKey over the original and names the file after the key', () => {
    const svg = baseAsset('svgl', 'logo', {
      name: 'Brand mark.svg',
      ext: 'svg',
      storageKey: 'brand/kitA/svgl.svg',
      usableKey: 'brand/kitA/svgl.usable.png',
      width: 512,
      height: 512,
    });
    const p = brandAssetToProjectAsset(svg);
    expect(p.source).toEqual({
      kind: 'upload',
      key: 'brand/kitA/svgl.usable.png',
      fileName: 'Brand mark.png',
    });
  });
  it('a silent video has hasAudio false', () => {
    expect(brandAssetToProjectAsset(ASSETS[3] as BrandAsset).hasAudio).toBe(false);
  });
});

describe('brandPartsFromDefaults', () => {
  it('follows the switches, and only when the needed asset exists', () => {
    const none = makeKit('k0', {
      defaults: {},
      watermark: {},
      introAssetId: null,
      outroAssetId: null,
      musicBed: {},
      textStyles: [],
    });
    expect(brandPartsFromDefaults(none.spec)).toEqual(['subtitles']);
    const full = makeKit('k1', {
      defaults: {
        watermarkOn: true,
        introOn: true,
        outroOn: true,
        musicOn: true,
        hookTextStyleId: 'hk1',
      },
    });
    expect(brandPartsFromDefaults(full.spec)).toEqual([
      'watermark',
      'intro',
      'outro',
      'subtitles',
      'hook',
      'music',
    ]);
    const noAssets = makeKit('k2', {
      defaults: { introOn: true, outroOn: true, musicOn: true },
      introAssetId: null,
      outroAssetId: null,
      musicBed: {},
      watermark: {},
    });
    expect(brandPartsFromDefaults(noAssets.spec)).toEqual(['subtitles']);
    const wmOff = makeKit('k3', { defaults: { watermarkOn: false } });
    expect(brandPartsFromDefaults(wmOff.spec)).not.toContain('watermark');
  });
});

/* ------------------------------------------------------------------------------------ intro ------ */

describe('intro: ripples everything', () => {
  const before = sample();
  const r = run(before, KIT_A, ['intro']);
  it('inserts the intro at 0 on the first video track', () => {
    expect(r.applied).toEqual(['intro']);
    expect(r.skipped).toEqual([]);
    const intro = items(r.project, 'v1')[0] as Item;
    expect(intro).toMatchObject({
      id: BRAND_ITEM_IDS.intro,
      type: 'video',
      startSec: 0,
      durationSec: 4,
      assetId: 'ba_intro',
      audioEnabled: true,
    });
    expect(r.project.assets.map((a) => a.id)).toContain('ba_intro');
  });
  it('moves every item on every track later by the intro duration, keeping gaps and transitions', () => {
    for (const t of before.tracks)
      for (const it of t.items) {
        const after = itemById(r.project, it.id);
        expect(after.startSec).toBeCloseTo(it.startSec + 4, 9);
        expect(after.durationSec).toBe(it.durationSec);
      }
    // the crossfade overlap is intact
    const c1 = itemById(r.project, 'c1');
    const c2 = itemById(r.project, 'c2');
    expect(itemEnd(c1) - c2.startSec).toBeCloseTo(0.5, 9);
    expect(c2).toMatchObject({ transitionIn: { type: 'crossfade', durationSec: 0.5 } });
  });
  it('moves every marker', () => {
    expect(r.project.markers.map((m) => m.atSec)).toEqual([4, 16.25]);
  });
  it('is a valid project, brandKitId set', () => {
    healthy(r.project);
    expect(r.project.brandKitId).toBe('kitA');
  });
  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(before);
    run(before, KIT_A);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
  it('creates the main video track when the project has none', () => {
    const p = proj([track('tx', 'text', [T('t1', 1, 2)])]);
    const out = run(p, KIT_A, ['intro']);
    expect(out.applied).toEqual(['intro']);
    expect(out.project.tracks[0]).toMatchObject({ kind: 'video', speech: true });
    expect(itemById(out.project, 't1').startSec).toBe(5);
    healthy(out.project);
  });
  it('uses the FIRST video track as main', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)]), track('v2', 'video', [V('b', 0, 5)])]);
    const out = run(p, KIT_A, ['intro']);
    expect(items(out.project, 'v1').map((i) => i.id)).toEqual(['brand_intro', 'a']);
    expect(items(out.project, 'v2').map((i) => i.id)).toEqual(['b']);
    expect(itemById(out.project, 'b').startSec).toBe(4);
  });
  it('skips when the main track is locked', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)], { locked: true })]);
    const out = run(p, KIT_A, ['intro']);
    expect(skippedParts(out)).toEqual(['intro']);
    expect(out.project).toBe(p);
  });
  it('pushes a late first clip too (gap before the clip is kept)', () => {
    const p = proj([track('v1', 'video', [V('a', 2, 5)])]);
    const out = run(p, KIT_A, ['intro']);
    expect(span4(out.project, 'a')).toEqual([6, 11]);
    expect(span4(out.project, 'brand_intro')).toEqual([0, 4]);
  });
});
const span4 = (p: Project, id: string): [number, number] => {
  const it = itemById(p, id);
  return [Math.round(it.startSec * 1e4) / 1e4, Math.round(itemEnd(it) * 1e4) / 1e4];
};

/* ------------------------------------------------------------------------------------ outro ------ */

describe('outro: after the programme end', () => {
  it('starts where the last visual item ends (here a text item outlasting the video)', () => {
    const p = proj([
      track('v1', 'video', [
        V('a', 0, 10),
        V('b', 9.5, 5, { transitionIn: { type: 'dip-black', durationSec: 0.5 } }),
      ]),
      track('tx', 'text', [T('late', 12, 6)]), // ends at 18 > 14.5
      track('au', 'audio', [A('long', 0, 60)]), // a long music track must NOT push the outro out
    ]);
    const r = run(p, KIT_A, ['outro']);
    expect(span4(r.project, 'brand_outro')).toEqual([18, 21]);
    expect(items(r.project, 'v1').map((i) => i.id)).toEqual(['a', 'b', 'brand_outro']);
    healthy(r.project);
  });
  it('with an intro too: intro shifts the programme, outro follows the shifted end', () => {
    const r = run(sample(), KIT_A, ['intro', 'outro']);
    const lastContentEnd = Math.max(
      ...sample()
        .tracks.filter((t) => t.kind !== 'audio')
        .flatMap((t) => t.items.map(itemEnd)),
    );
    expect(span4(r.project, 'brand_outro')[0]).toBeCloseTo(lastContentEnd + 4, 6);
    healthy(r.project);
  });
  it('an audio-only project puts the outro after the audio', () => {
    const p = proj([track('v1', 'video', []), track('au', 'audio', [A('x', 0, 8)])]);
    const r = run(p, KIT_A, ['outro']);
    expect(span4(r.project, 'brand_outro')).toEqual([8, 11]);
  });
  it('an empty project cannot take an outro', () => {
    const r = run(proj([track('v1', 'video', [])]), KIT_A, ['outro']);
    expect(skippedParts(r)).toEqual(['outro']);
  });
});

/* ------------------------------------------------------------------------------------ watermark -- */

describe('watermark', () => {
  for (const aspect of ['9:16', '1:1', '16:9'] as const) {
    it(`sits where watermarkRect says on ${aspect}`, () => {
      const p = sample({ aspect });
      const r = run(p, KIT_A, ['watermark']);
      expect(r.applied).toEqual(['watermark']);
      const tr = trackById(r.project, BRAND_TRACK_IDS.watermark);
      expect(tr).toMatchObject({ kind: 'overlay', name: 'Brand watermark' });
      const wm = tr.items[0] as Item & { type: 'image' };
      const rect = watermarkRect(p.canvas, KIT_A.spec.watermark, 2);
      expect(wm).toMatchObject({
        id: 'brand_wm',
        type: 'image',
        assetId: 'ba_logo',
        fit: 'native',
      });
      // the item's centre, canvas px: canvas centre + translation
      expect(p.canvas.width / 2 + wm.transform.x.v).toBeCloseTo(rect.cx, 1);
      expect(p.canvas.height / 2 + wm.transform.y.v).toBeCloseTo(rect.cy, 1);
      // native fit: width on canvas = asset width × scale
      expect(400 * wm.transform.scale.v).toBeCloseTo(rect.w, 3);
      expect(wm.transform.opacity.v).toBe(0.7);
      healthy(r.project);
    });
  }
  it('spans exactly the programme, excluding intro and outro', () => {
    const p = sample();
    const r = run(p, KIT_A, ['intro', 'outro', 'watermark']);
    const wm = itemById(r.project, 'brand_wm');
    expect(span4(r.project, 'brand_wm')).toEqual([4, span4(r.project, 'brand_outro')[0]]);
    expect(wm.startSec).toBe(4);
    // watermark added on top of the visual tracks, before audio
    const kinds = r.project.tracks.map((t) => t.kind);
    expect(kinds.indexOf('overlay')).toBeLessThan(kinds.indexOf('audio'));
    expect(r.project.tracks.findIndex((t) => t.id === BRAND_TRACK_IDS.watermark)).toBe(
      r.project.tracks.findIndex((t) => t.kind === 'audio') - 1,
    );
  });
  it('needs a logo with a known size, of the right kind', () => {
    const noSize = ASSETS.map((a) => (a.id === 'logo' ? { ...a, width: null, height: null } : a));
    expect(
      skippedParts(
        applyBrandToProject({
          project: sample(),
          kit: KIT_A,
          assets: noSize,
          parts: ['watermark'],
          newId,
        }),
      ),
    ).toEqual(['watermark']);
    const wrong = makeKit('kw', { watermark: { assetId: 'music' } });
    const r = run(sample(), wrong, ['watermark']);
    expect(skippedParts(r)).toEqual(['watermark']);
    expect(r.skipped[0]?.reason).toMatch(/logo or image/);
    const missing = makeKit('km', { watermark: { assetId: 'ghost' } });
    expect(skippedParts(run(sample(), missing, ['watermark']))).toEqual(['watermark']);
    const none = makeKit('kn', { watermark: { assetId: null } });
    expect(run(sample(), none, ['watermark']).skipped[0]?.reason).toMatch(/no watermark/);
  });
});

/* ------------------------------------------------------------------------------------ subtitles --- */

describe('subtitles', () => {
  it('sets the kit caption style on every cue and clears per-line overrides', () => {
    const p = sample();
    const withOverride = {
      ...p,
      tracks: p.tracks.map((t) =>
        t.kind === 'subtitle'
          ? {
              ...t,
              items: t.items.map((i) =>
                i.id === 'cue1' ? { ...i, styleOverride: { id: 'x' } as never } : i,
              ),
            }
          : t,
      ),
    } as Project;
    const r = run(withOverride, KIT_A, ['subtitles']);
    for (const it of items(r.project, 'st')) {
      expect(it).toMatchObject({ styleId: 'hormozi-bold', styleOverride: null });
    }
    // words untouched
    expect(itemById(r.project, 'cue1')).toMatchObject({
      words: (itemById(p, 'cue1') as never as { words: unknown }).words,
    });
    healthy(r.project);
  });
  it('is skipped when there are no captions', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 5)])]);
    const r = run(p, KIT_A, ['subtitles']);
    expect(skippedParts(r)).toEqual(['subtitles']);
    expect(r.project).toBe(p);
  });
});

/* ------------------------------------------------------------------------------------ hook --------- */

describe('hook', () => {
  it('restyles hook text with the kit hook text style (style, animations, y), keeping text and timing', () => {
    const p = sample();
    const r = run(p, KIT_A, ['hook']);
    const h = itemById(r.project, 'hook1') as TextItem;
    expect(h.text).toBe('Wait for it');
    expect(h.startSec).toBe(0);
    expect(h.style).toMatchObject({
      fontFamily: 'Anton',
      weight: 400,
      size: 120,
      color: '#FFE94D',
      maxWidth: 900,
      stroke: { width: 8 },
    });
    expect(h.animIn).toEqual({ type: 'bounce', durationSec: 0.6 });
    expect(h.animOut).toEqual({ type: 'fade', durationSec: 0.3 });
    expect(h.transform.y).toEqual({ v: Math.round((0.22 - 0.5) * 1920), kf: [] });
    expect(h.styleRef).toBe(brandStyleRef('kitA', 'hk1'));
    // other text untouched
    expect(itemById(r.project, 'title')).toEqual(itemById(p, 'title'));
    healthy(r.project);
  });
  it('recognises the CP3 hook item (named "Hook", no styleRef)', () => {
    const p = proj([track('tx', 'text', [T('h', 0, 3, { name: 'Hook', text: 'x' })])]);
    const r = run(p, KIT_A, ['hook']);
    expect(r.applied).toEqual(['hook']);
    expect((itemById(r.project, 'h') as TextItem).styleRef).toBe('brand:kitA:hk1');
  });
  it('scales sizes with the canvas short side and wrap width with the width', () => {
    const sq = sample({ aspect: '1:1' });
    const wide = sample({ aspect: '16:9' });
    const hSq = itemById(run(sq, KIT_A, ['hook']).project, 'hook1') as TextItem;
    const hWide = itemById(run(wide, KIT_A, ['hook']).project, 'hook1') as TextItem;
    expect(hSq.style.size).toBe(120); // short side 1080
    expect(hWide.style.size).toBe(120);
    expect(hWide.style.maxWidth).toBe(Math.round((900 * 1920) / 1080));
    expect(hWide.transform.y.v).toBe(Math.round((0.22 - 0.5) * 1080));
    const small = brandTextPatch(HOOK_STYLE, { width: 540, height: 960 });
    expect(small.style.size).toBe(60);
    expect(small.style.stroke?.width).toBe(4);
    expect(small.style.shadow?.blur).toBe(10);
  });
  it('a different kit replaces the look, even though the item no longer says "hook"', () => {
    const a = run(sample(), KIT_A, ['hook']);
    // without knowing the previous kit, the kitA-restyled hook is not recognised by kit B...
    const blind = run(a.project, KIT_B, ['hook']);
    // ...but name "Hook" still identifies it, so it is restyled either way
    expect((itemById(blind.project, 'hook1') as TextItem).styleRef).toBe('brand:kitB:hk2');
    // and a renamed one is found through the previous kit's style kind
    const renamed = {
      ...a.project,
      tracks: a.project.tracks.map((t) =>
        t.id === 'tx'
          ? {
              ...t,
              items: t.items.map((i) => (i.id === 'hook1' ? { ...i, name: 'My opener' } : i)),
            }
          : t,
      ),
    } as Project;
    const without = run(renamed, KIT_B, ['hook']);
    expect(skippedParts(without)).toEqual(['hook']);
    const withPrev = run(renamed, KIT_B, ['hook'], { previousKit: KIT_A });
    const h = itemById(withPrev.project, 'hook1') as TextItem;
    expect(h.style).toMatchObject({ fontFamily: 'Poppins', size: 60 });
    expect(h.styleRef).toBe('brand:kitB:hk2');
  });
  it('does not touch a title made from a non-hook kit style', () => {
    const p = proj([
      track('tx', 'text', [T('t', 0, 3, { styleRef: 'brand:kitA:ttl', name: 'Title' })]),
    ]);
    const kit = makeKit('kitA', {
      textStyles: [HOOK_STYLE, { ...HOOK_STYLE, id: 'ttl', kind: 'title' }],
    });
    const r = run(p, kit, ['hook']);
    expect(skippedParts(r)).toEqual(['hook']);
  });
  it('without a hook text style it falls back to the kit hook card', () => {
    const kit = makeKit('kc', {
      defaults: { hookTextStyleId: null },
      hook: {
        cardColor: '#112233',
        textColor: '#FFFFFF',
        yPct: 30,
        sizePct: 8,
        textCase: 'upper',
        fontFamily: 'Poppins',
        weight: 700,
      },
    });
    const r = run(sample(), kit, ['hook']);
    const h = itemById(r.project, 'hook1') as TextItem;
    expect(h.text).toBe('WAIT FOR IT');
    expect(h.style).toMatchObject({
      fontFamily: 'Poppins',
      color: '#FFFFFF',
      size: 86,
      box: { color: '#112233', opacity: 1 },
    });
    expect(h.styleRef).toBe('brand:kc:hook');
    // idempotent
    const again = run(r.project, kit, ['hook']);
    expect(again.project).toBe(r.project);
  });
  it('is skipped when the project has no hook, or the kit style vanished', () => {
    const p = proj([track('tx', 'text', [T('t', 0, 3)])]);
    expect(skippedParts(run(p, KIT_A, ['hook']))).toEqual(['hook']);
    const gone = makeKit('kg', { defaults: { hookTextStyleId: 'nope' } });
    expect(skippedParts(run(sample(), gone, ['hook']))).toEqual(['hook']);
  });
});

/* ------------------------------------------------------------------------------------ music -------- */

describe('music', () => {
  it('trims to the programme length when the file is longer', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 6)])]);
    const r = run(p, KIT_A, ['music']);
    const tr = trackById(r.project, BRAND_TRACK_IDS.music);
    expect(tr).toMatchObject({ kind: 'audio', name: 'Brand music', speech: false });
    expect(tr.items).toHaveLength(1);
    expect(tr.items[0]).toMatchObject({
      id: 'brand_music_0',
      type: 'audio',
      startSec: 0,
      durationSec: 6,
      assetId: 'ba_music',
      fadeInSec: 0.8,
      fadeOutSec: 1.5,
    });
    expect(tr.ducking).toMatchObject({ enabled: true, reductionDb: 12 });
    const vol = (tr.items[0] as Item & { type: 'audio' }).volume.v;
    expect(20 * Math.log10(vol)).toBeCloseTo(-18, 3);
    healthy(r.project);
  });
  it('loops by repeating items, back to back, fading only at the ends', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 25)])]);
    const r = run(p, KIT_A, ['music']);
    const its = trackById(r.project, BRAND_TRACK_IDS.music).items;
    expect(its.map((i) => [i.startSec, i.durationSec])).toEqual([
      [0, 10],
      [10, 10],
      [20, 5],
    ]);
    expect(its.map((i) => i.id)).toEqual(['brand_music_0', 'brand_music_1', 'brand_music_2']);
    expect((its[0] as never as { fadeInSec: number }).fadeInSec).toBe(0.8);
    expect((its[1] as never as { fadeInSec: number }).fadeInSec).toBe(0);
    expect((its[1] as never as { fadeOutSec: number }).fadeOutSec).toBe(0);
    expect((its[2] as never as { fadeOutSec: number }).fadeOutSec).toBe(1.5);
    healthy(r.project);
  });
  it('starts after the intro and ends before the outro', () => {
    const r = run(sample(), KIT_A, ['intro', 'outro', 'music']);
    const its = trackById(r.project, BRAND_TRACK_IDS.music).items;
    expect(its[0]?.startSec).toBe(4);
    expect(itemEnd(its[its.length - 1] as Item)).toBeCloseTo(span4(r.project, 'brand_outro')[0], 6);
  });
  it('turns on speech for the video tracks so ducking has something to duck under', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 6)], { speech: false })]);
    expect((p.tracks[0] as Track).speech).toBe(false);
    expect(trackById(run(p, KIT_A, ['music']).project, 'v1').speech).toBe(true);
  });
  it('ducking off when the kit says so; unknown file length is one item', () => {
    const kit = makeKit('kd', { musicBed: { assetId: 'music', duckEnabled: false } });
    const unknown = ASSETS.map((a) => (a.id === 'music' ? { ...a, durationSec: null } : a));
    const r = applyBrandToProject({
      project: proj([track('v1', 'video', [V('a', 0, 6)])]),
      kit,
      assets: unknown,
      parts: ['music'],
      newId,
    });
    const tr = trackById(r.project, BRAND_TRACK_IDS.music);
    expect(tr.ducking.enabled).toBe(false);
    expect(tr.items).toHaveLength(1);
  });
  it('rejects a clip that is too short to be a bed, and a wrong kind', () => {
    const short = ASSETS.map((a) => (a.id === 'music' ? { ...a, durationSec: 0.4 } : a));
    expect(
      skippedParts(
        applyBrandToProject({
          project: sample(),
          kit: KIT_A,
          assets: short,
          parts: ['music'],
          newId,
        }),
      ),
    ).toEqual(['music']);
    const wrong = makeKit('kw', { musicBed: { assetId: 'logo' } });
    expect(run(sample(), wrong, ['music']).skipped[0]?.reason).toMatch(/audio/);
  });
  it('refuses absurd loop counts instead of building thousands of items', () => {
    const p = proj([track('v1', 'video', [V('a', 0, 10000)])]);
    expect(run(p, KIT_A, ['music']).skipped).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------ idempotence -- */

describe('idempotence and replacement', () => {
  it('applying the same kit twice yields the same project (same object when nothing changes)', () => {
    for (const parts of [
      ALL,
      ['intro'],
      ['outro'],
      ['watermark', 'music'],
      ['intro', 'outro', 'music'],
    ] as BrandPart[][]) {
      const once = run(sample(), KIT_A, parts);
      const twice = run(once.project, KIT_A, parts);
      expect(twice.project).toBe(once.project);
      expect(twice.applied).toEqual(once.applied);
      expect(JSON.stringify(twice.project)).toBe(JSON.stringify(once.project));
    }
  });
  it('applying parts one by one equals applying them together', () => {
    const together = run(sample(), KIT_A, ALL).project;
    let step = sample();
    for (const part of ALL) step = run(step, KIT_A, [part]).project;
    expect(step.tracks.map((t) => t.id).sort()).toEqual(together.tracks.map((t) => t.id).sort());
    for (const t of together.tracks) {
      const o = trackById(step, t.id);
      expect(o.items).toEqual(t.items);
    }
    expect(step.markers).toEqual(together.markers);
  });
  it('another kit replaces the previous brand pieces (intro, outro, watermark, music, assets)', () => {
    const base = sample();
    const a = run(base, KIT_A, ALL);
    const b = run(a.project, KIT_B, ALL, { previousKit: KIT_A });
    healthy(b.project);
    // intro is now kit B's 2.5 s and everything is re-rippled from the ORIGINAL positions
    expect(span4(b.project, 'brand_intro')).toEqual([0, 2.5]);
    for (const t of base.tracks)
      for (const it of t.items)
        expect(itemById(b.project, it.id).startSec).toBeCloseTo(it.startSec + 2.5, 6);
    expect(b.project.markers.map((m) => m.atSec)).toEqual([2.5, 14.75]);
    // kit B has no outro: the old one stays, but is shifted along (parts skipped = project unchanged for that part)
    expect(skippedParts(b)).toEqual(['outro']);
    expect(find(b.project, 'brand_outro')).toBeDefined();
    // watermark: kit B's logo & geometry
    const wm = itemById(b.project, 'brand_wm') as Item & { type: 'image' };
    expect(wm.assetId).toBe('ba_logo2');
    const rect = watermarkRect(base.canvas, KIT_B.spec.watermark, 1);
    expect(base.canvas.width / 2 + wm.transform.x.v).toBeCloseTo(rect.cx, 1);
    // music replaced
    expect(trackById(b.project, BRAND_TRACK_IDS.music).items[0]).toMatchObject({
      assetId: 'ba_music2',
    });
    expect(trackById(b.project, BRAND_TRACK_IDS.music).ducking.enabled).toBe(false);
    // captions + hook
    expect(
      items(b.project, 'st').every((i) => i.type === 'subtitle' && i.styleId === 'clean-pop'),
    ).toBe(true);
    expect((itemById(b.project, 'hook1') as TextItem).styleRef).toBe('brand:kitB:hk2');
    // kit A's intro / logo / music assets no longer hang around, kit B's are in
    const ids = b.project.assets.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['ba_intro2', 'ba_logo2', 'ba_music2', 'ba_outro']));
    expect(ids).not.toContain('ba_intro');
    expect(ids).not.toContain('ba_logo');
    expect(ids).not.toContain('ba_music');
    expect(b.project.brandKitId).toBe('kitB');
    // and going back to kit A restores the exact first result
    const back = run(b.project, KIT_A, ALL, { previousKit: KIT_B });
    expect({ ...back.project, assets: sortById(back.project.assets) }).toEqual({
      ...a.project,
      assets: sortById(a.project.assets),
    });
  });
  it('applying only one part leaves the other brand pieces in sync with the timeline', () => {
    const full = run(sample(), KIT_A, ['watermark', 'music']);
    const withIntro = run(full.project, KIT_A, ['intro']);
    healthy(withIntro.project);
    expect(itemById(withIntro.project, 'brand_wm').startSec).toBe(4);
    expect(itemById(withIntro.project, 'brand_music_0').startSec).toBe(4);
  });
  it('keeps detected beats of a brand audio asset', () => {
    const first = run(sample(), KIT_A, ['music']);
    const beaten = {
      ...first.project,
      assets: first.project.assets.map((a) =>
        a.id === 'ba_music' ? { ...a, beats: [0.5, 1, 1.5] } : a,
      ),
    };
    const again = run(beaten, KIT_A, ['music']);
    expect(again.project.assets.find((a) => a.id === 'ba_music')?.beats).toEqual([0.5, 1, 1.5]);
    expect(again.project).toBe(beaten);
  });
  it('does not drop a brand asset the user also placed by hand', () => {
    const p = sample();
    const manual: Asset = brandAssetToProjectAsset(ASSETS[0] as BrandAsset);
    const withManual = projectSchema.parse({
      ...p,
      assets: [...p.assets, manual],
      tracks: p.tracks.map((t) =>
        t.id === 'ov'
          ? { ...t, items: [...t.items, I('handmade', 7, 2, { assetId: manual.id })] }
          : t,
      ),
    });
    const a = run(withManual, KIT_A, ['watermark']);
    const b = run(a.project, KIT_B, ['watermark'], { previousKit: KIT_A });
    expect(b.project.assets.map((x) => x.id)).toContain('ba_logo'); // still used by "handmade"
  });
});

/* ------------------------------------------------------------------------------------ robustness --- */

describe('never throws, never half-applies', () => {
  it('nothing selected / empty parts returns the project untouched', () => {
    const p = sample();
    const r = run(p, KIT_A, []);
    expect(r.project).toBe(p);
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
  it('missing and wrong-kind assets are reported per part and the rest still applies', () => {
    const kit = makeKit('kx', {
      introAssetId: 'ghost',
      outroAssetId: 'logo', // an image, not a video
      watermark: { assetId: 'img' },
    });
    const r = run(sample(), kit, ALL);
    expect(skippedParts(r)).toEqual(['intro', 'outro']);
    expect(r.skipped.find((s) => s.part === 'intro')?.reason).toMatch(/no longer in the kit/);
    expect(r.skipped.find((s) => s.part === 'outro')?.reason).toMatch(/must be video/);
    expect(r.applied).toEqual(['watermark', 'subtitles', 'hook', 'music']);
    healthy(r.project);
  });
  it('nothing applied -> same project, brandKitId untouched', () => {
    const p = sample();
    const kit = makeKit('kz', { introAssetId: null });
    const r = run(p, kit, ['intro']);
    expect(r.project).toBe(p);
    expect(r.project.brandKitId).toBeNull();
  });
  it('an empty project: only captions-free parts that need content are skipped', () => {
    const p = proj([track('v1', 'video', [])]);
    const r = run(p, KIT_A, ALL);
    // the intro can be added (it defines the timeline); everything that needs a programme is skipped
    expect(r.applied).toContain('intro');
    expect(skippedParts(r)).toEqual(['watermark', 'outro', 'subtitles', 'hook', 'music']);
    healthy(r.project);
  });
  it('an intro with no known duration is skipped', () => {
    const noDur = ASSETS.map((a) => (a.id === 'intro' ? { ...a, durationSec: null } : a));
    const r = applyBrandToProject({
      project: sample(),
      kit: KIT_A,
      assets: noDur,
      parts: ['intro'],
      newId,
    });
    expect(skippedParts(r)).toEqual(['intro']);
  });
  it('a layout it cannot keep valid is reported, not thrown', () => {
    // an item placed over where the intro lands, on the main track, with no room: two items at 0 on one track
    const p = proj([
      track('v1', 'video', [V('a', 0, 5)]),
      track('ov', 'overlay', [
        I('x', 0, 2),
        I('y', 1, 2, { transitionIn: { type: 'crossfade', durationSec: 1 } }),
      ]),
    ]);
    const r = run(p, KIT_A, ['intro']);
    healthy(r.project);
  });
});

/* ------------------------------------------------------------------------------------ fuzz --------- */

describe('fuzz: random projects stay valid and idempotent', () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  function randomProject(): Project {
    const tracks: Track[] = [];
    const nV = 1 + Math.floor(rnd() * 2);
    for (let t = 0; t < nV; t++) {
      const its: Item[] = [];
      let prevEnd = rnd() < 0.3 ? rnd() * 3 : 0;
      const n = Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const dur = 0.5 + rnd() * 8;
        const prev = its[k - 1];
        const overlap = prev && rnd() < 0.3 ? Math.min(0.5, dur / 3, prev.durationSec / 3) : 0;
        const start = overlap > 0.06 ? prevEnd - overlap : prevEnd + (rnd() < 0.3 ? rnd() * 2 : 0);
        its.push(
          V(
            `v${t}_${k}`,
            start,
            dur,
            overlap > 0.06 ? { transitionIn: { type: 'crossfade', durationSec: overlap } } : {},
          ),
        );
        prevEnd = start + dur;
      }
      tracks.push(track(`v${t}`, 'video', its));
    }
    if (rnd() < 0.7)
      tracks.push(track('tx', 'text', [hookItem('hk'), T('t2', 3 + rnd() * 10, 1 + rnd() * 3)]));
    if (rnd() < 0.7)
      tracks.push(
        track('st', 'subtitle', [
          C('c1', rnd() * 3, 2, [['a', 0, 1]]),
          C('c2', 6 + rnd(), 2, [['b', 0, 1]]),
        ]),
      );
    if (rnd() < 0.5) tracks.push(track('au', 'audio', [A('au1', 0, 5 + rnd() * 30)]));
    return projectSchema.parse({
      ...proj(tracks),
      markers: [{ id: 'm', atSec: rnd() * 10, label: 'm' }],
    });
  }
  it('150 random projects x random kit/parts', () => {
    for (let i = 0; i < 150; i++) {
      const p = randomProject();
      const parts = ALL.filter(() => rnd() < 0.6);
      const kit = pick([KIT_A, KIT_B]);
      const r = run(p, kit, parts);
      healthy(r.project);
      const again = run(r.project, kit, parts, { previousKit: kit });
      expect(JSON.stringify(again.project)).toBe(JSON.stringify(r.project));
      // swapping kits stays valid too
      const other = kit === KIT_A ? KIT_B : KIT_A;
      healthy(run(r.project, other, parts, { previousKit: kit }).project);
      // relative timing of the programme survives: every original item moved by the same delta
      const intro = find(r.project, 'brand_intro');
      if (intro && r.applied.includes('intro')) {
        for (const t of p.tracks)
          for (const it of t.items)
            expect(itemById(r.project, it.id).startSec).toBeCloseTo(
              it.startSec + intro.durationSec,
              5,
            );
      }
    }
  });
});
