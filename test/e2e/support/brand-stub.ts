/**
 * TEST-ONLY stand-in for main's CP4 Brand Kit behaviour as the Brand Kit PAGE sees it: kits (create / rename via update /
 * duplicate / delete / default), revision-checked updates (CONFLICT), assets (browse + drag-and-drop pipelines with
 * `brand:progress` events, rename, delete with cleared references), colour extraction, brand fonts, kit subtitle styles,
 * and the `broll:*` channels the stock dialog needs.
 *
 * Every request and response passes through the REAL zod contract in clipfern-stub.ts, so this file cannot drift from
 * shared/ipc.ts. Hooked into the main stub with one line (until then `installBrandStub()` wraps `stubB.handle`, which is
 * on the main stub's chain, so no other file has to change):
 *     const b = await handleBrand(state, channel, payload); if (b) return b.value;
 *
 * Open the page with `openBrand(h, opts)`; it seeds the kits, installs `window.clipfern.pathForFile` (the page's
 * drag-and-drop resolves a dropped `File` to an absolute path through it) and returns the session. Use `dropFiles` to
 * drop files on an upload panel, and `brandControls(state)` to script conflicts, delays and failures.
 *
 * `StockBrollDialog` (owned by another engineer) is the page's "Find stock footage" dialog; the stub answers
 * `broll:*` with an empty result so it can mount, and `broll:importToKit` creates a credited video asset.
 */
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { encodeIpcError } from '../../../shared/ipc';
import {
  BRAND_FORMATS,
  brandAssetViewSchema,
  brandKitPatchSchema,
  brandKitSpecSchema,
  brandKindsForExt,
  defaultBrandSpec,
  type BrandAssetKind,
  type BrandAssetView,
  type BrandKit,
  type BrandKitSpec,
  type BrandKitSummary,
} from '../../../shared/brand';
import { captionStyleSchema, type CaptionStyle } from '../../../shared/cp2';
import type { Cp1State } from './cp1-sim';
import type { Harness, OpenOptions, Session } from './harness';
import { cp2a } from './cp2-stub-a';
import { stubB } from './cp2-stub-b';

const fail = (msg: string, code: 'FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' = 'FAILED') =>
  new Error(encodeIpcError(code, msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------------------------ media --- */

const enc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** A simple mark: rounded square with an initial, so logos look different from each other. */
function logoSvg(letter: string, bg: string, fg: string, w = 512, h = 512): string {
  return enc(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect x="8" y="8" width="${w - 16}" height="${h - 16}" rx="${Math.min(w, h) / 4}" fill="${bg}"/>` +
      `<text x="${w / 2}" y="${h / 2 + Math.min(w, h) / 6}" font-family="sans-serif" font-weight="800" font-size="${Math.min(w, h) / 2}" text-anchor="middle" fill="${fg}">${letter}</text></svg>`,
  );
}

function imageSvg(label: string, a: string, b: string, w = 800, h = 600): string {
  return enc(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
      `<text x="${w / 2}" y="${h / 2 + 24}" font-family="sans-serif" font-weight="700" font-size="72" text-anchor="middle" fill="#ffffff">${label}</text></svg>`,
  );
}

/** A short mono WAV (sine with a fade) as a data URL, so the audio player has something real to play. */
function wavDataUrl(freq: number, seconds = 3): string {
  const rate = 16000;
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
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 800, (n - i) / 800);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 9000 * env), 44 + i * 2);
  }
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

const FONT_FILES = {
  poppins: '/fonts/editor/Poppins-Bold.ttf',
  serif: '/fonts/editor/DMSerifDisplay-Regular.ttf',
  anton: '/fonts/editor/Anton-Regular.ttf',
} as const;

const PALETTES: [string, string][] = [
  ['#6A4BF2', '#FFFFFF'],
  ['#FFE94D', '#101114'],
  ['#2EE6D6', '#101114'],
  ['#FF5FB0', '#FFFFFF'],
  ['#3EA6FF', '#FFFFFF'],
];

/* ------------------------------------------------------------------------------------------ state --- */

export interface BrandStubState {
  kits: Map<string, BrandKit>;
  assets: Map<string, BrandAssetView[]>;
  /** Dominant colours per asset id (what `brand:extractColors` answers). */
  palettes: Map<string, string[]>;
  /** Which kit a caption style belongs to (the style objects live in cp2a's list so captions:deleteStyle works). */
  styleKit: Map<string, string>;
  order: string[];
  defaultId: string | null;
  counter: number;
  /** Sizes of files "on disk" by absolute path (set by `dropFiles` and `controls.queueBrowse`). */
  fileSizes: Map<string, number>;
  /** Files the next `brand:browse` calls pick (empty queue = the user cancels the dialog). */
  browseQueue: { name: string; size?: number }[][];
  failures: Map<string, { message: string; times: number; code?: 'FAILED' | 'CONFLICT' }>;
  /** ms each `brand:update` takes (lets tests see "Saving…"). */
  updateDelayMs: number;
  /** ms each processing stage of `brand:addFiles` takes (lets tests see progress rows). */
  stageDelayMs: number;
  /** When > 0 the next N updates fail with CONFLICT regardless of revisions. */
  conflictNext: number;
  /** ms before `brand:list` / `brand:get` answer. */
  readDelayMs: number;
  log: {
    updates: { id: string; patch: unknown; baseRev: number | undefined }[];
    created: { name: string; copyFrom: string | undefined }[];
    duplicated: string[];
    deleted: string[];
    defaults: string[];
    added: { kitId: string; kind: BrandAssetKind; paths: string[] }[];
    browsed: { kitId: string; kind: BrandAssetKind }[];
    renamed: { id: string; name: string }[];
    deletedAssets: string[][];
    extracted: { assetId: string; count: number }[];
    savedStyles: { kitId: string; style: CaptionStyle }[];
    applied: unknown[];
    opened: string[];
  };
}

const states = new WeakMap<Cp1State, BrandStubState>();
export function brand(state: Cp1State): BrandStubState {
  let s = states.get(state);
  if (!s) {
    s = {
      kits: new Map(),
      assets: new Map(),
      palettes: new Map(),
      styleKit: new Map(),
      order: [],
      defaultId: null,
      counter: 0,
      fileSizes: new Map(),
      browseQueue: [],
      failures: new Map(),
      updateDelayMs: 0,
      stageDelayMs: 0,
      conflictNext: 0,
      readDelayMs: 0,
      log: {
        updates: [],
        created: [],
        duplicated: [],
        deleted: [],
        defaults: [],
        added: [],
        browsed: [],
        renamed: [],
        deletedAssets: [],
        extracted: [],
        savedStyles: [],
        applied: [],
        opened: [],
      },
    };
    states.set(state, s);
  }
  return s;
}

const nextId = (b: BrandStubState, prefix: string) => `${prefix}_${++b.counter}`;

/* ------------------------------------------------------------------------------------------ seeding -- */

type Opts = {
  kitId: string;
  kind: BrandAssetKind;
  name: string;
  ext: string;
  bytes?: number;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  lufs?: number | null;
  url?: string | null;
  thumbUrl?: string | null;
  previewUrl?: string | null;
  font?: BrandAssetView['font'];
  credit?: BrandAssetView['credit'];
};

function makeAsset(b: BrandStubState, state: Cp1State, o: Opts): BrandAssetView {
  const id = nextId(b, 'ba');
  const base = state.assetBase;
  const a = brandAssetViewSchema.parse({
    id,
    kitId: o.kitId,
    kind: o.kind,
    name: o.name,
    ext: o.ext,
    bytes: o.bytes ?? 120_000,
    storageKey: `brand/${o.kitId}/${id}.${o.ext}`,
    usableKey: null,
    previewKey: o.kind === 'video' || o.kind === 'audio' ? `brand/${o.kitId}/${id}.preview` : null,
    thumbKey: null,
    width: o.width ?? null,
    height: o.height ?? null,
    durationSec: o.durationSec ?? null,
    hasAudio: o.kind === 'audio' || o.kind === 'video',
    fps: o.kind === 'video' ? 30 : null,
    loudnessLufs: o.lufs ?? null,
    font: o.font ?? null,
    credit: o.credit ?? null,
    createdAt: Date.now() - b.counter * 1000,
    url: o.url ?? null,
    previewUrl: o.previewUrl ?? null,
    thumbUrl: o.thumbUrl ?? o.url ?? null,
  });
  void base;
  return a;
}

export interface SeedOptions {
  /** 'full' = two kits with assets, colours, styles; 'empty' = no kits at all; 'bare' = one kit with nothing in it. */
  kits?: 'full' | 'empty' | 'bare';
  /** Extra images in the first kit (for virtualisation tests). */
  manyImages?: number;
}

export function seedBrand(state: Cp1State, opts: SeedOptions = {}): BrandStubState {
  const b = brand(state);
  const mode = opts.kits ?? 'full';
  if (mode === 'empty') return b;
  const now = Date.now();
  const mkKit = (name: string, isDefault: boolean, spec: BrandKitSpec = defaultBrandSpec()): BrandKit => {
    const id = nextId(b, 'kit');
    const kit: BrandKit = {
      id,
      name,
      isDefault,
      spec,
      rev: 1,
      createdAt: now - 86_400_000,
      updatedAt: now - 3_600_000,
    };
    b.kits.set(id, kit);
    b.assets.set(id, []);
    b.order.push(id);
    if (isDefault) b.defaultId = id;
    return kit;
  };

  const a = mkKit('Acme Podcast', true);
  if (mode === 'bare') {
    mkKit('Side Hustle Shorts', false);
    return b;
  }
  const push = (o: Opts) => {
    const asset = makeAsset(b, state, o);
    b.assets.get(o.kitId)!.push(asset);
    return asset;
  };
  const kitId = a.id;
  const logoMain = push({
    kitId,
    kind: 'logo',
    name: 'acme-mark.svg',
    ext: 'svg',
    bytes: 2_400,
    width: 512,
    height: 512,
    url: logoSvg('A', '#6A4BF2', '#FFFFFF'),
  });
  push({
    kitId,
    kind: 'logo',
    name: 'acme-wordmark.svg',
    ext: 'svg',
    bytes: 3_100,
    width: 640,
    height: 200,
    url: logoSvg('ACME', '#101114', '#FFE94D', 640, 200),
  });
  push({
    kitId,
    kind: 'logo',
    name: 'acme-mono.png',
    ext: 'png',
    bytes: 18_400,
    width: 400,
    height: 400,
    url: logoSvg('a', '#FFFFFF', '#101114', 400, 400),
  });
  for (let i = 0; i < 2; i++)
    push({
      kitId,
      kind: 'image',
      name: i ? 'end-card.png' : 'subscribe-sticker.png',
      ext: 'png',
      bytes: 88_000,
      width: 800,
      height: 600,
      url: imageSvg(i ? 'Thanks!' : 'Subscribe', ...PALETTES[i]!),
    });
  const intro = push({
    kitId,
    kind: 'video',
    name: 'intro-sting.mp4',
    ext: 'mp4',
    bytes: 4_200_000,
    width: 1080,
    height: 1920,
    durationSec: 3.2,
    thumbUrl: `${state.assetBase}/__assets/c1.jpg`,
    previewUrl: `${state.assetBase}/__assets/clip-a.webm`,
    url: `${state.assetBase}/__assets/clip-a.webm`,
  });
  push({
    kitId,
    kind: 'video',
    name: 'city-timelapse.mp4',
    ext: 'mp4',
    bytes: 9_800_000,
    width: 1080,
    height: 1920,
    durationSec: 12.4,
    thumbUrl: `${state.assetBase}/__assets/c2.jpg`,
    previewUrl: `${state.assetBase}/__assets/clip-b.webm`,
    credit: { source: 'pexels', author: 'Jane Doe', url: 'https://www.pexels.com/video/1234/' },
  });
  const bed = push({
    kitId,
    kind: 'audio',
    name: 'lofi-bed.mp3',
    ext: 'mp3',
    bytes: 3_400_000,
    durationSec: 148,
    lufs: -17.6,
    previewUrl: wavDataUrl(220),
  });
  push({
    kitId,
    kind: 'audio',
    name: 'whoosh.wav',
    ext: 'wav',
    bytes: 240_000,
    durationSec: 1.4,
    lufs: -22.1,
    previewUrl: wavDataUrl(440, 2),
  });
  push({
    kitId,
    kind: 'font',
    name: 'Acme-Display-Bold.ttf',
    ext: 'ttf',
    bytes: 164_000,
    url: FONT_FILES.poppins,
    font: { family: 'Acme Display', assName: 'Acme Display', weight: 700, italic: false, file: 'Acme-Display-Bold.ttf' },
  });
  push({
    kitId,
    kind: 'font',
    name: 'Acme-Serif-Regular.otf',
    ext: 'otf',
    bytes: 98_000,
    url: FONT_FILES.serif,
    font: { family: 'Acme Serif', assName: 'Acme Serif', weight: 400, italic: false, file: 'Acme-Serif-Regular.ttf' },
  });
  b.palettes.set(logoMain.id, ['#6A4BF2', '#FFFFFF', '#2EE6D6', '#FF5FB0', '#101114']);

  a.spec = brandKitSpecSchema.parse({
    colors: [
      { id: 'c1', name: 'Acme Violet', hex: '#6A4BF2', group: 'Primary' },
      { id: 'c2', name: 'Sunbeam', hex: '#FFE94D', group: 'Primary' },
      { id: 'c3', name: 'Ink', hex: '#101114', group: 'Neutral' },
      { id: 'c4', name: 'Paper', hex: '#F6F6FA', group: 'Neutral' },
      { id: 'c5', name: 'Mint', hex: '#2EE6D6', group: 'Accent' },
    ],
    watermark: { assetId: logoMain.id, position: 'top-right', sizePct: 16, opacity: 0.85, marginPct: 4, safeArea: 'all' },
    introAssetId: intro.id,
    musicBed: { assetId: bed.id, gainDb: -18, duckEnabled: true, duckAmountDb: 12, fadeInSec: 0.8, fadeOutSec: 1.5 },
    textStyles: [
      {
        id: 'ts1',
        name: 'Hook Card',
        kind: 'hook',
        style: { fontFamily: 'Montserrat', weight: 800, size: 76, color: '#101114', box: { color: '#FFFFFF', opacity: 1, padding: 30, radius: 28 } },
        animIn: { type: 'pop', durationSec: 0.35 },
        animOut: { type: 'fade', durationSec: 0.25 },
        yPct: 18,
      },
      {
        id: 'ts2',
        name: 'Name Plate',
        kind: 'lower-third',
        style: { fontFamily: 'Poppins', weight: 600, size: 44, color: '#FFFFFF', align: 'left', box: { color: '#0C0C13', opacity: 0.72, padding: 24, radius: 16 } },
        animIn: { type: 'slide', durationSec: 0.45 },
        animOut: { type: 'slide', durationSec: 0.35 },
        yPct: 68,
      },
    ],
    defaults: {
      aspect: '9:16',
      captionStyleId: 'clean-pop',
      watermarkOn: true,
      introOn: true,
      platforms: ['tiktok', 'shorts'],
      hashtagSets: [{ id: 'hs1', name: 'Podcast clips', tags: ['podcast', 'interview', 'founders'] }],
      postingWindows: [{ id: 'pw1', platform: null, days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }],
    },
  });
  for (let i = 0; i < (opts.manyImages ?? 0); i++)
    push({
      kitId,
      kind: 'image',
      name: `bulk-${String(i + 1).padStart(3, '0')}.png`,
      ext: 'png',
      bytes: 40_000,
      width: 800,
      height: 600,
      url: imageSvg(`#${i + 1}`, ...PALETTES[i % PALETTES.length]!),
    });

  // a second, lighter kit
  const k2 = mkKit('Side Hustle Shorts', false);
  const l2 = push({
    kitId: k2.id,
    kind: 'logo',
    name: 'hustle.svg',
    ext: 'svg',
    bytes: 2_000,
    width: 480,
    height: 480,
    url: logoSvg('H', '#FF5FB0', '#FFFFFF', 480, 480),
  });
  k2.spec = brandKitSpecSchema.parse({
    colors: [
      { id: 'd1', name: 'Hot Pink', hex: '#FF5FB0', group: 'Primary' },
      { id: 'd2', name: 'Sky', hex: '#3EA6FF', group: 'Accent' },
    ],
    watermark: { assetId: l2.id, position: 'bottom-right' },
  });

  // one kit style, stored where captions:deleteStyle can find it
  const base = cp2a(state).styles.find((s) => s.id === 'hormozi-bold');
  if (base) {
    const custom: CaptionStyle = { ...base, id: 'kit-style-1', name: 'Acme Punch', builtin: false };
    cp2a(state).styles.push(custom);
    b.styleKit.set(custom.id, kitId);
  }
  return b;
}

/* ----------------------------------------------------------------------------------------- views ----- */

function summary(b: BrandStubState, k: BrandKit): BrandKitSummary {
  const assets = b.assets.get(k.id) ?? [];
  const counts = { logo: 0, image: 0, video: 0, audio: 0, font: 0 } as Record<BrandAssetKind, number>;
  for (const a of assets) counts[a.kind] += 1;
  const wm = assets.find((a) => a.id === k.spec.watermark.assetId) ?? assets.find((a) => a.kind === 'logo');
  return {
    id: k.id,
    name: k.name,
    isDefault: k.isDefault,
    updatedAt: k.updatedAt,
    counts,
    swatches: k.spec.colors.slice(0, 5).map((c) => c.hex),
    logoThumbUrl: wm?.thumbUrl ?? wm?.url ?? null,
  };
}

const kitOrThrow = (b: BrandStubState, id: string): BrandKit => {
  const k = b.kits.get(id);
  if (!k) throw fail('That brand kit does not exist.', 'NOT_FOUND');
  return k;
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Labels main reports in `clearedRefs`. */
function clearRefsOf(k: BrandKit, ids: Set<string>): string[] {
  const out: string[] = [];
  const s = k.spec;
  if (s.watermark.assetId && ids.has(s.watermark.assetId)) {
    s.watermark = { ...s.watermark, assetId: null };
    out.push('watermark');
  }
  if (s.introAssetId && ids.has(s.introAssetId)) {
    s.introAssetId = null;
    out.push('intro');
  }
  if (s.outroAssetId && ids.has(s.outroAssetId)) {
    s.outroAssetId = null;
    out.push('outro');
  }
  if (s.musicBed.assetId && ids.has(s.musicBed.assetId)) {
    s.musicBed = { ...s.musicBed, assetId: null };
    out.push('music bed');
  }
  if (out.length) {
    k.rev += 1;
    k.updatedAt = Date.now();
  }
  return out;
}

/* -------------------------------------------------------------------------------------- add files ----- */

const KIND_DEFAULTS: Record<BrandAssetKind, Partial<Opts>> = {
  logo: { width: 600, height: 600 },
  image: { width: 1200, height: 800 },
  video: { width: 1080, height: 1920, durationSec: 8.5 },
  audio: { durationSec: 62, lufs: -15.3 },
  font: {},
};

async function ingest(
  b: BrandStubState,
  state: Cp1State,
  kitId: string,
  kind: BrandAssetKind,
  files: { name: string; path: string; size: number }[],
): Promise<{ assets: BrandAssetView[]; errors: { name: string; message: string }[] }> {
  const out: BrandAssetView[] = [];
  const errors: { name: string; message: string }[] = [];
  const fmt = BRAND_FORMATS[kind];
  for (const f of files) {
    const ext = path.extname(f.name).slice(1).toLowerCase();
    if (!fmt.extensions.includes(ext)) {
      errors.push({
        name: f.name,
        message: `.${ext.toUpperCase()} is not a supported format here.${
          brandKindsForExt(ext).length ? ` It belongs in another section.` : ''
        }`,
      });
      continue;
    }
    if (f.size > fmt.maxBytes) {
      errors.push({ name: f.name, message: 'This file is too large.' });
      continue;
    }
    const stages = [
      ['probe', 0.15],
      ['upload', 0.55],
      ['preview', 0.9],
    ] as const;
    for (const [stage, fraction] of stages) {
      await state.emit?.('brand:progress', { kitId, name: f.name, fraction, stage, done: false });
      if (b.stageDelayMs) await sleep(b.stageDelayMs);
    }
    if (f.name.startsWith('broken')) {
      errors.push({ name: f.name, message: 'ffprobe could not read this file. Is it corrupted?' });
      await state.emit?.('brand:progress', { kitId, name: f.name, fraction: null, stage: 'probe', done: true });
      continue;
    }
    const idx = b.counter + 1;
    const [bg, fg] = PALETTES[idx % PALETTES.length]!;
    const o: Opts = {
      kitId,
      kind,
      name: f.name,
      ext,
      bytes: f.size,
      ...KIND_DEFAULTS[kind],
    };
    if (kind === 'logo') o.url = logoSvg(f.name[0]!.toUpperCase(), bg, fg);
    if (kind === 'image') o.url = imageSvg(f.name.slice(0, 12), bg, fg);
    if (kind === 'video') {
      o.thumbUrl = `${state.assetBase}/__assets/c${(idx % 9) + 1}.jpg`;
      o.previewUrl = `${state.assetBase}/__assets/clip-c.webm`;
    }
    if (kind === 'audio') o.previewUrl = wavDataUrl(330);
    if (kind === 'font') {
      o.url = FONT_FILES.anton;
      o.font = { family: f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '), assName: f.name, weight: 400, italic: false, file: f.name };
    }
    const asset = makeAsset(b, state, o);
    b.assets.get(kitId)!.push(asset);
    b.palettes.set(asset.id, [bg, fg, '#2EE6D6']);
    out.push(asset);
    await state.emit?.('brand:progress', { kitId, name: f.name, fraction: 1, stage: 'done', done: true });
  }
  if (out.length) await state.emit?.('brand:changed', { kitId });
  return { assets: out, errors };
}

/* ---------------------------------------------------------------------------------------- handler ---- */

type Payload = Record<string, unknown>;

/** Handles `brand:*` and `broll:*`; resolves null for any other channel. */
export async function handleBrand(
  state: Cp1State,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  if (!channel.startsWith('brand:') && !channel.startsWith('broll:')) return null;
  const b = brand(state);
  const p = (payload ?? {}) as Payload;
  const planned = b.failures.get(channel);
  if (planned && planned.times > 0) {
    planned.times -= 1;
    throw fail(planned.message, planned.code ?? 'FAILED');
  }

  switch (channel) {
    case 'brand:list': {
      if (b.readDelayMs) await sleep(b.readDelayMs);
      return { value: { items: b.order.map((id) => summary(b, b.kits.get(id)!)) } };
    }
    case 'brand:defaultKit':
      return { value: { id: b.defaultId } };
    case 'brand:get': {
      if (b.readDelayMs) await sleep(b.readDelayMs);
      const k = kitOrThrow(b, p.id as string);
      return { value: { kit: clone(k), assets: clone(b.assets.get(k.id) ?? []) } };
    }
    case 'brand:create': {
      const name = p.name as string;
      b.log.created.push({ name, copyFrom: p.copyFrom as string | undefined });
      const id = nextId(b, 'kit');
      let spec = defaultBrandSpec();
      if (p.copyFrom) {
        const src = kitOrThrow(b, p.copyFrom as string);
        spec = clone(src.spec);
        spec.watermark = { ...spec.watermark, assetId: null };
        spec.introAssetId = null;
        spec.outroAssetId = null;
        spec.musicBed = { ...spec.musicBed, assetId: null };
      }
      const kit: BrandKit = {
        id,
        name,
        isDefault: b.order.length === 0,
        spec,
        rev: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      b.kits.set(id, kit);
      b.assets.set(id, []);
      b.order.push(id);
      if (kit.isDefault) b.defaultId = id;
      await state.emit?.('brand:changed', { kitId: null });
      return { value: clone(kit) };
    }
    case 'brand:update': {
      const k = kitOrThrow(b, p.id as string);
      const baseRev = p.baseRev as number | undefined;
      const patch = brandKitPatchSchema.parse(p.patch);
      b.log.updates.push({ id: k.id, patch: clone(patch), baseRev });
      if (b.updateDelayMs) await sleep(b.updateDelayMs);
      if (b.conflictNext > 0) {
        b.conflictNext -= 1;
        throw fail('This kit was changed elsewhere. Reload it and try again.', 'CONFLICT');
      }
      if (baseRev !== undefined && baseRev !== k.rev)
        throw fail('This kit was changed elsewhere. Reload it and try again.', 'CONFLICT');
      if (patch.name !== undefined) k.name = patch.name;
      if (patch.spec) k.spec = brandKitSpecSchema.parse({ ...k.spec, ...patch.spec });
      k.rev += 1;
      k.updatedAt = Date.now();
      await state.emit?.('brand:changed', { kitId: k.id });
      return { value: clone(k) };
    }
    case 'brand:duplicate': {
      const src = kitOrThrow(b, p.id as string);
      b.log.duplicated.push(src.id);
      const id = nextId(b, 'kit');
      const idMap = new Map<string, string>();
      const assets = (b.assets.get(src.id) ?? []).map((a) => {
        const copy = { ...clone(a), id: nextId(b, 'ba'), kitId: id };
        idMap.set(a.id, copy.id);
        const pal = b.palettes.get(a.id);
        if (pal) b.palettes.set(copy.id, pal);
        return copy;
      });
      const spec = clone(src.spec);
      const remap = (v: string | null) => (v ? (idMap.get(v) ?? null) : null);
      spec.watermark.assetId = remap(spec.watermark.assetId);
      spec.introAssetId = remap(spec.introAssetId);
      spec.outroAssetId = remap(spec.outroAssetId);
      spec.musicBed.assetId = remap(spec.musicBed.assetId);
      const kit: BrandKit = {
        id,
        name: `${src.name} copy`.slice(0, 60),
        isDefault: false,
        spec,
        rev: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      b.kits.set(id, kit);
      b.assets.set(id, assets);
      b.order.push(id);
      await state.emit?.('brand:changed', { kitId: null });
      return { value: clone(kit) };
    }
    case 'brand:delete': {
      const id = p.id as string;
      const k = kitOrThrow(b, id);
      b.log.deleted.push(id);
      b.kits.delete(id);
      b.assets.delete(id);
      b.order = b.order.filter((x) => x !== id);
      if (b.defaultId === id) {
        b.defaultId = b.order[0] ?? null;
        if (b.defaultId) b.kits.get(b.defaultId)!.isDefault = true;
      }
      void k;
      await state.emit?.('brand:changed', { kitId: null });
      return { value: { ok: true } };
    }
    case 'brand:setDefault': {
      const id = p.id as string;
      kitOrThrow(b, id);
      b.log.defaults.push(id);
      for (const k of b.kits.values()) k.isDefault = k.id === id;
      b.defaultId = id;
      await state.emit?.('brand:changed', { kitId: null });
      return { value: { ok: true } };
    }
    case 'brand:browse': {
      const kitId = p.kitId as string;
      const kind = p.kind as BrandAssetKind;
      kitOrThrow(b, kitId);
      b.log.browsed.push({ kitId, kind });
      const picked = b.browseQueue.shift();
      if (!picked) return { value: { assets: [], errors: [], canceled: true } };
      const files = picked.map((f) => ({
        name: f.name,
        path: `/Users/demo/Brand/${f.name}`,
        size: f.size ?? 150_000,
      }));
      const res = await ingest(b, state, kitId, kind, files);
      return { value: { ...res, canceled: false } };
    }
    case 'brand:addFiles': {
      const kitId = p.kitId as string;
      const kind = p.kind as BrandAssetKind;
      const paths = p.paths as string[];
      kitOrThrow(b, kitId);
      b.log.added.push({ kitId, kind, paths });
      const files = paths.map((fp) => ({
        name: path.basename(fp),
        path: fp,
        size: b.fileSizes.get(fp) ?? 150_000,
      }));
      return { value: await ingest(b, state, kitId, kind, files) };
    }
    case 'brand:renameAsset': {
      const id = p.id as string;
      for (const list of b.assets.values()) {
        const a = list.find((x) => x.id === id);
        if (a) {
          a.name = p.name as string;
          b.log.renamed.push({ id, name: a.name });
          await state.emit?.('brand:changed', { kitId: a.kitId });
          return { value: { ok: true } };
        }
      }
      throw fail('That file does not exist.', 'NOT_FOUND');
    }
    case 'brand:deleteAssets': {
      const ids = new Set(p.ids as string[]);
      b.log.deletedAssets.push([...ids]);
      let deleted = 0;
      const cleared: string[] = [];
      for (const [kitId, list] of b.assets) {
        const kept = list.filter((a) => !ids.has(a.id));
        deleted += list.length - kept.length;
        if (kept.length !== list.length) {
          b.assets.set(kitId, kept);
          cleared.push(...clearRefsOf(b.kits.get(kitId)!, ids));
          await state.emit?.('brand:changed', { kitId });
        }
      }
      return { value: { deleted, clearedRefs: cleared } };
    }
    case 'brand:extractColors': {
      const assetId = p.assetId as string;
      const count = (p.count as number | undefined) ?? 6;
      b.log.extracted.push({ assetId, count });
      const pal = b.palettes.get(assetId);
      if (!pal) throw fail('This file has no colors to read (is it an image?).', 'FAILED');
      return { value: { colors: pal.slice(0, count) } };
    }
    case 'brand:fonts': {
      const fonts: { assetId: string; kitId: string; family: string; weight: number; italic: boolean; url: string }[] = [];
      for (const list of b.assets.values())
        for (const a of list)
          if (a.kind === 'font' && a.font && a.url)
            fonts.push({
              assetId: a.id,
              kitId: a.kitId,
              family: a.font.family,
              weight: a.font.weight,
              italic: a.font.italic,
              url: a.url,
            });
      return { value: { fonts } };
    }
    case 'brand:styles': {
      const kitId = p.kitId as string;
      const all = cp2a(state).styles;
      return { value: { styles: all.filter((s) => b.styleKit.get(s.id) === kitId) } };
    }
    case 'brand:saveStyle': {
      const kitId = p.kitId as string;
      kitOrThrow(b, kitId);
      const style = captionStyleSchema.parse(p.style);
      b.log.savedStyles.push({ kitId, style });
      const a = cp2a(state);
      const at = a.styles.findIndex((s) => s.id === style.id && !s.builtin);
      if (at >= 0 && b.styleKit.get(style.id) === kitId) {
        a.styles[at] = { ...style, builtin: false };
        return { value: a.styles[at]! };
      }
      a.counter += 1;
      const saved = { ...style, id: `kit-style-${kitId}-${a.counter}`, builtin: false };
      a.styles.push(saved);
      b.styleKit.set(saved.id, kitId);
      await state.emit?.('brand:changed', { kitId });
      return { value: saved };
    }
    case 'brand:apply': {
      b.log.applied.push(p);
      return { value: { queued: ((p.clipIds as string[] | undefined) ?? []).length, skipped: 0 } };
    }

    /* ---- stock B-roll: enough for the dialog to mount, plus a credited import ---- */
    case 'broll:status':
      return { value: { pexels: true, pixabay: false } };
    case 'broll:search':
      return { value: { items: [], page: 1, nextPage: null } };
    case 'broll:suggest':
      return { value: { queries: [] } };
    case 'broll:importToKit': {
      const kitId = p.kitId as string;
      const item = p.item as { title: string; author: string | null; pageUrl: string | null; durationSec: number };
      kitOrThrow(b, kitId);
      const asset = makeAsset(b, state, {
        kitId,
        kind: 'video',
        name: `${item.title}.mp4`,
        ext: 'mp4',
        width: 1080,
        height: 1920,
        durationSec: item.durationSec,
        thumbUrl: `${state.assetBase}/__assets/c3.jpg`,
        previewUrl: `${state.assetBase}/__assets/clip-c.webm`,
        credit: { source: 'pexels', author: item.author, url: item.pageUrl },
      });
      b.assets.get(kitId)!.push(asset);
      await state.emit?.('brand:changed', { kitId });
      return { value: { asset: clone(asset) } };
    }
    case 'broll:importToProject':
      throw fail('Not available in the Brand Kit page stub.');
  }
  return null;
}

/* ---------------------------------------------------------------------------------- install + helpers - */

let installed = false;
/**
 * Puts `handleBrand` in front of `stubB.handle`, which the main stub already calls. Idempotent; once the main stub
 * calls `handleBrand` directly this wrapper is redundant and harmless.
 */
export function installBrandStub(): void {
  if (installed) return;
  installed = true;
  const original = stubB.handle.bind(stubB);
  stubB.handle = async (state, channel, payload) => {
    const mine = await handleBrand(state, channel, payload);
    return mine ?? original(state, channel, payload);
  };
}

export interface OpenBrandOptions extends OpenOptions {
  seed?: SeedOptions;
}

/** Opens `/brand-kit/` with kits seeded and `window.clipfern.pathForFile` installed. */
export async function openBrand(
  h: Harness,
  opts: OpenBrandOptions = {},
  route = '/brand-kit/',
): Promise<Session> {
  installBrandStub();
  const { seed, prepare, ...rest } = opts;
  const s = await h.open(route, {
    scenario: 'configured',
    settle: 700,
    ...rest,
    prepare: (st) => {
      seedBrand(st, seed);
      prepare?.(st);
    },
  });
  await installPathForFile(s.page);
  return s;
}

/** Electron's `webUtils.getPathForFile`: here a registry written by `dropFiles`, falling back to /Users/demo/Brand/<name>. */
export async function installPathForFile(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      clipfern: { pathForFile: (f: File) => string };
      __dropPaths?: Map<File, string>;
    };
    w.__dropPaths ??= new Map();
    w.clipfern.pathForFile = (f: File) => w.__dropPaths!.get(f) ?? `/Users/demo/Brand/${f.name}`;
  });
}

export interface DropSpec {
  name: string;
  /** Reported `size` in bytes (the file content stays tiny). */
  size?: number;
  type?: string;
  /** Absolute path `pathForFile` answers; default /Users/demo/Brand/<name>. */
  path?: string;
}

/** Fires dragenter / dragover / drop with real `File` objects on `target`. */
export async function dropFiles(s: Session, target: Locator, files: DropSpec[]): Promise<void> {
  const b = brand(s.state);
  for (const f of files) b.fileSizes.set(f.path ?? `/Users/demo/Brand/${f.name}`, f.size ?? 150_000);
  const dt = await target.page().evaluateHandle((specs) => {
    const w = window as unknown as { __dropPaths?: Map<File, string> };
    w.__dropPaths ??= new Map();
    const data = new DataTransfer();
    for (const sp of specs) {
      const file = new File([new Uint8Array(16)], sp.name, { type: sp.type ?? '' });
      Object.defineProperty(file, 'size', { value: sp.size ?? 150_000 });
      w.__dropPaths.set(file, sp.path ?? `/Users/demo/Brand/${sp.name}`);
      data.items.add(file);
    }
    return data;
  }, files);
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
}

/** Test controls. */
export function brandControls(state: Cp1State) {
  const b = brand(state);
  const firstKit = () => b.kits.get(b.order[0]!)!;
  return {
    state: b,
    kit: (id?: string) => (id ? kitOrThrow(b, id) : firstKit()),
    /** The next `times` calls of `channel` fail. */
    failNext(channel: string, message: string, times = 1, code?: 'FAILED' | 'CONFLICT') {
      b.failures.set(channel, { message, times, code });
    },
    /** Another window saved: bumps the revision (and optionally edits the spec) without telling the page. */
    saveElsewhere(kitId: string, spec: Partial<BrandKitSpec> = {}, name?: string) {
      const k = kitOrThrow(b, kitId);
      k.spec = brandKitSpecSchema.parse({ ...k.spec, ...spec });
      if (name) k.name = name;
      k.rev += 1;
      k.updatedAt = Date.now();
    },
    /** Same, and push `brand:changed` like main would. */
    async saveElsewhereAndNotify(kitId: string, spec: Partial<BrandKitSpec> = {}, name?: string) {
      this.saveElsewhere(kitId, spec, name);
      await state.emit?.('brand:changed', { kitId });
    },
    queueBrowse(...files: { name: string; size?: number }[][]) {
      b.browseQueue.push(...files);
    },
  };
}
