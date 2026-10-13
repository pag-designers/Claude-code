/**
 * Font registry for the caption engine: shipped fonts (static metrics table, no I/O), fonts found in a
 * `fontsDir` (user uploads), and the system's fonts (listing only). Resolves a (family, weight, italic)
 * request to the face libass will use, and measures text with that face's advance widths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFaces, type FaceMetrics, type FaceNames } from './fontmeta';
import { SHIPPED_FACES } from './font-metrics';

export interface FontFace {
  /** Typographic family ("Poppins"). */
  family: string;
  /** The name libass/fontconfig match (nameID 1: "Poppins ExtraBold"). */
  assName: string;
  weight: number;
  italic: boolean;
  shipped: boolean;
  /** Em fractions. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** Advance in em fractions, null when the face has no glyph. */
  advance: (cp: number) => number | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const EXTRA_CPS = [0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0x2022, 0x20ac, 0x2122];

function shippedFaces(): FontFace[] {
  return SHIPPED_FACES.map((f) => ({
    family: f.family,
    assName: f.assName,
    weight: f.weight,
    italic: f.italic,
    shipped: true,
    ascent: f.ascent / 1000,
    descent: f.descent / 1000,
    capHeight: f.capHeight / 1000,
    advance: (cp: number): number | null => {
      let v: number | undefined;
      if (cp >= 0x20 && cp <= 0x7e) v = f.ascii[cp - 0x20];
      else if (cp >= 0xa0 && cp <= 0xff) v = f.latin1[cp - 0xa0];
      else if (EXTRA_CPS.includes(cp)) v = f.extra[cp];
      return v === undefined || v < 0 ? null : v / 1000;
    },
  }));
}

function lazyFace(names: FaceNames, load: () => FaceMetrics | null, shipped: boolean): FontFace {
  let m: FaceMetrics | null | undefined;
  const metrics = (): FaceMetrics | null => (m === undefined ? (m = load()) : m);
  return {
    family: names.typoFamily ?? names.family,
    assName: names.family,
    weight: names.weight,
    italic: names.italic,
    shipped,
    get ascent() {
      return metrics()?.ascent ?? 0.95;
    },
    get descent() {
      return metrics()?.descent ?? 0.25;
    },
    get capHeight() {
      return metrics()?.capHeight ?? 0.7;
    },
    advance: (cp) => metrics()?.advance(cp) ?? null,
  };
}

const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;

function scanDir(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) scanDir(p, depth - 1, out);
    } else if (FONT_EXT.test(e.name)) {
      out.push(p);
    }
  }
}

function systemFontDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
    case 'win32':
      return [
        path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts'),
      ];
    default:
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        path.join(home, '.fonts'),
        path.join(home, '.local', 'share', 'fonts'),
      ];
  }
}

const key = (f: FontFace): string => `${norm(f.assName)}|${f.weight}|${f.italic}`;

export class FontBook {
  private faces: FontFace[] = shippedFaces();
  private seen = new Set<string>(this.faces.map(key));
  private dirs = new Map<string, number>();
  private system: FontFace[] | null = null;

  /** Registers the fonts of `dir` (rescans when the directory changed). */
  addDir(dir: string | null): FontFace[] {
    if (!dir) return [];
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      return [];
    }
    const added: FontFace[] = [];
    if (this.dirs.get(dir) === mtime) return added;
    this.dirs.set(dir, mtime);
    const files: string[] = [];
    scanDir(dir, 2, files);
    for (const file of files) {
      for (const parsed of readFaces(file)) {
        const face = lazyFace(parsed.names, parsed.loadMetrics, false);
        if (this.seen.has(key(face))) continue;
        this.seen.add(key(face));
        this.faces.push(face);
        added.push(face);
      }
    }
    return added;
  }

  systemFaces(): FontFace[] {
    if (this.system) return this.system;
    const files: string[] = [];
    for (const d of systemFontDirs()) scanDir(d, 3, files);
    const out: FontFace[] = [];
    for (const file of files) {
      for (const parsed of readFaces(file))
        out.push(lazyFace(parsed.names, parsed.loadMetrics, false));
    }
    this.system = out;
    return out;
  }

  /** Shipped + registered faces (not the system's). */
  known(): FontFace[] {
    return this.faces;
  }

  /**
   * Closest registered face for the request (same family, nearest weight). Falls back to the system's
   * fonts, then null (libass will substitute something by name).
   */
  resolve(family: string, weight: number, italic: boolean): FontFace | null {
    const q = norm(family);
    const pick = (pool: FontFace[]): FontFace | null => {
      let best: FontFace | null = null;
      let bestScore = Infinity;
      for (const f of pool) {
        if (norm(f.family) !== q && norm(f.assName) !== q) continue;
        const score = Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000);
        if (score < bestScore) {
          best = f;
          bestScore = score;
        }
      }
      return best;
    };
    return pick(this.faces) ?? pick(this.systemFaces());
  }

  /** Families (+ weights) of everything libass can use: shipped, `fontsDir`, system. */
  listFamilies(): { family: string; weights: number[] }[] {
    const map = new Map<string, { family: string; weights: Set<number> }>();
    for (const f of [...this.faces, ...this.systemFaces()]) {
      const k = norm(f.family);
      let e = map.get(k);
      if (!e) {
        e = { family: f.family, weights: new Set() };
        map.set(k, e);
      }
      e.weights.add(f.weight);
    }
    return [...map.values()]
      .map((e) => ({ family: e.family, weights: [...e.weights].sort((a, b) => a - b) }))
      .sort((a, b) => a.family.localeCompare(b.family));
  }
}

export const fontBook = new FontBook();

/* ------------------------------------------------ measuring ------------------------------------------ */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters a font usually lacks and the system falls back for: CJK, Hangul, kana, emoji. */
export const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x11ff) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f000 && cp <= 0x1faff) ||
  (cp >= 0x2600 && cp <= 0x27bf);

/** Average lower/upper-case advance used when a face has no glyph (em). */
const FALLBACK_ADVANCE = 0.6;

/** Width in px of one grapheme cluster. */
function clusterAdvance(face: FontFace | null, cluster: string): number {
  const cp = cluster.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x200b || cp === 0x200d) return 0;
  const generic = face ?? fontBook.resolve('Poppins', 600, false);
  const a = generic?.advance(cp);
  return a ?? FALLBACK_ADVANCE;
}

/**
 * libass (like VSFilter) treats the ASS font size as the height of the line cell (ascent + descent), not
 * the em: the em in px is `size / (ascent + descent)`.
 */
export function emPx(face: FontFace | null, sizePx: number): number {
  const f = face ?? fontBook.resolve('Poppins', 600, false);
  const cell = f ? f.ascent + f.descent : 1.4;
  return sizePx / (cell > 0.1 ? cell : 1.4);
}

/** Text width in px for `face` at ASS font size `sizePx` with `spacingPx` between glyphs (libass adds it after each). */
export function measureText(
  face: FontFace | null,
  text: string,
  sizePx: number,
  spacingPx = 0,
): number {
  const em = emPx(face, sizePx);
  let w = 0;
  let n = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cp = segment.codePointAt(0) ?? 0;
    // CJK / emoji come from a fallback font whose cell is ~ the ASS size: about 0.95 of it per glyph
    w += isWide(cp) ? 0.95 * sizePx : clusterAdvance(face, segment) * em;
    n++;
  }
  return w + n * spacingPx;
}

/** Line height libass uses: the ASS font size itself (it is the ascent + descent cell). */
export function lineHeight(_face: FontFace | null, sizePx: number): number {
  return sizePx;
}
