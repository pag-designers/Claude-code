import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandService, type BrandDeps } from '@main/pipeline/brand';
import type { BrandMediaService, FontsHub, ProcessedBrandAsset } from '@main/pipeline/contracts4';
import { StyleRegistry } from '@main/pipeline/styles';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { keysBrand } from '@shared/brand';
import { FAKE_STYLE, makeServices, tmpDir } from './helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A media stub that derives files from the input like the real service would (content = input name). */
function fakeMedia(over: Partial<Record<string, Partial<ProcessedBrandAsset>>> = {}) {
  const calls: { kind: string; file: string; ext: string }[] = [];
  let failNext: string | null = null;
  const media: BrandMediaService = {
    async process({ kind, file, ext, outDir, onProgress }) {
      calls.push({ kind, file, ext });
      onProgress?.('Probing', 0.2);
      if (failNext) {
        const m = failNext;
        failNext = null;
        throw new Error(m);
      }
      const w = (name: string, body: string) => {
        const p = path.join(outDir, name);
        fs.writeFileSync(p, body);
        return p;
      };
      const base: ProcessedBrandAsset = {
        width: kind === 'font' || kind === 'audio' ? null : 400,
        height: kind === 'font' || kind === 'audio' ? null : 300,
        durationSec: kind === 'video' ? 4 : kind === 'audio' ? 30 : null,
        hasAudio: kind === 'video' || kind === 'audio',
        fps: kind === 'video' ? 30 : null,
        loudnessLufs: kind === 'audio' || kind === 'video' ? -20 : null,
        font:
          kind === 'font'
            ? {
                family: 'Fancy Sans',
                assName: 'Fancy Sans Bold',
                weight: 700,
                italic: false,
                sfntPath: w('font.ttf', 'sfnt'),
                sfntExt: 'ttf',
              }
            : null,
        usable:
          ext === 'svg' ? { path: w('u.png', 'png'), ext: 'png', contentType: 'image/png' } : null,
        preview:
          kind === 'video'
            ? { path: w('p.mp4', 'mp4'), ext: 'mp4', contentType: 'video/mp4' }
            : kind === 'audio'
              ? { path: w('p.m4a', 'm4a'), ext: 'm4a', contentType: 'audio/mp4' }
              : null,
        thumb: kind === 'audio' ? null : { path: w('t.jpg', 'jpg') },
      };
      return { ...base, ...(over[kind] ?? {}) };
    },
    async extractColors() {
      return ['#112233', '#445566'];
    },
  };
  return { media, calls, failWith: (m: string) => (failNext = m) };
}

function fakeFonts() {
  const added = new Map<string, string>();
  const removed: string[] = [];
  const hub: FontsHub = {
    dir: () => null,
    async add(id, p) {
      added.set(id, p);
    },
    async remove(id) {
      removed.push(id);
      added.delete(id);
    },
    async prune(keep) {
      for (const id of [...added.keys()]) if (!keep.includes(id)) added.delete(id);
    },
  };
  return { hub, added, removed };
}

async function makeEnv() {
  const m = await makeServices();
  cleanups.push(m.cleanup);
  const db = m.svc.dbHandle.prisma;
  const storage = new MemoryStorageProvider();
  const fm = fakeMedia();
  const ff = fakeFonts();
  const changed: (string | null)[] = [];
  const progress: { name: string; done: boolean }[] = [];
  const rerendered: string[] = [];
  const cacheDir = path.join(m.dir, 'cache');
  const styles = new StyleRegistry(db, { builtinStyles: () => [FAKE_STYLE] });
  const deps: BrandDeps = {
    db,
    getStorage: () => storage,
    invalidateStorage: () => {},
    cacheDir,
    media: fm.media,
    fonts: ff.hub,
    styles,
    chooseFiles: async () => [],
    rerenderClip: async (id) => {
      rerendered.push(id);
    },
    emit: {
      changed: (k) => changed.push(k),
      progress: (p) => progress.push({ name: p.name, done: p.done }),
    },
    log: () => {},
  };
  const svc = new BrandService(deps);
  const src = tmpDir('brand-src-');
  cleanups.push(async () => fs.rmSync(src, { recursive: true, force: true }));
  const file = (name: string, body = 'x'.repeat(100)) => {
    const p = path.join(src, name);
    fs.writeFileSync(p, body);
    return p;
  };
  return { svc, db, storage, fm, ff, changed, progress, rerendered, file, deps, cacheDir };
}

describe('Brand kits', () => {
  it('the first kit becomes the default; setDefault moves it; deleting the default promotes another', async () => {
    const { svc } = await makeEnv();
    const a = await svc.create('Acme');
    const b = await svc.create('Beta');
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);
    expect(await svc.defaultKitId()).toBe(a.id);
    await svc.setDefault(b.id);
    expect(await svc.defaultKitId()).toBe(b.id);
    await svc.remove(b.id);
    expect(await svc.defaultKitId()).toBe(a.id);
    expect((await svc.listKits()).map((k) => k.name)).toEqual(['Acme']);
  });

  it('update merges spec keys, bumps rev and reports CONFLICT for a stale baseRev', async () => {
    const { svc } = await makeEnv();
    const k = await svc.create('Acme');
    const u = await svc.update(k.id, {
      name: 'Acme 2',
      spec: { colors: [{ id: 'c1', name: 'Blue', hex: '#0044FF', group: 'Primary' }] },
    });
    expect(u.rev).toBe(k.rev + 1);
    expect(u.name).toBe('Acme 2');
    expect(u.spec.colors[0]?.hex).toBe('#0044FF');
    expect(u.spec.watermark.position).toBe('top-right'); // untouched key survives
    await expect(svc.update(k.id, { name: 'x' }, k.rev)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('references must point at this kit’s assets of the right kind', async () => {
    const { svc, file } = await makeEnv();
    const k = await svc.create('Acme');
    const other = await svc.create('Other');
    const { assets } = await svc.addFiles(k.id, 'audio', [file('bed.mp3')]);
    await expect(svc.update(k.id, { spec: { introAssetId: assets[0]!.id } })).rejects.toMatchObject(
      { code: 'VALIDATION' },
    );
    await expect(
      svc.update(other.id, { spec: { musicBed: { ...k.spec.musicBed, assetId: assets[0]!.id } } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const ok = await svc.update(k.id, {
      spec: { musicBed: { ...k.spec.musicBed, assetId: assets[0]!.id } },
    });
    expect(ok.spec.musicBed.assetId).toBe(assets[0]!.id);
  });

  it('listKits reports counts and swatches', async () => {
    const { svc, file } = await makeEnv();
    const k = await svc.create('Acme');
    await svc.addFiles(k.id, 'logo', [file('a.png'), file('b.png')]);
    await svc.update(k.id, {
      spec: {
        colors: ['#111111', '#222222'].map((hex, i) => ({
          id: `c${i}`,
          name: hex,
          hex,
          group: 'P',
        })),
      },
    });
    const [s] = await svc.listKits();
    expect(s?.counts.logo).toBe(2);
    expect(s?.counts.video).toBe(0);
    expect(s?.swatches).toEqual(['#111111', '#222222']);
    expect(s?.logoThumbUrl).toMatch(/^memory:|^http|thumb/);
  });
});

describe('Brand assets', () => {
  it('uploads the original, derived files and a DB row; emits progress; returns viewable assets', async () => {
    const { svc, storage, file, progress, changed } = await makeEnv();
    const k = await svc.create('Acme');
    changed.length = 0;
    const { assets, errors } = await svc.addFiles(k.id, 'video', [file('intro.mp4')]);
    expect(errors).toEqual([]);
    const a = assets[0]!;
    expect(a).toMatchObject({
      kind: 'video',
      ext: 'mp4',
      width: 400,
      durationSec: 4,
      hasAudio: true,
    });
    expect(a.storageKey).toBe(keysBrand.original(k.id, a.id, 'mp4'));
    // the editor convention: the 480p copy sits at `${key}.preview.mp4`
    expect(a.previewKey).toBe(keysBrand.editorPreview(a.storageKey));
    expect(storage.objects.has(a.storageKey)).toBe(true);
    expect(storage.objects.has(a.previewKey!)).toBe(true);
    expect(storage.objects.has(a.thumbKey!)).toBe(true);
    expect(a.url).toBeTruthy();
    expect(progress.some((p) => p.name === 'intro.mp4' && p.done)).toBe(true);
    expect(changed).toContain(k.id);
    const got = await svc.get(k.id);
    expect(got.assets).toHaveLength(1);
  });

  it('SVG keeps the original and adds a usable PNG raster', async () => {
    const { svc, storage, file } = await makeEnv();
    const k = await svc.create('Acme');
    const { assets } = await svc.addFiles(k.id, 'logo', [file('logo.svg', '<svg/>')]);
    const a = assets[0]!;
    expect(a.usableKey).toBe(keysBrand.usable(a.storageKey, 'png'));
    expect(storage.objects.get(a.usableKey!)?.contentType).toBe('image/png');
    expect(storage.objects.get(a.storageKey)?.contentType).toBe('image/svg+xml');
  });

  it('fonts: stored, registered with the fonts hub, listed with the family; removal unregisters', async () => {
    const { svc, ff, file } = await makeEnv();
    const k = await svc.create('Acme');
    const { assets } = await svc.addFiles(k.id, 'font', [file('fancy.woff2')]);
    const a = assets[0]!;
    expect(a.font).toMatchObject({ family: 'Fancy Sans', assName: 'Fancy Sans Bold', weight: 700 });
    expect(a.usableKey).toBe(keysBrand.usable(a.storageKey, 'ttf'));
    expect(ff.added.has(a.id)).toBe(true);
    expect((await svc.fontList()).fonts).toEqual([
      expect.objectContaining({ assetId: a.id, family: 'Fancy Sans', weight: 700, italic: false }),
    ]);
    await svc.deleteAssets([a.id]);
    expect(ff.removed).toContain(a.id);
    expect((await svc.fontList()).fonts).toEqual([]);
  });

  it('rejects wrong-section, unknown, empty and oversized files with a clear message and uploads nothing', async () => {
    const { svc, storage, file } = await makeEnv();
    const k = await svc.create('Acme');
    const big = file('big.png');
    fs.truncateSync(big, 26 * 2 ** 20); // > 25 MB logo limit
    const r = await svc.addFiles(k.id, 'logo', [
      file('song.mp3'),
      file('thing.xyz'),
      file('empty.png', ''),
      big,
      '/nope/missing.png',
    ]);
    expect(r.assets).toEqual([]);
    expect(r.errors.map((e) => e.name)).toEqual([
      'song.mp3',
      'thing.xyz',
      'empty.png',
      'big.png',
      'missing.png',
    ]);
    expect(r.errors[0]!.message).toMatch(/audio/);
    expect(r.errors[1]!.message).toMatch(/not supported/);
    expect(r.errors[2]!.message).toMatch(/empty/);
    expect(r.errors[3]!.message).toMatch(/limit/);
    expect(storage.objects.size).toBe(0);
  });

  it('a processing failure cleans up: no objects, no row, font unregistered, other files still added', async () => {
    const { svc, storage, fm, ff, file } = await makeEnv();
    const k = await svc.create('Acme');
    fm.failWith('Clipfern could not read “bad.png”. Is it a valid PNG?');
    const r = await svc.addFiles(k.id, 'logo', [file('bad.png'), file('good.png')]);
    expect(r.errors).toEqual([{ name: 'bad.png', message: expect.stringContaining('valid PNG') }]);
    expect(r.assets.map((a) => a.name)).toEqual(['good']);
    expect([...storage.objects.keys()].every((x) => !x.includes('bad'))).toBe(true);
    expect(ff.added.size).toBe(0);
  });

  it('deleting an asset clears the kit references to it and removes its objects', async () => {
    const { svc, storage, file } = await makeEnv();
    const k = await svc.create('Acme');
    const { assets } = await svc.addFiles(k.id, 'logo', [file('l.png')]);
    const v = await svc.addFiles(k.id, 'video', [file('i.mp4')]);
    await svc.update(k.id, {
      spec: {
        watermark: { ...k.spec.watermark, assetId: assets[0]!.id },
        introAssetId: v.assets[0]!.id,
      },
    });
    const r = await svc.deleteAssets([assets[0]!.id, v.assets[0]!.id]);
    expect(r.deleted).toBe(2);
    expect(r.clearedRefs.sort()).toEqual(['intro', 'watermark']);
    const after = await svc.getKit(k.id);
    expect(after.spec.watermark.assetId).toBeNull();
    expect(after.spec.introAssetId).toBeNull();
    expect(storage.objects.size).toBe(0);
  });

  it('keeps storage objects an editor project still references', async () => {
    const { svc, storage, db, file } = await makeEnv();
    const k = await svc.create('Acme');
    const { assets } = await svc.addFiles(k.id, 'video', [file('b-roll.mp4')]);
    const a = assets[0]!;
    await db.editorProject.create({
      data: {
        name: 'p',
        data: JSON.stringify({ assets: [{ source: { kind: 'upload', key: a.storageKey } }] }),
      },
    });
    await svc.deleteAssets([a.id]);
    expect(storage.objects.has(a.storageKey)).toBe(true);
  });

  it('renames assets and extracts colours only from logos/images', async () => {
    const { svc, file } = await makeEnv();
    const k = await svc.create('Acme');
    const logo = (await svc.addFiles(k.id, 'logo', [file('l.png')])).assets[0]!;
    const aud = (await svc.addFiles(k.id, 'audio', [file('a.mp3')])).assets[0]!;
    await svc.renameAsset(logo.id, 'Main logo');
    expect((await svc.get(k.id)).assets.find((a) => a.id === logo.id)?.name).toBe('Main logo');
    expect(await svc.extractColors(logo.id, 4)).toEqual(['#112233', '#445566']);
    await expect(svc.extractColors(aud.id, 4)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('duplicating a kit copies assets (own storage keys), remaps references and copies subtitle styles', async () => {
    const { svc, storage, file } = await makeEnv();
    const k = await svc.create('Acme');
    const logo = (await svc.addFiles(k.id, 'logo', [file('l.png')])).assets[0]!;
    const style = await svc.saveStyle(k.id, {
      ...FAKE_STYLE,
      id: 'x',
      name: 'Mine',
      builtin: false,
    });
    await svc.update(k.id, {
      spec: {
        watermark: { ...k.spec.watermark, assetId: logo.id },
        defaults: { ...k.spec.defaults, captionStyleId: style.id },
      },
    });
    const copy = await svc.duplicate(k.id);
    expect(copy.name).toBe('Acme copy');
    expect(copy.isDefault).toBe(false);
    const { assets } = await svc.get(copy.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.id).not.toBe(logo.id);
    expect(assets[0]!.storageKey).toContain(copy.id);
    expect(storage.objects.has(assets[0]!.storageKey)).toBe(true);
    expect(copy.spec.watermark.assetId).toBe(assets[0]!.id);
    const copied = await svc.styles(copy.id);
    expect(copied).toHaveLength(1);
    expect(copy.spec.defaults.captionStyleId).toBe(copied[0]!.id);
    // deleting the original leaves the copy intact
    await svc.remove(k.id);
    expect(storage.objects.has(assets[0]!.storageKey)).toBe(true);
  });
});

describe('Applying a kit', () => {
  async function withClips() {
    const env = await makeEnv();
    const video = await env.db.video.create({
      data: { sourceUrl: 'https://x', title: 'V', status: 'ready' },
    });
    const mk = (status: string) =>
      env.db.clip.create({
        data: { videoId: video.id, title: status, startSec: 0, endSec: 30, status },
      });
    return { ...env, video, rendered: await mk('rendered'), candidate: await mk('candidate') };
  }

  it('sets the override + the kit’s subtitle style and re-renders rendered clips; candidates only remember it', async () => {
    const { svc, db, rendered, candidate, rerendered } = await withClips();
    const k = await svc.create('Acme');
    const style = await svc.saveStyle(k.id, {
      ...FAKE_STYLE,
      id: 'x',
      name: 'Mine',
      builtin: false,
    });
    await svc.update(k.id, {
      spec: { defaults: { ...k.spec.defaults, captionStyleId: style.id } },
    });
    const r = await svc.apply({ kitId: k.id, clipIds: [rendered.id, candidate.id] });
    expect(r).toEqual({ queued: 1, skipped: 1 });
    expect(rerendered).toEqual([rendered.id]);
    const row = await db.clip.findUniqueOrThrow({ where: { id: rendered.id } });
    expect(row.brandKitId).toBe(k.id);
    expect(row.captionStyleId).toBe(style.id);
    expect((await db.clip.findUniqueOrThrow({ where: { id: candidate.id } })).brandKitId).toBe(
      k.id,
    );
  });

  it('"none" strips branding without touching the subtitle style; videoId targets every rendered clip', async () => {
    const { svc, db, video, rendered, rerendered } = await withClips();
    const r = await svc.apply({ kitId: 'none', videoId: video.id });
    expect(r.queued).toBe(1);
    expect(rerendered).toEqual([rendered.id]);
    const row = await db.clip.findUniqueOrThrow({ where: { id: rendered.id } });
    expect(row.brandKitId).toBe('none');
    expect(row.captionStyleId).toBe('clean-pop');
  });

  it('rejects an unknown kit', async () => {
    const { svc, rendered } = await withClips();
    await expect(svc.apply({ kitId: 'nope', clipIds: [rendered.id] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('kitForClip: clip override > run option > default kit; "none" and unknown ids mean no kit', async () => {
    const { svc } = await withClips();
    const a = await svc.create('A');
    const b = await svc.create('B');
    expect((await svc.kitForClip(null, 'default'))?.id).toBe(a.id);
    expect((await svc.kitForClip(null, b.id))?.id).toBe(b.id);
    expect((await svc.kitForClip(b.id, 'none'))?.id).toBe(b.id);
    expect(await svc.kitForClip('none', 'default')).toBeNull();
    expect(await svc.kitForClip(null, 'none')).toBeNull();
    expect(await svc.kitForClip('gone', 'default')).toBeNull();
  });

  it('captionStyleForRun: the kit style applies only while the run keeps the default style', async () => {
    const { svc } = await withClips();
    const k = await svc.create('A');
    await svc.update(k.id, {
      spec: { defaults: { ...k.spec.defaults, captionStyleId: 'karaoke-highlight' } },
    });
    expect(await svc.captionStyleForRun('default', 'clean-pop')).toBe('karaoke-highlight');
    expect(await svc.captionStyleForRun('default', 'hormozi-bold')).toBe('hormozi-bold');
    expect(await svc.captionStyleForRun('none', 'clean-pop')).toBe('clean-pop');
  });

  it('prepare downloads only the pieces the kit has switched on, into the cache (re-used on the next call)', async () => {
    const { svc, file, cacheDir } = await withClips();
    const k = await svc.create('A');
    const logo = (await svc.addFiles(k.id, 'logo', [file('l.png', 'LOGO')])).assets[0]!;
    const intro = (await svc.addFiles(k.id, 'video', [file('i.mp4', 'INTRO')])).assets[0]!;
    const kit = await svc.update(k.id, {
      spec: {
        watermark: { ...k.spec.watermark, assetId: logo.id },
        introAssetId: intro.id,
        defaults: { ...k.spec.defaults, watermarkOn: true, introOn: false },
      },
    });
    const p = await svc.prepare(kit);
    expect(p.intro).toBeNull(); // asset exists but introOn is false
    expect(p.outro).toBeNull();
    expect(p.music).toBeNull();
    expect(fs.readFileSync(p.watermark!.path, 'utf8')).toBe('LOGO');
    expect(p.watermark!.path.startsWith(cacheDir)).toBe(true);
    const again = await svc.prepare(kit);
    expect(again.watermark!.path).toBe(p.watermark!.path);
  });
});
