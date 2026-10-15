/** `createCompositor`: ties the pure scene (scene.ts) to the GL executor (gl-renderer.ts). */
import type { CaptionStyle } from '@shared/cp2';
import type { Asset, Item, Project, TextItem } from '@shared/editor';
import { findItem, isActive } from '@shared/editor-eval';
import type {
  Compositor,
  CompositorExports,
  FrameRequest,
  FrameSource,
  RenderStats,
  TransformHandles,
} from './api';
import { resolveCaptionStyle } from './caption-presets';
import { computeDrag } from './drag';
import {
  editorFontsEpoch,
  editorFontsReady,
  ensureEditorFonts,
  onEditorFontsLoaded,
} from './fonts';
import { geomContains, geomCorners, rotationHandlePoint } from './geometry';
import { GlRenderer } from './gl-renderer';
import { parseCube } from './cube';
import { RasterCache, rasterizeText, type Raster } from './raster';
import {
  buildScene,
  framesNeededAt,
  interactionLayers,
  makeLayer,
  type SceneEnv,
  type SceneLayer,
} from './scene';
import { buildBlock, capMeasure, captionGeometry, prepareSubtitleWords } from './subtitle';
import { clearMeasureCache, currentMeasurer, layoutTextItem } from './text-layout';

export interface EditorCompositor extends Compositor {
  /** Custom caption presets (built-ins are always known). Call when the user's preset list changes. */
  setCaptionStyles(styles: readonly CaptionStyle[]): void;
  /** Texture uploads performed so far (static layers must not add to it between frames). */
  readonly uploadCount: number;
  /** True when the WebGL context was lost (the host should recreate the compositor). */
  readonly contextLost: boolean;
}

export interface CompositorOptions {
  project?: Project;
  powerPreference?: 'low-power' | 'high-performance';
}

const textKeyCache = new WeakMap<TextItem, string>();
function textBaseKey(item: TextItem): string {
  let k = textKeyCache.get(item);
  if (!k) {
    k = JSON.stringify([item.text, item.style]);
    textKeyCache.set(item, k);
  }
  return k;
}

const EMPTY_PROJECT = {
  version: 1,
  canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' },
  tracks: [],
  assets: [],
  brandKitId: null,
  markers: [],
  origin: { clipId: null, videoId: null },
} as Project;

export function createCompositor(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  opts: CompositorOptions = {},
): EditorCompositor {
  const renderer = new GlRenderer(canvas, opts.powerPreference);
  let project: Project = opts.project ?? EMPTY_PROJECT;
  let assets = new Map<string, Asset>();
  let captionStyles: readonly CaptionStyle[] = [];
  const rasters = new RasterCache(96, (r) => renderer.dropRaster(r.id));
  let fontsEpochSeen = editorFontsEpoch();

  const indexAssets = (): void => {
    assets = new Map(project.assets.map((a) => [a.id, a]));
  };
  indexAssets();

  const unsub = onEditorFontsLoaded(() => {
    clearMeasureCache();
    rasters.clear();
  });

  const scale = (): number => Math.max(1e-6, canvas.width / project.canvas.width);

  const env = (applyOps = true, frames?: FrameSource): SceneEnv => ({
    project,
    assets,
    captionStyles,
    applyOps,
    frameSize: frames
      ? (item) => {
          const src =
            item.type === 'video' ? frames.video(item.assetId, 0) : frames.image(item.assetId);
          if (!src) return null;
          const s = src as unknown as {
            width?: number;
            height?: number;
            videoWidth?: number;
            videoHeight?: number;
            naturalWidth?: number;
            naturalHeight?: number;
          };
          const w = s.videoWidth ?? s.naturalWidth ?? s.width ?? 0;
          const h = s.videoHeight ?? s.naturalHeight ?? s.height ?? 0;
          return w > 0 && h > 0 ? { w, h } : null;
        }
      : undefined,
  });

  const rasterFor = (layer: SceneLayer): Raster | null => {
    const k = scale();
    const c = layer.content;
    const sq = Math.round(k * 1000);
    const ep = editorFontsEpoch();
    if (c.kind === 'text') {
      const item = layer.item as TextItem;
      const key = `t|${ep}|${sq}|${project.canvas.width}|${c.nVisible === Infinity ? 'all' : c.nVisible}|${textBaseKey(item)}`;
      let r = rasters.get(key);
      if (!r) {
        r = rasterizeText(item, c.layout, c.nVisible, k);
        rasters.set(key, r);
      }
      return r;
    }
    if (c.kind === 'subtitle') {
      const key = `s|${ep}|${sq}|${c.frame.key}`;
      let r = rasters.get(key);
      if (!r) {
        r = c.frame.paint(k);
        rasters.set(key, r);
      }
      return r;
    }
    return null;
  };

  const comp: EditorCompositor = {
    setProject(p) {
      project = p;
      indexAssets();
      const ids = new Set<string>();
      for (const tr of p.tracks) for (const it of tr.items) ids.add(it.id);
      renderer.pruneSlots((key) => ids.has(key.slice(key.indexOf(':') + 1)));
    },
    setCaptionStyles(styles) {
      captionStyles = styles;
    },
    resize(w, h) {
      const W = Math.max(1, Math.round(w));
      const H = Math.max(1, Math.round(h));
      if (
        canvas.width === W &&
        canvas.height === H &&
        renderer.size.w === W &&
        renderer.size.h === H
      )
        return;
      canvas.width = W;
      canvas.height = H;
      renderer.resize(W, H);
      rasters.clear(); // text / subtitle textures are rasterised at the preview scale
    },
    framesNeeded(t): FrameRequest[] {
      return framesNeededAt(project, assets, t);
    },
    render(t, frames): RenderStats {
      if (renderer.contextLost) return { drawCalls: 0, missingFrames: [], ms: 0 };
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!editorFontsReady()) void ensureEditorFonts();
      if (fontsEpochSeen !== editorFontsEpoch()) fontsEpochSeen = editorFontsEpoch();
      if (renderer.gl.drawingBufferWidth !== canvas.width)
        renderer.resize(canvas.width, canvas.height);
      const missing: FrameRequest[] = [];
      const groups = buildScene(env(true, frames), t);
      renderer.render(groups, {
        project,
        assets,
        frames,
        scale: scale(),
        raster: rasterFor,
        missing,
      });
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return { drawCalls: renderer.drawCalls, missingFrames: missing, ms: t1 - t0 };
    },
    hitTest(t, xPx, yPx) {
      const k = scale();
      const x = xPx / k;
      const y = yPx / k;
      for (const l of interactionLayers(env(false), t)) {
        if (l.opacity <= 0.001) continue;
        if (geomContains(l.geom, x, y)) return l.item.id;
      }
      return null;
    },
    handlesFor(t, itemId): TransformHandles | null {
      const found = findItem(project, itemId);
      if (!found || found.item.type === 'audio') return null;
      if (found.track.hidden || !isActive(found.item, t)) return null;
      const layer = makeLayer(found.item, found.track.id, t, env(false));
      if (!layer) return null;
      const k = scale();
      return {
        corners: geomCorners(layer.geom, k),
        center: { x: layer.geom.cx * k, y: layer.geom.cy * k },
        rotationHandle: rotationHandlePoint(layer.geom, k),
        rotation: layer.geom.rot,
      };
    },
    readPixels() {
      return renderer.readPixels();
    },
    dispose() {
      unsub();
      rasters.clear();
      renderer.dispose();
    },
    get uploadCount() {
      return renderer.uploads;
    },
    get contextLost() {
      return renderer.contextLost;
    },
  };
  if (canvas.width > 0 && canvas.height > 0) renderer.resize(canvas.width, canvas.height);
  return comp;
}

/** Pure text measuring shared with hit-testing (api.ts `measureTextItem`). */
export function measureTextItem(
  item: Item,
  canvasW: number,
): { width: number; height: number; lines: string[] } {
  if (item.type === 'text') {
    const l = layoutTextItem(item, canvasW);
    return { width: l.width, height: l.height, lines: l.lines.map((x) => x.text) };
  }
  if (item.type === 'subtitle') {
    const H = Math.round((canvasW * 16) / 9);
    const style = resolveCaptionStyle(item.styleId, item.styleOverride);
    const words = prepareSubtitleWords(item);
    if (words.length === 0) return { width: 0, height: 0, lines: [] };
    const blk = buildBlock(
      words,
      style,
      captionGeometry(style, canvasW, H),
      capMeasure(style, currentMeasurer()),
    );
    return {
      width: blk.maxW,
      height: blk.lines.length * blk.pitch,
      lines: blk.lines.map((l) => l.map((w) => w.text).join(' ')),
    };
  }
  return { width: 0, height: 0, lines: [] };
}

export const compositorExports: CompositorExports = {
  createCompositor,
  computeDrag,
  measureTextItem,
  parseCube,
};
