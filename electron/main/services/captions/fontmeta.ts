/**
 * Minimal sfnt (TTF / OTF / TTC) reader: family names, weight, vertical metrics and glyph advances.
 * Used to (a) measure caption text so lines/boxes fit the frame, and (b) list fonts for the editor.
 * It reads only the tables it needs through `fs.readSync`, so scanning a system font folder with
 * large CJK collections stays cheap. No kerning/GPOS: widths are within ~1-2 % of libass output.
 */
import fs from 'node:fs';

export interface FaceNames {
  /** nameID 1 — what libass/fontconfig match as "family" (e.g. "Poppins ExtraBold"). */
  family: string;
  /** nameID 16 when present — the typographic family (e.g. "Poppins"). */
  typoFamily: string | null;
  /** nameID 2 / 17. */
  subfamily: string;
  fullName: string;
  /** OS/2 usWeightClass (100..900), 400 when absent. */
  weight: number;
  italic: boolean;
}

export interface FaceMetrics {
  unitsPerEm: number;
  /** Positive, em fractions. */
  ascent: number;
  descent: number;
  capHeight: number;
  /** Advance width in em fractions for `cp`, or null when the font has no glyph for it. */
  advance: (cp: number) => number | null;
}

class Reader {
  private fd: number;
  readonly size: number;
  constructor(readonly file: string) {
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
  slice(offset: number, length: number): Buffer {
    const len = Math.max(0, Math.min(length, this.size - offset));
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(this.fd, buf, 0, len, offset);
    return buf;
  }
  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

interface Table {
  offset: number;
  length: number;
}

function readDirectory(r: Reader, base: number): Map<string, Table> {
  const head = r.slice(base, 12);
  const numTables = head.length >= 12 ? head.readUInt16BE(4) : 0;
  const dir = r.slice(base + 12, numTables * 16);
  const tables = new Map<string, Table>();
  for (let i = 0; i + 16 <= dir.length; i += 16) {
    tables.set(dir.toString('latin1', i, i + 4), {
      offset: dir.readUInt32BE(i + 8),
      length: dir.readUInt32BE(i + 12),
    });
  }
  return tables;
}

/** Offsets of every face in the file (1 for TTF/OTF, n for a TTC collection). */
function faceOffsets(r: Reader): number[] {
  const head = r.slice(0, 16);
  if (head.length < 12) return [];
  const tag = head.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const n = Math.min(64, head.readUInt32BE(8));
    const offs = r.slice(12, n * 4);
    const out: number[] = [];
    for (let i = 0; i + 4 <= offs.length; i += 4) out.push(offs.readUInt32BE(i));
    return out;
  }
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true' || tag === 'OTTO') return [0];
  return [];
}

function decodeName(buf: Buffer, platform: number): string {
  if (platform === 3 || platform === 0) {
    // UTF-16BE
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('latin1');
}

function readNames(r: Reader, tables: Map<string, Table>): Map<number, string> {
  const t = tables.get('name');
  const names = new Map<number, string>();
  if (!t) return names;
  const buf = r.slice(t.offset, Math.min(t.length, 1 << 20));
  if (buf.length < 6) return names;
  const count = buf.readUInt16BE(2);
  const strOff = buf.readUInt16BE(4);
  const score = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > buf.length) break;
    const platform = buf.readUInt16BE(o);
    const lang = buf.readUInt16BE(o + 4);
    const id = buf.readUInt16BE(o + 6);
    const len = buf.readUInt16BE(o + 8);
    const off = buf.readUInt16BE(o + 10);
    // prefer Windows English (3/0x409), then any Windows/Unicode, then Mac Roman
    const s = platform === 3 ? (lang === 0x409 ? 3 : 2) : platform === 0 ? 2 : 1;
    if (s <= (score.get(id) ?? 0)) continue;
    const raw = buf.subarray(strOff + off, strOff + off + len);
    if (raw.length !== len) continue;
    names.set(id, decodeName(raw, platform).replace(/\u0000/g, '').trim());
    score.set(id, s);
  }
  return names;
}

function readOs2(r: Reader, tables: Map<string, Table>): { weight: number; italic: boolean } | null {
  const t = tables.get('OS/2');
  if (!t || t.length < 64) return null;
  const b = r.slice(t.offset, Math.min(t.length, 96));
  return { weight: b.readUInt16BE(4), italic: (b.readUInt16BE(62) & 1) !== 0 };
}

export interface ParsedFace {
  names: FaceNames;
  /** Lazily reads cmap/hmtx (reopens the file). */
  loadMetrics: () => FaceMetrics | null;
}

/** All faces in a font file (names only; metrics load on demand). Returns [] for non sfnt files. */
export function readFaces(file: string): ParsedFace[] {
  let r: Reader;
  try {
    r = new Reader(file);
  } catch {
    return [];
  }
  const out: ParsedFace[] = [];
  try {
    for (const base of faceOffsets(r)) {
      const tables = readDirectory(r, base);
      const names = readNames(r, tables);
      const family = names.get(1) ?? names.get(16);
      if (!family) continue;
      const os2 = readOs2(r, tables);
      const subfamily = names.get(17) ?? names.get(2) ?? 'Regular';
      const style = names.get(2) ?? '';
      out.push({
        names: {
          family,
          typoFamily: names.get(16) ?? null,
          subfamily,
          fullName: names.get(4) ?? family,
          weight: os2?.weight ?? (/bold/i.test(style) ? 700 : 400),
          italic: os2?.italic ?? /italic|oblique/i.test(style),
        },
        loadMetrics: () => loadMetrics(file, base),
      });
    }
  } finally {
    r.close();
  }
  return out;
}

function parseCmap(buf: Buffer): (cp: number) => number {
  const n = buf.length >= 4 ? buf.readUInt16BE(2) : 0;
  let best: { off: number; prio: number } | null = null;
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    if (o + 8 > buf.length) break;
    const platform = buf.readUInt16BE(o);
    const enc = buf.readUInt16BE(o + 2);
    const off = buf.readUInt32BE(o + 4);
    const prio = platform === 3 && enc === 10 ? 4 : platform === 3 && enc === 1 ? 3 : platform === 0 ? 2 : 0;
    if (prio > 0 && (!best || prio > best.prio)) best = { off, prio };
  }
  if (!best) return () => 0;
  const fmt = buf.readUInt16BE(best.off);
  const base = best.off;
  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(base + 6);
    const seg = segX2 / 2;
    const endO = base + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      let lo = 0;
      let hi = seg - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (buf.readUInt16BE(endO + mid * 2) < cp) lo = mid + 1;
        else hi = mid;
      }
      if (lo >= seg) return 0;
      const start = buf.readUInt16BE(startO + lo * 2);
      if (cp < start || cp > buf.readUInt16BE(endO + lo * 2)) return 0;
      const delta = buf.readInt16BE(deltaO + lo * 2);
      const ro = buf.readUInt16BE(rangeO + lo * 2);
      if (ro === 0) return (cp + delta) & 0xffff;
      const gi = buf.readUInt16BE(rangeO + lo * 2 + ro + (cp - start) * 2);
      return gi === 0 ? 0 : (gi + delta) & 0xffff;
    };
  }
  if (fmt === 12) {
    const groups = buf.readUInt32BE(base + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = base + 16 + mid * 12;
        const s = buf.readUInt32BE(g);
        const e = buf.readUInt32BE(g + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + (cp - s);
      }
      return 0;
    };
  }
  return () => 0;
}

function loadMetrics(file: string, base: number): FaceMetrics | null {
  let r: Reader;
  try {
    r = new Reader(file);
  } catch {
    return null;
  }
  try {
    const tables = readDirectory(r, base);
    const get = (tag: string): Buffer | null => {
      const t = tables.get(tag);
      return t ? r.slice(t.offset, t.length) : null;
    };
    const head = get('head');
    const hhea = get('hhea');
    const hmtx = get('hmtx');
    const cmap = get('cmap');
    if (!head || !hhea || !hmtx || !cmap || head.length < 20 || hhea.length < 36) return null;
    const upm = head.readUInt16BE(18) || 1000;
    const numH = hhea.readUInt16BE(34);
    let ascent = hhea.readInt16BE(4);
    let descent = -hhea.readInt16BE(6);
    const os2 = get('OS/2');
    let capHeight = 0.7 * upm;
    if (os2 && os2.length >= 78) {
      if (ascent === 0 && descent === 0) {
        ascent = os2.readUInt16BE(74);
        descent = os2.readUInt16BE(76);
      }
      if (os2.length >= 90 && os2.readUInt16BE(0) >= 2) capHeight = os2.readInt16BE(88) || capHeight;
    }
    const glyphOf = parseCmap(cmap);
    const advanceOfGlyph = (g: number): number => {
      const i = Math.min(g, Math.max(0, numH - 1));
      const o = i * 4;
      return o + 2 <= hmtx.length ? hmtx.readUInt16BE(o) : 0;
    };
    return {
      unitsPerEm: upm,
      ascent: ascent / upm,
      descent: descent / upm,
      capHeight: capHeight / upm,
      advance: (cp) => {
        const g = glyphOf(cp);
        return g === 0 ? null : advanceOfGlyph(g) / upm;
      },
    };
  } catch {
    return null;
  } finally {
    r.close();
  }
}
