/** Canvas2D helpers + the LRU cache of rasterised text / subtitle textures. */
import type { TextItem } from '@shared/editor';
import { cssFont, resolveEditorFace } from './fonts';
import type { TextLayout } from './text-layout';

export type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createRasterCanvas(w: number, h: number): RasterCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: RasterCanvas): Ctx2D {
  const ctx = c.getContext('2d', { willReadFrequently: false }) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  const v = m ? parseInt(m[1] as string, 16) : 0xffffff;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.min(1, Math.max(0, alpha))})`;
}

export function roundRectPath(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rr < 0.01) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

let nextId = 1;
export interface Raster {
  id: number;
  canvas: RasterCanvas;
  /** Pixel size of `canvas`. */
  pxW: number;
  pxH: number;
  /** Size the texture covers in CANVAS px (= px / scale), centred on the item's natural rect. */
  drawW: number;
  drawH: number;
}

export function newRaster(drawW: number, drawH: number, scale: number): Raster {
  const pxW = Math.max(1, Math.ceil(drawW * scale));
  const pxH = Math.max(1, Math.ceil(drawH * scale));
  return {
    id: nextId++,
    canvas: createRasterCanvas(pxW, pxH),
    pxW,
    pxH,
    drawW: pxW / scale,
    drawH: pxH / scale,
  };
}

/** Small LRU keyed by string; `onEvict` lets the GL side drop the texture of a dropped raster. */
export class RasterCache {
  private map = new Map<string, Raster>();
  constructor(
    private max: number,
    private onEvict: (r: Raster) => void,
  ) {}
  get(key: string): Raster | undefined {
    const r = this.map.get(key);
    if (r) {
      this.map.delete(key);
      this.map.set(key, r);
    }
    return r;
  }
  set(key: string, r: Raster): void {
    this.map.set(key, r);
    while (this.map.size > this.max) {
      const k = this.map.keys().next().value as string;
      const old = this.map.get(k) as Raster;
      this.map.delete(k);
      this.onEvict(old);
    }
  }
  clear(): void {
    for (const r of this.map.values()) this.onEvict(r);
    this.map.clear();
  }
}

/** Unit-less ascent / descent (em) of the face the style resolves to (fallback metrics for unknown fonts). */
export function faceMetrics(family: string, weight: number): { ascent: number; descent: number } {
  const f = resolveEditorFace(family, weight);
  return f ? { ascent: f.ascent, descent: f.descent } : { ascent: 0.93, descent: 0.24 };
}

/** Extra canvas px around the natural block that stroke + shadow can paint into. */
export function textMargin(item: TextItem): number {
  const s = item.style;
  let m = 2;
  if (s.stroke) m += s.stroke.width;
  if (s.shadow)
    m += Math.max(Math.abs(s.shadow.offsetX), Math.abs(s.shadow.offsetY)) + s.shadow.blur * 1.5;
  return Math.ceil(m);
}

/**
 * Rasterises a text item (box, stroke, fill, shadow) at `scale` device px per canvas px. `nVisible` = code points to
 * show (typewriter); layout is always the full text so nothing reflows.
 */
export function rasterizeText(
  item: TextItem,
  layout: TextLayout,
  nVisible: number,
  scale: number,
): Raster {
  const s = item.style;
  const m = textMargin(item);
  const r = newRaster(layout.width + 2 * m, layout.height + 2 * m, scale);
  const ctx = ctx2d(r.canvas);
  ctx.clearRect(0, 0, r.pxW, r.pxH);
  ctx.save();
  ctx.scale(r.pxW / r.drawW, r.pxH / r.drawH);
  ctx.translate(r.drawW / 2, r.drawH / 2);

  if (s.box) {
    ctx.fillStyle = rgba(s.box.color, s.box.opacity);
    roundRectPath(
      ctx,
      -layout.width / 2,
      -layout.height / 2,
      layout.width,
      layout.height,
      s.box.radius,
    );
    ctx.fill();
  }

  // glyph mask (stroke + fill, opaque colours) — drawn once, optionally shadowed
  const mask = createRasterCanvas(r.pxW, r.pxH);
  const mctx = ctx2d(mask);
  mctx.scale(r.pxW / r.drawW, r.pxH / r.drawH);
  mctx.translate(r.drawW / 2, r.drawH / 2);
  const { font } = cssFont(s.fontFamily, s.weight, s.italic, s.size);
  mctx.font = font;
  mctx.textBaseline = 'alphabetic';
  mctx.textAlign = 'left';
  if ('letterSpacing' in mctx)
    (mctx as CanvasRenderingContext2D).letterSpacing = `${s.letterSpacing}px`;
  mctx.lineJoin = 'round';
  mctx.miterLimit = 2;
  const { ascent, descent } = faceMetrics(s.fontFamily, s.weight);
  const top = -layout.contentHeight / 2;
  layout.lines.forEach((line, i) => {
    const shownCount = Math.max(0, Math.min(line.end - line.start, nVisible - line.start));
    if (shownCount <= 0) return;
    const shown =
      shownCount >= line.end - line.start
        ? line.text
        : Array.from(line.text).slice(0, shownCount).join('');
    const x0 =
      s.align === 'left'
        ? -layout.contentWidth / 2
        : s.align === 'right'
          ? layout.contentWidth / 2 - line.width
          : -line.width / 2;
    const baseline = top + (i + 0.5) * layout.pitch + ((ascent - descent) / 2) * s.size;
    if (s.stroke && s.stroke.width > 0) {
      mctx.strokeStyle = s.stroke.color;
      mctx.lineWidth = s.stroke.width * 2;
      mctx.strokeText(shown, x0, baseline);
    }
    mctx.fillStyle = s.color;
    mctx.fillText(shown, x0, baseline);
  });

  ctx.restore();
  if (s.shadow && s.shadow.opacity > 0) {
    // draw only the shadow: the mask is placed far off-canvas and its shadow offset brings the shadow back
    const far = r.pxW + 4 * (s.shadow.blur + Math.abs(s.shadow.offsetX)) * scale + 64;
    ctx.save();
    ctx.shadowColor = rgba(s.shadow.color, s.shadow.opacity);
    ctx.shadowBlur = s.shadow.blur * scale;
    ctx.shadowOffsetX = far + s.shadow.offsetX * scale;
    ctx.shadowOffsetY = s.shadow.offsetY * scale;
    ctx.drawImage(mask as CanvasImageSource, -far, 0);
    ctx.restore();
  }
  ctx.drawImage(mask as CanvasImageSource, 0, 0);
  return r;
}
