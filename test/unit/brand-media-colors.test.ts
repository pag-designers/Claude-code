import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deltaE, extractPalette, rgbToLab } from '../../electron/main/services/brand-media/colors';
import { encodePng, fakeRasterizer, ff, makeService, type RGBA } from './brand-media-helpers';
import { tmpDir } from './helpers';

let dir: string;
beforeAll(() => {
  dir = tmpDir('brand-colors-');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const hexLab = (h: string) =>
  rgbToLab(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

/** Packs [colour, count] runs into an RGBA buffer. */
function pixels(runs: [RGBA, number][]): Uint8Array {
  const total = runs.reduce((n, r) => n + r[1], 0);
  const buf = new Uint8Array(total * 4);
  let o = 0;
  for (const [c, count] of runs) for (let i = 0; i < count; i++, o += 4) buf.set(c, o);
  return buf;
}

describe('extractPalette (pure)', () => {
  const RED: RGBA = [230, 57, 70, 255];
  const GREEN: RGBA = [42, 157, 143, 255];
  const BLUE: RGBA = [29, 53, 87, 255];

  it('3-colour logo on a transparent background: exact brand hexes, most prominent first', () => {
    const rgba = pixels([
      [[0, 0, 0, 0], 5000], // transparent background must not count (black RGB under alpha 0)
      [RED, 2000],
      [GREEN, 1200],
      [BLUE, 800],
    ]);
    expect(extractPalette(rgba, 5)).toEqual(['#E63946', '#2A9D8F', '#1D3557']);
    expect(extractPalette(rgba, 2)).toEqual(['#E63946', '#2A9D8F']);
    expect(extractPalette(rgba, 1)).toEqual(['#E63946']);
  });

  it('anti-aliasing fringes and noise do not become swatches', () => {
    const fringe: RGBA[] = [
      [136, 55, 78, 255], // red/blue blend
      [136, 105, 115, 255],
      [90, 105, 115, 255],
    ];
    const rgba = pixels([
      [RED, 3000],
      [BLUE, 2000],
      [fringe[0] as RGBA, 12],
      [fringe[1] as RGBA, 9],
      [fringe[2] as RGBA, 14],
    ]);
    expect(extractPalette(rgba, 5)).toEqual(['#E63946', '#1D3557']);
  });

  it('near-duplicates merge into the more prominent one; distinct colours stay distinct', () => {
    const rgba = pixels([
      [[255, 0, 0, 255], 4000],
      [[250, 6, 4, 255], 3000], // ΔE ~ 2 from the red above
      [[0, 0, 255, 255], 3000],
    ]);
    const out = extractPalette(rgba, 3);
    expect(out).toEqual(['#FF0000', '#0000FF']);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(deltaE(hexLab(out[i] as string), hexLab(out[j] as string))).toBeGreaterThanOrEqual(
          12,
        );
  });

  it('is deterministic and independent of pixel order', () => {
    const base = pixels([
      [RED, 700],
      [GREEN, 500],
      [BLUE, 300],
      [[250, 200, 20, 255], 120],
      [[240, 240, 240, 255], 60],
    ]);
    const first = extractPalette(base, 4);
    expect(extractPalette(base, 4)).toEqual(first);
    // reverse the pixel order
    const rev = new Uint8Array(base.length);
    for (let i = 0; i < base.length / 4; i++)
      rev.set(base.subarray(i * 4, i * 4 + 4), base.length - (i + 1) * 4);
    expect(extractPalette(rev, 4)).toEqual(first);
    expect(first).toEqual(['#E63946', '#2A9D8F', '#1D3557', '#FAC814']);
  });

  it('gradients return perceptually distinct representatives, sorted by prominence', () => {
    const w = 128;
    const rgba = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        rgba.set(
          [Math.round((x / (w - 1)) * 255), Math.round((y / (w - 1)) * 255), 128, 255],
          (y * w + x) * 4,
        );
    const out = extractPalette(rgba, 5);
    expect(out.length).toBe(5);
    expect(new Set(out).size).toBe(5);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(deltaE(hexLab(out[i] as string), hexLab(out[j] as string))).toBeGreaterThanOrEqual(
          12,
        );
  });

  it('edge cases: fully transparent, empty, zero count, semi-transparent threshold', () => {
    expect(extractPalette(pixels([[[10, 20, 30, 0], 100]]), 3)).toEqual([]);
    expect(extractPalette(new Uint8Array(0), 3)).toEqual([]);
    expect(extractPalette(pixels([[RED, 10]]), 0)).toEqual([]);
    expect(
      extractPalette(
        pixels([
          [[1, 2, 3, 127], 100],
          [RED, 3],
        ]),
        3,
      ),
    ).toEqual(['#E63946']);
  });
});

describe('extractColors (service, real ffmpeg)', () => {
  const svc = makeService();
  const R: RGBA = [230, 57, 70, 255];
  const G: RGBA = [42, 157, 143, 255];
  const B: RGBA = [29, 53, 87, 255];
  /** 600x400 logo: red disc (anti-aliased by 4x supersampling), a green bar and a blue bar, transparent elsewhere. */
  const logo = (x: number, y: number): RGBA => {
    let rr = 0;
    let n = 0;
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - 150;
        const dy = y + (sy + 0.5) / 4 - 200;
        n++;
        if (dx * dx + dy * dy <= 120 * 120) rr++;
      }
    if (rr > 0) return [R[0], R[1], R[2], Math.round((rr / n) * 255)];
    if (x >= 330 && x < 570 && y >= 90 && y < 190) return G;
    if (x >= 330 && x < 570 && y >= 220 && y < 270) return B;
    return [0, 0, 0, 0];
  };

  it('PNG logo -> its 3 brand colours, prominence order, same on every run', async () => {
    const f = path.join(dir, 'logo.png');
    fs.writeFileSync(f, encodePng(600, 400, logo));
    const out = await svc.extractColors(f, 6);
    expect(out).toEqual(['#E63946', '#2A9D8F', '#1D3557']);
    expect(await svc.extractColors(f, 6)).toEqual(out);
    expect(await svc.extractColors(f, 2)).toEqual(['#E63946', '#2A9D8F']);
    expect(await svc.extractColors(f, 0)).toEqual([]);
  });

  it('a lossy JPEG of the same logo (opaque white background) lands close to the true colours', async () => {
    const png = path.join(dir, 'logo-white.png');
    fs.writeFileSync(
      png,
      encodePng(600, 400, (x, y) => {
        const p = logo(x, y);
        const a = p[3] / 255;
        return [
          Math.round(p[0] * a + 255 * (1 - a)),
          Math.round(p[1] * a + 255 * (1 - a)),
          Math.round(p[2] * a + 255 * (1 - a)),
          255,
        ];
      }),
    );
    const jpg = path.join(dir, 'logo-white.jpg');
    ff(['-i', png, '-q:v', '2', jpg]);
    const out = await svc.extractColors(jpg, 4);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe('#FFFFFF'); // the background IS the most prominent colour of an opaque image
    for (const want of ['#E63946', '#2A9D8F', '#1D3557']) {
      const best = Math.min(...out.map((c) => deltaE(hexLab(c), hexLab(want))));
      expect(best, want).toBeLessThan(8);
    }
  });

  it('an animated GIF is read from its first frame', async () => {
    const gif = path.join(dir, 'a.gif');
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0xE63946:s=64x64:d=0.3:r=10',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x1D3557:s=64x64:d=0.3:r=10',
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none',
      gif,
    ]);
    const out = await svc.extractColors(gif, 3);
    expect(out).toHaveLength(1);
    expect(deltaE(hexLab(out[0] as string), hexLab('#E63946'))).toBeLessThan(6);
  });

  it('SVG goes through the rasteriser (256 px) first', async () => {
    const ras = fakeRasterizer();
    const s = makeService(ras.fn);
    const svg = path.join(dir, 'l.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await s.extractColors(svg, 3)).toEqual(['#FF0000']);
    expect(ras.calls).toEqual([{ svg, maxPx: 256 }]);
  });

  it('unreadable images reject with the standard message', async () => {
    const f = path.join(dir, 'broken.png');
    fs.writeFileSync(f, 'nope');
    await expect(svc.extractColors(f, 3)).rejects.toThrow(
      "Clipfern could not read 'broken.png'. Is it a valid image?",
    );
  });
});
