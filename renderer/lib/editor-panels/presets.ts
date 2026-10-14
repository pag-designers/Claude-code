/**
 * Data for the bin's Text / Stickers / Transitions tabs. Pure: presets are PATCHES applied on top of the complete
 * default item the core store makes (`makeTextItem` / `makeShapeItem`), sized relative to the canvas so a preset
 * looks the same on 9:16, 1:1, 16:9 and 4:5 projects. Hex values here are project DATA (they end up in the saved
 * document, like caption colours), not UI chrome.
 */
import type { ShapeKind, TextAnimation, TextStyle, TransitionType } from '@shared/editor';

export const DATA_COLORS = {
  white: '#FFFFFF',
  black: '#000000',
  accent: '#6A4BF2',
  yellow: '#FFE94D',
} as const;

export interface CanvasSize {
  width: number;
  height: number;
}

/** Presets are authored for a 1080-px short side. */
export const unit = (c: CanvasSize): number => Math.min(c.width, c.height) / 1080;

/* --------------------------------------------------------------------------------------- text */

export interface TextPresetDef {
  id: string;
  label: string;
  /** Text inserted. */
  text: string;
  /** Short line shown under the tile. */
  hint: string;
  style: Partial<TextStyle>;
  /** Vertical offset from the canvas centre as a fraction of the canvas height. */
  yFrac: number;
  /** Wrap width as a fraction of the canvas width. */
  maxWidthFrac?: number;
  animIn?: TextAnimation;
  animOut?: TextAnimation;
}

const SHADOW = { color: DATA_COLORS.black, opacity: 0.55, blur: 14, offsetX: 0, offsetY: 6 };

export const TEXT_PRESETS: readonly TextPresetDef[] = [
  {
    id: 'title',
    label: 'Title',
    text: 'Your title',
    hint: 'Big and bold',
    style: { fontFamily: 'Montserrat', weight: 800, size: 112, shadow: SHADOW },
    yFrac: -0.22,
    maxWidthFrac: 0.84,
  },
  {
    id: 'subtitle',
    label: 'Subtitle',
    text: 'Add a subtitle',
    hint: 'Supporting line',
    style: { fontFamily: 'Montserrat', weight: 600, size: 58, shadow: SHADOW },
    yFrac: 0.2,
    maxWidthFrac: 0.84,
  },
  {
    id: 'lower-third',
    label: 'Lower third',
    text: 'Name Surname\nRole or topic',
    hint: 'Name and title bar',
    style: {
      fontFamily: 'Montserrat',
      weight: 700,
      size: 50,
      align: 'left',
      lineHeight: 1.25,
      box: { color: DATA_COLORS.black, opacity: 0.66, padding: 28, radius: 14 },
    },
    yFrac: 0.27,
    maxWidthFrac: 0.8,
  },
  {
    id: 'quote',
    label: 'Quote',
    text: '“Your quote goes here”',
    hint: 'Serif pull quote',
    style: {
      fontFamily: 'DM Serif Display',
      weight: 400,
      italic: true,
      size: 76,
      lineHeight: 1.2,
      shadow: SHADOW,
    },
    yFrac: -0.05,
    maxWidthFrac: 0.78,
  },
  {
    id: 'counter',
    label: 'Counter',
    text: '01',
    hint: 'Numbered step or stat',
    style: {
      fontFamily: 'Anton',
      weight: 400,
      size: 240,
      color: DATA_COLORS.yellow,
      stroke: { color: DATA_COLORS.black, width: 8 },
    },
    yFrac: -0.16,
  },
];

export const TEXT_ANIMATIONS: readonly {
  type: Exclude<TextAnimation['type'], 'none'>;
  label: string;
  hint: string;
  durationSec: number;
}[] = [
  { type: 'pop', label: 'Pop', hint: 'Overshoots, then settles', durationSec: 0.45 },
  { type: 'typewriter', label: 'Typewriter', hint: 'Letters appear one by one', durationSec: 1 },
  { type: 'slide', label: 'Slide', hint: 'Rises into place', durationSec: 0.5 },
  { type: 'bounce', label: 'Bounce', hint: 'Drops and bounces', durationSec: 0.7 },
  { type: 'fade', label: 'Fade', hint: 'Fades in', durationSec: 0.5 },
  { type: 'scale', label: 'Scale', hint: 'Grows from 60 %', durationSec: 0.5 },
];

/** Preset for one of the six text animations: a plain headline that plays the animation in. */
export function animationPreset(a: (typeof TEXT_ANIMATIONS)[number]): TextPresetDef {
  return {
    id: `anim-${a.type}`,
    label: a.label,
    text: 'Your text',
    hint: a.hint,
    style: { fontFamily: 'Montserrat', weight: 800, size: 96, shadow: SHADOW },
    yFrac: 0,
    maxWidthFrac: 0.84,
    animIn: { type: a.type, durationSec: a.durationSec },
  };
}

export interface TextPatch {
  text: string;
  name: string;
  style: Partial<TextStyle>;
  /** Canvas px offset of the centre from the canvas centre. */
  y: number;
  animIn?: TextAnimation;
  animOut?: TextAnimation;
}

/** Resolves a preset for a canvas: sizes scale with the short side, offsets follow the canvas height. */
export function textPatch(p: TextPresetDef, canvas: CanvasSize): TextPatch {
  const u = unit(canvas);
  const style: Partial<TextStyle> = { ...p.style };
  if (style.size !== undefined) style.size = Math.round(style.size * u);
  if (style.stroke) style.stroke = { ...style.stroke, width: Math.round(style.stroke.width * u) };
  if (style.box)
    style.box = {
      ...style.box,
      padding: Math.round(style.box.padding * u),
      radius: Math.round(style.box.radius * u),
    };
  if (style.shadow)
    style.shadow = {
      ...style.shadow,
      blur: Math.round(style.shadow.blur * u),
      offsetY: Math.round(style.shadow.offsetY * u),
    };
  if (p.maxWidthFrac !== undefined) style.maxWidth = Math.round(canvas.width * p.maxWidthFrac);
  return {
    text: p.text,
    name: p.label,
    style,
    y: Math.round(p.yFrac * canvas.height),
    animIn: p.animIn,
    animOut: p.animOut,
  };
}

/* ------------------------------------------------------------------------------------ stickers */

export const SHAPE_PRESETS: readonly { kind: ShapeKind; label: string; hint: string }[] = [
  { kind: 'rect', label: 'Rectangle', hint: 'Box, card or highlight' },
  { kind: 'ellipse', label: 'Ellipse', hint: 'Circle or oval' },
  { kind: 'line', label: 'Line', hint: 'Divider or underline' },
  { kind: 'arrow', label: 'Arrow', hint: 'Point at something' },
  { kind: 'progress-bar', label: 'Progress bar', hint: 'Fills over its length' },
];

export interface ShapePatch {
  name: string;
  width: number;
  height: number;
  fill: string;
  radius: number;
  /** Canvas px offset of the centre from the canvas centre. */
  y: number;
  /** True for the progress bar: it should span the rest of the project. */
  spansProject: boolean;
}

export function shapePatch(kind: ShapeKind, canvas: CanvasSize): ShapePatch {
  const u = unit(canvas);
  const r = (n: number) => Math.round(n * u);
  switch (kind) {
    case 'rect':
      return {
        name: 'Rectangle',
        width: r(520),
        height: r(320),
        fill: DATA_COLORS.accent,
        radius: r(28),
        y: 0,
        spansProject: false,
      };
    case 'ellipse':
      return {
        name: 'Ellipse',
        width: r(380),
        height: r(380),
        fill: DATA_COLORS.accent,
        radius: 0,
        y: 0,
        spansProject: false,
      };
    case 'line':
      return {
        name: 'Line',
        width: r(640),
        height: Math.max(2, r(8)),
        fill: DATA_COLORS.white,
        radius: r(4),
        y: 0,
        spansProject: false,
      };
    case 'arrow':
      return {
        name: 'Arrow',
        width: r(420),
        height: r(140),
        fill: DATA_COLORS.white,
        radius: 0,
        y: 0,
        spansProject: false,
      };
    case 'progress-bar': {
      const h = Math.max(4, r(14));
      return {
        name: 'Progress bar',
        width: Math.round(canvas.width * 0.92),
        height: h,
        fill: DATA_COLORS.accent,
        radius: Math.round(h / 2),
        y: Math.round(canvas.height * 0.47),
        spansProject: true,
      };
    }
  }
}

export const CTA_STICKERS: readonly { id: string; label: string; hint: string }[] = [
  { id: 'swipe-up', label: 'Swipe up', hint: 'Pill with a pop-in label' },
  { id: 'follow', label: 'Follow', hint: 'Ask for the follow' },
  { id: 'link-in-bio', label: 'Link in bio', hint: 'Point to your link' },
];

export interface CtaPatch {
  label: string;
  pill: { width: number; height: number; radius: number; fill: string };
  text: { size: number; style: Partial<TextStyle>; animIn: TextAnimation };
  /** Canvas px offset of the sticker centre from the canvas centre (kept above the platform UI). */
  y: number;
}

export function ctaPatch(label: string, canvas: CanvasSize): CtaPatch {
  const u = unit(canvas);
  const size = Math.round(54 * u);
  // pill width grows with the label so long labels stay inside it
  const width = Math.round(Math.max(380, label.length * 40 + 150) * u);
  const height = Math.round(118 * u);
  return {
    label,
    pill: { width, height, radius: Math.round(height / 2), fill: DATA_COLORS.accent },
    text: {
      size,
      style: { fontFamily: 'Montserrat', weight: 800, size, color: DATA_COLORS.white },
      animIn: { type: 'pop', durationSec: 0.4 },
    },
    y: Math.round(canvas.height * 0.26),
  };
}

/* --------------------------------------------------------------------------------- transitions */

export const TRANSITIONS: readonly { type: TransitionType; label: string; hint: string }[] = [
  { type: 'cut', label: 'Cut', hint: 'Instant switch (removes a transition)' },
  { type: 'crossfade', label: 'Crossfade', hint: 'Dissolve between clips' },
  { type: 'dip-black', label: 'Dip to black', hint: 'Fade out to black, then in' },
  { type: 'dip-white', label: 'Dip to white', hint: 'Flash through white' },
  { type: 'slide-left', label: 'Slide left', hint: 'New clip pushes in from the right' },
  { type: 'slide-right', label: 'Slide right', hint: 'New clip pushes in from the left' },
  { type: 'slide-up', label: 'Slide up', hint: 'New clip pushes in from below' },
  { type: 'slide-down', label: 'Slide down', hint: 'New clip pushes in from above' },
  { type: 'zoom', label: 'Zoom', hint: 'Zoom into the next clip' },
  { type: 'blur', label: 'Blur', hint: 'Defocus into the next clip' },
  { type: 'whip-pan', label: 'Whip pan', hint: 'Fast blurred pan' },
  { type: 'glitch', label: 'Glitch', hint: 'Digital stutter' },
];

export const transitionLabel = (t: TransitionType): string =>
  TRANSITIONS.find((x) => x.type === t)?.label ?? t;

export const DEFAULT_TRANSITION_SEC = 0.5;
