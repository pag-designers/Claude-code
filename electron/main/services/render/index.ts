/**
 * RenderService (BRIEF §4.13): one FFmpeg invocation per clip / highlight reel.
 *
 *   single layout : input-seek (-ss/-t before -i) -> [fps] -> sendcmd-driven two-stage crop (reframe path)
 *                   -> lanczos scale -> ass (captions + hook)                         (CP1, unchanged)
 *   split / screen-face : the same decoded stream feeds one crop pipeline per panel -> vstack/hstack ->
 *                   divider -> ass                                                    (CP2, layouts.ts)
 *   highlight     : N inputs (one per segment, each with its own plan + ASS) -> xfade / concat -> hook card;
 *                   audio acrossfade, loudness normalised ONCE on the joined audio                (stitch.ts)
 *   audio         : loudnorm pass 1 (measure) -> pass 2 linear to the target LUFS, TP <= -1.5 dBTP, AAC 192k
 *   H.264 yuv420p +faststart (NVENC / VideoToolbox when they really work, else libx264 veryfast crf 20)
 */
import { copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CommonOpts,
  HighlightRenderRequest,
  RenderRequest,
  RenderService,
} from '../../pipeline/contracts';
import { appendHookToAss } from '../captions/hook';
import {
  buildAudioFilter,
  measureLoudness,
  measureLoudnessGraph,
  type LoudnormMeasure,
} from './audio';
import { detectEncoder, encoderArgs, type EncoderName } from './encoder';
import {
  lastLines,
  probeStreams,
  RenderAbortError,
  RenderError,
  runFfmpeg,
  type StreamInfo,
} from './ffmpeg';
import {
  buildCropCommands,
  buildMultiCropCommands,
  buildVideoFilter,
  CropPath,
  escapeFilterPath,
  planStages,
  stageValues,
} from './filters';
import { buildLayoutGraph, isPanelLayout, panelCommandInputs, preparePanels } from './layouts';
import {
  audioStitchGraph,
  effectiveTransitionSec,
  segmentAudioChain,
  stitchedDuration,
  videoStitchGraph,
} from './stitch';
import type { ReframePlan } from '@shared/pipeline';

export { extractThumbnail, laplacianVariance } from './thumbnail';
export { createThumbnailService } from '../thumbnails';
export { detectEncoder, encoderArgs, canEncode, clearEncoderCache } from './encoder';
export type { EncoderName } from './encoder';
export { buildAudioFilter, parseLoudnormJson, measureLoudness } from './audio';
export {
  buildCropCommands,
  buildMultiCropCommands,
  buildVideoFilter,
  CropPath,
  escapeFilterPath,
  planStages,
  stagesFor,
  stageValues,
} from './filters';
export {
  buildLayoutGraph,
  DIVIDER_PX,
  facePanelChain,
  isPanelLayout,
  panelCommandInputs,
  preparePanels,
  screenPanelGraph,
  screenRegion,
  stackSpec,
} from './layouts';
export {
  audioStitchGraph,
  DEFAULT_TRANSITION_SEC,
  effectiveTransitionSec,
  segmentAudioChain,
  stitchedDuration,
  videoStitchGraph,
  XFADE_NAME,
} from './stitch';
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
  const scaleKfs = (ks: ReframePlan['keyframes']): ReframePlan['keyframes'] =>
    ks.map((k) => ({
      t: k.t,
      x: k.x * sx,
      y: k.y * sy,
      w: Math.min(srcW, ev(k.w * sx)),
      h: Math.min(srcH, ev(k.h * sy)),
    }));
  return {
    ...plan,
    srcW,
    srcH,
    keyframes: scaleKfs(plan.keyframes),
    panels: plan.panels?.map((p) => ({ ...p, keyframes: scaleKfs(p.keyframes) })),
  };
}

function validatePlan(plan: ReframePlan): void {
  if (plan.keyframes.length === 0) throw new RenderError('The reframe plan has no keyframes.');
  if (!(plan.outW > 0 && plan.outH > 0))
    throw new RenderError('The reframe plan has no output size.');
  if (plan.layout === 'split' || plan.layout === 'screen-face') {
    if (!plan.panels || plan.panels.length < 2) {
      throw new RenderError(`The '${plan.layout}' layout needs at least two panels.`);
    }
    for (const p of plan.panels) {
      if (p.keyframes.length === 0) throw new RenderError('A reframe panel has no keyframes.');
    }
  }
}

function validate(req: RenderRequest): void {
  if (!(req.endSec > req.startSec) || !Number.isFinite(req.startSec) || req.startSec < 0) {
    throw new RenderError(`Invalid clip range ${req.startSec}..${req.endSec}`);
  }
  validatePlan(req.plan);
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

interface SourceCtx {
  info: StreamInfo;
  srcW: number;
  srcH: number;
  encoder: EncoderName;
  targetFps: number;
  forceFps: boolean;
}

/** Probes the source and decides encoder + frame rate (keep the source rate, cap at 60). */
async function openSource(
  req: {
    ffmpegPath: string;
    sourcePath: string;
    encoder: RenderRequest['encoder'];
    fps: number | null;
  },
  planSize: { srcW: number; srcH: number },
  signal?: AbortSignal,
): Promise<SourceCtx> {
  const info = await probeStreams(req.ffmpegPath, req.sourcePath, signal);
  if (!info.hasVideo) throw new RenderError('The source file has no video stream.');
  const encoder: EncoderName =
    req.encoder === 'auto' ? await detectEncoder(req.ffmpegPath) : req.encoder;
  const srcFps = info.fps ?? info.tbr ?? 30;
  const targetFps = Math.min(MAX_FPS, req.fps ?? srcFps);
  const vfr = info.tbr !== null && info.fps !== null && Math.abs(info.tbr - info.fps) > 0.5;
  const forceFps = req.fps !== null || srcFps > MAX_FPS || vfr;
  return {
    info,
    srcW: info.width ?? planSize.srcW,
    srcH: info.height ?? planSize.srcH,
    encoder,
    targetFps,
    forceFps,
  };
}

interface SegmentGraphInput {
  index: number;
  inLabel: string;
  outLabel: string;
  plan: ReframePlan;
  srcW: number;
  srcH: number;
  targetFps: number;
  forceFps: boolean;
  assFile: string | null;
  fontsDir: string | null;
  work: string;
  duration: number;
}

/** One labelled video chain `[inLabel] ... [outLabel]` for a clip/segment (any layout), plus its sendcmd file. */
async function segmentGraph(c: SegmentGraphInput): Promise<string> {
  const tag = `s${c.index}_`;
  const fps = c.forceFps ? fpsArg(c.targetFps) : null;
  if (isPanelLayout(c.plan)) {
    const panels = preparePanels(c.plan, c.srcW, c.srcH, c.targetFps, tag);
    const cmds = panelCommandInputs(panels);
    let cmdFile: string | null = null;
    if (cmds.length > 0) {
      cmdFile = path.join(c.work, `crop-${c.index}.cmd`);
      await writeFile(
        cmdFile,
        buildMultiCropCommands(cmds, c.srcW, c.srcH, c.duration, c.targetFps),
        'utf8',
      );
    }
    return buildLayoutGraph({
      plan: c.plan,
      srcW: c.srcW,
      srcH: c.srcH,
      inLabel: c.inLabel,
      outLabel: c.outLabel,
      tag,
      fps,
      rate: c.targetFps,
      cmdFile,
      panels,
      assFile: c.assFile,
      fontsDir: c.fontsDir,
    });
  }
  const st = planStages(c.plan, c.srcW, c.srcH);
  const cropPath = new CropPath(
    c.plan.keyframes,
    c.plan.cuts,
    { maxX: c.srcW - st.cropW, maxY: c.srcH - st.cropH },
    0.5 / c.targetFps,
  );
  const initial = stageValues(cropPath.at(0), st, c.srcW, c.srcH);
  let cmdFile: string | null = null;
  if (!st.isStatic) {
    cmdFile = path.join(c.work, `crop-${c.index}.cmd`);
    await writeFile(
      cmdFile,
      buildCropCommands(cropPath, st, c.srcW, c.srcH, c.duration, c.targetFps, tag),
      'utf8',
    );
  }
  const vf = buildVideoFilter({
    plan: c.plan,
    srcW: c.srcW,
    srcH: c.srcH,
    cmdFile,
    initial,
    fps,
    assFile: c.assFile,
    fontsDir: c.fontsDir,
    tag,
  });
  return `[${c.inLabel}]${vf}[${c.outLabel}]`;
}

/** Runs the final encode into a partial file and moves it into place; removes the partial on failure. */
async function encodeToFile(
  ffmpegPath: string,
  args: string[],
  partial: string,
  outPath: string,
  encoder: EncoderName,
  durationSec: number,
  report: (f: number | null, msg?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await runFfmpeg(ffmpegPath, args, {
      signal,
      onOutTime: (sec) => report(0.05 + 0.95 * Math.min(0.999, sec / durationSec)),
    });
    if (res.code !== 0) {
      throw new RenderError(
        `ffmpeg (${encoder}) failed with exit code ${res.code}:\n${lastLines(res.stderr)}`,
        lastLines(res.stderr),
      );
    }
    await rename(partial, outPath).catch(async () => {
      await copyFile(partial, outPath); // cross-device
      await rm(partial, { force: true });
    });
  } catch (err) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
}

const makeReporter =
  (onProgress: CommonOpts['onProgress']) =>
  (f: number | null, msg?: string): void => {
    if (!onProgress) return;
    if (f === null) onProgress(null, msg);
    else onProgress(Math.max(0, Math.min(1, f)), msg);
  };

type AnyRequest<T> = T & CommonOpts;

export function createRenderService(): RenderService {
  return {
    detectEncoder: (ffmpegPath) => detectEncoder(ffmpegPath),

    async render(req: AnyRequest<RenderRequest>) {
      validate(req);
      const { signal } = req;
      const duration = req.endSec - req.startSec;
      const report = makeReporter(req.onProgress);
      if (!(await exists(req.sourcePath)))
        throw new RenderError(`Source video not found: ${req.sourcePath}`);
      if (req.assPath && !(await exists(req.assPath))) {
        throw new RenderError(`Caption file not found: ${req.assPath}`);
      }
      report(0, 'Preparing render');

      const src = await openSource(req, req.plan, signal);
      const { info, srcW, srcH, encoder, targetFps, forceFps } = src;
      const plan = fitPlanToSource(req.plan, srcW, srcH);

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

        // ---- video: classic single crop (-vf) or a multi-panel graph (-filter_complex) ----------
        let videoArgs: string[];
        if (isPanelLayout(plan)) {
          const graph = await segmentGraph({
            index: 0,
            inLabel: '0:v:0',
            outLabel: 'vout',
            plan,
            srcW,
            srcH,
            targetFps,
            forceFps,
            assFile,
            fontsDir: req.fontsDir,
            work,
            duration,
          });
          videoArgs = ['-filter_complex', graph, '-map', '[vout]'];
        } else {
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
          videoArgs = ['-map', '0:v:0', '-vf', vf];
        }
        report(0.05, 'Rendering');

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
          ...videoArgs,
          ...(audioFilter ? ['-map', '0:a:0', '-af', audioFilter] : ['-an']),
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
        await encodeToFile(
          req.ffmpegPath,
          args,
          partial,
          req.outPath,
          encoder,
          duration,
          report,
          signal,
        );
        report(1, 'Render complete');
        return { encoder, durationSec: duration };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async renderHighlight(req: AnyRequest<HighlightRenderRequest>) {
      const { signal } = req;
      const report = makeReporter(req.onProgress);
      const segs = req.segments;
      if (segs.length === 0) throw new RenderError('A highlight needs at least one segment.');
      for (const s of segs) {
        if (!(s.endSec > s.startSec) || !Number.isFinite(s.startSec) || s.startSec < 0) {
          throw new RenderError(`Invalid segment range ${s.startSec}..${s.endSec}`);
        }
        validatePlan(s.plan);
        if (s.assPath && !(await exists(s.assPath))) {
          throw new RenderError(`Caption file not found: ${s.assPath}`);
        }
      }
      const first = segs[0];
      if (!first) throw new RenderError('A highlight needs at least one segment.');
      if (segs.some((s) => s.plan.outW !== first.plan.outW || s.plan.outH !== first.plan.outH)) {
        throw new RenderError('All highlight segments must have the same output size.');
      }
      if (!(await exists(req.sourcePath)))
        throw new RenderError(`Source video not found: ${req.sourcePath}`);
      report(0, 'Preparing highlight');

      const src = await openSource(req, first.plan, signal);
      const { info, srcW, srcH, encoder, targetFps } = src;
      const durations = segs.map((s) => s.endSec - s.startSec);
      const T = effectiveTransitionSec(req.transition, req.transitionSec, durations);
      const total = stitchedDuration(durations, T);
      const outW = first.plan.outW;
      const outH = first.plan.outH;

      const outDir = path.dirname(req.outPath);
      const work = await mkdtemp(path.join(outDir, '.clipfern-render-'));
      const partial = path.join(outDir, `.${path.basename(req.outPath)}.partial.mp4`);
      try {
        // inputs: one seek per segment
        const inputArgs: string[] = [];
        for (const [i, s] of segs.entries()) {
          inputArgs.push(
            '-ss',
            s.startSec.toFixed(3),
            '-t',
            (durations[i] ?? 0).toFixed(3),
            '-i',
            req.sourcePath,
          );
        }

        // ---- video: per-segment chains (own plan + ASS) -> stitch -> hook card --------------------
        const chains: string[] = [];
        const labels: string[] = [];
        for (const [i, s] of segs.entries()) {
          const plan = fitPlanToSource(s.plan, srcW, srcH);
          chains.push(
            await segmentGraph({
              index: i,
              inLabel: `${i}:v:0`,
              outLabel: `v${i}`,
              plan,
              srcW,
              srcH,
              targetFps,
              forceFps: true,
              assFile: s.assPath,
              fontsDir: req.fontsDir,
              work,
              duration: durations[i] ?? 0,
            }),
          );
          labels.push(`v${i}`);
        }
        let videoOut = 'vst';
        chains.push(videoStitchGraph(labels, durations, req.transition, T, videoOut));
        if (req.hook) {
          const hookDur = Math.min(req.hook.durationSec, Math.max(1.2, total - 0.3));
          const doc = appendHookToAss(
            null,
            { text: req.hook.text, durationSec: hookDur },
            outW,
            outH,
          );
          const hookFile = path.join(work, 'hook.ass');
          await writeFile(hookFile, doc, 'utf8');
          let ass = `ass=filename=${escapeFilterPath(hookFile)}`;
          if (req.fontsDir) ass += `:fontsdir=${escapeFilterPath(req.fontsDir)}`;
          chains.push(`[${videoOut}]${ass},format=yuv420p[vhook]`);
          videoOut = 'vhook';
        }

        // ---- audio: join (acrossfade / concat), measure ONCE, normalise ---------------------------
        let audioGraph: string | null = null;
        let audioOut = 'aout';
        if (info.hasAudio) {
          const aLabels = segs.map((_, i) => `a${i}`);
          const aParts = segs.map((_, i) =>
            segmentAudioChain(i, durations[i] ?? 0, req.transition === 'cut' || T === 0),
          );
          aParts.push(audioStitchGraph(aLabels, req.transition, T, audioOut));
          const joined = aParts.join(';');
          report(0.01, 'Measuring loudness');
          const measured: LoudnormMeasure | null = await measureLoudnessGraph(
            req.ffmpegPath,
            inputArgs,
            joined,
            audioOut,
            req.loudnessTarget,
            signal,
          );
          audioGraph = `${joined};[${audioOut}]${buildAudioFilter(measured, req.loudnessTarget, total)}[afinal]`;
        }
        report(0.05, 'Rendering');

        const args = [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'warning',
          '-y',
          ...inputArgs,
          '-filter_complex',
          [...chains, ...(audioGraph ? [audioGraph] : [])].join(';\n'),
          '-map',
          `[${videoOut}]`,
          ...(audioGraph ? ['-map', '[afinal]'] : ['-an']),
          ...encoderArgs(encoder, targetFps),
          '-pix_fmt',
          'yuv420p',
          '-fps_mode',
          'cfr',
          ...(audioGraph ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
          '-t',
          total.toFixed(3),
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          '-f',
          'mp4',
          partial,
        ];
        await encodeToFile(
          req.ffmpegPath,
          args,
          partial,
          req.outPath,
          encoder,
          total,
          report,
          signal,
        );
        report(1, 'Render complete');
        return { encoder, durationSec: total };
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
