/**
 * TEST-ONLY stand-in for main's Brand Kit data as the EDITOR sees it (`brand:list|get|defaultKit|fonts` and the
 * `broll:*` channels of the stock dialog), plus the projects the CP4 editor specs work on.
 *
 * Every request/response passes through the REAL zod contract of shared/ipc.ts (clipfern-stub.ts), so this cannot
 * drift from the contract. It is hooked in by wrapping `stubB.handle` (which the main stub already calls), guarded by
 * a per-state registry: a state that was not seeded with `seedEditorBrand` is never touched, so it coexists with the
 * Brand Kit page's own stub (`brand-stub.ts`) in one worker.
 *
 * Fixed ids make assertions exact:
 *   kit "Acme" (default): a_logo (400×200 logo, the watermark) · a_sticker (600×600 image) · a_intro (4 s video) ·
 *     a_outro (3 s) · a_broll (8 s) · a_music (10 s audio, normalised preview) · a_sfx (1.2 s) · a_font ("Acme Display",
 *     the shipped Anton file under another family name, so a pixel comparison proves the canvas draws brand fonts)
 *     text styles hk1 (hook) · ttl1 (title) · cta1 (cta) · lt1 (lower-third); captions "hormozi-bold".
 *   kit "Neon": b_logo (300×300, bottom-left) · b_intro (2.5 s) · b_music (7.3 s); no outro; hook style hk2.
 */
import {
  brandAssetViewSchema,
  brandKitSchema,
  type BrandAssetKind,
  type BrandAssetView,
  type BrandKit,
} from '../../../shared/brand';
import {
  projectSchema,
  subtitleItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  audioItemSchema,
  type Project,
} from '../../../shared/editor';
import type { Cp1State } from './cp1-sim';
import { addDoc } from './editor-stub-panels';
import { TL_ASSETS } from './editor-stub';
import { stubB } from './cp2-stub-b';
import { createBrollStub, handleBroll, type BrollStub } from './broll-stub';

const enc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function badge(label: string, bg: string, w: number, h: number): string {
  return enc(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="${Math.min(w, h) / 5}" fill="${bg}"/>` +
      `<text x="${w / 2}" y="${h / 2 + Math.min(w, h) / 6}" font-family="sans-serif" font-weight="800" ` +
      `font-size="${Math.min(w, h) / 2.2}" text-anchor="middle" fill="#ffffff">${label}</text></svg>`,
  );
}

/** A short mono WAV (sine) as a data URL, so the audition has something real to play. */
function wav(freq: number, seconds = 2): string {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000), 44 + i * 2);
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

/* ----------------------------------------------------------------------------------------- state --- */

export interface EditorBrandState {
  kits: BrandKit[];
  assets: Map<string, BrandAssetView[]>;
  defaultId: string | null;
  /** The B-roll stub (`broll:*` is answered by it). */
  broll: BrollStub;
  /** Origin serving `/fonts/editor/*` (the brand font file is the shipped Anton). */
  base: string;
  calls: { channel: string; payload: unknown }[];
}

const registry = new WeakMap<Cp1State, EditorBrandState>();

export function editorBrand(state: Cp1State): EditorBrandState {
  const s = registry.get(state);
  if (!s) throw new Error('seedEditorBrand(state) was not called');
  return s;
}

let created = 0;
const view = (
  kitId: string,
  id: string,
  kind: BrandAssetKind,
  over: Record<string, unknown>,
): BrandAssetView => {
  const ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : kind === 'font' ? 'ttf' : 'png';
  return brandAssetViewSchema.parse({
    id,
    kitId,
    kind,
    name: id,
    ext,
    bytes: 1000,
    storageKey: `brand/${kitId}/${id}.${ext}`,
    createdAt: 1000 + created++,
    url: null,
    previewUrl: null,
    thumbUrl: null,
    ...over,
  });
};

const hookStyle = (id: string, name: string, family: string, yPct: number, color: string) => ({
  id,
  name,
  kind: 'hook',
  style: {
    fontFamily: family,
    weight: 400,
    size: 110,
    color,
    stroke: { color: '#000000', width: 8 },
    shadow: { color: '#000000', opacity: 0.5, blur: 16, offsetX: 0, offsetY: 6 },
    maxWidth: 900,
  },
  animIn: { type: 'pop', durationSec: 0.4 },
  animOut: { type: 'fade', durationSec: 0.3 },
  yPct,
});

function buildKits(base: string): { kits: BrandKit[]; assets: Map<string, BrandAssetView[]> } {
  const acme = brandKitSchema.parse({
    id: 'kit_acme',
    name: 'Acme',
    isDefault: true,
    rev: 3,
    createdAt: 1,
    updatedAt: Date.now() - 3600_000,
    spec: {
      colors: [
        { id: 'c1', name: 'Acme Blue', hex: '#2F6BFF', group: 'Primary' },
        { id: 'c2', name: 'Ink', hex: '#101114', group: 'Primary' },
        { id: 'c3', name: 'Sunrise', hex: '#FFB020', group: 'Accent' },
      ],
      watermark: {
        assetId: 'a_logo',
        position: 'top-right',
        sizePct: 20,
        opacity: 0.8,
        marginPct: 4,
        safeArea: 'all',
      },
      introAssetId: 'a_intro',
      outroAssetId: 'a_outro',
      musicBed: {
        assetId: 'a_music',
        gainDb: -18,
        duckEnabled: true,
        duckAmountDb: 12,
        fadeInSec: 0.8,
        fadeOutSec: 1.5,
      },
      textStyles: [
        hookStyle('hk1', 'Big hook', 'Acme Display', 22, '#FFE94D'),
        {
          id: 'ttl1',
          name: 'Bold title',
          kind: 'title',
          style: { fontFamily: 'Poppins', weight: 800, size: 96, color: '#FFFFFF' },
          animIn: { type: 'slide', durationSec: 0.5 },
          yPct: 30,
        },
        {
          id: 'cta1',
          name: 'Follow pill',
          kind: 'cta',
          style: {
            fontFamily: 'Montserrat',
            weight: 800,
            size: 56,
            color: '#101114',
            box: { color: '#FFB020', opacity: 1, padding: 28, radius: 60 },
          },
          animIn: { type: 'pop', durationSec: 0.4 },
          yPct: 78,
        },
        {
          id: 'lt1',
          name: 'Name tag',
          kind: 'lower-third',
          style: {
            fontFamily: 'Poppins',
            weight: 700,
            size: 48,
            color: '#FFFFFF',
            align: 'left',
            box: { color: '#2F6BFF', opacity: 0.9, padding: 24, radius: 12 },
          },
          yPct: 72,
        },
      ],
      defaults: {
        captionStyleId: 'hormozi-bold',
        hookTextStyleId: 'hk1',
        watermarkOn: true,
        introOn: true,
        outroOn: true,
        musicOn: true,
      },
    },
  });
  const neon = brandKitSchema.parse({
    id: 'kit_neon',
    name: 'Neon',
    isDefault: false,
    rev: 1,
    createdAt: 2,
    updatedAt: Date.now() - 86_400_000,
    spec: {
      colors: [{ id: 'n1', name: 'Neon Pink', hex: '#FF2D95', group: 'Primary' }],
      watermark: {
        assetId: 'b_logo',
        position: 'bottom-left',
        sizePct: 10,
        opacity: 1,
        marginPct: 2,
        safeArea: 'none',
      },
      introAssetId: 'b_intro',
      outroAssetId: null,
      musicBed: {
        assetId: 'b_music',
        gainDb: -24,
        duckEnabled: false,
        duckAmountDb: 6,
        fadeInSec: 0,
        fadeOutSec: 2,
      },
      textStyles: [hookStyle('hk2', 'Neon hook', 'Poppins', 80, '#FF2D95')],
      defaults: {
        captionStyleId: 'clean-pop',
        hookTextStyleId: 'hk2',
        watermarkOn: true,
        introOn: true,
        outroOn: false,
        musicOn: true,
      },
    },
  });
  const A = (id: string, kind: BrandAssetKind, over: Record<string, unknown>) =>
    view('kit_acme', id, kind, over);
  const B = (id: string, kind: BrandAssetKind, over: Record<string, unknown>) =>
    view('kit_neon', id, kind, over);
  const assets = new Map<string, BrandAssetView[]>([
    [
      'kit_acme',
      [
        A('a_logo', 'logo', {
          name: 'Acme logo',
          width: 400,
          height: 200,
          thumbUrl: badge('ACME', '#2F6BFF', 400, 200),
          url: badge('ACME', '#2F6BFF', 400, 200),
        }),
        A('a_sticker', 'image', {
          name: 'Subscribe sticker',
          width: 600,
          height: 600,
          thumbUrl: badge('SUB', '#E5484D', 600, 600),
        }),
        A('a_intro', 'video', {
          name: 'Acme intro',
          width: 1080,
          height: 1920,
          durationSec: 4,
          hasAudio: true,
          fps: 30,
          thumbUrl: badge('IN', '#7C3AED', 270, 480),
        }),
        A('a_outro', 'video', {
          name: 'Acme outro',
          width: 1080,
          height: 1920,
          durationSec: 3,
          hasAudio: true,
          fps: 30,
          thumbUrl: badge('OUT', '#0E9F6E', 270, 480),
        }),
        A('a_broll', 'video', {
          name: 'Office B-roll',
          width: 1920,
          height: 1080,
          durationSec: 8,
          hasAudio: false,
          fps: 30,
          thumbUrl: badge('B', '#B45309', 480, 270),
        }),
        A('a_music', 'audio', {
          name: 'Sunny bed',
          durationSec: 10,
          hasAudio: true,
          loudnessLufs: -16.4,
          previewUrl: wav(330),
          url: wav(330),
        }),
        A('a_sfx', 'audio', {
          name: 'Whoosh',
          durationSec: 1.2,
          hasAudio: true,
          loudnessLufs: -20,
          previewUrl: wav(660, 1),
        }),
        A('a_font', 'font', {
          name: 'Acme Display',
          ext: 'ttf',
          font: {
            family: 'Acme Display',
            assName: 'Acme Display',
            weight: 400,
            italic: false,
            file: 'a_font.ttf',
          },
        }),
      ],
    ],
    [
      'kit_neon',
      [
        B('b_logo', 'logo', {
          name: 'Neon mark',
          width: 300,
          height: 300,
          thumbUrl: badge('N', '#FF2D95', 300, 300),
        }),
        B('b_intro', 'video', {
          name: 'Neon intro',
          width: 1080,
          height: 1920,
          durationSec: 2.5,
          hasAudio: false,
          fps: 30,
          thumbUrl: badge('NI', '#FF2D95', 270, 480),
        }),
        B('b_music', 'audio', {
          name: 'Night drive',
          durationSec: 7.3,
          hasAudio: true,
          loudnessLufs: -15,
          previewUrl: wav(440),
        }),
      ],
    ],
  ]);
  void base;
  return { kits: [acme, neon], assets };
}

export interface SeedBrandOptions {
  /** 'none' = the person has no kits yet. */
  kits?: 'two' | 'none';
  broll?: Partial<BrollStub>;
}

/** Seeds the kits and the editor projects `br-1` (captions + hook) and `br-bare` (video only). */
export function seedEditorBrand(state: Cp1State, opts: SeedBrandOptions = {}): EditorBrandState {
  installEditorBrandStub();
  const base = state.assetBase;
  const built = opts.kits === 'none' ? { kits: [], assets: new Map() } : buildKits(base);
  const broll = createBrollStub({ ...opts.broll, assetBase: base });
  const s: EditorBrandState = {
    kits: built.kits,
    assets: built.assets,
    defaultId: built.kits.find((k) => k.isDefault)?.id ?? null,
    broll,
    base,
    calls: [],
  };
  registry.set(state, s);
  addDoc(state, { id: 'br-1', name: 'Founder story', project: brandProject({ captions: true }) });
  addDoc(state, { id: 'br-bare', name: 'Bare cut', project: brandProject({ captions: false }) });
  addDoc(state, {
    id: 'br-wide',
    name: 'Widescreen cut',
    project: brandProject({ captions: true, aspect: '16:9' }),
  });
  return s;
}

/**
 * The projects: two clips (12 s + 8 s, 0.5 s crossfade) on the main track → ends at 19.5 s; a hook text (named "Hook"
 * with `styleRef: 'hook'`, as CP3 + CP4 make it), a title text, five caption lines, a user music track and two markers.
 */
export function brandProject(
  o: { captions?: boolean; aspect?: '9:16' | '16:9' | '1:1' } = {},
): Project {
  const aspect = o.aspect ?? '9:16';
  const size = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] }[aspect]!;
  const cues = [0, 1, 2, 3, 4].map((i) =>
    subtitleItemSchema.parse({
      type: 'subtitle',
      id: `cue_${i}`,
      startSec: 1 + i * 3,
      durationSec: 2.5,
      words: ['small', 'habits', 'compound', 'quickly'].map((w, k) => ({
        w,
        s: k * 0.5,
        e: k * 0.5 + 0.4,
      })),
      styleId: 'clean-pop',
    }),
  );
  return projectSchema.parse({
    canvas: { aspect, width: size[0], height: size[1], fps: 30 },
    tracks: [
      trackSchema.parse({
        id: 'tr_video',
        kind: 'video',
        name: 'Video',
        speech: true,
        items: [
          videoItemSchema.parse({
            type: 'video',
            id: 'v1',
            assetId: 'as_interview',
            startSec: 0,
            durationSec: 12,
            inSec: 5,
            name: 'Interview',
          }),
          videoItemSchema.parse({
            type: 'video',
            id: 'v2',
            assetId: 'as_broll',
            startSec: 11.5,
            durationSec: 8,
            inSec: 3,
            name: 'City',
            transitionIn: { type: 'crossfade', durationSec: 0.5 },
          }),
        ],
      }),
      trackSchema.parse({
        id: 'tr_text',
        kind: 'text',
        name: 'Text',
        items: [
          textItemSchema.parse({
            type: 'text',
            id: 'hook',
            name: 'Hook',
            styleRef: 'hook',
            text: 'This habit changed my life',
            startSec: 0.2,
            durationSec: 3,
          }),
          textItemSchema.parse({
            type: 'text',
            id: 'title',
            name: 'Chapter',
            text: 'Chapter two',
            startSec: 6,
            durationSec: 3,
          }),
        ],
      }),
      trackSchema.parse({
        id: 'tr_sub',
        kind: 'subtitle',
        name: 'Subtitles',
        items: o.captions ? cues : [],
      }),
      trackSchema.parse({
        id: 'tr_music',
        kind: 'audio',
        name: 'Music',
        items: [
          audioItemSchema.parse({
            type: 'audio',
            id: 'user_music',
            assetId: 'as_music',
            startSec: 0,
            durationSec: 19.5,
            name: 'Lo-fi beat',
          }),
        ],
      }),
    ],
    assets: TL_ASSETS.filter((a) => ['as_interview', 'as_broll', 'as_music'].includes(a.id)),
    markers: [
      { id: 'mk_1', atSec: 4, label: 'Hook ends', color: '#F5A524' },
      { id: 'mk_2', atSec: 12, label: 'Cut', color: '#F5A524' },
    ],
    origin: { clipId: null, videoId: null },
  });
}

/* -------------------------------------------------------------------------------------- handler --- */

export async function handleEditorBrand(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  const s = registry.get(state);
  if (!s) return null;
  if (channel.startsWith('broll:')) {
    s.calls.push({ channel, payload });
    return handleBroll(s.broll, channel, payload);
  }
  if (!channel.startsWith('brand:')) return null;
  s.calls.push({ channel, payload });
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (channel) {
    case 'brand:list':
      return {
        value: {
          items: s.kits.map((k) => {
            const list = s.assets.get(k.id) ?? [];
            const count = (kind: BrandAssetKind) => list.filter((a) => a.kind === kind).length;
            return {
              id: k.id,
              name: k.name,
              isDefault: k.isDefault,
              updatedAt: k.updatedAt,
              counts: {
                logo: count('logo'),
                image: count('image'),
                video: count('video'),
                audio: count('audio'),
                font: count('font'),
              },
              swatches: k.spec.colors.slice(0, 5).map((c) => c.hex),
              logoThumbUrl: list.find((a) => a.kind === 'logo')?.thumbUrl ?? null,
            };
          }),
        },
      };
    case 'brand:defaultKit':
      return { value: { id: s.defaultId } };
    case 'brand:get': {
      const kit = s.kits.find((k) => k.id === p.id);
      if (!kit) throw new Error('NOT_FOUND: That kit no longer exists.');
      return { value: { kit, assets: s.assets.get(kit.id) ?? [] } };
    }
    case 'brand:fonts':
      return {
        value: {
          fonts: [...s.assets.values()].flat().flatMap((a) =>
            a.kind === 'font' && a.font
              ? [
                  {
                    assetId: a.id,
                    kitId: a.kitId,
                    family: a.font.family,
                    weight: a.font.weight,
                    italic: a.font.italic,
                    // the shipped Anton, under the kit's family name
                    url: `${s.base}/fonts/editor/Anton-Regular.ttf`,
                  },
                ]
              : [],
          ),
        },
      };
  }
  return null;
}

const MINE = Symbol('editorBrandStub');
/**
 * Puts `handleEditorBrand` in front of `stubB.handle`, which the main stub already calls. Harmless for states that were
 * not seeded; re-wraps when another stub (the Brand Kit page's) was installed after this one, so mine stays outermost.
 */
export function installEditorBrandStub(): void {
  if ((stubB.handle as unknown as Record<symbol, boolean>)[MINE]) return;
  const original = stubB.handle.bind(stubB);
  const wrapped: typeof stubB.handle = async (state, channel, payload) => {
    const mine = await handleEditorBrand(state, channel, payload);
    return mine ?? original(state, channel, payload);
  };
  (wrapped as unknown as Record<symbol, boolean>)[MINE] = true;
  stubB.handle = wrapped;
}
