import type { HandleKind, Point, TransformHandles } from '../../../lib/editor/compositor/api';

/** Pure layout / geometry helpers of the preview panel (unit-tested in node). */

export interface FitInput {
  containerW: number;
  containerH: number;
  /** Project canvas size (export px). */
  canvasW: number;
  canvasH: number;
  /** Space kept free around the picture, CSS px. */
  pad: number;
  /** Physical px per CSS px. */
  dpr: number;
  /** Cap for the long side of the drawing buffer. The picture is CSS-scaled above it (proxy resolution). */
  maxBufferLong: number;
}

export interface FitResult {
  cssW: number;
  cssH: number;
  bufW: number;
  bufH: number;
  /** Buffer px per CSS px. */
  k: number;
  /** Preview px per project (export) px. */
  previewScale: number;
}

/** Largest rectangle of the project's aspect that fits the container; drawing buffer sized for the DPR, capped. */
export function fitPreview(i: FitInput): FitResult {
  const availW = Math.max(1, i.containerW - 2 * i.pad);
  const availH = Math.max(1, i.containerH - 2 * i.pad);
  const aspect = i.canvasW / i.canvasH;
  let cssW = availW;
  let cssH = cssW / aspect;
  if (cssH > availH) {
    cssH = availH;
    cssW = cssH * aspect;
  }
  cssW = Math.max(1, Math.floor(cssW));
  cssH = Math.max(1, Math.floor(cssH));
  const wantW = cssW * Math.max(1, i.dpr);
  const wantH = cssH * Math.max(1, i.dpr);
  const long = Math.max(wantW, wantH);
  const shrink = long > i.maxBufferLong ? i.maxBufferLong / long : 1;
  const bufW = Math.max(2, Math.round(wantW * shrink));
  const bufH = Math.max(2, Math.round(wantH * shrink));
  return { cssW, cssH, bufW, bufH, k: bufW / cssW, previewScale: bufW / i.canvasW };
}

/** `mm:ss:ff` — minutes, seconds, frames (project fps). */
export function formatTimecode(sec: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.max(0, sec);
  const whole = Math.floor(total + 1e-9);
  const frames = Math.min(f - 1, Math.floor((total - whole) * f + 1e-6));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(m)}:${p2(s)}:${p2(frames)}`;
}

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Point inside a (convex, possibly rotated) quad given clockwise or counter-clockwise. */
export function pointInQuad(p: Point, q: readonly [Point, Point, Point, Point]): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i] as Point, q[(i + 1) % 4] as Point, p);
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Handle radii in CSS px. */
export const HANDLE_HIT_CSS = 10;
export const ROTATE_HIT_CSS = 11;

/**
 * Which handle (or the body) is under a pointer. `p` is in preview (buffer) px, `k` = buffer px per CSS px, so hit radii
 * stay constant on screen. Rotation wins over corners, corners over the body.
 */
export function hitHandle(h: TransformHandles, p: Point, k: number): HandleKind | null {
  if (dist(p, h.rotationHandle) <= ROTATE_HIT_CSS * k) return 'rotate';
  const names: HandleKind[] = ['scale-nw', 'scale-ne', 'scale-se', 'scale-sw'];
  let best: HandleKind | null = null;
  let bd = HANDLE_HIT_CSS * k;
  h.corners.forEach((c, i) => {
    const d = dist(p, c);
    if (d <= bd) {
      bd = d;
      best = names[i] as HandleKind;
    }
  });
  if (best) return best;
  return pointInQuad(p, h.corners) ? 'move' : null;
}

/** Axis-aligned bounds of the handle quad (buffer px). */
export function quadBounds(c: readonly Point[]): { x: number; y: number; w: number; h: number } {
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Natural (scale 1) rect size of a handle quad in canvas px: the compositor reports the transformed corners in preview
 * px, `computeDrag` wants the untransformed size.
 */
export function naturalSize(
  h: TransformHandles,
  previewScale: number,
  scale: number,
): { rectW: number; rectH: number } {
  const s = previewScale * (scale > 1e-6 ? scale : 1);
  return {
    rectW: dist(h.corners[0], h.corners[1]) / s,
    rectH: dist(h.corners[0], h.corners[3]) / s,
  };
}

/** CSS cursor for a handle. Corner cursors follow the item's rotation to the nearest 45° resize cursor. */
export function cursorFor(kind: HandleKind | null, rotationDeg = 0): string {
  switch (kind) {
    case null:
      return 'default';
    case 'move':
      return 'move';
    case 'rotate':
      return 'grab';
    default: {
      const base = kind === 'scale-nw' || kind === 'scale-se' ? 45 : 135;
      const a = (((base + rotationDeg) % 180) + 180) % 180;
      const idx = Math.round(a / 45) % 4;
      return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][idx] as string;
    }
  }
}

/** Client coordinates → preview (buffer) px for an element's bounding rect. */
export function toBufferPx(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  bufW: number,
  bufH: number,
): Point {
  return {
    x: ((clientX - rect.left) / Math.max(1, rect.width)) * bufW,
    y: ((clientY - rect.top) / Math.max(1, rect.height)) * bufH,
  };
}

/** Safe-area rectangle (fractions of the canvas) in buffer px. */
export function safeRect(
  a: { top: number; bottom: number; left: number; right: number },
  bufW: number,
  bufH: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: a.left * bufW,
    y: a.top * bufH,
    w: bufW * (1 - a.left - a.right),
    h: bufH * (1 - a.top - a.bottom),
  };
}
