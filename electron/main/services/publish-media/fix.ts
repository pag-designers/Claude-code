/**
 * The auto-fix: ONE ffmpeg re-encode (H.264 High yuv420p + AAC 48 kHz, faststart) written to `<out>.partial` and renamed on
 * success; the partial file is removed on failure or abort. Never crops or trims: duration/aspect problems are refused.
 */
import { copyFile, rename, rm } from 'node:fs/promises';
import { PLATFORM_SPECS } from '@shared/platform-specs';
import type { MediaIssue, MediaReport, Platform } from '@shared/publish';
import type { OnProgress } from '../../pipeline/contracts';
import { detectEncoder, type EncoderName } from '../render/encoder';
import { lastLines, RenderAbortError, runFfmpeg } from '../render/ffmpeg';
import { buildFixArgs, planFix } from './plan';
import type { ProbedMediaInfo } from './types';
import { validateMedia } from './validate';

export interface FixDeps {
  probe(file: string, signal?: AbortSignal): Promise<ProbedMediaInfo>;
  detectEncoder?: (ffmpegPath: string) => Promise<EncoderName>;
  log?: (m: string) => void;
}

export interface FixArgs {
  file: string;
  outFile: string;
  platform: Platform;
  report: MediaReport;
  ffmpegPath: string;
  signal?: AbortSignal;
  onProgress?: OnProgress;
}

/** The sentence a person reads when the fix is refused. */
export function unfixableMessage(platform: Platform, issues: readonly MediaIssue[]): string {
  const name = PLATFORM_SPECS[platform].label;
  return `Auto-fix cannot make this clip fit ${name}: ${issues.map((i) => i.message).join(' ')} Auto-fix never trims, crops or enlarges a clip.`;
}

export async function fixMedia(a: FixArgs, deps: FixDeps): Promise<ProbedMediaInfo> {
  const { signal } = a;
  if (signal?.aborted) throw new RenderAbortError();
  if (a.outFile === a.file) throw new Error('The fixed video must be written to a different file.');

  // 1. refuse what a re-encode cannot fix
  const blocking = a.report.issues.filter((i) => i.severity === 'error' && !i.fixable);
  if (blocking.length > 0) throw new Error(unfixableMessage(a.platform, blocking));

  // 2. look at the file as it is NOW (the report may be older, and lacks facts such as pixel shape and rotation)
  const info = await deps.probe(a.file, signal);
  const now = validateMedia(info, a.platform);
  const fixable = now.issues.filter((i) => i.fixable);
  const partial = `${a.outFile}.partial`;
  const cleanup = (): Promise<void> => rm(partial, { force: true }).catch(() => undefined);
  const report = (f: number, m?: string): void => a.onProgress?.(Math.min(1, Math.max(0, f)), m);
  report(0, 'Preparing');

  try {
    // nothing a re-encode would change: hand the file back as it is
    if (fixable.length === 0) {
      await copyFile(a.file, partial);
      await rename(partial, a.outFile);
      report(1, 'Already within the limits');
      return await deps.probe(a.outFile, signal);
    }

    const plan = planFix(info, a.platform, fixable);
    const enc = await (deps.detectEncoder ?? detectEncoder)(a.ffmpegPath);
    deps.log?.(`auto-fix ${a.platform}: ${plan.notes.join('; ') || 'repackage'} (${enc})`);
    const args = buildFixArgs(a.file, partial, info, plan, enc);
    const total = info.durationSec;
    const r = await runFfmpeg(a.ffmpegPath, args, {
      signal,
      onOutTime: (t) => report(0.02 + 0.96 * Math.min(1, t / total), 'Re-encoding'),
    });
    if (r.code !== 0) {
      throw new Error(
        `The video could not be re-encoded (ffmpeg exited with ${r.code}): ${lastLines(r.stderr, 3) || 'no details'}`,
      );
    }

    // 3. the result must really be clean: refuse to hand back a file the platform would still reject
    const out = await deps.probe(partial, signal);
    const left = validateMedia(out, a.platform).issues.filter(
      (i) => i.severity === 'error' && i.fixable,
    );
    if (left.length > 0) {
      throw new Error(
        `The re-encoded video still does not meet ${PLATFORM_SPECS[a.platform].label}'s limits: ${left.map((i) => i.message).join(' ')}`,
      );
    }
    await rename(partial, a.outFile);
    report(1, 'Done');
    return { ...out, sizeBytes: out.sizeBytes };
  } catch (e) {
    throw e;
  }
}
