/**
 * Subtitle items → Canvas2D, reproducing the libass look of `electron/main/services/captions/ass.ts` (geometry from
 * geometry.ts, event model from ass.ts). A subtitle item is ONE on-screen block (a cue) shown for its whole duration;
 * the active word is the last word whose start ≤ the item-local time.
 *
 * What is reproduced: font / weight / case / letter spacing; fill; stroke (outline) with round joins; hard shadow
 * (offset copy), soft shadow and glow (blurred copies); rounded caption box; active-word emphasis by colour, scale and
 * highlight box; per-word `color` overrides (replace the style's keyword colour); animations pop, bounce, fade,
 * slide-up, karaoke (colour sweep) and typewriter (letter reveal); layout (yPct + aspect shift + safe zone, margins,
 * left / centre alignment, shrink-to-fit, line pitch).
 *
 * Approximations vs libass: glyph rasterisation / hinting / blur kernel (Canvas2D vs FreeType + libass' own gaussian);
 * the ASS "\blur1" edge softening is not applied; line breaking inside a cue is by width (the exporter's chunker is not
 * run — see report); a word too wide even when shrunk is not hyphen-split.
 */
import type { CaptionStyle } from '@shared/cp2';
import type { SubtitleItem } from '@shared/editor';
import { cssFont, resolveEditorFace, type ResolvedFace } from './fonts';
import type { Geom } from './geometry';
import {
  createRasterCanvas,
  ctx2d,
  newRaster,
  roundRectPath,
  rgba,
  hexToRgb,
  type Ctx2D,
  type Raster,
} from './raster';
import type { TextMeasurer } from './text-layout';

/* ------------------------------------------------------------------ text helpers ---------------- */

/** Port of captions/text.ts `applyCase`. */
export function applyCase(text: string, mode: 'none' | 'upper' | 'lower' | 'title'): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return text.replace(
        /(^|[\s\-"'([“‘])(\p{L})(\p{L}*)/gu,
        (_m, pre: string, first: string, rest: string) => {
          const mixed = /\p{Lu}/u.test(rest) && rest !== rest.toUpperCase();
          if (mixed) return `${pre}${first}${rest}`;
          return `${pre}${first.toUpperCase()}${rest === rest.toUpperCase() ? rest.toLowerCase() : rest}`;
        },
      );
    default:
      return text;
  }
}

export interface PreparedWord {
  text: string;
  s: number;
  e: number;
  color: string | null;
}

/** captions/text.ts `prepareWords` for item-local times (sorted, overlaps resolved, zero-length words given a short life). */
export function prepareSubtitleWords(item: SubtitleItem): PreparedWord[] {
  const dur = item.durationSec;
  const out: PreparedWord[] = [];
  for (const w of item.words) {
    const raw = w.w.replace(/\s+/g, ' ').trim();
    if (raw === '' || !Number.isFinite(w.s) || !Number.isFinite(w.e)) continue;
    const s = Math.max(0, w.s);
    out.push({ text: raw, s, e: Math.max(s, w.e), color: w.color });
  }
  out.sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length; i++) {
    const p = out[i] as PreparedWord;
    const c = out[i + 1];
    if (c && c.s < p.e) p.e = Math.max(p.s, c.s);
    if (p.e <= p.s) {
      const room = c ? c.s - p.s : Math.max(0, dur - p.s);
      p.e = p.s + Math.min(0.12, room >= 0.08 ? room : 0);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ geometry -------------------- */

export interface CapGeo {
  W: number;
  H: number;
  short: number;
  k: number;
  family: string;
  weight: number;
  italic: boolean;
  face: ResolvedFace | null;
  /** libass font size (ascent + descent cell), canvas px. */
  fontSize: number;
  spacing: number;
  outline: number;
  /** Hard-shadow offset (0 when the style uses a soft shadow or none). */
  shadow: number;
  marginX: number;
  pad: number;
  cx: number;
  cy: number;
  left: boolean;
  usableW: number;
}

const aspectDelta = (w: number, h: number): number => {
  if (w > h) return 6;
  const r = h / w;
  return r > 1.5 ? 0 : r > 1.1 ? 1 : 3;
};

/** em px for a libass cell size. */
export const emOf = (g: Pick<CapGeo, 'face'>, fs: number): number =>
  fs / (g.face ? g.face.ascent + g.face.descent : 1.4);

/** Port of geometry.ts `computeLayout` (minus the character budget, which only drives chunking). */
export function captionGeometry(style: CaptionStyle, W: number, H: number): CapGeo {
  const short = Math.min(W, H);
  const k = short / 1080;
  const face = resolveEditorFace(style.font.family, style.font.weight);
  const fontSize = Math.max(16, Math.round((short * style.font.sizePct) / 100));
  const spacing = Math.round((style.font.letterSpacingPct / 100) * fontSize * 100) / 100;
  const outline =
    style.stroke.widthPct > 0 ? Math.max(1, Math.round((short * style.stroke.widthPct) / 100)) : 0;
  const hasShadowOffset = style.shadow.opacity > 0 && style.shadow.offsetPx > 0;
  const shadow =
    style.shadow.blurPx > 0 || !hasShadowOffset
      ? 0
      : Math.max(1, Math.round(style.shadow.offsetPx * k));
  const boxish = style.box.enabled || style.highlight.mode === 'box';
  const pad = boxish ? Math.max(2, Math.round((short * style.box.paddingPct) / 100)) : 0;
  const marginX = Math.ceil((W * style.layout.marginXPct) / 100);
  const left = style.layout.align === 'left';
  const boxPad = style.box.enabled ? pad : 0;
  const usableW = Math.max(40, W - 2 * marginX - 2 * boxPad);
  const portrait = H / W > 1.5;
  const blockH = style.chunking.maxLines * fontSize + 2 * boxPad;
  const bottomLimit = H * (portrait ? 0.82 : 0.93);
  let cy = Math.round((H * (style.layout.yPct + aspectDelta(W, H))) / 100);
  cy = Math.min(cy, Math.round(bottomLimit - blockH / 2));
  cy = Math.max(cy, Math.round(H * 0.05 + blockH / 2));
  return {
    W,
    H,
    short,
    k,
    family: style.font.family,
    weight: style.font.weight,
    italic: style.font.italic,
    face,
    fontSize,
    spacing,
    outline,
    shadow,
    marginX,
    pad,
    cx: left ? marginX + boxPad : Math.round(W / 2),
    cy,
    left,
    usableW,
  };
}

/* ------------------------------------------------------------------ animation plan -------------- */

interface AnimPlan {
  steady: number;
  peak: number;
  hasScale: boolean;
}

export function animPlan(style: CaptionStyle): AnimPlan {
  const m = style.highlight.mode;
  const hasScale = m === 'scale' || m === 'color-scale';
  const steady = hasScale ? Math.round(style.highlight.scale * 100) : 100;
  const peak = hasScale
    ? Math.max(steady + 6, Math.round(steady * 1.08))
    : Math.max(112, Math.round(style.highlight.scale * 100));
  return { steady, peak, hasScale };
}

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

/** Piecewise-linear \t() chain: points [t(ms), value]; the value before the first point is `from`. */
function chain(from: number, pts: [number, number][], a: number): number {
  let prevT = 0;
  let prevV = from;
  for (const [t, v] of pts) {
    if (a < t) return lerp(prevV, v, (a - prevT) / Math.max(1e-6, t - prevT));
    prevT = t;
    prevV = v;
  }
  return prevV;
}

/** Scale (1 = 100 %) of the ACTIVE word `ms` after it became active. */
export function activeScale(style: CaptionStyle, ms: number): number {
  const plan = animPlan(style);
  switch (style.animation) {
    case 'pop':
      return (
        chain(
          Math.round(plan.steady * 0.82),
          [
            [70, plan.peak],
            [150, plan.steady],
          ],
          ms,
        ) / 100
      );
    case 'bounce': {
      const s = plan.steady;
      return (
        chain(
          Math.round(s * 0.72),
          [
            [90, Math.round(s * 1.16)],
            [170, Math.round(s * 0.93)],
            [240, Math.round(s * 1.05)],
            [310, s],
          ],
          ms,
        ) / 100
      );
    }
    default:
      return plan.steady / 100;
  }
}

const idleColor = (style: CaptionStyle, w: PreparedWord): string => w.color ?? style.fill;
function activeColor(style: CaptionStyle, w: PreparedWord): string {
  const m = style.highlight.mode;
  return m === 'color' || m === 'color-scale' || m === 'box'
    ? style.highlight.color
    : idleColor(style, w);
}

function mixHex(a: string, b: string, p: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = (i: number): string =>
    Math.round(lerp(x[i] as number, y[i] as number, p))
      .toString(16)
      .padStart(2, '0');
  return `#${c(0)}${c(1)}${c(2)}`;
}

/* ------------------------------------------------------------------ block layout ---------------- */

interface BlockWord {
  idx: number;
  text: string;
}

export interface CapBlock {
  geo: CapGeo;
  lines: BlockWord[][];
  fontScale: number;
  fs: number;
  em: number;
  /** Widest line (steady-state growth reserved), canvas px. */
  maxW: number;
  pitch: number;
  centers: number[];
}

export type CapMeasure = (text: string, emPx: number) => number;

export function capMeasure(style: CaptionStyle, measure: TextMeasurer): CapMeasure {
  return (text, em) =>
    measure(text, {
      fontFamily: style.font.family,
      weight: style.font.weight,
      italic: style.font.italic,
      size: em,
    });
}

export function buildBlock(
  words: PreparedWord[],
  style: CaptionStyle,
  geo: CapGeo,
  meas: CapMeasure,
): CapBlock {
  const width = (text: string, size = geo.fontSize): number => {
    const em = emOf(geo, size);
    return meas(text, em) + [...text].length * geo.spacing * (size / geo.fontSize);
  };
  const cased = words.map((w) => applyCase(w.text, style.textCase));
  const lines: BlockWord[][] = [];
  let cur: BlockWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const trial = [...cur, { idx: i, text: cased[i] as string }];
    const w = width(trial.map((b) => b.text).join(' '));
    if (cur.length > 0 && w > geo.usableW) {
      lines.push(cur);
      cur = [{ idx: i, text: cased[i] as string }];
    } else cur = trial;
  }
  if (cur.length) lines.push(cur);
  const grow = Math.max(0, animPlan(style).steady / 100 - 1);
  const widths = lines.map((l) => {
    const w = width(l.map((b) => b.text).join(' '));
    const widest = Math.max(0, ...l.map((b) => width(b.text)));
    return w + grow * widest;
  });
  const maxW0 = Math.max(0, ...widths);
  const fontScale = maxW0 > geo.usableW ? Math.max(0.5, geo.usableW / maxW0) : 1;
  const fs = fontScale < 1 ? Math.round(geo.fontSize * fontScale) : geo.fontSize;
  const em = emOf(geo, fs);
  const wide = lines.some((l) =>
    l.some((b) => [...b.text].some((c) => isWideCp(c.codePointAt(0) ?? 0))),
  );
  let pitch = em * 1.18 + geo.outline * 1.2 * fontScale;
  if (wide) pitch = Math.max(pitch, fs * 1.02 + geo.outline * 1.2 * fontScale);
  const centers = lines.map((_l, i) => geo.cy + (i - (lines.length - 1) / 2) * pitch);
  return { geo, lines, fontScale, fs, em, maxW: maxW0 * (fs / geo.fontSize), pitch, centers };
}

const isWideCp = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x11ff) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f000 && cp <= 0x1faff) ||
  (cp >= 0x2600 && cp <= 0x27bf);

interface Ink {
  top: number;
  bottom: number;
}
function lineInk(geo: CapGeo, blk: CapBlock): Ink {
  const asc = geo.face?.ascent ?? 1.0;
  const cap = geo.face?.capHeight ?? 0.7;
  const baseline = asc * blk.em - blk.fs / 2;
  return { top: baseline - cap * blk.em, bottom: baseline + 0.22 * blk.em };
}

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export function chunkBox(geo: CapGeo, blk: CapBlock): BoxRect {
  const ink = lineInk(geo, blk);
  const padV = Math.round(geo.pad * 0.8);
  const first = blk.centers[0] ?? geo.cy;
  const last = blk.centers[blk.centers.length - 1] ?? geo.cy;
  const y = first + ink.top - padV;
  const bottom = last + ink.bottom + padV;
  const w = blk.maxW + 2 * geo.pad;
  const x = geo.left ? geo.cx - geo.pad : geo.cx - w / 2;
  const h = bottom - y;
  return { x, y, w, h, r: Math.min(h / 2, h * (geo.left ? 0.2 : 0.34)) };
}

/** The item's natural (selection) rect: the caption box if there is one, else the text bounds. */
export function subtitleBounds(style: CaptionStyle, blk: CapBlock): Geom {
  const geo = blk.geo;
  const ink = lineInk(geo, blk);
  const first = blk.centers[0] ?? geo.cy;
  const last = blk.centers[blk.centers.length - 1] ?? geo.cy;
  const padH = style.box.enabled ? geo.pad : 0;
  const padV = style.box.enabled ? Math.round(geo.pad * 0.8) : 0;
  const w = blk.maxW + 2 * padH;
  const top = first + ink.top - padV;
  const bottom = last + ink.bottom + padV;
  const x0 = geo.left ? geo.cx - padH : geo.cx - w / 2;
  return { cx: x0 + w / 2, cy: (top + bottom) / 2, hw: w / 2, hh: (bottom - top) / 2, rot: 0 };
}

/* ------------------------------------------------------------------ per-frame state ------------- */

interface RunState {
  idx: number;
  text: string;
  scale: number;
  fill: string;
  /** Active word of a box-highlight style: drawn flat (no outline / shadow). */
  flat: boolean;
  /** Karaoke: fraction swept (0..1) and the swept colour; typewriter: number of graphemes shown (null = all). */
  sweep: number | null;
  sweptFill: string;
  shown: number | null;
}

export interface SubFrame {
  /** Cache key of the raster (changes only when pixels change). */
  key: string;
  /** Whole-block alpha (fade / slide-up entrance and exit). */
  opacity: number;
  /** Extra downward offset in canvas px (slide-up entrance). */
  dy: number;
  geo: CapGeo;
  block: CapBlock;
  bounds: Geom;
  /** Where the raster's top-left sits on the canvas, canvas px. */
  origin: { x: number; y: number };
  /** Raster size in canvas px (before pixel rounding). */
  drawW: number;
  drawH: number;
  paint: (scale: number) => Raster;
}

const graphemes: { segment(s: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (
        Intl as unknown as {
          Segmenter: new (
            l?: string,
            o?: object,
          ) => { segment(s: string): Iterable<{ segment: string }> };
        }
      ).Segmenter(undefined, { granularity: 'grapheme' })
    : null;
const unitsOf = (text: string): string[] =>
  graphemes ? [...graphemes.segment(text)].map((g) => g.segment) : Array.from(text);

/** The visual state of a subtitle at item-local time `tl` (pure given `meas`). */
export function subtitleFrame(
  item: SubtitleItem,
  style: CaptionStyle,
  words: PreparedWord[],
  block: CapBlock,
  tl: number,
  styleKey: string,
): SubFrame {
  const geo = block.geo;
  const active =
    words.length && tl >= (words[0] as PreparedWord).s - 1e-9 ? lastStartedIndex(words, tl) : -1;
  const anim = style.animation;
  const runs = new Map<number, RunState>();
  const keyParts: string[] = [];
  const boxHighlight = style.highlight.mode === 'box';

  for (const line of block.lines)
    for (const bw of line) {
      const w = words[bw.idx] as PreparedWord;
      const idle = idleColor(style, w);
      const act = activeColor(style, w);
      const r: RunState = {
        idx: bw.idx,
        text: bw.text,
        scale: 1,
        fill: idle,
        flat: false,
        sweep: null,
        sweptFill: act,
        shown: null,
      };
      if (anim === 'karaoke') {
        const span = Math.max(1e-6, w.e - w.s);
        const f = w.e > w.s ? Math.min(1, Math.max(0, (tl - w.s) / span)) : tl >= w.s ? 1 : 0;
        r.sweep = f;
        r.fill = idle;
        r.sweptFill = act;
      } else if (anim === 'typewriter') {
        const units = unitsOf(bw.text);
        const real = units.length;
        const so = Math.round(w.s * 100) * 10;
        const eo = Math.max(so + 10, Math.round(Math.max(w.e, w.s) * 100) * 10);
        const dur = Math.max(10, eo - so);
        const step = Math.max(12, Math.min(60, Math.floor((dur * 0.85) / Math.max(1, real))));
        const ms = tl * 1000;
        r.shown = ms < so ? 0 : Math.min(real, Math.floor((ms - so) / step) + 1);
        const inWord = style.highlight.mode !== 'none' && ms >= so && ms < eo;
        r.fill = inWord ? act : idle;
      } else if (bw.idx === active) {
        const ms = Math.max(0, (tl - w.s) * 1000);
        r.scale = activeScale(style, ms);
        // fade / slide-up: the colour eases idle → active over 120 ms (quantised to 1/16: identical pixels share a key)
        r.fill =
          anim === 'fade' || anim === 'slide-up'
            ? mixHex(idle, act, Math.round(Math.min(1, ms / 120) * 16) / 16)
            : act;
        r.flat = boxHighlight;
      }
      // quantise so that identical pixels share a cache key
      r.scale = Math.round(r.scale * 400) / 400;
      if (r.sweep !== null) r.sweep = Math.round(r.sweep * 64) / 64;
      runs.set(bw.idx, r);
      keyParts.push(`${r.scale}|${r.fill}|${r.sweep ?? ''}|${r.shown ?? ''}|${r.flat ? 1 : 0}`);
    }

  // entrance / exit (fade, slide-up): linear \fad and \move
  let opacity = 1;
  let dy = 0;
  if (anim === 'fade' || anim === 'slide-up') {
    const inMs = anim === 'slide-up' ? 90 : 140;
    const outMs = 110;
    const tms = tl * 1000;
    const remain = (item.durationSec - tl) * 1000;
    opacity = Math.min(1, Math.max(0, tms / inMs), Math.max(0, remain / outMs));
    if (anim === 'slide-up') {
      const slidePx = Math.max(8, Math.round(geo.H * 0.022));
      dy = slidePx * (1 - Math.min(1, Math.max(0, tms / 180)));
    }
  }

  const bounds = subtitleBounds(style, block);
  // raster strip: full canvas width, vertical extent of the block + everything it can paint
  const grow = Math.max(0.2, animPlan(style).peak / 100 - 1, 0.25);
  const margin =
    Math.ceil(
      geo.outline +
        geo.shadow +
        style.shadow.blurPx * geo.k * 2 +
        (style.box.enabled ? geo.pad : 0) +
        geo.pad +
        block.fs * grow * 0.5,
    ) + 8;
  const stripH = (block.lines.length - 1) * block.pitch + block.fs * 1.6 + 2 * margin;
  const drawW = geo.W;
  const drawH = stripH;
  const originY = geo.cy - drawH / 2;
  const key = `${styleKey}|${geo.W}x${geo.H}|${keyParts.join(';')}`;

  const frame: SubFrame = {
    key,
    opacity,
    dy,
    geo,
    block,
    bounds,
    origin: { x: 0, y: originY },
    drawW,
    drawH,
    paint: (scale) => paintSubtitle(frame, style, words, runs, scale),
  };
  return frame;
}

function lastStartedIndex(words: PreparedWord[], tl: number): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) if ((words[i] as PreparedWord).s <= tl + 1e-9) idx = i;
  return idx;
}

/* ------------------------------------------------------------------ painting -------------------- */

interface PaintCtx {
  frame: SubFrame;
  style: CaptionStyle;
  words: PreparedWord[];
  runs: Map<number, RunState>;
  meas: CapMeasure;
}

function paintSubtitle(
  frame: SubFrame,
  style: CaptionStyle,
  words: PreparedWord[],
  runs: Map<number, RunState>,
  scale: number,
): Raster {
  const { geo, block } = frame;
  const r = newRaster(frame.drawW, frame.drawH, scale);
  const sx = r.pxW / r.drawW;
  const sy = r.pxH / r.drawH;
  const ctx = ctx2d(r.canvas);
  ctx.clearRect(0, 0, r.pxW, r.pxH);
  // canvas px → raster px
  const ox = geo.W / 2 - r.drawW / 2;
  const oy = geo.cy - r.drawH / 2;
  const setTransform = (c: Ctx2D): void => c.setTransform(sx, 0, 0, sy, -ox * sx, -oy * sy);
  setTransform(ctx);

  const meas = canvasMeasure(style);
  const pc: PaintCtx = { frame, style, words, runs, meas };

  // 1. boxes
  if (style.box.enabled) {
    const b = chunkBox(geo, block);
    ctx.fillStyle = rgba(style.box.color, style.box.opacity);
    roundRectPath(ctx, b.x, b.y, b.w, b.h, b.r);
    ctx.fill();
  }
  const active = [...runs.values()].find((q) => q.flat);
  if (style.highlight.mode === 'box' && active) {
    const wb = wordBox(pc, active.idx);
    if (wb) {
      ctx.fillStyle = style.highlight.boxColor;
      roundRectPath(ctx, wb.x, wb.y, wb.w, wb.h, wb.r);
      ctx.fill();
    }
  }

  // 2. shadow skins (painted into a scratch layer, then blurred + offset onto the canvas)
  const shadowSkins = shadowPlan(style, geo);
  for (const sk of shadowSkins) {
    const layer = createRasterCanvas(r.pxW, r.pxH);
    const lctx = ctx2d(layer);
    setTransform(lctx);
    paintRuns(lctx, pc, { solid: style.shadow.color, bord: sk.bord, flatBorder: false });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = sk.alpha;
    if (sk.blur > 0) ctx.filter = `blur(${sk.blur * sx}px)`;
    ctx.drawImage(layer as CanvasImageSource, sk.dx * sx, sk.dy * sy);
    ctx.restore();
  }

  // 3. text
  paintRuns(ctx, pc, { solid: null, bord: geo.outline, flatBorder: true });
  return r;
}

interface Skin {
  bord: number;
  blur: number;
  dx: number;
  dy: number;
  alpha: number;
}

/** Port of ass.ts `shadowSkins` + the hard `\shad` shadow: copies painted under the text. */
function shadowPlan(style: CaptionStyle, geo: CapGeo): Skin[] {
  const { opacity, blurPx, offsetPx } = style.shadow;
  if (opacity <= 0) return [];
  if (blurPx <= 0) {
    return geo.shadow > 0
      ? [{ bord: geo.outline, blur: 0, dx: geo.shadow, dy: geo.shadow, alpha: opacity }]
      : [];
  }
  const blur = Math.max(1, blurPx * geo.k * 0.5);
  if (offsetPx > 0) {
    const d = Math.max(1, Math.round(offsetPx * geo.k));
    return [{ bord: geo.outline, blur, dx: d, dy: d, alpha: opacity }];
  }
  return [
    { bord: geo.outline + blur * 0.9, blur, dx: 0, dy: 0, alpha: opacity * 0.55 },
    { bord: geo.outline + blur * 0.35, blur: blur * 0.45, dx: 0, dy: 0, alpha: opacity * 0.85 },
  ];
}

function runWidth(pc: PaintCtx, r: RunState, last: boolean): number {
  const { frame } = pc;
  const block = frame.block;
  const em = block.em * r.scale;
  const text = last ? r.text : `${r.text} `;
  return (
    pc.meas(text, em) +
    [...text].length * frame.geo.spacing * (block.fs / frame.geo.fontSize) * r.scale
  );
}

interface PaintOpts {
  /** Paint everything in this one colour (shadow copies); null = real colours. */
  solid: string | null;
  bord: number;
  /** Active words of a box-highlight style lose their outline in the main pass. */
  flatBorder: boolean;
}

function paintRuns(ctx: Ctx2D, pc: PaintCtx, o: PaintOpts): void {
  const { frame, style, runs } = pc;
  const { block, geo } = frame;
  const asc = geo.face?.ascent ?? 1.0;
  const desc = geo.face?.descent ?? 0.4;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  block.lines.forEach((line, li) => {
    const lrs = line.map((b) => runs.get(b.idx) as RunState);
    const widths = lrs.map((r, i) => runWidth(pc, r, i === lrs.length - 1));
    const total = widths.reduce((a, b) => a + b, 0);
    let x = geo.left ? geo.cx : geo.cx - total / 2;
    const maxAsc = Math.max(...lrs.map((r) => asc * block.em * r.scale));
    const maxDesc = Math.max(...lrs.map((r) => desc * block.em * r.scale));
    const baseline = (block.centers[li] as number) + (maxAsc - maxDesc) / 2;
    lrs.forEach((r, i) => {
      const last = i === lrs.length - 1;
      const text = last ? r.text : `${r.text} `;
      const em = block.em * r.scale;
      const { font } = cssFont(
        pc.style.font.family,
        pc.style.font.weight,
        pc.style.font.italic,
        em,
      );
      ctx.font = font;
      if ('letterSpacing' in ctx)
        (ctx as CanvasRenderingContext2D).letterSpacing =
          `${geo.spacing * (block.fs / geo.fontSize) * r.scale}px`;
      const shownText = r.shown === null ? text : unitsOf(text).slice(0, r.shown).join('');
      const bord = o.flatBorder && r.flat ? 0 : o.bord;
      if (shownText !== '') {
        if (bord > 0) {
          ctx.strokeStyle = o.solid ?? style.stroke.color;
          ctx.lineWidth = bord * 2;
          ctx.strokeText(shownText, x, baseline);
        }
        ctx.fillStyle = o.solid ?? r.fill;
        ctx.fillText(shownText, x, baseline);
        if (r.sweep !== null && r.sweep > 0 && o.solid === null) {
          const wTrim = pc.meas(r.text, em);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x - 2, baseline - em * 2, wTrim * r.sweep + 2, em * 4);
          ctx.clip();
          ctx.fillStyle = r.sweptFill;
          ctx.fillText(shownText, x, baseline);
          ctx.restore();
        }
      }
      x += widths[i] as number;
    });
  });
}

/** Port of ass.ts `wordBox`: box behind the active word (highlight mode "box"). */
function wordBox(pc: PaintCtx, idx: number): BoxRect | null {
  const { frame, meas } = pc;
  const { block, geo } = frame;
  const li = block.lines.findIndex((l) => l.some((x) => x.idx === idx));
  const line = block.lines[li];
  if (!line) return null;
  const pos = line.findIndex((x) => x.idx === idx);
  const sp = (text: string): number =>
    meas(text, block.em) + [...text].length * geo.spacing * (block.fs / geo.fontSize);
  const lineText = line.map((x) => x.text).join(' ');
  const lineW = sp(lineText);
  const prefixW =
    pos > 0
      ? sp(
          `${line
            .slice(0, pos)
            .map((x) => x.text)
            .join(' ')} `,
        )
      : 0;
  const wordW = sp((line[pos] as BlockWord).text);
  const lineLeft = geo.left ? geo.cx : geo.cx - lineW / 2;
  const ink = lineInk(geo, block);
  const centre = block.centers[li] ?? geo.cy;
  const padH = geo.pad;
  const padV = Math.round(geo.pad * 0.7);
  const y = centre + ink.top - padV;
  const h = centre + ink.bottom + padV - y;
  return { x: lineLeft + prefixW - padH, y, w: wordW + 2 * padH, h, r: Math.min(h / 2, h * 0.28) };
}

/** Measure bound to Canvas2D for painting (the pure code paths take an injected measurer). */
function canvasMeasure(style: CaptionStyle): CapMeasure {
  const c = ctx2d(createRasterCanvas(1, 1));
  return (text, em) => {
    c.font = cssFont(style.font.family, style.font.weight, style.font.italic, em).font;
    if ('letterSpacing' in c) (c as CanvasRenderingContext2D).letterSpacing = '0px';
    return c.measureText(text).width;
  };
}
