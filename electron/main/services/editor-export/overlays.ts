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
  const face = fontBook.resolve(family, weight, italic) ?? fontBook.resolve(FONT_FALLBACK, weight, italic);
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

/** Greedy word wrap with the face's real advances (explicit \n kept). */
function wrapText(text: string, font: FontSetup, fsAss: number, spacing: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/ +/);
    let cur = '';
    for (const w of words) {
      const trial = cur === '' ? w : `${cur} ${w}`;
      if (cur !== '' && measureText(font.face, trial, fsAss, spacing) > maxW) {
        out.push(cur);
        cur = w;
      } else cur = trial;
    }
    out.push(cur);
  }
  return out;
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
  const widths = lines.map((l) => measureText(font.face, l, fsBase, spacingBase));
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
    (f) => `${f.cx.toFixed(1)}|${f.cy.toFixed(1)}|${f.s.toFixed(3)}|${f.rot.toFixed(2)}|${f.opa.toFixed(3)}|${f.chars}`,
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

    let remaining = f.chars;
    lines.forEach((line, li) => {
      const chars = Array.from(line);
      const showN = Math.max(0, Math.min(chars.length, remaining));
      remaining -= chars.length + 1; // the break character between lines
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

function ellipsePath(w: number, h: number): string {
  const f = (n: number): string => r1(n);
  const rx = w / 2;
  const ry = h / 2;
  return [
    `m 0 ${f(ry)}`,
    `b 0 ${f(ry - KAPPA * ry)} ${f(rx - KAPPA * rx)} 0 ${f(rx)} 0`,
    `b ${f(rx + KAPPA * rx)} 0 ${f(w)} ${f(ry - KAPPA * ry)} ${f(w)} ${f(ry)}`,
    `b ${f(w)} ${f(ry + KAPPA * ry)} ${f(rx + KAPPA * rx)} ${f(h)} ${f(rx)} ${f(h)}`,
    `b ${f(rx - KAPPA * rx)} ${f(h)} 0 ${f(ry + KAPPA * ry)} 0 ${f(ry)}`,
  ].join(' ');
}

/** Shaft (34 % of the height) + triangular head (length min(45 % of the width, 90 % of the height)). */
function arrowPath(w: number, h: number): string {
  const f = (n: number): string => r1(n);
  const head = Math.min(w * 0.45, h * 0.9);
  const shaft = h * 0.34;
  const y0 = (h - shaft) / 2;
  const y1 = y0 + shaft;
  return `m 0 ${f(y0)} l ${f(w - head)} ${f(y0)} l ${f(w - head)} 0 l ${f(w)} ${f(h / 2)} l ${f(w - head)} ${f(h)} l ${f(w - head)} ${f(y1)} l 0 ${f(y1)}`;
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
    (f) => `${f.cx.toFixed(1)}|${f.cy.toFixed(1)}|${f.s.toFixed(3)}|${f.rot.toFixed(2)}|${f.opa.toFixed(3)}|${(f.p * 4000).toFixed(0)}`,
  );
  const half = 0.5 / ctx.fps;
  const events: Event[] = [];
  for (const run of runsOf(keys)) {
    const f = frames[run.k0] as Fr;
    if (f.opa <= 0.002 || f.s <= 0.005) continue;
    const start = grid.out(info.ja + run.k0) - half;
    const end = grid.out(info.ja + run.k1 - 1) + half;
    const w = item.width * K * f.s;
    const h = item.height * K * f.s;
    const x0 = f.cx - w / 2;
    const y0 = f.cy - h / 2;
    let path: string;
    let dw = w;
    switch (item.shape) {
      case 'ellipse':
        path = ellipsePath(w, h);
        break;
      case 'arrow':
        path = arrowPath(w, h);
        break;
      case 'progress-bar':
        dw = Math.max(0.01, w * f.p);
        if (f.p <= 0) continue;
        path = roundedRectPath(Math.round(dw), Math.round(h), item.radius * K * f.s);
        break;
      default:
        path = roundedRectPath(Math.round(w), Math.round(h), item.radius * K * f.s);
    }
    const bord = item.stroke ? item.stroke.width * K * f.s : 0;
    const frz = Math.abs(f.rot) > 0.01 ? `\\frz${num(-f.rot, 2)}` : '';
    const tags =
      `\\an7\\pos(${r1(x0)},${r1(y0)})\\org(${r1(f.cx)},${r1(f.cy)})${frz}` +
      `\\bord${num(bord, 2)}\\shad0\\blur0.4\\1c${assTagColor(item.fill)}\\1a${alphaTag(item.fillOpacity * f.opa)}` +
      `\\3c${assTagColor(item.stroke?.color ?? '#000000')}\\3a${alphaTag(item.stroke ? f.opa : 0)}\\p1`;
    events.push({ layer: 1, start, end, style: styleName, text: `{${tags}}${path}{\\p0}` });
  }
  return events;
}

const shapeStyleLine = (name: string): string =>
  `Style: ${name},${FONT_FALLBACK},20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;

/* ----------------------------------------------------------------------------- subtitles -------- */

const KEEP_STYLE_RE = /^(Dialogue: \d+,[^,]+,[^,]+,)(Caption(?:Bg)?),/;

function shiftDialogue(line: string, offset: number): string {
  return line.replace(
    /^(Dialogue: \d+,)(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),/,
    (_m, head: string, a: string, b: string) =>
      `${head}${assTime(parseAssTime(a) + offset)},${assTime(parseAssTime(b) + offset)},`,
  );
}

function parseAssTime(t: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(t);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

/** Splits `{tags}text{tags}text` into alternating segments. */
const segments = (text: string): string[] => text.split(/(\{[^}]*\})/);

interface SubOut {
  styles: string[];
  events: string[];
}

/** One subtitle item → ASS lines in output time (per-word colours merged in). */
function subtitleLines(
  ctx: Ctx,
  item: SubtitleItem,
  style: CaptionStyle,
  captions: Pick<CaptionService, 'buildAss'>,
  styleTag: string,
  r0: number,
): SubOut {
  const words: Word[] = item.words.map((w) => ({ w: w.w, s: w.s, e: Math.max(w.e, w.s) }));
  const base = (keywords: string[] | undefined, st: CaptionStyle): string =>
    captions.buildAss({
      words,
      startSec: 0,
      endSec: item.durationSec,
      width: ctx.W,
      height: ctx.H,
      style: st,
      keywords,
    });
  const docBase = base(undefined, style).split('\n');
  const dlg = docBase.filter((l) => l.startsWith('Dialogue:'));
  const merged = [...dlg];
  // per-word emphasis colours: one extra pass per distinct colour (keyword colour = that colour)
  const byColor = new Map<string, string[]>();
  for (const w of item.words) {
    if (!w.color) continue;
    const list = byColor.get(w.color) ?? [];
    list.push(w.w);
    byColor.set(w.color, list);
  }
  for (const [color, ws] of byColor) {
    const pass = base(ws, { ...style, keywordColor: color })
      .split('\n')
      .filter((l) => l.startsWith('Dialogue:'));
    if (pass.length !== dlg.length) continue;
    for (let i = 0; i < merged.length; i++) {
      const a = segments(merged[i] as string);
      const b = segments(pass[i] as string);
      if (a.length !== b.length) continue;
      for (let k = 0; k < a.length; k++) {
        if ((a[k] as string).startsWith('{') && a[k] !== b[k]) a[k] = b[k] as string;
      }
      merged[i] = a.join('');
    }
  }
  const styles = docBase.filter((l) => l.startsWith('Style:'));
  const offset = item.startSec - r0;
  return {
    styles: styles.map((l) => l.replace(/^Style: (Caption(?:Bg)?),/, `Style: ${styleTag}_$1,`)),
    events: merged.map((l) =>
      shiftDialogue(l, offset).replace(KEEP_STYLE_RE, `$1${styleTag}_$2,`),
    ),
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
  const groups = new Map<BlendMode, { styles: string[]; events: Event[]; ja: number; jb: number }>();
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
  const srt = cues.map((c, i) => `${i + 1}\n${ts(c.s, ',')} --> ${ts(c.e, ',')}\n${c.text}\n`).join('\n');
  const vtt = `WEBVTT\n\n${cues
    .map((c) => {
      const safe = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/-->/g, '--&gt;');
      return `${ts(c.s, '.')} --> ${ts(c.e, '.')}\n${safe}\n`;
    })
    .join('\n')}`;
  return { srt, vtt };
}
