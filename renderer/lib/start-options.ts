/** Builds the explicit `pipeline:start` options from the Home form (always complete: see report on zod partial defaults). */
import { DEFAULT_STYLE_ID, type ReframeMode } from '@shared/cp2';
import type { PipelineOptionsInput } from '@shared/pipeline';
import type { Settings } from '@shared/settings';

export type CountMode = 'fixed' | 'score';

export interface StartForm {
  clipPreset: '15-30' | '30-60' | '60-90' | 'custom';
  minSec: number;
  maxSec: number;
  countMode: CountMode;
  clipCount: number;
  minScore: number;
  aspect: '9:16' | '1:1' | '4:5' | '16:9';
  captions: boolean;
  hookCard: boolean;
  prompt: string;
  /** Caption style preset id (CP2). */
  captionStyleId: string;
  reframeMode: ReframeMode;
  /** Brand Kit of the run (CP4): 'default' (the default kit), 'none' or a kit id. */
  brandKitId: string;
}

export function formFromSettings(
  s: Pick<Settings, 'defaultClipPreset' | 'defaultClipCount' | 'defaultAspect'>,
): StartForm {
  return {
    clipPreset: s.defaultClipPreset,
    minSec: 20,
    maxSec: 60,
    countMode: 'fixed',
    clipCount: s.defaultClipCount,
    minScore: 70,
    aspect: s.defaultAspect,
    captions: true,
    hookCard: true,
    prompt: '',
    captionStyleId: DEFAULT_STYLE_ID,
    reframeMode: 'auto',
    brandKitId: 'default',
  };
}

export function customRangeError(
  f: Pick<StartForm, 'clipPreset' | 'minSec' | 'maxSec'>,
): string | null {
  if (f.clipPreset !== 'custom') return null;
  if (!Number.isFinite(f.minSec) || !Number.isFinite(f.maxSec))
    return 'Enter both lengths in seconds.';
  if (f.minSec < 5) return 'Clips shorter than 5 seconds are not supported.';
  if (f.maxSec > 300) return 'The longest clip can be 300 seconds (5 minutes).';
  if (f.maxSec < f.minSec + 5) return 'Max length must be at least 5 seconds above min.';
  return null;
}

export function buildStartOptions(
  f: StartForm,
  maxResolution: Settings['maxResolution'],
): PipelineOptionsInput {
  const o: PipelineOptionsInput = {
    clipPreset: f.clipPreset,
    clipCount: f.countMode === 'score' ? null : f.clipCount,
    minScore: f.countMode === 'score' ? f.minScore : 60,
    aspect: f.aspect,
    captions: f.captions,
    hookCard: f.hookCard,
    prompt: f.prompt.trim().slice(0, 500),
    language: null,
    maxResolution,
    mode: 'clips',
    captionStyleId: f.captionStyleId,
    reframeMode: f.reframeMode,
    brandKitId: f.brandKitId,
  };
  if (f.clipPreset === 'custom') {
    o.minSec = Math.round(f.minSec);
    o.maxSec = Math.round(f.maxSec);
  }
  return o;
}
