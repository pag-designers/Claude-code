/**
 * Brand media (CP4): turns an uploaded logo / image / video / audio / font file into everything the app needs
 * (probe data, usable raster/sfnt copies, previews, thumbnails, loudness) and extracts brand colours.
 * Pure Node (ffmpeg child processes). The Electron SVG rasteriser is injected; see ./svg-electron.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAND_FORMATS, type BrandAssetKind } from '@shared/brand';
import type {
  BrandMediaService,
  ProcessedBrandAsset,
  SvgRasterizer,
} from '../../pipeline/contracts4';
import { processAudio, processVideo } from './av';
import { extractPalette } from './colors';
import { runProcess } from '../media/proc';
import { BrandMediaError, baseName, rmQuiet, unreadable, type FfCtx } from './ffutil';
import { processFont } from './fonts';
import { processImage, sniffImage } from './images';

export { createFontsHub, type FontsHubOptions } from './fonts-hub';
export { BrandMediaError } from './ffutil';
export { extractPalette } from './colors';
export { sniffFont, woffToSfnt, woff2ToSfnt, sfntTables } from './fonts';
export { SVG_MAX_PX, svgRenderLongSide } from './images';

export interface BrandMediaOptions {
  ffmpegPath: string;
  ffprobePath: string;
  rasterizeSvg: SvgRasterizer;
  log?: (m: string) => void;
}

const COLOR_SAMPLE_PX = 128;

/** Share of the whole file's progress bar each processing step covers. */
const IMAGE_STAGES: Record<string, [number, number]> = {
  'Rendering SVG': [0, 0.3],
  'Reading image': [0.3, 0.4],
  'Extracting first frame': [0.4, 0.6],
  'Creating thumbnail': [0.6, 1],
  Done: [1, 1],
};
const STAGE_RANGES: Record<BrandAssetKind, Record<string, [number, number]>> = {
  logo: IMAGE_STAGES,
  image: IMAGE_STAGES,
  video: {
    'Reading video': [0, 0.05],
    'Measuring loudness': [0.05, 0.3],
    'Creating thumbnail': [0.3, 0.35],
    'Creating preview': [0.35, 1],
    Done: [1, 1],
  },
  audio: {
    'Reading audio': [0, 0.03],
    'Measuring loudness': [0.03, 0.3],
    'Creating preview': [0.3, 0.9],
    'Verifying loudness': [0.9, 1],
    Done: [1, 1],
  },
  font: { 'Reading font': [0, 0.2], 'Rendering specimen': [0.2, 1], Done: [1, 1] },
};

const mb = (n: number): string =>
  n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(0)} GB` : `${Math.round(n / 2 ** 20)} MB`;

export function createBrandMedia(opts: BrandMediaOptions): BrandMediaService {
  const log = opts.log ?? (() => undefined);
  const ctx: FfCtx = { ffmpegPath: opts.ffmpegPath, ffprobePath: opts.ffprobePath, log };

  async function process_(
    args: Parameters<BrandMediaService['process']>[0],
  ): Promise<ProcessedBrandAsset> {
    const { kind, file, outDir, signal } = args;
    const ext = args.ext.replace(/^\./, '').toLowerCase();
    const fmt = BRAND_FORMATS[kind as BrandAssetKind] as
      (typeof BRAND_FORMATS)[BrandAssetKind] | undefined;
    if (!fmt) throw new BrandMediaError(`Unknown brand asset type '${String(kind)}'.`);
    if (!fmt.extensions.includes(ext)) {
      throw new BrandMediaError(
        `'${baseName(file)}' is not a supported ${kind} file. Supported: ${fmt.label}.`,
      );
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      throw new BrandMediaError(
        `Clipfern could not find '${baseName(file)}'. Was it moved or deleted?`,
      );
    }
    if (!st.isFile()) throw unreadable(file, ext.toUpperCase());
    if (st.size === 0) throw new BrandMediaError(`'${baseName(file)}' is empty (0 bytes).`);
    if (st.size > fmt.maxBytes) {
      throw new BrandMediaError(
        `'${baseName(file)}' is too large (${mb(st.size)}). The limit for this section is ${mb(fmt.maxBytes)}.`,
      );
    }
    await fs.promises.mkdir(outDir, { recursive: true });
    // processors report per-step progress; map it onto 0..1 for the whole file and never let it go backwards
    const ranges = STAGE_RANGES[kind as BrandAssetKind];
    let overall = 0;
    const stage = (name: string, fraction: number | null): void => {
      const r = ranges[name] ?? [overall, overall];
      const f = fraction === null ? 0 : Math.min(1, Math.max(0, fraction));
      overall = Math.max(overall, r[0] + (r[1] - r[0]) * f);
      args.onProgress?.(name, name === 'Done' ? 1 : overall);
    };
    const a = { file, ext, outDir, signal, stage };
    let res: ProcessedBrandAsset;
    switch (kind) {
      case 'logo':
      case 'image':
        res = await processImage(ctx, opts.rasterizeSvg, a);
        break;
      case 'video':
        res = await processVideo(ctx, a);
        break;
      case 'audio':
        res = await processAudio(ctx, a);
        break;
      case 'font':
        res = await processFont(ctx, a);
        break;
      default:
        throw new BrandMediaError(`Unknown brand asset type '${String(kind)}'.`);
    }
    stage('Done', 1);
    return res;
  }

  async function extractColors(imagePath: string, count: number): Promise<string[]> {
    const want = Math.max(0, Math.min(32, Math.floor(count)));
    if (want === 0) return [];
    let source = imagePath;
    let tmpDir: string | null = null;
    try {
      if (path.extname(imagePath).toLowerCase() === '.svg' || sniffImage(imagePath) === 'svg') {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipfern-colors-'));
        source = path.join(tmpDir, 'svg.png');
        await opts.rasterizeSvg(imagePath, source, 256);
      }
      const chunks: Buffer[] = [];
      // nearest-neighbour keeps real pixel colours (an averaging scaler would smear a transparent pixel's RGB into the
      // edges); 128 px gives ~16k samples, plenty for a logo.
      const res = await runProcess(
        opts.ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          `scale=${COLOR_SAMPLE_PX}:${COLOR_SAMPLE_PX}:force_original_aspect_ratio=decrease:flags=neighbor,format=rgba`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-',
        ],
        { onStdout: (c) => chunks.push(c) },
      );
      const rgba = Buffer.concat(chunks);
      if (res.code !== 0 || rgba.length < 4) throw unreadable(imagePath, 'image');
      return extractPalette(rgba, want);
    } finally {
      if (tmpDir) await rmQuiet(tmpDir);
    }
  }

  return { process: process_, extractColors };
}
