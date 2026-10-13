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
