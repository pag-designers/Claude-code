/**
 * FontsHub: ONE directory libass reads fonts from = the shipped fonts (hard links, or copies across devices) + every
 * brand font as `<assetId>.<ttf|otf>`. Operations are serialised, idempotent, atomic (write to a temp name, rename)
 * and survive restarts: the directory is the state, plus a tiny manifest of which files are shipped ones so an app
 * update that drops a shipped font cleans it up without ever touching a brand font.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FontsHub } from '../../pipeline/contracts4';

const FONT_FILE = /^(.+)\.(ttf|otf)$/i;
const MANIFEST = '.fonts-hub.json';
/** Brand asset ids become file names: keep them boring. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface FontsHubOptions {
  /** Directory with the app's bundled fonts (null when there are none, e.g. a stripped dev build). */
  shippedDir: string | null;
  /** Writable app-data directory; the merged fonts live in `<userDir>/merged`. */
  userDir: string;
  /**
   * The caption engine's FontBook (captions/fontbook.ts). Told about the merged directory after every change so
   * caption layout measures uploaded fonts with their real advances. FontBook.addDir rescans when the dir changed.
   */
  fontBook?: { addDir(dir: string): unknown };
  log?: (m: string) => void;
}

const isFontName = (n: string): boolean => FONT_FILE.test(n);

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ino !== 0;
}

export function createFontsHub(opts: FontsHubOptions): FontsHub {
  const merged = path.join(opts.userDir, 'merged');
  const log = opts.log ?? (() => undefined);
  let shippedNames: Set<string> = new Set();
  let initialised = false;
  let chain: Promise<unknown> = Promise.resolve();

  const informBook = (): void => {
    try {
      opts.fontBook?.addDir(merged);
    } catch (e) {
      log(`[fonts-hub] fontBook.addDir failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Hard link, falling back to a copy (other device, FAT, permissions). Replaces atomically. */
  function linkOrCopy(src: string, dest: string): void {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    try {
      fs.linkSync(src, tmp);
    } catch {
      fs.copyFileSync(src, tmp);
      const st = fs.statSync(src);
      fs.utimesSync(tmp, st.atime, st.mtime);
    }
    fs.renameSync(tmp, dest);
  }

  function readManifest(): string[] {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(merged, MANIFEST), 'utf8')) as {
        shipped?: unknown;
      };
      return Array.isArray(j.shipped)
        ? j.shipped.filter((x): x is string => typeof x === 'string' && isFontName(x))
        : [];
    } catch {
      return [];
    }
  }

  /** Synchronous so `dir()` is usable straight at startup. Idempotent; re-checked cheaply on every operation. */
  function sync(): void {
    fs.mkdirSync(merged, { recursive: true });
    let shipped: string[] = [];
    if (opts.shippedDir) {
      try {
        shipped = fs
          .readdirSync(opts.shippedDir, { withFileTypes: true })
          .filter((e) => e.isFile() && isFontName(e.name))
          .map((e) => e.name)
          .sort();
      } catch (e) {
        log(`[fonts-hub] cannot read shipped fonts: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    shippedNames = new Set(shipped);
    for (const name of shipped) {
      const src = path.join(opts.shippedDir as string, name);
      const dest = path.join(merged, name);
      try {
        const ss = fs.statSync(src);
        let ok = false;
        try {
          const ds = fs.statSync(dest);
          ok = sameFile(ss, ds) || (ds.size === ss.size && Math.abs(ds.mtimeMs - ss.mtimeMs) < 2);
        } catch {
          ok = false;
        }
        if (!ok) linkOrCopy(src, dest);
      } catch (e) {
        log(
          `[fonts-hub] shipped font ${name} not linked: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // shipped fonts that an app update removed: they were ours, not a user's
    for (const old of readManifest()) {
      if (!shippedNames.has(old)) fs.rmSync(path.join(merged, old), { force: true });
    }
    const manifest = JSON.stringify({ shipped });
    const mp = path.join(merged, MANIFEST);
    try {
      if (fs.readFileSync(mp, 'utf8') !== manifest) fs.writeFileSync(mp, manifest);
    } catch {
      fs.writeFileSync(mp, manifest);
    }
    // leftovers of a crash mid-write
    for (const n of fs.readdirSync(merged))
      if (n.endsWith('.tmp')) fs.rmSync(path.join(merged, n), { force: true });
    initialised = true;
    informBook();
  }

  const ensure = (): void => {
    if (!initialised) sync();
  };

  /** Runs `fn` after every earlier operation; a failure does not poison the chain. */
  function serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  const brandFiles = (): { name: string; id: string }[] => {
    if (!fs.existsSync(merged)) return [];
    return fs
      .readdirSync(merged)
      .filter((n) => isFontName(n) && !shippedNames.has(n))
      .map((n) => ({ name: n, id: (FONT_FILE.exec(n) as RegExpExecArray)[1] as string }));
  };

  return {
    dir(): string | null {
      try {
        ensure();
        return fs.readdirSync(merged).some(isFontName) ? merged : null;
      } catch (e) {
        log(`[fonts-hub] dir() failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },

    add(assetId, sfntPath, sfntExt) {
      return serial(async () => {
        if (!SAFE_ID.test(assetId)) throw new Error(`Invalid font asset id '${assetId}'.`);
        if (sfntExt !== 'ttf' && sfntExt !== 'otf') {
          throw new Error(`Unsupported font type '${String(sfntExt)}'.`);
        }
        ensure();
        const name = `${assetId}.${sfntExt}`;
        if (shippedNames.has(name)) throw new Error(`'${name}' collides with a bundled font.`);
        const dest = path.join(merged, name);
        const incoming = await fs.promises.readFile(sfntPath);
        let same = false;
        try {
          same = (await fs.promises.readFile(dest)).equals(incoming);
        } catch {
          same = false;
        }
        if (!same) {
          const tmp = `${dest}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, incoming);
          await fs.promises.rename(tmp, dest);
        }
        // the same id registered with the other container type: only one file per id
        await fs.promises.rm(path.join(merged, `${assetId}.${sfntExt === 'ttf' ? 'otf' : 'ttf'}`), {
          force: true,
        });
        informBook();
      });
    },

    remove(assetId) {
      return serial(async () => {
        if (!SAFE_ID.test(assetId)) return;
        ensure();
        for (const ext of ['ttf', 'otf']) {
          const name = `${assetId}.${ext}`;
          if (shippedNames.has(name)) continue; // never delete a shipped font
          await fs.promises.rm(path.join(merged, name), { force: true });
        }
        informBook();
      });
    },

    prune(keep) {
      const keepSet = new Set(keep);
      return serial(async () => {
        ensure();
        for (const f of brandFiles()) {
          if (!keepSet.has(f.id)) await fs.promises.rm(path.join(merged, f.name), { force: true });
        }
        informBook();
      });
    },
  };
}
