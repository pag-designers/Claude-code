/**
 * CPU reference compositor for the tests: renders ONE pixel of a project at timeline time T by calling the
 * shared evaluator (activeOnTrack, transitionOps, resolveTransform, resolveCrop, naturalLayout, resolveColor,
 * applyColor). Sources are procedural (flat colour / quadrants), so no media decoding is involved.
 * This is the independent oracle the export is compared with.
 */
import type { BlendMode, ImageItem, Project, VideoItem } from '../../../shared/editor';
import {
  activeOnTrack,
  applyColor,
  naturalLayout,
  resolveColor,
  resolveCrop,
  resolveTransform,
  transitionOps,
  type LayerOps,
} from '../../../shared/editor-eval';

export type RGB = [number, number, number];
/** u, v in 0..1 of the SOURCE frame → colour 0..255. */
export type Sampler = (u: number, v: number) => RGB;

export const flat =
  (hex: string): Sampler =>
  () => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export const quad: Sampler = (u, v) =>
  v < 0.5 ? (u < 0.5 ? [255, 0, 0] : [0, 255, 0]) : u < 0.5 ? [0, 0, 255] : [255, 255, 0];

export interface RefSource {
  sampler: Sampler;
  w: number;
  h: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function blendCh(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case 'multiply':
      return b * s;
    case 'screen':
      return 1 - (1 - b) * (1 - s);
    case 'overlay':
      return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'add':
      return Math.min(1, b + s);
    case 'darken':
      return Math.min(b, s);
    case 'lighten':
      return Math.max(b, s);
    default:
      return s;
  }
}

export interface RefOpts {
  /** Export size (project canvas scaled by K = outW / canvas.width). */
  outW: number;
  outH: number;
}

/** Colour (0..255) of pixel (px, py) (pixel centre) at timeline time T. */
export function refPixel(
  project: Project,
  sources: Record<string, RefSource>,
  T: number,
  px: number,
  py: number,
  o: RefOpts,
): RGB {
  const { width: cw, height: ch, background } = project.canvas;
  const K = o.outW / cw;
  const bgc: RGB = [
    parseInt(background.slice(1, 3), 16),
    parseInt(background.slice(3, 5), 16),
    parseInt(background.slice(5, 7), 16),
  ];
  let out: RGB = [...bgc];
  const X = px + 0.5;
  const Y = py + 0.5;
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    if (tr.kind !== 'video' && tr.kind !== 'overlay' && tr.kind !== 'image') continue;
    const act = activeOnTrack(tr, T);
    const ops = act.transition ? transitionOps(act.transition.type, act.transition.progress) : null;
    for (const it of act.items) {
      if (it.type !== 'video' && it.type !== 'image') continue;
      let lo: LayerOps | null = null;
      if (act.transition && ops) lo = it.id === act.transition.from.id ? ops.from : ops.to;
      const px4 = layerPixel(it, T, lo, sources, K, cw, ch, X, Y, o);
      if (!px4) continue;
      const [lr, lg, lb, a] = px4;
      if (a <= 0) continue;
      const nb: RGB = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const b = (out[c] as number) / 255;
        const s = ([lr, lg, lb][c] as number) / 255;
        const mixed = blendCh(it.blend, b, s);
        nb[c] = 255 * (b + (mixed - b) * a);
      }
      out = nb;
    }
    if (ops?.veil) {
      const vc: RGB = ops.veil.color === '#000000' ? [0, 0, 0] : [255, 255, 255];
      const a = ops.veil.alpha;
      out = out.map((v, c) => v + ((vc[c] as number) - v) * a) as RGB;
    }
  }
  return out;
}

function layerPixel(
  item: VideoItem | ImageItem,
  T: number,
  ops: LayerOps | null,
  sources: Record<string, RefSource>,
  K: number,
  cw: number,
  ch: number,
  X: number,
  Y: number,
  o: RefOpts,
): [number, number, number, number] | null {
  const src = sources[item.assetId];
  if (!src) return null;
  const tl = T - item.startSec;
  const tr = resolveTransform(item, tl);
  const sOps = ops?.scale ?? 1;
  const cx = o.outW / 2 + K * (tr.x * sOps + (ops?.dx ?? 0) * cw);
  const cy = o.outH / 2 + K * (tr.y * sOps + (ops?.dy ?? 0) * ch);
  const s = tr.scale * sOps;
  if (s <= 0) return null;
  const rc = resolveCrop(item.crop, tl);
  const nl = naturalLayout(item.fit, rc, src.w, src.h, cw, ch);
  const dw = nl.dst.w * K;
  const dh = nl.dst.h * K;
  // inverse transform: output px → natural-rect local px (rotation clockwise)
  const rad = (tr.rotation * Math.PI) / 180;
  const dx = X - cx;
  const dy = Y - cy;
  const lx = (dx * Math.cos(rad) + dy * Math.sin(rad)) / s;
  const ly = (-dx * Math.sin(rad) + dy * Math.cos(rad)) / s;
  const u = (lx + dw / 2) / dw;
  const v = (ly + dh / 2) / dh;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  const uu = item.mirror ? 1 - u : u;
  const sxp = nl.src.x + uu * nl.src.w;
  const syp = nl.src.y + v * nl.src.h;
  const rgb = src.sampler(sxp / src.w, syp / src.h);
  const e = resolveColor(item.color, tl);
  const c = applyColor([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255], e);
  let a = tr.opacity * (ops?.opacity ?? 1);
  if (a <= 0) return null;
  a = clamp01(a);
  return [c[0] * 255, c[1] * 255, c[2] * 255, a];
}
