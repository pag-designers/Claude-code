/**
 * Pure builders for the FFmpeg filtergraph.
 *
 * Panning method (measured for jitter, see tests): FFmpeg's `crop` snaps x/y to whole (even) pixels,
 * which at 480p-source -> 1080p-output would move the picture in 8 px output steps. So panning is done
 * in TWO stages:
 *   1. `crop@c1`  integer/even window in SOURCE pixels (w+4 wide), moved by `sendcmd`
 *   2. `scale` to output scale (lanczos)
 *   3. `crop@c2`  the exact output window, positioned in OUTPUT pixels (1 px resolution at output scale)
 * so the effective pan resolution is ~1/f source pixels. `sendcmd` updates both crops every half frame
 * from a command file generated from the plan's keyframes (Hermite-interpolated, cut aware).
 */
import type { CropKeyframe, ReframePlan } from '@shared/pipeline';

const evenCeil = (v: number): number => 2 * Math.ceil(v / 2);

/* --------------------------------------- filtergraph escaping ------------------------------------- */

/**
 * Escapes a file path for use as a filter option value (two levels: option value, then filtergraph).
 * Windows backslashes become slashes first.
 */
export function escapeFilterPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const lvl1 = slashed.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  return lvl1
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[[\],;]/g, (m) => `\\${m}`);
}

/* ---------------------------------------- path interpolation -------------------------------------- */

export interface PathSample {
  x: number;
  y: number;
}

/**
 * Evaluates the crop path at clip-relative time `t`. Keyframes between two cuts are interpolated with a
 * cubic Hermite spline (Catmull-Rom tangents, monotone-safe clamping); across a cut the position
 * jumps. `cutEpsSec` makes the jump happen half a frame early so the first frame of the new shot already
 * uses the new crop.
 */
export class CropPath {
  private readonly shots: CropKeyframe[][];
  private readonly cutTimes: number[];

  constructor(
    keyframes: CropKeyframe[],
    cuts: number[],
    private readonly bounds: { maxX: number; maxY: number },
    private readonly cutEpsSec: number,
  ) {
    this.cutTimes = [...cuts].sort((a, b) => a - b);
    this.shots = Array.from({ length: this.cutTimes.length + 1 }, () => []);
    for (const k of [...keyframes].sort((a, b) => a.t - b.t)) {
      // keyframes at/after a cut belong to the new shot (reframe emits one exactly at the cut)
      let idx = 0;
      for (const c of this.cutTimes) if (k.t >= c - 1e-9) idx++;
      this.shots[idx]?.push(k);
    }
  }

  /** Time at which the crop jumps for the i-th cut. */
  jumpTime(i: number): number {
    return (this.cutTimes[i] ?? 0) - this.cutEpsSec;
  }

  get cutCount(): number {
    return this.cutTimes.length;
  }

  private shotIndex(t: number): number {
    let n = 0;
    for (const c of this.cutTimes) if (t >= c - this.cutEpsSec) n++;
    return Math.min(n, this.shots.length - 1);
  }

  at(t: number): PathSample {
    let si = this.shotIndex(t);
    // an empty shot (plan without keyframes there) reuses the nearest earlier one
    while (si > 0 && (this.shots[si]?.length ?? 0) === 0) si--;
    const kfs = this.shots[si];
    if (!kfs || kfs.length === 0) return { x: 0, y: 0 };
    const first = kfs[0];
    const last = kfs[kfs.length - 1];
    if (!first || !last) return { x: 0, y: 0 };
    let out: PathSample;
    if (t <= first.t) out = { x: first.x, y: first.y };
    else if (t >= last.t) out = { x: last.x, y: last.y };
    else {
      let lo = 0;
      let hi = kfs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((kfs[mid]?.t ?? 0) <= t) lo = mid;
        else hi = mid;
      }
      const p0 = kfs[Math.max(0, lo - 1)] ?? first;
      const p1 = kfs[lo] ?? first;
      const p2 = kfs[hi] ?? last;
      const p3 = kfs[Math.min(kfs.length - 1, hi + 1)] ?? last;
      const h = Math.max(1e-6, p2.t - p1.t);
      const u = (t - p1.t) / h;
      const herm = (a0: number, a1: number, a2: number, a3: number): number => {
        const m1 = p2.t - p0.t > 1e-6 ? ((a2 - a0) / (p2.t - p0.t)) * h : 0;
        const m2 = p3.t - p1.t > 1e-6 ? ((a3 - a1) / (p3.t - p1.t)) * h : 0;
        const u2 = u * u;
        const u3 = u2 * u;
        const v =
          (2 * u3 - 3 * u2 + 1) * a1 +
          (u3 - 2 * u2 + u) * m1 +
          (-2 * u3 + 3 * u2) * a2 +
          (u3 - u2) * m2;
        // never overshoot the segment's own range (tangent overshoot would read as jitter)
        return Math.min(Math.max(v, Math.min(a1, a2)), Math.max(a1, a2));
      };
      out = { x: herm(p0.x, p1.x, p2.x, p3.x), y: herm(p0.y, p1.y, p2.y, p3.y) };
    }
    return {
      x: Math.min(Math.max(out.x, 0), this.bounds.maxX),
      y: Math.min(Math.max(out.y, 0), this.bounds.maxY),
    };
  }
}

/* ----------------------------------------- two-stage crop geometry -------------------------------- */

export interface CropStages {
  /** true when the path never moves: a single static crop+scale is used. */
  isStatic: boolean;
  /** stage-1 window size in source px */
  w1: number;
  h1: number;
  /** scale factor source -> output */
  f: number;
  /** scaled size after stage 1 */
  sw: number;
  sh: number;
  outW: number;
  outH: number;
  /** crop window size in source px (from the plan) */
  cropW: number;
  cropH: number;
}

export function planStages(plan: ReframePlan, srcW: number, srcH: number): CropStages {
  const first = plan.keyframes[0];
  const cropW = Math.min(srcW, first?.w ?? srcW);
  const cropH = Math.min(srcH, first?.h ?? srcH);
  const f = Math.max(plan.outW / cropW, plan.outH / cropH);
  const w1 = Math.min(srcW, evenCeil(cropW + 4));
  const h1 = Math.min(srcH, evenCeil(cropH + 4));
  const sw = Math.max(plan.outW, evenCeil(w1 * f));
  const sh = Math.max(plan.outH, evenCeil(h1 * f));
  const xs = plan.keyframes.map((k) => k.x);
  const ys = plan.keyframes.map((k) => k.y);
  const spread = (a: number[]): number => (a.length > 1 ? Math.max(...a) - Math.min(...a) : 0);
  const moves = spread(xs) > 0.25 || spread(ys) > 0.25;
  return {
    isStatic: !moves,
    w1,
    h1,
    f,
    sw,
    sh,
    outW: plan.outW,
    outH: plan.outH,
    cropW,
    cropH,
  };
}

export interface StageValues {
  x0: number;
  y0: number;
  ox: number;
  oy: number;
}

/** Splits a source-space crop position into the stage-1 even/integer window origin and stage-2 offset. */
export function stageValues(
  p: PathSample,
  st: CropStages,
  srcW: number,
  srcH: number,
): StageValues {
  const maxX0 = Math.max(0, srcW - st.w1);
  const maxY0 = Math.max(0, srcH - st.h1);
  const x0 = Math.min(maxX0, Math.max(0, 2 * Math.floor(p.x / 2)));
  const y0 = Math.min(maxY0, Math.max(0, 2 * Math.floor(p.y / 2)));
  const ox = Math.min(Math.max(0, Math.round((p.x - x0) * st.f)), st.sw - st.outW);
  const oy = Math.min(Math.max(0, Math.round((p.y - y0) * st.f)), st.sh - st.outH);
  return { x0, y0, ox, oy };
}

/* ------------------------------------------- sendcmd file ---------------------------------------- */

const fmtT = (t: number): string => Math.max(0, t).toFixed(4);

/**
 * Builds the `sendcmd` command file. Commands are issued every half frame (FFmpeg applies the latest
 * command at or before each frame's timestamp) and only when a value changes; cut jumps are issued at
 * (cut - 0.5/fps).
 */
export function buildCropCommands(
  path: CropPath,
  st: CropStages,
  srcW: number,
  srcH: number,
  durationSec: number,
  fps: number,
): string {
  const step = 1 / (2 * fps);
  const lines: string[] = [];
  let prev: StageValues | null = null;
  const issue = (t: number, v: StageValues): void => {
    const parts: string[] = [];
    if (!prev || prev.x0 !== v.x0) parts.push(`crop@c1 x ${v.x0}`);
    if (!prev || prev.y0 !== v.y0) parts.push(`crop@c1 y ${v.y0}`);
    if (!prev || prev.ox !== v.ox) parts.push(`crop@c2 x ${v.ox}`);
    if (!prev || prev.oy !== v.oy) parts.push(`crop@c2 y ${v.oy}`);
    if (parts.length === 0) return;
    lines.push(`${fmtT(t)} ${parts.join(', ')};`);
    prev = v;
  };
  const jumps = Array.from({ length: path.cutCount }, (_, i) => path.jumpTime(i)).filter(
    (t) => t > 0 && t < durationSec,
  );
  let ji = 0;
  const n = Math.ceil(durationSec / step);
  for (let k = 0; k <= n; k++) {
    const t = k * step;
    while (ji < jumps.length && (jumps[ji] ?? Infinity) <= t) {
      // exact jump command: the path value just after the jump
      const jt = jumps[ji] ?? 0;
      issue(jt, stageValues(path.at(jt + 1e-6), st, srcW, srcH));
      ji++;
    }
    issue(t, stageValues(path.at(t), st, srcW, srcH));
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------- video filter ----------------------------------------- */

export interface VideoFilterOptions {
  plan: ReframePlan;
  srcW: number;
  srcH: number;
  /** Path of the sendcmd file (moving paths only). */
  cmdFile: string | null;
  /** Initial stage values (first frame). */
  initial: StageValues;
  /** `fps=` argument when the output frame rate must be forced (VFR / cap / explicit). */
  fps: string | null;
  assFile: string | null;
  fontsDir: string | null;
}

/** Builds the video filter chain (without labels); input/output pads are added by the caller. */
export function buildVideoFilter(o: VideoFilterOptions): string {
  const st = planStages(o.plan, o.srcW, o.srcH);
  const parts: string[] = [];
  if (o.fps) parts.push(`fps=${o.fps}`);
  if (st.isStatic || !o.cmdFile) {
    const x = Math.min(
      Math.max(0, 2 * Math.round((o.plan.keyframes[0]?.x ?? 0) / 2)),
      o.srcW - st.cropW,
    );
    const y = Math.min(
      Math.max(0, 2 * Math.round((o.plan.keyframes[0]?.y ?? 0) / 2)),
      o.srcH - st.cropH,
    );
    parts.push(`crop=w=${st.cropW}:h=${st.cropH}:x=${x}:y=${y}`);
    parts.push(`scale=${o.plan.outW}:${o.plan.outH}:flags=lanczos`);
  } else {
    parts.push(`sendcmd=f=${escapeFilterPath(o.cmdFile)}`);
    parts.push(`crop@c1=w=${st.w1}:h=${st.h1}:x=${o.initial.x0}:y=${o.initial.y0}`);
    parts.push(`scale=${st.sw}:${st.sh}:flags=lanczos`);
    parts.push(`crop@c2=w=${st.outW}:h=${st.outH}:x=${o.initial.ox}:y=${o.initial.oy}`);
  }
  parts.push('setsar=1');
  if (o.assFile) {
    let ass = `ass=filename=${escapeFilterPath(o.assFile)}`;
    if (o.fontsDir) ass += `:fontsdir=${escapeFilterPath(o.fontsDir)}`;
    parts.push(ass);
  }
  parts.push('format=yuv420p');
  return parts.join(',');
}
