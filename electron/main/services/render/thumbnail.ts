/** Clip thumbnail: the sharpest frame around ~1.5 s in (or one third of a very short clip). */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { lastLines, probeStreams, RenderError, runFfmpeg } from './ffmpeg';

const PROBE_W = 180;

/** Variance of a 4-neighbour Laplacian over an 8-bit grayscale image (higher = sharper). */
export function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        4 * (gray[i] ?? 0) -
        (gray[i - 1] ?? 0) -
        (gray[i + 1] ?? 0) -
        (gray[i - w] ?? 0) -
        (gray[i + w] ?? 0);
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * Writes a JPEG (max 720x1280, aspect preserved) of the sharpest of 8 frames sampled over 1.4 s
 * starting ~1.5 s into the clip (or at one third of the clip when it is shorter than 4.5 s).
 * Note the hook card is burned into the first seconds; pass `opts.atSec` (e.g. 3.5) to avoid it.
 */
export async function extractThumbnail(
  ffmpegPath: string,
  clipPath: string,
  outJpg: string,
  opts: { atSec?: number } = {},
): Promise<void> {
  const info = await probeStreams(ffmpegPath, clipPath);
  const dur = info.durationSec ?? 0;
  const nominal =
    opts.atSec !== undefined
      ? Math.min(opts.atSec, Math.max(0, dur - 0.5))
      : Math.min(1.5, dur / 3);
  const t0 = Math.max(0, nominal);
  const span = Math.max(0.2, Math.min(1.4, dur - t0 - 0.1));

  let best = t0;
  try {
    const probe = await runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-ss',
        t0.toFixed(3),
        '-t',
        span.toFixed(3),
        '-i',
        clipPath,
        '-vf',
        `fps=5,scale=${PROBE_W}:-2,format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { captureStdout: true, timeoutMs: 30_000 },
    );
    const w = PROBE_W;
    const h = info.width && info.height ? 2 * Math.round((w * info.height) / info.width / 2) : 0;
    if (probe.code === 0 && h > 0) {
      const frameSize = w * h;
      const n = Math.floor(probe.stdout.length / frameSize);
      let bestScore = -1;
      for (let i = 0; i < n; i++) {
        const frame = probe.stdout.subarray(i * frameSize, (i + 1) * frameSize);
        const score = laplacianVariance(frame, w, h);
        if (score > bestScore) {
          bestScore = score;
          best = t0 + i * 0.2;
        }
      }
    }
  } catch {
    // sharpness probing is best-effort: fall back to the nominal time
  }

  await mkdir(path.dirname(outJpg), { recursive: true });
  const r = await runFfmpeg(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      best.toFixed(3),
      '-i',
      clipPath,
      '-frames:v',
      '1',
      '-vf',
      "scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
      '-q:v',
      '3',
      outJpg,
    ],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) throw new RenderError('Thumbnail extraction failed', lastLines(r.stderr));
}
