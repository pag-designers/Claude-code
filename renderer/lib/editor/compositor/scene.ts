/**
 * The PURE half of the compositor: turns (project, t) into a list of draw groups with fully resolved geometry, colour,
 * opacity, blur and blend — using nothing but `shared/editor-eval`. No DOM / GL, so hit-testing, handles, framesNeeded
 * and the parity-relevant rules can be unit-tested in node. `gl-renderer.ts` only executes what this produces.
 *
 * Semantics implemented here (mirror in the FFmpeg compiler):
 *  - tracks bottom → top in project order, hidden tracks skipped, audio items ignored;
 *  - per track `activeOnTrack`; during a transition the group is [from, to] + veil (see `transitionOps`);
 *  - item geometry: `naturalLayout(fit, resolveCrop, sourceDims, canvas)` → rect; `resolveTransform` → translate /
 *    uniform scale / rotate about the rect centre; then the transition op: scale about the CANVAS centre by `ops.scale`,
 *    then translate by (dx·W, dy·H); blur σ = ops.blur × min(W,H) px;
 *  - opacity = transform opacity × fades × ops.opacity (× text-animation opacity);
 *  - source dims for the layout are the ASSET's width/height (so 'native' fit is exact whatever proxy resolution the
 *    frame has); only when the asset has none the frame's own size is used.
 */
import type { CaptionStyle } from '@shared/cp2';
import type {
  Asset,
  BlendMode,
  Item,
  Project,
  ShapeItem,
  SubtitleItem,
  TextItem,
  Track,
  VideoItem,
  ImageItem,
} from '@shared/editor';
import {
  activeOnTrack,
  animatedAt,
  isNeutralColor,
  makeSourceTime,
  naturalLayout,
  progressFraction,
  resolveColor,
  resolveCrop,
  resolveTransform,
  textAnimAt,
  transitionOps,
  visibleChars,
  type EffectiveColor,
  type LayerOps,
} from '@shared/editor-eval';
import type { FrameRequest } from './api';
import { resolveCaptionStyle } from './caption-presets';
import type { Geom } from './geometry';
import {
  buildBlock,
  capMeasure,
  captionGeometry,
  prepareSubtitleWords,
  subtitleFrame,
  type CapBlock,
  type PreparedWord,
  type SubFrame,
} from './subtitle';
import { editorFontsEpoch } from './fonts';
import { textMargin } from './raster';
import { currentMeasurer, layoutTextItem, type TextLayout } from './text-layout';

/** Background-blur fill sigma as a fraction of the canvas short side (mirror in the exporter). */
export const BACKGROUND_BLUR_SIGMA = 0.04;

export interface UvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayerContent =
  | {
      kind: 'media';
      assetId: string;
      mediaType: 'video' | 'image';
      /** SOURCE time asked of the FrameSource (video only). */
      srcSec: number;
      /** Normalised source rect sampled. */
      uv: UvRect;
      mirror: boolean;
      color: EffectiveColor | null;
      /** Paint a blurred cover copy underneath (fit 'contain' + backgroundBlur). */
      bg: { uv: UvRect; sigma: number } | null;
    }
  | { kind: 'text'; layout: TextLayout; nVisible: number; margin: number }
  | { kind: 'subtitle'; frame: SubFrame; styleKey: string }
  | {
      kind: 'shape';
      shape: ShapeItem['shape'];
      w: number;
      h: number;
      fill: string;
      fillOpacity: number;
      stroke: { color: string; width: number } | null;
      radius: number;
      progress: number;
    };

export interface SceneLayer {
  item: Item;
  trackId: string;
  /** Local item time. */
  tl: number;
  /** The item's natural rect after transform + ops (selection geometry), canvas px. */
  geom: Geom;
  /** The rect that is actually drawn (text / subtitle textures extend past the natural rect). */
  quad: Geom;
  /** Total scale applied to the natural size (transform scale × text animation × ops.scale). */
  scaleK: number;
  opacity: number;
  /** Gaussian sigma, canvas px. */
  blurSigma: number;
  blend: BlendMode;
  content: LayerContent;
}

export interface SceneGroup {
  trackId: string;
  layers: SceneLayer[];
  veil: { color: string; alpha: number } | null;
  /** Blend used to composite the group onto what is below. */
  blend: BlendMode;
  transition: { type: string; progress: number } | null;
}

export interface SceneEnv {
  project: Project;
  assets: Map<string, Asset>;
  captionStyles: readonly CaptionStyle[];
  /** Size of the actual frame when the asset has no dimensions. */
  frameSize?: (item: VideoItem | ImageItem) => { w: number; h: number } | null;
  /** false = leave transition ops out of the geometry (hit-testing / handles). */
  applyOps?: boolean;
}

export const visualType = (
  it: Item,
): it is VideoItem | ImageItem | TextItem | SubtitleItem | ShapeItem => it.type !== 'audio';

const sourceTimeCache = new WeakMap<object, (tl: number) => number>();
export function sourceTimeFn(item: VideoItem): (tl: number) => number {
  let f = sourceTimeCache.get(item);
  if (!f) {
    f = makeSourceTime(item);
    sourceTimeCache.set(item, f);
  }
  return f;
}

/** SOURCE time shown at timeline time t, clamped to the asset. */
export function videoSrcSec(item: VideoItem, asset: Asset | undefined, t: number): number {
  const tl = Math.max(0, t - item.startSec);
  const s = sourceTimeFn(item)(tl);
  const dur = asset?.durationSec;
  return Math.max(0, dur !== null && dur !== undefined && dur > 0 ? Math.min(s, dur) : s);
}

/** Which video frames the host must have ready for t (2 per track during a transition). */
export function framesNeededAt(
  project: Project,
  assets: Map<string, Asset>,
  t: number,
): FrameRequest[] {
  const out: FrameRequest[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const it of activeOnTrack(track, t).items) {
      if (it.type !== 'video') continue;
      out.push({
        assetId: it.assetId,
        srcSec: videoSrcSec(it, assets.get(it.assetId), t),
        itemId: it.id,
      });
    }
  }
  return out;
}

const IDENTITY_OPS: LayerOps = { opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0 };

function styleKeyOf(item: SubtitleItem, style: CaptionStyle, W: number, H: number): string {
  return JSON.stringify([item.id, item.words, style, W, H]);
}
const subKeyCache = new WeakMap<
  SubtitleItem,
  { style: CaptionStyle; W: number; H: number; key: string }
>();
function subtitleKey(item: SubtitleItem, style: CaptionStyle, W: number, H: number): string {
  const c = subKeyCache.get(item);
  if (c && c.style === style && c.W === W && c.H === H) return c.key;
  const key = styleKeyOf(item, style, W, H);
  subKeyCache.set(item, { style, W, H, key });
  return key;
}

const subWordsCache = new WeakMap<SubtitleItem, ReturnType<typeof prepareSubtitleWords>>();

/** Text layout / caption block are time-independent: computed once per (item, canvas, fonts) and reused every frame. */
const textLayoutCache = new WeakMap<
  TextItem,
  { W: number; ep: number; m: unknown; layout: TextLayout }
>();
function cachedTextLayout(item: TextItem, W: number): TextLayout {
  const ep = editorFontsEpoch();
  const m = currentMeasurer();
  const c = textLayoutCache.get(item);
  if (c && c.W === W && c.ep === ep && c.m === m) return c.layout;
  const layout = layoutTextItem(item, W);
  textLayoutCache.set(item, { W, ep, m, layout });
  return layout;
}
const blockCache = new WeakMap<
  SubtitleItem,
  { style: CaptionStyle; W: number; H: number; ep: number; m: unknown; block: CapBlock }
>();
function cachedBlock(
  item: SubtitleItem,
  style: CaptionStyle,
  words: PreparedWord[],
  W: number,
  H: number,
): CapBlock {
  const ep = editorFontsEpoch();
  const m = currentMeasurer();
  const c = blockCache.get(item);
  if (c && c.style === style && c.W === W && c.H === H && c.ep === ep && c.m === m) return c.block;
  const block = buildBlock(words, style, captionGeometry(style, W, H), capMeasure(style, m));
  blockCache.set(item, { style, W, H, ep, m, block });
  return block;
}

/** Builds one layer (without transition ops applied) or null when the item draws nothing. */
export function makeLayer(
  item: Item,
  trackId: string,
  t: number,
  env: SceneEnv,
  ops: LayerOps = IDENTITY_OPS,
): SceneLayer | null {
  const W = env.project.canvas.width;
  const H = env.project.canvas.height;
  const tl = Math.max(0, t - item.startSec);

  let layer: Omit<SceneLayer, 'geom' | 'quad' | 'scaleK' | 'opacity' | 'blurSigma' | 'blend'> & {
    cx: number;
    cy: number;
    rot: number;
    natW: number;
    natH: number;
    quadW: number;
    quadH: number;
    quadDx: number;
    quadDy: number;
    scaleK: number;
    opacity: number;
    blend: BlendMode;
    /** The item's own blur sigma (canvas px). */
    blurPx: number;
  };

  switch (item.type) {
    case 'video':
    case 'image': {
      const asset = env.assets.get(item.assetId);
      if (!asset) return null;
      const fs = asset.width && asset.height ? null : (env.frameSize?.(item) ?? null);
      const sw = asset.width ?? fs?.w ?? W;
      const sh = asset.height ?? fs?.h ?? H;
      const crop = resolveCrop(item.crop, tl);
      const nat = naturalLayout(item.fit, crop, sw, sh, W, H);
      const tr = resolveTransform(item, tl);
      const eff = resolveColor(item.color, tl);
      const uv: UvRect = {
        x: nat.src.x / sw,
        y: nat.src.y / sh,
        w: nat.src.w / sw,
        h: nat.src.h / sh,
      };
      let bg: { uv: UvRect; sigma: number } | null = null;
      if (item.backgroundBlur && item.fit === 'contain') {
        const cov = naturalLayout('cover', crop, sw, sh, W, H);
        bg = {
          uv: { x: cov.src.x / sw, y: cov.src.y / sh, w: cov.src.w / sw, h: cov.src.h / sh },
          sigma: BACKGROUND_BLUR_SIGMA * Math.min(W, H),
        };
      }
      layer = {
        item,
        trackId,
        tl,
        cx: W / 2 + tr.x + (nat.dst.x + nat.dst.w / 2 - W / 2),
        cy: H / 2 + tr.y + (nat.dst.y + nat.dst.h / 2 - H / 2),
        rot: tr.rotation,
        natW: nat.dst.w,
        natH: nat.dst.h,
        quadW: nat.dst.w,
        quadH: nat.dst.h,
        quadDx: 0,
        quadDy: 0,
        scaleK: tr.scale,
        opacity: tr.opacity,
        blend: item.blend,
        blurPx: Math.max(0, animatedAt(item.blur, tl)),
        content: {
          kind: 'media',
          assetId: item.assetId,
          mediaType: item.type,
          srcSec: item.type === 'video' ? videoSrcSec(item, asset, t) : 0,
          uv,
          mirror: item.mirror,
          color: isNeutralColor(eff) ? null : eff,
          bg,
        },
      };
      break;
    }
    case 'text': {
      const layout = cachedTextLayout(item, W);
      const tr = resolveTransform(item, tl);
      const an = textAnimAt(item, tl);
      const margin = textMargin(item);
      layer = {
        item,
        trackId,
        tl,
        cx: W / 2 + tr.x + an.dx * W,
        cy: H / 2 + tr.y + an.dy * H,
        rot: tr.rotation,
        natW: layout.width,
        natH: layout.height,
        quadW: layout.width + 2 * margin,
        quadH: layout.height + 2 * margin,
        quadDx: 0,
        quadDy: 0,
        scaleK: tr.scale * an.scale,
        opacity: tr.opacity * an.opacity,
        blend: item.blend,
        blurPx: 0,
        content: {
          kind: 'text',
          layout,
          nVisible: an.visible >= 1 ? Infinity : visibleChars(item.text, an.visible),
          margin,
        },
      };
      break;
    }
    case 'shape': {
      const tr = resolveTransform(item, tl);
      layer = {
        item,
        trackId,
        tl,
        cx: W / 2 + tr.x,
        cy: H / 2 + tr.y,
        rot: tr.rotation,
        natW: item.width,
        natH: item.height,
        quadW: item.width,
        quadH: item.height,
        quadDx: 0,
        quadDy: 0,
        scaleK: tr.scale,
        opacity: tr.opacity,
        blend: item.blend,
        blurPx: 0,
        content: {
          kind: 'shape',
          shape: item.shape,
          w: item.width,
          h: item.height,
          fill: item.fill,
          fillOpacity: item.fillOpacity,
          stroke: item.stroke && item.stroke.width > 0 ? item.stroke : null,
          radius: item.radius,
          progress: item.shape === 'progress-bar' ? progressFraction(item.durationSec, tl) : 1,
        },
      };
      break;
    }
    case 'subtitle': {
      const style = resolveCaptionStyle(item.styleId, item.styleOverride, env.captionStyles);
      let words = subWordsCache.get(item);
      if (!words) {
        words = prepareSubtitleWords(item);
        subWordsCache.set(item, words);
      }
      if (words.length === 0) return null;
      const block = cachedBlock(item, style, words, W, H);
      const key = subtitleKey(item, style, W, H);
      const frame = subtitleFrame(item, style, words, block, tl, key);
      const b = frame.bounds;
      layer = {
        item,
        trackId,
        tl,
        cx: b.cx,
        cy: b.cy + frame.dy,
        rot: 0,
        natW: b.hw * 2,
        natH: b.hh * 2,
        quadW: frame.drawW,
        quadH: frame.drawH,
        quadDx: W / 2 - b.cx,
        quadDy: frame.origin.y + frame.drawH / 2 - b.cy,
        scaleK: 1,
        opacity: frame.opacity,
        blend: 'normal',
        blurPx: 0,
        content: { kind: 'subtitle', frame, styleKey: key },
      };
      break;
    }
    default:
      return null;
  }

  // transition ops: scale about the canvas centre, then offset (fractions of canvas size)
  const apply = env.applyOps !== false;
  const o = apply ? ops : IDENTITY_OPS;
  const s = o.scale;
  const cx = W / 2 + (layer.cx - W / 2) * s + o.dx * W;
  const cy = H / 2 + (layer.cy - H / 2) * s + o.dy * H;
  const scaleK = layer.scaleK * s;
  const geom: Geom = {
    cx,
    cy,
    hw: (layer.natW / 2) * scaleK,
    hh: (layer.natH / 2) * scaleK,
    rot: layer.rot,
  };
  // the drawn rect keeps its offset from the natural rect (rotated with the item)
  const qd = { x: layer.quadDx * scaleK, y: layer.quadDy * scaleK };
  const c = Math.cos((layer.rot * Math.PI) / 180);
  const sn = Math.sin((layer.rot * Math.PI) / 180);
  const quad: Geom = {
    cx: cx + c * qd.x - sn * qd.y,
    cy: cy + sn * qd.x + c * qd.y,
    hw: (layer.quadW / 2) * scaleK,
    hh: (layer.quadH / 2) * scaleK,
    rot: layer.rot,
  };
  return {
    item: layer.item,
    trackId,
    tl: layer.tl,
    geom,
    quad,
    scaleK,
    opacity: Math.min(1, Math.max(0, layer.opacity * o.opacity)),
    blurSigma: Math.hypot(layer.blurPx, o.blur * Math.min(W, H)),
    blend: layer.blend,
    content: layer.content,
  };
}

/** The whole frame at t as ordered draw groups (bottom → top). */
export function buildScene(env: SceneEnv, t: number): SceneGroup[] {
  const groups: SceneGroup[] = [];
  for (const track of env.project.tracks) {
    if (track.hidden) continue;
    const g = trackGroup(track, t, env);
    if (g) groups.push(g);
  }
  return groups;
}

function trackGroup(track: Track, t: number, env: SceneEnv): SceneGroup | null {
  const act = activeOnTrack(track, t);
  if (act.items.length === 0) return null;
  const tr = act.transition;
  if (!tr) {
    const it = act.items[act.items.length - 1] as Item;
    const l = makeLayer(it, track.id, t, env);
    return l
      ? { trackId: track.id, layers: [l], veil: null, blend: l.blend, transition: null }
      : null;
  }
  const ops = transitionOps(tr.type, tr.progress);
  const from = makeLayer(tr.from, track.id, t, env, ops.from);
  const to = makeLayer(tr.to, track.id, t, env, ops.to);
  const layers = [from, to].filter((l): l is SceneLayer => l !== null);
  if (layers.length === 0) return null;
  const apply = env.applyOps !== false;
  return {
    trackId: track.id,
    layers,
    veil: apply ? ops.veil : null,
    blend: (to ?? from)?.blend ?? 'normal',
    transition: { type: tr.type, progress: tr.progress },
  };
}

/* ------------------------------------------------------------------ interaction ---------------- */

/** Layers of every visible track at t, topmost first, WITHOUT transition ops (stable editing geometry). */
export function interactionLayers(env: SceneEnv, t: number): SceneLayer[] {
  const out: SceneLayer[] = [];
  for (const g of buildScene({ ...env, applyOps: false }, t)) for (const l of g.layers) out.push(l);
  return out.reverse();
}
