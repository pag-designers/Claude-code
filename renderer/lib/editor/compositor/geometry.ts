/**
 * Pure geometry shared by rendering, hit-testing, handles and drag maths (no DOM / GL). Coordinates are CANVAS px of the
 * project (origin top-left, y down) unless a function says "preview px"; rotation is degrees clockwise.
 */
import type { Point } from './api';

/** A rotated rectangle: centre, half extents (already scaled), rotation about the centre. */
export interface Geom {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  rot: number;
}

export const DEG = Math.PI / 180;

/** Rotates the vector (x, y) clockwise (y-down screen space) by `deg`. */
export function rotate(x: number, y: number, deg: number): Point {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return { x: c * x - s * y, y: s * x + c * y };
}

/** Corners clockwise from the rect's own top-left, multiplied by `k` (e.g. preview scale). */
export function geomCorners(g: Geom, k = 1): [Point, Point, Point, Point] {
  const loc: [number, number][] = [
    [-g.hw, -g.hh],
    [g.hw, -g.hh],
    [g.hw, g.hh],
    [-g.hw, g.hh],
  ];
  const pts = loc.map(([x, y]) => {
    const r = rotate(x, y, g.rot);
    return { x: (g.cx + r.x) * k, y: (g.cy + r.y) * k };
  });
  return pts as [Point, Point, Point, Point];
}

/** Whether the canvas-px point lies inside the rotated rect (`pad` grows it, canvas px). */
export function geomContains(g: Geom, x: number, y: number, pad = 0): boolean {
  const r = rotate(x - g.cx, y - g.cy, -g.rot);
  return Math.abs(r.x) <= g.hw + pad && Math.abs(r.y) <= g.hh + pad;
}

/** Half extents of the axis-aligned bounding box of the rotated rect. */
export function geomBounds(g: Geom): { hx: number; hy: number } {
  const c = Math.abs(Math.cos(g.rot * DEG));
  const s = Math.abs(Math.sin(g.rot * DEG));
  return { hx: c * g.hw + s * g.hh, hy: s * g.hw + c * g.hh };
}

/** Distance (preview px) between the top edge and the rotation handle. */
export const ROTATE_HANDLE_OFFSET_PX = 28;

/** Point `offset` beyond the middle of the top edge, along the rect's own "up" axis (preview px). */
export function rotationHandlePoint(g: Geom, k: number, offsetPx = ROTATE_HANDLE_OFFSET_PX): Point {
  const r = rotate(0, -g.hh * k - offsetPx, g.rot);
  return { x: g.cx * k + r.x, y: g.cy * k + r.y };
}
