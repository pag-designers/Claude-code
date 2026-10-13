/**
 * A caption-free still of a clip frame (for thumbnails): thumbnail candidates sampled from a rendered clip
 * have the captions burned in, which collide with the overlay text. This renders ONE second of the same
 * reframed picture (same plan, layout, crop path) without captions / hook card and extracts the frame.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ReframePlan } from '@shared/pipeline';
import type { RenderRequest } from '../../pipeline/contracts';
import { lastLines, RenderError, runFfmpeg } from './ffmpeg';
import { createRenderService } from './index';

/** Linear interpolation of a keyframe path at time t (held outside its range). */
function interpAt(
  ks: ReframePlan['keyframes'],
  t: number,
): ReframePlan['keyframes'][number] | null {
  const s = [...ks].sort((a, b) => a.t - b.t);
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  for (let i = 1; i < s.length; i++) {
    const p = s[i - 1];
    const q = s[i];
    if (p && q && t <= q.t) {
      const f = (t - p.t) / Math.max(1e-9, q.t - p.t);
      return { t, x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, w: p.w, h: p.h };
    }
  }
  return last;
}

/** The part of a plan covering clip-relative [off, off+dur): keyframes and cuts shifted to start at 0. */
export function windowPlan(plan: ReframePlan, off: number, dur: number): ReframePlan {
  const shift = (ks: ReframePlan['keyframes']): ReframePlan['keyframes'] => {
    const a = interpAt(ks, off);
    const b = interpAt(ks, off + dur);
    if (!a || !b) return ks;
    const inside = ks
      .filter((k) => k.t > off + 0.01 && k.t < off + dur - 0.01)
      .map((k) => ({ ...k, t: Math.round((k.t - off) * 1000) / 1000 }));
    return [{ ...a, t: 0 }, ...inside, { ...b, t: dur }];
  };
  return {
    ...plan,
    keyframes: shift(plan.keyframes),
    cuts: plan.cuts.map((c) => c - off).filter((c) => c > 0.05 && c < dur - 0.05),
    panels: plan.panels?.map((p) => ({ ...p, keyframes: shift(p.keyframes) })),
  };
}

export interface CleanFrameRequest {
  ffmpegPath: string;
  sourcePath: string;
  /** Clip start in the source (seconds) and clip-relative time of the wanted frame. */
  startSec: number;
  atSec: number;
  plan: ReframePlan;
  outJpg: string;
  encoder?: RenderRequest['encoder'];
  signal?: AbortSignal;
}

export async function renderCleanFrame(req: CleanFrameRequest): Promise<void> {
  const off = Math.max(0, req.atSec - 0.2);
  const dur = 1.2;
  await mkdir(path.dirname(req.outJpg), { recursive: true });
  const work = await mkdtemp(path.join(path.dirname(req.outJpg), '.clipfern-still-'));
  try {
    const tmp = path.join(work, 'still.mp4');
    await createRenderService().render({
      ffmpegPath: req.ffmpegPath,
      sourcePath: req.sourcePath,
      outPath: tmp,
      startSec: req.startSec + off,
      endSec: req.startSec + off + dur,
      plan: windowPlan(req.plan, off, dur),
      assPath: null,
      fontsDir: null,
      hook: null,
      loudnessTarget: -14,
      encoder: req.encoder ?? 'auto',
      fps: null,
      signal: req.signal,
    });
    const r = await runFfmpeg(
      req.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        (req.atSec - off).toFixed(3),
        '-i',
        tmp,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        req.outJpg,
      ],
      { signal: req.signal, timeoutMs: 30_000 },
    );
    if (r.code !== 0)
      throw new RenderError('Could not extract the clean frame', lastLines(r.stderr));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
