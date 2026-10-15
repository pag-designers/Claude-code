import fs from 'node:fs/promises';

/**
 * Preparing candidate frames for the vision request.
 *
 * Token cost of an image is about width*height/750, so a 1080x1920 frame is ~2.7K tokens while a
 * 432x768 one is ~440. Policy ("send as-is when small, otherwise downscale to <= 768 px on the long
 * side"):
 *   1. width <= 720 px or long side <= 768 px (read from the JPEG/PNG header, no decoding): sent AS-IS.
 *   2. otherwise downscaled through the injectable `downscale` port - the app wires an ffmpeg/Electron
 *      `nativeImage` implementation; the default below tries Electron's `nativeImage` (main process).
 *   3. if nothing can downscale (e.g. unit tests, plain Node): sent as-is. The API itself caps the
 *      long side at 1568 px, so this only costs tokens, never correctness. Logged once.
 * No image library from node_modules is used: `sharp` is only a transitive optional dependency of
 * Next.js and is not shipped with the app.
 */

export const MAX_LONG_SIDE = 768;
export const AS_IS_WIDTH = 720;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PreparedImage {
  data: Buffer;
  mediaType: ImageMediaType;
  /** Size of the bytes that are sent, when known. */
  width: number | null;
  height: number | null;
  downscaled: boolean;
}

export type DownscalePort = (
  data: Buffer,
  maxLongSide: number,
) => Promise<{ data: Buffer; mediaType: ImageMediaType } | null>;

export function sniffMediaType(b: Buffer): ImageMediaType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (
    b.length > 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Pixel size from the file header (JPEG SOFn / PNG IHDR); null when unknown. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  const type = sniffMediaType(b);
  if (type === 'image/png' && b.length >= 24) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (type === 'image/jpeg') {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1]!;
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        o += 2;
        continue;
      }
      const len = b.readUInt16BE(o + 2);
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSof) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
      o += 2 + len;
    }
  }
  return null;
}

let warnedNoDownscaler = false;

/** Default downscaler: Electron's `nativeImage` when running inside the app's main process. */
export const electronDownscale: DownscalePort = async (data, maxLongSide) => {
  try {
    // Dynamic import: plain Node (unit tests) gets the path string of the binary here, not the API.
    const mod = (await import('electron')) as unknown as {
      nativeImage?: {
        createFromBuffer(b: Buffer): {
          isEmpty(): boolean;
          getSize(): { width: number; height: number };
          resize(o: { width: number; height: number; quality?: string }): {
            toJPEG(q: number): Buffer;
          };
        };
      };
    };
    const ni =
      mod.nativeImage ??
      (mod as { default?: { nativeImage?: typeof mod.nativeImage } }).default?.nativeImage;
    if (!ni || typeof ni.createFromBuffer !== 'function') return null;
    const img = ni.createFromBuffer(data);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const k = maxLongSide / Math.max(width, height);
    if (k >= 1) return null;
    const out = img
      .resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' })
      .toJPEG(80);
    return { data: out, mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
};

export async function prepareImage(
  file: string,
  downscale: DownscalePort,
  log: (m: string) => void,
): Promise<PreparedImage> {
  const data = await fs.readFile(file);
  const mediaType = sniffMediaType(data);
  if (!mediaType) throw new Error(`${file} is not a JPEG, PNG or WebP image.`);
  const size = imageSize(data);
  const small =
    size !== null &&
    (size.width <= AS_IS_WIDTH || Math.max(size.width, size.height) <= MAX_LONG_SIDE);
  if (small) return { data, mediaType, width: size.width, height: size.height, downscaled: false };
  const scaled = await downscale(data, MAX_LONG_SIDE);
  if (scaled) {
    const s = imageSize(scaled.data);
    return {
      data: scaled.data,
      mediaType: scaled.mediaType,
      width: s?.width ?? null,
      height: s?.height ?? null,
      downscaled: true,
    };
  }
  if (!warnedNoDownscaler) {
    warnedNoDownscaler = true;
    log('thumbnails: no image downscaler available; sending frames at their original size');
  }
  return {
    data,
    mediaType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    downscaled: false,
  };
}
