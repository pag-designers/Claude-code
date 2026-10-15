import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { brollItemSchema, brollSearchResultSchema, type BrollProvider } from '@shared/brand';
import { BrollError, createBrollService } from '@main/services/broll';
import {
  LANDSCAPE,
  PORTRAIT,
  SQUARE,
  pexelsCatalog,
  pixabayCatalog,
  startFakeApi,
  type FakeApi,
  type PexelsClip,
  type PixabayClip,
} from './broll-fakes';

const PEXELS_KEY = 'pexels-test-key-9f8e7d';
const PIXABAY_KEY = 'pixabay-test-key';

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.hits.length = 0;
  api.setCatalog({ pexels: [], pixabay: [] });
});

function svc(opts: Partial<Parameters<typeof createBrollService>[0]> = {}) {
  const logs: string[] = [];
  const keys: Record<BrollProvider, string | null> = { pexels: PEXELS_KEY, pixabay: PIXABAY_KEY };
  const service = createBrollService({
    getKey: (p) => keys[p],
    baseUrls: { pexels: api.url, pixabay: api.url },
    log: (m) => logs.push(m),
    ...opts,
  });
  return { service, logs, keys };
}
const rejection = async (p: Promise<unknown>): Promise<BrollError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BrollError);
    return e as BrollError;
  }
  throw new Error('expected a rejection');
};
const pexelsSearch = (service: ReturnType<typeof svc>['service'], over = {}) =>
  service.search({ provider: 'pexels', query: 'ocean', orientation: 'portrait', page: 1, ...over });
const pixabaySearch = (service: ReturnType<typeof svc>['service'], over = {}) =>
  service.search({ provider: 'pixabay', query: 'ocean', orientation: 'any', page: 1, ...over });

describe('status + missing keys', () => {
  it('reports which providers have a key (blank = none)', () => {
    const { service, keys } = svc();
    expect(service.status()).toEqual({ pexels: true, pixabay: true });
    keys.pexels = null;
    keys.pixabay = '   ';
    expect(service.status()).toEqual({ pexels: false, pixabay: false });
  });

  it('throws a guidance error instead of calling the network', async () => {
    const { service, keys } = svc();
    keys.pexels = null;
    const e = await rejection(pexelsSearch(service));
    expect(e.code).toBe('missing-key');
    expect(e.message).toBe('Add your Pexels API key in Settings -> API Keys');
    keys.pixabay = null;
    expect((await rejection(pixabaySearch(service))).message).toBe(
      'Add your Pixabay API key in Settings -> API Keys',
    );
    const item = brollItemSchema.parse({
      id: 'pexels:1',
      provider: 'pexels',
      title: 't',
      author: null,
      pageUrl: null,
      thumbUrl: 'https://x/y.jpg',
      previewUrl: null,
      width: 1080,
      height: 1920,
      durationSec: 5,
    });
    expect((await rejection(service.resolveDownload(item))).code).toBe('missing-key');
    expect(api.hits).toHaveLength(0);
  });
});

describe('Pexels search', () => {
  it('speaks the documented request and maps the documented response', async () => {
    api.setCatalog({
      pexels: [
        {
          id: 3015510,
          shape: PORTRAIT,
          duration: 14,
          slug: 'a-woman-running-on-the-beach',
          user: 'Jane Photographer',
        },
      ],
    });
    const { service } = svc();
    const r = await pexelsSearch(service);
    const hit = api.hits[0]!;
    expect(hit.path).toBe('/videos/search');
    expect(hit.headers.authorization).toBe(PEXELS_KEY);
    expect(hit.query.get('query')).toBe('ocean');
    expect(hit.query.get('orientation')).toBe('portrait');
    expect(hit.query.get('per_page')).toBe('24');
    expect(hit.query.get('page')).toBe('1');

    expect(brollSearchResultSchema.safeParse(r).success).toBe(true);
    expect(r.page).toBe(1);
    expect(r.nextPage).toBeNull();
    const it = r.items[0]!;
    expect(it).toMatchObject({
      id: 'pexels:3015510',
      provider: 'pexels',
      title: 'A woman running on the beach',
      author: 'Jane Photographer',
      pageUrl: 'https://www.pexels.com/video/a-woman-running-on-the-beach-3015510/',
      durationSec: 14,
      // the size an import would download, not the 4K master
      width: 1080,
      height: 1920,
    });
    expect(it.thumbUrl).toMatch(/\/thumbs\/pexels-3015510\.jpeg$/);
    // smallest MP4 rendition (360 short side), never the HLS playlist
    expect(it.previewUrl).toMatch(/pexels-3015510-360\.mp4/);
  });

  it('omits orientation for "any" and sends it for the others', async () => {
    api.setCatalog({ pexels: pexelsCatalog(3, [PORTRAIT, LANDSCAPE, SQUARE]) });
    const { service } = svc();
    await pexelsSearch(service, { orientation: 'any' });
    await pexelsSearch(service, { orientation: 'landscape' });
    await pexelsSearch(service, { orientation: 'square' });
    expect(api.hits.map((h) => h.query.get('orientation'))).toEqual([null, 'landscape', 'square']);
  });

  it('pages: nextPage from total_results / per_page, null on the last page and past the end', async () => {
    api.setCatalog({ pexels: pexelsCatalog(50, [PORTRAIT]) });
    const { service } = svc();
    const p1 = await pexelsSearch(service);
    expect(p1.items).toHaveLength(24);
    expect(p1.nextPage).toBe(2);
    const p2 = await pexelsSearch(service, { page: 2 });
    expect(p2.items).toHaveLength(24);
    expect(p2.nextPage).toBe(3);
    const p3 = await pexelsSearch(service, { page: 3 });
    expect(p3.items).toHaveLength(2);
    expect(p3.nextPage).toBeNull();
    const p4 = await pexelsSearch(service, { page: 4 });
    expect(p4).toEqual({ items: [], page: 4, nextPage: null });
    expect(new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).size).toBe(50);
  });

  it('empty results are a normal answer', async () => {
    const { service } = svc();
    expect(await pexelsSearch(service)).toEqual({ items: [], page: 1, nextPage: null });
  });

  it('drops malformed items, keeps the good ones, ignores extra fields', async () => {
    const good: PexelsClip = { id: 1, shape: PORTRAIT };
    const bad: PexelsClip[] = [
      { id: 2, shape: PORTRAIT, broken: 'no-image' },
      { id: 3, shape: PORTRAIT, broken: 'no-dims' },
      { id: 4, shape: PORTRAIT, broken: 'no-duration' },
      { id: 5, shape: PORTRAIT, broken: 'string-id' },
    ];
    api.setCatalog({ pexels: [bad[0]!, good, ...bad.slice(1), { id: 6, shape: LANDSCAPE }] });
    const { service } = svc();
    const r = await pexelsSearch(service, { orientation: 'any' });
    expect(r.items.map((i) => i.id)).toEqual(['pexels:1', 'pexels:6']);
  });

  it('keeps an item whose files are garbled (no preview), and without author/title data', async () => {
    api.setCatalog({
      pexels: [
        { id: 7, shape: PORTRAIT, broken: 'files-not-array', user: null, slug: '' },
        { id: 8, shape: PORTRAIT, files: 'none' },
      ],
    });
    const { service } = svc();
    const r = await pexelsSearch(service);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ author: null, previewUrl: null, width: 2160, height: 3840 });
    expect(r.items[0]!.title).toMatch(/\S/);
    expect(r.items[1]!.previewUrl).toBeNull();
  });

  it('rejects a body that is not the documented shape', async () => {
    const { service } = svc();
    api.script('/videos/search', { body: { videos: 'nope' } });
    expect((await rejection(pexelsSearch(service))).code).toBe('provider');
    api.script('/videos/search', { body: [1, 2, 3] });
    expect((await rejection(pexelsSearch(service, { query: 'b' }))).code).toBe('provider');
    api.script('/videos/search', { body: '<html>oops{', headers: { 'content-type': 'text/html' } });
    const e = await rejection(pexelsSearch(service, { query: 'c' }));
    expect(e.code).toBe('provider');
    expect(e.message).toMatch(/could not read/);
  });

  it('turns empty / whitespace queries into a user error, and normalises spaces', async () => {
    const { service } = svc();
    expect((await rejection(pexelsSearch(service, { query: '   ' }))).code).toBe('invalid');
    await pexelsSearch(service, { query: '  big   waves ' });
    expect(api.hits[0]!.query.get('query')).toBe('big waves');
  });
});

describe('Pexels errors', () => {
  it.each([401, 403])('maps HTTP %i to "rejected this key"', async (status) => {
    api.script('/videos/', { status, body: { error: 'nope' } });
    const e = await rejection(pexelsSearch(svc().service));
    expect(e.code).toBe('rejected');
    expect(e.message).toMatch(/^Pexels rejected this key/);
  });

  it('429 with Retry-After tells how long to wait', async () => {
    api.script('/videos/', { status: 429, headers: { 'retry-after': '42' } });
    const e = await rejection(pexelsSearch(svc().service));
    expect(e.code).toBe('rate-limit');
    expect(e.retryAfterSec).toBe(42);
    expect(e.message).toBe('Pexels rate limit reached; try again in 42 s');
  });

  it("429 without Retry-After uses Pexels' epoch X-Ratelimit-Reset, or a generic hint", async () => {
    const now = 1_800_000_000_000;
    api.script('/videos/', {
      status: 429,
      headers: { 'x-ratelimit-reset': String(now / 1000 + 3000) },
    });
    const e = await rejection(pexelsSearch(svc({ now: () => now }).service));
    expect(e.retryAfterSec).toBe(3000);
    expect(e.message).toBe('Pexels rate limit reached; try again in 50 min');
    api.script('/videos/', { status: 429 });
    const e2 = await rejection(pexelsSearch(svc().service, { query: 'zz' }));
    expect(e2.retryAfterSec).toBeNull();
    expect(e2.message).toMatch(/rate limit reached; try again in a few minutes/);
  });

  it('429 with an HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    api.script('/videos/', {
      status: 429,
      headers: { 'retry-after': 'Wed, 14 Oct 2026 10:01:30 GMT' },
    });
    const e = await rejection(pexelsSearch(svc({ now: () => now }).service));
    expect(e.retryAfterSec).toBe(90);
  });

  it('5xx is a provider problem, with no URL or key in the text', async () => {
    api.script('/videos/', { status: 503, body: 'down' });
    const e = await rejection(pexelsSearch(svc().service));
    expect(e.code).toBe('provider');
    expect(e.message).toMatch(/HTTP 503/);
    expect(e.message).not.toContain(PEXELS_KEY);
  });

  it('network down: a closed port is "could not reach"', async () => {
    const dead = await startFakeApi();
    const url = dead.url;
    await dead.close();
    const { service, logs } = svc({ baseUrls: { pexels: url, pixabay: url } });
    const e = await rejection(pexelsSearch(service));
    expect(e.code).toBe('network');
    expect(e.message).toMatch(/Could not reach Pexels/);
    const p = await rejection(pixabaySearch(service));
    expect(p.code).toBe('network');
    expect(logs.join('\n')).not.toContain(PIXABAY_KEY);
    expect(logs.join('\n')).not.toContain(PEXELS_KEY);
  });

  it('a slow server hits the timeout', async () => {
    api.script('/videos/', { delayMs: 400 });
    const e = await rejection(pexelsSearch(svc({ timeoutMs: 60 }).service));
    expect(e.code).toBe('network');
    expect(e.message).toMatch(/did not answer in time/);
  });

  it('an AbortSignal cancels as an AbortError (not a BrollError)', async () => {
    api.script('/videos/', { delayMs: 400 });
    const ac = new AbortController();
    const { service } = svc();
    const p = pexelsSearch(service, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pexelsSearch(service, { signal: ac.signal, query: 'q2' })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('Pixabay search', () => {
  it('speaks the documented request and maps hits', async () => {
    api.setCatalog({
      pixabay: [
        {
          id: 125,
          shape: LANDSCAPE,
          duration: 22,
          tags: 'sea, waves, sunset, extra',
          user: 'seaman',
          pictureId: '99887766',
        },
      ],
    });
    const { service } = svc();
    const r = await pixabaySearch(service, { page: 1 });
    const hit = api.hits[0]!;
    expect(hit.path).toBe('/api/videos/');
    expect(hit.query.get('key')).toBe(PIXABAY_KEY);
    expect(hit.query.get('q')).toBe('ocean');
    expect(hit.query.get('per_page')).toBe('24');
    expect(hit.query.get('safesearch')).toBe('true');
    expect(brollSearchResultSchema.safeParse(r).success).toBe(true);
    expect(r.items[0]).toMatchObject({
      id: 'pixabay:125',
      provider: 'pixabay',
      title: 'Sea, waves, sunset',
      author: 'seaman',
      pageUrl: 'https://pixabay.com/videos/stock-125/',
      thumbUrl: 'https://i.vimeocdn.com/video/99887766_640x360.jpg',
      durationSec: 22,
      width: 1920,
      height: 1080,
    });
    // smallest rendition = tiny
    expect(r.items[0]!.previewUrl).toMatch(/pixabay-125_tiny\.mp4$/);
    expect(r.nextPage).toBeNull();
  });

  it('handles the empty "large" rendition, 4K-only and rendition-less clips, missing picture/duration', async () => {
    const clips: PixabayClip[] = [
      { id: 1, shape: LANDSCAPE, files: 'no-large' },
      { id: 2, shape: LANDSCAPE, files: 'only-4k' },
      { id: 3, shape: LANDSCAPE, files: 'none' },
      { id: 4, shape: LANDSCAPE, broken: 'no-picture' },
      { id: 5, shape: LANDSCAPE, broken: 'no-duration' },
      { id: 6, shape: LANDSCAPE },
    ];
    api.setCatalog({ pixabay: clips });
    const r = await pixabaySearch(svc().service);
    expect(r.items.map((i) => i.id)).toEqual(['pixabay:1', 'pixabay:2', 'pixabay:6']);
    expect(r.items[0]).toMatchObject({ width: 1920, height: 1080 });
    // only a 4K master exists: it is listed (with its real size) but resolveDownload will refuse it
    expect(r.items[1]).toMatchObject({ width: 3840, height: 2160 });
  });

  it("truncates long queries to Pixabay's 100 characters", async () => {
    const { service } = svc();
    await pixabaySearch(service, { query: 'x'.repeat(120) });
    expect(api.hits[0]!.query.get('q')).toHaveLength(100);
  });

  it('pages by totalHits', async () => {
    api.setCatalog({ pixabay: pixabayCatalog(30) });
    const { service } = svc();
    const p1 = await pixabaySearch(service);
    expect(p1.items).toHaveLength(24);
    expect(p1.nextPage).toBe(2);
    const p2 = await pixabaySearch(service, { page: 2 });
    expect(p2.items).toHaveLength(6);
    expect(p2.nextPage).toBeNull();
  });

  it('client-side orientation filter: portrait only, looking ahead through thin pages', async () => {
    // 100 clips, only every 10th is portrait -> 2-3 per page of 24
    const shapes = [PORTRAIT, ...Array(9).fill(LANDSCAPE)];
    api.setCatalog({ pixabay: pixabayCatalog(100, shapes) });
    const { service } = svc();
    const r = await pixabaySearch(service, { orientation: 'portrait' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.height > i.width)).toBe(true);
    // looked ahead beyond page 1 (3 provider pages at most) and continues after the last one read
    const pages = api.hits.map((h) => h.query.get('page'));
    expect(pages).toEqual(['1', '2', '3']);
    expect(r.page).toBe(1);
    expect(r.nextPage).toBe(4);
    const more = await pixabaySearch(service, { orientation: 'portrait', page: r.nextPage! });
    expect(more.items.every((i) => i.height > i.width)).toBe(true);
    const ids = new Set([...r.items, ...more.items].map((i) => i.id));
    expect(ids.size).toBe(r.items.length + more.items.length);
  });

  it('square / landscape filters', async () => {
    api.setCatalog({ pixabay: pixabayCatalog(9, [PORTRAIT, LANDSCAPE, SQUARE]) });
    const { service } = svc();
    expect((await pixabaySearch(service, { orientation: 'square' })).items).toHaveLength(3);
    expect((await pixabaySearch(service, { orientation: 'landscape' })).items).toHaveLength(3);
    expect((await pixabaySearch(service, { orientation: 'any' })).items).toHaveLength(9);
  });

  it('does not look ahead when the page already has enough matches or orientation is "any"', async () => {
    api.setCatalog({ pixabay: pixabayCatalog(80, [LANDSCAPE]) });
    const { service } = svc();
    await pixabaySearch(service, { orientation: 'landscape' });
    await pixabaySearch(service, { orientation: 'any', query: 'b' });
    expect(api.hits).toHaveLength(2);
  });

  it('keeps the page that worked when a look-ahead page fails', async () => {
    api.setCatalog({ pixabay: pixabayCatalog(100, [PORTRAIT, ...Array(9).fill(LANDSCAPE)]) });
    const { service } = svc();
    // 1st request fine, 2nd (look-ahead) is rate limited
    let n = 0;
    const flaky = svc({
      fetch: (async (url: string, init: RequestInit) => {
        n += 1;
        if (n === 2)
          return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } });
        return fetch(url, init);
      }) as typeof fetch,
    }).service;
    const r = await pixabaySearch(flaky, { orientation: 'portrait' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.nextPage).toBe(2);
    // but a failing FIRST page is an error
    api.script('/api/videos/', { status: 429, headers: { 'retry-after': '5' } });
    const e = await rejection(pixabaySearch(service, { orientation: 'portrait', query: 'fresh' }));
    expect(e.message).toBe('Pixabay rate limit reached; try again in 5 s');
  });

  it('Pixabay "invalid key" (HTTP 400) is a rejected key; other 400s are not', async () => {
    const { service } = svc({ getKey: (p) => (p === 'pixabay' ? 'wrong-key' : PEXELS_KEY) });
    const e = await rejection(pixabaySearch(service));
    expect(e.code).toBe('rejected');
    expect(e.message).toMatch(/^Pixabay rejected this key/);
    api.script('/api/videos/', {
      status: 400,
      body: '[ERROR 400] "q" is too long',
      headers: { 'content-type': 'text/plain' },
    });
    const o = await rejection(pixabaySearch(svc().service, { query: 'z' }));
    expect(o.code).toBe('provider');
  });

  it('never leaks the key into logs or error messages (it is in the URL)', async () => {
    const { service, logs } = svc();
    api.setCatalog({ pixabay: pixabayCatalog(2) });
    await pixabaySearch(service);
    api.script('/api/videos/', { status: 500, body: `oops ${PIXABAY_KEY}` });
    const e = await rejection(pixabaySearch(service, { query: 'again' }));
    expect(e.message).not.toContain(PIXABAY_KEY);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(PIXABAY_KEY);
    expect(logs.join('\n')).not.toMatch(/key=/);
  });
});

describe('search cache', () => {
  it('serves an identical search from memory for 60 s, then asks again', async () => {
    api.setCatalog({ pexels: pexelsCatalog(5) });
    let t = 1_000_000;
    const { service } = svc({ now: () => t });
    const a = await pexelsSearch(service);
    t += 59_000;
    const b = await pexelsSearch(service, { query: '  OCEAN ' });
    expect(api.hits).toHaveLength(1);
    expect(b).toEqual(a);
    t += 2_000;
    await pexelsSearch(service);
    expect(api.hits).toHaveLength(2);
  });

  it('is keyed by provider, orientation, page and query; callers get copies; errors and a changed key are not served from cache', async () => {
    api.setCatalog({ pexels: pexelsCatalog(30), pixabay: pixabayCatalog(5) });
    const { service, keys } = svc();
    const a = await pexelsSearch(service);
    a.items[0]!.title = 'mutated';
    const again = await pexelsSearch(service);
    expect(again.items[0]!.title).not.toBe('mutated');
    await pexelsSearch(service, { page: 2 });
    await pexelsSearch(service, { orientation: 'landscape' });
    await pexelsSearch(service, { query: 'other' });
    await pixabaySearch(service, { query: 'ocean' });
    expect(api.hits).toHaveLength(5);
    keys.pexels = 'another-key';
    await pexelsSearch(service);
    expect(api.hits).toHaveLength(6);

    api.script('/videos/search', { status: 429, headers: { 'retry-after': '1' } });
    await rejection(pexelsSearch(service, { query: 'fails' }));
    await pexelsSearch(service, { query: 'fails' }); // not cached -> goes out again and succeeds
    expect(api.hits).toHaveLength(8);
  });

  it('evicts the least recently used entries (max 50)', async () => {
    api.setCatalog({ pexels: pexelsCatalog(2) });
    const { service } = svc();
    for (let i = 0; i < 51; i++) await pexelsSearch(service, { query: `q${i}` });
    expect(api.hits).toHaveLength(51);
    await pexelsSearch(service, { query: 'q50' }); // cached
    expect(api.hits).toHaveLength(51);
    await pexelsSearch(service, { query: 'q0' }); // evicted
    expect(api.hits).toHaveLength(52);
  });
});

const itemOf = async (
  service: ReturnType<typeof svc>['service'],
  provider: BrollProvider,
  orientation: 'any' | 'portrait' | 'landscape' | 'square' = 'any',
) => {
  const r = await service.search({ provider, query: 'ocean', orientation, page: 1 });
  expect(r.items.length).toBeGreaterThan(0);
  api.hits.length = 0;
  return r.items[0]!;
};

describe('resolveDownload', () => {
  it('Pexels portrait: 1080x1920, never the 4K file, never HLS; credit from the fresh record', async () => {
    api.setCatalog({
      pexels: [{ id: 42, shape: PORTRAIT, duration: 9.5, slug: 'surf-at-dawn', user: 'Sam Surf' }],
    });
    const { service } = svc();
    const item = await itemOf(service, 'pexels', 'portrait');
    const d = await service.resolveDownload(item);
    expect(api.hits).toHaveLength(1);
    expect(api.hits[0]!.path).toBe('/videos/videos/42');
    expect(api.hits[0]!.headers.authorization).toBe(PEXELS_KEY);
    expect(d).toMatchObject({
      ext: 'mp4',
      width: 1080,
      height: 1920,
      durationSec: 9.5,
      credit: {
        source: 'pexels',
        author: 'Sam Surf',
        url: 'https://www.pexels.com/video/surf-at-dawn-42/',
      },
    });
    expect(d.url).toMatch(/pexels-42-1080\.mp4\?token=abc$/);
  });

  it('Pexels landscape: 1920x1080', async () => {
    api.setCatalog({ pexels: [{ id: 43, shape: LANDSCAPE }] });
    const { service } = svc();
    const d = await service.resolveDownload(await itemOf(service, 'pexels'));
    expect([d.width, d.height]).toEqual([1920, 1080]);
  });

  it('Pexels: falls back to the best smaller file, and refuses a clip that only has 4K or nothing', async () => {
    api.setCatalog({
      pexels: [
        { id: 50, shape: PORTRAIT, files: 'sd-only' },
        { id: 51, shape: PORTRAIT, files: 'uhd-only' },
        { id: 52, shape: PORTRAIT, files: 'none' },
      ],
    });
    const { service } = svc();
    const r = await service.search({ provider: 'pexels', query: 'x', orientation: 'any', page: 1 });
    const [sd, uhd, none] = r.items;
    expect(await service.resolveDownload(sd!)).toMatchObject({ width: 540, height: 960 });
    const e = await rejection(service.resolveDownload(uhd!));
    expect(e.code).toBe('no-file');
    expect(e.message).toMatch(/no downloadable HD MP4/);
    expect((await rejection(service.resolveDownload(none!))).code).toBe('no-file');
  });

  it('Pixabay: GET ?id= and picks 1080 "medium" over the 4K "large"', async () => {
    api.setCatalog({ pixabay: [{ id: 777, shape: LANDSCAPE, duration: 30, user: 'pixel' }] });
    const { service } = svc();
    const item = await itemOf(service, 'pixabay');
    const d = await service.resolveDownload(item);
    expect(api.hits[0]!.query.get('id')).toBe('777');
    expect(api.hits[0]!.query.get('key')).toBe(PIXABAY_KEY);
    expect(d).toMatchObject({
      width: 1920,
      height: 1080,
      durationSec: 30,
      credit: { source: 'pixabay', author: 'pixel', url: 'https://pixabay.com/videos/stock-777/' },
    });
    expect(d.url).toMatch(/pixabay-777_medium\.mp4$/);
  });

  it('Pixabay portrait picks the 1080x1920 file', async () => {
    api.setCatalog({ pixabay: [{ id: 778, shape: PORTRAIT }] });
    const { service } = svc();
    const d = await service.resolveDownload(await itemOf(service, 'pixabay', 'portrait'));
    expect([d.width, d.height]).toEqual([1080, 1920]);
  });

  it('Pixabay: 4K-only clip -> no-file; vanished clip -> provider error', async () => {
    api.setCatalog({ pixabay: [{ id: 779, shape: LANDSCAPE, files: 'only-4k' }] });
    const { service } = svc();
    const item = await itemOf(service, 'pixabay');
    expect((await rejection(service.resolveDownload(item))).code).toBe('no-file');
    api.setCatalog({ pixabay: [] });
    const e = await rejection(service.resolveDownload(item));
    expect(e.code).toBe('provider');
    expect(e.message).toMatch(/no longer available/);
  });

  it('Pexels 404 is "no longer available"; 401 / 429 map like search', async () => {
    api.setCatalog({ pexels: [{ id: 60, shape: PORTRAIT }] });
    const { service } = svc();
    const item = await itemOf(service, 'pexels');
    api.setCatalog({ pexels: [] });
    expect((await rejection(service.resolveDownload(item))).message).toMatch(/no longer available/);
    api.script('/videos/videos', { status: 401 });
    expect((await rejection(service.resolveDownload(item))).code).toBe('rejected');
    api.script('/videos/videos', { status: 429, headers: { 'retry-after': '7' } });
    expect((await rejection(service.resolveDownload(item))).message).toMatch(/try again in 7 s/);
  });

  it('refuses ids that could escape the URL path', async () => {
    const { service } = svc();
    const base = {
      provider: 'pexels' as const,
      title: 't',
      author: null,
      pageUrl: null,
      thumbUrl: 'https://x/y.jpg',
      previewUrl: null,
      width: 1080,
      height: 1920,
      durationSec: 5,
    };
    for (const id of ['pexels:../../etc', 'pexels:12/34', 'pixabay:12', 'pexels:', 'nope']) {
      expect((await rejection(service.resolveDownload({ ...base, id }))).code).toBe('invalid');
    }
    expect(api.hits).toHaveLength(0);
  });

  it('honours an AbortSignal', async () => {
    api.setCatalog({ pexels: [{ id: 70, shape: PORTRAIT }] });
    const { service } = svc();
    const item = await itemOf(service, 'pexels');
    api.script('/videos/videos', { delayMs: 300 });
    const ac = new AbortController();
    const p = service.resolveDownload(item, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
