/**
 * ReframeService implementation + helper to convert the sidecar's /faces response.
 */
import type { FaceSample, ReframeService } from '../../pipeline/contracts';
import { analyzeLayout } from './layout';
import { planReframe } from './plan';

export { cropGeometry } from './geometry';
export type { CropGeometry } from './geometry';
export { planReframe, smoothDamp, SCREEN_FACE_MIN_CONFIDENCE } from './plan';
export { planMulti, analyzeShots } from './multi';
export { planScreenFace, webcamRectFromFace } from './screen';
export { planSingle, centerPlan, chooseZoom } from './single';
export { analyzeLayout, classifyLayout, sampleFrames, sampleTimes, screenScore } from './layout';
export {
  detectTile,
  growTile,
  mergeLetterbox,
  parseCropdetect,
  regionMotion,
  screenStats,
  frameDiff,
  iou,
} from './frames';
export type { GrayFrame, ScreenStats, CropRect } from './frames';
export type { LayoutHintEx, Rect01 } from './hint';
export { DIVIDER_PX, screenFacePanels, splitPanels } from './geometry';
export { buildTracks, pickPair } from './tracks';
export * as reframeTuning from './tuning';

/** Structural subset of the sidecar `FacesResult` (snake_case wire format, see services/sidecar.ts). */
export interface FacesWire {
  frames: { t: number; faces: { x: number; y: number; w: number; h: number; score: number }[] }[];
}

/** Converts the sidecar /faces response into `FaceSample[]` (absolute source seconds, 0..1 boxes). */
export function facesFromSidecar(wire: FacesWire): FaceSample[] {
  return wire.frames.map((f) => ({
    t: f.t,
    boxes: f.faces.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, score: b.score })),
  }));
}

export function createReframeService(): ReframeService {
  return {
    plan: (args) => planReframe(args),
    analyzeLayout: (args) => analyzeLayout(args),
  };
}
