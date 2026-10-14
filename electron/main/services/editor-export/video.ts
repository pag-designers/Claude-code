/**
 * Visual layers (video / image items): shared-evaluator samples → FFmpeg sub-graph per item.
 *
 *   input(-ss/-t)  →  time map (setpts G(c), fps on the global frame grid, trim to the item's frames, hold)
 *                  →  crop1 (integer window, may move) → scale (to output px, may zoom) → crop2 (exact window)
 *                  →  mirror → colour (lutrgb · colorchannelmixer · lutrgb [· lut3d]) → rotate → blur → opacity
 *                  →  final scale (animated item scale) → overlay at a time-varying centre
 *
 * Every animated number is sampled from the evaluator at each frame (see pl.ts) — nothing is re-implemented.
 */
import type { ImageItem, VideoItem } from '@shared/editor';
import {
  animatedAt,
  makeSourceOffset,
  naturalLayout,
  resolveColor,
  resolveCrop,
  resolveTransform,
  type EffectiveColor,
} from '@shared/editor-eval';
import { Chain, filt, pathOpt, q } from './graph';
import {
  affineExpr,
  isConst,
  mapSeries,
  num,
  seriesExpr,
  seriesRange,
  toSeries,
  type Series,
} from './pl';
import type { ItemFrameInfo } from './timeline';
import type { Ctx, FileInfo, PlacedLayer } from './types';

/** Tolerances (value units) of the PL simplification; documented in the README. */
export const TOL = {
  px: 0.25,
  scale: 0.002,
  deg: 0.05,
  opacity: 0.004,
  blur: 0.12,
  crop: 0.02,
  time: 0.0004,
} as const;

const MAX_PIECES = 24;
/** Slot-timestamp bias: with `fps round=near` a frame lands on slot ceil(τ·F − 0.0001), i.e. "last source frame at or before". */
const SLOT_BIAS = 0.4999;
/** Reverse is buffered in memory: chunks of at most this many source seconds. */
const REVERSE_CHUNK_SEC = 4;

const ss = (v: number): string => num(Math.max(0, v), 4);

/* ------------------------------------------------------------------------------ sampling -------- */

interface Samples {
  m: number;
  tOut: number[];
  /** Source seconds consumed since the item start (video/audio items only). */
  c: number[];
  cx: number[];
  cy: number[];
  sTot: number[];
  rot: number[];
  opa: number[];
  blur: number[];
  sx: number[];
  sy: number[];
  sw: number[];
  sh: number[];
  dstW: number[];
  dstH: number[];
  color: EffectiveColor[];
}

/** 'bg' = the blurred cover copy behind a 'contain' item: follows the transition ops, not the item transform. */
type LayerMode = 'main' | 'bg';
const BG_BLUR_FRACTION = 0.04;

function sampleMedia(
  ctx: Ctx,
  item: VideoItem | ImageItem,
  info: ItemFrameInfo,
  file: FileInfo,
  mode: LayerMode = 'main',
): Samples {
  const { grid, K, cw, ch } = ctx;
  const m = info.jb - info.ja;
  const srcW = file.width as number;
  const srcH = file.height as number;
  const off = item.type === 'video' ? makeSourceOffset(item) : () => 0;
  const s: Samples = {
    m,
    tOut: [],
    c: [],
    cx: [],
    cy: [],
    sTot: [],
    rot: [],
    opa: [],
    blur: [],
    sx: [],
    sy: [],
    sw: [],
    sh: [],
    dstW: [],
    dstH: [],
    color: [],
  };
  const shortSide = Math.min(cw, ch);
  for (let k = 0; k < m; k++) {
    const j = info.ja + k;
    const tl = grid.time(j) - item.startSec;
    const ops = info.ops[k] ?? null;
    const tr = resolveTransform(item, tl);
    if (mode === 'bg') {
      tr.x = 0;
      tr.y = 0;
      tr.scale = 1;
      tr.rotation = 0;
    }
    const sOps = ops?.scale ?? 1;
    const blurItem =
      mode === 'bg' ? BG_BLUR_FRACTION * shortSide : Math.max(0, animatedAt(item.blur, tl));
    const blurOps = (ops?.blur ?? 0) * shortSide;
    const rc = resolveCrop(item.crop, tl);
    const nl = naturalLayout(mode === 'bg' ? 'cover' : item.fit, rc, srcW, srcH, cw, ch);
    s.tOut.push(grid.out(j));
    s.c.push(off(tl));
    s.cx.push(ctx.W / 2 + K * (tr.x * sOps + (ops?.dx ?? 0) * cw));
    s.cy.push(ctx.H / 2 + K * (tr.y * sOps + (ops?.dy ?? 0) * ch));
    s.sTot.push(tr.scale * sOps);
    s.rot.push(tr.rotation);
    s.opa.push(info.hidden[k] ? 0 : tr.opacity * (ops?.opacity ?? 1));
    s.blur.push(K * Math.hypot(blurItem, blurOps));
    s.sx.push(nl.src.x);
    s.sy.push(nl.src.y);
    s.sw.push(nl.src.w);
    s.sh.push(nl.src.h);
    s.dstW.push(nl.dst.w);
    s.dstH.push(nl.dst.h);
    s.color.push(resolveColor(item.color, tl));
  }
  return s;
}

/* ------------------------------------------------------------------------------ time chain ------ */

function matrixFor(file: FileInfo): string | undefined {
  return file.forceBt709 ? 'bt709' : undefined;
}

/** Hold the last frame, cut to exactly `n` frames starting at slot `ja`. */
function holdAndCut(c: Chain, n: number, fps: number): void {
  c.push(filt('tpad', { stop_mode: 'clone', stop: n + 30 }), filt('trim', { end_frame: n }));
}

/** A still image / freeze frame: one decoded frame repeated for `n` frames at slots ja.. */
function stillChain(
  ctx: Ctx,
  file: FileInfo,
  seek: number | null,
  ja: number,
  n: number,
): string {
  const idx = ctx.g.addInput([...(seek !== null ? ['-ss', ss(seek)] : []), '-i', file.path]);
  const c = new Chain(ctx.g, `${idx}:v:0`);
  c.push(
    filt('trim', { end_frame: 1 }),
    'setpts=PTS-STARTPTS',
    filt('fps', { fps: ctx.fps, round: 'near' }),
    filt('tpad', { stop_mode: 'clone', stop: n }),
    filt('trim', { end_frame: n }),
    `setpts=PTS+${num(ja / ctx.fps, 6)}/TB`,
  );
  return c.flush();
}

/**
 * Video of a media item as a CFR stream whose frame for slot j (j in [ja, jb)) is the source frame the
 * evaluator picks at that frame time (the last frame at or before it). Output timestamps are j / fps.
 */
function timeChain(ctx: Ctx, item: VideoItem, file: FileInfo, info: ItemFrameInfo, s: Samples): string {
  const F = ctx.fps;
  const n = s.m;
  const ja = info.ja;
  if (item.freezeAtSec !== null) {
    return stillChain(ctx, file, Math.max(0, item.freezeAtSec - 1e-4), ja, n);
  }
  const period = 1 / Math.max(1, file.fps ?? 30);
  const span = s.c[n - 1] as number;
  const total = (s.c[n - 1] as number) + 0; // consumed seconds up to the last frame
  void total;
  const parts: { label: string; j0: number; j1: number }[] = [];

  // frame index ranges per chunk (forward = one chunk)
  const ranges: [number, number][] = [];
  if (!item.reverse) ranges.push([0, n]);
  else {
    let k0 = 0;
    for (let k = 1; k <= n; k++) {
      if (k === n || (s.c[k] as number) - (s.c[k0] as number) > REVERSE_CHUNK_SEC) {
        ranges.push([k0, k]);
        k0 = k;
      }
    }
  }
  // source window of the whole reversed item
  const fullSpan = makeSourceOffset(item)(item.durationSec);
  for (const [k0, k1] of ranges) {
    const j0 = ja + k0;
    const m = k1 - k0;
    const cLo = s.c[k0] as number;
    const cHi = s.c[k1 - 1] as number;
    let srcStart: number;
    let srcLen: number;
    let cOff: number;
    if (!item.reverse) {
      srcStart = Math.max(0, item.inSec + cLo - (1.5 * period + 0.02));
      srcLen = item.inSec + cHi + 2 * period - srcStart;
      cOff = srcStart - item.inSec;
    } else {
      const top = item.inSec + fullSpan - cLo;
      const low = item.inSec + fullSpan - cHi - 1.5 * period;
      srcStart = Math.max(0, low);
      srcLen = top + 0.0005 - srcStart;
      cOff = cLo;
    }
    const idx = ctx.g.addInput(['-ss', ss(srcStart), '-t', num(Math.max(0.1, srcLen), 4), '-i', file.path]);
    const c = new Chain(ctx.g, `${idx}:v:0`);
    if (item.reverse) c.push('setpts=PTS-STARTPTS', 'reverse');
    // G(c) → absolute output time of that source frame; T = pts (s) of the frame in this chain
    const kn: { t: number; v: number }[] = [];
    const times: number[] = [];
    const vals: number[] = [];
    for (let k = k0; k < k1; k++) {
      times.push((s.c[k] as number) - cOff);
      vals.push((s.tOut[k] as number) + SLOT_BIAS / F);
    }
    void kn;
    const g = toSeries(times, vals, TOL.time);
    // a series with a single knot (m === 1) is constant: build a unit-slope line instead
    const gx =
      g.kind === 'const'
        ? m === 1
          ? `(${num(vals[0] as number)}+(T-${num(times[0] as number)}))`
          : `(${num(vals[0] as number)})`
        : seriesExpr(g, 'T');
    c.push(`setpts=${q(`${gx}/TB`)}`);
    c.push(
      filt('fps', {
        fps: F,
        start_time: num((j0 - 1) / F, 6),
        round: 'near',
      }),
      filt('trim', { start_frame: 1, end_frame: m + 1 }),
    );
    holdAndCut(c, m, F);
    if (ranges.length > 1) c.push(`setpts=PTS-${num(j0 / F, 6)}/TB`);
    parts.push({ label: c.flush(), j0, j1: j0 + m });
  }
  if (parts.length === 1) return (parts[0] as { label: string }).label;
  // reverse chunks: concat in order, then re-base to the item's first slot
  const cat = ctx.g.add(
    parts.map((p) => p.label),
    [`concat=n=${parts.length}:v=1:a=0`, `setpts=PTS+${num(ja / F, 6)}/TB`],
  );
  void span;
  return cat;
}

/* ------------------------------------------------------------------------------ colour ---------- */

const lutExpr = (gain: number, contrast: number): string =>
  `clip((clip(val*${num(gain, 6)},0,maxval)/maxval-0.5)*${num(contrast, 6)}+0.5,0,1)*maxval+0.5`;

/** The applyColor() maths as FFmpeg filters (exposure+contrast LUT → saturation matrix → temperature LUT). */
export function colorFilters(e: EffectiveColor, enable?: string): string[] {
  const en = enable ? { enable: q(enable) } : {};
  const out: string[] = [];
  const gain = Math.pow(2, e.ev);
  if (Math.abs(e.ev) > 1e-6 || Math.abs(e.contrast - 1) > 1e-6) {
    const ex = q(lutExpr(gain, e.contrast));
    out.push(filt('lutrgb', { r: ex, g: ex, b: ex, ...en }));
  }
  if (Math.abs(e.saturation - 1) > 1e-6) {
    const s = e.saturation;
    const lr = 0.2126;
    const lg = 0.7152;
    const lb = 0.0722;
    const k = 1 - s;
    out.push(
      filt('colorchannelmixer', {
        rr: num(s + k * lr, 6),
        rg: num(k * lg, 6),
        rb: num(k * lb, 6),
        gr: num(k * lr, 6),
        gg: num(s + k * lg, 6),
        gb: num(k * lb, 6),
        br: num(k * lr, 6),
        bg: num(k * lg, 6),
        bb: num(s + k * lb, 6),
        ...en,
      }),
    );
  }
  if (Math.abs(e.temperature) > 1e-6) {
    const rg = 1 + 0.25 * e.temperature;
    const bg = 1 - 0.25 * e.temperature;
    out.push(
      filt('lutrgb', {
        r: q(`clip(val*${num(rg, 6)}+0.5,0,maxval)`),
        b: q(`clip(val*${num(bg, 6)}+0.5,0,maxval)`),
        ...en,
      }),
    );
  }
  return out;
}

const sameColor = (a: EffectiveColor, b: EffectiveColor, tol: number): boolean =>
  Math.abs(a.ev - b.ev) <= tol * 1.5 &&
  Math.abs(a.contrast - b.contrast) <= tol &&
  Math.abs(a.saturation - b.saturation) <= tol &&
  Math.abs(a.temperature - b.temperature) <= tol;

/** Groups consecutive frames into ≤ MAX_PIECES runs (value taken at the run's middle frame). */
function groupBy<T>(
  values: T[],
  same: (a: T, b: T) => boolean,
): { k0: number; k1: number; v: T }[] {
  const runs: { k0: number; k1: number }[] = [];
  let start = 0;
  for (let k = 1; k <= values.length; k++) {
    if (k === values.length || !same(values[start] as T, values[k] as T)) {
      runs.push({ k0: start, k1: k });
      start = k;
    }
  }
  let merged = runs;
  if (runs.length > MAX_PIECES) {
    merged = [];
    const per = Math.ceil(values.length / MAX_PIECES);
    for (let k = 0; k < values.length; k += per)
      merged.push({ k0: k, k1: Math.min(values.length, k + per) });
  }
  return merged.map((r) => ({ ...r, v: values[(r.k0 + r.k1 - 1) >> 1] as T }));
}

/* ------------------------------------------------------------------------------ natural image --- */

interface Natural {
  label: string;
  w: number;
  h: number;
}

function buildNatural(
  ctx: Ctx,
  file: FileInfo,
  src: string,
  info: ItemFrameInfo,
  s: Samples,
  sNat: number,
  mirror: boolean,
): Natural {
  const { K } = ctx;
  const srcW = file.width as number;
  const srcH = file.height as number;
  const sx = toSeries(s.tOut, s.sx, TOL.crop);
  const sy = toSeries(s.tOut, s.sy, TOL.crop);
  const sw = toSeries(s.tOut, s.sw, TOL.crop);
  const sh = toSeries(s.tOut, s.sh, TOL.crop);
  const dstW0 = s.dstW[0] as number;
  const dstH0 = s.dstH[0] as number;
  const natW = Math.max(2, Math.round(dstW0 * K * sNat));
  const natH = Math.max(2, Math.round(dstH0 * K * sNat));
  const sizeAnimated = !isConst(sw) || !isConst(sh);
  const posAnimated = !isConst(sx) || !isConst(sy);
  const animated = sizeAnimated || posAnimated;
  if (sizeAnimated && (s.dstW.some((v) => Math.abs(v - dstW0) > 0.5) || s.dstH.some((v) => Math.abs(v - dstH0) > 0.5))) {
    ctx.notes.push(
      `crop size animation with contain/native fit is approximated (natural size fixed at the first frame) on item ${info.ja}`,
    );
  }
  // output px per source px (uniform)
  const fVals = s.sw.map((w) => natW / w);
  const fS = toSeries(s.tOut, fVals, 0.0005 * Math.max(...fVals));
  const fMax = seriesRange(fS).max;

  // stage-1 integer window (bounding size when moving)
  let w1 = 0;
  let h1 = 0;
  for (let k = 0; k < s.m; k++) {
    w1 = Math.max(w1, Math.ceil((s.sx[k] as number) + (s.sw[k] as number) - 1e-6) - Math.floor((s.sx[k] as number) + 1e-6));
    h1 = Math.max(h1, Math.ceil((s.sy[k] as number) + (s.sh[k] as number) - 1e-6) - Math.floor((s.sy[k] as number) + 1e-6));
  }
  if (animated) {
    w1 += 1;
    h1 += 1;
  }
  w1 = Math.min(srcW, Math.max(2, w1));
  h1 = Math.min(srcH, Math.max(2, h1));

  const x1E = (): string =>
    isConst(sx)
      ? num(Math.max(0, Math.min(Math.floor(sx.v + 1e-6), srcW - w1)))
      : `max(0,min(floor(${seriesExpr(sx)}),${srcW - w1}))`;
  const y1E = (): string =>
    isConst(sy)
      ? num(Math.max(0, Math.min(Math.floor(sy.v + 1e-6), srcH - h1)))
      : `max(0,min(floor(${seriesExpr(sy)}),${srcH - h1}))`;

  const c = new Chain(ctx.g, src);
  c.push('setsar=1');
  const fullWindow = isConst(sx) && isConst(sy) && w1 === srcW && h1 === srcH;
  const noCrop1 = fullWindow && sx.kind === 'const' && Math.floor(sx.v + 1e-6) === 0 && sy.kind === 'const' && Math.floor(sy.v + 1e-6) === 0;
  if (!noCrop1) {
    c.push(
      filt('crop', {
        w: w1,
        h: h1,
        x: isConst(sx) ? x1E() : q(x1E()),
        y: isConst(sy) ? y1E() : q(y1E()),
        exact: 1,
      }),
    );
  }
  const matrix = matrixFor(file);
  const scaleBase = { flags: 'lanczos+accurate_rnd', in_color_matrix: matrix, out_range: 'pc' };
  let scaledW: number;
  let scaledH: number;
  if (isConst(fS)) {
    scaledW = Math.max(natW, Math.ceil(w1 * fS.v - 1e-6));
    scaledH = Math.max(natH, Math.ceil(h1 * fS.v - 1e-6));
    c.push(filt('scale', { w: scaledW, h: scaledH, ...scaleBase }), 'format=rgba');
  } else {
    const fe = seriesExpr(fS);
    c.push(
      filt('scale', {
        w: q(`max(${natW},ceil(${w1}*(${fe})))`),
        h: q(`max(${natH},ceil(${h1}*(${fe})))`),
        eval: 'frame',
        ...scaleBase,
      }),
      'format=rgba',
    );
    scaledW = Math.ceil(w1 * fMax);
    scaledH = Math.ceil(h1 * fMax);
  }
  // stage 2: exact window (sub-pixel position rounded at OUTPUT resolution)
  const fExpr = isConst(fS) ? num(fS.v, 6) : `(${seriesExpr(fS)})`;
  const x2 = isConst(sx) && isConst(fS)
    ? num(Math.max(0, Math.min(Math.round((sx.v - Number(x1E())) * fS.v), scaledW - natW)))
    : q(`max(0,round((${isConst(sx) ? num(sx.v) : seriesExpr(sx)}-${x1E()})*${fExpr}))`);
  const y2 = isConst(sy) && isConst(fS)
    ? num(Math.max(0, Math.min(Math.round((sy.v - Number(y1E())) * fS.v), scaledH - natH)))
    : q(`max(0,round((${isConst(sy) ? num(sy.v) : seriesExpr(sy)}-${y1E()})*${fExpr}))`);
  const trivial2 = isConst(fS) && scaledW === natW && scaledH === natH && x2 === '0' && y2 === '0';
  if (!trivial2) c.push(filt('crop', { w: natW, h: natH, x: x2, y: y2, exact: 1 }));
  if (mirror) c.push('hflip');
  return { label: c.flush(), w: natW, h: natH };
}

/* ------------------------------------------------------------------------------ the item -------- */

export interface MediaLayerOpts {
  /** LUT file for item.color.lutAssetId. */
  lut: (assetId: string) => string;
}

/** Compiles one video / image item into placed RGBA layers (a blurred background copy first, when requested). */
export function compileMediaItem(
  ctx: Ctx,
  item: VideoItem | ImageItem,
  info: ItemFrameInfo,
  opts: MediaLayerOpts,
): PlacedLayer[] {
  const file = ctx.file(item.assetId);
  const main = sampleMedia(ctx, item, info, file, 'main');
  const opaMain = toSeries(main.tOut, main.opa, TOL.opacity);
  const sMain = toSeries(main.tOut, main.sTot, TOL.scale);
  if (seriesRange(opaMain).max <= 0.002 || seriesRange(sMain).max <= 0.005) {
    ctx.notes.push(`item ${item.id}: invisible (opacity or scale 0), skipped`);
    return [];
  }
  /* ---- the time-mapped slot stream ---- */
  let slots: string;
  if (item.type === 'image') slots = stillChain(ctx, file, null, info.ja, main.m);
  else slots = timeChain(ctx, item, file, info, main);

  const wantBg = item.fit === 'contain' && item.backgroundBlur;
  let slotsMain = slots;
  let slotsBg = '';
  if (wantBg) {
    slotsMain = ctx.g.label('sm');
    slotsBg = ctx.g.label('sb');
    ctx.g.chains.push(`[${slots}]split=2[${slotsBg}][${slotsMain}]`);
  }
  const layers: PlacedLayer[] = [];
  if (wantBg) {
    const bg = sampleMedia(ctx, item, info, file, 'bg');
    layers.push(layerFromSamples(ctx, item, info, file, bg, slotsBg, opts, true));
  }
  layers.push(layerFromSamples(ctx, item, info, file, main, slotsMain, opts, false));
  return layers;
}

function layerFromSamples(
  ctx: Ctx,
  item: VideoItem | ImageItem,
  info: ItemFrameInfo,
  file: FileInfo,
  s: Samples,
  slots: string,
  opts: MediaLayerOpts,
  isBg: boolean,
): PlacedLayer {
  const { g } = ctx;
  const opa = toSeries(s.tOut, s.opa, TOL.opacity);
  const sTot = toSeries(s.tOut, s.sTot, TOL.scale);
  const rot = toSeries(s.tOut, s.rot, TOL.deg);
  const cxS = toSeries(s.tOut, s.cx, TOL.px);
  const cyS = toSeries(s.tOut, s.cy, TOL.px);

  /* ---- natural image ---- */
  const smax = seriesRange(sTot).max;
  const sAnim = !isConst(sTot);
  const sNat = sAnim ? Math.min(smax, 1.25) : Math.min(smax, 3);
  const nat = buildNatural(ctx, file, slots, info, s, sNat, item.mirror);
  const c = new Chain(g, nat.label);

  /* ---- colour ---- */
  applyColor(ctx, c, s, item, opts);

  /* ---- rotation (fixed-size frame; the frame centre stays the layer centre) ---- */
  const rr = seriesRange(rot);
  let w = nat.w;
  let h = nat.h;
  if (Math.max(Math.abs(rr.min), Math.abs(rr.max)) > TOL.deg) {
    const rad = (v: number): number => (v * Math.PI) / 180;
    if (isConst(rot)) {
      const a = Math.abs(rad(rot.v));
      w = Math.ceil(Math.abs(nat.w * Math.cos(a)) + Math.abs(nat.h * Math.sin(a))) + 2;
      h = Math.ceil(Math.abs(nat.w * Math.sin(a)) + Math.abs(nat.h * Math.cos(a))) + 2;
    } else {
      w = h = Math.ceil(Math.hypot(nat.w, nat.h)) + 2;
    }
    c.push(
      filt('rotate', {
        a: isConst(rot) ? num(rad(rot.v), 7) : q(affineExpr(rot, Math.PI / 180, 0)),
        ow: w,
        oh: h,
        c: '0x00000000',
        bilinear: 1,
      }),
    );
  }

  /* ---- blur (σ in output px; applied before the final scale, so divided by the remaining ratio) ---- */
  if (Math.max(...s.blur) > 0.3) {
    const blurPre = s.blur.map((b, k) => b / Math.max(0.05, (s.sTot[k] as number) / sNat));
    c.push('premultiply=inplace=1');
    const pieces = groupBy(blurPre, (a, b) => Math.abs(a - b) <= TOL.blur * 2);
    for (const p of pieces) {
      if (p.v < 0.3) continue;
      const t0 = (s.tOut[p.k0] as number) - 0.5 / ctx.fps;
      const t1 = (s.tOut[p.k1 - 1] as number) + 0.5 / ctx.fps;
      const gate = pieces.length === 1 ? undefined : q(`between(t,${num(t0)},${num(t1)})`);
      c.push(filt('gblur', { sigma: num(p.v, 3), steps: 2, enable: gate }));
    }
    c.push('unpremultiply=inplace=1');
  }

  /* ---- opacity ---- */
  applyOpacity(ctx, c, opa);

  /* ---- animated / non-unit scale as the very last (size-changing) step ---- */
  if (sAnim) {
    const ratio = seriesExpr(mapSeries(sTot, (v) => v / sNat));
    c.push(
      filt('scale', {
        w: q(`max(2,round(iw*(${ratio})))`),
        h: q(`max(2,round(ih*(${ratio})))`),
        eval: 'frame',
        flags: 'bicubic',
      }),
    );
  } else if (isConst(sTot) && Math.abs(sTot.v / sNat - 1) > 0.002) {
    const r = sTot.v / sNat;
    c.push(
      filt('scale', {
        w: Math.max(2, Math.round(w * r)),
        h: Math.max(2, Math.round(h * r)),
        flags: 'bicubic',
      }),
    );
  }
  void isBg;
  return {
    label: c.flush(),
    ja: info.ja,
    jb: info.jb,
    x: q(`${seriesExpr(cxS)}-w/2`),
    y: q(`${seriesExpr(cyS)}-h/2`),
    blend: item.blend,
  };
}

function applyColor(
  ctx: Ctx,
  c: Chain,
  s: Samples,
  item: VideoItem | ImageItem,
  opts: MediaLayerOpts,
): void {
  const neutral = (e: EffectiveColor): boolean =>
    Math.abs(e.ev) < 1e-6 &&
    Math.abs(e.contrast - 1) < 1e-6 &&
    Math.abs(e.saturation - 1) < 1e-6 &&
    Math.abs(e.temperature) < 1e-6;
  const pieces = groupBy(s.color, (a, b) => sameColor(a, b, 0.004));
  const allNeutral = pieces.every((p) => neutral(p.v));
  if (!allNeutral) {
    for (const p of pieces) {
      if (neutral(p.v)) continue;
      const gate =
        pieces.length === 1
          ? undefined
          : `between(t,${num((s.tOut[p.k0] as number) - 0.5 / ctx.fps)},${num((s.tOut[p.k1 - 1] as number) + 0.5 / ctx.fps)})`;
      c.push(...colorFilters(p.v, gate));
    }
  }
  const lutId = item.color.lutAssetId;
  if (lutId) {
    const path = opts.lut(lutId);
    const amount = item.color.lutAmount;
    const lutF = filt('lut3d', { file: pathOpt(path), interp: 'tetrahedral' });
    if (amount >= 0.999) c.push(lutF);
    else if (amount > 0.001) {
      const base = c.flush();
      const a = ctx.g.label('la');
      const b = ctx.g.label('lb');
      ctx.g.add([base], ['split=2'], undefined);
      // `split` needs two output pads: build manually
      ctx.g.chains.pop();
      ctx.g.chains.push(`[${base}]split=2[${a}][${b}]`);
      const lutted = ctx.g.add([b], [lutF]);
      const mixed = ctx.g.add([a, lutted], [filt('blend', { all_mode: 'normal', all_opacity: amount })]);
      c.label = mixed;
    }
  }
}

/** Multiplies the layer's alpha by the opacity series. */
function applyOpacity(ctx: Ctx, c: Chain, opa: Series): void {
  if (isConst(opa)) {
    if (opa.v < 0.998) c.push(filt('colorchannelmixer', { aa: num(opa.v, 4) }));
    return;
  }
  const base = c.flush();
  const a = ctx.g.label('oa');
  const b = ctx.g.label('ob');
  ctx.g.chains.push(`[${base}]split=2[${a}][${b}]`);
  const gain = (v: number): number => Math.max(0, Math.min(1, v));
  const cexpr = seriesExpr(mapSeries(opa, gain));
  const bexpr = seriesExpr(mapSeries(opa, (v) => 0.5 * gain(v) - 0.5));
  const m = ctx.g.add(
    [a],
    ['alphaextract', filt('eq', { contrast: q(cexpr), brightness: q(bexpr), eval: 'frame' })],
  );
  c.label = ctx.g.add([b, m], ['alphamerge']);
}

/** Opacity from samples (used for dip veils). */
export function applyOpacityFor(ctx: Ctx, c: Chain, times: number[], values: number[]): void {
  applyOpacity(ctx, c, toSeries(times, values, TOL.opacity));
}
