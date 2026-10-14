import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { CaptionStyle } from '@shared/cp2';
import {
  BRAND_ASSET_KINDS,
  BRAND_FORMATS,
  brandAssetSchema,
  brandKindsForExt,
  brandKitSpecSchema,
  defaultBrandSpec,
  keysBrand,
  resolveBrandKitId,
  type BrandAsset,
  type BrandAssetKind,
  type BrandAssetView,
  type BrandKit,
  type BrandKitPatch,
  type BrandKitSpec,
  type BrandKitSummary,
} from '@shared/brand';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { StorageProvider } from '../services/storage/provider';
import type { BrandMediaService, FontsHub, ProcessedBrandAsset } from './contracts4';
import type { StyleRegistry } from './styles';
import { parseJson } from './views';

const newId = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** Fields of `BrandAsset` that live in the row's `data` JSON (the rest are columns). */
type AssetData = Omit<BrandAsset, 'id' | 'kitId' | 'kind' | 'name' | 'ext' | 'bytes' | 'createdAt'>;

type AssetRow = {
  id: string;
  kitId: string;
  kind: string;
  name: string;
  ext: string;
  bytes: number;
  data: string;
  createdAt: Date;
};
type KitRow = {
  id: string;
  name: string;
  isDefault: boolean;
  spec: string;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
};

export interface BrandDeps {
  db: Db;
  getStorage(): StorageProvider | null;
  invalidateStorage(): void;
  cacheDir: string;
  media: BrandMediaService;
  fonts: FontsHub;
  styles: StyleRegistry;
  chooseFiles(opts: {
    title: string;
    extensions: { name: string; extensions: string[] }[];
  }): Promise<string[]>;
  /** Re-renders one clip through the pipeline (orchestrator.rerenderClip). */
  rerenderClip(clipId: string): Promise<void>;
  emit: {
    changed(kitId: string | null): void;
    progress(p: {
      kitId: string;
      name: string;
      fraction: number | null;
      stage: string;
      done: boolean;
    }): void;
  };
  log: (m: string) => void;
}

/** Local copies of a kit's pieces, ready for the finisher (watermark logo, intro/outro, music). */
export interface PreparedBrand {
  kit: BrandKit;
  watermark: { asset: BrandAsset; path: string } | null;
  intro: { asset: BrandAsset; path: string } | null;
  outro: { asset: BrandAsset; path: string } | null;
  music: { asset: BrandAsset; path: string } | null;
}

/** Brand Kits (BRIEF §7): kit CRUD, asset upload pipeline, fonts, subtitle styles, applying kits to clips. */
export class BrandService {
  constructor(private readonly d: BrandDeps) {}

  private storage(): StorageProvider {
    const s = this.d.getStorage();
    if (!s)
      throw new AppError('UNAVAILABLE', 'Object storage is not connected (Settings → Storage).');
    return s;
  }

  /* ---------------------------------------------------------------------------- mapping ------ */

  private kitOf(r: KitRow): BrandKit {
    const parsed = brandKitSpecSchema.safeParse(parseJson<unknown>(r.spec, {}));
    return {
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      // A spec that no longer parses (older/newer app) falls back to defaults instead of making the kit unreadable.
      spec: parsed.success ? parsed.data : defaultBrandSpec(),
      rev: r.rev,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    };
  }

  private assetOf(r: AssetRow): BrandAsset | null {
    const data = parseJson<Partial<AssetData> & { storageKey?: string }>(r.data, {});
    const parsed = brandAssetSchema.safeParse({
      ...data,
      id: r.id,
      kitId: r.kitId,
      kind: r.kind,
      name: r.name,
      ext: r.ext,
      bytes: r.bytes,
      createdAt: r.createdAt.getTime(),
    });
    return parsed.success ? parsed.data : null;
  }

  private async view(a: BrandAsset): Promise<BrandAssetView> {
    const s = this.d.getStorage();
    const sign = async (key: string | null): Promise<string | null> => {
      if (!key || !s) return null;
      try {
        return await s.presignGet(key, 3600);
      } catch {
        return null;
      }
    };
    return {
      ...a,
      url: await sign(a.storageKey),
      previewUrl: await sign(a.previewKey),
      thumbUrl: await sign(a.thumbKey),
    };
  }

  /* ----------------------------------------------------------------------------- kits -------- */

  private async getRow(id: string): Promise<KitRow> {
    const r = await this.d.db.brandKit.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', 'That Brand Kit no longer exists.');
    return r;
  }

  async getKit(id: string): Promise<BrandKit> {
    return this.kitOf(await this.getRow(id));
  }

  async listKits(): Promise<BrandKitSummary[]> {
    const rows = await this.d.db.brandKit.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    const assets = (await this.d.db.brandAsset.findMany()).flatMap((r) => this.assetOf(r) ?? []);
    const out: BrandKitSummary[] = [];
    for (const row of rows) {
      const kit = this.kitOf(row);
      const mine = assets.filter((a) => a.kitId === kit.id);
      const counts = Object.fromEntries(BRAND_ASSET_KINDS.map((k) => [k, 0])) as Record<
        BrandAssetKind,
        number
      >;
      for (const a of mine) counts[a.kind] += 1;
      const logo =
        mine.find((a) => a.id === kit.spec.watermark.assetId) ??
        mine.find((a) => a.kind === 'logo');
      out.push({
        id: kit.id,
        name: kit.name,
        isDefault: kit.isDefault,
        updatedAt: kit.updatedAt,
        counts,
        swatches: kit.spec.colors.slice(0, 5).map((c) => c.hex),
        logoThumbUrl: logo ? ((await this.view(logo)).thumbUrl ?? null) : null,
      });
    }
    return out;
  }

  async get(id: string): Promise<{ kit: BrandKit; assets: BrandAssetView[] }> {
    const kit = await this.getKit(id);
    const rows = await this.d.db.brandAsset.findMany({
      where: { kitId: id },
      orderBy: { createdAt: 'asc' },
    });
    const assets = await Promise.all(
      rows.flatMap((r) => this.assetOf(r) ?? []).map((a) => this.view(a)),
    );
    return { kit, assets };
  }

  async defaultKitId(): Promise<string | null> {
    const r = await this.d.db.brandKit.findFirst({ where: { isDefault: true } });
    return r?.id ?? null;
  }

  async create(name: string, copyFrom?: string): Promise<BrandKit> {
    if (copyFrom) return this.duplicate(copyFrom, name);
    const first = (await this.d.db.brandKit.count()) === 0;
    const row = await this.d.db.brandKit.create({
      data: { name: name.trim(), isDefault: first, spec: JSON.stringify(defaultBrandSpec()) },
    });
    this.d.emit.changed(null);
    return this.kitOf(row);
  }

  async update(id: string, patch: BrandKitPatch, baseRev?: number): Promise<BrandKit> {
    const row = await this.getRow(id);
    if (baseRev !== undefined && baseRev !== row.rev)
      throw new AppError(
        'CONFLICT',
        'This Brand Kit was changed somewhere else. Reload it to see the latest version.',
      );
    const cur = this.kitOf(row);
    const spec = brandKitSpecSchema.parse({ ...cur.spec, ...(patch.spec ?? {}) });
    await this.checkRefs(id, spec);
    const next = await this.d.db.brandKit.update({
      where: { id },
      data: {
        name: patch.name?.trim() || undefined,
        spec: JSON.stringify(spec),
        rev: { increment: 1 },
      },
    });
    this.d.emit.changed(id);
    return this.kitOf(next);
  }

  /** The kit's references must point at assets of THIS kit with the right kind (a clear VALIDATION error otherwise). */
  private async checkRefs(kitId: string, spec: BrandKitSpec): Promise<void> {
    const rows = await this.d.db.brandAsset.findMany({ where: { kitId } });
    const byId = new Map(rows.flatMap((r) => this.assetOf(r) ?? []).map((a) => [a.id, a]));
    const must = (id: string | null, kinds: BrandAssetKind[], what: string): void => {
      if (!id) return;
      const a = byId.get(id);
      if (!a || !kinds.includes(a.kind))
        throw new AppError(
          'VALIDATION',
          `${what} must be one of this kit's ${kinds.join(' / ')} files.`,
        );
    };
    must(spec.watermark.assetId, ['logo', 'image'], 'The watermark');
    must(spec.introAssetId, ['video'], 'The intro');
    must(spec.outroAssetId, ['video'], 'The outro');
    must(spec.musicBed.assetId, ['audio'], 'The music bed');
  }

  async duplicate(id: string, name?: string): Promise<BrandKit> {
    const src = await this.getRow(id);
    const kit = this.kitOf(src);
    const created = await this.d.db.brandKit.create({
      data: {
        name: (name ?? `${kit.name} copy`).trim().slice(0, 60),
        spec: JSON.stringify(kit.spec),
      },
    });
    // assets: copy the storage objects so the copy owns its files (deleting one kit never breaks the other)
    const idMap = new Map<string, string>();
    const rows = await this.d.db.brandAsset.findMany({ where: { kitId: id } });
    const storage = this.d.getStorage();
    for (const r of rows) {
      const a = this.assetOf(r);
      if (!a) continue;
      const nid = newId('ba');
      idMap.set(a.id, nid);
      const storageKey = keysBrand.original(created.id, nid, a.ext);
      const extOf = (k: string, fallback: string) => k.split('.').pop() ?? fallback;
      const moved = {
        storageKey,
        usableKey: a.usableKey ? keysBrand.usable(storageKey, extOf(a.usableKey, 'png')) : null,
        previewKey: a.previewKey ? keysBrand.preview(storageKey, extOf(a.previewKey, 'mp4')) : null,
        thumbKey: a.thumbKey ? keysBrand.thumb(created.id, nid) : null,
      };
      if (storage) {
        const pairs: [string | null, string | null][] = [
          [a.storageKey, moved.storageKey],
          [a.usableKey, moved.usableKey],
          [a.previewKey, moved.previewKey],
          [a.thumbKey, moved.thumbKey],
        ];
        for (const [from, to] of pairs) if (from && to) await this.copyObject(storage, from, to);
      }
      const data = { ...parseJson<Record<string, unknown>>(r.data, {}), ...moved };
      await this.d.db.brandAsset.create({
        data: {
          id: nid,
          kitId: created.id,
          kind: r.kind,
          name: r.name,
          ext: r.ext,
          bytes: r.bytes,
          data: JSON.stringify(data),
        },
      });
      // a copied font joins the fonts directory under its own asset id
      if (a.kind === 'font' && storage && moved.usableKey) {
        const local = await this.cacheOf({ ...a, id: nid, usableKey: moved.usableKey, storageKey });
        if (local)
          await this.d.fonts.add(
            nid,
            local,
            (path.extname(local).slice(1) as 'ttf' | 'otf') || 'ttf',
          );
      }
    }
    // spec references follow the copied assets; kit styles are copied too
    const styleMap = await this.d.styles.copyKitStyles(id, created.id);
    const remap = (v: string | null): string | null => (v ? (idMap.get(v) ?? null) : null);
    const spec: BrandKitSpec = {
      ...kit.spec,
      watermark: { ...kit.spec.watermark, assetId: remap(kit.spec.watermark.assetId) },
      introAssetId: remap(kit.spec.introAssetId),
      outroAssetId: remap(kit.spec.outroAssetId),
      musicBed: { ...kit.spec.musicBed, assetId: remap(kit.spec.musicBed.assetId) },
      defaults: {
        ...kit.spec.defaults,
        captionStyleId:
          styleMap.get(kit.spec.defaults.captionStyleId) ?? kit.spec.defaults.captionStyleId,
      },
    };
    const row = await this.d.db.brandKit.update({
      where: { id: created.id },
      data: { spec: JSON.stringify(spec) },
    });
    this.d.emit.changed(null);
    return this.kitOf(row);
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id);
    const rows = await this.d.db.brandAsset.findMany({ where: { kitId: id } });
    await this.deleteAssetRows(rows, { clearRefs: false });
    await this.d.styles.deleteKitStyles(id);
    // clips that pointed at it inherit again (their next render has no kit unless the run default applies)
    await this.d.db.clip.updateMany({ where: { brandKitId: id }, data: { brandKitId: null } });
    const wasDefault = (await this.d.db.brandKit.findUnique({ where: { id } }))?.isDefault ?? false;
    await this.d.db.brandKit.delete({ where: { id } });
    if (wasDefault) {
      const next = await this.d.db.brandKit.findFirst({ orderBy: { createdAt: 'asc' } });
      if (next)
        await this.d.db.brandKit.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    this.d.emit.changed(null);
  }

  async setDefault(id: string): Promise<void> {
    await this.getRow(id);
    await this.d.db.brandKit.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    await this.d.db.brandKit.update({ where: { id }, data: { isDefault: true } });
    this.d.emit.changed(null);
  }

  /* ---------------------------------------------------------------------------- assets ------- */

  async browse(kitId: string, kind: BrandAssetKind) {
    await this.getRow(kitId);
    const fmt = BRAND_FORMATS[kind];
    const paths = await this.d.chooseFiles({
      title: 'Choose files for your Brand Kit',
      extensions: [{ name: fmt.label, extensions: [...fmt.extensions] }],
    });
    if (paths.length === 0) return { assets: [], errors: [], canceled: true };
    return { ...(await this.addFiles(kitId, kind, paths)), canceled: false };
  }

  async addFiles(kitId: string, kind: BrandAssetKind, paths: string[]) {
    await this.getRow(kitId);
    const storage = this.storage();
    const assets: BrandAssetView[] = [];
    const errors: { name: string; message: string }[] = [];
    for (const file of paths) {
      const name = path.basename(file);
      const tick = (stage: string, fraction: number | null, done = false) =>
        this.d.emit.progress({ kitId, name, stage, fraction, done });
      try {
        const asset = await this.addOne(storage, kitId, kind, file, tick);
        assets.push(await this.view(asset));
        tick('Done', 1, true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.d.log(`brand: could not add ${name}: ${message}`);
        errors.push({ name, message });
        tick(message, null, true);
      }
    }
    this.d.invalidateStorage();
    if (assets.length) this.d.emit.changed(kitId);
    return { assets, errors };
  }

  private async addOne(
    storage: StorageProvider,
    kitId: string,
    kind: BrandAssetKind,
    file: string,
    tick: (stage: string, fraction: number | null) => void,
  ): Promise<BrandAsset> {
    const name = path.basename(file);
    const ext = path.extname(file).slice(1).toLowerCase();
    const fmt = BRAND_FORMATS[kind];
    if (!brandKindsForExt(ext).includes(kind)) {
      const where = brandKindsForExt(ext);
      throw new AppError(
        'VALIDATION',
        where.length
          ? `“${name}” is a .${ext} file; add it to ${where.map((k) => k).join(' / ')} instead. This section takes ${fmt.label}.`
          : `“${name}” is not supported here. This section takes ${fmt.label}.`,
      );
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      throw new AppError('NOT_FOUND', `Clipfern could not open “${name}”.`);
    }
    if (size === 0) throw new AppError('VALIDATION', `“${name}” is empty.`);
    if (size > fmt.maxBytes)
      throw new AppError(
        'VALIDATION',
        `“${name}” is ${(size / 2 ** 20).toFixed(0)} MB; the limit here is ${(fmt.maxBytes / 2 ** 20).toFixed(0)} MB.`,
      );

    const id = newId('ba');
    const tmp = path.join(this.d.cacheDir, 'brand-tmp', id);
    fs.mkdirSync(tmp, { recursive: true });
    const uploaded: string[] = [];
    try {
      tick('Reading file', null);
      const p: ProcessedBrandAsset = await this.d.media.process({
        kind,
        file,
        ext,
        outDir: tmp,
        onProgress: (stage, fraction) => tick(stage, fraction),
      });
      const originalKey = keysBrand.original(kitId, id, ext);
      const put = async (key: string, f: string, contentType: string): Promise<string> => {
        await storage.putFile(key, f, { contentType });
        uploaded.push(key);
        return key;
      };
      tick('Uploading', 0.1);
      await put(originalKey, file, CONTENT_TYPES[ext] ?? 'application/octet-stream');
      let usableKey: string | null = null;
      if (p.font) {
        usableKey = await put(
          keysBrand.usable(originalKey, p.font.sfntExt),
          p.font.sfntPath,
          CONTENT_TYPES[p.font.sfntExt] ?? 'font/ttf',
        );
      } else if (p.usable) {
        usableKey = await put(
          keysBrand.usable(originalKey, p.usable.ext),
          p.usable.path,
          p.usable.contentType,
        );
      }
      const previewKey = p.preview
        ? await put(
            keysBrand.preview(originalKey, p.preview.ext),
            p.preview.path,
            p.preview.contentType,
          )
        : null;
      const thumbKey = p.thumb
        ? await put(keysBrand.thumb(kitId, id), p.thumb.path, 'image/jpeg')
        : null;

      if (p.font) await this.d.fonts.add(id, await this.keepFont(id, p.font), p.font.sfntExt);

      const data: AssetData & { storageKey: string } = {
        storageKey: originalKey,
        usableKey,
        previewKey,
        thumbKey,
        width: p.width,
        height: p.height,
        durationSec: p.durationSec,
        hasAudio: p.hasAudio,
        fps: p.fps,
        loudnessLufs: p.loudnessLufs,
        font: p.font
          ? {
              family: p.font.family,
              assName: p.font.assName,
              weight: p.font.weight,
              italic: p.font.italic,
              file: `${id}.${p.font.sfntExt}`,
            }
          : null,
        credit: null,
      };
      const row = await this.d.db.brandAsset.create({
        data: {
          id,
          kitId,
          kind,
          name: path.basename(file, path.extname(file)),
          ext,
          bytes: size,
          data: JSON.stringify(data),
        },
      });
      const asset = this.assetOf(row);
      if (!asset) throw new AppError('FAILED', `Clipfern could not store “${name}”.`);
      return asset;
    } catch (e) {
      if (uploaded.length) await storage.delete(uploaded).catch(() => undefined);
      await this.d.fonts.remove(id).catch(() => undefined);
      throw e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The processed sfnt lives in the temp dir that is deleted afterwards: give the fonts hub a stable copy. */
  private async keepFont(id: string, font: { sfntPath: string; sfntExt: string }): Promise<string> {
    const dir = path.join(this.d.cacheDir, 'brand-fonts');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${id}.${font.sfntExt}`);
    fs.copyFileSync(font.sfntPath, dest);
    return dest;
  }

  async renameAsset(id: string, name: string): Promise<void> {
    const r = await this.d.db.brandAsset.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', 'That file no longer exists.');
    await this.d.db.brandAsset.update({ where: { id }, data: { name: name.trim() } });
    this.d.emit.changed(r.kitId);
  }

  async deleteAssets(ids: string[]): Promise<{ deleted: number; clearedRefs: string[] }> {
    const rows = await this.d.db.brandAsset.findMany({ where: { id: { in: ids } } });
    const res = await this.deleteAssetRows(rows, { clearRefs: true });
    for (const k of new Set(rows.map((r) => r.kitId))) this.d.emit.changed(k);
    return res;
  }

  private async deleteAssetRows(
    rows: AssetRow[],
    opts: { clearRefs: boolean },
  ): Promise<{ deleted: number; clearedRefs: string[] }> {
    const cleared: string[] = [];
    const kitIds = [...new Set(rows.map((r) => r.kitId))];
    if (opts.clearRefs) {
      for (const kitId of kitIds) {
        const kitRow = await this.d.db.brandKit.findUnique({ where: { id: kitId } });
        if (!kitRow) continue;
        const gone = new Set(rows.filter((r) => r.kitId === kitId).map((r) => r.id));
        const kit = this.kitOf(kitRow);
        const spec = structuredClone(kit.spec);
        if (spec.watermark.assetId && gone.has(spec.watermark.assetId)) {
          spec.watermark.assetId = null;
          cleared.push('watermark');
        }
        if (spec.introAssetId && gone.has(spec.introAssetId)) {
          spec.introAssetId = null;
          cleared.push('intro');
        }
        if (spec.outroAssetId && gone.has(spec.outroAssetId)) {
          spec.outroAssetId = null;
          cleared.push('outro');
        }
        if (spec.musicBed.assetId && gone.has(spec.musicBed.assetId)) {
          spec.musicBed.assetId = null;
          cleared.push('music bed');
        }
        if (cleared.length)
          await this.d.db.brandKit.update({
            where: { id: kitId },
            data: { spec: JSON.stringify(spec), rev: { increment: 1 } },
          });
      }
    }
    const storage = this.d.getStorage();
    const referenced = await this.referencedKeys();
    for (const r of rows) {
      const a = this.assetOf(r);
      if (a?.kind === 'font') await this.d.fonts.remove(a.id).catch(() => undefined);
      if (a && storage) {
        // an editor project may still use the file (its asset points at the storage key): keep the object then
        const keys = [a.storageKey, a.usableKey, a.previewKey, a.thumbKey].filter(
          (k): k is string =>
            Boolean(k) && !referenced.has(k as string) && !referenced.has(a.storageKey),
        );
        if (keys.length)
          await storage
            .delete(keys)
            .catch((e) => this.d.log(`brand: storage cleanup failed: ${String(e)}`));
      }
      await this.d.db.brandAsset.delete({ where: { id: r.id } });
    }
    this.d.invalidateStorage();
    return { deleted: rows.length, clearedRefs: [...new Set(cleared)] };
  }

  /** Storage keys referenced by editor project JSON (cheap substring scan of `brand/` keys). */
  private async referencedKeys(): Promise<Set<string>> {
    const out = new Set<string>();
    const rows = await this.d.db.editorProject.findMany({ select: { data: true } });
    const re = /"key":"(brand\/[^"]+)"/g;
    for (const r of rows) for (const m of r.data.matchAll(re)) out.add(m[1]!);
    return out;
  }

  async extractColors(assetId: string, count: number): Promise<string[]> {
    const r = await this.d.db.brandAsset.findUnique({ where: { id: assetId } });
    const a = r ? this.assetOf(r) : null;
    if (!a) throw new AppError('NOT_FOUND', 'That file no longer exists.');
    if (a.kind !== 'logo' && a.kind !== 'image')
      throw new AppError('VALIDATION', 'Colours can be extracted from logos and images.');
    const local = await this.cacheOf(a);
    if (!local) throw new AppError('UNAVAILABLE', 'Clipfern could not download that file.');
    return this.d.media.extractColors(local, count);
  }

  /* ------------------------------------------------------------------------------ fonts ------ */

  async fontList() {
    const storage = this.d.getStorage();
    const rows = await this.d.db.brandAsset.findMany({ where: { kind: 'font' } });
    const out: {
      assetId: string;
      kitId: string;
      family: string;
      weight: number;
      italic: boolean;
      url: string;
    }[] = [];
    if (!storage) return { fonts: out };
    for (const r of rows) {
      const a = this.assetOf(r);
      if (!a?.font) continue;
      // the ORIGINAL file: Chromium loads ttf/otf/woff/woff2 alike
      out.push({
        assetId: a.id,
        kitId: a.kitId,
        family: a.font.family,
        weight: a.font.weight,
        italic: a.font.italic,
        url: await storage.presignGet(a.storageKey, 3600),
      });
    }
    return { fonts: out };
  }

  /** On start: make sure every brand font is in the fonts directory (re-downloading after a data wipe), prune the rest. */
  async reconcileOnStart(): Promise<void> {
    const rows = await this.d.db.brandAsset.findMany({ where: { kind: 'font' } });
    const fonts = rows.flatMap((r) => this.assetOf(r) ?? []).filter((a) => a.font);
    await this.d.fonts.prune(fonts.map((a) => a.id));
    for (const a of fonts) {
      try {
        const local = await this.cacheOf(a);
        if (local)
          await this.d.fonts.add(a.id, local, path.extname(local) === '.otf' ? 'otf' : 'ttf');
      } catch (e) {
        this.d.log(`brand: font ${a.name} could not be registered: ${String(e)}`);
      }
    }
  }

  /* ------------------------------------------------------------------- subtitle styles -------- */

  styles(kitId: string): Promise<CaptionStyle[]> {
    return this.d.styles.listForKit(kitId);
  }

  async saveStyle(kitId: string, style: CaptionStyle): Promise<CaptionStyle> {
    await this.getRow(kitId);
    const saved = await this.d.styles.saveForKit(kitId, style);
    this.d.emit.changed(kitId);
    return saved;
  }

  /* ------------------------------------------------------------------ applying to clips ------- */

  /** Sets the clip override and re-renders. `kitId`: kit id | 'none' (strip branding) | null (inherit). */
  async apply(args: {
    kitId: string | null;
    clipIds?: string[];
    videoId?: string;
  }): Promise<{ queued: number; skipped: number }> {
    // applying a kit also adopts its default subtitle style; 'none'/null leave the clip's style alone
    const kit = args.kitId && args.kitId !== 'none' ? await this.getKit(args.kitId) : null;
    if (args.kitId && args.kitId !== 'none' && !kit)
      throw new AppError('NOT_FOUND', 'That Brand Kit no longer exists.');
    const styleData = kit ? { captionStyleId: kit.spec.defaults.captionStyleId } : {};
    const clips = await this.d.db.clip.findMany({
      where: args.clipIds?.length
        ? { id: { in: args.clipIds } }
        : args.videoId
          ? { videoId: args.videoId, status: 'rendered' }
          : { id: '__none__' },
      select: { id: true, status: true },
    });
    let queued = 0;
    let skipped = 0;
    for (const c of clips) {
      if (c.status === 'candidate' || c.status === 'queued' || c.status === 'rendering') {
        // not rendered yet (or already rendering): it remembers the choice and a queued render picks it up
        await this.d.db.clip.update({
          where: { id: c.id },
          data: { brandKitId: args.kitId, ...styleData },
        });
        skipped += 1;
        continue;
      }
      await this.d.db.clip.update({
        where: { id: c.id },
        data: { brandKitId: args.kitId, ...styleData },
      });
      try {
        await this.d.rerenderClip(c.id);
        queued += 1;
      } catch (e) {
        this.d.log(`brand: re-render of ${c.id} not queued: ${String(e)}`);
        skipped += 1;
      }
    }
    return { queued, skipped };
  }

  /* ------------------------------------------------------------------- clip render support ----- */

  /**
   * The kit a clip renders with, or null. `optionsValue` = the video's `PipelineOptions.brandKitId`.
   * A kit id that no longer exists reads as "no kit".
   */
  async kitForClip(
    clipValue: string | null | undefined,
    optionsValue: string | null | undefined,
  ): Promise<BrandKit | null> {
    const id = resolveBrandKitId(clipValue, optionsValue, await this.defaultKitId());
    if (!id) return null;
    const r = await this.d.db.brandKit.findUnique({ where: { id } });
    return r ? this.kitOf(r) : null;
  }

  /**
   * Subtitle style new clips of a run should use: the kit's default style, but only while the run itself asks for the
   * built-in default ('clean-pop'), so an explicit choice in the start options always wins.
   */
  async captionStyleForRun(
    optionsValue: string | null | undefined,
    runStyleId: string,
  ): Promise<string> {
    if (runStyleId !== 'clean-pop') return runStyleId;
    const kit = await this.kitForClip(null, optionsValue);
    return kit?.spec.defaults.captionStyleId ?? runStyleId;
  }

  /** Local copies of the pieces the kit's defaults switch on (downloaded once into the cache, then reused). */
  async prepare(kit: BrandKit): Promise<PreparedBrand> {
    const s = kit.spec;
    const find = async (id: string | null): Promise<BrandAsset | null> => {
      if (!id) return null;
      const r = await this.d.db.brandAsset.findFirst({ where: { id, kitId: kit.id } });
      return r ? this.assetOf(r) : null;
    };
    const local = async (id: string | null, on: boolean) => {
      if (!on) return null;
      const asset = await find(id);
      if (!asset) return null;
      const p = await this.cacheOf(asset);
      return p ? { asset, path: p } : null;
    };
    return {
      kit,
      watermark: await local(s.watermark.assetId, s.defaults.watermarkOn),
      intro: await local(s.introAssetId, s.defaults.introOn),
      outro: await local(s.outroAssetId, s.defaults.outroOn),
      music: await local(s.musicBed.assetId, s.defaults.musicOn),
    };
  }

  /** Local file for compositing an asset (usable copy when there is one, else the original). Cached by asset id. */
  async cacheOf(a: BrandAsset): Promise<string | null> {
    const key = a.usableKey ?? a.storageKey;
    const storage = this.d.getStorage();
    if (!storage) return null;
    const dir = path.join(this.d.cacheDir, 'brand');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${a.id}${path.extname(key) || `.${a.ext}`}`);
    const head = await storage.head(key).catch(() => null);
    if (!head) return null;
    if (fs.existsSync(dest) && fs.statSync(dest).size === head.size) return dest;
    await this.download(storage, key, dest);
    return dest;
  }

  private async download(storage: StorageProvider, key: string, dest: string): Promise<void> {
    const tmp = `${dest}.${process.pid}.part`;
    try {
      const stream = await storage.getStream(key);
      await streamPipeline(stream, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private async copyObject(storage: StorageProvider, from: string, to: string): Promise<void> {
    const tmp = path.join(this.d.cacheDir, 'brand-tmp', `copy-${randomBytes(4).toString('hex')}`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      await this.download(storage, from, tmp);
      const head = await storage.head(from).catch(() => null);
      await storage.putFile(to, tmp, head?.contentType ? { contentType: head.contentType } : {});
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** Asset rows of a kit as domain objects (used by the editor integration). */
  async assetsOf(kitId: string): Promise<BrandAsset[]> {
    const rows = await this.d.db.brandAsset.findMany({ where: { kitId } });
    return rows.flatMap((r) => this.assetOf(r) ?? []);
  }

  async assetById(id: string): Promise<BrandAsset | null> {
    const r = await this.d.db.brandAsset.findUnique({ where: { id } });
    return r ? this.assetOf(r) : null;
  }

  /** Creates the DB row + storage objects for a stock clip imported into a kit (credit kept). */
  async addDownloadedVideo(
    kitId: string,
    args: {
      file: string;
      name: string;
      credit: { source: string; author: string | null; url: string | null };
    },
  ): Promise<BrandAssetView> {
    await this.getRow(kitId);
    this.storage();
    const tmpName = path.join(this.d.cacheDir, 'brand-tmp', `${newId('dl')}.mp4`);
    fs.mkdirSync(path.dirname(tmpName), { recursive: true });
    try {
      fs.copyFileSync(args.file, tmpName);
      const { assets, errors } = await this.addFiles(kitId, 'video', [tmpName]);
      const a = assets[0];
      if (!a) throw new AppError('FAILED', errors[0]?.message ?? 'The clip could not be added.');
      const row = await this.d.db.brandAsset.findUniqueOrThrow({ where: { id: a.id } });
      const data = parseJson<Record<string, unknown>>(row.data, {});
      await this.d.db.brandAsset.update({
        where: { id: a.id },
        data: {
          name: args.name.slice(0, 120),
          data: JSON.stringify({ ...data, credit: args.credit }),
        },
      });
      this.d.emit.changed(kitId);
      const fresh = this.assetOf(
        await this.d.db.brandAsset.findUniqueOrThrow({ where: { id: a.id } }),
      );
      return this.view(fresh as BrandAsset);
    } finally {
      fs.rmSync(tmpName, { force: true });
    }
  }
}
