/**
 * Media checks for posting (BRIEF §9): probe → validate against the platform's published limits → optionally fix with one
 * re-encode. Contract: `PublishMediaService` in pipeline/contracts5.ts. Limits: shared/platform-specs.ts.
 */
import type { MediaReport, Platform, PostMediaInfo } from '@shared/publish';
import type { PublishMediaService } from '../../pipeline/contracts5';
import type { CommonOpts } from '../../pipeline/contracts';
import type { EncoderName } from '../render/encoder';
import { fixMedia } from './fix';
import { probeFile } from './probe';
import type { ProbedMediaInfo, SpecOverrides } from './types';
import { validateMedia } from './validate';

export { chromaOf, validateMedia, averageBitrateBps } from './validate';
export { planFix, buildFixArgs, targetFps, videoEncoderArgs } from './plan';
export type { FixPlan } from './plan';
export { infoFromFfprobe, probeFile, parseRate } from './probe';
export { unfixableMessage } from './fix';
export type { ProbedMediaInfo, SpecOverrides } from './types';

export interface PublishMediaDeps {
  /** Path of the ffprobe binary (resolved lazily so a late-installed binary is found). */
  ffprobePath: () => string;
  log?: (m: string) => void;
  /** Tests only: replaces hardware-encoder detection. */
  detectEncoder?: (ffmpegPath: string) => Promise<EncoderName>;
}

/** `PublishMediaService` plus the optional per-call limits (TikTok's per-creator maximum duration). */
export interface PublishMediaServiceEx extends PublishMediaService {
  probe(file: string, opts?: Pick<CommonOpts, 'signal'>): Promise<ProbedMediaInfo>;
  validate(a: { info: PostMediaInfo; platform: Platform } & SpecOverrides): MediaReport;
  fix(a: Parameters<PublishMediaService['fix']>[0]): Promise<ProbedMediaInfo>;
}

export function createPublishMedia(deps: PublishMediaDeps): PublishMediaServiceEx {
  const probe = (file: string, signal?: AbortSignal): Promise<ProbedMediaInfo> =>
    probeFile(deps.ffprobePath(), file, signal);
  return {
    probe: (file, opts) => probe(file, opts?.signal),
    validate: (a) => validateMedia(a.info, a.platform, { maxDurationSec: a.maxDurationSec }),
    fix: (a) => fixMedia(a, { probe, detectEncoder: deps.detectEncoder, log: deps.log }),
  };
}
