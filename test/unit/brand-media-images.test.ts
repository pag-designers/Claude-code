import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodePng,
  decodeWithFfmpeg,
  encodePng,
  fakeRasterizer,
  ff,
  makeService,
  probeJson,
} from './brand-media-helpers';
import { tmpDir } from './helpers';

let dir: string;
let n = 0;
const outDir = (): string => path.join(dir, `out-${n++}`);

beforeAll(() => {
  dir = tmpDir('brand-img-');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

describe('logos and images', () => {
  const svc = makeService();

  it('PNG with alpha: size, JPEG thumbnail <= 480 px composited on a ground, no usable copy', async () => {
    const png = write(
      'alpha.png',
      encodePng(1200, 400, (x) => (x < 600 ? [255, 0, 0, 255] : [0, 0, 255, 0])),
    );
    const progress: [string, number | null][] = [];
    const res = await svc.process({
      kind: 'logo',
      file: png,
      ext: 'png',
      outDir: outDir(),
      onProgress: (s, f) => progress.push([s, f]),
    });
    expect([res.width, res.height]).toEqual([1200, 400]);
    expect(res.usable).toBeNull();
    expect(res.preview).toBeNull();
    expect(res.durationSec).toBeNull();
    expect(res.hasAudio).toBe(false);
    const thumb = res.thumb?.path as string;
    const meta = probeJson(thumb).streams[0] as {
      codec_name: string;
      width: number;
      height: number;
    };
    expect(meta.codec_name).toBe('mjpeg');
    expect([meta.width, meta.height]).toEqual([480, 160]);
    const img = decodeWithFfmpeg(thumb);
    // left half is the logo (red), the transparent right half shows the neutral checker ground (grey, never red/blue)
    const [r, g, b] = img.at(60, 80);
    expect(r).toBeGreaterThan(220);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
    const [gr, gg, gb] = img.at(400, 80);
    expect(Math.abs(gr - gg)).toBeLessThan(8);
    expect(Math.abs(gg - gb)).toBeLessThan(8);
    expect(gr).toBeGreaterThan(60);
    expect(gr).toBeLessThan(160);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual(['Done', 1]);
    for (const [, f] of progress) if (f !== null) expect(f >= 0 && f <= 1).toBe(true);
  });

  it('small images are never upscaled and accept a leading dot / upper-case extension', async () => {
    const png = write(
      'tiny.png',
      encodePng(40, 20, () => [10, 200, 30, 255]),
    );
    const res = await svc.process({ kind: 'image', file: png, ext: '.PNG', outDir: outDir() });
    const meta = probeJson(res.thumb?.path as string).streams[0] as {
      width: number;
      height: number;
    };
    expect([res.width, res.height]).toEqual([40, 20]);
    expect([meta.width, meta.height]).toEqual([40, 20]);
  });

  it('JPEG and WEBP are probed and thumbnailed', async () => {
    const jpg = path.join(dir, 'photo.jpg');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x900', '-frames:v', '1', '-q:v', '2', jpg]);
    const webp = path.join(dir, 'photo.webp');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', webp]);
    const a = await svc.process({ kind: 'image', file: jpg, ext: 'jpg', outDir: outDir() });
    expect([a.width, a.height]).toEqual([1600, 900]);
    expect(probeJson(a.thumb?.path as string).streams[0]).toMatchObject({
      width: 480,
      height: 270,
    });
    const b = await svc.process({ kind: 'logo', file: webp, ext: 'webp', outDir: outDir() });
    expect([b.width, b.height]).toEqual([640, 360]);
    expect(b.usable).toBeNull();
  });

  it('animated GIF -> first-frame PNG as the usable copy', async () => {
    const gif = path.join(dir, 'anim.gif');
    // frame 1 is solid red, later frames blue
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48:d=0.2:r=10',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48:d=0.4:r=10',
      '-filter_complex',
      '[0][1]concat=n=2:v=1:a=0',
      gif,
    ]);
    expect(probeJson(gif).streams[0]?.codec_name).toBe('gif');
    const res = await svc.process({ kind: 'image', file: gif, ext: 'gif', outDir: outDir() });
    expect(res.usable).toMatchObject({ ext: 'png', contentType: 'image/png' });
    const first = decodePng(fs.readFileSync(res.usable?.path as string));
    expect([first.width, first.height]).toEqual([64, 48]);
    const [r, g, b] = first.at(10, 10);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(50);
    expect(b).toBeLessThan(50);
    expect(probeJson(res.usable?.path as string).streams).toHaveLength(1);
    expect(fs.existsSync(res.thumb?.path as string)).toBe(true);
  });

  it('SVG goes through the injected rasteriser (<= 2048 px) and the PNG becomes usable', async () => {
    const ras = fakeRasterizer();
    const s = makeService(ras.fn);
    const svg = write(
      'logo.svg',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"/>',
    );
    const od = outDir();
    const res = await s.process({ kind: 'logo', file: svg, ext: 'svg', outDir: od });
    expect(ras.calls).toHaveLength(1);
    expect(ras.calls[0]).toMatchObject({ svg, maxPx: 2048 });
    expect(res.usable).toEqual({
      path: path.join(od, 'usable.png'),
      ext: 'png',
      contentType: 'image/png',
    });
    expect([res.width, res.height]).toEqual([200, 100]);
    expect(decodePng(fs.readFileSync(res.usable?.path as string)).at(150, 50)[3]).toBe(0);
    expect(res.thumb?.path).toBe(path.join(od, 'thumb.jpg'));
  });

  it('a rasteriser that overshoots the 2048 px cap is clamped, not trusted', async () => {
    const s = makeService(async (_svg, out) => {
      fs.writeFileSync(
        out,
        encodePng(3000, 600, () => [1, 2, 3, 255]),
      );
      return { width: 3000, height: 600 };
    });
    const svg = write('huge.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await s.process({ kind: 'image', file: svg, ext: 'svg', outDir: outDir() });
    expect([res.width, res.height]).toEqual([2048, 410]);
  });

  it('a failing rasteriser gives a readable error', async () => {
    const s = makeService(async () => {
      throw new Error('window crashed');
    });
    const svg = write('bad-render.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(
      s.process({ kind: 'logo', file: svg, ext: 'svg', outDir: outDir() }),
    ).rejects.toThrow("Clipfern could not render 'bad-render.svg'. Is it a valid SVG?");
  });
});

describe('rejections', () => {
  const svc = makeService();
  const run = (file: string, ext: string, kind: 'logo' | 'image' = 'logo') =>
    svc.process({ kind, file, ext, outDir: outDir() });

  it('zero-byte file', async () => {
    await expect(run(write('empty.png', ''), 'png')).rejects.toThrow("'empty.png' is empty");
  });

  it('missing file', async () => {
    await expect(run(path.join(dir, 'nope.png'), 'png')).rejects.toThrow(
      /could not find 'nope\.png'/,
    );
  });

  it('truncated PNG', async () => {
    const full = encodePng(300, 300, (x, y) => [x & 255, y & 255, (x * y) & 255, 255]);
    const f = write('trunc.png', full.subarray(0, Math.floor(full.length * 0.6)));
    await expect(run(f, 'png')).rejects.toThrow(
      "Clipfern could not read 'trunc.png'. Is it a valid PNG?",
    );
  });

  it('truncated JPEG (decoders tolerate it, the structural check does not)', async () => {
    const jpg = path.join(dir, 'full.jpg');
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', '-q:v', '2', jpg]);
    const full = fs.readFileSync(jpg);
    const f = write('trunc.jpg', full.subarray(0, Math.floor(full.length / 2)));
    await expect(run(f, 'jpg', 'image')).rejects.toThrow(
      "Clipfern could not read 'trunc.jpg'. Is it a valid JPEG?",
    );
  });

  it('text file with an image extension', async () => {
    await expect(run(write('notes.png', 'hello world'), 'png')).rejects.toThrow(
      "Clipfern could not read 'notes.png'. Is it a valid PNG?",
    );
  });

  it('PNG header with garbage after it', async () => {
    const f = write(
      'garbage.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(300, 7),
      ]),
    );
    await expect(run(f, 'png')).rejects.toThrow(/could not read 'garbage\.png'/);
  });

  it('an extension this section does not accept', async () => {
    const f = write('x.gif', 'GIF89a');
    await expect(run(f, 'gif', 'logo')).rejects.toThrow(
      /not a supported logo file\. Supported: PNG, SVG, WEBP/,
    );
  });

  it('an .svg that is not SVG text', async () => {
    await expect(run(write('fake.svg', 'just some text'), 'svg', 'image')).rejects.toThrow(
      /Is it a valid SVG\?/,
    );
  });

  it('a mislabelled but intact image is still read by content', async () => {
    const f = write(
      'actually-png.jpg',
      encodePng(30, 30, () => [1, 2, 3, 255]),
    );
    const res = await run(f, 'jpg', 'image');
    expect([res.width, res.height]).toEqual([30, 30]);
  });

  it('images over 100 megapixels are refused before any decoding', async () => {
    // a valid PNG header + IHDR claiming 12000x12000, crafted so ffprobe reads the size
    const big = encodePng(1, 1, () => [0, 0, 0, 255]);
    big.writeUInt32BE(12000, 16);
    big.writeUInt32BE(12000, 20);
    // fix the IHDR CRC so ffprobe accepts the header
    const body = big.subarray(12, 29);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    big.writeUInt32BE((c ^ 0xffffffff) >>> 0, 29);
    await expect(run(write('huge.png', big), 'png')).rejects.toThrow(/12000x12000.*100 megapixels/);
  });
});
