/** Node-side helpers for the compositor golden-frame spec: project builders, pixel access, PNG writer, CPU references. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  assetSchema,
  imageItemSchema,
  projectSchema,
  shapeItemSchema,
  subtitleItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
  type Project,
} from '../../../shared/editor';
import { applyColor, type EffectiveColor } from '../../../shared/editor-eval';

export const CW = 360;
export const CH = 640;

type Loose = Record<string, unknown>;

export const asset = (
  id: string,
  w: number,
  h: number,
  kind: 'video' | 'image' = 'image',
  durationSec = 10,
) =>
  assetSchema.parse({
    id,
    kind,
    name: id,
    source: { kind: 'upload', key: id, fileName: `${id}.png` },
    width: w,
    height: h,
    durationSec: kind === 'video' ? durationSec : null,
  });

export const image = (
  id: string,
  assetId: string,
  startSec: number,
  durationSec: number,
  extra: Loose = {},
) => imageItemSchema.parse({ type: 'image', id, assetId, startSec, durationSec, ...extra });

export const video = (
  id: string,
  assetId: string,
  startSec: number,
  durationSec: number,
  extra: Loose = {},
) => videoItemSchema.parse({ type: 'video', id, assetId, startSec, durationSec, ...extra });

export const text = (
  id: string,
  txt: string,
  startSec: number,
  durationSec: number,
  extra: Loose = {},
) => textItemSchema.parse({ type: 'text', id, text: txt, startSec, durationSec, ...extra });

export const shape = (
  id: string,
  kind: string,
  startSec: number,
  durationSec: number,
  extra: Loose = {},
) => shapeItemSchema.parse({ type: 'shape', id, shape: kind, startSec, durationSec, ...extra });

export const subtitle = (
  id: string,
  words: { w: string; s: number; e: number; color?: string | null }[],
  startSec: number,
  durationSec: number,
  extra: Loose = {},
) => subtitleItemSchema.parse({ type: 'subtitle', id, words, startSec, durationSec, ...extra });

export const track = (id: string, kind: string, items: unknown[], extra: Loose = {}) =>
  trackSchema.parse({ id, kind, name: id, items, ...extra });

export function project(tracks: unknown[], assets: unknown[], canvas: Loose = {}): Project {
  return projectSchema.parse({ canvas: { width: CW, height: CH, ...canvas }, tracks, assets });
}

/* ------------------------------------------------------------------ pixels ----------------------- */

export interface Img {
  w: number;
  h: number;
  data: Buffer;
}
export const decode = (r: { w: number; h: number; b64: string }): Img => ({
  w: r.w,
  h: r.h,
  data: Buffer.from(r.b64, 'base64'),
});
export const px = (im: Img, x: number, y: number): [number, number, number, number] => {
  const i = (Math.round(y) * im.w + Math.round(x)) * 4;
  return [
    im.data[i] as number,
    im.data[i + 1] as number,
    im.data[i + 2] as number,
    im.data[i + 3] as number,
  ];
};
export const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < 3; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
};
export const to255 = (c: readonly number[]): [number, number, number] =>
  [c[0] as number, c[1] as number, c[2] as number].map((v) => Math.round(v * 255)) as [
    number,
    number,
    number,
  ];

/* ------------------------------------------------------------------ PNG --------------------------- */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePng(file: string, im: Img): void {
  const raw = Buffer.alloc((im.w * 4 + 1) * im.h);
  for (let y = 0; y < im.h; y++) {
    raw[y * (im.w * 4 + 1)] = 0;
    im.data.copy(raw, y * (im.w * 4 + 1) + 1, y * im.w * 4, (y + 1) * im.w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0);
  ihdr.writeUInt32BE(im.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/* ------------------------------------------------------------------ CPU references ---------------- */

export type RGB = [number, number, number];

/** W3C separable blend of straight colours (0..1), backdrop opaque; mirrors the documented shader formulas. */
export function blendRef(mode: string, cb: RGB, cs: RGB, alpha: number): RGB {
  const f = (b: number, s: number): number => {
    switch (mode) {
      case 'multiply':
        return b * s;
      case 'screen':
        return b + s - b * s;
      case 'overlay':
        return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case 'add':
        return Math.min(1, b + s);
      case 'darken':
        return Math.min(b, s);
      case 'lighten':
        return Math.max(b, s);
      default:
        return s;
    }
  };
  return [0, 1, 2].map((i) => {
    const b = cb[i] as number;
    const s = cs[i] as number;
    return b * (1 - alpha) + alpha * f(b, s);
  }) as RGB;
}

export const colorRef = (rgb255: readonly number[], e: EffectiveColor): RGB =>
  to255(
    applyColor(
      [(rgb255[0] as number) / 255, (rgb255[1] as number) / 255, (rgb255[2] as number) / 255],
      e,
    ),
  );
