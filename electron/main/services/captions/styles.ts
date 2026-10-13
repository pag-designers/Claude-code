/** Caption style presets. CP1 ships "Clean Pop"; CP2 adds the rest of the Brand Kit presets here. */

/** Colours are #RRGGBB. */
export interface CaptionStyle {
  id: string;
  name: string;
  /** Family name libass resolves (shipped font: assets/fonts/Montserrat-ExtraBold.ttf). */
  fontName: string;
  uppercase: boolean;
  /** Maximum words per on-screen line. */
  maxWords: number;
  primary: string;
  /** Active (currently spoken) word. */
  active: string;
  /** LLM keywords (not active). */
  keyword: string;
  outline: string;
  /** Shadow colour + alpha 0..255 (255 = transparent in ASS terms is handled in ass.ts). */
  shadow: string;
  shadowOpacity: number;
  /** Font size as a fraction of the frame width (portrait/square) or height (landscape). */
  sizeFrac: number;
  /** Outline thickness relative to the font size. */
  outlineRel: number;
  shadowRel: number;
  /** Pop animation of the active word. */
  pop: {
    fromScale: number;
    peakScale: number;
    settleScale: number;
    peakMs: number;
    settleMs: number;
  };
  /** Optional font used for emoji runs (null = let libass fall back per glyph). */
  emojiFont: string | null;
}

export const FONT_FAMILY = 'Montserrat ExtraBold';
export const FONT_FILE = 'Montserrat-ExtraBold.ttf';

export const CLEAN_POP: CaptionStyle = {
  id: 'clean-pop',
  name: 'Clean Pop',
  fontName: FONT_FAMILY,
  uppercase: true,
  maxWords: 3,
  primary: '#FFFFFF',
  active: '#FFD60A',
  keyword: '#35E0A1',
  outline: '#000000',
  shadow: '#000000',
  shadowOpacity: 0.55,
  sizeFrac: 0.078,
  outlineRel: 0.075,
  shadowRel: 0.04,
  pop: { fromScale: 82, peakScale: 116, settleScale: 100, peakMs: 70, settleMs: 150 },
  emojiFont: null,
};

const REGISTRY: Record<string, CaptionStyle> = { [CLEAN_POP.id]: CLEAN_POP };

/** Unknown ids fall back to Clean Pop (the other presets arrive in CP2). */
export function resolveStyle(id: string): CaptionStyle {
  return REGISTRY[id] ?? CLEAN_POP;
}

/** `#RRGGBB` + opacity (1 = opaque) -> ASS `&HAABBGGRR` (alpha is inverted in ASS). */
export function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  const rgb = m?.[1] ?? 'FFFFFF';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Colour for an inline override tag: `&HBBGGRR&`. */
export function assTagColor(hex: string): string {
  return assColor(hex).replace(/^&H../, '&H') + '&';
}
