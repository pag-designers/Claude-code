/**
 * Layout analysis (BRIEF §4.7): looks at a few REAL frames of the span (ffmpeg, raw gray frames piped
 * through memory — nothing is written to disk) and decides:
 *   - baked-in letterbox / pillarbox bars (ffmpeg `cropdetect`, applied only when a bar is >= 3%),
 *   - 'screen-face': a screen share with a small, stationary webcam face in a corner / edge,
 *   - 'multi-face': two persistent, well separated faces (with the tiles they sit in),
 *   - 'single-face' / 'none'.
 * The decision is a pure function of the frames and the face samples (`classifyLayout`) so it is unit-tested.
 */
import type { CommonOpts, FaceSample, LayoutHint } from '../../pipeline/contracts';
import { RenderError, runFfmpeg } from '../render/ffmpeg';
import {
  detectTile,
  frameDiff,
  iou,
  regionMotion,
  mergeLetterbox,
  parseCropdetect,
  screenStats,
  type CropRect,
  type GrayFrame,
  type ScreenStats,
} from './frames';
import type { LayoutHintEx, Rect01 } from './hint';
import { buildTracks, pickPair, type FaceTrack } from './tracks';
import { webcamRectFromFace } from './screen';

/** Webcam face must be narrower than this share of the frame width. */
export const SCREEN_FACE_MAX_W = 0.22;
/** Face centre spread (p90-p10) allowed for "roughly stationary", as a share of the frame. */
const STATIONARY_X = 0.04;
const STATIONARY_Y = 0.05;
/** Analysis frame width (px). */
const SAMPLE_W = 640;
const SAMPLE_COUNT = 6;
/** A face track whose box changes less than this (mean gray levels between samples) is not alive. */
export const MIN_FACE_MOTION = 2.5;

export interface LayoutInput {
  frames: GrayFrame[];
  faces: FaceSample[];
  startSec: number;
  endSec: number;
  srcW: number;
  srcH: number;
  /** Letterbox result (already merged), passed through to the hint. */
  contentRect?: Rect01 | null;
}

const none = (extra: Partial<LayoutHintEx> = {}): LayoutHintEx => ({
  kind: 'none',
  faceRegion: null,
  screenRegion: null,
  confidence: 0,
  ...extra,
});

const spread = (a: number[]): number => {
  if (a.length < 2) return 0;
  const s = [...a].sort((x, y) => x - y);
  return (
    (s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] ?? 0) -
    (s[Math.floor(0.1 * s.length)] ?? 0)
  );
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** 0..1: how much the frame content looks like a screen capture (flat UI areas + crisp edges). */
export function screenScore(s: ScreenStats): number {
  const flat = clamp01((s.flatFrac - 0.3) / 0.3);
  const edge = clamp01((s.edgeFrac - 0.012) / 0.03);
  const peak = clamp01((s.peakFrac - 0.3) / 0.35);
  return (flat + edge + peak) / 3;
}

/** Pure decision from sampled frames + face detections. */
export function classifyLayout(inp: LayoutInput): LayoutHintEx {
  const { srcW, srcH } = inp;
  const dur = Math.max(0.1, inp.endSec - inp.startSec);
  const samples = inp.faces
    .filter((f) => f.t >= inp.startSec - 0.25 && f.t < inp.endSec + 0.25)
    .map((f) => ({ t: f.t - inp.startSec, sample: f }))
    .sort((a, b) => a.t - b.t);
  const base: Partial<LayoutHintEx> = { contentRect: inp.contentRect ?? null };
  if (samples.length === 0) return none({ ...base, diagnostics: { reason: 'no face samples' } });
  const trackBox = (t: FaceTrack): Rect01 => ({
    x: (t.cx - t.w / 2) / srcW,
    y: (t.cy - t.h / 2) / srcH,
    w: t.w / srcW,
    h: t.h / srcH,
  });
  // Liveness: a face that never changes between sample frames is a false detection on a static pattern
  // (text, shelves) or a photo, not a person; drop it before deciding anything.
  const allTracks = buildTracks(samples, srcW, srcH);
  const tracks =
    inp.frames.length >= 3
      ? allTracks.filter(
          (t) => (regionMotion(inp.frames, trackBox(t)) ?? Infinity) >= MIN_FACE_MOTION,
        )
      : allTracks;
  const main: FaceTrack | undefined = tracks[0];
  if (!main) {
    return none({
      ...base,
      diagnostics: {
        reason: 'no persistent live face',
        staticTracks: allTracks.length - tracks.length,
      },
    });
  }

  // ---- two faces: multi-face (+ the tiles they sit in) ----------------------------------------------
  const pair = pickPair(tracks);
  if (pair) {
    const tiles: Rect01[] = [];
    for (const fr of inp.frames) {
      for (const t of [pair.a, pair.b]) {
        const tile = detectTile(fr, {
          x: (t.cx - t.w / 2) / srcW,
          y: (t.cy - t.h / 2) / srcH,
          w: t.w / srcW,
          h: t.h / srcH,
        });
        if (tile && !tiles.some((o) => iou(o, tile) > 0.8)) tiles.push(tile);
      }
    }
    return {
      kind: 'multi-face',
      faceRegion: null,
      screenRegion: null,
      confidence: clamp01(Math.min(pair.a.presence, pair.b.presence) + 0.3),
      ...base,
      tiles,
      diagnostics: { faces: tracks.length, horizontal: pair.horizontal },
    };
  }

  // ---- one face: screen + webcam? --------------------------------------------------------------------
  const wFrac = main.w / srcW;
  const hFrac = main.h / srcH;
  const cx = main.cx / srcW;
  const cy = main.cy / srcH;
  const sx = spread(main.obs.map((o) => o.cx)) / srcW;
  const sy = spread(main.obs.map((o) => o.cy)) / srcH;
  const corner = Math.min(cx, 1 - cx) <= 0.25 && Math.min(cy, 1 - cy) <= 0.3;
  const sideEdge = Math.min(cx, 1 - cx) <= 0.14;
  const small = wFrac < SCREEN_FACE_MAX_W && hFrac < 0.4;
  const stationary = sx <= STATIONARY_X && sy <= STATIONARY_Y;
  const cam = webcamRectFromFace(main, srcW, srcH);
  const camN: Rect01 = { x: cam.x / srcW, y: cam.y / srcH, w: cam.w / srcW, h: cam.h / srcH };
  const stats = inp.frames.map((f) => screenStats(f, camN));
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0;
  const agg: ScreenStats = {
    edgeFrac: med(stats.map((s) => s.edgeFrac)),
    flatFrac: med(stats.map((s) => s.flatFrac)),
    peakFrac: med(stats.map((s) => s.peakFrac)),
    darkFrac: med(stats.map((s) => s.darkFrac)),
  };
  const sScore = inp.frames.length > 0 ? screenScore(agg) : 0;
  const diffs: number[] = [];
  for (let i = 1; i < inp.frames.length; i++) {
    const a = inp.frames[i - 1];
    const b = inp.frames[i];
    if (a && b) diffs.push(frameDiff(a, b, camN));
  }
  const motion = diffs.length ? med(diffs) : 0;
  const diagnostics = {
    faceW: Math.round(wFrac * 1000) / 1000,
    faceH: Math.round(hFrac * 1000) / 1000,
    cx: Math.round(cx * 100) / 100,
    cy: Math.round(cy * 100) / 100,
    spreadX: Math.round(sx * 1000) / 1000,
    spreadY: Math.round(sy * 1000) / 1000,
    corner,
    small,
    stationary,
    edgeFrac: Math.round(agg.edgeFrac * 1000) / 1000,
    flatFrac: Math.round(agg.flatFrac * 1000) / 1000,
    peakFrac: Math.round(agg.peakFrac * 1000) / 1000,
    screenScore: Math.round(sScore * 1000) / 1000,
    motion: Math.round(motion * 10) / 10,
    durSec: Math.round(dur * 10) / 10,
  };
  const isScreen =
    small && stationary && (corner || sideEdge) && sScore >= 0.5 && inp.frames.length >= 2;
  if (isScreen) {
    const full: Rect01 = inp.contentRect ?? { x: 0, y: 0, w: 1, h: 1 };
    return {
      kind: 'screen-face',
      faceRegion: camN,
      screenRegion: full,
      confidence: clamp01(0.5 + 0.5 * sScore - Math.min(0.3, motion / 60)),
      ...base,
      diagnostics,
    };
  }
  return {
    kind: 'single-face',
    faceRegion: null,
    screenRegion: null,
    confidence: clamp01(main.presence),
    ...base,
    diagnostics,
  };
}

/* ---------------------------------------------- ffmpeg sampling ------------------------------------------- */

export interface SampledFrames {
  frames: GrayFrame[];
  crops: CropRect[];
}

/** Evenly spread sample times inside the span (never at the very edges). */
export function sampleTimes(startSec: number, endSec: number, count = SAMPLE_COUNT): number[] {
  const dur = Math.max(0.1, endSec - startSec);
  const n = dur < 3 ? Math.max(2, Math.min(count, Math.floor(dur * 2))) : count;
  return Array.from({ length: n }, (_, i) => startSec + (dur * (i + 0.5)) / n);
}

/**
 * One ffmpeg call per sample time: seek, decode ONE frame, run cropdetect on it at full resolution and
 * pipe it back as a raw gray frame scaled to ~640 px wide.
 */
export async function sampleFrames(
  ffmpegPath: string,
  sourcePath: string,
  times: number[],
  srcW: number,
  srcH: number,
  opts: CommonOpts = {},
): Promise<SampledFrames> {
  const w = Math.min(SAMPLE_W, 2 * Math.floor(srcW / 2));
  const h = 2 * Math.round((w * srcH) / srcW / 2);
  const frames: GrayFrame[] = [];
  const crops: CropRect[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i] ?? 0;
    const r = await runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'info',
        '-ss',
        t.toFixed(3),
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-an',
        '-vf',
        `cropdetect=limit=24:round=2:reset=0:skip=0,scale=${w}:${h}:flags=area,format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { signal: opts.signal, captureStdout: true, timeoutMs: 60_000 },
    );
    if (r.code !== 0)
      throw new RenderError('Could not sample frames for layout analysis', r.stderr.slice(-400));
    if (r.stdout.length >= w * h) {
      frames.push({
        w,
        h,
        data: new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, w * h).slice(),
      });
      const c = parseCropdetect(r.stderr);
      if (c) crops.push(c);
    }
    opts.onProgress?.((i + 1) / times.length);
  }
  return { frames, crops };
}

export interface AnalyzeArgs {
  ffmpegPath: string;
  sourcePath: string;
  startSec: number;
  endSec: number;
  srcW: number;
  srcH: number;
  faces: FaceSample[];
}

export async function analyzeLayout(args: AnalyzeArgs & CommonOpts): Promise<LayoutHint> {
  const times = sampleTimes(args.startSec, args.endSec);
  const { frames, crops } = await sampleFrames(
    args.ffmpegPath,
    args.sourcePath,
    times,
    args.srcW,
    args.srcH,
    args,
  );
  const contentRect = mergeLetterbox(crops, args.srcW, args.srcH);
  return classifyLayout({ ...args, frames, contentRect });
}
