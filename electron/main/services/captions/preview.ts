/**
 * Live preview: a REAL libass render of a style on one background frame (what the style editor shows).
 * One ffmpeg process, one PNG on stdout; the only file written is the ASS (temp dir, always removed).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CaptionStyle } from '@shared/cp2';
import type { Word } from '@shared/pipeline';
import { buildAssDocument } from './ass';

const WORD_SEC = 0.5;
const DEFAULT_TEXT = 'This is how your captions will look';

export interface PreviewArgs {
  ffmpegPath: string;
  fontsDir: string | null;
  style: CaptionStyle;
  text: string;
  activeWord: number;
  width: number;
  height: number;
  backgroundPath: string | null;
  signal?: AbortSignal;
}

/** Escapes a path for use inside an ffmpeg filter argument. */
export function escapeFilterValue(p: string): string {
  return p.replace(/\\/g, '/').replace(/[:',[\];]/g, (c) => `\\${c}`);
}

/** Time (s) inside the active word at which the animation has reached its steady, readable state. */
function sampleOffset(style: CaptionStyle): number {
  if (style.animation === 'karaoke') return 0.3;
  if (style.animation === 'typewriter') return 0.46;
  return 0.42;
}

export function previewWords(text: string): Word[] {
  const tokens = (text.trim() === '' ? DEFAULT_TEXT : text).split(/\s+/).filter(Boolean);
  return tokens.map((w, i) => ({ w, s: i * WORD_SEC, e: (i + 1) * WORD_SEC }));
}

export function buildPreviewAss(
  args: Pick<PreviewArgs, 'style' | 'text' | 'activeWord' | 'width' | 'height'>,
): { ass: string; atSec: number } {
  const words = previewWords(args.text);
  const idx = Math.min(Math.max(0, Math.floor(args.activeWord)), words.length - 1);
  const ass = buildAssDocument({
    words,
    startSec: 0,
    endSec: words.length * WORD_SEC,
    width: args.width,
    height: args.height,
    style: args.style,
  });
  return { ass, atSec: idx * WORD_SEC + sampleOffset(args.style) };
}

function runFfmpeg(ffmpegPath: string, argv: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const child = spawn(ffmpegPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('aborted'));
      else if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg preview failed (${code}): ${err.trim().slice(-400)}`));
    });
  });
}

/** Neutral dark slate -> warm grey vertical gradient (time independent) used when no background is given. */
export function gradientSource(w: number, h: number): string {
  return `nullsrc=s=${w}x${h}:r=1:d=1,format=gbrp,geq=r='35+119*Y/H':g='50+73*Y/H':b='74+16*Y/H'`;
}

export async function renderPreview(args: PreviewArgs): Promise<Buffer> {
  const w = Math.max(16, Math.round(args.width));
  const h = Math.max(16, Math.round(args.height));
  const { ass, atSec } = buildPreviewAss({ ...args, width: w, height: h });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-prev-'));
  try {
    const assPath = path.join(dir, 'p.ass');
    fs.writeFileSync(assPath, ass);
    const useBg = args.backgroundPath !== null && fs.existsSync(args.backgroundPath);
    let assFilter = `ass=filename=${escapeFilterValue(assPath)}`;
    if (args.fontsDir) assFilter += `:fontsdir=${escapeFilterValue(args.fontsDir)}`;
    const shift = `setpts=PTS+${atSec.toFixed(3)}/TB`;
    const input = useBg
      ? ['-i', args.backgroundPath as string]
      : ['-f', 'lavfi', '-i', gradientSource(w, h)];
    const fit = useBg
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,`
      : '';
    return await runFfmpeg(
      args.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-threads',
        '1',
        ...input,
        '-vf',
        `${fit}${shift},${assFilter}`,
        '-frames:v',
        '1',
        '-an',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      args.signal,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
