/** Crop-window geometry for the supported output aspects (BRIEF §4.7). */
import type { PipelineOptions } from '@shared/pipeline';

export type Aspect = PipelineOptions['aspect'];

const OUT_SIZE: Record<Aspect, { outW: number; outH: number }> = {
  '9:16': { outW: 1080, outH: 1920 },
  '1:1': { outW: 1080, outH: 1080 },
  '4:5': { outW: 1080, outH: 1350 },
  '16:9': { outW: 1920, outH: 1080 },
};

const RATIO: Record<Aspect, number> = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };

export interface CropGeometry {
  /** Crop window size in SOURCE pixels (even integers, never larger than the source). */
  cropW: number;
  cropH: number;
  outW: number;
  outH: number;
}

const evenFloor = (v: number): number => Math.max(2, 2 * Math.floor(v / 2));
const evenRound = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/**
 * The largest window of the target aspect that fits in the source: full height for a source that is
 * wider than the target (16:9 -> 9:16 gives width srcH*9/16), full width otherwise.
 */
export function cropGeometry(aspect: Aspect, srcW: number, srcH: number): CropGeometry {
  const { outW, outH } = OUT_SIZE[aspect];
  const a = RATIO[aspect];
  let cropW: number;
  let cropH: number;
  if (srcW / srcH >= a) {
    cropH = evenFloor(srcH);
    cropW = evenRound(srcH * a);
    if (cropW > srcW) cropW = evenFloor(srcW);
  } else {
    cropW = evenFloor(srcW);
    cropH = evenRound(srcW / a);
    if (cropH > srcH) cropH = evenFloor(srcH);
  }
  return { cropW, cropH, outW, outH };
}

/* ------------------------------------------- multi-panel layouts ------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width of the line drawn on the seam between two panels (px of the output frame). */
export const DIVIDER_PX = 4;

export function outputSize(aspect: Aspect): { outW: number; outH: number } {
  return OUT_SIZE[aspect];
}

/**
 * Two equal face panels. 9:16 / 4:5 / 1:1 stack them (top = first face); 16:9 puts them side by side
 * (left = first face). Panels tile the output frame exactly.
 */
export function splitPanels(aspect: Aspect): { a: Rect; b: Rect } {
  const { outW, outH } = OUT_SIZE[aspect];
  if (aspect === '16:9') {
    const w = outW / 2;
    return { a: { x: 0, y: 0, w, h: outH }, b: { x: w, y: 0, w, h: outH } };
  }
  const h = outH / 2;
  return { a: { x: 0, y: 0, w: outW, h }, b: { x: 0, y: h, w: outW, h } };
}

/**
 * Screen on top (or left for 16:9), webcam face below (right): 9:16 -> 1080x1280 + 1080x640, 4:5 ->
 * 1080x810 + 1080x540, 1:1 -> 1080x648 + 1080x432, 16:9 -> 1280x1080 + 640x1080.
 */
export function screenFacePanels(aspect: Aspect): { screen: Rect; face: Rect } {
  const { outW, outH } = OUT_SIZE[aspect];
  if (aspect === '16:9') {
    const faceW = 640;
    return {
      screen: { x: 0, y: 0, w: outW - faceW, h: outH },
      face: { x: outW - faceW, y: 0, w: faceW, h: outH },
    };
  }
  const frac = aspect === '9:16' ? 1 / 3 : aspect === '4:5' ? 0.4 : 0.4;
  const faceH = 2 * Math.round((outH * frac) / 2);
  return {
    screen: { x: 0, y: 0, w: outW, h: outH - faceH },
    face: { x: 0, y: outH - faceH, w: outW, h: faceH },
  };
}
