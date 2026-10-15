/**
 * `LayoutHint` (contracts.ts) plus the extra fields our analyzer fills in. The extras are optional and
 * the planner reads them structurally, so a hint that went through a plain `LayoutHint` variable
 * (same object) keeps working; a consumer that re-serialises it must keep `contentRect` and `tiles`.
 */
import type { LayoutHint } from '../../pipeline/contracts';
import type { Rect } from './geometry';

/** Normalised (0..1) rectangle of the source frame. */
export interface Rect01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutHintEx extends LayoutHint {
  /** Picture area without baked-in black bars (normalised); null/undefined = the whole frame. */
  contentRect?: Rect01 | null;
  /** Video-call tiles / camera panes found in the sampled frames (normalised), for multi-face crops. */
  tiles?: Rect01[];
  /** Numbers behind the decision (face width, stationarity, edge density...) for logs and tests. */
  diagnostics?: Record<string, number | string | boolean>;
}

export function toPx(r: Rect01, srcW: number, srcH: number): Rect {
  return { x: r.x * srcW, y: r.y * srcH, w: r.w * srcW, h: r.h * srcH };
}

/** The picture area in source pixels (even-aligned), or the whole frame. */
export function contentRegion(
  hint: LayoutHint | null | undefined,
  srcW: number,
  srcH: number,
): Rect {
  const c = (hint as LayoutHintEx | null | undefined)?.contentRect;
  if (!c || !(c.w > 0.2 && c.h > 0.2)) return { x: 0, y: 0, w: srcW, h: srcH };
  const x = 2 * Math.round((c.x * srcW) / 2);
  const y = 2 * Math.round((c.y * srcH) / 2);
  const w = Math.min(srcW - x, 2 * Math.round((c.w * srcW) / 2));
  const h = Math.min(srcH - y, 2 * Math.round((c.h * srcH) / 2));
  return { x, y, w, h };
}

export function hintTiles(hint: LayoutHint | null | undefined): Rect01[] {
  return (hint as LayoutHintEx | null | undefined)?.tiles ?? [];
}
