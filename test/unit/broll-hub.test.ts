import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrollItem } from '@shared/brand';
import { BrollHub } from '@main/pipeline/broll';
import type { BrollService } from '@main/pipeline/contracts4';
import { tmpDir } from './helpers';

const item: BrollItem = {
  id: 'pexels:42',
  provider: 'pexels',
  title: 'City at night',
  author: 'Ann',
  pageUrl: 'https://pexels.test/42',
  thumbUrl: 'https://img.test/42.jpg',
  previewUrl: null,
  width: 1080,
  height: 1920,
  durationSec: 8,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function make(over: { fetch?: typeof fetch; configured?: boolean } = {}) {
  const dir = tmpDir('broll-hub-');
  dirs.push(dir);
  const imported: { projectId?: string; kitId?: string; name: string; bytes: number }[] = [];
  const broll: BrollService = {
    status: () => ({ pexels: true, pixabay: false }),
    search: async () => ({ items: [item], page: 1, nextPage: null }),
    resolveDownload: async () => ({
      url: 'https://cdn.test/42.mp4',
      ext: 'mp4',
      width: 1080,
      height: 1920,
      durationSec: 8,
      credit: { source: 'pexels', author: 'Ann', url: 'https://pexels.test/42' },
    }),
  };
  const hub = new BrollHub({
    broll,
    brand: {
      addDownloadedVideo: async (kitId, a) => {
        imported.push({ kitId, name: a.name, bytes: fs.statSync(a.file).size });
        return { id: 'ba_1', credit: a.credit } as never;
      },
    },
    editor: {
      importLocalVideo: async (projectId, file, name) => {
        imported.push({ projectId, name, bytes: fs.statSync(file).size });
        return { id: 'as_1', name } as never;
      },
    },
    llm: {
      isConfigured: () => over.configured ?? true,
      suggestBroll: async ({ text }) => [`q:${text}`],
    },
    cacheDir: dir,
    fetch:
      over.fetch ??
      (async () =>
        new Response(new Uint8Array(1234), { status: 200, headers: { 'content-length': '1234' } })),
    log: () => {},
  });
  return { hub, imported, dir };
}

const leftovers = (dir: string) =>
  fs.existsSync(path.join(dir, 'broll')) ? fs.readdirSync(path.join(dir, 'broll')) : [];

describe('BrollHub', () => {
  it('downloads the clip, hands it to the project, and removes the temp file', async () => {
    const { hub, imported, dir } = make();
    const r = await hub.importToProject('p1', item);
    expect(r.asset).toMatchObject({ id: 'as_1', name: 'City at night (pexels)' });
    expect(imported).toEqual([{ projectId: 'p1', name: 'City at night (pexels)', bytes: 1234 }]);
    expect(leftovers(dir)).toEqual([]);
  });

  it('imports into a kit with the provider credit', async () => {
    const { hub, imported } = make();
    const r = await hub.importToKit('k1', item);
    expect(imported[0]).toMatchObject({ kitId: 'k1', bytes: 1234 });
    expect((r.asset as unknown as { credit: unknown }).credit).toEqual({
      source: 'pexels',
      author: 'Ann',
      url: 'https://pexels.test/42',
    });
  });

  it('a failing download is a clear error and leaves nothing behind', async () => {
    const { hub, imported, dir } = make({
      fetch: async () => new Response('nope', { status: 403 }),
    });
    await expect(hub.importToProject('p1', item)).rejects.toThrow(/HTTP 403/);
    expect(imported).toEqual([]);
    expect(leftovers(dir)).toEqual([]);
  });

  it('refuses an oversized clip', async () => {
    const { hub, dir } = make({
      fetch: async () =>
        new Response(new Uint8Array(10), {
          status: 200,
          headers: { 'content-length': String(2 * 2 ** 30) },
        }),
    });
    await expect(hub.importToProject('p1', item)).rejects.toThrow(/too large/);
    expect(leftovers(dir)).toEqual([]);
  });

  it('suggest needs the Anthropic key; status/search pass through', async () => {
    expect(await make().hub.suggest('hello')).toEqual(['q:hello']);
    await expect(make({ configured: false }).hub.suggest('hello')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    const { hub } = make();
    expect(hub.status()).toEqual({ pexels: true, pixabay: false });
    expect(
      (await hub.search({ provider: 'pexels', query: 'x', orientation: 'any', page: 1 })).items,
    ).toHaveLength(1);
  });
});
