/**
 * Brand finisher (BRIEF §7): ONE extra FFmpeg pass over an already rendered clip.
 *
 *   watermark : logo PNG (alpha) scaled/placed by shared/brand `watermarkRect`, opacity via colorchannelmixer, overlaid on
 *               the clip piece only (before the join), so it is never visible during intro/outro
 *   intro/outro: fitted (contain, black bars, square pixels) to the clip's size, resampled to its fps, audio to 48 kHz
 *               stereo (silence when the file has none), hard-cut joined; every piece is frame-exact
 *   music     : looped/trimmed bed, loudness-referenced then `gainDb`, fades, ducked by the programme audio with
 *               sidechaincompress (20 ms attack / 350 ms release), mixed in, whole mix loudnorm'd (two-pass, linear) to
 *               the target with true peak <= -1.5 dBTP
 *   video     : re-encoded only when a watermark / intro / outro is applied (high quality, the clip is already
 *               compressed once); music-only copies the video stream; nothing requested copies the file
 * Unusable optional pieces are skipped AND reported (`notes`, `applied`); a corrupt clip throws.
 */
import { copyFile, rename, rm } from 'node:fs/promises';
import { watermarkRect } from '@shared/brand';
import type {
  BrandFinisher,
  FinishRequest,
  FinishResult,
  FinisherMedia,
} from '../../pipeline/contracts4';
import type { CommonOpts } from '../../pipeline/contracts';
import { buildAudioFilter, measureLoudness, measureLoudnessGraph } from '../render/audio';
import { encoderArgs, type EncoderName } from '../render/encoder';
import { lastLines, RenderAbortError, RenderError, runFfmpeg } from '../render/ffmpeg';
import {
  buildAudioGraph,
  buildVideoGraph,
  fpsExpression,
  frameAligned,
  SAMPLE_RATE,
  type GraphPlan,
  type PlanPiece,
} from './graph';
import { decodeCheck, probeMedia, type MediaProbe } from './probe';

export { buildAudioGraph, buildVideoGraph, duckThresholdLinear } from './graph';
export type { GraphPlan, PlanPiece } from './graph';

/** How much of an optional piece is decoded up front to catch damaged data (seconds). */
const CHECK_VIDEO_SEC = 30;
const CHECK_AUDIO_SEC = 20;
/** Longest stretch of the music file used to measure its loudness. */
const MUSIC_MEASURE_SEC = 120;
/** The bed is referenced to the target loudness, then `gainDb`; never boost more than this. */
const MAX_BED_BOOST_DB = 36;

/** libx264 crf 17 (the clip was already compressed once); the other encoders get a matching bump. */
export function finishEncoderArgs(enc: EncoderName, fps: number): string[] {
  const a = encoderArgs(enc, fps);
  const set = (key: string, value: string): void => {
    const i = a.indexOf(key);
    if (i >= 0 && i + 1 < a.length) a[i + 1] = value;
  };
  set('-crf', '17');
  set('-cq', '17');
  if (enc === 'h264_videotoolbox') {
    set('-b:v', '16M');
    set('-maxrate', '24M');
  }
  if (enc === 'h264_nvenc') set('-maxrate', '24M');
  return a;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Usable {
  media: FinisherMedia;
  probe: MediaProbe;
}

/** Validates an optional piece; returns null and pushes a note when it cannot be used. */
async function usable(
  label: string,
  media: FinisherMedia,
  need: 'video' | 'audio' | 'image',
  ffmpegPath: string,
  notes: string[],
  signal: AbortSignal | undefined,
): Promise<Usable | null> {
  let probe: MediaProbe;
  try {
    probe = await probeMedia(ffmpegPath, media.path, signal);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    notes.push(`${label} skipped: ${msg(e)}`);
    return null;
  }
  if (need !== 'audio' && !probe.hasVideo) {
    notes.push(`${label} skipped: the file has no video`);
    return null;
  }
  if (need === 'audio' && !probe.hasAudio) {
    notes.push(`${label} skipped: the file has no audio`);
    return null;
  }
  if (need !== 'image' && !((probe.durationSec ?? media.durationSec) > 0.05)) {
    notes.push(`${label} skipped: the file is empty (no duration)`);
    return null;
  }
  const bad = await decodeCheck(ffmpegPath, media.path, {
    seconds: need === 'image' ? 1 : need === 'audio' ? CHECK_AUDIO_SEC : CHECK_VIDEO_SEC,
    video: need !== 'audio',
    audio: need !== 'image',
    signal,
  });
  if (bad) {
    notes.push(`${label} skipped: damaged file (${bad})`);
    return null;
  }
  return { media, probe };
}

export function createBrandFinisher(): BrandFinisher {
  return {
    async finish(
      req: FinishRequest,
      opts?: CommonOpts & { onProgress?: (fraction: number) => void },
    ): Promise<FinishResult> {
      return finish(req, opts?.signal, opts?.onProgress);
    },
  };
}

async function finish(
  req: FinishRequest,
  signal: AbortSignal | undefined,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<FinishResult> {
  const ff = req.ffmpegPath;
  if (signal?.aborted) throw new RenderAbortError();
  if (req.outPath === req.input.path) {
    throw new Error('The finished clip must be written to a different file than the rendered clip');
  }
  let last = -1;
  const report = (f: number): void => {
    const v = Math.min(1, Math.max(0, f));
    if (v - last >= 0.004 || v === 1) {
      last = v;
      onProgress?.(v);
    }
  };
  report(0);

  // ---- the clip itself: unreadable input is an error, not a note -------------------------------------
  let clip: MediaProbe;
  try {
    clip = await probeMedia(ff, req.input.path, signal);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new Error(`The rendered clip could not be read (${req.input.path}): ${msg(e)}`, {
      cause: e,
    });
  }
  if (!clip.hasVideo) throw new Error('The rendered clip has no video stream');
  const canvas = {
    width: clip.width ?? req.input.width,
    height: clip.height ?? req.input.height,
  };
  if (!(canvas.width > 0 && canvas.height > 0))
    throw new Error('The rendered clip has no usable size');
  const clipDur = clip.durationSec ?? req.input.durationSec;
  if (!(clipDur > 0)) throw new Error('The rendered clip has no duration');
  const fpsIn = req.input.fps > 0 ? req.input.fps : (clip.fps ?? 30);
  const { fps, expr: fpsExpr } = fpsExpression(fpsIn);

  // ---- optional pieces ----------------------------------------------------------------------------------
  const notes: string[] = [];
  const logo = req.watermark
    ? await usable('Watermark', req.watermark.media, 'image', ff, notes, signal)
    : null;
  const intro = req.intro ? await usable('Intro', req.intro, 'video', ff, notes, signal) : null;
  const outro = req.outro ? await usable('Outro', req.outro, 'video', ff, notes, signal) : null;
  const bed = req.music ? await usable('Music', req.music.media, 'audio', ff, notes, signal) : null;
  const applied = {
    watermark: logo !== null,
    intro: intro !== null,
    outro: outro !== null,
    music: bed !== null,
  };

  const rebuildVideo = applied.watermark || applied.intro || applied.outro;
  const rebuildAudio = applied.intro || applied.outro || applied.music;

  // ---- nothing to do: hand the clip back untouched --------------------------------------------------------
  const partial = `${req.outPath}.partial`;
  const cleanup = async (): Promise<void> => {
    await rm(partial, { force: true }).catch(() => undefined);
  };
  if (!rebuildVideo && !rebuildAudio) {
    try {
      await copyFile(req.input.path, partial);
      await rename(partial, req.outPath);
    } catch (e) {
      await cleanup();
      throw e;
    }
    report(1);
    return { durationSec: clipDur, applied, notes };
  }

  // ---- plan: inputs (index order), frame-exact pieces ------------------------------------------------------
  const inputArgs: string[][] = [];
  const addInput = (args: string[]): number => inputArgs.push(args) - 1;
  const pieces: PlanPiece[] = [];
  const piece = (kind: PlanPiece['kind'], path: string, dur: number, hasAudio: boolean): void => {
    const fa = frameAligned(dur, fps);
    pieces.push({
      kind,
      inputIndex: addInput(['-i', path]),
      frames: fa.frames,
      sec: fa.sec,
      hasAudio,
    });
  };
  // the clip is always input 0
  const clipFa = frameAligned(clipDur, fps);
  const clipIdx = addInput(['-i', req.input.path]);
  const clipPiece: PlanPiece = {
    kind: 'clip',
    inputIndex: clipIdx,
    frames: clipFa.frames,
    sec: clipFa.sec,
    hasAudio: clip.hasAudio,
  };
  if (intro) {
    piece(
      'intro',
      intro.media.path,
      intro.probe.durationSec ?? intro.media.durationSec,
      intro.probe.hasAudio,
    );
  }
  if (outro) {
    piece(
      'outro',
      outro.media.path,
      outro.probe.durationSec ?? outro.media.durationSec,
      outro.probe.hasAudio,
    );
  }
  const introPiece = pieces.find((p) => p.kind === 'intro');
  const outroPiece = pieces.find((p) => p.kind === 'outro');
  const ordered: PlanPiece[] = [
    ...(introPiece ? [introPiece] : []),
    clipPiece,
    ...(outroPiece ? [outroPiece] : []),
  ];
  const totalSec = ordered.reduce((s, p) => s + p.sec, 0);

  // music: loudness-referenced so `gainDb` means "dB below the programme target" whatever the file's mastering
  let musicPlan: GraphPlan['music'] = null;
  if (bed && req.music) {
    let offset = 0;
    try {
      const m = await measureLoudness(
        ff,
        bed.media.path,
        0,
        Math.min(MUSIC_MEASURE_SEC, bed.probe.durationSec ?? bed.media.durationSec),
        req.loudnessTarget,
        signal,
      );
      if (m) offset = req.loudnessTarget - m.inputI;
      else
        notes.push(
          'Music loudness could not be measured (silent file?); it is used at its own level',
        );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      notes.push(`Music loudness could not be measured (${msg(e)}); it is used at its own level`);
    }
    const musicInput = addInput([
      '-stream_loop',
      '-1',
      '-t',
      totalSec.toFixed(6),
      '-i',
      bed.media.path,
    ]);
    musicPlan = {
      inputIndex: musicInput,
      gainDb: Math.min(MAX_BED_BOOST_DB, offset + req.music.gainDb),
      duckAmountDb: req.music.duckEnabled ? req.music.duckAmountDb : null,
      fadeInSec: req.music.fadeInSec,
      fadeOutSec: req.music.fadeOutSec,
    };
  }
  const audioInputArgs = inputArgs.map((a) => [...a]); // the logo is video-only: not part of the loudness pass

  let wmPlan: GraphPlan['watermark'] = null;
  if (logo && req.watermark) {
    const lw = logo.probe.width ?? logo.media.width;
    const lh = logo.probe.height ?? logo.media.height;
    const rect = watermarkRect(canvas, req.watermark, lw > 0 && lh > 0 ? lw / lh : 1);
    wmPlan = {
      inputIndex: addInput([
        '-loop',
        '1',
        '-framerate',
        fpsExpr,
        '-t',
        (clipFa.sec + 1).toFixed(3),
        '-i',
        logo.media.path,
      ]),
      rect,
      opacity: Math.min(1, Math.max(0, req.watermark.opacity)),
    };
  }

  const plan: GraphPlan = {
    canvas,
    fps,
    fpsExpr,
    pieces: ordered,
    watermark: wmPlan,
    music: musicPlan,
    totalSec,
  };

  // ---- loudness: measure the final mix once, then normalise linearly -------------------------------------
  let audioFilterGraph = '';
  let audioOut = '';
  if (rebuildAudio) {
    const ag = buildAudioGraph(plan);
    report(0.05);
    let measure: Awaited<ReturnType<typeof measureLoudnessGraph>>;
    try {
      measure = await measureLoudnessGraph(
        ff,
        audioInputArgs.flat(),
        ag.graph,
        ag.out,
        req.loudnessTarget,
        signal,
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new Error(`Could not measure the loudness of the finished audio: ${msg(e)}`, {
        cause: e,
      });
    }
    if (!measure) notes.push('The finished audio is silent; loudness was not normalised');
    audioFilterGraph = `${ag.graph};[${ag.out}]${buildAudioFilter(measure, req.loudnessTarget, totalSec)}[aout]`;
    audioOut = 'aout';
  }
  report(0.2);

  let videoGraph = '';
  if (rebuildVideo) videoGraph = buildVideoGraph(plan).graph;

  const graph = [videoGraph, audioFilterGraph].filter((g) => g !== '').join(';');
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    ...inputArgs.flat(),
    '-filter_complex',
    graph,
  ];
  if (rebuildVideo) {
    args.push('-map', '[vout]', ...finishEncoderArgs(req.encoder, fps), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
  }
  if (rebuildAudio) {
    args.push(
      '-map',
      `[${audioOut}]`,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '2',
    );
  } else if (clip.hasAudio) {
    // watermark only: the clip's audio is untouched
    args.push('-map', '0:a:0');
    if (clip.audioCodec === 'aac') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', partial);

  try {
    const r = await runFfmpeg(ff, args, {
      signal,
      onOutTime: (t) => report(0.2 + 0.78 * Math.min(1, t / totalSec)),
    });
    if (r.code !== 0) {
      throw new RenderError('Brand finishing failed (ffmpeg error)', lastLines(r.stderr));
    }
    await rename(partial, req.outPath);
  } catch (e) {
    await cleanup();
    throw e;
  }

  let durationSec: number;
  try {
    const out = await probeMedia(ff, req.outPath, signal);
    if (!out.hasVideo) throw new Error('the output has no video');
    durationSec = out.durationSec ?? totalSec;
  } catch (e) {
    await rm(req.outPath, { force: true }).catch(() => undefined);
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new Error(`Brand finishing produced an unreadable file: ${msg(e)}`, { cause: e });
  }
  report(1);
  return { durationSec, applied, notes };
}
