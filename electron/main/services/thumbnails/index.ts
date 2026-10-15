/**
 * ThumbnailService (BRIEF §4.12, contracts2.ts): candidate frames from a RENDERED clip, scoring through the
 * sidecar's /frames/score (sharpness + face + composition), and the text-overlay composer.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ThumbnailService } from '../../pipeline/contracts2';
import { lastLines, probeStreams, RenderError, runFfmpeg } from '../render/ffmpeg';
import { escapeFilterPath } from '../render/filters';
import { buildThumbAss } from './compose';
import { candidateTimes, parseRmsSeries, scoreMeasurements } from './score';

export {
  buildThumbAss,
  layoutThumbText,
  thumbWords,
  wrapWords,
  THUMB_FONT,
  MAX_WORDS,
} from './compose';
export {
  candidateTimes,
  compositionScore,
  exposureScore,
  faceScore,
  faceSizeScore,
  mainFace,
  parseRmsSeries,
  scoreMeasurements,
  sharpnessAbsolute,
  sharpnessScores,
  WEIGHTS,
} from './score';

const DEFAULT_MAX_WIDTH = 720;

/** RMS level (dBFS) per 0.25 s window of the clip's audio; empty when it has none. */
async function audioLevels(
  ffmpegPath: string,
  clipPath: string,
  signal?: AbortSignal,
): Promise<{ t: number; db: number }[]> {
  try {
    const r = await runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        clipPath,
        '-vn',
        '-af',
        'aresample=8000,asetnsamples=n=2000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
        '-f',
        'null',
        '-',
      ],
      { signal, captureStdout: true, timeoutMs: 60_000 },
    );
    return r.code === 0 ? parseRmsSeries(r.stdout.toString('utf8')) : [];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return []; // no audio / unreadable: an even spread is fine
  }
}

export function createThumbnailService(): ThumbnailService {
  return {
    async sample(args) {
      const { ffmpegPath, clipPath, durationSec, hookSeconds, count, outDir, signal } = args;
      await mkdir(outDir, { recursive: true });
      const dur = Math.max(0.5, durationSec);
      // skip the hook-card window (the card is burned into the first seconds) and the last half second
      let from = Math.max(hookSeconds + 0.25, 0.5);
      const to = Math.max(0.3, dur - 0.4);
      if (to - from < Math.min(2, dur / 2)) from = Math.min(dur * 0.3, Math.max(0.1, to - 1));
      const levels = await audioLevels(ffmpegPath, clipPath, signal);
      const times = candidateTimes(from, to, Math.max(1, count), levels);
      const out: { t: number; file: string }[] = [];
      for (const [i, t] of times.entries()) {
        const file = path.join(outDir, `cand-${String(i).padStart(2, '0')}.jpg`);
        const r = await runFfmpeg(
          ffmpegPath,
          [
            '-hide_banner',
            '-nostdin',
            '-loglevel',
            'error',
            '-y',
            '-ss',
            t.toFixed(3),
            '-i',
            clipPath,
            '-frames:v',
            '1',
            '-q:v',
            '2',
            file,
          ],
          { signal, timeoutMs: 30_000 },
        );
        if (r.code !== 0) {
          throw new RenderError(
            `Could not extract a frame at ${t.toFixed(2)} s`,
            lastLines(r.stderr),
          );
        }
        out.push({ t, file });
      }
      return out;
    },

    async score(frames, scorer, signal) {
      if (frames.length === 0) return [];
      const measured = await scorer(
        frames.map((f) => f.file),
        signal,
      );
      if (measured.length !== frames.length) {
        throw new RenderError(
          `The frame scorer returned ${measured.length} results for ${frames.length} frames.`,
        );
      }
      const scores = scoreMeasurements(measured);
      return frames.map((f, i) => ({
        t: f.t,
        file: f.file,
        sharpness: scores[i]?.sharpness ?? 0,
        face: scores[i]?.face ?? 0,
        composition: scores[i]?.composition ?? 0,
        total: scores[i]?.total ?? 0,
      }));
    },

    async compose(args) {
      const { ffmpegPath, framePath, overlayText, fontsDir, outJpg, signal } = args;
      const maxWidth = args.maxWidth ?? DEFAULT_MAX_WIDTH;
      const info = await probeStreams(ffmpegPath, framePath, signal);
      if (!info.width || !info.height)
        throw new RenderError(`Cannot read the image size of ${framePath}`);
      const w = Math.min(maxWidth, info.width);
      const outW = 2 * Math.round(w / 2);
      const outH = 2 * Math.round((outW * info.height) / info.width / 2);
      await mkdir(path.dirname(outJpg), { recursive: true });
      const work = await mkdtemp(path.join(path.dirname(outJpg), '.clipfern-thumb-'));
      try {
        const doc = buildThumbAss(overlayText, outW, outH);
        const filters = [`scale=${outW}:${outH}:flags=lanczos`, 'setsar=1'];
        if (doc) {
          const assFile = path.join(work, 'thumb.ass');
          await writeFile(assFile, doc, 'utf8');
          let ass = `ass=filename=${escapeFilterPath(assFile)}`;
          if (fontsDir) ass += `:fontsdir=${escapeFilterPath(fontsDir)}`;
          filters.push(ass);
        }
        filters.push('format=yuvj420p');
        const r = await runFfmpeg(
          ffmpegPath,
          [
            '-hide_banner',
            '-nostdin',
            '-loglevel',
            'error',
            '-y',
            '-i',
            framePath,
            '-frames:v',
            '1',
            '-vf',
            filters.join(','),
            '-q:v',
            '2',
            outJpg,
          ],
          { signal, timeoutMs: 30_000 },
        );
        if (r.code !== 0)
          throw new RenderError('Thumbnail composition failed', lastLines(r.stderr));
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
