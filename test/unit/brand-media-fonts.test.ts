import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as wawoff2 from 'wawoff2';
import {
  fellBackToSystemFont,
  pickSpecimen,
  sniffFont,
  woffToSfnt,
} from '../../electron/main/services/brand-media/fonts';
import { readFaces } from '../../electron/main/services/captions/fontmeta';
import {
  FONTS_DIR,
  FFMPEG,
  decodeWithFfmpeg,
  encodeWoff1,
  makeService,
  probeJson,
} from './brand-media-helpers';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers';

let dir: string;
let n = 0;
const outDir = (): string => path.join(dir, `out-${n++}`);
const svc = makeService();
const INTER = '/usr/share/fonts/opentype/inter/Inter-BlackItalic.otf';

beforeAll(() => {
  dir = tmpDir('brand-font-');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const shipped = (name: string): string => path.join(FONTS_DIR, name);

function tablesOf(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 16;
    const off = buf.readUInt32BE(o + 8);
    out.set(buf.toString('latin1', o, o + 4), buf.subarray(off, off + buf.readUInt32BE(o + 12)));
  }
  return out;
}

/** Number of "ink" pixels (bright) in the specimen: proves text was drawn. */
function inkPixels(jpg: string): number {
  const img = decodeWithFfmpeg(jpg);
  let c = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if ((img.rgba[i] as number) > 150) c++;
  return c;
}

describe('plain TTF / OTF', () => {
  it('Poppins ExtraBold: names, weight, specimen thumbnail, sfnt copy', async () => {
    const src = shipped('Poppins-ExtraBold.ttf');
    const od = outDir();
    const res = await svc.process({ kind: 'font', file: src, ext: 'ttf', outDir: od });
    const font = res.font as NonNullable<typeof res.font>;
    expect(font).toMatchObject({
      family: 'Poppins',
      assName: 'Poppins ExtraBold',
      weight: 800,
      italic: false,
      sfntExt: 'ttf',
      sfntPath: path.join(od, 'font.ttf'),
    });
    expect(fs.readFileSync(font.sfntPath).equals(fs.readFileSync(src))).toBe(true);
    expect(res.usable).toBeNull(); // the original is already usable
    expect(res.preview).toBeNull();
    const meta = probeJson((res.thumb as { path: string }).path).streams[0] as Record<
      string,
      number | string
    >;
    expect(meta).toMatchObject({ codec_name: 'mjpeg', width: 480, height: 240 });
    expect(inkPixels((res.thumb as { path: string }).path)).toBeGreaterThan(1500);
  });

  it('different fonts give visibly different specimens (the font really is used)', async () => {
    const a = await svc.process({
      kind: 'font',
      file: shipped('Anton-Regular.ttf'),
      ext: 'ttf',
      outDir: outDir(),
    });
    const b = await svc.process({
      kind: 'font',
      file: shipped('DMSerifDisplay-Regular.ttf'),
      ext: 'ttf',
      outDir: outDir(),
    });
    const ia = decodeWithFfmpeg((a.thumb as { path: string }).path);
    const ib = decodeWithFfmpeg((b.thumb as { path: string }).path);
    let diff = 0;
    for (let i = 0; i < ia.rgba.length; i += 4)
      diff += Math.abs((ia.rgba[i] as number) - (ib.rgba[i] as number));
    expect(diff / (ia.rgba.length / 4)).toBeGreaterThan(4);
  });

  it.skipIf(!fs.existsSync(INTER))('OTF (CFF) with italic + black weight', async () => {
    const res = await svc.process({ kind: 'font', file: INTER, ext: 'otf', outDir: outDir() });
    const font = res.font as NonNullable<typeof res.font>;
    expect(font).toMatchObject({ sfntExt: 'otf', weight: 900, italic: true });
    expect(font.sfntPath.endsWith('font.otf')).toBe(true);
    expect(font.assName.length).toBeGreaterThan(0);
    expect(inkPixels((res.thumb as { path: string }).path)).toBeGreaterThan(1500);
  });

  it('a TrueType file named .otf is stored with its real type', async () => {
    const copy = path.join(dir, 'misnamed.otf');
    fs.copyFileSync(shipped('Anton-Regular.ttf'), copy);
    const res = await svc.process({ kind: 'font', file: copy, ext: 'otf', outDir: outDir() });
    expect(res.font?.sfntExt).toBe('ttf');
  });
});

describe('WOFF / WOFF2 are converted to a real sfnt', () => {
  const sources = ['Poppins-SemiBold.ttf', 'BebasNeue-Regular.ttf'];

  it.each(sources)('WOFF1 (%s) round-trips table for table', async (name) => {
    const sfnt = fs.readFileSync(shipped(name));
    const woff = path.join(dir, `${name}.woff`);
    fs.writeFileSync(woff, encodeWoff1(sfnt));
    expect(sniffFont(fs.readFileSync(woff))).toBe('woff');
    const od = outDir();
    const res = await svc.process({ kind: 'font', file: woff, ext: 'woff', outDir: od });
    const font = res.font as NonNullable<typeof res.font>;
    const rebuilt = fs.readFileSync(font.sfntPath);
    expect(sniffFont(rebuilt)).toBe('sfnt-ttf');
    const before = tablesOf(sfnt);
    const after = tablesOf(rebuilt);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [tag, data] of before) expect(after.get(tag)?.equals(data), tag).toBe(true);
    // same identity as the original
    const orig = readFaces(shipped(name))[0]?.names;
    expect(font.assName).toBe(orig?.family);
    expect(font.weight).toBe(orig?.weight);
    expect(res.usable).toEqual({ path: font.sfntPath, ext: 'ttf', contentType: 'font/ttf' });
    expect(inkPixels((res.thumb as { path: string }).path)).toBeGreaterThan(1000);
  });

  it.each(sources)('WOFF2 (%s) via wawoff2 gives a font libass reads', async (name) => {
    const sfnt = fs.readFileSync(shipped(name));
    const woff2 = path.join(dir, `${name}.woff2`);
    fs.writeFileSync(woff2, Buffer.from(await wawoff2.compress(new Uint8Array(sfnt))));
    expect(sniffFont(fs.readFileSync(woff2))).toBe('woff2');
    expect(fs.statSync(woff2).size).toBeLessThan(sfnt.length);
    const od = outDir();
    const res = await svc.process({ kind: 'font', file: woff2, ext: 'woff2', outDir: od });
    const font = res.font as NonNullable<typeof res.font>;
    expect(font.sfntPath).toBe(path.join(od, 'font.ttf'));
    const orig = readFaces(shipped(name))[0]?.names;
    expect(readFaces(font.sfntPath)[0]?.names).toMatchObject({
      family: orig?.family,
      weight: orig?.weight,
    });
    expect(font.assName).toBe(orig?.family);
    // libass (through ffmpeg) can draw text with the converted file from a fontsdir
    const fd = path.join(od, 'fd');
    fs.mkdirSync(fd);
    fs.copyFileSync(font.sfntPath, path.join(fd, 'x.ttf'));
    const ass = path.join(od, 't.ass');
    fs.writeFileSync(
      ass,
      `[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 120\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: S,${font.assName},60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,S,,0,0,0,,Hamburgefonstiv\n`,
    );
    const r = spawnSync(
      FFMPEG,
      [
        '-hide_banner',
        '-v',
        'verbose',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x120:d=1:r=1',
        '-vf',
        `ass=filename=${ass}:fontsdir=${fd}`,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('fontselect:');
    expect(fellBackToSystemFont(r.stderr, [font.assName])).toBe(false);
    // and it picked the uploaded face, not a system font
    expect(r.stderr).not.toMatch(/fontselect: .* -> \/[^,]*\.(ttf|otf)/);
  });

  it('WOFF with deflated and stored tables, table order scrambled in the directory', () => {
    const sfnt = fs.readFileSync(shipped('Anton-Regular.ttf'));
    const out = woffToSfnt(encodeWoff1(sfnt));
    // header fields of the rebuilt directory are consistent (binary-searchable)
    const num = out.readUInt16BE(4);
    const sr = out.readUInt16BE(6);
    const es = out.readUInt16BE(8);
    expect(sr).toBe(2 ** es * 16);
    expect(out.readUInt16BE(10)).toBe(num * 16 - sr);
    const tags = [...tablesOf(out).keys()];
    expect([...tags].sort()).toEqual(tags);
  });

  it('truncated / corrupt WOFF and WOFF2', async () => {
    const woff = encodeWoff1(fs.readFileSync(shipped('Anton-Regular.ttf')));
    fs.writeFileSync(path.join(dir, 'cut.woff'), woff.subarray(0, Math.floor(woff.length / 2)));
    await expect(
      svc.process({
        kind: 'font',
        file: path.join(dir, 'cut.woff'),
        ext: 'woff',
        outDir: outDir(),
      }),
    ).rejects.toThrow("Clipfern could not read 'cut.woff'. Is it a valid WOFF font?");
    // valid directory, corrupt zlib stream
    const bad = Buffer.from(woff);
    for (
      let i = 44 + 20 * bad.readUInt16BE(12) + 8;
      i < bad.length - 64 && i < 44 + 20 * bad.readUInt16BE(12) + 4000;
      i++
    )
      bad[i] = 0x55;
    fs.writeFileSync(path.join(dir, 'bad.woff'), bad);
    await expect(
      svc.process({
        kind: 'font',
        file: path.join(dir, 'bad.woff'),
        ext: 'woff',
        outDir: outDir(),
      }),
    ).rejects.toThrow(/could not read 'bad\.woff'/);

    const w2 = Buffer.from(
      await wawoff2.compress(new Uint8Array(fs.readFileSync(shipped('Anton-Regular.ttf')))),
    );
    fs.writeFileSync(path.join(dir, 'cut.woff2'), w2.subarray(0, Math.floor(w2.length / 2)));
    await expect(
      svc.process({
        kind: 'font',
        file: path.join(dir, 'cut.woff2'),
        ext: 'woff2',
        outDir: outDir(),
      }),
    ).rejects.toThrow("Clipfern could not read 'cut.woff2'. Is it a valid WOFF2 font?");
  });
});

describe('rejections', () => {
  const run = (file: string, ext: string) =>
    svc.process({ kind: 'font', file, ext, outDir: outDir() });

  it('collections get a polite explanation', async () => {
    const ttc = Buffer.alloc(64);
    ttc.write('ttcf', 0, 'latin1');
    ttc.writeUInt32BE(0x00010000, 4);
    ttc.writeUInt32BE(2, 8);
    fs.writeFileSync(path.join(dir, 'pack.ttf'), ttc);
    await expect(run(path.join(dir, 'pack.ttf'), 'ttf')).rejects.toThrow(
      /font collection.*individual TTF or OTF/,
    );
  });

  it('garbage, text, empty, unsupported extension', async () => {
    fs.writeFileSync(path.join(dir, 'x.ttf'), 'not a font at all, just text');
    await expect(run(path.join(dir, 'x.ttf'), 'ttf')).rejects.toThrow(
      "Clipfern could not read 'x.ttf'. Is it a valid TTF font?",
    );
    fs.writeFileSync(path.join(dir, 'e.otf'), '');
    await expect(run(path.join(dir, 'e.otf'), 'otf')).rejects.toThrow(/is empty/);
    fs.writeFileSync(path.join(dir, 'f.eot'), 'x');
    await expect(run(path.join(dir, 'f.eot'), 'eot')).rejects.toThrow(
      /not a supported font file\. Supported: TTF, OTF, WOFF, WOFF2/,
    );
  });

  it('a truncated TTF (missing tables) is not accepted', async () => {
    const full = fs.readFileSync(shipped('Anton-Regular.ttf'));
    fs.writeFileSync(path.join(dir, 'cut.ttf'), full.subarray(0, 200));
    await expect(run(path.join(dir, 'cut.ttf'), 'ttf')).rejects.toThrow(
      /could not read 'cut\.ttf'/,
    );
  });

  it('a valid sfnt header without glyph tables is rejected', async () => {
    const h = Buffer.alloc(12 + 16);
    h.writeUInt32BE(0x00010000, 0);
    h.writeUInt16BE(1, 4);
    h.write('name', 12, 'latin1');
    fs.writeFileSync(path.join(dir, 'skeleton.ttf'), h);
    await expect(run(path.join(dir, 'skeleton.ttf'), 'ttf')).rejects.toThrow(
      /could not read 'skeleton\.ttf'/,
    );
  });
});

describe('helpers', () => {
  it('libass fallback detection reads fontselect lines', () => {
    const ours = ['Anton', 'Anton Regular'];
    expect(
      fellBackToSystemFont(
        '[Parsed_ass_0 @ 0x1] fontselect: (Anton, 400, 0) -> Anton-Regular, 0, Anton-Regular',
        ours,
      ),
    ).toBe(false);
    expect(
      fellBackToSystemFont(
        '[Parsed_ass_0 @ 0x1] fontselect: (Weird, 400, 0) -> /usr/share/fonts/opentype/inter/Inter-Regular.otf, 0, Inter-Regular',
        ['Weird'],
      ),
    ).toBe(true);
    // a system font with the same PostScript name as the upload is the same font, not a fallback
    expect(
      fellBackToSystemFont(
        'fontselect: (Anton, 400, 0) -> /usr/share/fonts/Anton-Regular.ttf, 0, Anton-Regular',
        ['Anton', 'Anton-Regular'],
      ),
    ).toBe(false);
    expect(fellBackToSystemFont('no font lines here', ours)).toBe(false);
  });

  it('specimen text falls back to a script the font can draw', () => {
    const only = (set: (cp: number) => boolean) => ({
      unitsPerEm: 1000,
      ascent: 1,
      descent: 0.2,
      capHeight: 0.7,
      advance: (cp: number) => (set(cp) ? 0.5 : null),
    });
    expect(pickSpecimen(only(() => true))).toBe('Aa Bb 123');
    expect(
      pickSpecimen(only((cp) => (cp >= 0x400 && cp <= 0x4ff) || (cp >= 0x30 && cp <= 0x39))),
    ).toBe('Аа Бб 123');
    expect(pickSpecimen(null)).toBe('Aa Bb 123');
  });

  it('zlib is the WOFF table codec (sanity)', () => {
    expect(zlib.inflateSync(zlib.deflateSync(Buffer.from('x'))).toString()).toBe('x');
  });
});
