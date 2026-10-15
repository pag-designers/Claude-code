import {
  audioItemSchema,
  imageItemSchema,
  projectSchema,
  textAnimationSchema,
  textStyleSchema,
  trackSchema,
  videoItemSchema,
  type Asset,
  type AudioItem,
  type ImageItem,
  type Item,
  type Project,
  type TextAnimation,
  type TextItem,
  type TextStyle,
  type Track,
  type VideoItem,
} from './editor';
import { itemEnd } from './editor-eval';
import {
  BRAND_PARTS,
  watermarkRect,
  type BrandAsset,
  type BrandKit,
  type BrandKitSpec,
  type BrandPart,
  type BrandTextStyle,
  type HookStyle,
} from './brand';

/* ------------------------------------------------------------------------------------------------
 * CP4 — "Apply Brand Kit" to an editor project (BRIEF §5 + §7). PURE: no DOM, no randomness (ids come from
 * the caller's `newId`), same input → same output, and idempotent: applying a kit twice yields the same project,
 * applying another kit replaces the pieces the first one added.
 *
 * Everything this module adds is recognisable by a FIXED id so it can be found again and replaced:
 *   items   brand_intro · brand_outro · brand_wm · brand_music_<n>
 *   tracks  tr_brand_wm ("Brand watermark", overlay) · tr_brand_music ("Brand music", audio)
 *   assets  ba_<brandAssetId>  (see `brandAssetToProjectAsset`)
 *
 * Geometry (the parity contract of shared/editor.ts is respected — nothing here needs a renderer change):
 *   - intro: a video item at t = 0 on the MAIN (first) video track; EVERY item of EVERY track and every marker is
 *     rippled later by the intro's duration. Outro: appended at the programme end on the main track.
 *   - "programme" = everything that is not brand intro / outro / watermark / music, measured on the visual tracks
 *     (a long music bed never pushes the outro out).
 *   - watermark: ONE image item over the programme, placed with `watermarkRect()` (fit 'native', so the transform
 *     scale is exactly logoWidth / assetWidth — the same rectangle the clip finisher and the Brand Kit page use).
 *   - music: the kit's bed on its own audio track over the programme, looped by repeating items or trimmed, ducking
 *     enabled on the track; video tracks are marked `speech` so the ducking engages.
 *   - text sizes of kit text styles are authored for a 1080-px short side and scale with min(width, height) / 1080
 *     (the same unit the bin's presets use); wrap widths scale with the canvas width.
 * ---------------------------------------------------------------------------------------------- */

export const BRAND_ITEM_IDS = {
  intro: 'brand_intro',
  outro: 'brand_outro',
  watermark: 'brand_wm',
  musicPrefix: 'brand_music_',
} as const;
export const BRAND_TRACK_IDS = { watermark: 'tr_brand_wm', music: 'tr_brand_music' } as const;
/** `styleRef` of a text item created from / restyled with a kit text style. */
export const brandStyleRef = (kitId: string, styleId: string): string =>
  `brand:${kitId}:${styleId}`;
/** styleRef marker of a hook item restyled from the kit's card style (`spec.hook`) when no hook text style is set. */
export const BRAND_HOOK_CARD_ID = 'hook';

export const brandProjectAssetId = (brandAssetId: string): string => `ba_${brandAssetId}`;
const isBrandItem = (id: string): boolean =>
  id === BRAND_ITEM_IDS.intro ||
  id === BRAND_ITEM_IDS.outro ||
  id === BRAND_ITEM_IDS.watermark ||
  id.startsWith(BRAND_ITEM_IDS.musicPrefix);
const isBrandTrack = (id: string): boolean =>
  id === BRAND_TRACK_IDS.watermark || id === BRAND_TRACK_IDS.music;

const EPS = 1e-6;
/** Times are rounded to the microsecond after arithmetic so ripples never accumulate float dust. */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const MIN_DUR = 0.04;
const MAX_MUSIC_PIECES = 600;

/* ------------------------------------------------------------------------------ assets ------- */

const stripExt = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
const keyExt = (key: string): string => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(key);
  return m ? (m[1] as string).toLowerCase() : '';
};

/**
 * A Brand Kit asset as an editor project asset. Id `ba_<assetId>`; the source is an `upload` whose key is the file the
 * compositor can use (`usableKey` — SVG raster, converted font — else the original). Logos, fonts and images become
 * `image`, because the editor has no other still kind.
 */
export function brandAssetToProjectAsset(asset: BrandAsset): Asset {
  const key = asset.usableKey ?? asset.storageKey;
  const kind: Asset['kind'] =
    asset.kind === 'video' ? 'video' : asset.kind === 'audio' ? 'audio' : 'image';
  const ext = keyExt(key) || asset.ext;
  const visual = kind === 'video' || kind === 'image';
  return {
    id: brandProjectAssetId(asset.id),
    kind,
    name: asset.name,
    source: { kind: 'upload', key, fileName: `${stripExt(asset.name)}.${ext}` },
    durationSec: kind === 'image' ? null : asset.durationSec,
    width: visual ? asset.width : null,
    height: visual ? asset.height : null,
    fps: kind === 'video' ? asset.fps : null,
    hasAudio: kind === 'audio' ? true : kind === 'video' ? asset.hasAudio : false,
    beats: null,
  };
}

/** The parts a kit turns on by default (its `defaults` switches, and only when the asset they need exists). */
export function brandPartsFromDefaults(spec: BrandKitSpec): BrandPart[] {
  const d = spec.defaults;
  const parts: BrandPart[] = [];
  if (d.watermarkOn && spec.watermark.assetId) parts.push('watermark');
  if (d.introOn && spec.introAssetId) parts.push('intro');
  if (d.outroOn && spec.outroAssetId) parts.push('outro');
  parts.push('subtitles');
  // the hook card look (kit `hook` style, or a chosen hook text style) always follows the kit, like a rendered clip's card
  parts.push('hook');
  if (d.musicOn && spec.musicBed.assetId) parts.push('music');
  return parts;
}

/* ------------------------------------------------------------------------------ text styles --- */

export interface BrandTextPatch {
  style: TextStyle;
  animIn: TextAnimation;
  animOut: TextAnimation;
  /** Offset of the text centre from the canvas centre, canvas px. */
  y: number;
}

/** Kit text style → what a text item on THIS canvas gets (sizes scale with the short side, wrap with the width). */
export function brandTextPatch(
  ts: Pick<BrandTextStyle, 'style' | 'animIn' | 'animOut' | 'yPct'>,
  canvas: { width: number; height: number },
): BrandTextPatch {
  const u = Math.min(canvas.width, canvas.height) / 1080;
  const s = (n: number, lo: number, hi: number): number =>
    clamp(Math.round(n * u * 100) / 100, lo, hi);
  const st = ts.style;
  const style: TextStyle = textStyleSchema.parse({
    ...st,
    size: s(st.size, 8, 600),
    letterSpacing: s(st.letterSpacing, -20, 80),
    stroke: st.stroke ? { ...st.stroke, width: s(st.stroke.width, 0, 40) } : null,
    shadow: st.shadow
      ? {
          ...st.shadow,
          blur: s(st.shadow.blur, 0, 60),
          offsetX: s(st.shadow.offsetX, -60, 60),
          offsetY: s(st.shadow.offsetY, -60, 60),
        }
      : null,
    box: st.box
      ? { ...st.box, padding: s(st.box.padding, 0, 120), radius: s(st.box.radius, 0, 120) }
      : null,
    maxWidth:
      st.maxWidth === null ? null : Math.max(40, Math.round((st.maxWidth * canvas.width) / 1080)),
  });
  return {
    style,
    animIn: textAnimationSchema.parse(ts.animIn),
    animOut: textAnimationSchema.parse(ts.animOut),
    y: Math.round((clamp(ts.yPct, 0, 100) / 100 - 0.5) * canvas.height),
  };
}

/** The kit's burned-in hook CARD (`spec.hook`) as an editor text style, the same look CP3 gives an opened clip's hook. */
export function hookCardPatch(
  hook: HookStyle,
  canvas: { width: number; height: number },
): BrandTextPatch {
  const short = Math.min(canvas.width, canvas.height);
  return {
    style: textStyleSchema.parse({
      fontFamily: hook.fontFamily,
      weight: hook.weight,
      size: clamp(Math.round((short * hook.sizePct) / 100), 8, 600),
      color: hook.textColor,
      align: 'center',
      lineHeight: 1.12,
      box: {
        color: hook.cardColor,
        opacity: hook.cardOpacity,
        padding: Math.round(short * 0.025),
        radius: Math.round(short * 0.02),
      },
      maxWidth: Math.round(canvas.width * 0.84),
    }),
    animIn: { type: 'pop', durationSec: 0.3 },
    animOut: { type: 'fade', durationSec: 0.25 },
    y: Math.round((clamp(hook.yPct, 0, 100) / 100 - 0.5) * canvas.height),
  };
}

/* ------------------------------------------------------------------------------ validation ---- */

/** The editor's layout invariant for one track (sorted; overlaps only as transitions) — a copy of core's `layoutProblem`. */
function layoutIssue(items: readonly Item[]): string | null {
  let endsBeforePrev = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    const prev = items[i - 1];
    if (prev && it.startSec < prev.startSec - EPS) return `items not sorted at ${it.id}`;
    if (it.startSec < endsBeforePrev - EPS) return `${it.id} overlaps a non-adjacent item`;
    if (prev) {
      const o = itemEnd(prev) - it.startSec;
      if (o > EPS) {
        const tin = 'transitionIn' in it ? it.transitionIn : null;
        if (!tin) return `${it.id} overlaps ${prev.id} without a transition`;
        if (Math.abs(o - tin.durationSec) > 1e-5) return `${it.id} transition != overlap`;
      }
      endsBeforePrev = Math.max(endsBeforePrev, itemEnd(prev));
    }
  }
  return null;
}

function projectIssue(p: Project): string | null {
  const ids = new Set<string>();
  for (const tr of p.tracks) {
    const issue = layoutIssue(tr.items);
    if (issue) return `${tr.name}: ${issue}`;
    for (const it of tr.items) {
      if (ids.has(it.id)) return `duplicate item id ${it.id}`;
      ids.add(it.id);
      if (it.startSec < -EPS || it.durationSec < MIN_DUR - EPS) return `${it.id}: bad timing`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------ the operation -- */

export interface ApplyBrandArgs {
  project: Project;
  kit: BrandKit;
  /** The kit's assets (anything shaped like `BrandAsset`; the editor passes the `brand:get` views). */
  assets: readonly BrandAsset[];
  parts: readonly BrandPart[];
  /** Id factory (only used to create a missing main video track). */
  newId: (prefix: string) => string;
  /**
   * The kit the project was branded with before (`project.brandKitId`), when it differs from `kit`: its hook
   * items are still recognised and restyled.
   */
  previousKit?: BrandKit | null;
}

export interface ApplyBrandResult {
  project: Project;
  /** Parts that now hold (in BRAND_PARTS order), including those that were already in place. */
  applied: BrandPart[];
  /** Parts left untouched, with a reason a person can read. */
  skipped: { part: BrandPart; reason: string }[];
  /** One human line per applied part ("Intro 4.0 s inserted at the start; everything moves 4.0 s later"). */
  details: Partial<Record<BrandPart, string>>;
}

const fmtSec = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)} s`;

const allItems = (p: Project): Item[] => p.tracks.flatMap((t) => t.items);
const findBrandItem = (p: Project, id: string): { track: Track; item: Item } | null => {
  for (const track of p.tracks) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { track, item };
  }
  return null;
};

/** The main video track: the first track of kind 'video'. */
const mainTrackIndex = (p: Project): number => p.tracks.findIndex((t) => t.kind === 'video');

function mapTracks(p: Project, fn: (t: Track) => Track): Project {
  let changed = false;
  const tracks = p.tracks.map((t) => {
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? { ...p, tracks } : p;
}

/** Moves every item of every track and every marker by `delta` seconds (never below 0). */
function shiftEverything(p: Project, delta: number): Project {
  if (Math.abs(delta) < 1e-9) return p;
  const tracks = p.tracks.map((t) =>
    t.items.length
      ? {
          ...t,
          items: t.items.map((it) => ({ ...it, startSec: r6(Math.max(0, it.startSec + delta)) })),
        }
      : t,
  );
  const markers = p.markers.map((m) => ({ ...m, atSec: r6(Math.max(0, m.atSec + delta)) }));
  return { ...p, tracks, markers };
}

const removeItems = (p: Project, pred: (it: Item) => boolean): Project =>
  mapTracks(p, (t) => (t.items.some(pred) ? { ...t, items: t.items.filter((i) => !pred(i)) } : t));

/** Where the programme (everything but the brand pieces) starts and ends on the timeline. */
function programmeSpan(p: Project): { start: number; end: number; empty: boolean } {
  const intro = findBrandItem(p, BRAND_ITEM_IDS.intro);
  const start = intro ? itemEnd(intro.item) : 0;
  let end = -Infinity;
  let any = false;
  for (const pass of [0, 1]) {
    // pass 0: visual tracks only; pass 1 (only when there is no visual content): audio tracks too
    for (const t of p.tracks) {
      if (isBrandTrack(t.id)) continue;
      const audio = t.kind === 'audio' || t.kind === 'sfx';
      if ((pass === 0) === audio) continue;
      for (const it of t.items) {
        if (isBrandItem(it.id)) continue;
        any = true;
        end = Math.max(end, itemEnd(it));
      }
    }
    if (any) break;
  }
  return { start, end: any ? Math.max(end, start) : start, empty: !any };
}

type PartResult = Project | string;

const ORDER: BrandPart[] = ['intro', 'outro', 'watermark', 'subtitles', 'hook', 'music'];

/**
 * Applies the chosen parts of `kit` to `project`. Never throws: a part that cannot be applied (missing asset, wrong
 * kind, nothing to restyle, would break the track layout) lands in `skipped` and leaves the project as it was for
 * that part. Returns the SAME project object when nothing changed (so a store records no undo step).
 */
export function applyBrandToProject(args: ApplyBrandArgs): ApplyBrandResult {
  const { kit, parts, newId } = args;
  const original = args.project;
  const spec = kit.spec;
  const byId = new Map(args.assets.map((a) => [a.id, a]));
  const wanted = new Set(parts);
  const orphanCandidates = new Set<string>();

  const needAsset = (
    id: string | null,
    kinds: BrandAsset['kind'][],
    what: string,
  ): BrandAsset | string => {
    if (!id) return `This kit has no ${what} set.`;
    const a = byId.get(id);
    if (!a) return `The ${what} file is no longer in the kit.`;
    if (!kinds.includes(a.kind))
      return `The ${what} must be ${kinds.join(' or ')} (it is ${a.kind}).`;
    return a;
  };
  const useAsset = (p: Project, a: BrandAsset): Project => {
    const next = brandAssetToProjectAsset(a);
    const cur = p.assets.find((x) => x.id === next.id);
    const merged: Asset = cur ? { ...next, beats: cur.beats } : next;
    if (cur && JSON.stringify(cur) === JSON.stringify(merged)) return p;
    return {
      ...p,
      assets: cur ? p.assets.map((x) => (x.id === merged.id ? merged : x)) : [...p.assets, merged],
    };
  };

  const details: Partial<Record<BrandPart, string>> = {};

  /* ---- intro ---- */
  const applyIntro = (p0: Project): PartResult => {
    const a = needAsset(spec.introAssetId, ['video'], 'intro video');
    if (typeof a === 'string') return a;
    if (a.durationSec === null || a.durationSec < MIN_DUR)
      return 'The intro video has no known duration.';
    const mi = mainTrackIndex(p0);
    if (mi >= 0 && (p0.tracks[mi] as Track).locked) return 'The main video track is locked.';
    const dur = r6(a.durationSec);
    const pid = brandProjectAssetId(a.id);
    const cur = findBrandItem(p0, BRAND_ITEM_IDS.intro);
    if (
      cur &&
      cur.item.type === 'video' &&
      cur.item.assetId === pid &&
      Math.abs(cur.item.durationSec - dur) < 1e-6 &&
      cur.item.startSec < 1e-6
    ) {
      details.intro = `Intro ${fmtSec(dur)} already at the start.`;
      return useAsset(p0, a);
    }
    let p = p0;
    if (cur) {
      // replacing: take the old intro out and close the gap it left
      orphanCandidates.add((cur.item as VideoItem).assetId);
      p = shiftEverything(
        removeItems(p, (i) => i.id === BRAND_ITEM_IDS.intro),
        -cur.item.durationSec,
      );
    }
    p = shiftEverything(p, dur);
    p = useAsset(p, a);
    let idx = mainTrackIndex(p);
    if (idx < 0) {
      const track = trackSchema.parse({
        id: newId('tr'),
        kind: 'video',
        name: 'Video',
        speech: true,
        items: [],
      });
      p = { ...p, tracks: [track, ...p.tracks] };
      idx = 0;
    }
    const item: VideoItem = videoItemSchema.parse({
      type: 'video',
      id: BRAND_ITEM_IDS.intro,
      name: 'Brand intro',
      startSec: 0,
      durationSec: dur,
      assetId: pid,
      audioEnabled: a.hasAudio,
      // the clip finisher scales intros to the clip with black bars; the editor shows the same
      fit: 'contain',
    });
    const tracks = p.tracks.map((t, i) => (i === idx ? { ...t, items: [item, ...t.items] } : t));
    details.intro = `Intro ${fmtSec(dur)} added at the start; everything moves ${fmtSec(dur)} later.`;
    return { ...p, tracks };
  };

  /* ---- outro ---- */
  const applyOutro = (p0: Project): PartResult => {
    const a = needAsset(spec.outroAssetId, ['video'], 'outro video');
    if (typeof a === 'string') return a;
    if (a.durationSec === null || a.durationSec < MIN_DUR)
      return 'The outro video has no known duration.';
    const mi = mainTrackIndex(p0);
    if (mi >= 0 && (p0.tracks[mi] as Track).locked) return 'The main video track is locked.';
    const dur = r6(a.durationSec);
    const pid = brandProjectAssetId(a.id);
    let p = removeItems(p0, (i) => i.id === BRAND_ITEM_IDS.outro);
    const prev = findBrandItem(p0, BRAND_ITEM_IDS.outro);
    const span = programmeSpan(p);
    if (span.empty) return 'There is nothing on the timeline to put an outro after.';
    const at = r6(span.end);
    if (
      prev &&
      prev.item.type === 'video' &&
      prev.item.assetId === pid &&
      Math.abs(prev.item.durationSec - dur) < 1e-6 &&
      Math.abs(prev.item.startSec - at) < 1e-6
    ) {
      details.outro = `Outro ${fmtSec(dur)} already at the end.`;
      return useAsset(p0, a);
    }
    if (prev) orphanCandidates.add((prev.item as VideoItem).assetId);
    p = useAsset(p, a);
    let idx = mainTrackIndex(p);
    if (idx < 0) {
      const track = trackSchema.parse({
        id: newId('tr'),
        kind: 'video',
        name: 'Video',
        speech: true,
        items: [],
      });
      p = { ...p, tracks: [track, ...p.tracks] };
      idx = 0;
    }
    const item: VideoItem = videoItemSchema.parse({
      type: 'video',
      id: BRAND_ITEM_IDS.outro,
      name: 'Brand outro',
      startSec: at,
      durationSec: dur,
      assetId: pid,
      audioEnabled: a.hasAudio,
      fit: 'contain',
    });
    const tracks = p.tracks.map((t, i) => (i === idx ? { ...t, items: [...t.items, item] } : t));
    details.outro = `Outro ${fmtSec(dur)} added after the last clip.`;
    return { ...p, tracks };
  };

  /* ---- watermark ---- */
  const applyWatermark = (p0: Project): PartResult => {
    const wm = spec.watermark;
    const a = needAsset(wm.assetId, ['logo', 'image'], 'watermark logo');
    if (typeof a === 'string') return a;
    if (!a.width || !a.height) return 'The logo has no known size.';
    const span = programmeSpan(p0);
    if (span.empty || span.end - span.start < MIN_DUR)
      return 'There is nothing on the timeline to watermark.';
    const rect = watermarkRect(p0.canvas, wm, a.width / a.height);
    const pid = brandProjectAssetId(a.id);
    let p = removeItems(p0, (i) => i.id === BRAND_ITEM_IDS.watermark);
    const old = findBrandItem(p0, BRAND_ITEM_IDS.watermark);
    if (old && old.item.type === 'image' && old.item.assetId !== pid)
      orphanCandidates.add(old.item.assetId);
    p = useAsset(p, a);
    const item: ImageItem = imageItemSchema.parse({
      type: 'image',
      id: BRAND_ITEM_IDS.watermark,
      name: 'Brand watermark',
      startSec: r6(span.start),
      durationSec: r6(span.end - span.start),
      assetId: pid,
      // native: the natural rect is the source at 1:1, so scale = logo width on the canvas / source width
      fit: 'native',
      transform: {
        x: { v: Math.round((rect.cx - p.canvas.width / 2) * 100) / 100, kf: [] },
        y: { v: Math.round((rect.cy - p.canvas.height / 2) * 100) / 100, kf: [] },
        scale: { v: Math.round((rect.w / a.width) * 1e6) / 1e6, kf: [] },
        rotation: { v: 0, kf: [] },
        opacity: { v: wm.opacity, kf: [] },
      },
    });
    const existing = p.tracks.findIndex((t) => t.id === BRAND_TRACK_IDS.watermark);
    if (existing >= 0) {
      const tracks = p.tracks.map((t, i) => (i === existing ? { ...t, items: [item] } : t));
      p = { ...p, tracks };
    } else {
      const track: Track = trackSchema.parse({
        id: BRAND_TRACK_IDS.watermark,
        kind: 'overlay',
        name: 'Brand watermark',
        items: [item],
      });
      // topmost visual layer: just before the first audio track
      const at = p.tracks.findIndex((t) => t.kind === 'audio' || t.kind === 'sfx');
      const idx = at < 0 ? p.tracks.length : at;
      p = { ...p, tracks: [...p.tracks.slice(0, idx), track, ...p.tracks.slice(idx)] };
    }
    details.watermark = `Logo placed ${wm.position.replace('-', ' ')} at ${Math.round(wm.sizePct)} % width, ${Math.round(wm.opacity * 100)} % opacity, for the whole programme.`;
    return p;
  };

  /* ---- subtitles ---- */
  const applySubtitles = (p0: Project): PartResult => {
    const styleId = spec.defaults.captionStyleId;
    if (!allItems(p0).some((i) => i.type === 'subtitle'))
      return 'There are no captions in this project.';
    let n = 0;
    const p = mapTracks(p0, (t) => {
      if (
        !t.items.some(
          (i) => i.type === 'subtitle' && (i.styleId !== styleId || i.styleOverride !== null),
        )
      )
        return t;
      return {
        ...t,
        items: t.items.map((i) =>
          i.type === 'subtitle' ? { ...i, styleId, styleOverride: null } : i,
        ),
      };
    });
    for (const i of allItems(p)) if (i.type === 'subtitle') n++;
    details.subtitles = `${n} caption line${n === 1 ? '' : 's'} set to the "${styleId}" style.`;
    return p;
  };

  /* ---- hook ---- */
  const kitsKnown = [
    kit,
    ...(args.previousKit && args.previousKit.id !== kit.id ? [args.previousKit] : []),
  ];
  const isHookRef = (ref: string): boolean => {
    const m = /^brand:([^:]+):(.+)$/.exec(ref);
    if (!m) return false;
    const [, kitId, styleId] = m as unknown as [string, string, string];
    if (styleId === BRAND_HOOK_CARD_ID) return true;
    const k = kitsKnown.find((x) => x.id === kitId);
    return !!k?.spec.textStyles.some((t) => t.id === styleId && t.kind === 'hook');
  };
  const isHookItem = (i: Item): i is TextItem =>
    i.type === 'text' &&
    (i.styleRef === 'hook' ||
      (i.styleRef !== null && isHookRef(i.styleRef)) ||
      // CP3 gives an opened clip's hook the name "Hook" and no styleRef; kit restyles keep that name
      (i.name === 'Hook' && (i.styleRef === null || i.styleRef.startsWith('brand:'))));

  const applyHook = (p0: Project): PartResult => {
    const styleId = spec.defaults.hookTextStyleId;
    const ts = styleId
      ? spec.textStyles.find((t) => t.id === styleId && t.kind === 'hook')
      : undefined;
    if (styleId && !ts) return "The kit's hook text style no longer exists.";
    if (!allItems(p0).some(isHookItem)) return 'There is no hook text in this project.';
    const patch = ts ? brandTextPatch(ts, p0.canvas) : hookCardPatch(spec.hook, p0.canvas);
    const ref = brandStyleRef(kit.id, ts ? ts.id : BRAND_HOOK_CARD_ID);
    const upper = !ts && spec.hook.textCase === 'upper';
    const lower = !ts && spec.hook.textCase === 'lower';
    let n = 0;
    const p = mapTracks(p0, (t) => {
      if (!t.items.some(isHookItem)) return t;
      return {
        ...t,
        items: t.items.map((i) => {
          if (!isHookItem(i)) return i;
          n++;
          const text = upper ? i.text.toUpperCase() : lower ? i.text.toLowerCase() : i.text;
          return {
            ...i,
            text,
            style: patch.style,
            animIn: patch.animIn,
            animOut: patch.animOut,
            styleRef: ref,
            transform: { ...i.transform, y: { v: patch.y, kf: [] } },
          };
        }),
      };
    });
    details.hook = `${n} hook text${n === 1 ? '' : 's'} restyled with ${ts ? `"${ts.name}"` : 'the kit hook card'}.`;
    return p;
  };

  /* ---- music ---- */
  const applyMusic = (p0: Project): PartResult => {
    const bed = spec.musicBed;
    const a = needAsset(bed.assetId, ['audio'], 'music bed');
    if (typeof a === 'string') return a;
    const span = programmeSpan(p0);
    const length = r6(span.end - span.start);
    if (span.empty || length < MIN_DUR)
      return 'There is nothing on the timeline to put music under.';
    const unit = a.durationSec;
    if (unit !== null && unit < 1) return 'The music file is too short to use as a bed.';
    const pid = brandProjectAssetId(a.id);
    const old = allItems(p0).find((i) => i.id.startsWith(BRAND_ITEM_IDS.musicPrefix));
    if (old && old.type === 'audio' && old.assetId !== pid) orphanCandidates.add(old.assetId);
    let p = removeItems(p0, (i) => i.id.startsWith(BRAND_ITEM_IDS.musicPrefix));
    p = useAsset(p, a);

    if (unit !== null && Math.ceil(length / unit) > MAX_MUSIC_PIECES)
      return 'The music file is too short to loop over a project this long.';
    const pieces: { start: number; dur: number }[] = [];
    if (unit === null) pieces.push({ start: r6(span.start), dur: length });
    else {
      // chained so every piece starts exactly where the previous one ends
      let t = 0;
      while (length - t >= MIN_DUR - EPS) {
        const dur = r6(Math.min(unit, length - t));
        pieces.push({ start: r6(span.start + t), dur });
        t = r6(t + dur);
      }
    }
    if (!pieces.length) return 'There is nothing on the timeline to put music under.';
    const gain = Math.round(Math.pow(10, bed.gainDb / 20) * 1e6) / 1e6;
    const items: AudioItem[] = pieces.map((pc, k) =>
      audioItemSchema.parse({
        type: 'audio',
        id: `${BRAND_ITEM_IDS.musicPrefix}${k}`,
        name: k === 0 ? 'Brand music' : `Brand music (loop ${k + 1})`,
        startSec: pc.start,
        durationSec: pc.dur,
        assetId: pid,
        volume: { v: gain, kf: [] },
        fadeInSec: k === 0 ? Math.min(bed.fadeInSec, pc.dur) : 0,
        fadeOutSec: k === pieces.length - 1 ? Math.min(bed.fadeOutSec, pc.dur) : 0,
      }),
    );
    const track: Track = trackSchema.parse({
      id: BRAND_TRACK_IDS.music,
      kind: 'audio',
      name: 'Brand music',
      ducking: { enabled: bed.duckEnabled, reductionDb: bed.duckAmountDb },
      items,
    });
    const at = p.tracks.findIndex((t) => t.id === BRAND_TRACK_IDS.music);
    if (at >= 0) {
      const prev = p.tracks[at] as Track;
      p = {
        ...p,
        tracks: p.tracks.map((t, i) =>
          i === at
            ? {
                ...track,
                locked: prev.locked,
                muted: prev.muted,
                hidden: prev.hidden,
                gain: prev.gain,
              }
            : t,
        ),
      };
    } else p = { ...p, tracks: [...p.tracks, track] };
    // ducking follows speech: make sure the video tracks count as speech
    p = mapTracks(p, (t) => (t.kind === 'video' && !t.speech ? { ...t, speech: true } : t));
    details.music = `Music bed ${pieces.length > 1 ? `looped ${pieces.length}×` : 'trimmed'} over ${fmtSec(length)}${bed.duckEnabled ? `, ducking ${Math.round(bed.duckAmountDb)} dB under speech` : ''}.`;
    return p;
  };

  const handlers: Record<BrandPart, (p: Project) => PartResult> = {
    intro: applyIntro,
    outro: applyOutro,
    watermark: applyWatermark,
    subtitles: applySubtitles,
    hook: applyHook,
    music: applyMusic,
  };

  let current = original;
  const applied: BrandPart[] = [];
  const skipped: { part: BrandPart; reason: string }[] = [];
  for (const part of ORDER) {
    if (!wanted.has(part)) continue;
    let r: PartResult;
    try {
      r = handlers[part](current);
    } catch (e) {
      r = `Could not apply this part (${e instanceof Error ? e.message : 'unexpected error'}).`;
    }
    if (typeof r === 'string') {
      skipped.push({ part, reason: r });
      delete details[part];
      continue;
    }
    const issue = projectIssue(r);
    if (issue) {
      skipped.push({ part, reason: `It would break the timeline layout (${issue}).` });
      delete details[part];
      continue;
    }
    current = r;
    applied.push(part);
  }

  const done = (project: Project): ApplyBrandResult => ({
    project,
    applied: BRAND_PARTS.filter((x) => applied.includes(x)),
    skipped: BRAND_PARTS.flatMap((x) => skipped.filter((s) => s.part === x)),
    details,
  });
  if (!applied.length) return done(original);

  // drop brand assets whose only users were pieces this call replaced
  const used = new Set(allItems(current).flatMap((i) => ('assetId' in i ? [i.assetId] : [])));
  const drop = [...orphanCandidates].filter((id) => id.startsWith('ba_') && !used.has(id));
  const out: Project = {
    ...current,
    assets: current.assets.filter((a) => !drop.includes(a.id)),
    brandKitId: kit.id,
  };
  if (JSON.stringify(out) === JSON.stringify(original)) return done(original);
  const check = projectSchema.safeParse(out);
  if (!check.success) {
    return {
      project: original,
      applied: [],
      skipped: BRAND_PARTS.filter((x) => wanted.has(x)).map((part) => ({
        part,
        reason: 'The result did not pass validation, so nothing was changed.',
      })),
      details: {},
    };
  }
  return done(out);
}
