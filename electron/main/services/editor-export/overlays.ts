/**
 * Text layers, shapes and the subtitle track → ASS (libass). Text/shape animation is SAMPLED per frame from the
 * shared evaluator (textAnimAt / resolveTransform / progressFraction) into events whose tags are constant, so
 * the picture equals the evaluator at every rendered frame (consecutive identical frames are merged).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CaptionStyle } from '@shared/cp2';
import type {
  BlendMode,
  ExportSettings,
  Project,
  ShapeItem,
  SubtitleItem,
  TextItem,
  Track,
} from '@shared/editor';
import {
  itemEnd,
  progressFraction,
  resolveTransform,
  textAnimAt,
  visibleChars,
} from '@shared/editor-eval';
import type { Word } from '@shared/pipeline';
import type { CaptionService } from '../../pipeline/contracts';
import { assHeader, assTime, roundedRectPath } from '../captions/ass';
import { fontBook, measureText } from '../captions/fontbook';
import { assAlpha, assColor, assTagColor } from '../captions/styles';
import { escapeAssText } from '../captions/text';
import { num } from './pl';
import type { ItemFrameInfo, TrackFrames } from './timeline';
import type { Ctx } from './types';

export interface OverlayLayer {
  assPath: string;
  blend: BlendMode;
  ja: number;
  jb: number;
}

const FONT_FALLBACK = 'Montserrat';

/* ----------------------------------------------------------------------------- shared bits ------ */

const r1 = (n: number): string => num(n, 2);
const alphaTag = (opacity: number): string => assAlpha(Math.min(1, Math.max(0, opacity)));

interface FontSetup {
  name: string;
  bold: boolean;
  italic: boolean;
  /** ASS size = CSS size × (ascent + descent). */
  cell: number;
  face: ReturnType<typeof fontBook.resolve>;
}

function resolveTextFont(family: string, weight: number, italic: boolean): FontSetup {
  const face =
    fontBook.resolve(family, weight, italic) ?? fontBook.resolve(FONT_FALLBACK, weight, italic);
  if (face) {
    return {
      name: face.assName,
      bold: face.weight >= 600,
      italic,
      cell: Math.max(0.5, face.ascent + face.descent),
      face,
    };
  }
  return { name: family, bold: weight >= 600, italic, cell: 1.2, face: null };
}

interface WrapLine {
  text: string;
  /** Code-point range of the line inside the whole text (typewriter reveals by index). */
  start: number;
  end: number;
  /** Advance incl. letter spacing after EVERY code point (libass \fsp), output px at scale 1. */
  width: number;
}

/**
 * The preview's rules (renderer/lib/editor/compositor/text-layout.ts): greedy wrap at spaces, `\n` always breaks,
 * an over-long word is never split, leading / trailing spaces of a line are dropped, interior spaces kept.
 */
function wrapText(
  text: string,
  font: FontSetup,
  fsAss: number,
  ls: number,
  wrapW: number,
): WrapLine[] {
  const cps = Array.from(text);
  const advance = (str: string): number =>
    str === '' ? 0 : measureText(font.face, str, fsAss, 0) + Array.from(str).length * ls;
  const lines: WrapLine[] = [];
  const isSpace = (c: string): boolean => c === ' ' || c === '\t';
  let p = 0;
  while (p <= cps.length) {
    let q = p;
    while (q < cps.length && cps[q] !== '\n') q++;
    const toks: [number, number][] = [];
    for (let i = p; i < q;) {
      if (isSpace(cps[i] as string)) {
        i++;
        continue;
      }
      let j = i;
      while (j < q && !isSpace(cps[j] as string)) j++;
      toks.push([i, j]);
      i = j;
    }
    if (toks.length === 0) lines.push({ text: '', start: p, end: p, width: 0 });
    else {
      const seg = (a: number, b: number): string =>
        cps.slice((toks[a] as [number, number])[0], (toks[b] as [number, number])[1]).join('');
      let first = 0;
      let cur = '';
      for (let k = 0; k < toks.length; k++) {
        const cand = seg(first, k);
        if (k > first && advance(cand) > wrapW) {
          const t = seg(first, k - 1);
          lines.push({
            text: t,
            start: (toks[first] as [number, number])[0],
            end: (toks[k - 1] as [number, number])[1],
            width: advance(t),
          });
          first = k;
          cur = seg(first, k);
        } else cur = cand;
      }
      lines.push({
        text: cur,
        start: (toks[first] as [number, number])[0],
        end: (toks[toks.length - 1] as [number, number])[1],
        width: advance(cur),
      });
    }
    p = q + 1;
  }
  return lines;
}

interface Event {
  layer: number;
  start: number;
  end: number;
  style: string;
  text: string;
}

const dialogue = (e: Event): string =>
  `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`;

/** Merges consecutive frames with equal keys into [kStart, kEnd) runs. */
function runsOf(keys: string[]): { k0: number; k1: number }[] {
  const out: { k0: number; k1: number }[] = [];
  let s = 0;
  for (let k = 1; k <= keys.length; k++) {
    if (k === keys.length || keys[k] !== keys[s]) {
      out.push({ k0: s, k1: k });
      s = k;
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------- text ------------ */

function textEvents(ctx: Ctx, item: TextItem, info: ItemFrameInfo, styleName: string): Event[] {
  const { grid, K, cw, W, H } = ctx;
  const st = item.style;
  const font = resolveTextFont(st.fontFamily, st.weight, st.italic);
  const size = st.size * K;
  const fsBase = size * font.cell;
  const spacingBase = st.letterSpacing * K;
  const maxW = (st.maxWidth ?? cw * 0.8) * K;
  const lines = wrapText(item.text, font, fsBase, spacingBase, maxW);
  const widths = lines.map((l) => l.width);
  const blockW = Math.max(1, ...widths);
  const lineH = st.lineHeight * size;
  const m = info.jb - info.ja;

  interface Fr {
    cx: number;
    cy: number;
    s: number;
    rot: number;
    opa: number;
    chars: number;
  }
  const frames: Fr[] = [];
  const total = Array.from(item.text).length;
  for (let k = 0; k < m; k++) {
    const j = info.ja + k;
    const tl = grid.time(j) - item.startSec;
    const tr = resolveTransform({ ...item, fadeInSec: 0, fadeOutSec: 0 }, tl, false);
    const an = textAnimAt(item, tl);
    const ops = info.ops[k];
    const sOps = ops?.scale ?? 1;
    frames.push({
      cx: W / 2 + K * tr.x * sOps + (an.dx + (ops?.dx ?? 0)) * W,
      cy: ctx.H / 2 + K * tr.y * sOps + (an.dy + (ops?.dy ?? 0)) * H,
      s: tr.scale * an.scale * sOps,
      rot: tr.rotation,
      opa: tr.opacity * an.opacity * (ops?.opacity ?? 1),
      chars: an.visible >= 1 ? total : visibleChars(item.text, an.visible),
    });
  }
  const keys = frames.map(
    (f) =>
      `${f.cx.toFixed(1)}|${f.cy.toFixed(1)}|${f.s.toFixed(3)}|${f.rot.toFixed(2)}|${f.opa.toFixed(3)}|${f.chars}`,
  );
  const events: Event[] = [];
  const half = 0.5 / ctx.fps;
  const fill = assTagColor(st.color);
  for (const run of runsOf(keys)) {
    const f = frames[run.k0] as Fr;
    if (f.opa <= 0.002 || f.s <= 0.005 || f.chars <= 0) continue;
    const start = grid.out(info.ja + run.k0) - half;
    const end = grid.out(info.ja + run.k1 - 1) + half;
    const s = f.s;
    const fs = fsBase * s;
    const sp = spacingBase * s;
    const lh = lineH * s;
    const org = `\\org(${r1(f.cx)},${r1(f.cy)})`;
    const frz = Math.abs(f.rot) > 0.01 ? `\\frz${num(-f.rot, 2)}` : '';
    const boxPad = st.box ? st.box.padding * K * s : 0;
    const top = f.cy - ((lines.length - 1) / 2) * lh;

    // box (layer 0)
    if (st.box && st.box.opacity > 0) {
      const bw = blockW * s + 2 * boxPad;
      const bh = lines.length * lh + 2 * boxPad;
      const x0 = f.cx - bw / 2;
      const y0 = f.cy - bh / 2;
      const rad = Math.min(st.box.radius * K * s, bw / 2, bh / 2);
      events.push({
        layer: 0,
        start,
        end,
        style: styleName,
        text: `{\\an7\\pos(${r1(x0)},${r1(y0)})${org}${frz}\\bord0\\shad0\\blur0.5\\1c${assTagColor(st.box.color)}\\1a${alphaTag(st.box.opacity * f.opa)}\\p1}${roundedRectPath(Math.round(bw), Math.round(bh), rad)}{\\p0}`,
      });
    }

    lines.forEach((wl, li) => {
      const chars = Array.from(wl.text);
      const showN = Math.max(0, Math.min(chars.length, f.chars - wl.start));
      if (showN <= 0) return;
      const shown = chars.slice(0, showN).join('');
      const hidden = chars.slice(showN).join('');
      const w = (widths[li] as number) * s;
      const lx =
        st.align === 'left'
          ? f.cx - (blockW * s) / 2 + w / 2
          : st.align === 'right'
            ? f.cx + (blockW * s) / 2 - w / 2
            : f.cx;
      const ly = top + li * lh;
      const body = `${escapeAssText(shown)}${hidden ? `{\\alpha&HFF&}${escapeAssText(hidden)}` : ''}`;
      const common = `\\an5\\q2\\fs${r1(fs)}\\fsp${num(sp, 2)}${org}${frz}`;
      const bord = st.stroke ? st.stroke.width * K * s : 0;
      // soft shadow: a blurred copy underneath (libass cannot blur a shadow on its own)
      const sh = st.shadow;
      if (sh && sh.blur > 0 && sh.opacity > 0) {
        const a = alphaTag(sh.opacity * f.opa);
        events.push({
          layer: 0,
          start,
          end,
          style: styleName,
          text: `{${common}\\pos(${r1(lx + sh.offsetX * K * s)},${r1(ly + sh.offsetY * K * s)})\\bord${num(bord, 2)}\\blur${num(Math.max(0.5, sh.blur * K * s * 0.5), 1)}\\1c${assTagColor(sh.color)}\\3c${assTagColor(sh.color)}\\1a${a}\\3a${a}\\4a&HFF&\\shad0}${body}`,
        });
      }
      const shadowTags =
        sh && sh.blur <= 0 && sh.opacity > 0
          ? `\\xshad${num(sh.offsetX * K * s, 2)}\\yshad${num(sh.offsetY * K * s, 2)}\\4c${assTagColor(sh.color)}\\4a${alphaTag(sh.opacity * f.opa)}`
          : '\\shad0\\4a&HFF&';
      events.push({
        layer: 1,
        start,
        end,
        style: styleName,
        text: `{${common}\\pos(${r1(lx)},${r1(ly)})\\bord${num(bord, 2)}\\blur0.3\\1c${fill}\\1a${alphaTag(f.opa)}\\3c${assTagColor(st.stroke?.color ?? '#000000')}\\3a${alphaTag(st.stroke ? f.opa : 0)}${shadowTags}}${body}`,
      });
    });
  }
  return events;
}

function textStyleLine(name: string, item: TextItem, ctx: Ctx): string {
  const st = item.style;
  const font = resolveTextFont(st.fontFamily, st.weight, st.italic);
  const size = st.size * ctx.K * font.cell;
  return [
    `Style: ${name}`,
    font.name,
    r1(size),
    assColor(st.color),
    assColor(st.color),
    assColor('#000000'),
    assColor('#000000', 0),
    font.bold ? -1 : 0,
    font.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    0,
    0,
    5,
    0,
    0,
    0,
    1,
  ].join(',');
}

/* ----------------------------------------------------------------------------- shapes ----------- */

const KAPPA = 0.5523;
const f1 = (n: number): string => r1(n);

/** Rounded rectangle at (x,y); `cw` = clockwise (outer contour), else counter-clockwise (a hole in a ring). */
function rrect(x: number, y: number, w: number, h: number, rad: number, cw: boolean): string {
  const r = Math.max(0, Math.min(rad, w / 2, h / 2));
  const c = r * KAPPA;
  if (r < 0.5) {
    return cw
      ? `m ${f1(x)} ${f1(y)} l ${f1(x + w)} ${f1(y)} l ${f1(x + w)} ${f1(y + h)} l ${f1(x)} ${f1(y + h)}`
      : `m ${f1(x)} ${f1(y)} l ${f1(x)} ${f1(y + h)} l ${f1(x + w)} ${f1(y + h)} l ${f1(x + w)} ${f1(y)}`;
  }
  if (cw) {
    return [
      `m ${f1(x + r)} ${f1(y)}`,
      `l ${f1(x + w - r)} ${f1(y)}`,
      `b ${f1(x + w - r + c)} ${f1(y)} ${f1(x + w)} ${f1(y + r - c)} ${f1(x + w)} ${f1(y + r)}`,
      `l ${f1(x + w)} ${f1(y + h - r)}`,
      `b ${f1(x + w)} ${f1(y + h - r + c)} ${f1(x + w - r + c)} ${f1(y + h)} ${f1(x + w - r)} ${f1(y + h)}`,
      `l ${f1(x + r)} ${f1(y + h)}`,
      `b ${f1(x + r - c)} ${f1(y + h)} ${f1(x)} ${f1(y + h - r + c)} ${f1(x)} ${f1(y + h - r)}`,
      `l ${f1(x)} ${f1(y + r)}`,
      `b ${f1(x)} ${f1(y + r - c)} ${f1(x + r - c)} ${f1(y)} ${f1(x + r)} ${f1(y)}`,
    ].join(' ');
  }
  return [
    `m ${f1(x + r)} ${f1(y)}`,
    `b ${f1(x + r - c)} ${f1(y)} ${f1(x)} ${f1(y + r - c)} ${f1(x)} ${f1(y + r)}`,
    `l ${f1(x)} ${f1(y + h - r)}`,
    `b ${f1(x)} ${f1(y + h - r + c)} ${f1(x + r - c)} ${f1(y + h)} ${f1(x + r)} ${f1(y + h)}`,
    `l ${f1(x + w - r)} ${f1(y + h)}`,
    `b ${f1(x + w - r + c)} ${f1(y + h)} ${f1(x + w)} ${f1(y + h - r + c)} ${f1(x + w)} ${f1(y + h - r)}`,
    `l ${f1(x + w)} ${f1(y + r)}`,
    `b ${f1(x + w)} ${f1(y + r - c)} ${f1(x + w - r + c)} ${f1(y)} ${f1(x + w - r)} ${f1(y)}`,
  ].join(' ');
}

function ellipse(x: number, y: number, w: number, h: number, cw: boolean): string {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  const cwPath = [
    `m ${f1(x)} ${f1(cy)}`,
    `b ${f1(x)} ${f1(cy - ky)} ${f1(cx - kx)} ${f1(y)} ${f1(cx)} ${f1(y)}`,
    `b ${f1(cx + kx)} ${f1(y)} ${f1(x + w)} ${f1(cy - ky)} ${f1(x + w)} ${f1(cy)}`,
    `b ${f1(x + w)} ${f1(cy + ky)} ${f1(cx + kx)} ${f1(y + h)} ${f1(cx)} ${f1(y + h)}`,
    `b ${f1(cx - kx)} ${f1(y + h)} ${f1(x)} ${f1(cy + ky)} ${f1(x)} ${f1(cy)}`,
  ];
  if (cw) return cwPath.join(' ');
  return [
    `m ${f1(x)} ${f1(cy)}`,
    `b ${f1(x)} ${f1(cy + ky)} ${f1(cx - kx)} ${f1(y + h)} ${f1(cx)} ${f1(y + h)}`,
    `b ${f1(cx + kx)} ${f1(y + h)} ${f1(x + w)} ${f1(cy + ky)} ${f1(x + w)} ${f1(cy)}`,
    `b ${f1(x + w)} ${f1(cy - ky)} ${f1(cx + kx)} ${f1(y)} ${f1(cx)} ${f1(y)}`,
    `b ${f1(cx - kx)} ${f1(y)} ${f1(x)} ${f1(cy - ky)} ${f1(x)} ${f1(cy)}`,
  ].join(' ');
}

/** Right-pointing arrow in a w×h box: shaft 40 % of the height, head min(w/2, 0.9·h) long and h tall. */
function arrow(x: number, y: number, w: number, h: number, cw: boolean): string {
  const head = Math.min(w / 2, 0.9 * h);
  const shaft = 0.4 * h;
  const y0 = y + (h - shaft) / 2;
  const y1 = y0 + shaft;
  const pts: [number, number][] = [
    [x, y0],
    [x + w - head, y0],
    [x + w - head, y],
    [x + w, y + h / 2],
    [x + w - head, y + h],
    [x + w - head, y1],
    [x, y1],
  ];
  const ordered = cw ? pts : [...pts].reverse();
  return ordered.map(([px, py], i) => `${i === 0 ? 'm' : 'l'} ${f1(px)} ${f1(py)}`).join(' ');
}

function shapePath(
  shape: ShapeItem['shape'],
  x: number,
  y: number,
  w: number,
  h: number,
  rad: number,
  cw: boolean,
): string {
  if (shape === 'ellipse') return ellipse(x, y, w, h, cw);
  if (shape === 'arrow') return arrow(x, y, w, h, cw);
  return rrect(x, y, w, h, rad, cw);
}

function shapeEvents(ctx: Ctx, item: ShapeItem, info: ItemFrameInfo, styleName: string): Event[] {
  const { grid, K, W, H } = ctx;
  const m = info.jb - info.ja;
  interface Fr {
    cx: number;
    cy: number;
    s: number;
    rot: number;
    opa: number;
    p: number;
  }
  const frames: Fr[] = [];
  for (let k = 0; k < m; k++) {
    const j = info.ja + k;
    const tl = grid.time(j) - item.startSec;
    const tr = resolveTransform({ ...item, fadeInSec: 0, fadeOutSec: 0 }, tl, false);
    const ops = info.ops[k];
    const sOps = ops?.scale ?? 1;
    frames.push({
      cx: W / 2 + K * tr.x * sOps + (ops?.dx ?? 0) * W,
      cy: H / 2 + K * tr.y * sOps + (ops?.dy ?? 0) * H,
      s: tr.scale * sOps,
      rot: tr.rotation,
      opa: tr.opacity * (ops?.opacity ?? 1),
      p: item.shape === 'progress-bar' ? progressFraction(item.durationSec, tl) : 1,
    });
  }
  const keys = frames.map(
    (f) =>
      `${f.cx.toFixed(1)}|${f.cy.toFixed(1)}|${f.s.toFixed(3)}|${f.rot.toFixed(2)}|${f.opa.toFixed(3)}|${(f.p * 4000).toFixed(0)}`,
  );
  const half = 0.5 / ctx.fps;
  const events: Event[] = [];
  for (const run of runsOf(keys)) {
    const f = frames[run.k0] as Fr;
    if (f.opa <= 0.002 || f.s <= 0.005) continue;
    const start = grid.out(info.ja + run.k0) - half;
    const end = grid.out(info.ja + run.k1 - 1) + half;
    const W0 = item.width * K * f.s;
    const h = item.height * K * f.s;
    // progress bar: only the filled part, left-anchored in the natural rect; the radius is clamped to it
    const w = item.shape === 'progress-bar' ? W0 * f.p : W0;
    if (w < 0.5 || h < 0.5) continue;
    const x0 = f.cx - W0 / 2;
    const y0 = f.cy - h / 2;
    const rad = item.radius * K * f.s;
    const sw = item.stroke ? Math.min(item.stroke.width * K * f.s, Math.min(w, h) / 2) : 0;
    const frz = Math.abs(f.rot) > 0.01 ? `\\frz${num(-f.rot, 2)}` : '';
    const base = `\\an7\\pos(${r1(x0)},${r1(y0)})\\org(${r1(f.cx)},${r1(f.cy)})${frz}\\bord0\\shad0\\blur0.4\\p1`;
    // fill: the whole shape, fillOpacity applies to the fill only
    events.push({
      layer: 1,
      start,
      end,
      style: styleName,
      text: `{${base}\\1c${assTagColor(item.fill)}\\1a${alphaTag(item.fillOpacity * f.opa)}}${shapePath(item.shape === 'progress-bar' ? 'rect' : item.shape, 0, 0, w, h, rad, true)}{\\p0}`,
    });
    // stroke: an opaque band INSIDE the natural rect (outer contour + inner hole)
    if (item.stroke && sw >= 0.5) {
      const inner = shapePath(
        item.shape === 'progress-bar' ? 'rect' : item.shape,
        sw,
        sw,
        Math.max(0.5, w - 2 * sw),
        Math.max(0.5, h - 2 * sw),
        Math.max(0, rad - sw),
        false,
      );
      const outer = shapePath(
        item.shape === 'progress-bar' ? 'rect' : item.shape,
        0,
        0,
        w,
        h,
        rad,
        true,
      );
      events.push({
        layer: 2,
        start,
        end,
        style: styleName,
        text: `{${base}\\1c${assTagColor(item.stroke.color)}\\1a${alphaTag(f.opa)}}${outer} ${inner}{\\p0}`,
      });
    }
  }
  return events;
}

const shapeStyleLine = (name: string): string =>
  `Style: ${name},${FONT_FALLBACK},20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;

/* ----------------------------------------------------------------------------- subtitles -------- */

const KEEP_STYLE_RE = /^(Dialogue: \d+,[^,]+,[^,]+,)(Caption(?:Bg)?),/;

function parseAssTime(t: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

interface DLine {
  layer: string;
  start: number;
  end: number;
  rest: string;
}

function parseDialogue(line: string): DLine | null {
  const m = /^Dialogue: (\d+),(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),(.*)$/.exec(line);
  if (!m) return null;
  return {
    layer: m[1] as string,
    start: parseAssTime(m[2] as string),
    end: parseAssTime(m[3] as string),
    rest: m[4] as string,
  };
}

const fmtDialogue = (d: DLine, offset: number): string =>
  `Dialogue: ${d.layer},${assTime(d.start + offset)},${assTime(d.end + offset)},${d.rest}`;

/** Splits `{tags}text{tags}text` into alternating segments. */
const segments = (text: string): string[] => text.split(/(\{[^}]*\})/);

interface SubOut {
  styles: string[];
  events: string[];
}

const PUNCT_END = /[.?!…,;:–—]["')\]”’]*$/;

/**
 * One subtitle item = ONE caption block shown for the whole item (the preview's rule), built with the caption
 * engine: the chunker is neutralised (no phrase splits: a zero-width joiner hides trailing punctuation, word ends
 * are bridged to the next start, maxWords / maxChars lifted — lines still break by width), the entrance happens at
 * the item start, the block stays until the item end, and the active word is the last word that has started.
 */
function subtitleLines(
  ctx: Ctx,
  item: SubtitleItem,
  style: CaptionStyle,
  captions: Pick<CaptionService, 'buildAss'>,
  styleTag: string,
  r0: number,
): SubOut {
  const sorted = [...item.words].filter((w) => w.w.trim() !== '').sort((x, y) => x.s - y.s);
  const words: Word[] = sorted.map((w, i) => {
    const next = sorted[i + 1];
    const e = next ? Math.max(next.s, w.s) : Math.max(w.e, w.s);
    return { w: PUNCT_END.test(w.w.trim()) ? `${w.w}‍` : w.w, s: w.s, e };
  });
  const dur = item.durationSec;
  const lift = (st: CaptionStyle): CaptionStyle => ({
    ...st,
    chunking: { ...st.chunking, maxWords: 64, maxChars: 999 },
  });
  const build = (st: CaptionStyle, kw?: string[]): string[] =>
    captions
      .buildAss({
        words,
        startSec: 0,
        endSec: dur,
        width: ctx.W,
        height: ctx.H,
        style: lift(st),
        keywords: kw,
      })
      .split('\n');
  const dialogues = (doc: string[]): string[] => doc.filter((l) => l.startsWith('Dialogue:'));
  /** Dialogue lines with the per-word emphasis colours merged in (one extra pass per distinct colour). */
  const withColors = (st: CaptionStyle): string[] => {
    const base = dialogues(build(st));
    const merged = [...base];
    const byColor = new Map<string, string[]>();
    for (const w of item.words) {
      if (!w.color) continue;
      const list = byColor.get(w.color) ?? [];
      list.push(w.w);
      byColor.set(w.color, list);
    }
    for (const [color, ws] of byColor) {
      const pass = dialogues(build({ ...st, keywordColor: color }, ws));
      if (pass.length !== base.length) continue;
      for (let i = 0; i < merged.length; i++) {
        const a = segments(merged[i] as string);
        const b = segments(pass[i] as string);
        if (a.length !== b.length) continue;
        for (let k = 0; k < a.length; k++)
          if ((a[k] as string).startsWith('{') && a[k] !== b[k]) a[k] = b[k] as string;
        merged[i] = a.join('');
      }
    }
    return merged;
  };

  const main = withColors(style)
    .map(parseDialogue)
    .filter((d): d is DLine => d !== null);
  const doc0 = build(style);
  const styleLines = doc0.filter((l) => l.startsWith('Style:'));
  const out: DLine[] = [];
  if (main.length > 0) {
    const t0 = Math.min(...main.map((d) => d.start));
    const anim = style.animation;
    const blockAnim = anim === 'karaoke' || anim === 'typewriter';
    const stripEntrance = (txt: string): string =>
      txt
        .replace(/\\move\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),[^)]*\)/, '\\pos($3,$4)')
        .replace(/\\fad\((\d+),(\d+)\)/, (_m, _a: string, b: string) =>
          Number(b) > 0 ? `\\fad(0,${b})` : '',
        );
    const stripExit = (txt: string): string =>
      txt.replace(/\\fad\((\d+),\d+\)/, (_m, a: string) => (Number(a) > 0 ? `\\fad(${a},0)` : ''));
    const firstGroup = main.filter(
      (d) =>
        Math.abs(d.start - t0) < 1e-6 &&
        (blockAnim || Math.abs(d.end - (main[0] as DLine).end) < 1e-6),
    );
    if (t0 > 0.011 && blockAnim) {
      // block-level animations: start the block at the item start, shifting the internal clock
      for (const d of main) {
        if (Math.abs(d.start - t0) > 1e-6) continue;
        let rest = d.rest;
        if (anim === 'karaoke')
          rest = rest.replace(
            /\\k(\d+)\\kf/,
            (_m, g: string) => `\\k${Number(g) + Math.round(t0 * 100)}\\kf`,
          );
        else
          rest = rest.replace(
            /\\t\((\d+),(\d+),/g,
            (_m, a: string, b: string) =>
              `\\t(${Number(a) + Math.round(t0 * 1000)},${Number(b) + Math.round(t0 * 1000)},`,
          );
        out.push({ ...d, start: 0, end: Math.max(d.end, dur), rest });
      }
      for (const d of main) if (Math.abs(d.start - t0) > 1e-6) out.push(d);
    } else {
      // word-state animations
      if (t0 > 0.011) {
        // pre-roll: the block with no active word, carrying the entrance
        const idleStyle: CaptionStyle = {
          ...style,
          highlight: { ...style.highlight, mode: 'none' },
          animation: anim === 'fade' || anim === 'slide-up' ? anim : 'none',
        };
        const idle = withColors(idleStyle)
          .map(parseDialogue)
          .filter((d): d is DLine => d !== null);
        const it0 = idle.length ? Math.min(...idle.map((d) => d.start)) : 0;
        const firstIdle = idle.filter(
          (d) => Math.abs(d.start - it0) < 1e-6 && Math.abs(d.end - (idle[0] as DLine).end) < 1e-6,
        );
        for (const d of firstIdle) out.push({ ...d, start: 0, end: t0, rest: stripExit(d.rest) });
        for (const d of main) {
          const isFirst = firstGroup.includes(d);
          out.push(isFirst ? { ...d, rest: stripEntrance(d.rest) } : d);
        }
      } else out.push(...main);
      // hold the last word state until the item ends (the fade-out, if any, now ends with the item)
      const lastEnd = Math.max(...out.map((d) => d.end));
      for (const d of out) if (Math.abs(d.end - lastEnd) < 1e-6) d.end = Math.max(d.end, dur);
    }
    if (blockAnim) {
      const lastEnd = Math.max(...out.map((d) => d.end));
      for (const d of out) if (Math.abs(d.end - lastEnd) < 1e-6) d.end = Math.max(d.end, dur);
    }
  }
  const offset = item.startSec - r0;
  return {
    styles: styleLines.map((l) => l.replace(/^Style: (Caption(?:Bg)?),/, `Style: ${styleTag}_$1,`)),
    events: out.map((d) => fmtDialogue(d, offset).replace(KEEP_STYLE_RE, `$1${styleTag}_$2,`)),
  };
}

/* ----------------------------------------------------------------------------- entry point ------ */

export async function buildTrackOverlays(a: {
  ctx: Ctx;
  track: Track;
  frames: TrackFrames;
  workDir: string;
  fontsDir: string | null;
  settings: ExportSettings;
  getStyle(id: string): CaptionStyle;
  captions: Pick<CaptionService, 'buildAss' | 'buildSrt' | 'buildVtt'>;
}): Promise<OverlayLayer[]> {
  const { ctx, track, frames } = a;
  fontBook.addDir(a.fontsDir);
  const out: OverlayLayer[] = [];

  if (track.kind === 'subtitle') {
    if (!a.settings.burnCaptions) return out;
    const items = track.items.filter((i): i is SubtitleItem => i.type === 'subtitle');
    const styleSig = new Map<string, string>();
    const styles: string[] = [];
    const events: string[] = [];
    let ja = Infinity;
    let jb = 0;
    for (const item of items) {
      const info = frames.items.get(item.id);
      if (!info) continue;
      const style = item.styleOverride ?? a.getStyle(item.styleId);
      const sig = JSON.stringify(style);
      let tag = styleSig.get(sig);
      let fresh = false;
      if (!tag) {
        tag = `S${styleSig.size}`;
        styleSig.set(sig, tag);
        fresh = true;
      }
      const lines = subtitleLines(ctx, item, style, a.captions, tag, ctx.grid.r0);
      if (fresh) styles.push(...lines.styles);
      events.push(...lines.events);
      ja = Math.min(ja, info.ja);
      jb = Math.max(jb, info.jb);
    }
    if (events.length === 0) return out;
    const assPath = path.join(a.workDir, `sub-${track.id.replace(/[^a-z0-9_-]/gi, '_')}.ass`);
    await fs.promises.writeFile(
      assPath,
      `${assHeader(ctx.W, ctx.H, styles)}${events.join('\n')}\n`,
      'utf8',
    );
    out.push({ assPath, blend: 'normal', ja, jb });
    return out;
  }

  // text + shapes, grouped by blend mode (a non-normal blend needs its own canvas)
  const groups = new Map<
    BlendMode,
    { styles: string[]; events: Event[]; ja: number; jb: number }
  >();
  let seq = 0;
  for (const item of track.items) {
    if (item.type !== 'text' && item.type !== 'shape') continue;
    const info = frames.items.get(item.id);
    if (!info) continue;
    const g = groups.get(item.blend) ?? { styles: [], events: [], ja: Infinity, jb: 0 };
    const name = `X${seq++}`;
    if (item.type === 'text') {
      g.styles.push(textStyleLine(name, item, ctx));
      g.events.push(...textEvents(ctx, item, info, name));
    } else {
      g.styles.push(shapeStyleLine(name));
      g.events.push(...shapeEvents(ctx, item, info, name));
    }
    g.ja = Math.min(g.ja, info.ja);
    g.jb = Math.max(g.jb, info.jb);
    groups.set(item.blend, g);
  }
  for (const [blend, g] of groups) {
    if (g.events.length === 0) continue;
    const assPath = path.join(
      a.workDir,
      `layer-${track.id.replace(/[^a-z0-9_-]/gi, '_')}-${blend}.ass`,
    );
    const body = g.events
      .sort((x, y) => x.layer - y.layer || x.start - y.start)
      .map(dialogue)
      .join('\n');
    await fs.promises.writeFile(assPath, `${assHeader(ctx.W, ctx.H, g.styles)}${body}\n`, 'utf8');
    out.push({ assPath, blend, ja: g.ja, jb: g.jb });
  }
  return out;
}

/* ----------------------------------------------------------------------------- SRT / VTT --------- */

function ts(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

/** One cue per subtitle item (the subtitle track IS the cue list), shifted to the export range. */
export function buildSubtitleCues(
  project: Pick<Project, 'tracks'>,
  r0: number,
  r1: number,
): { srt: string | null; vtt: string | null } {
  const cues: { s: number; e: number; text: string }[] = [];
  for (const tr of project.tracks) {
    if (tr.kind !== 'subtitle') continue;
    for (const it of tr.items) {
      if (it.type !== 'subtitle') continue;
      const s = Math.max(it.startSec, r0);
      const e = Math.min(itemEnd(it), r1);
      if (e <= s) continue;
      const text = it.words
        .map((w) => w.w.trim())
        .filter(Boolean)
        .join(' ');
      if (text) cues.push({ s: s - r0, e: e - r0, text });
    }
  }
  if (cues.length === 0) return { srt: null, vtt: null };
  cues.sort((x, y) => x.s - y.s);
  const srt = cues
    .map((c, i) => `${i + 1}\n${ts(c.s, ',')} --> ${ts(c.e, ',')}\n${c.text}\n`)
    .join('\n');
  const vtt = `WEBVTT\n\n${cues
    .map((c) => {
      const safe = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '--&gt;');
      return `${ts(c.s, '.')} --> ${ts(c.e, '.')}\n${safe}\n`;
    })
    .join('\n')}`;
  return { srt, vtt };
}
