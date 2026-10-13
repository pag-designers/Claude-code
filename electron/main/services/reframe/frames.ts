/**
 * Pure image analysis on small grayscale frames (8-bit, row-major): letterbox merging, screen-content
 * statistics and video-call tile detection. No I/O: the frames come from `layout.ts` (ffmpeg).
 */
import type { Rect01 } from './hint';

export interface GrayFrame {
  w: number;
  h: number;
  data: Uint8Array;
}

/* ------------------------------------------------ letterbox ------------------------------------------------ */

export interface CropRect {
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Last `crop=W:H:X:Y` printed by ffmpeg's cropdetect (it refines over frames; the last is final). */
export function parseCropdetect(stderr: string): CropRect | null {
  let last: CropRect | null = null;
  for (const m of stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    last = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  }
  return last;
}

/** A side counts as a letterbox bar from this share of the dimension. */
export const MIN_BAR_FRAC = 0.03;

/**
 * Merges per-frame cropdetect results into the picture area. Conservative: each side's bar is the
 * SMALLEST bar seen in any frame (one frame whose picture reaches the edge means there is no bar there),
 * and at least 3 frames must have been analysed. Bars below 3% of the dimension are ignored.
 * Returns null when nothing should be cropped.
 */
export function mergeLetterbox(
  crops: CropRect[],
  srcW: number,
  srcH: number,
  minFrames = 3,
): Rect01 | null {
  if (crops.length < minFrames) return null;
  const bar = (f: (c: CropRect) => number): number => Math.min(...crops.map(f));
  let left = bar((c) => c.x);
  let top = bar((c) => c.y);
  let right = bar((c) => srcW - (c.x + c.w));
  let bottom = bar((c) => srcH - (c.y + c.h));
  if (left < MIN_BAR_FRAC * srcW) left = 0;
  if (right < MIN_BAR_FRAC * srcW) right = 0;
  if (top < MIN_BAR_FRAC * srcH) top = 0;
  if (bottom < MIN_BAR_FRAC * srcH) bottom = 0;
  if (left + right + top + bottom === 0) return null;
  const w = srcW - left - right;
  const h = srcH - top - bottom;
  if (w < 0.4 * srcW || h < 0.4 * srcH) return null; // implausible: not a letterbox
  return { x: left / srcW, y: top / srcH, w: w / srcW, h: h / srcH };
}

/* ------------------------------------------- screen-content stats ------------------------------------------ */

export interface ScreenStats {
  /** Share of pixels with a strong gradient (text, lines, UI borders). */
  edgeFrac: number;
  /** Share of 8x8 blocks that are (nearly) flat (UI backgrounds). */
  flatFrac: number;
  /** Share of pixels within 3 gray levels of the most common level (peaky histogram = synthetic). */
  peakFrac: number;
  /** Share of near-black pixels. */
  darkFrac: number;
}

const EDGE_T = 40;
const FLAT_RANGE = 5;

/** Statistics over the frame excluding `skip` (normalised rect; e.g. the webcam). */
export function screenStats(f: GrayFrame, skip?: Rect01 | null): ScreenStats {
  const { w, h, data } = f;
  const sx0 = skip ? Math.floor(skip.x * w) : 0;
  const sx1 = skip ? Math.ceil((skip.x + skip.w) * w) : 0;
  const sy0 = skip ? Math.floor(skip.y * h) : 0;
  const sy1 = skip ? Math.ceil((skip.y + skip.h) * h) : 0;
  const inSkip = (x: number, y: number): boolean => !!skip && x >= sx0 && x < sx1 && y >= sy0 && y < sy1;
  let n = 0;
  let edges = 0;
  let dark = 0;
  const hist = new Array<number>(256).fill(0);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      if (inSkip(x, y)) continue;
      const i = y * w + x;
      const v = data[i] ?? 0;
      const g = Math.abs(v - (data[i + 1] ?? 0)) + Math.abs(v - (data[i + w] ?? 0));
      if (g >= EDGE_T) edges++;
      if (v < 24) dark++;
      hist[v] = (hist[v] ?? 0) + 1;
      n++;
    }
  }
  let blocks = 0;
  let flat = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      if (inSkip(bx, by) || inSkip(bx + 7, by + 7)) continue;
      let lo = 255;
      let hi = 0;
      for (let y = by; y < by + 8; y++) {
        for (let x = bx; x < bx + 8; x++) {
          const v = data[y * w + x] ?? 0;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      blocks++;
      if (hi - lo <= FLAT_RANGE) flat++;
    }
  }
  let peak = 0;
  for (let v = 0; v < 256; v++) {
    const s = (hist[v - 1] ?? 0) + (hist[v] ?? 0) + (hist[v + 1] ?? 0);
    if (s > peak) peak = s;
  }
  return {
    edgeFrac: n ? edges / n : 0,
    flatFrac: blocks ? flat / blocks : 0,
    peakFrac: n ? peak / n : 0,
    darkFrac: n ? dark / n : 0,
  };
}

/** Mean absolute difference (0..255) between two frames of the same size, outside `skip`. */
export function frameDiff(a: GrayFrame, b: GrayFrame, skip?: Rect01 | null): number {
  if (a.w !== b.w || a.h !== b.h) return 255;
  const sx0 = skip ? Math.floor(skip.x * a.w) : 0;
  const sx1 = skip ? Math.ceil((skip.x + skip.w) * a.w) : 0;
  const sy0 = skip ? Math.floor(skip.y * a.h) : 0;
  const sy1 = skip ? Math.ceil((skip.y + skip.h) * a.h) : 0;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      if (skip && x >= sx0 && x < sx1 && y >= sy0 && y < sy1) continue;
      sum += Math.abs((a.data[y * a.w + x] ?? 0) - (b.data[y * a.w + x] ?? 0));
      n++;
    }
  }
  return n ? sum / n : 0;
}

/* ------------------------------------------------- tiles ----------------------------------------------------- */

const DARK = 30;
/** Mean luma step across a strip that marks a hard tile edge. */
const TILE_EDGE_STEP = 26;

/**
 * Finds the rectangle (video-call tile / camera pane) around a face by growing a window from the face
 * box until it meets near-black margins or a hard edge (two images side by side). Normalised in/out.
 * Returns null when the result is implausibly small (< 1.4x the face).
 */
export function detectTile(f: GrayFrame, face: Rect01): Rect01 | null {
  const { w, h, data } = f;
  const fx0 = Math.max(0, Math.floor(face.x * w));
  const fx1 = Math.min(w, Math.ceil((face.x + face.w) * w));
  const fy0 = Math.max(0, Math.floor(face.y * h));
  const fy1 = Math.min(h, Math.ceil((face.y + face.h) * h));
  // the bands we examine: the face's own columns/rows widened a little (never the whole current rect,
  // which would swallow neighbouring tiles that touch this one)
  const bx0 = Math.max(0, Math.floor(fx0 - 0.3 * (fx1 - fx0)));
  const bx1 = Math.min(w, Math.ceil(fx1 + 0.3 * (fx1 - fx0)));
  const by0 = Math.max(0, Math.floor(fy0 - 0.3 * (fy1 - fy0)));
  const by1 = Math.min(h, Math.ceil(fy1 + 0.3 * (fy1 - fy0)));

  const rowStat = (y: number, x0: number, x1: number): { dark: number; mean: number } => {
    let dark = 0;
    let sum = 0;
    for (let x = x0; x < x1; x++) {
      const v = data[y * w + x] ?? 0;
      sum += v;
      if (v < DARK) dark++;
    }
    const n = Math.max(1, x1 - x0);
    return { dark: dark / n, mean: sum / n };
  };
  const colStat = (x: number, y0: number, y1: number): { dark: number; mean: number } => {
    let dark = 0;
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      const v = data[y * w + x] ?? 0;
      sum += v;
      if (v < DARK) dark++;
    }
    const n = Math.max(1, y1 - y0);
    return { dark: dark / n, mean: sum / n };
  };

  /** Grows from `start` by `step` (+1/-1) until `stat` says the next strip is a margin or a hard edge. */
  const grow = (
    start: number,
    step: 1 | -1,
    limit: number,
    stat: (i: number) => { dark: number; mean: number },
  ): number => {
    let edge = start;
    let darkRun = 0;
    const recent: number[] = [];
    for (let i = start + step; step > 0 ? i < limit : i >= limit; i += step) {
      const s = stat(i);
      if (s.dark >= 0.97) {
        darkRun++;
        if (darkRun >= 2) break;
      } else darkRun = 0;
      const base = recent.length >= 6 ? (recent.slice(-6).reduce((a, b) => a + b, 0) / 6) : null;
      if (base !== null && Math.abs(s.mean - base) > TILE_EDGE_STEP) break;
      recent.push(s.mean);
      edge = i;
    }
    return edge;
  };

  const left = grow(fx0, -1, 0, (x) => colStat(x, by0, by1));
  const right = grow(fx1 - 1, 1, w, (x) => colStat(x, by0, by1)) + 1;
  const top = grow(fy0, -1, 0, (y) => rowStat(y, bx0, bx1));
  const bottom = grow(fy1 - 1, 1, h, (y) => rowStat(y, bx0, bx1)) + 1;
  const tw = right - left;
  const th = bottom - top;
  if (tw < 1.4 * (fx1 - fx0) || th < 1.4 * (fy1 - fy0)) return null;
  return { x: left / w, y: top / h, w: tw / w, h: th / h };
}

/** IoU of two normalised rects. */
export function iou(a: Rect01, b: Rect01): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
