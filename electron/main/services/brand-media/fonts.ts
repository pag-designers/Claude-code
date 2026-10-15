/**
 * Font uploads: container sniffing, WOFF / WOFF2 -> sfnt conversion, name/weight parsing (via captions/fontmeta) and a
 * rendered "Aa Bb 123" specimen. The specimen is rendered by the same libass that burns captions, so a font that
 * cannot be used for captions is rejected at upload time instead of silently falling back to another face.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ProcessedBrandAsset } from '../../pipeline/contracts4';
import { readFaces, type FaceMetrics } from '../captions/fontmeta';
import { escapeFilterPath } from '../render/filters';
import {
  BrandMediaError,
  atomicOut,
  baseName,
  rmQuiet,
  runFf,
  unreadable,
  type FfCtx,
} from './ffutil';

const LABEL: Record<string, string> = {
  ttf: 'TTF font',
  otf: 'OTF font',
  woff: 'WOFF font',
  woff2: 'WOFF2 font',
};

const tag = (b: Buffer, o: number): string => b.toString('latin1', o, o + 4);

export type FontContainer = 'sfnt-ttf' | 'sfnt-otf' | 'woff' | 'woff2' | 'collection' | 'unknown';

/** Identifies the container from the first bytes (the file extension is only a hint). */
export function sniffFont(head: Buffer): FontContainer {
  if (head.length < 12) return 'unknown';
  const t = tag(head, 0);
  if (t === 'wOFF') return 'woff';
  if (t === 'wOF2') return 'woff2';
  if (t === 'ttcf') return 'collection';
  if (t === 'OTTO') return 'sfnt-otf';
  if (t === '\u0000\u0001\u0000\u0000' || t === 'true') return 'sfnt-ttf';
  return 'unknown';
}

/** Table tags of an in-memory sfnt (empty when the directory is malformed). */
export function sfntTables(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const n = buf.readUInt16BE(4);
  if (12 + n * 16 > buf.length) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(tag(buf, 12 + i * 16));
  return out;
}

/** True when the table set can actually draw and measure text. */
function looksComplete(tables: string[]): boolean {
  const has = (t: string): boolean => tables.includes(t);
  const outlines = (has('glyf') && has('loca')) || has('CFF ') || has('CFF2');
  return (
    outlines &&
    has('cmap') &&
    has('head') &&
    has('hhea') &&
    has('hmtx') &&
    has('maxp') &&
    has('name')
  );
}

/** WOFF 1.0 (zlib per table) -> sfnt. Throws on a malformed file. */
export function woffToSfnt(buf: Buffer): Buffer {
  if (buf.length < 44 || tag(buf, 0) !== 'wOFF') throw new Error('not a WOFF file');
  const flavor = buf.readUInt32BE(4);
  const declared = buf.readUInt32BE(8);
  const numTables = buf.readUInt16BE(12);
  if (declared > buf.length) throw new Error('truncated WOFF file');
  if (numTables === 0 || 44 + numTables * 20 > buf.length) throw new Error('bad WOFF directory');
  const entries: { tag: string; data: Buffer; checksum: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const offset = buf.readUInt32BE(o + 4);
    const comp = buf.readUInt32BE(o + 8);
    const orig = buf.readUInt32BE(o + 12);
    if (offset + comp > buf.length || comp > orig) throw new Error('bad WOFF table bounds');
    const raw = buf.subarray(offset, offset + comp);
    const data = comp < orig ? zlib.inflateSync(raw) : raw;
    if (data.length !== orig) throw new Error('WOFF table length mismatch');
    entries.push({ tag: tag(buf, o), data, checksum: buf.readUInt32BE(o + 16) });
  }
  entries.sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));
  const headerLen = 12 + numTables * 16;
  const total = entries.reduce((n, e) => n + ((e.data.length + 3) & ~3), headerLen);
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = 2 ** entrySelector * 16;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let pos = headerLen;
  entries.forEach((e, i) => {
    const o = 12 + i * 16;
    out.write(e.tag, o, 'latin1');
    out.writeUInt32BE(e.checksum >>> 0, o + 4);
    out.writeUInt32BE(pos, o + 8);
    out.writeUInt32BE(e.data.length, o + 12);
    e.data.copy(out, pos);
    pos += (e.data.length + 3) & ~3;
  });
  return out;
}

/** WOFF2 -> sfnt through wawoff2 (WASM, no native code, works offline). */
export async function woff2ToSfnt(buf: Buffer): Promise<Buffer> {
  // only the decompressor: the package's index also pulls in the 1 MB compressor
  const mod = await import('wawoff2/decompress');
  const out = await mod.default(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
  return Buffer.from(out.buffer, out.byteOffset, out.length);
}

export interface FontArgs {
  file: string;
  ext: string;
  outDir: string;
  signal?: AbortSignal;
  stage: (name: string, fraction: number | null) => void;
}

/** Sample text a face can really draw: Latin first, then other scripts, so a CJK-only font still shows glyphs. */
const SAMPLES = ['Aa Bb 123', 'Аа Бб 123', 'Αα Ββ 123', 'あア 漢字', '가나다 123'];

export function pickSpecimen(metrics: FaceMetrics | null): string {
  if (!metrics) return SAMPLES[0] as string;
  for (const s of SAMPLES) {
    const letters = [...s].filter((c) => c !== ' ');
    if (letters.every((c) => metrics.advance(c.codePointAt(0) ?? 0) !== null)) return s;
  }
  return SAMPLES[0] as string;
}

const assColor = '&H00F2F2F2';

function specimenAss(a: {
  assName: string;
  bold: boolean;
  italic: boolean;
  text: string;
  fontSize: number;
  width: number;
  height: number;
}): string {
  const name = a.assName.replace(/[,\r\n]/g, ' ');
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${a.width}`,
    `PlayResY: ${a.height}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: S,${name},${a.fontSize},${assColor},${assColor},&H00000000,&H00000000,${a.bold ? -1 : 0},${a.italic ? -1 : 0},0,0,100,100,0,0,1,0,0,5,16,16,16,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:05.00,S,,0,0,0,,${a.text.replace(/[{}\\]/g, '')}`,
    '',
  ].join('\n');
}

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * libass logs `fontselect: (<asked>, w, i) -> <found>, idx, <psname>` at verbose level. Fonts loaded from fontsdir show
 * a bare name, system fonts a path. Returns true when libass fell back to a DIFFERENT system font.
 */
export function fellBackToSystemFont(stderr: string, ours: string[]): boolean {
  const m = /fontselect: \(.*?\) -> ([^\n]*?), (-?\d+), ([^\n]*)/.exec(stderr);
  if (!m) return false;
  const found = (m[1] ?? '').trim();
  const ps = (m[3] ?? '').trim();
  const isPath = /[\\/]/.test(found);
  if (!isPath) return false;
  const mine = new Set(ours.map(normName));
  return !(
    mine.has(normName(ps)) || mine.has(normName(path.basename(found).replace(/\.[^.]+$/, '')))
  );
}

export async function processFont(ctx: FfCtx, a: FontArgs): Promise<ProcessedBrandAsset> {
  const what = LABEL[a.ext] ?? 'font';
  a.stage('Reading font', null);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(a.file);
  } catch {
    throw unreadable(a.file, what);
  }
  const container = sniffFont(raw);
  if (container === 'collection') {
    throw new BrandMediaError(
      `'${baseName(a.file)}' is a font collection (several fonts in one file). Upload the individual TTF or OTF files instead.`,
    );
  }
  if (container === 'unknown') throw unreadable(a.file, what);

  let sfnt: Buffer;
  try {
    if (container === 'woff') sfnt = woffToSfnt(raw);
    else if (container === 'woff2') sfnt = await woff2ToSfnt(raw);
    else sfnt = raw;
  } catch (e) {
    ctx.log(`[brand-media] font decode failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }
  // the converted data may itself be a collection (WOFF2 can wrap one)
  if (sniffFont(sfnt) === 'collection') {
    throw new BrandMediaError(
      `'${baseName(a.file)}' is a font collection (several fonts in one file). Upload the individual TTF or OTF files instead.`,
    );
  }
  const sfntExt: 'ttf' | 'otf' = tag(sfnt, 0) === 'OTTO' ? 'otf' : 'ttf';
  const tables = sfntTables(sfnt);
  if (!looksComplete(tables)) throw unreadable(a.file, what);

  const sfntPath = path.join(a.outDir, `font.${sfntExt}`);
  await rmQuiet(path.join(a.outDir, 'font.ttf'), path.join(a.outDir, 'font.otf'));
  await fs.promises.writeFile(sfntPath, sfnt);

  const face = readFaces(sfntPath)[0];
  if (!face) throw unreadable(a.file, what);
  const n = face.names;
  const weight = Math.min(900, Math.max(100, Math.round(n.weight || 400)));
  const metrics = face.loadMetrics();

  a.stage('Rendering specimen', null);
  const thumbPath = path.join(a.outDir, 'thumb.jpg');
  const W = 480;
  const H = 240;
  const text = pickSpecimen(metrics);
  const sumEm = metrics
    ? [...text].reduce((s, c) => s + (metrics.advance(c.codePointAt(0) ?? 0) ?? 0.6), 0)
    : text.length * 0.6;
  const cell = metrics ? metrics.ascent + metrics.descent : 1.3;
  const emPx = Math.max(24, Math.min(104, (W - 64) / Math.max(1, sumEm)));
  const fontSize = Math.round(emPx * (cell > 0.2 ? cell : 1.3));

  const work = path.join(a.outDir, '.specimen');
  await rmQuiet(work);
  await fs.promises.mkdir(work, { recursive: true });
  try {
    const fontsDir = path.join(work, 'fonts');
    await fs.promises.mkdir(fontsDir);
    await fs.promises.copyFile(sfntPath, path.join(fontsDir, `font.${sfntExt}`));
    const assFile = path.join(work, 'specimen.ass');
    await fs.promises.writeFile(
      assFile,
      specimenAss({
        assName: n.family,
        bold: weight >= 600,
        italic: n.italic,
        text,
        fontSize,
        width: W,
        height: H,
      }),
      'utf8',
    );
    let stderr = '';
    await atomicOut(thumbPath, async (tmp) => {
      const res = await runFf(
        ctx,
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=0x16181d:s=${W}x${H}:d=1:r=1,format=yuv420p`,
          '-vf',
          `ass=filename=${escapeFilterPath(assFile)}:fontsdir=${escapeFilterPath(fontsDir)},format=yuvj420p`,
          '-frames:v',
          '1',
          '-q:v',
          '3',
          '-f',
          'image2',
          '-update',
          '1',
          tmp,
        ],
        { signal: a.signal, verbosity: 'verbose' },
      );
      stderr = res.stderr;
    });
    if (fellBackToSystemFont(stderr, [n.family, n.fullName])) {
      ctx.log(`[brand-media] libass could not use ${baseName(a.file)}: ${stderr.slice(-400)}`);
      throw new BrandMediaError(
        `'${baseName(a.file)}' cannot be used for captions: the caption renderer refused this font file. Try another file of the same font.`,
      );
    }
  } catch (e) {
    if (e instanceof BrandMediaError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw e;
    ctx.log(`[brand-media] specimen failed: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  } finally {
    await rmQuiet(work);
  }

  return {
    width: null,
    height: null,
    durationSec: null,
    hasAudio: false,
    fps: null,
    loudnessLufs: null,
    font: {
      family: n.typoFamily ?? n.family,
      assName: n.family,
      weight,
      italic: n.italic,
      sfntPath,
      sfntExt,
    },
    usable:
      container === 'woff' || container === 'woff2'
        ? {
            path: sfntPath,
            ext: sfntExt,
            contentType: sfntExt === 'otf' ? 'font/otf' : 'font/ttf',
          }
        : null,
    preview: null,
    thumb: { path: thumbPath },
  };
}
