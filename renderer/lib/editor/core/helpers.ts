/**
 * Pure helpers exported to the UI (ids, project / item / track factories, time↔pixel maths, frame maths,
 * track compatibility). No state, no DOM.
 */
import {
  ASPECT_SIZES,
  TRACK_ACCEPTS,
  imageItemSchema,
  audioItemSchema,
  projectSchema,
  shapeItemSchema,
  subtitleItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  type AspectId,
  type Asset,
  type AudioItem,
  type ImageItem,
  type ItemType,
  type Project,
  type ShapeItem,
  type ShapeKind,
  type SubtitleItem,
  type TextItem,
  type Track,
  type TrackKind,
  type VideoItem,
} from '@shared/editor';

export const MIN_ITEM_SEC = 0.04;

/* ------------------------------------------------------------------ ids ----------------------- */

let idCounter = 0;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short unique id: `<prefix>_<counter><random>` ('it_…', 'tr_…', 'as_…', 'mk_…', 'gr_…'). Unique per session. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000_000;
  let r = '';
  for (let i = 0; i < 5; i++) r += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}_${idCounter.toString(36)}${r}`;
}

/* ------------------------------------------------------------------ frames / pixels ----------- */

export const frameDuration = (fps: number): number => 1 / fps;
/** Nearest frame boundary. */
export const snapToFrame = (t: number, fps: number): number => Math.round(t * fps) / fps;
export const timeToPx = (t: number, pxPerSec: number, scrollSec: number): number =>
  (t - scrollSec) * pxPerSec;
export const pxToTime = (px: number, pxPerSec: number, scrollSec: number): number =>
  px / pxPerSec + scrollSec;

export const TRANSPORT_RATES = [1, 2, 4, 8] as const;

/* ------------------------------------------------------------------ tracks -------------------- */

const DEFAULT_TRACK_NAME: Record<TrackKind, string> = {
  video: 'Video',
  overlay: 'Overlay',
  image: 'Images',
  text: 'Text',
  subtitle: 'Subtitles',
  audio: 'Music',
  sfx: 'SFX',
};

/** z-order rank used to place a NEW track sensibly among existing ones (video lowest, audio last). */
export const TRACK_RANK: Record<TrackKind, number> = {
  video: 0,
  overlay: 1,
  image: 1,
  text: 2,
  subtitle: 3,
  audio: 4,
  sfx: 4,
};

export function makeTrack(
  kind: TrackKind,
  name?: string,
  opts: { id?: string; speech?: boolean } = {},
): Track {
  return trackSchema.parse({
    id: opts.id ?? newId('tr'),
    kind,
    name: name ?? DEFAULT_TRACK_NAME[kind],
    speech: opts.speech ?? kind === 'video',
    items: [],
  });
}

/** "Video 2" style default name for the next track of a kind. */
export function nextTrackName(tracks: readonly Track[], kind: TrackKind): string {
  const n = tracks.filter((t) => t.kind === kind).length;
  return n === 0 ? DEFAULT_TRACK_NAME[kind] : `${DEFAULT_TRACK_NAME[kind]} ${n + 1}`;
}

/** Default insertion index for a new track of `kind`: after every track of lower-or-equal rank. */
export function defaultTrackIndex(tracks: readonly Track[], kind: TrackKind): number {
  const rank = TRACK_RANK[kind];
  const idx = tracks.findIndex((t) => TRACK_RANK[t.kind] > rank);
  return idx < 0 ? tracks.length : idx;
}

export const trackAccepts = (track: Pick<Track, 'kind'>, itemType: ItemType): boolean =>
  TRACK_ACCEPTS[track.kind].includes(itemType);

/** Track kinds to try, in order, when placing an item of `type` automatically. The first is also the kind created. */
export const PREFERRED_KINDS: Record<ItemType, TrackKind[]> = {
  video: ['video', 'overlay'],
  image: ['image', 'overlay'],
  audio: ['audio'],
  text: ['text', 'overlay'],
  subtitle: ['subtitle'],
  shape: ['overlay', 'image'],
};

/** First UNLOCKED track of a preferred kind for the item type (video → Video, else Overlay…), or null. */
export function firstCompatibleTrack(project: Project, itemType: ItemType): Track | null {
  for (const kind of PREFERRED_KINDS[itemType]) {
    const t = project.tracks.find((tr) => tr.kind === kind && !tr.locked);
    if (t) return t;
  }
  return null;
}

/** A blank project with the default tracks (Video[speech], Subtitles, Text, Music). */
export function emptyProject(aspect: AspectId = '9:16'): Project {
  const size = ASPECT_SIZES[aspect === 'custom' ? '9:16' : aspect];
  return projectSchema.parse({
    canvas: { aspect, width: size.width, height: size.height },
    tracks: [
      makeTrack('video', 'Video', { speech: true }),
      makeTrack('subtitle', 'Subtitles'),
      makeTrack('text', 'Text'),
      makeTrack('audio', 'Music'),
    ],
    assets: [],
  });
}

/* ------------------------------------------------------------------ item factories ------------ */

interface MakeOpts {
  id?: string;
  durationSec?: number;
  name?: string;
}

function pickDuration(opts: MakeOpts, fallback: number): number {
  const d = opts.durationSec ?? fallback;
  return Math.max(MIN_ITEM_SEC, Number.isFinite(d) ? d : fallback);
}

export function makeVideoItem(
  asset: Asset,
  startSec: number,
  opts: MakeOpts & { inSec?: number } = {},
): VideoItem {
  const inSec = Math.max(0, opts.inSec ?? 0);
  const natural = asset.durationSec !== null ? Math.max(MIN_ITEM_SEC, asset.durationSec - inSec) : 5;
  return videoItemSchema.parse({
    type: 'video',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, natural),
    name: opts.name ?? asset.name,
    assetId: asset.id,
    inSec,
    audioEnabled: asset.hasAudio,
  });
}

export function makeAudioItem(
  asset: Asset,
  startSec: number,
  opts: MakeOpts & { inSec?: number } = {},
): AudioItem {
  const inSec = Math.max(0, opts.inSec ?? 0);
  const natural = asset.durationSec !== null ? Math.max(MIN_ITEM_SEC, asset.durationSec - inSec) : 5;
  return audioItemSchema.parse({
    type: 'audio',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, natural),
    name: opts.name ?? asset.name,
    assetId: asset.id,
    inSec,
  });
}

/** Stills default to 5 s. */
export function makeImageItem(asset: Asset, startSec: number, opts: MakeOpts = {}): ImageItem {
  return imageItemSchema.parse({
    type: 'image',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, 5),
    name: opts.name ?? asset.name,
    assetId: asset.id,
  });
}

/** Text layers default to 3 s. `style` is a partial TextStyle merged over the schema defaults. */
export function makeTextItem(
  text: string,
  startSec: number,
  opts: MakeOpts & { style?: Partial<TextItem['style']> } = {},
): TextItem {
  return textItemSchema.parse({
    type: 'text',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, 3),
    name: opts.name,
    text,
    style: opts.style ?? {},
  });
}

const SHAPE_DEFAULTS: Record<ShapeKind, { width: number; height: number; fill?: string }> = {
  rect: { width: 400, height: 400 },
  ellipse: { width: 400, height: 400 },
  line: { width: 600, height: 6 },
  arrow: { width: 600, height: 60 },
  'progress-bar': { width: 900, height: 16 },
};

/** Shapes default to 3 s. */
export function makeShapeItem(
  kind: ShapeKind,
  startSec: number,
  opts: MakeOpts & Partial<Pick<ShapeItem, 'width' | 'height' | 'fill'>> = {},
): ShapeItem {
  const d = SHAPE_DEFAULTS[kind];
  return shapeItemSchema.parse({
    type: 'shape',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, 3),
    name: opts.name,
    shape: kind,
    width: opts.width ?? d.width,
    height: opts.height ?? d.height,
    ...(opts.fill ? { fill: opts.fill } : {}),
  });
}

/**
 * A caption cue. `words` carry times LOCAL to the cue (0 = cue start); duration = end of the last word
 * (override with `opts.durationSec`).
 */
export function makeSubtitleItem(
  words: readonly { w: string; s: number; e: number; color?: string | null }[],
  startSec: number,
  opts: MakeOpts & { styleId?: string } = {},
): SubtitleItem {
  const ws = words.map((w) => ({
    w: w.w,
    s: Math.max(0, w.s),
    e: Math.max(w.s, w.e),
    color: w.color ?? null,
  }));
  const lastEnd = ws.reduce((m, w) => Math.max(m, w.e), 0);
  return subtitleItemSchema.parse({
    type: 'subtitle',
    id: opts.id ?? newId('it'),
    startSec: Math.max(0, startSec),
    durationSec: pickDuration(opts, lastEnd),
    name: opts.name,
    words: ws,
    ...(opts.styleId ? { styleId: opts.styleId } : {}),
  });
}
