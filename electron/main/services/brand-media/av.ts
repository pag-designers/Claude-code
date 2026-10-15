/**
 * Videos (intros, outros, B-roll) and audio (music beds, SFX): validation, probing, 480p previews, thumbnails and
 * EBU R128 loudness (measure + a normalised audition copy).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProcessedBrandAsset } from '../../pipeline/contracts4';
import { proxyHeight } from '../media/ffmpeg';
import {
  BrandMediaError,
  atomicOut,
  baseName,
  makeThumbJpeg,
  measureLoudness,
  probeFile,
  rmQuiet,
  runFf,
  unreadable,
  type FfCtx,
  type Loudness,
} from './ffutil';

export const TARGET_LUFS = -14;
/** Peak ceiling of the audition copy (dBTP). */
export const TARGET_TP = -1;

export interface AvArgs {
  file: string;
  ext: string;
  outDir: string;
  signal?: AbortSignal;
  stage: (name: string, fraction: number | null) => void;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export async function processVideo(ctx: FfCtx, a: AvArgs): Promise<ProcessedBrandAsset> {
  const what = a.ext === 'mov' ? 'MOV video' : a.ext === 'webm' ? 'WEBM video' : 'MP4 video';
  a.stage('Reading video', null);
  const probed = await probeFile(ctx, a.file, a.signal);
  if (!probed) throw unreadable(a.file, what);
  const info = probed.info;
  if (!info.hasVideo || !info.width || !info.height) {
    throw new BrandMediaError(
      info.hasAudio
        ? `'${baseName(a.file)}' has no video track, only audio. Add it to the Audio section instead.`
        : `Clipfern could not read '${baseName(a.file)}'. Is it a valid ${what}?`,
    );
  }
  if (!(info.durationSec > 0)) {
    throw new BrandMediaError(`Clipfern could not read the length of '${baseName(a.file)}'.`);
  }
  const duration = info.durationSec;

  // a full decode of the first seconds catches files whose container is fine but whose stream is broken
  try {
    await runFf(
      ctx,
      ['-xerror', '-i', a.file, '-map', '0:v:0', '-frames:v', '2', '-f', 'null', '-'],
      { signal: a.signal },
    );
  } catch (e) {
    if (isAbort(e)) throw e;
    ctx.log(`[brand-media] video decode failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  let loudness: Loudness | null = null;
  if (info.hasAudio) {
    a.stage('Measuring loudness', 0);
    try {
      loudness = await measureLoudness(ctx, a.file, {
        durationSec: duration,
        signal: a.signal,
        onFraction: (f) => a.stage('Measuring loudness', f),
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      ctx.log(`[brand-media] loudness measurement failed: ${(e as Error).message}`);
    }
  }

  a.stage('Creating thumbnail', null);
  const thumb = path.join(a.outDir, 'thumb.jpg');
  try {
    await makeThumbJpeg(ctx, {
      input: a.file,
      out: thumb,
      seekSec: duration * 0.25,
      signal: a.signal,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    ctx.log(`[brand-media] thumbnail failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  const out = path.join(a.outDir, 'preview.mp4');
  a.stage('Creating preview', 0);
  const h = proxyHeight(info.height, 480);
  try {
    await atomicOut(out, (tmp) =>
      runFf(
        ctx,
        [
          '-i',
          a.file,
          '-map',
          '0:v:0',
          ...(info.hasAudio ? ['-map', '0:a:0'] : []),
          '-vf',
          `scale=-2:${h},format=yuv420p`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          tmp,
        ],
        {
          signal: a.signal,
          durationSec: duration,
          onFraction: (f) => a.stage('Creating preview', f),
        },
      ).then(() => undefined),
    );
  } catch (e) {
    if (isAbort(e)) throw e;
    ctx.log(`[brand-media] preview failed: ${(e as Error).message}`);
    throw new BrandMediaError(
      `Clipfern could not convert '${baseName(a.file)}' for preview. Is it a valid ${what}?`,
    );
  }

  return {
    width: info.width,
    height: info.height,
    durationSec: duration,
    hasAudio: info.hasAudio,
    fps: info.fps,
    loudnessLufs: loudness ? round1(loudness.inputI) : null,
    font: null,
    usable: null,
    preview: { path: out, ext: 'mp4', contentType: 'video/mp4' },
    thumb: { path: thumb },
  };
}

/** How far the audition copy may be from the target before it is re-rendered (LU). */
const LOUDNESS_TOLERANCE = 1;

export async function processAudio(ctx: FfCtx, a: AvArgs): Promise<ProcessedBrandAsset> {
  const what = a.ext.toUpperCase() + ' audio file';
  a.stage('Reading audio', null);
  const probed = await probeFile(ctx, a.file, a.signal);
  if (!probed) throw unreadable(a.file, what);
  const info = probed.info;
  if (!info.hasAudio) {
    throw new BrandMediaError(
      info.hasVideo
        ? `'${baseName(a.file)}' has no audio track. Add it to the Videos section instead.`
        : `Clipfern could not read '${baseName(a.file)}'. Is it a valid ${what}?`,
    );
  }
  if (!(info.durationSec > 0)) {
    throw new BrandMediaError(`Clipfern could not read the length of '${baseName(a.file)}'.`);
  }
  const duration = info.durationSec;

  a.stage('Measuring loudness', 0);
  let measured: Loudness | null;
  try {
    measured = await measureLoudness(ctx, a.file, {
      durationSec: duration,
      signal: a.signal,
      onFraction: (f) => a.stage('Measuring loudness', f),
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    ctx.log(`[brand-media] loudness measurement failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  const out = path.join(a.outDir, 'preview.m4a');
  a.stage('Creating preview', 0);
  try {
    await normaliseTo(ctx, a, { src: a.file, out, measured, duration });
  } catch (e) {
    if (isAbort(e)) throw e;
    ctx.log(`[brand-media] audio preview failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  return {
    width: null,
    height: null,
    durationSec: duration,
    hasAudio: true,
    fps: null,
    loudnessLufs: measured ? round1(measured.inputI) : null,
    font: null,
    usable: null,
    preview: { path: out, ext: 'm4a', contentType: 'audio/mp4' },
    thumb: null,
  };
}

function loudnormFilter(m: Loudness, targetI: number, tp: number): string {
  // linear=true applies one constant gain (no pumping); it needs measured LRA <= the LRA target, else loudnorm
  // silently falls back to its dynamic mode.
  const lra = Math.min(50, Math.max(11, Math.ceil(m.inputLra) + 1));
  return (
    `loudnorm=I=${targetI.toFixed(2)}:TP=${tp.toFixed(2)}:LRA=${lra}` +
    `:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}` +
    `:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=summary`
  );
}

/**
 * Renders the −14 LUFS / TP ≤ −1 AAC audition copy, then MEASURES the result and tries again (up to 5 renders) when it
 * is off by more than ±1 LU or peaks above the ceiling (AAC can overshoot a limiter by a dB on short hits):
 *   1-2  measured linear loudnorm (one constant gain, no pumping);
 *   3-5  the exact gain plus a peak limiter whose ceiling is lowered by the observed overshoot. Material whose
 *        peaks sit too far above its loudness cannot reach −14 LUFS under a −1 dBTP ceiling at all.
 * The best render wins: the peak ceiling is a hard limit (a copy over it is only used when nothing else is), then
 * the smallest loudness error. Silent input is just encoded.
 */
async function normaliseTo(
  ctx: FfCtx,
  a: AvArgs,
  p: { src: string; out: string; measured: Loudness | null; duration: number },
): Promise<void> {
  const candidate = (k: number): string => p.out.replace(/\.m4a$/, `.try${k}.m4a`);
  const render = (
    to: string,
    filter: string | null,
    onFrac: (f: number | null) => void,
  ): Promise<void> =>
    atomicOut(to, (tmp) =>
      runFf(
        ctx,
        [
          '-i',
          p.src,
          '-map',
          '0:a:0',
          '-vn',
          ...(filter ? ['-af', filter] : []),
          '-ar',
          '48000',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          '-f',
          'ipod',
          tmp,
        ],
        { signal: a.signal, durationSec: p.duration, onFraction: onFrac },
      ).then(() => undefined),
    );

  if (!p.measured) {
    await render(p.out, null, (f) => a.stage('Creating preview', f));
    return;
  }
  const MAX_ATTEMPTS = 5;
  let targetI = TARGET_LUFS;
  let tp = TARGET_TP - 0.5;
  let gainDb = TARGET_LUFS - p.measured.inputI;
  let ceilingDb = TARGET_TP - 1;
  let best: { file: string; cost: number } | null = null;
  const tried: string[] = [];
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const file = candidate(attempt);
      tried.push(file);
      const filter =
        attempt < 2
          ? loudnormFilter(p.measured, targetI, tp)
          : `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${(10 ** (ceilingDb / 20)).toFixed(4)}:attack=2:release=60:level=disabled`;
      await render(file, filter, (f) => a.stage('Creating preview', f));
      a.stage('Verifying loudness', 0);
      const got = await measureLoudness(ctx, file, {
        durationSec: p.duration,
        signal: a.signal,
        onFraction: (f) => a.stage('Verifying loudness', f),
      });
      if (!got) {
        best = { file, cost: 0 };
        break;
      }
      const err = got.inputI - TARGET_LUFS;
      const over = Math.max(0, got.inputTp - TARGET_TP);
      ctx.log(
        `[brand-media] audition copy ${baseName(p.src)}: ${got.inputI.toFixed(1)} LUFS, ${got.inputTp.toFixed(1)} dBTP (attempt ${attempt + 1})`,
      );
      const cost = Math.abs(err) + 10 * over;
      if (!best || cost < best.cost) best = { file, cost };
      if (Math.abs(err) <= LOUDNESS_TOLERANCE && over === 0) break;
      // fold the observation into the next attempt
      targetI = Math.max(-40, Math.min(-6, targetI - err));
      tp = Math.max(-6, tp - Math.max(0.5, over + 0.5));
      gainDb = Math.min(60, gainDb - err * (attempt < 2 ? 0 : 0.9));
      if (over > 0) ceilingDb = Math.max(-12, ceilingDb - over - 0.3);
    }
    if (!best) throw new BrandMediaError('Audio normalisation produced no output.');
    await fs.promises.rename(best.file, p.out);
  } finally {
    await rmQuiet(...tried.filter((t) => t !== best?.file));
  }
}
