/**
 * Built-in caption style presets (BRIEF §7). All are plain `CaptionStyle` data, so the preview editor
 * can duplicate and edit every field; the engine in ass.ts knows nothing about preset ids.
 *
 * Preset table (font files ship in electron/main/assets/fonts, all SIL OFL):
 *
 * | id                  | Name                | Font (weight)           | Look                                                         | Animation  |
 * | ------------------- | ------------------- | ----------------------- | ------------------------------------------------------------ | ---------- |
 * | clean-pop           | Clean Pop (default) | Montserrat ExtraBold    | white caps, black stroke, yellow active word, 3 words/line   | pop        |
 * | hormozi-bold        | Hormozi Bold        | Anton                   | huge white caps, heavy black stroke, yellow active, 2 lines  | pop        |
 * | karaoke-highlight   | Karaoke Highlight   | Poppins ExtraBold       | whole phrase on screen, colour sweeps across each word       | karaoke    |
 * | tiktok-classic      | TikTok Classic      | Poppins Bold            | white sentence-case, thin black stroke, no highlight         | none       |
 * | minimal-lower-third | Minimal Lower-Third | Poppins SemiBold        | small left-aligned text, soft shadow, no stroke or box       | fade       |
 * | neon-glow           | Neon Glow           | Bebas Neue              | white-hot caps, cyan stroke + blurred cyan halo, pink active | pop        |
 * | boxed-highlight     | Boxed Highlight     | Poppins ExtraBold       | white caps; the active word sits in a yellow box             | none       |
 * | typewriter          | Typewriter          | IBM Plex Mono SemiBold  | mono text typed out letter by letter in a dark left block    | typewriter |
 * | bounce-word         | Bounce Word         | Poppins ExtraBold       | white caps, the active word springs (squash and stretch)     | bounce     |
 * | gradient-glow       | Gradient Glow       | Poppins ExtraBold       | cyan letters, violet rim, magenta halo (see note)            | pop        |
 * | outline-only        | Outline Only        | Montserrat ExtraBold    | dark letters with a thick white outline, no shadow           | none       |
 * | caption-bubble      | Caption Bubble      | Poppins Bold            | white sentence-case in a rounded dark bubble                 | pop        |
 * | podcast-lower-third | Podcast Lower-Third | Poppins SemiBold        | left-aligned speaker-style block: navy box, amber active word| slide-up   |
 * | subtle-serif        | Subtle Serif        | DM Serif Display        | cream serif, no stroke, soft blurred shadow                  | fade       |
 *
 * Gradient Glow note: libass has no gradient fills. The look is faked honestly with data the style
 * already has: fill colour A (cyan), outline colour B (violet) so each letter fades from A in the
 * middle to B at the rim, and a blurred halo in colour C (magenta) behind it. It is not a true
 * per-pixel gradient and does not vary with the letter's vertical position.
 *
 * Outline Only note: `fill` has no alpha in the shared schema, so the letters are not hollow; they are
 * near-black with a thick white outline, which reads as "outline lettering" and stays legible.
 */
import { BUILTIN_STYLE_IDS, DEFAULT_STYLE_ID, captionStyleSchema } from '@shared/cp2';
import type { CaptionStyle, CaptionStyleInput } from '@shared/cp2';

export type { CaptionStyle } from '@shared/cp2';

/** CP1 names kept for the hook title card and the render pipeline (Clean Pop's face). */
export const FONT_FAMILY = 'Montserrat ExtraBold';
export const FONT_FILE = 'Montserrat-ExtraBold.ttf';

const RAW: Record<(typeof BUILTIN_STYLE_IDS)[number], CaptionStyleInput> = {
  'clean-pop': {
    id: 'clean-pop',
    name: 'Clean Pop',
    builtin: true,
    font: { family: 'Montserrat', weight: 800, italic: false, sizePct: 7.8, letterSpacingPct: 0 },
    textCase: 'upper',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0.6 },
    shadow: { color: '#000000', opacity: 0.55, blurPx: 0, offsetPx: 3 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color', color: '#FFD60A', boxColor: '#FFD60A', scale: 1.16 },
    keywordColor: '#35E0A1',
    animation: 'pop',
    layout: { yPct: 69, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 3, maxChars: 14, maxLines: 1 },
  },
  'hormozi-bold': {
    id: 'hormozi-bold',
    name: 'Hormozi Bold',
    builtin: true,
    font: { family: 'Anton', weight: 400, italic: false, sizePct: 10.4, letterSpacingPct: 1 },
    textCase: 'upper',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 1.1 },
    shadow: { color: '#000000', opacity: 0.85, blurPx: 0, offsetPx: 7 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color-scale', color: '#FFE81F', boxColor: '#FFE81F', scale: 1.1 },
    keywordColor: '#27F26B',
    animation: 'pop',
    layout: { yPct: 62, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 2, maxChars: 12, maxLines: 2 },
  },
  'karaoke-highlight': {
    id: 'karaoke-highlight',
    name: 'Karaoke Highlight',
    builtin: true,
    font: { family: 'Poppins', weight: 800, italic: false, sizePct: 6.4, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0.5 },
    shadow: { color: '#000000', opacity: 0.6, blurPx: 0, offsetPx: 3 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color', color: '#3DDCFF', boxColor: '#3DDCFF', scale: 1.1 },
    keywordColor: '#FFD60A',
    animation: 'karaoke',
    layout: { yPct: 66, marginXPct: 7, align: 'center' },
    chunking: { maxWords: 4, maxChars: 20, maxLines: 2 },
  },
  'tiktok-classic': {
    id: 'tiktok-classic',
    name: 'TikTok Classic',
    builtin: true,
    font: { family: 'Poppins', weight: 700, italic: false, sizePct: 6, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0.55 },
    shadow: { color: '#000000', opacity: 0.35, blurPx: 0, offsetPx: 2 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'none', color: '#FFFFFF', boxColor: '#FFFFFF', scale: 1 },
    keywordColor: '#FFE14D',
    animation: 'none',
    layout: { yPct: 65, marginXPct: 7, align: 'center' },
    chunking: { maxWords: 5, maxChars: 24, maxLines: 2 },
  },
  'minimal-lower-third': {
    id: 'minimal-lower-third',
    name: 'Minimal Lower-Third',
    builtin: true,
    font: { family: 'Poppins', weight: 600, italic: false, sizePct: 4.6, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#D5DAE3',
    stroke: { color: '#000000', widthPct: 0 },
    shadow: { color: '#000000', opacity: 0.7, blurPx: 5, offsetPx: 2 },
    box: { enabled: false, color: '#000000', opacity: 0.5, paddingPct: 1 },
    highlight: { mode: 'color', color: '#FFFFFF', boxColor: '#FFFFFF', scale: 1 },
    keywordColor: '#8EE6C4',
    animation: 'fade',
    layout: { yPct: 73, marginXPct: 8, align: 'left' },
    chunking: { maxWords: 5, maxChars: 30, maxLines: 2 },
  },
  'neon-glow': {
    id: 'neon-glow',
    name: 'Neon Glow',
    builtin: true,
    font: { family: 'Bebas Neue', weight: 400, italic: false, sizePct: 9.4, letterSpacingPct: 2 },
    textCase: 'upper',
    fill: '#F4FFFF',
    stroke: { color: '#00E5FF', widthPct: 0.4 },
    shadow: { color: '#00E5FF', opacity: 0.95, blurPx: 16, offsetPx: 0 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color-scale', color: '#FF7AE8', boxColor: '#FF7AE8', scale: 1.1 },
    keywordColor: '#B8FF5C',
    animation: 'pop',
    layout: { yPct: 66, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 3, maxChars: 18, maxLines: 1 },
  },
  'boxed-highlight': {
    id: 'boxed-highlight',
    name: 'Boxed Highlight',
    builtin: true,
    font: { family: 'Poppins', weight: 800, italic: false, sizePct: 6.4, letterSpacingPct: 0 },
    textCase: 'upper',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0.45 },
    shadow: { color: '#000000', opacity: 0.5, blurPx: 0, offsetPx: 2 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1.1 },
    /** In box mode `color` is the text colour inside the box. */
    highlight: { mode: 'box', color: '#111111', boxColor: '#FFD60A', scale: 1 },
    keywordColor: '#FFD60A',
    animation: 'none',
    layout: { yPct: 67, marginXPct: 7, align: 'center' },
    chunking: { maxWords: 3, maxChars: 15, maxLines: 1 },
  },
  typewriter: {
    id: 'typewriter',
    name: 'Typewriter',
    builtin: true,
    font: { family: 'IBM Plex Mono', weight: 600, italic: false, sizePct: 4.8, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0 },
    shadow: { color: '#000000', opacity: 0, blurPx: 0, offsetPx: 0 },
    box: { enabled: true, color: '#0B0F14', opacity: 0.74, paddingPct: 1.5 },
    highlight: { mode: 'color', color: '#7CFFB2', boxColor: '#7CFFB2', scale: 1 },
    keywordColor: '#FFD60A',
    animation: 'typewriter',
    layout: { yPct: 70, marginXPct: 8, align: 'left' },
    chunking: { maxWords: 4, maxChars: 22, maxLines: 2 },
  },
  'bounce-word': {
    id: 'bounce-word',
    name: 'Bounce Word',
    builtin: true,
    font: { family: 'Poppins', weight: 800, italic: false, sizePct: 7.2, letterSpacingPct: 0 },
    textCase: 'upper',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0.65 },
    shadow: { color: '#000000', opacity: 0.55, blurPx: 0, offsetPx: 4 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color-scale', color: '#FF4D9D', boxColor: '#FF4D9D', scale: 1.18 },
    keywordColor: '#35E0A1',
    animation: 'bounce',
    layout: { yPct: 68, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 3, maxChars: 14, maxLines: 1 },
  },
  'gradient-glow': {
    id: 'gradient-glow',
    name: 'Gradient Glow',
    builtin: true,
    font: { family: 'Poppins', weight: 800, italic: false, sizePct: 7, letterSpacingPct: 0 },
    textCase: 'upper',
    fill: '#7DF9FF',
    stroke: { color: '#9B4DFF', widthPct: 0.55 },
    shadow: { color: '#FF3CAC', opacity: 0.9, blurPx: 18, offsetPx: 0 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color-scale', color: '#FFFFFF', boxColor: '#FFFFFF', scale: 1.1 },
    keywordColor: '#FFE45C',
    animation: 'pop',
    layout: { yPct: 67, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 3, maxChars: 14, maxLines: 1 },
  },
  'outline-only': {
    id: 'outline-only',
    name: 'Outline Only',
    builtin: true,
    font: { family: 'Montserrat', weight: 800, italic: false, sizePct: 7.2, letterSpacingPct: 0 },
    textCase: 'upper',
    fill: '#0A0A0C',
    stroke: { color: '#FFFFFF', widthPct: 0.9 },
    shadow: { color: '#000000', opacity: 0, blurPx: 0, offsetPx: 0 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color', color: '#FFD60A', boxColor: '#FFD60A', scale: 1 },
    keywordColor: '#35E0A1',
    animation: 'none',
    layout: { yPct: 68, marginXPct: 6, align: 'center' },
    chunking: { maxWords: 3, maxChars: 14, maxLines: 1 },
  },
  'caption-bubble': {
    id: 'caption-bubble',
    name: 'Caption Bubble',
    builtin: true,
    font: { family: 'Poppins', weight: 700, italic: false, sizePct: 5.4, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0 },
    shadow: { color: '#000000', opacity: 0.35, blurPx: 8, offsetPx: 3 },
    box: { enabled: true, color: '#101114', opacity: 0.8, paddingPct: 1.8 },
    highlight: { mode: 'color-scale', color: '#FFD60A', boxColor: '#FFD60A', scale: 1.08 },
    keywordColor: '#35E0A1',
    animation: 'pop',
    layout: { yPct: 67, marginXPct: 8, align: 'center' },
    chunking: { maxWords: 4, maxChars: 24, maxLines: 2 },
  },
  'podcast-lower-third': {
    id: 'podcast-lower-third',
    name: 'Podcast Lower-Third',
    builtin: true,
    font: { family: 'Poppins', weight: 600, italic: false, sizePct: 4.7, letterSpacingPct: 0 },
    textCase: 'none',
    fill: '#FFFFFF',
    stroke: { color: '#000000', widthPct: 0 },
    shadow: { color: '#000000', opacity: 0, blurPx: 0, offsetPx: 0 },
    box: { enabled: true, color: '#14213D', opacity: 0.9, paddingPct: 2 },
    highlight: { mode: 'color', color: '#FCA311', boxColor: '#FCA311', scale: 1 },
    keywordColor: '#FCA311',
    animation: 'slide-up',
    layout: { yPct: 72, marginXPct: 7, align: 'left' },
    chunking: { maxWords: 5, maxChars: 28, maxLines: 2 },
  },
  'subtle-serif': {
    id: 'subtle-serif',
    name: 'Subtle Serif',
    builtin: true,
    font: { family: 'DM Serif Display', weight: 400, italic: false, sizePct: 6.4, letterSpacingPct: 0.4 },
    textCase: 'none',
    fill: '#FFF6E5',
    stroke: { color: '#000000', widthPct: 0 },
    shadow: { color: '#000000', opacity: 0.8, blurPx: 7, offsetPx: 2 },
    box: { enabled: false, color: '#000000', opacity: 0.7, paddingPct: 1 },
    highlight: { mode: 'color', color: '#FFD27A', boxColor: '#FFD27A', scale: 1 },
    keywordColor: '#9FF0CF',
    animation: 'fade',
    layout: { yPct: 67, marginXPct: 8, align: 'center' },
    chunking: { maxWords: 4, maxChars: 22, maxLines: 2 },
  },
};

const BUILTINS: CaptionStyle[] = BUILTIN_STYLE_IDS.map((id) => captionStyleSchema.parse(RAW[id]));

/** Fresh copies of the 14 presets, in the brief's order (`clean-pop` first). */
export function builtinStyles(): CaptionStyle[] {
  return BUILTINS.map((s) => structuredClone(s));
}

export const CLEAN_POP: CaptionStyle = BUILTINS[0] as CaptionStyle;

/** Built-in style by id; unknown ids fall back to Clean Pop. */
export function resolveStyle(id: string): CaptionStyle {
  return BUILTINS.find((s) => s.id === id) ?? CLEAN_POP;
}

export { DEFAULT_STYLE_ID };

/* ---------------------------------------------- colours --------------------------------------------- */

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

/** Alpha for an override tag (`\1a`, `\3a`, `\4a`): `&HAA&` where 00 = opaque. */
export function assAlpha(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a.toUpperCase()}&`;
}
