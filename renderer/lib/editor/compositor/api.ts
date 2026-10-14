/**
 * CP3 COMPOSITOR CONTRACT (preview renderer). Owned by the lead; implemented by the `editor-compositor` agent in
 * renderer/lib/editor/compositor/*, exported from '@/lib/editor/compositor' (index). WebGL2 (fallback: Canvas2D is NOT
 * required — Chromium always has WebGL2; tests run it on SwiftShader).
 *
 * It draws ONE frame of a Project at timeline time t, synchronously, from frames the HOST supplies. It never loads or
 * seeks media itself (the playback engine does) so golden-frame tests can feed it static images and be deterministic.
 * All semantics come from '@shared/editor-eval' — never re-derive them. Canvas px in the Project = export px; the preview
 * canvas is smaller: scale = canvas.width / project.canvas.width.
 */
import type { Asset, Item, Project, Transform } from '@shared/editor';

export interface FrameSource {
  /** Drawable for a VIDEO asset at SOURCE time `srcSec` (already clamped to the asset) or null when not ready. */
  video(assetId: string, srcSec: number): CanvasImageSource | null;
  /** Drawable for an IMAGE asset. */
  image(assetId: string): CanvasImageSource | null;
  /** Parsed .cube LUT for a 'lut' asset (size³ RGB floats), or null. */
  lut(assetId: string): { size: number; data: Float32Array } | null;
}

export interface FrameRequest {
  assetId: string;
  /** SOURCE time wanted (what `FrameSource.video` will be asked for). */
  srcSec: number;
  /** Item that needs it (a transition needs two). */
  itemId: string;
}

export interface RenderStats {
  drawCalls: number;
  /** Items skipped because their frame was not ready (host may show a spinner / keep the last frame). */
  missingFrames: FrameRequest[];
  ms: number;
}

export interface Compositor {
  /** Replace the project (cheap; textures for unchanged assets are kept). */
  setProject(project: Project): void;
  /** Resize the drawing buffer in physical px (call on layout / devicePixelRatio change). */
  resize(widthPx: number, heightPx: number): void;
  /**
   * Everything visible at t: which asset frames the host must have ready (at what SOURCE times). Lets the playback
   * engine seek/prefetch before calling `render`.
   */
  framesNeeded(tSec: number): FrameRequest[];
  /** Draw the frame at tSec using `frames`. Order, blending, transitions, colour, text, shapes, subtitles per shared eval. */
  render(tSec: number, frames: FrameSource): RenderStats;
  /** Topmost visible item at preview pixel (x,y) at time t (hit-testing rotated / scaled rects), else null. Text/shape/subtitle included. */
  hitTest(tSec: number, xPx: number, yPx: number): string | null;
  /** Transform-handle geometry for an item at t, in PREVIEW px (for the overlay): corners (clockwise from top-left), centre, rotation handle. */
  handlesFor(tSec: number, itemId: string): TransformHandles | null;
  /** Read back the last rendered frame (golden tests, thumbnails). RGBA, top row first, preview size. */
  readPixels(): { width: number; height: number; data: Uint8Array };
  dispose(): void;
}

export interface TransformHandles {
  corners: [Point, Point, Point, Point];
  center: Point;
  rotationHandle: Point;
  /** Degrees (item rotation at t). */
  rotation: number;
}
export interface Point {
  x: number;
  y: number;
}

export type HandleKind = 'move' | 'scale-nw' | 'scale-ne' | 'scale-se' | 'scale-sw' | 'rotate';

/**
 * Pure drag maths for the transform overlay (no GL): given the transform at drag start, the handle being dragged and the
 * pointer positions (PREVIEW px) + modifiers, returns the NEW absolute transform values in CANVAS px / degrees. Snapping
 * (to canvas centre/edges, 15° steps with shift) is part of it. Unit-tested without a browser.
 */
export interface DragInput {
  kind: HandleKind;
  start: { x: number; y: number };
  current: { x: number; y: number };
  /** Transform values at drag start (canvas px/deg). */
  initial: { x: number; y: number; scale: number; rotation: number };
  /** Preview px per canvas px. */
  previewScale: number;
  /** Natural rect size of the item (canvas px) for scale maths. */
  rectW: number;
  rectH: number;
  canvasW: number;
  canvasH: number;
  shift: boolean;
  alt: boolean;
  /** Snap to centre/edges of the canvas when within this many preview px (0 = off). */
  snapPx: number;
}
export interface DragResult {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** Guides to draw (canvas px): vertical x lines / horizontal y lines that snapped. */
  guides: { x?: number; y?: number }[];
}
export type ComputeDrag = (input: DragInput) => DragResult;

export interface CompositorExports {
  createCompositor(canvas: HTMLCanvasElement | OffscreenCanvas, opts?: { project?: Project; powerPreference?: 'low-power' | 'high-performance' }): Compositor;
  computeDrag: ComputeDrag;
  /** Pure: text layout (line breaks) a text item gets at its style/size — shared with hit-testing. */
  measureTextItem(item: Item, canvasW: number): { width: number; height: number; lines: string[] };
  /** Parses a .cube file. */
  parseCube(text: string): { size: number; data: Float32Array };
}
export type { Asset, Transform };
