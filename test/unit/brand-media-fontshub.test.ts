import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFontsHub } from '../../electron/main/services/brand-media';
import { readFaces } from '../../electron/main/services/captions/fontmeta';
import { FontBook } from '../../electron/main/services/captions/fontbook';
import { FONTS_DIR, writeRenamedFont } from './brand-media-helpers';
import { tmpDir } from './helpers';

const SHIPPED_TTF = fs
  .readdirSync(FONTS_DIR)
  .filter((n) => n.endsWith('.ttf'))
  .sort();

let root: string;
let BRAND_A = '';
let BRAND_B = '';
/** stands in for an OTF upload: the hub only cares about the extension */
let BRAND_OTF = '';
let n = 0;
const fresh = (): string => path.join(root, `u${n++}`);
const listMerged = (u: string): string[] =>
  fs
    .readdirSync(path.join(u, 'merged'))
    .filter((f) => /\.(ttf|otf)$/.test(f))
    .sort();

beforeAll(() => {
  root = tmpDir('brand-hub-');
  // brand fonts = shipped fonts under new family names (so the caption FontBook sees them as NEW faces)
  BRAND_A = writeRenamedFont(
    path.join(FONTS_DIR, 'Anton-Regular.ttf'),
    'Anton',
    'Zanto',
    path.join(root, 'Zanto-Regular.ttf'),
  );
  BRAND_B = writeRenamedFont(
    path.join(FONTS_DIR, 'Poppins-Bold.ttf'),
    'Poppins',
    'Zoppins',
    path.join(root, 'Zoppins-Bold.ttf'),
  );
  BRAND_OTF = path.join(root, 'brand.otf');
  fs.copyFileSync(BRAND_A, BRAND_OTF);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('FontsHub', () => {
  it('dir() builds the merged directory from the shipped fonts only (no licence texts), linked or copied', () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    expect(hub.dir()).toBe(path.join(u, 'merged'));
    expect(listMerged(u)).toEqual(SHIPPED_TTF);
    expect(SHIPPED_TTF.length).toBeGreaterThanOrEqual(8);
    for (const f of SHIPPED_TTF) {
      expect(
        fs.readFileSync(path.join(u, 'merged', f)).equals(fs.readFileSync(path.join(FONTS_DIR, f))),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(u, 'merged', 'OFL.txt'))).toBe(false);
    // idempotent: a second hub / second call changes nothing
    const before = fs.statSync(path.join(u, 'merged', SHIPPED_TTF[0] as string)).ino;
    createFontsHub({ shippedDir: FONTS_DIR, userDir: u }).dir();
    expect(fs.statSync(path.join(u, 'merged', SHIPPED_TTF[0] as string)).ino).toBe(before);
  });

  it('add() registers a brand font, is idempotent per id, and tells the caption FontBook the real advances', async () => {
    const u = fresh();
    const book = new FontBook();
    const addDir = vi.spyOn(book, 'addDir');
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u, fontBook: book });
    expect(book.known().some((f) => f.assName === 'Zanto')).toBe(false);

    await hub.add('asset1', BRAND_A, 'ttf');
    expect(addDir).toHaveBeenCalledWith(path.join(u, 'merged'));
    const dest = path.join(u, 'merged', 'asset1.ttf');
    expect(fs.readFileSync(dest).equals(fs.readFileSync(BRAND_A))).toBe(true);
    const face = book.known().find((f) => f.assName === 'Zanto');
    expect(face?.shipped).toBe(false);
    expect(face?.weight).toBe(400);
    // real advance of "A" from the uploaded file's hmtx, not a fallback
    const a = face?.advance(0x41);
    expect(a).not.toBeNull();
    // exactly the advance in the uploaded file's hmtx, not the generic 0.6 em fallback
    const real = readFaces(path.join(FONTS_DIR, 'Anton-Regular.ttf'))[0]
      ?.loadMetrics()
      ?.advance(0x41);
    expect(real).toBeGreaterThan(0);
    expect(a).toBe(real);
    expect(a).not.toBe(0.6);

    const mtime = fs.statSync(dest).mtimeMs;
    await hub.add('asset1', BRAND_A, 'ttf');
    expect(fs.statSync(dest).mtimeMs).toBe(mtime); // unchanged content is not rewritten
    expect(listMerged(u)).toEqual([...SHIPPED_TTF, 'asset1.ttf'].sort());
  });

  it('same id with new content replaces the file; switching ttf/otf leaves exactly one file per id', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    await hub.add('x', BRAND_A, 'ttf');
    await hub.add('x', BRAND_B, 'ttf');
    expect(fs.readFileSync(path.join(u, 'merged', 'x.ttf')).equals(fs.readFileSync(BRAND_B))).toBe(
      true,
    );
    await hub.add('x', BRAND_OTF, 'otf');
    expect(listMerged(u).filter((f) => f.startsWith('x.'))).toEqual(['x.otf']);
  });

  it('remove() deletes only that brand font, is idempotent and never touches shipped fonts', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    await hub.add('a', BRAND_A, 'ttf');
    await hub.add('b', BRAND_B, 'ttf');
    await hub.remove('a');
    await hub.remove('a');
    await hub.remove('never-existed');
    expect(listMerged(u)).toEqual([...SHIPPED_TTF, 'b.ttf'].sort());
    // an id that equals a shipped file's name must not delete the shipped font
    const shippedId = (SHIPPED_TTF[0] as string).replace(/\.ttf$/, '');
    await hub.remove(shippedId);
    expect(listMerged(u)).toContain(SHIPPED_TTF[0]);
    await expect(hub.add(shippedId, BRAND_A, 'ttf')).rejects.toThrow(
      /collides with a bundled font/,
    );
    expect(
      fs
        .readFileSync(path.join(u, 'merged', SHIPPED_TTF[0] as string))
        .equals(fs.readFileSync(path.join(FONTS_DIR, SHIPPED_TTF[0] as string))),
    ).toBe(true);
  });

  it('prune() keeps the listed ids, drops the rest, never drops shipped fonts, cleans crash leftovers', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    await hub.add('keep1', BRAND_A, 'ttf');
    await hub.add('keep2', BRAND_OTF, 'otf');
    await hub.add('gone', BRAND_B, 'ttf');
    fs.writeFileSync(path.join(u, 'merged', 'half.ttf.123.tmp'), 'partial');
    await hub.prune(['keep1', 'keep2', 'unknown-id']);
    await hub.prune(['keep1', 'keep2']);
    expect(listMerged(u)).toEqual([...SHIPPED_TTF, 'keep1.ttf', 'keep2.otf'].sort());
    await hub.prune([]);
    expect(listMerged(u)).toEqual(SHIPPED_TTF);
    // a new hub (restart) removes the leftover temp file
    createFontsHub({ shippedDir: FONTS_DIR, userDir: u }).dir();
    expect(fs.readdirSync(path.join(u, 'merged')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('survives a restart: brand fonts stay, reconciliation prunes what the DB no longer has', async () => {
    const u = fresh();
    const first = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    await first.add('p', BRAND_A, 'ttf');
    await first.add('q', BRAND_B, 'ttf');
    const book = new FontBook();
    const second = createFontsHub({ shippedDir: FONTS_DIR, userDir: u, fontBook: book });
    expect(second.dir()).toBe(path.join(u, 'merged'));
    expect(book.known().some((f) => f.assName === 'Zanto')).toBe(true); // announced at startup
    await second.prune(['p']);
    expect(listMerged(u)).toEqual([...SHIPPED_TTF, 'p.ttf'].sort());
  });

  it('concurrent operations are serialised: many adds of one id, and mixed add/remove/prune storms', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    await Promise.all(Array.from({ length: 12 }, () => hub.add('same', BRAND_A, 'ttf')));
    expect(listMerged(u).filter((f) => f.startsWith('same.'))).toEqual(['same.ttf']);
    expect(
      fs.readFileSync(path.join(u, 'merged', 'same.ttf')).equals(fs.readFileSync(BRAND_A)),
    ).toBe(true);

    const ops: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) ops.push(hub.add(`f${i}`, i % 2 ? BRAND_A : BRAND_B, 'ttf'));
    for (let i = 0; i < 10; i += 2) ops.push(hub.remove(`f${i}`));
    ops.push(hub.prune(['f1', 'f3', 'f5', 'f7', 'f9', 'f2']));
    ops.push(hub.add('late', BRAND_OTF, 'otf'));
    await Promise.all(ops);
    // operations ran in call order: adds f0..f9, removes of even ids, prune keeping odd ids + f2 (already removed),
    // then 'late'. 'same' was not in the keep list so the prune dropped it.
    expect(listMerged(u)).toEqual(
      [...SHIPPED_TTF, 'f1.ttf', 'f3.ttf', 'f5.ttf', 'f7.ttf', 'f9.ttf', 'late.otf'].sort(),
    );
  });

  it('a failing operation (missing source) rejects without breaking the queue', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    const bad = hub.add('ghost', path.join(u, 'does-not-exist.ttf'), 'ttf');
    const good = hub.add('real', BRAND_A, 'ttf');
    await expect(bad).rejects.toThrow();
    await good;
    expect(listMerged(u)).toContain('real.ttf');
    expect(listMerged(u)).not.toContain('ghost.ttf');
    await expect(hub.add('../escape', BRAND_A, 'ttf')).rejects.toThrow(/Invalid font asset id/);
    await expect(hub.add('', BRAND_A, 'ttf')).rejects.toThrow(/Invalid font asset id/);
    await expect(hub.add('ok', BRAND_A, 'woff' as unknown as 'ttf')).rejects.toThrow(
      /Unsupported font type/,
    );
    expect(fs.existsSync(path.join(u, 'escape.ttf'))).toBe(false);
  });

  it('falls back to copying when hard links are impossible (other device)', () => {
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw exdev;
    });
    const u = fresh();
    const hub = createFontsHub({ shippedDir: FONTS_DIR, userDir: u });
    expect(hub.dir()).toBe(path.join(u, 'merged'));
    expect(spy).toHaveBeenCalled();
    expect(listMerged(u)).toEqual(SHIPPED_TTF);
    for (const f of SHIPPED_TTF) {
      const src = path.join(FONTS_DIR, f);
      const dst = path.join(u, 'merged', f);
      expect(fs.statSync(dst).ino).not.toBe(fs.statSync(src).ino);
      expect(fs.readFileSync(dst).equals(fs.readFileSync(src))).toBe(true);
      expect(Math.abs(fs.statSync(dst).mtimeMs - fs.statSync(src).mtimeMs)).toBeLessThan(2);
    }
    // the copy is recognised as up to date next time: no second round of copying
    spy.mockClear();
    const copySpy = vi.spyOn(fs, 'copyFileSync');
    createFontsHub({ shippedDir: FONTS_DIR, userDir: u }).dir();
    expect(copySpy).not.toHaveBeenCalled();
  });

  it('an app update that changes or drops a shipped font is followed, brand fonts are untouched', async () => {
    const shipped = fresh();
    fs.mkdirSync(shipped);
    for (const f of SHIPPED_TTF.slice(0, 3))
      fs.copyFileSync(path.join(FONTS_DIR, f), path.join(shipped, f));
    const u = fresh();
    const hub = createFontsHub({ shippedDir: shipped, userDir: u });
    await hub.add('mine', BRAND_A, 'ttf');
    expect(listMerged(u)).toEqual([...SHIPPED_TTF.slice(0, 3), 'mine.ttf'].sort());

    // update: first font removed, second replaced by different bytes, a new one added
    const [gone, changed] = SHIPPED_TTF as [string, string];
    fs.rmSync(path.join(shipped, gone));
    fs.copyFileSync(path.join(FONTS_DIR, SHIPPED_TTF[5] as string), path.join(shipped, changed));
    fs.copyFileSync(
      path.join(FONTS_DIR, SHIPPED_TTF[6] as string),
      path.join(shipped, SHIPPED_TTF[6] as string),
    );
    const hub2 = createFontsHub({ shippedDir: shipped, userDir: u });
    hub2.dir();
    expect(listMerged(u)).toEqual(
      [...SHIPPED_TTF.slice(1, 3), SHIPPED_TTF[6] as string, 'mine.ttf'].sort(),
    );
    expect(
      fs
        .readFileSync(path.join(u, 'merged', changed))
        .equals(fs.readFileSync(path.join(shipped, changed))),
    ).toBe(true);
    await hub2.prune([]);
    expect(listMerged(u)).toEqual([...SHIPPED_TTF.slice(1, 3), SHIPPED_TTF[6] as string].sort());
  });

  it('no shipped fonts and no brand fonts: dir() is null; the first brand font creates it', async () => {
    const u = fresh();
    const hub = createFontsHub({ shippedDir: null, userDir: u });
    expect(hub.dir()).toBeNull();
    await hub.add('solo', BRAND_A, 'ttf');
    expect(hub.dir()).toBe(path.join(u, 'merged'));
    await hub.remove('solo');
    expect(hub.dir()).toBeNull();
    const missing = createFontsHub({ shippedDir: path.join(u, 'nope'), userDir: fresh() });
    expect(missing.dir()).toBeNull();
  });

  it('a throwing FontBook never breaks registration', async () => {
    const u = fresh();
    const hub = createFontsHub({
      shippedDir: FONTS_DIR,
      userDir: u,
      fontBook: {
        addDir() {
          throw new Error('book exploded');
        },
      },
    });
    await hub.add('z', BRAND_A, 'ttf');
    expect(listMerged(u)).toContain('z.ttf');
  });
});
