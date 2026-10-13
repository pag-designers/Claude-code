import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildPreviewAss,
  builtinStyles,
  createCaptionService,
  escapeFilterValue,
  gradientSource,
  resolveStyle,
} from '../../electron/main/services/captions';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const FONTS = path.resolve(__dirname, '../../electron/main/assets/fonts');

interface Png {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel. */
  data: Uint8Array;
}

/** Minimal PNG decoder: 8-bit RGB / RGBA, non-interlaced (what ffmpeg writes). */
function decodePng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8);
      const ct = body[9];
      channels = ct === 6 ? 4 : ct === 2 ? 3 : 0;
      expect(channels, 'colour type').toBeGreaterThan(0);
      expect(body[12]).toBe(0); // not interlaced
    } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= channels ? (line[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      let r = v;
      if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[x] = r & 255;
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) out[(y * width + x) * 3 + k] = line[x * channels + k] ?? 0;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Pixels that differ noticeably, per horizontal band (fraction of the frame height). */
function diffBands(a: Png, b: Png, bands: number): number[] {
  const out = new Array<number>(bands).fill(0);
  for (let y = 0; y < a.height; y++) {
    const band = Math.min(bands - 1, Math.floor((y / a.height) * bands));
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 3;
      const d =
        Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
        Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
        Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
      if (d > 60) out[band] = (out[band] ?? 0) + 1;
    }
  }
  return out;
}

const previewDirs = (): string[] =>
  fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('clipfern-prev-'));

/** The gradient the preview uses when no background is given, rendered without captions. */
function gradientOnly(w: number, h: number): Png {
  const buf = execFileSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      gradientSource(w, h),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return decodePng(buf);
}

describe('captions.preview — real libass render', () => {
  const svc = createCaptionService();
  const base = {
    ffmpegPath: FFMPEG,
    fontsDir: FONTS,
    text: 'This is how your captions will look',
    activeWord: 3,
    width: 360,
    height: 640,
    backgroundPath: null,
  };

  it('returns a PNG of exactly width x height whose text pixels differ from the bare background', async () => {
    const before = previewDirs();
    const bg = gradientOnly(360, 640);
    for (const id of ['clean-pop', 'hormozi-bold', 'caption-bubble', 'neon-glow', 'subtle-serif']) {
      const png = decodePng(await svc.preview({ ...base, style: resolveStyle(id) }));
      expect([png.width, png.height], id).toEqual([360, 640]);
      const bands = diffBands(png, bg, 10);
      const total = bands.reduce((a, b) => a + b, 0);
      expect(total, `${id}: text pixels`).toBeGreaterThan(400);
      // text lives in the 9:16 caption zone: nothing in the top 40 % or the bottom 18 %
      expect(
        bands.slice(0, 4).reduce((a, b) => a + b, 0),
        `${id}: top`,
      ).toBe(0);
      expect(
        bands.slice(8).reduce((a, b) => a + b, 0),
        `${id}: bottom 20 %`,
      ).toBe(0);
    }
    expect(previewDirs()).toEqual(before); // no temp-dir leaks
  });

  it('renders the 540x960 editor size and respects the aspect (1:1, 16:9)', async () => {
    for (const [w, h] of [
      [540, 960],
      [540, 540],
      [640, 360],
    ] as const) {
      const png = decodePng(
        await svc.preview({ ...base, width: w, height: h, style: resolveStyle('clean-pop') }),
      );
      expect([png.width, png.height]).toEqual([w, h]);
      expect(diffBands(png, gradientOnly(w, h), 4).reduce((a, b) => a + b, 0)).toBeGreaterThan(300);
    }
  });

  it('the active word is emphasised: moving it changes the pixels; editing a colour changes them too', async () => {
    const a = decodePng(
      await svc.preview({ ...base, activeWord: 1, style: resolveStyle('clean-pop') }),
    );
    const b = decodePng(
      await svc.preview({ ...base, activeWord: 4, style: resolveStyle('clean-pop') }),
    );
    expect(diffBands(a, b, 1)[0]).toBeGreaterThan(100);
    const style = structuredClone(resolveStyle('clean-pop'));
    style.fill = '#00FF00';
    const c = decodePng(await svc.preview({ ...base, activeWord: 1, style }));
    expect(diffBands(a, c, 1)[0]).toBeGreaterThan(100);
  });

  it('uses a background image when given (and falls back to the gradient when it is missing)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-bg-'));
    try {
      const bgFile = path.join(dir, 'bg.png');
      execFileSync(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=1280x720:d=1',
        '-frames:v',
        '1',
        bgFile,
      ]);
      const png = decodePng(
        await svc.preview({ ...base, backgroundPath: bgFile, style: resolveStyle('hormozi-bold') }),
      );
      expect([png.width, png.height]).toEqual([360, 640]);
      // top-left pixel is the (red) background, not the gradient
      expect(png.data[0]).toBeGreaterThan(200);
      expect(png.data[1]).toBeLessThan(60);
      const miss = decodePng(
        await svc.preview({
          ...base,
          backgroundPath: path.join(dir, 'nope.png'),
          style: resolveStyle('clean-pop'),
        }),
      );
      expect(miss.data[0]).toBeLessThan(120);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every preset renders, and each looks different from every other', async () => {
    const shots = await Promise.all(
      builtinStyles().map(async (s) => ({
        id: s.id,
        png: decodePng(await svc.preview({ ...base, style: s })),
      })),
    );
    for (let i = 0; i < shots.length; i++) {
      for (let j = i + 1; j < shots.length; j++) {
        const d = diffBands(shots[i]!.png, shots[j]!.png, 1)[0] ?? 0;
        expect(d, `${shots[i]?.id} vs ${shots[j]?.id}`).toBeGreaterThan(150);
      }
    }
  }, 60_000);

  it('is fast when warm (< 700 ms) and never leaks temp dirs, also on abort and ffmpeg failure', async () => {
    await svc.preview({ ...base, style: resolveStyle('clean-pop') }); // warm fontconfig
    const before = previewDirs();
    const t0 = performance.now();
    await svc.preview({ ...base, style: resolveStyle('neon-glow') });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(700);

    const ac = new AbortController();
    const p = svc.preview({ ...base, style: resolveStyle('clean-pop'), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    await expect(
      svc.preview({ ...base, ffmpegPath: '/nonexistent/ffmpeg', style: resolveStyle('clean-pop') }),
    ).rejects.toThrow();
    expect(previewDirs()).toEqual(before);
  });

  it('handles empty/odd text and out-of-range active word', async () => {
    for (const text of ['', '   ', 'one', '🔥 emoji', '你好 世界']) {
      const png = decodePng(
        await svc.preview({ ...base, text, activeWord: 99, style: resolveStyle('typewriter') }),
      );
      expect(png.width).toBe(360);
    }
  });

  it('buildPreviewAss samples the steady state inside the active word', () => {
    const { ass, atSec } = buildPreviewAss({
      style: resolveStyle('clean-pop'),
      text: 'a b c d',
      activeWord: 2,
      width: 360,
      height: 640,
    });
    expect(ass).toContain('[Events]');
    expect(atSec).toBeGreaterThan(1.0); // word 2 starts at 1.0 s
    expect(atSec).toBeLessThan(1.5);
  });

  it('escapes filter paths', () => {
    expect(escapeFilterValue('C:\\Users\\me\\a b\\p.ass')).toBe('C\\:/Users/me/a b/p.ass');
    expect(escapeFilterValue("/tmp/it's,[x];y")).toBe("/tmp/it\\'s\\,\\[x\\]\\;y");
  });
});
