/** Hook title card (BRIEF §4.9): a bold card near the top for the first 2-3 seconds. */
import { assColor, FONT_FAMILY } from './styles';
import { assHeader, assTime } from './ass';
import { escapeAssText } from './text';

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

/** Style + event for the hook card. `durationSec` is clamped to [1.2, 4]. */
export function buildHookEvent(
  text: string,
  durationSec: number,
  width: number,
  height: number,
): HookEvent {
  const landscape = width > height;
  const base = landscape ? height : width;
  let fontSize = Math.round(base * (landscape ? 0.066 : 0.074));
  const marginX = Math.round(width * 0.08);
  const pad = Math.round(fontSize * 0.34);
  // text width budget: frame width minus margins minus the box padding on both sides
  const budget = width - 2 * marginX - 2 * pad;
  let maxChars = Math.max(8, Math.floor(budget / (fontSize * 0.68)));
  let lines = wrapHook(text, maxChars);
  const longest = Math.max(0, ...lines.map((l) => [...l].length));
  if (longest > maxChars) {
    const k = maxChars / longest;
    fontSize = Math.max(18, Math.round(fontSize * k));
    maxChars = Math.floor(budget / (fontSize * 0.68));
    lines = wrapHook(text, maxChars);
  }
  const outline = Math.round(fontSize * 0.34);
  const cx = Math.round(width / 2);
  const cy = Math.round(height * 0.18);
  const dur = Math.min(HOOK_MAX_SEC, Math.max(HOOK_MIN_SEC, durationSec));

  const style = [
    `Style: ${HOOK_STYLE_NAME}`,
    FONT_FAMILY,
    fontSize,
    assColor('#101114'), // text
    assColor('#101114'),
    assColor('#FFFFFF'), // BorderStyle 3: the "outline" colour is the card fill
    assColor('#000000', 0.45), // card shadow
    -1,
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
  return { style, event };
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
): string {
  const ev = buildHookEvent(hook.text, hook.durationSec, width, height);
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
    return appendHookToAss(doc, hook, width, height);
  }
  // insert the style as the last line of the styles section (right before the blank line + [Events])
  let insertAt = evIdx;
  while (insertAt > 0 && (filtered[insertAt - 1] ?? '').trim() === '') insertAt--;
  filtered.splice(insertAt, 0, ev.style);
  const out = filtered.join('\n').replace(/\n*$/, '\n') + ev.event + '\n';
  return out;
}
