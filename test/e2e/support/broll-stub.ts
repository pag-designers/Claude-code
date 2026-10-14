/**
 * TEST-ONLY stand-in for main's `broll:*` channels, as the stock B-roll dialog sees them. Every request and every
 * response passes through the REAL zod contract of shared/ipc.ts (here, in `openBroll`), so this file cannot drift
 * from the contract.
 *
 * It is self-contained on purpose: `openBroll` builds its own page (same recording of console problems / external
 * requests as the shared harness) and routes only `broll:*` to this stub; every other channel still goes to the main
 * clipfern stub. When the lead wants it in the main stub, `handleBroll(stub, channel, payload)` is the one-line hook:
 *     const b = await handleBroll(state.broll, channel, payload); if (b) return b.value;
 */
import type { Page } from '@playwright/test';
import {
  encodeIpcError,
  invokeContract,
  type InvokeChannel,
  type InvokeInput,
} from '../../../shared/ipc';
import { brollItemSchema, type BrandAssetView, type BrollItem } from '../../../shared/brand';
import type { Asset } from '../../../shared/editor';
import type { BrollProvider } from '../../../shared/brand';
import { installClipfernStub, makeState } from './clipfern-stub';
import type { Harness, OpenOptions, Session } from './harness';

export const PAGE_SIZE = 8;
const TOTAL_PER_SEARCH = 20;

export interface BrollCall {
  channel: string;
  payload: unknown;
  at: number;
}

export interface BrollStub {
  keys: Record<BrollProvider, boolean>;
  /** Items per page the fake provider returns (default 8, so paging is easy to reach). */
  pageSize: number;
  /** Items behind one search (default 20 -> 3 pages of 8). */
  total: number;
  searchDelayMs: number;
  importDelayMs: number;
  suggestDelayMs: number;
  /** Queries the fake provider has nothing for. */
  emptyQueries: Set<string>;
  /** The next search(es) fail with this message. */
  searchFailure: { message: string; times: number } | null;
  /** Item ids whose import fails (until removed from the set). */
  failImports: Set<string>;
  /** What `broll:suggest` answers. */
  suggest: { queries: string[] } | { error: string };
  /** Origin that serves `/__assets/*` (set by openBroll). */
  assetBase: string;
  calls: BrollCall[];
  /** Imports that completed, in order. */
  imported: { channel: string; itemId: string }[];
}

export function createBrollStub(over: Partial<BrollStub> = {}): BrollStub {
  return {
    keys: { pexels: true, pixabay: true },
    pageSize: PAGE_SIZE,
    total: TOTAL_PER_SEARCH,
    searchDelayMs: 0,
    importDelayMs: 0,
    suggestDelayMs: 0,
    emptyQueries: new Set(['nothing']),
    searchFailure: null,
    failImports: new Set(),
    suggest: {
      queries: [
        'city skyline at night',
        'neon street rain',
        'time lapse traffic',
        'drone over downtown',
      ],
    },
    assetBase: '',
    calls: [],
    imported: [],
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string) => new Error(encodeIpcError('FAILED', msg));
const NAME: Record<BrollProvider, string> = { pexels: 'Pexels', pixabay: 'Pixabay' };

/** Deterministic SVG thumbnail (data: URL, so no network). */
function thumb(n: number, w: number, h: number): string {
  const hue = (n * 47) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 38%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 22%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="hsl(${hue} 90% 80% / .55)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SHAPES = {
  portrait: [1080, 1920],
  landscape: [1920, 1080],
  square: [1080, 1080],
} as const;

/** One fake search result item. `any` mixes the three shapes. */
export function fakeItem(
  stub: BrollStub,
  provider: BrollProvider,
  query: string,
  orientation: string,
  n: number,
): BrollItem {
  const shape =
    orientation === 'any'
      ? (['portrait', 'landscape', 'square'] as const)[n % 3]!
      : (orientation as keyof typeof SHAPES);
  const [w, h] = SHAPES[shape];
  const slug = query.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return brollItemSchema.parse({
    id: `${provider}:${slug}-${orientation}-${n}`,
    provider,
    title: `${query[0]!.toUpperCase()}${query.slice(1)} clip ${n + 1}`,
    author:
      n % 5 === 4 ? null : `${['Ana', 'Ben', 'Chioma', 'Dev', 'Eli'][n % 5]} ${NAME[provider]}`,
    pageUrl: n % 7 === 6 ? null : `https://www.${provider}.com/video/${slug}-${n}/`,
    thumbUrl: thumb(n + provider.length, 270, 480),
    previewUrl:
      n % 6 === 5
        ? null
        : `${stub.assetBase}/__assets/${['clip-a', 'clip-b', 'clip-c'][n % 3]}.webm`,
    width: w,
    height: h,
    durationSec: 6 + ((n * 7) % 40),
  });
}

function assetFor(item: BrollItem, id: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${item.title}.mp4`,
    source: {
      kind: 'upload',
      key: `editor/proj-1/assets/${id}.mp4`,
      fileName: `${item.title}.mp4`,
    },
    durationSec: item.durationSec,
    width: item.width,
    height: item.height,
    fps: 30,
    hasAudio: false,
    beats: null,
  };
}

function brandAssetFor(item: BrollItem, id: string, kitId: string): BrandAssetView {
  return {
    id,
    kitId,
    kind: 'video',
    name: `${item.title}.mp4`,
    ext: 'mp4',
    bytes: 5_000_000,
    storageKey: `brand/${kitId}/${id}.mp4`,
    usableKey: null,
    previewKey: `brand/${kitId}/${id}.preview.mp4`,
    thumbKey: `brand/${kitId}/${id}.thumb.jpg`,
    width: item.width,
    height: item.height,
    durationSec: item.durationSec,
    hasAudio: false,
    fps: 30,
    loudnessLufs: null,
    font: null,
    credit: { source: item.provider, author: item.author, url: item.pageUrl },
    createdAt: Date.now(),
    url: null,
    previewUrl: null,
    thumbUrl: null,
  };
}

/** Returns `{ value }` for a `broll:*` channel, null for anything else. */
export async function handleBroll(
  stub: BrollStub,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  if (!channel.startsWith('broll:')) return null;
  stub.calls.push({ channel, payload, at: Date.now() });
  switch (channel) {
    case 'broll:status':
      return { value: { ...stub.keys } };
    case 'broll:search': {
      const p = payload as InvokeInput<'broll:search'>;
      if (stub.searchDelayMs) await sleep(stub.searchDelayMs);
      if (!stub.keys[p.provider])
        throw fail(`Add your ${NAME[p.provider]} API key in Settings -> API Keys`);
      if (stub.searchFailure && stub.searchFailure.times > 0) {
        stub.searchFailure.times -= 1;
        throw fail(stub.searchFailure.message);
      }
      const page = p.page ?? 1;
      const total = stub.emptyQueries.has(p.query.toLowerCase()) ? 0 : stub.total;
      const from = (page - 1) * stub.pageSize;
      const items = Array.from(
        { length: Math.max(0, Math.min(stub.pageSize, total - from)) },
        (_, i) => fakeItem(stub, p.provider, p.query, p.orientation ?? 'portrait', from + i),
      );
      return { value: { items, page, nextPage: from + items.length < total ? page + 1 : null } };
    }
    case 'broll:importToProject':
    case 'broll:importToKit': {
      const p = payload as { item: BrollItem; projectId?: string; kitId?: string };
      if (stub.importDelayMs) await sleep(stub.importDelayMs);
      if (stub.failImports.has(p.item.id))
        throw fail(
          `${NAME[p.item.provider]} has no downloadable HD MP4 for this clip. Pick another one.`,
        );
      stub.imported.push({ channel, itemId: p.item.id });
      const id = `asset-${stub.imported.length}`;
      return {
        value:
          channel === 'broll:importToProject'
            ? { asset: assetFor(p.item, id) }
            : { asset: brandAssetFor(p.item, id, p.kitId ?? 'kit-1') },
      };
    }
    case 'broll:suggest': {
      if (stub.suggestDelayMs) await sleep(stub.suggestDelayMs);
      if ('error' in stub.suggest) throw fail(stub.suggest.error);
      return { value: { queries: stub.suggest.queries } };
    }
  }
  return null;
}

export interface BrollSession extends Session {
  stub: BrollStub;
}

/**
 * Opens `route` with the main stub plus the B-roll stub. Same recording as `Harness.open` (console errors/warnings,
 * page errors, external requests, HTTP >= 400 land in `problems`).
 */
/** The harness options, with `stub` re-purposed to configure (or hand in) the B-roll stub. */
export type BrollOpenOptions = Omit<OpenOptions, 'stub'> & {
  stub?: Partial<BrollStub> | BrollStub;
};

export async function openBroll(
  h: Harness,
  route: string,
  opts: BrollOpenOptions = {},
): Promise<BrollSession> {
  const {
    scenario = 'library',
    theme = 'dark',
    platform = 'linux',
    width = 1440,
    height = 900,
    reducedMotion = false,
    settle = 500,
    prepare,
  } = opts;
  const stub =
    opts.stub && 'calls' in opts.stub ? (opts.stub as BrollStub) : createBrollStub(opts.stub);
  stub.assetBase = h.base;
  const context = await h.browser.newContext({
    viewport: { width, height },
    colorScheme: theme === 'light' ? 'light' : 'dark',
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message} @ ${page.url()}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(h.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:'))
      problems.push(`EXTERNAL REQUEST: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  const state = makeState(scenario, platform, { assetBase: h.base });
  prepare?.(state);
  const bridge = await installClipfernStub(page, state);
  await installBrollRoute(page, stub);
  await context.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem('clipfern.theme', t as string);
      } catch {
        /* ignore */
      }
    },
    [theme] as const,
  );
  await page.goto(h.base + route);
  await page.locator('nav[aria-label="Main"]').waitFor();
  await page.waitForLoadState('networkidle');
  if (settle) await page.waitForTimeout(settle);
  return {
    page,
    state,
    problems,
    emit: bridge.emit,
    sim: bridge.sim,
    stub,
    close: () => context.close(),
  };
}

async function installBrollRoute(page: Page, stub: BrollStub) {
  await page.exposeFunction('__brollInvoke', async (channel: string, payload: unknown) => {
    const spec = invokeContract[channel as InvokeChannel];
    if (!spec) throw new Error(`Unknown channel: ${channel}`);
    const input = spec.input.parse(payload);
    const res = await handleBroll(stub, channel, input);
    if (!res) throw new Error(`broll stub does not handle ${channel}`);
    return spec.output.parse(res.value);
  });
  await page.addInitScript(() => {
    const w = window as unknown as {
      clipfern: { invoke: (c: string, p?: unknown) => Promise<unknown> };
      __brollInvoke: (c: string, p: unknown) => Promise<unknown>;
    };
    const prev = w.clipfern.invoke;
    w.clipfern.invoke = (c, p) => (c.startsWith('broll:') ? w.__brollInvoke(c, p) : prev(c, p));
  });
}
