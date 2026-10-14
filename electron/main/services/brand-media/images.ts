/**
 * Logos and images: validation, SVG rasterisation, animated GIF -> first frame, JPEG thumbnail.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SvgRasterizer, ProcessedBrandAsset } from '../../pipeline/contracts4';
import {
  BrandMediaError,
  atomicOut,
  baseName,
  makeThumbJpeg,
  probeFile,
  rmQuiet,
  runFf,
  unreadable,
  type FfCtx,
  type Fraction,
} from './ffutil';

/** Longest side of a rasterised SVG. */
export const SVG_MAX_PX = 2048;
/** Vector art is rendered at least this large so a small icon still makes a crisp watermark. */
const SVG_MIN_RENDER_PX = 1024;
const MAX_PIXELS = 100_000_000;

const LABEL: Record<string, string> = {
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  webp: 'WEBP',
  gif: 'GIF',
  svg: 'SVG',
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readEdges(file: string, n: number): { head: Buffer; tail: Buffer; size: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(n, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(n, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return { head, tail, size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Cheap structural check by CONTENT (not extension) that catches truncation, which decoders often tolerate
 * (a half-downloaded JPEG still "decodes" to a grey bottom). Returns the detected container.
 */
export function sniffImage(
  file: string,
): 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'unknown' | 'truncated' {
  const { head, tail, size } = readEdges(file, 4096);
  if (head.subarray(0, 8).equals(PNG_SIG)) {
    return tail.includes(Buffer.from('IEND')) ? 'png' : 'truncated';
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    // EOI marker near the end (allow a little trailing garbage, some cameras append padding)
    for (let i = tail.length - 2; i >= Math.max(0, tail.length - 2048); i--) {
      if (tail[i] === 0xff && tail[i + 1] === 0xd9) return 'jpeg';
    }
    return 'truncated';
  }
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return head.readUInt32LE(4) + 8 <= size ? 'webp' : 'truncated';
  }
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  // text: an <svg root element within the first 64 KB (after any XML prolog / comments / DOCTYPE)
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(65536, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return /<svg[\s>]/i.test(buf.toString('utf8')) ? 'svg' : 'unknown';
  } finally {
    fs.closeSync(fd);
  }
}

export interface ImageArgs {
  file: string;
  ext: string;
  outDir: string;
  signal?: AbortSignal;
  stage: (name: string, fraction: number | null) => void;
}

export async function processImage(
  ctx: FfCtx,
  rasterizeSvg: SvgRasterizer,
  a: ImageArgs,
): Promise<ProcessedBrandAsset> {
  const what = LABEL[a.ext] ?? a.ext.toUpperCase();
  const kind = sniffImage(a.file);
  if (kind === 'unknown' || kind === 'truncated') throw unreadable(a.file, what);
  // An .svg that is really a bitmap (or the reverse) is still decoded by content, but a "svg" ext needs svg text.
  if (a.ext === 'svg' && kind !== 'svg') throw unreadable(a.file, what);

  let source = a.file;
  let usable: ProcessedBrandAsset['usable'] = null;

  if (kind === 'svg') {
    a.stage('Rendering SVG', null);
    const out = path.join(a.outDir, 'usable.png');
    await rmQuiet(out);
    try {
      await rasterizeSvg(a.file, out, SVG_MAX_PX);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      ctx.log(`[brand-media] svg rasterise failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new BrandMediaError(
        `Clipfern could not render '${baseName(a.file)}'. Is it a valid SVG?`,
      );
    }
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw unreadable(a.file, 'SVG');
    source = out;
    usable = { path: out, ext: 'png', contentType: 'image/png' };
  }

  a.stage('Reading image', null);
  const probed = await probeFile(ctx, source, a.signal);
  const w = probed?.info.width ?? 0;
  const h = probed?.info.height ?? 0;
  if (!probed?.info.hasVideo || w <= 0 || h <= 0) throw unreadable(a.file, what);
  if (w * h > MAX_PIXELS) {
    throw new BrandMediaError(
      `'${baseName(a.file)}' is too large (${w}x${h} px). Use an image under 100 megapixels.`,
    );
  }

  // decode the first frame for real: -xerror turns any decoder error into a failure
  const decodeCheck = (frac: Fraction | undefined): Promise<unknown> =>
    runFf(ctx, ['-xerror', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], {
      signal: a.signal,
      onFraction: frac,
    });
  try {
    await decodeCheck(undefined);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    ctx.log(`[brand-media] decode failed for ${baseName(a.file)}: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  let width = w;
  let height = h;
  if (kind === 'svg') {
    if (Math.max(w, h) > SVG_MAX_PX) {
      // a rasteriser that overshoots the cap is clamped here rather than trusted
      const tmp = path.join(a.outDir, 'usable.clamp.png');
      await atomicOut(tmp, (t) =>
        runFf(
          ctx,
          [
            '-i',
            source,
            '-vf',
            `scale=${SVG_MAX_PX}:${SVG_MAX_PX}:force_original_aspect_ratio=decrease`,
            '-frames:v',
            '1',
            '-f',
            'image2',
            '-update',
            '1',
            t,
          ],
          { signal: a.signal },
        ).then(() => undefined),
      );
      await fs.promises.rename(tmp, source);
      const again = await probeFile(ctx, source, a.signal);
      width = again?.info.width ?? w;
      height = again?.info.height ?? h;
    }
  } else if (kind === 'gif') {
    // GIFs are composited from their first frame (animation is not supported in watermarks/overlays)
    a.stage('Extracting first frame', null);
    const out = path.join(a.outDir, 'usable.png');
    await atomicOut(out, (t) =>
      runFf(
        ctx,
        ['-i', a.file, '-map', '0:v:0', '-frames:v', '1', '-f', 'image2', '-update', '1', t],
        { signal: a.signal },
      ).then(() => undefined),
    );
    usable = { path: out, ext: 'png', contentType: 'image/png' };
    source = out;
  }

  a.stage('Creating thumbnail', null);
  const thumb = path.join(a.outDir, 'thumb.jpg');
  try {
    await makeThumbJpeg(ctx, { input: source, out: thumb, onChecker: true, signal: a.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    ctx.log(`[brand-media] thumbnail failed for ${baseName(a.file)}: ${(e as Error).message}`);
    throw unreadable(a.file, what);
  }

  return {
    width,
    height,
    durationSec: null,
    hasAudio: false,
    fps: null,
    loudnessLufs: null,
    font: null,
    usable,
    preview: null,
    thumb: { path: thumb },
  };
}

/** Where the SVG render lands in tests / callers that want the sizing rule: min(cap, max(intrinsic, 1024)). */
export function svgRenderLongSide(intrinsicLongSide: number, maxPx: number): number {
  return Math.max(1, Math.min(maxPx, Math.max(Math.round(intrinsicLongSide), SVG_MIN_RENDER_PX)));
}
