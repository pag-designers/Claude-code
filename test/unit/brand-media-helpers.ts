/**
 * Shared helpers for the brand-media tests: real ffmpeg on generated lavfi media, a tiny PNG codec, a WOFF1 encoder.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { SvgRasterizer } from '../../electron/main/pipeline/contracts4';
import { createBrandMedia } from '../../electron/main/services/brand-media';

export const FFMPEG = ffmpegStatic as unknown as string;
export const FFPROBE = ffprobeStatic.path;
export const FONTS_DIR = path.resolve(__dirname, '../../electron/main/assets/fonts');

export function ff(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: 'pipe' });
}

export function probeJson(file: string): {
  streams: Record<string, string | number>[];
  format: Record<string, string>;
} {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as ReturnType<typeof probeJson>;
}

/** Independent loudness measurement with the ebur128 filter (not the code under test). */
export function measureEbur(file: string): { lufs: number; truePeak: number } {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const text = r.stderr;
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const tp = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  return { lufs: Number(i?.[1] ?? NaN), truePeak: Number(tp?.[1] ?? NaN) };
}

/* ------------------------------------------------------------------------------------- PNG codec -- */

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export type RGBA = [number, number, number, number];

/** Encodes an 8-bit RGBA PNG; `pixel(x, y)` supplies each pixel. */
export function encodePng(w: number, h: number, pixel: (x: number, y: number) => RGBA): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const p = pixel(x, y);
      raw.set(p, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface Decoded {
  width: number;
  height: number;
  /** tightly packed RGBA */
  rgba: Buffer;
  at(x: number, y: number): RGBA;
}

/** Decodes 8-bit RGB / RGBA non-interlaced PNGs (all filter types). */
export function decodePng(buf: Buffer): Decoded {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9] as number;
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNG');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG colour type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const cur = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= bpp ? (px[y * stride + i - bpp] as number) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= bpp ? (px[(y - 1) * stride + i - bpp] as number) : 0;
      let v = cur;
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + i] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = px[i * bpp] as number;
    rgba[i * 4 + 1] = px[i * bpp + 1] as number;
    rgba[i * 4 + 2] = px[i * bpp + 2] as number;
    rgba[i * 4 + 3] = bpp === 4 ? (px[i * 4 + 3] as number) : 255;
  }
  return {
    width: w,
    height: h,
    rgba,
    at: (x, y) => {
      const k = (y * w + x) * 4;
      return [
        rgba[k] as number,
        rgba[k + 1] as number,
        rgba[k + 2] as number,
        rgba[k + 3] as number,
      ];
    },
  };
}

/** Decodes any image ffmpeg can read to RGBA (JPEG thumbnails, etc.). */
export function decodeWithFfmpeg(file: string): Decoded {
  const info = probeJson(file).streams[0] as { width: number; height: number };
  const out = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { maxBuffer: 1 << 28 },
  );
  const w = info.width;
  return {
    width: w,
    height: info.height,
    rgba: out,
    at: (x, y) => {
      const k = (y * w + x) * 4;
      return [out[k] as number, out[k + 1] as number, out[k + 2] as number, out[k + 3] as number];
    },
  };
}

/* ------------------------------------------------------------------------------------- fonts ----- */

/** Minimal WOFF 1.0 encoder (zlib per table, falls back to raw when it does not shrink). */
export function encodeWoff1(sfnt: Buffer): Buffer {
  const n = sfnt.readUInt16BE(4);
  const flavor = sfnt.readUInt32BE(0);
  const tables: { tag: string; checksum: number; data: Buffer; comp: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const offset = sfnt.readUInt32BE(o + 8);
    const length = sfnt.readUInt32BE(o + 12);
    const data = sfnt.subarray(offset, offset + length);
    const z = zlib.deflateSync(data);
    tables.push({
      tag: sfnt.toString('latin1', o, o + 4),
      checksum: sfnt.readUInt32BE(o + 4),
      data,
      comp: z.length < data.length ? z : data,
    });
  }
  const dirEnd = 44 + n * 20;
  let pos = dirEnd;
  const offsets = tables.map((t) => {
    const at = pos;
    pos += (t.comp.length + 3) & ~3;
    return at;
  });
  const out = Buffer.alloc(pos);
  out.write('wOFF', 0, 'latin1');
  out.writeUInt32BE(flavor, 4);
  out.writeUInt32BE(pos, 8);
  out.writeUInt16BE(n, 12);
  out.writeUInt32BE(sfnt.length, 16);
  tables.forEach((t, i) => {
    const o = 44 + i * 20;
    out.write(t.tag, o, 'latin1');
    out.writeUInt32BE(offsets[i] as number, o + 4);
    out.writeUInt32BE(t.comp.length, o + 8);
    out.writeUInt32BE(t.data.length, o + 12);
    out.writeUInt32BE(t.checksum, o + 16);
    t.comp.copy(out, offsets[i] as number);
  });
  return out;
}

/* ------------------------------------------------------------------------------------- service ---- */

/** A rasteriser stand-in for unit tests: paints a fixed picture and records calls. */
export function fakeRasterizer(): { fn: SvgRasterizer; calls: { svg: string; maxPx: number }[] } {
  const calls: { svg: string; maxPx: number }[] = [];
  const fn: SvgRasterizer = async (svg, out, maxPx) => {
    calls.push({ svg, maxPx });
    const w = 200;
    const h = 100;
    fs.writeFileSync(
      out,
      encodePng(w, h, (x) => (x < 100 ? [255, 0, 0, 255] : [0, 0, 255, 0])),
    );
    return { width: w, height: h };
  };
  return { fn, calls };
}

export function makeService(
  rasterizer: SvgRasterizer = fakeRasterizer().fn,
  log?: (m: string) => void,
) {
  return createBrandMedia({
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    rasterizeSvg: rasterizer,
    log,
  });
}

/** Writes a copy of a shipped font whose family name has been changed (same length), so it is a "new" brand font. */
export function writeRenamedFont(
  srcFile: string,
  from: string,
  to: string,
  destFile: string,
): string {
  if (from.length !== to.length) throw new Error('rename must keep the length');
  const buf = Buffer.from(fs.readFileSync(srcFile));
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (buf.toString('latin1', o, o + 4) !== 'name') continue;
    const off = buf.readUInt32BE(o + 8);
    const len = buf.readUInt32BE(o + 12);
    const region = buf.subarray(off, off + len);
    const swap = (a: Buffer, b: Buffer): void => {
      for (let at = region.indexOf(a); at >= 0; at = region.indexOf(a, at + b.length))
        b.copy(region, at);
    };
    swap(Buffer.from(from, 'latin1'), Buffer.from(to, 'latin1'));
    swap(Buffer.from(from, 'utf16le').swap16(), Buffer.from(to, 'utf16le').swap16());
  }
  fs.writeFileSync(destFile, buf);
  return destFile;
}
