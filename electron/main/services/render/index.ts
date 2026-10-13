/**
 * RenderService: one FFmpeg invocation per clip (BRIEF §4.13).
 *
 *   input-seek (-ss/-t before -i, frame-accurate because we re-encode)
 *   -> [fps] -> sendcmd-driven two-stage crop (reframe path) -> lanczos scale -> ass (captions + hook)
 *   audio: loudnorm pass 1 (measure) -> pass 2 linear to the target LUFS, TP <= -1.5 dBTP, AAC 192k/48 kHz
 *   H.264 yuv420p +faststart (NVENC / VideoToolbox when they really work, else libx264 veryfast crf 20)
 */
import { copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RenderRequest, RenderService } from '../../pipeline/contracts';
import { appendHookToAss } from '../captions/hook';
import { buildAudioFilter, measureLoudness } from './audio';
import { detectEncoder, encoderArgs, type EncoderName } from './encoder';
import {
  lastLines,
  probeStreams,
  RenderAbortError,
  RenderError,
  runFfmpeg,
  type StreamInfo,
} from './ffmpeg';
import { buildCropCommands, buildVideoFilter, CropPath, planStages, stageValues } from './filters';
import type { ReframePlan } from '@shared/pipeline';

export { extractThumbnail, laplacianVariance } from './thumbnail';
export { detectEncoder, encoderArgs, canEncode, clearEncoderCache } from './encoder';
export type { EncoderName } from './encoder';
export { buildAudioFilter, parseLoudnormJson, measureLoudness } from './audio';
export {
  buildCropCommands,
  buildVideoFilter,
  CropPath,
  escapeFilterPath,
  planStages,
  stageValues,
} from './filters';
export { parseStreamInfo, probeStreams, RenderError, RenderAbortError } from './ffmpeg';

const MAX_FPS = 60;

/** Rational notation for the NTSC rates so `fps=` does not drift. */
function fpsArg(fps: number): string {
  const ntsc: [number, string][] = [
    [23.976, '24000/1001'],
    [29.97, '30000/1001'],
    [47.952, '48000/1001'],
    [59.94, '60000/1001'],
  ];
  for (const [v, r] of ntsc) if (Math.abs(fps - v) < 0.01) return r;
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3);
}

/** Scales a plan made for another resolution of the same picture to the real source size. */
function fitPlanToSource(plan: ReframePlan, srcW: number, srcH: number): ReframePlan {
  if (plan.srcW === srcW && plan.srcH === srcH) return plan;
  const sx = srcW / plan.srcW;
  const sy = srcH / plan.srcH;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.01) {
    throw new RenderError(
      `The reframe plan was made for a ${plan.srcW}x${plan.srcH} source but the file is ${srcW}x${srcH}.`,
    );
  }
  const ev = (v: number): number => Math.max(2, 2 * Math.round(v / 2));
  return {
    ...plan,
    srcW,
    srcH,
    keyframes: plan.keyframes.map((k) => ({
      t: k.t,
      x: k.x * sx,
      y: k.y * sy,
      w: Math.min(srcW, ev(k.w * sx)),
      h: Math.min(srcH, ev(k.h * sy)),
    })),
  };
}

function validate(req: RenderRequest): void {
  if (!(req.endSec > req.startSec) || !Number.isFinite(req.startSec) || req.startSec < 0) {
    throw new RenderError(`Invalid clip range ${req.startSec}..${req.endSec}`);
  }
  if (req.plan.keyframes.length === 0) throw new RenderError('The reframe plan has no keyframes.');
  if (!(req.plan.outW > 0 && req.plan.outH > 0))
    throw new RenderError('The reframe plan has no output size.');
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function createRenderService(): RenderService {
  return {
    detectEncoder: (ffmpegPath) => detectEncoder(ffmpegPath),

    async render(req) {
      validate(req);
      const { signal, onProgress } = req;
      const duration = req.endSec - req.startSec;
      const report = (f: number | null, msg?: string): void => {
        if (!onProgress) return;
        if (f === null) onProgress(null, msg);
        else onProgress(Math.max(0, Math.min(1, f)), msg);
      };
      if (!(await exists(req.sourcePath)))
        throw new RenderError(`Source video not found: ${req.sourcePath}`);
      if (req.assPath && !(await exists(req.assPath))) {
        throw new RenderError(`Caption file not found: ${req.assPath}`);
      }
      report(0, 'Preparing render');

      const info: StreamInfo = await probeStreams(req.ffmpegPath, req.sourcePath, signal);
      if (!info.hasVideo) throw new RenderError('The source file has no video stream.');
      const srcW = info.width ?? req.plan.srcW;
      const srcH = info.height ?? req.plan.srcH;
      const plan = fitPlanToSource(req.plan, srcW, srcH);

      const encoder: EncoderName =
        req.encoder === 'auto' ? await detectEncoder(req.ffmpegPath) : req.encoder;

      // frame rate: keep the source rate, cap at 60; force it only when it must change
      const srcFps = info.fps ?? info.tbr ?? 30;
      const targetFps = Math.min(MAX_FPS, req.fps ?? srcFps);
      const vfr = info.tbr !== null && info.fps !== null && Math.abs(info.tbr - info.fps) > 0.5;
      const forceFps = req.fps !== null || srcFps > MAX_FPS || vfr;

      const outDir = path.dirname(req.outPath);
      const work = await mkdtemp(path.join(outDir, '.clipfern-render-'));
      const partial = path.join(outDir, `.${path.basename(req.outPath)}.partial.mp4`);
      try {
        // ---- captions + hook card -> one ASS document --------------------------------------
        let assFile: string | null = null;
        if (req.hook || req.assPath) {
          let doc = req.assPath ? await readFile(req.assPath, 'utf8') : null;
          if (req.hook) {
            const hookDur = Math.min(req.hook.durationSec, Math.max(1.2, duration - 0.3));
            doc = appendHookToAss(
              doc,
              { text: req.hook.text, durationSec: hookDur },
              plan.outW,
              plan.outH,
            );
          }
          assFile = path.join(work, 'overlay.ass');
          await writeFile(assFile, doc ?? '', 'utf8');
        }

        // ---- crop path -> sendcmd ------------------------------------------------------------
        const st = planStages(plan, srcW, srcH);
        const cropPath = new CropPath(
          plan.keyframes,
          plan.cuts,
          { maxX: srcW - st.cropW, maxY: srcH - st.cropH },
          0.5 / targetFps,
        );
        let cmdFile: string | null = null;
        const initial = stageValues(cropPath.at(0), st, srcW, srcH);
        if (!st.isStatic) {
          cmdFile = path.join(work, 'crop.cmd');
          await writeFile(
            cmdFile,
            buildCropCommands(cropPath, st, srcW, srcH, duration, targetFps),
            'utf8',
          );
        }

        // ---- audio: measure then normalise ---------------------------------------------------
        let audioFilter: string | null = null;
        if (info.hasAudio) {
          report(0.01, 'Measuring loudness');
          const measured = await measureLoudness(
            req.ffmpegPath,
            req.sourcePath,
            req.startSec,
            duration,
            req.loudnessTarget,
            signal,
          );
          audioFilter = buildAudioFilter(measured, req.loudnessTarget, duration);
        }
        report(0.05, 'Rendering');

        // ---- the render ------------------------------------------------------------------------
        const vf = buildVideoFilter({
          plan,
          srcW,
          srcH,
          cmdFile,
          initial,
          fps: forceFps ? fpsArg(targetFps) : null,
          assFile,
          fontsDir: req.fontsDir,
        });
        const args = [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'warning',
          '-y',
          '-ss',
          req.startSec.toFixed(3),
          '-t',
          duration.toFixed(3),
          '-i',
          req.sourcePath,
          '-map',
          '0:v:0',
          ...(audioFilter ? ['-map', '0:a:0'] : ['-an']),
          '-vf',
          vf,
          ...(audioFilter ? ['-af', audioFilter] : []),
          ...encoderArgs(encoder, targetFps),
          '-pix_fmt',
          'yuv420p',
          '-fps_mode',
          'cfr',
          ...(audioFilter ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
          '-t',
          duration.toFixed(3),
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          '-f',
          'mp4',
          partial,
        ];
        const res = await runFfmpeg(req.ffmpegPath, args, {
          signal,
          onOutTime: (sec) => report(0.05 + 0.95 * Math.min(0.999, sec / duration)),
        });
        if (res.code !== 0) {
          throw new RenderError(
            `ffmpeg (${encoder}) failed with exit code ${res.code}:\n${lastLines(res.stderr)}`,
            lastLines(res.stderr),
          );
        }
        await rename(partial, req.outPath).catch(async () => {
          await copyFile(partial, req.outPath); // cross-device
          await rm(partial, { force: true });
        });
        report(1, 'Render complete');
        return { encoder, durationSec: duration };
      } catch (err) {
        await rm(partial, { force: true }).catch(() => undefined);
        if (err instanceof RenderAbortError) throw err;
        throw err;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
