/**
 * Reframe planner entry point (BRIEF §4.7): picks the layout and delegates.
 *
 *   mode 'center'      -> static centre crop of the picture area
 *   mode 'single-face' -> follow one face (single.ts)
 *   mode 'multi-face'  -> two stacked panels, one per face (multi.ts); falls back to single-face when
 *                         the footage has no two separated faces
 *   mode 'screen-face' -> screen on top + webcam strip (screen.ts); falls back to single-face
 *   mode 'auto'        -> screen-face when the layout analysis says so (confidence >= 0.55), else
 *                         multi-face when two faces are in view for >= 75% of the clip, else single-face
 */
import type { ReframePlan } from '@shared/pipeline';
import type { ReframeService } from '../../pipeline/contracts';
import { contentRegion, hintTiles, type LayoutHintEx } from './hint';
import { AUTO_MIN_PAIR_FRACTION, planMulti } from './multi';
import { planScreenFace } from './screen';
import { centerPlan, planSingle } from './single';

export {
  DEAD_ZONE_FRAC,
  FACE_Y_FRACTION,
  HOLD_SEC,
  KEYFRAME_HZ,
  MAX_PAN_CROPS_PER_SEC,
  smoothDamp,
  SMOOTH_TIME,
} from './path';

/** Minimum `LayoutHint.confidence` for auto mode to switch to the screen + face layout. */
export const SCREEN_FACE_MIN_CONFIDENCE = 0.55;

export function planReframe(args: Parameters<ReframeService['plan']>[0]): ReframePlan {
  const mode = args.mode ?? 'auto';
  const hint = (args.layoutHint ?? null) as LayoutHintEx | null;
  const region = contentRegion(hint, args.srcW, args.srcH);

  if (mode === 'center') return centerPlan(args, region);

  const wantScreen =
    mode === 'screen-face' ||
    (mode === 'auto' &&
      hint?.kind === 'screen-face' &&
      hint.faceRegion !== null &&
      hint.confidence >= SCREEN_FACE_MIN_CONFIDENCE);
  if (wantScreen) {
    const p = planScreenFace(args, hint, region);
    if (p) return p;
  }

  if (mode === 'multi-face' || mode === 'auto') {
    const p = planMulti(args, {
      region,
      tiles: hintTiles(hint),
      minPairFraction: mode === 'multi-face' ? 0.01 : AUTO_MIN_PAIR_FRACTION,
    });
    if (p) return p;
  }

  return planSingle(args, { region, zoom: true });
}
