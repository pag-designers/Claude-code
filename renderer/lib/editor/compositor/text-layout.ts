/**
 * Text layout for text items. PURE: all font measuring goes through a `TextMeasurer`, so the maths is unit-testable in
 * node with a stub, and the browser uses Canvas2D (`canvasMeasurer`).
 *
 * Layout rules (the exporter mirrors them by emitting one positioned line per entry of `lines`):
 *  - the font EM size is `style.size` canvas px; the advance of a string is `measurer(text) + codePoints × letterSpacing`
 *    (libass-style: spacing is added after every glyph, the last one included);
 *  - wrap width = `style.maxWidth ?? 0.8 × canvasWidth`; greedy word wrap at spaces; explicit `\n` always breaks;
 *    a single word wider than the wrap width stays on its own line (never split);
 *  - leading/trailing spaces of a wrapped line are dropped; interior spaces are kept;
 *  - line pitch = `lineHeight × size`; the block is `lines × pitch` tall and as wide as its widest line, plus
 *    `2 × box.padding` each way when there is a box; the block is centred on the item's position (canvas centre +
 *    transform offset); lines are aligned left / centre / right inside the block width;
 *  - the em box is centred in each line's pitch box: baseline = lineCentre + (ascent − descent) / 2 × size.
 */
import type { TextItem, TextStyle } from '@shared/editor';
import { cssFont, onEditorFontsLoaded } from './fonts';

export type TextMeasurer = (
  text: string,
  style: Pick<TextStyle, 'fontFamily' | 'weight' | 'italic' | 'size'>,
) => number;

export interface TextLine {
  /** Displayed text of the line. */
  text: string;
  /** Code-point range [start, end) of `text` inside the item's whole text (typewriter reveals by index). */
  start: number;
  end: number;
  /** Advance incl. letter spacing, canvas px. */
  width: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** Widest line (no box padding), canvas px. */
  contentWidth: number;
  /** lines × pitch, canvas px. */
  contentHeight: number;
  /** Box padding (0 without a box). */
  padding: number;
  /** Visual block incl. padding: the item's natural rect. */
  width: number;
  height: number;
  /** Line pitch, canvas px. */
  pitch: number;
}

export const DEFAULT_WRAP_FRACTION = 0.8;

const isSpace = (c: string): boolean => c === ' ' || c === '\t';

export function layoutText(
  text: string,
  style: TextStyle,
  canvasW: number,
  measure: TextMeasurer,
): TextLayout {
  const cps = Array.from(text);
  const ls = style.letterSpacing;
  const wrapW = style.maxWidth ?? canvasW * DEFAULT_WRAP_FRACTION;
  const advance = (s: string): number =>
    s === '' ? 0 : measure(s, style) + Array.from(s).length * ls;
  const lines: TextLine[] = [];

  let p = 0;
  while (p <= cps.length) {
    // paragraph [p, q)
    let q = p;
    while (q < cps.length && cps[q] !== '\n') q++;
    // word tokens [s, e) inside the paragraph
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
    if (toks.length === 0) {
      lines.push({ text: '', start: p, end: p, width: 0 });
    } else {
      let first = 0;
      let cur = '';
      const seg = (a: number, b: number): string =>
        cps.slice((toks[a] as [number, number])[0], (toks[b] as [number, number])[1]).join('');
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
        } else {
          cur = cand;
        }
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

  const pitch = style.lineHeight * style.size;
  const contentWidth = Math.max(0, ...lines.map((l) => l.width));
  const contentHeight = lines.length * pitch;
  const padding = style.box ? style.box.padding : 0;
  return {
    lines,
    contentWidth,
    contentHeight,
    padding,
    width: contentWidth + 2 * padding,
    height: contentHeight + 2 * padding,
    pitch,
  };
}

/* ------------------------------------------------------------------ measurers -------------------- */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx2D | null | undefined;
function getMeasureCtx(): Ctx2D | null {
  if (measureCtx !== undefined) return measureCtx;
  try {
    if (typeof OffscreenCanvas !== 'undefined')
      measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined')
      measureCtx = document.createElement('canvas').getContext('2d');
    else measureCtx = null;
  } catch {
    measureCtx = null;
  }
  return measureCtx ?? null;
}

const widthCache = new Map<string, number>();

/** Canvas2D measuring with the editor fonts (falls back to an average-width estimate where no canvas exists). */
export const canvasMeasurer: TextMeasurer = (text, style) => {
  const ctx = getMeasureCtx();
  if (!ctx) return approxMeasurer(text, style);
  const { font } = cssFont(style.fontFamily, style.weight, style.italic, style.size);
  const key = `${font}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = '0px';
  const w = ctx.measureText(text).width;
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
};

/** Drops measuring caches (fonts finished loading → previously measured widths may be stale). */
export const clearMeasureCache = (): void => widthCache.clear();
onEditorFontsLoaded(clearMeasureCache);

/** Average-advance estimate (0.56 em, 0.6 em for monospace). Only used when there is no canvas (node tests, SSR). */
export const approxMeasurer: TextMeasurer = (text, style) =>
  Array.from(text).length * style.size * (/mono/i.test(style.fontFamily) ? 0.6 : 0.56);

let activeMeasurer: TextMeasurer = canvasMeasurer;
/** Test hook: replace the measurer used by `measureTextItem` / the compositor. */
export function setTextMeasurer(m: TextMeasurer | null): void {
  activeMeasurer = m ?? canvasMeasurer;
}
export const currentMeasurer = (): TextMeasurer => activeMeasurer;

export function layoutTextItem(item: TextItem, canvasW: number): TextLayout {
  return layoutText(item.text, item.style, canvasW, activeMeasurer);
}
