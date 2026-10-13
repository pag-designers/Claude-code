/**
 * Thumbnail text overlay as an ASS document (the bundled ffmpeg has no `drawtext`, libass is always there):
 * bold Montserrat ExtraBold, upper case, <= 5 words, <= 3 balanced lines, auto-fitted to 84% of the width,
 * thick black stroke, last word in the accent colour, safe margins (clear of the platform UI zones).
 */

/** Same family as the caption / hook styles (`electron/main/assets/fonts/Montserrat-ExtraBold.ttf`). */
export const THUMB_FONT = 'Montserrat ExtraBold';
export const MAX_WORDS = 5;
const SAFE_X = 0.08;
/** Average advance of upper-case Montserrat ExtraBold, in em (slightly conservative). */
const ADVANCE_EM = 0.72;

export function thumbWords(text: string): string[] {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[{}\\]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((w) => w.toUpperCase());
}

/** Balanced wrap into at most `maxLines` lines. */
export function wrapWords(words: string[], maxLines = 3): string[][] {
  if (words.length <= 1) return [words];
  const total = words.join(' ').length;
  const n = Math.min(maxLines, words.length, Math.max(1, Math.ceil(total / 14)));
  const target = Math.ceil(total / n);
  const lines: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const w of words) {
    const add = cur.length ? len + 1 + w.length : w.length;
    if (cur.length && add > target && lines.length < n - 1) {
      lines.push(cur);
      cur = [w];
      len = w.length;
    } else {
      cur.push(w);
      len = add;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

export interface TextLayout {
  lines: string[][];
  fontSize: number;
  outline: number;
  /** Line centre, px. */
  cx: number;
  cy: number;
}

/** Auto-fit: the largest font (<= 9.5% of the height for portrait frames) whose longest line fits. */
export function layoutThumbText(text: string, width: number, height: number): TextLayout | null {
  const words = thumbWords(text);
  if (words.length === 0) return null;
  const lines = wrapWords(words);
  const longest = Math.max(...lines.map((l) => l.join(' ').length));
  const budget = width * (1 - 2 * SAFE_X);
  const portrait = height >= width;
  const maxSize = (portrait ? 0.095 : 0.14) * height;
  const fontSize = Math.max(16, Math.round(Math.min(maxSize, budget / (longest * ADVANCE_EM))));
  const outline = Math.round(fontSize * 0.16);
  const cy = Math.round(
    height * (portrait ? 0.68 : 0.78) - ((lines.length - 1) * fontSize * 1.1) / 2,
  );
  return { lines, fontSize, outline, cx: Math.round(width / 2), cy };
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');

/** The ASS document, or null when there is no text. */
export function buildThumbAss(
  text: string | null,
  width: number,
  height: number,
  opts: { fill?: string; accent?: string; stroke?: string } = {},
): string | null {
  const lay = text ? layoutThumbText(text, width, height) : null;
  if (!lay) return null;
  const fill = opts.fill ?? '&H00FFFFFF&';
  const accent = opts.accent ?? '&H000AD6FF&'; // #FFD60A (BGR)
  const stroke = opts.stroke ?? '&H00000000&';
  const style = [
    'Style: Thumb',
    THUMB_FONT,
    lay.fontSize,
    fill,
    fill,
    stroke,
    '&H80000000',
    -1,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    lay.outline,
    Math.max(2, Math.round(lay.fontSize * 0.06)),
    5,
    Math.round(width * SAFE_X),
    Math.round(width * SAFE_X),
    0,
    1,
  ].join(',');
  const lastLine = lay.lines.length - 1;
  const body = lay.lines
    .map((l, li) =>
      l
        .map((w, wi) =>
          li === lastLine && wi === l.length - 1 && lay.lines.flat().length > 1
            ? `{\\1c${accent}}${esc(w)}{\\1c${fill}}`
            : esc(w),
        )
        .join(' '),
    )
    .join('\\N');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:10.00,Thumb,,0,0,0,,{\\an5\\pos(${lay.cx},${lay.cy})}${body}`,
    '',
  ].join('\n');
}
