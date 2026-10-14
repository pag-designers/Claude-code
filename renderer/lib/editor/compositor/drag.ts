/**
 * Pure drag maths for the transform overlay (see `DragInput` in api.ts). No DOM, no GL — unit-tested in node.
 *
 *  - move: translates by the pointer delta (canvas px). Shift locks to the dominant axis. With `snapPx > 0` the item's
 *    rotated bounding box snaps its centre / edges to the canvas centre lines and edges; the snapped lines are returned
 *    as `guides` (canvas px).
 *  - scale-nw/ne/se/sw: UNIFORM scale (free aspect is not supported, so shift has no effect). The factor is the pointer's
 *    projection on the corner diagonal relative to where the drag began. Default anchor = the item centre; `alt` anchors
 *    the opposite corner instead (the centre moves so that corner stays put).
 *  - rotate: angle swept around the centre; shift snaps the absolute angle to 15° steps.
 */
import type { DragInput, DragResult } from './api';
import { DEG, geomBounds, rotate } from './geometry';

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 100;
export const ROTATE_SNAP_DEG = 15;

const CORNER_SIGN: Record<string, [number, number]> = {
  'scale-nw': [-1, -1],
  'scale-ne': [1, -1],
  'scale-se': [1, 1],
  'scale-sw': [-1, 1],
};

function wrap180(d: number): number {
  let v = d % 360;
  if (v > 180) v -= 360;
  else if (v <= -180) v += 360;
  return v;
}

export function computeDrag(i: DragInput): DragResult {
  const ps = i.previewScale > 0 ? i.previewScale : 1;
  const out: DragResult = {
    x: i.initial.x,
    y: i.initial.y,
    scale: i.initial.scale,
    rotation: i.initial.rotation,
    guides: [],
  };
  const dxPrev = i.current.x - i.start.x;
  const dyPrev = i.current.y - i.start.y;

  if (i.kind === 'move') {
    let dx = dxPrev / ps;
    let dy = dyPrev / ps;
    if (i.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    let x = i.initial.x + dx;
    let y = i.initial.y + dy;
    if (i.snapPx > 0) {
      const thr = i.snapPx / ps;
      const w = i.rectW * i.initial.scale;
      const h = i.rectH * i.initial.scale;
      const { hx, hy } = geomBounds({
        cx: 0,
        cy: 0,
        hw: w / 2,
        hh: h / 2,
        rot: i.initial.rotation,
      });
      // candidates: [value of the item's centre offset, guide line position]
      const xs: [number, number][] = [
        [0, i.canvasW / 2],
        [-i.canvasW / 2 + hx, 0],
        [i.canvasW / 2 - hx, i.canvasW],
      ];
      const ys: [number, number][] = [
        [0, i.canvasH / 2],
        [-i.canvasH / 2 + hy, 0],
        [i.canvasH / 2 - hy, i.canvasH],
      ];
      const pick = (v: number, c: [number, number][]): [number, number] | null => {
        let best: [number, number] | null = null;
        let bd = thr;
        for (const cand of c) {
          const d = Math.abs(cand[0] - v);
          if (d <= bd) {
            best = cand;
            bd = d;
          }
        }
        return best;
      };
      const sx = pick(x, xs);
      const sy = pick(y, ys);
      if (sx) {
        x = sx[0];
        out.guides.push({ x: sx[1] });
      }
      if (sy) {
        y = sy[0];
        out.guides.push({ y: sy[1] });
      }
    }
    out.x = x;
    out.y = y;
    return out;
  }

  // centre of the item in preview px
  const c0x = (i.canvasW / 2 + i.initial.x) * ps;
  const c0y = (i.canvasH / 2 + i.initial.y) * ps;

  if (i.kind === 'rotate') {
    const a0 = Math.atan2(i.start.y - c0y, i.start.x - c0x) / DEG;
    const a1 = Math.atan2(i.current.y - c0y, i.current.x - c0x) / DEG;
    let rot = i.initial.rotation + wrap180(a1 - a0);
    if (i.shift) rot = Math.round(rot / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
    out.rotation = rot;
    return out;
  }

  const sign = CORNER_SIGN[i.kind];
  if (!sign) return out;
  const hw0 = (i.rectW * i.initial.scale) / 2;
  const hh0 = (i.rectH * i.initial.scale) / 2;
  // corner offset from the centre (canvas px), rotated
  const cv = rotate(sign[0] * hw0, sign[1] * hh0, i.initial.rotation);
  const len = Math.hypot(cv.x, cv.y) || 1;
  const u = { x: cv.x / len, y: cv.y / len };
  // anchor point (preview px): the centre, or with alt the opposite corner
  const ax = i.alt ? c0x - cv.x * ps : c0x;
  const ay = i.alt ? c0y - cv.y * ps : c0y;
  const p0 = (i.start.x - ax) * u.x + (i.start.y - ay) * u.y;
  const p1 = (i.current.x - ax) * u.x + (i.current.y - ay) * u.y;
  let f = Math.abs(p0) < 1e-6 ? 1 : p1 / p0;
  if (!Number.isFinite(f)) f = 1;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, i.initial.scale * f));
  f = scale / i.initial.scale;
  out.scale = scale;
  if (i.alt) {
    // keep the opposite corner fixed: new centre = anchor + (old centre - anchor) * f
    const ox = c0x / ps - cv.x;
    const oy = c0y / ps - cv.y;
    out.x = ox + cv.x * f - i.canvasW / 2;
    out.y = oy + cv.y * f - i.canvasH / 2;
  }
  return out;
}
