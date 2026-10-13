/**
 * Resolution-independent caption geometry: font face, pixel sizes, safe-area position, line budget.
 * Everything is derived from a `CaptionStyle` + the frame size (BRIEF §4 step 8: safe-area aware).
 */
import type { CaptionStyle } from '@shared/cp2';
import { fontBook, lineHeight, measureText, type FontFace } from './fontbook';
import { applyCase } from './text';

export interface FontSetup {
  face: FontFace | null;
  /** Name written into the ASS style (what libass/fontconfig match). */
  assName: string;
  /** ASS Bold flag: only for faces that already are bold (libass would otherwise fake-embolden). */
  bold: boolean;
  italic: boolean;
}

export function resolveFont(style: CaptionStyle): FontSetup {
  const { family, weight, italic } = style.font;
  const face = fontBook.resolve(family, weight, italic);
  if (face) return { face, assName: face.assName, bold: face.weight >= 600, italic };
  return { face: null, assName: family, bold: weight >= 600, italic };
}

export interface Layout {
  width: number;
  height: number;
  /** min(width, height) */
  short: number;
  /** short / 1080: converts the style's "px at 1080" values. */
  k: number;
  font: FontSetup;
  fontSize: number;
  /** Letter spacing in px (ASS Spacing). */
  spacing: number;
  outline: number;
  shadow: number;
  marginX: number;
  /** Box padding in px (0 when the style has no box and no box highlight). */
  pad: number;
  /** Text anchor: centre x for centred text, left x for left-aligned text. */
  cx: number;
  cy: number;
  left: boolean;
  /** Width available to text lines. */
  usableW: number;
  /** Character budget per line after the font's real width is taken into account. */
  maxChars: number;
  portrait: boolean;
}

const SAMPLE = 'the quick brown fox jumps over a lazy dog and runs';

/** Vertical shift (percentage points) from the 9:16 design position for other aspect ratios. */
function aspectDelta(width: number, height: number): number {
  if (width > height) return 6;
  const r = height / width;
  return r > 1.5 ? 0 : r > 1.1 ? 1 : 3;
}

export function computeLayout(width: number, height: number, style: CaptionStyle): Layout {
  const short = Math.min(width, height);
  const k = short / 1080;
  const font = resolveFont(style);
  const fontSize = Math.max(16, Math.round((short * style.font.sizePct) / 100));
  const spacing = Math.round(((style.font.letterSpacingPct / 100) * fontSize) * 100) / 100;
  const outline = style.stroke.widthPct > 0 ? Math.max(1, Math.round((short * style.stroke.widthPct) / 100)) : 0;
  const hasShadowOffset = style.shadow.opacity > 0 && style.shadow.offsetPx > 0;
  const shadow =
    style.shadow.blurPx > 0 || !hasShadowOffset ? 0 : Math.max(1, Math.round(style.shadow.offsetPx * k));
  const boxish = style.box.enabled || style.highlight.mode === 'box';
  const pad = boxish ? Math.max(2, Math.round((short * style.box.paddingPct) / 100)) : 0;
  const marginX = Math.ceil((width * style.layout.marginXPct) / 100);
  const left = style.layout.align === 'left';
  const boxPad = style.box.enabled ? pad : 0;
  const usableW = Math.max(40, width - 2 * marginX - 2 * boxPad);
  const portrait = height / width > 1.5;

  // vertical anchor: design position (9:16) + aspect shift, kept clear of the platform UI zone
  const lineH = lineHeight(font.face, fontSize);
  const blockH = style.chunking.maxLines * lineH + 2 * boxPad;
  const bottomLimit = height * (portrait ? 0.82 : 0.93);
  let cy = Math.round((height * (style.layout.yPct + aspectDelta(width, height))) / 100);
  cy = Math.min(cy, Math.round(bottomLimit - blockH / 2));
  cy = Math.max(cy, Math.round(height * 0.05 + blockH / 2));

  const avg = measureText(font.face, applyCase(SAMPLE, style.textCase), fontSize, spacing) / SAMPLE.length;
  const fits = Math.max(4, Math.floor(usableW / Math.max(1, avg)));
  return {
    width,
    height,
    short,
    k,
    font,
    fontSize,
    spacing,
    outline,
    shadow,
    marginX,
    pad,
    cx: left ? marginX + boxPad : Math.round(width / 2),
    cy,
    left,
    usableW,
    maxChars: Math.min(style.chunking.maxChars, fits),
    portrait,
  };
}
