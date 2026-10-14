/**
 * Browser-side harness for test/e2e/editor-compositor.spec.ts. Bundled by esbuild into an IIFE and injected into a blank
 * page: exposes `window.CMP` with synthetic deterministic media, a test FrameSource and render/readback helpers.
 */
import type { Asset, Project } from '../../../shared/editor';
import {
  createCompositor,
  ensureEditorFonts,
  measureTextItem,
  parseCube,
  type EditorCompositor,
  type FrameRequest,
  type FrameSource,
} from '../../../renderer/lib/editor/compositor';
import { computeDrag } from '../../../renderer/lib/editor/compositor';

export interface MediaSpec {
  id: string;
  kind: 'flat' | 'hgrad' | 'vgrad' | 'chart' | 'checker' | 'quad' | 'alpha-disc';
  w: number;
  h: number;
  /** flat colour / hgrad end colour (0..255). */
  rgb?: [number, number, number];
}

function paint(spec: MediaSpec): OffscreenCanvas {
  const c = new OffscreenCanvas(spec.w, spec.h);
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const img = ctx.createImageData(spec.w, spec.h);
  const d = img.data;
  const [r0, g0, b0] = spec.rgb ?? [255, 255, 255];
  for (let y = 0; y < spec.h; y++)
    for (let x = 0; x < spec.w; x++) {
      const i = (y * spec.w + x) * 4;
      let r = r0;
      let g = g0;
      let b = b0;
      let a = 255;
      switch (spec.kind) {
        case 'flat':
          break;
        case 'hgrad': {
          // red = x position (0..255), green = 64 constant, blue = 128 constant
          r = Math.round(((x + 0.5) / spec.w) * 255);
          g = 64;
          b = 128;
          break;
        }
        case 'vgrad':
          r = 40;
          g = Math.round(((y + 0.5) / spec.h) * 255);
          b = 200;
          break;
        case 'chart': {
          // 16×16 patches, every patch a different, deterministic colour; patch = (spec.w/16)
          const px = Math.floor((x * 16) / spec.w);
          const py = Math.floor((y * 16) / spec.h);
          const n = py * 16 + px;
          r = (px * 17) & 255;
          g = (py * 17) & 255;
          b = (n * 37 + 11) & 255;
          break;
        }
        case 'checker': {
          const on = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;
          r = on ? 255 : 0;
          g = on ? 255 : 0;
          b = on ? 255 : 0;
          break;
        }
        case 'quad': {
          // four distinct quadrants to verify orientation and mirroring
          const left = x < spec.w / 2;
          const top = y < spec.h / 2;
          [r, g, b] = top ? (left ? [255, 0, 0] : [0, 255, 0]) : left ? [0, 0, 255] : [255, 255, 0];
          break;
        }
        case 'alpha-disc': {
          const dx = x + 0.5 - spec.w / 2;
          const dy = y + 0.5 - spec.h / 2;
          a = Math.hypot(dx, dy) < spec.w / 2 - 1 ? 255 : 0;
          break;
        }
      }
      d[i] = a ? r : 0;
      d[i + 1] = a ? g : 0;
      d[i + 2] = a ? b : 0;
      d[i + 3] = a;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

const bitmaps = new Map<string, CanvasImageSource>();
const luts = new Map<string, { size: number; data: Float32Array }>();
const frameLog: { assetId: string; srcSec: number }[] = [];
let comp: EditorCompositor | null = null;
let canvas: HTMLCanvasElement | null = null;

const frames: FrameSource = {
  video(assetId, srcSec) {
    frameLog.push({ assetId, srcSec });
    return bitmaps.get(assetId) ?? null;
  },
  image(assetId) {
    return bitmaps.get(assetId) ?? null;
  },
  lut(assetId) {
    return luts.get(assetId) ?? null;
  },
};

function b64(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

const api = {
  async init(fontBase: string): Promise<{ renderer: string }> {
    await ensureEditorFonts({ baseUrl: fontBase });
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    comp = createCompositor(canvas);
    return { renderer: 'ok' };
  },
  async media(specs: MediaSpec[]): Promise<void> {
    for (const s of specs) {
      (bitmaps.get(s.id) as ImageBitmap | undefined)?.close?.();
      bitmaps.set(s.id, await createImageBitmap(paint(s), { premultiplyAlpha: 'premultiply' }));
    }
  },
  /** A MUTABLE source (HTMLCanvasElement): the compositor must re-upload it every frame. */
  liveCanvas(id: string, w: number, h: number, rgb: [number, number, number]): void {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    bitmaps.set(id, c);
    api.repaint(id, rgb);
  },
  repaint(id: string, rgb: [number, number, number]): void {
    const c = bitmaps.get(id) as HTMLCanvasElement;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(0, 0, c.width, c.height);
  },
  cube(id: string, text: string): void {
    luts.set(id, parseCube(text));
  },
  /** Renders and returns RGBA bytes (base64) at preview width `pw`. */
  render(project: Project, t: number, pw: number) {
    const c = comp as EditorCompositor;
    c.setProject(project);
    const ph = Math.round((pw * project.canvas.height) / project.canvas.width);
    c.resize(pw, ph);
    frameLog.length = 0;
    const stats = c.render(t, frames);
    const px = c.readPixels();
    return {
      w: px.width,
      h: px.height,
      b64: b64(px.data),
      drawCalls: stats.drawCalls,
      ms: stats.ms,
      missing: stats.missingFrames,
      uploads: c.uploadCount,
      frameLog: [...frameLog],
    };
  },
  framesNeeded(project: Project, t: number): FrameRequest[] {
    const c = comp as EditorCompositor;
    c.setProject(project);
    return c.framesNeeded(t);
  },
  hit(project: Project, t: number, pw: number, x: number, y: number): string | null {
    const c = comp as EditorCompositor;
    c.setProject(project);
    c.resize(pw, Math.round((pw * project.canvas.height) / project.canvas.width));
    return c.hitTest(t, x, y);
  },
  handles(project: Project, t: number, pw: number, id: string) {
    const c = comp as EditorCompositor;
    c.setProject(project);
    c.resize(pw, Math.round((pw * project.canvas.height) / project.canvas.width));
    return c.handlesFor(t, id);
  },
  /** Average ms per render over `n` frames (GPU work forced to finish by a readback). */
  bench(project: Project, t: number, pw: number, n: number) {
    const c = comp as EditorCompositor;
    c.setProject(project);
    const ph = Math.round((pw * project.canvas.height) / project.canvas.width);
    c.resize(pw, ph);
    c.render(t, frames);
    c.readPixels();
    const u0 = c.uploadCount;
    const t0 = performance.now();
    let cpu = 0;
    for (let i = 0; i < n; i++) cpu += c.render(t, frames).ms;
    c.readPixels();
    const total = performance.now() - t0;
    return { perFrameMs: total / n, cpuMs: cpu / n, uploadsDuring: c.uploadCount - u0 };
  },
  measure(item: Parameters<typeof measureTextItem>[0], w: number) {
    return measureTextItem(item, w);
  },
  drag: computeDrag,
  /** Contact sheet: `frames` are base64 RGBA images; returns a PNG data URL. */
  sheet(
    imgs: { w: number; h: number; b64: string; label: string }[],
    cols: number,
    gap: number,
  ): string {
    const cw = Math.max(...imgs.map((i) => i.w));
    const ch = Math.max(...imgs.map((i) => i.h));
    const rows = Math.ceil(imgs.length / cols);
    const c = new OffscreenCanvas(cols * (cw + gap) + gap, rows * (ch + gap + 14) + gap);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = '#444';
    ctx.fillRect(0, 0, c.width, c.height);
    imgs.forEach((im, i) => {
      const bin = atob(im.b64);
      const u8 = new Uint8ClampedArray(bin.length);
      for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
      const x = gap + (i % cols) * (cw + gap);
      const y = gap + Math.floor(i / cols) * (ch + gap + 14);
      ctx.putImageData(new ImageData(u8, im.w, im.h), x, y + 14);
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.fillText(im.label, x, y + 10);
    });
    // OffscreenCanvas has no toDataURL: go through a regular canvas
    const out = document.createElement('canvas');
    out.width = c.width;
    out.height = c.height;
    (out.getContext('2d') as CanvasRenderingContext2D).drawImage(c, 0, 0);
    return out.toDataURL('image/png');
  },
};

export type CmpApi = typeof api;
(window as unknown as { CMP: CmpApi }).CMP = api;
export type { Asset };
