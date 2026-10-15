/** Hook title card (BRIEF §4.9): a bold card near the top for the first 2-3 seconds. */
import { DEFAULT_HOOK_STYLE, type HookStyle } from '@shared/brand';
import { assColor, FONT_FAMILY } from './styles';
import { assHeader, assTime } from './ass';
import { fontBook, measureText } from './fontbook';
import { applyCase, escapeAssText } from './text';

export interface HookEvent {
  /** `Style: Hook,...` line for the [V4+ Styles] section. */
  style: string;
  /** `Dialogue:` line for the [Events] section. */
  event: string;
}

export const HOOK_STYLE_NAME = 'Hook';
/** Hook cards are shown for 2-4 s whatever the caller asks for. */
export const HOOK_MIN_SEC = 1.2;
export const HOOK_MAX_SEC = 4;

/** Breaks a hook into at most 3 balanced lines of at most `maxChars` characters. */
export function wrapHook(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const total = words.join(' ').length;
  const nLines = Math.min(3, Math.max(1, Math.ceil(total / maxChars)));
  const target = Math.ceil(total / nLines);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && next.length > target && lines.length < nLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** True when `style` is absent or equal to the built-in look (the CP1/CP2 card, reproduced byte for byte). */
export function isDefaultHookStyle(style: HookStyle | null | undefined): boolean {
  if (!style) return true;
  const d = DEFAULT_HOOK_STYLE;
  return (
    style.fontFamily === d.fontFamily &&
    style.weight === d.weight &&
    style.textColor.toLowerCase() === d.textColor.toLowerCase() &&
    style.cardColor.toLowerCase() === d.cardColor.toLowerCase() &&
    style.cardOpacity === d.cardOpacity &&
    style.textCase === d.textCase &&
    style.yPct === d.yPct &&
    style.sizePct === d.sizePct
  );
}

/** Everything the card layout needs, resolved from either the built-in look or a kit `HookStyle`. */
interface HookLook {
  fontName: string;
  bold: boolean;
  textColor: string;
  cardColor: string;
  cardOpacity: number;
  textCase: HookStyle['textCase'];
  /** Font size as a fraction of the frame's short side. */
  sizeFrac: number;
  /** Card centre, fraction of frame height. */
  yFrac: number;
  /** Measures a line in px at a font size (null = use the width heuristic). */
  measure: ((line: string, fontSize: number) => number) | null;
}

function builtinLook(landscape: boolean): HookLook {
  return {
    fontName: FONT_FAMILY,
    bold: true,
    textColor: '#101114',
    cardColor: '#FFFFFF',
    cardOpacity: 1,
    textCase: 'none',
    sizeFrac: landscape ? 0.066 : 0.074,
    yFrac: 0.18,
    measure: null,
  };
}

function styledLook(style: HookStyle, landscape: boolean): HookLook {
  const weight = Math.min(900, Math.max(100, Math.round(style.weight)));
  const face = fontBook.resolve(style.fontFamily, weight, false);
  // landscape frames keep the built-in 0.066/0.074 ratio so a kit that only recolours the card does not also resize it
  const ratio = landscape ? 0.066 / 0.074 : 1;
  return {
    fontName: face ? face.assName : style.fontFamily,
    bold: face ? face.weight >= 600 : weight >= 600,
    textColor: style.textColor,
    cardColor: style.cardColor,
    cardOpacity: Math.min(1, Math.max(0, style.cardOpacity)),
    textCase: style.textCase,
    sizeFrac: (Math.min(12, Math.max(3, style.sizePct)) / 100) * ratio,
    yFrac: Math.min(90, Math.max(5, style.yPct)) / 100,
    measure: (line, fontSize) => measureText(face, line, fontSize),
  };
}

/**
 * Style + event for the hook card. `durationSec` is clamped to [1.2, 4]. `style` (the Brand Kit's hook look) is
 * optional: undefined or equal to DEFAULT_HOOK_STYLE yields exactly the built-in white card.
 */
export function buildHookEvent(
  text: string,
  durationSec: number,
  width: number,
  height: number,
  style?: HookStyle | null,
): HookEvent {
  const landscape = width > height;
  const custom = !isDefaultHookStyle(style);
  const look = custom && style ? styledLook(style, landscape) : builtinLook(landscape);
  const base = landscape ? height : width;
  const shown = look.textCase === 'none' ? text : applyCase(text, look.textCase);
  let fontSize = Math.round(base * look.sizeFrac);
  const marginX = Math.round(width * 0.08);
  const budgetFor = (fs: number): number => width - 2 * marginX - 2 * Math.round(fs * 0.34);
  let lines: string[];
  if (!look.measure) {
    const pad = Math.round(fontSize * 0.34);
    // text width budget: frame width minus margins minus the box padding on both sides
    const budget = width - 2 * marginX - 2 * pad;
    let maxChars = Math.max(8, Math.floor(budget / (fontSize * 0.68)));
    lines = wrapHook(shown, maxChars);
    const longest = Math.max(0, ...lines.map((l) => [...l].length));
    if (longest > maxChars) {
      const k = maxChars / longest;
      fontSize = Math.max(18, Math.round(fontSize * k));
      maxChars = Math.floor(budget / (fontSize * 0.68));
      lines = wrapHook(shown, maxChars);
    }
  } else {
    // real glyph advances of the chosen face: wrap by the average character width, then shrink until the widest
    // line (plus the card padding) fits between the margins
    const measure = look.measure;
    const chars = Math.max(1, [...shown].length);
    lines = [];
    for (let i = 0; i < 8; i++) {
      const budget = budgetFor(fontSize);
      const avg = (measure(shown, fontSize) / chars) * 1.04;
      const maxChars = Math.max(8, Math.floor(budget / Math.max(1, avg)));
      lines = wrapHook(shown, maxChars);
      const widest = Math.max(0, ...lines.map((l) => measure(l, fontSize)));
      if (widest <= budget || fontSize <= 18) break;
      fontSize = Math.max(18, Math.floor((fontSize * budget) / widest));
    }
  }
  const outline = Math.round(fontSize * 0.34);
  const cx = Math.round(width / 2);
  let cy = Math.round(height * look.yFrac);
  if (custom) {
    // keep the whole card inside the frame whatever yPct/size/line count were asked for
    const half = Math.ceil((Math.max(1, lines.length) * fontSize) / 2 + outline) + 2;
    cy = Math.min(Math.max(cy, half), Math.max(half, height - half));
  }
  const dur = Math.min(HOOK_MAX_SEC, Math.max(HOOK_MIN_SEC, durationSec));

  const styleLine = [
    `Style: ${HOOK_STYLE_NAME}`,
    look.fontName,
    fontSize,
    assColor(look.textColor), // text
    assColor(look.textColor),
    assColor(look.cardColor, look.cardOpacity), // BorderStyle 3: the "outline" colour is the card fill
    assColor('#000000', 0.45 * look.cardOpacity), // card shadow
    look.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    3, // opaque box
    outline,
    Math.max(2, Math.round(fontSize * 0.1)),
    5,
    marginX,
    marginX,
    0,
    1,
  ].join(',');

  const fadeIn = 180;
  const fadeOut = 220;
  const outStart = Math.max(0, Math.round(dur * 1000) - fadeOut);
  const body = lines.map((l) => escapeAssText(l)).join('\\N');
  const tags =
    `{\\an5\\pos(${cx},${cy})\\fad(${fadeIn},${fadeOut})\\fscx84\\fscy84` +
    `\\t(0,260,\\fscx100\\fscy100)\\t(${outStart},${Math.round(dur * 1000)},\\fscx94\\fscy94)}`;
  const event = `Dialogue: 3,${assTime(0)},${assTime(dur)},${HOOK_STYLE_NAME},,0,0,0,,${tags}${body}`;
  return { style: styleLine, event };
}

/**
 * Returns `ass` with the hook style and event added (creates a minimal document when `ass` is empty).
 * Idempotent: an existing Hook style/event is replaced.
 */
export function appendHookToAss(
  ass: string | null,
  hook: { text: string; durationSec: number },
  width: number,
  height: number,
  style?: HookStyle | null,
): string {
  const ev = buildHookEvent(hook.text, hook.durationSec, width, height, style);
  let doc = ass && ass.trim() !== '' ? ass : assHeader(width, height, []);
  const lines = doc.split(/\r?\n/).filter((l) => !l.startsWith(`Style: ${HOOK_STYLE_NAME},`));
  const filtered = lines.filter(
    (l) => !(l.startsWith('Dialogue:') && l.includes(`,${HOOK_STYLE_NAME},`)),
  );
  const evIdx = filtered.findIndex((l) => l.trim() === '[Events]');
  if (evIdx < 0) {
    doc = [
      ...filtered,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join('\n');
    return appendHookToAss(doc, hook, width, height, style);
  }
  // insert the style as the last line of the styles section (right before the blank line + [Events])
  let insertAt = evIdx;
  while (insertAt > 0 && (filtered[insertAt - 1] ?? '').trim() === '') insertAt--;
  filtered.splice(insertAt, 0, ev.style);
  const out = filtered.join('\n').replace(/\n*$/, '\n') + ev.event + '\n';
  return out;
}
