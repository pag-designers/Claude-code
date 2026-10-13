/** Text helpers for captions: ASS escaping, profanity masking, word normalisation. */
import type { Word } from '@shared/pipeline';

/** Strong sentence-ending punctuation (also through trailing quotes/brackets). */
export const STRONG_PUNCT = /[.?!…]["')\]”’]*$/;
/** Soft break opportunities. */
export const SOFT_PUNCT = /[,;:–—]["')\]”’]*$/;

/** Function words a caption line should not end on (they belong with what follows). */
export const WEAK_END = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'and',
  'but',
  'or',
  'so',
  'if',
  'as',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'this',
  'that',
  'i',
  'we',
  'you',
  'they',
  'is',
  'are',
  'was',
  'be',
  'not',
  'very',
  'than',
  'from',
  'by',
  'into',
  'about',
  'because',
]);

export const normalizeToken = (w: string): string =>
  w
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .replace(/’/g, "'");

/**
 * Escapes caption text for an ASS Dialogue field. Braces would open override blocks ("\{" is the
 * libass escape), a lone backslash would start a tag/line-break escape (dropped), and line breaks /
 * control characters would corrupt the event.
 */
export function escapeAssText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\\/g, '')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
  );
}

/** Applies the style's text case. "title" capitalises each word and lowers shouted (ALL CAPS) words. */
export function applyCase(text: string, mode: 'none' | 'upper' | 'lower' | 'title'): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      // capitalise each word; lower SHOUTED words; leave mixed-case words ("iPhone") alone
      return text.replace(
        /(^|[\s\-"'(\[“‘])(\p{L})(\p{L}*)/gu,
        (_m, pre: string, first: string, rest: string) => {
          const mixed = /\p{Lu}/u.test(rest) && rest !== rest.toUpperCase();
          if (mixed) return `${pre}${first}${rest}`;
          return `${pre}${first.toUpperCase()}${rest === rest.toUpperCase() ? rest.toLowerCase() : rest}`;
        },
      );
    default:
      return text;
  }
}

/* ------------------------------------------------ profanity ---------------------------------------- */

const PROFANITY: RegExp[] = [
  /^f+u+c+k+\w*$/,
  /^motherf\w+$/,
  /^sh[i1]+t+\w*$/,
  /^bullsh[i1]t\w*$/,
  /^b[i1]tch\w*$/,
  /^a+ss+h[o0]le\w*$/,
  /^dumbass\w*$/,
  /^jackass\w*$/,
  /^bastard\w*$/,
  /^cunt\w*$/,
  /^d[i1]ck\w*$/,
  /^pr[i1]ck\w*$/,
  /^p[i1]ss\w*$/,
  /^wh[o0]re\w*$/,
  /^sl[u]t\w*$/,
  /^cock\w*$/,
  /^tits?$/,
  /^pussy$/,
  /^nigg\w*$/,
  /^fag+\w*$/,
  /^retard\w*$/,
  /^damn\w*$/,
  /^goddamn\w*$/,
  /^crap$/,
  /^wtf$/,
  /^stfu$/,
];

export const isProfane = (token: string): boolean => {
  const t = normalizeToken(token);
  return t.length > 0 && PROFANITY.some((re) => re.test(t));
};

/** "fucking," -> "f*****," (first letter kept, remaining letters/digits starred, punctuation kept). */
export function maskWord(word: string): string {
  const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}']*)(.*)$/su.exec(word);
  if (!m) return word;
  const [, pre = '', core = '', post = ''] = m;
  const chars = [...core];
  return `${pre}${chars[0] ?? ''}${'*'.repeat(Math.max(0, chars.length - 1))}${post}`;
}

/* ------------------------------------------------ words ------------------------------------------- */

export interface CaptionWord {
  /** Display text (profanity masked), not yet case-converted/escaped. */
  text: string;
  /** Clip-relative seconds. */
  s: number;
  e: number;
  /** Normalised token (for keyword matching). */
  norm: string;
}

/**
 * Words overlapping [startSec,endSec), shifted to clip-relative seconds, clamped to the clip and
 * made sequential (no overlaps; start times are never moved). Zero-length ASR words stay zero-length
 * when the next word starts at the same instant (they are displayed but never "active").
 */
export function prepareWords(
  words: Word[],
  startSec: number,
  endSec: number,
  maskProfanity: boolean,
): CaptionWord[] {
  const dur = Math.max(0, endSec - startSec);
  const out: CaptionWord[] = [];
  for (const w of words) {
    const raw = w.w.replace(/\s+/g, ' ').trim();
    if (raw === '' || !Number.isFinite(w.s) || !Number.isFinite(w.e)) continue;
    if (w.e <= startSec || w.s >= endSec) continue;
    const s = Math.max(0, w.s - startSec);
    const e = Math.min(dur, Math.max(w.e, w.s) - startSec);
    out.push({
      text: maskProfanity && isProfane(raw) ? maskWord(raw) : raw,
      s,
      e: Math.max(s, e),
      norm: normalizeToken(raw),
    });
  }
  out.sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    const c = out[i + 1];
    if (!p) continue;
    // true overlap: the previous word ends where the next one starts (start times are never moved)
    if (c && c.s < p.e) p.e = Math.max(p.s, c.s);
    // ASR sometimes emits zero-length words (tiny model): give an isolated one a short visible life,
    // but never steal time from the following word
    if (p.e <= p.s) {
      const room = c ? c.s - p.s : Math.max(0, dur - p.s);
      p.e = p.s + Math.min(0.12, room >= 0.08 ? room : 0);
    }
  }
  return out;
}
