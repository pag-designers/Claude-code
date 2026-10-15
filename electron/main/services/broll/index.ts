/**
 * Stock B-roll service (BRIEF §7 / CP4): searches the official Pexels and Pixabay video APIs and resolves the file
 * to download. Contract: electron/main/pipeline/contracts4.ts (BrollService / BrollDownload).
 *
 * Keys come from `getKey` per call (never cached beyond a search-result cache entry) and are never logged.
 */
import type { BrollItem, BrollProvider, BrollSearchResult } from '@shared/brand';
import type { BrollDownload, BrollService } from '../../pipeline/contracts4';
import { TtlLru } from './cache';
import { BrollError, abortError, missingKeyError, noFileError } from './errors';
import { pexelsAdapter } from './pexels';
import { pixabayAdapter } from './pixabay';
import { pickRendition } from './select';
import { REQUEST_TIMEOUT_MS, type ProviderAdapter, type ProviderCtx } from './types';

export { BrollError, isBrollError, type BrollErrorCode, PROVIDER_NAME } from './errors';

const DEFAULT_BASE: Record<BrollProvider, string> = {
  pexels: 'https://api.pexels.com',
  pixabay: 'https://pixabay.com',
};
const ADAPTERS: Record<BrollProvider, ProviderAdapter> = {
  pexels: pexelsAdapter,
  pixabay: pixabayAdapter,
};

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;
const MAX_QUERY = 120;

export interface BrollServiceDeps {
  /** The saved API key for a provider, null/empty when there is none (Settings -> API Keys). */
  getKey(provider: BrollProvider): string | null;
  /** Test/dev overrides (same idea as the validators' pexelsBaseUrl / pixabayBaseUrl). */
  baseUrls?: { pexels?: string; pixabay?: string };
  fetch?: typeof fetch;
  log?: (m: string) => void;
  /** Clock for the search cache and Retry-After dates (tests). */
  now?: () => number;
  /** Per-request timeout in ms (default 15 000). */
  timeoutMs?: number;
}

export function createBrollService(deps: BrollServiceDeps): BrollService {
  const now = deps.now ?? Date.now;
  const cache = new TtlLru<{ key: string; result: BrollSearchResult }>(
    CACHE_MAX,
    CACHE_TTL_MS,
    now,
  );

  const keyOf = (p: BrollProvider): string | null => deps.getKey(p)?.trim() || null;

  function ctxFor(p: BrollProvider, signal?: AbortSignal): ProviderCtx {
    const key = keyOf(p);
    if (!key) throw missingKeyError(p);
    const override = deps.baseUrls?.[p]?.trim();
    return {
      baseUrl: (override || DEFAULT_BASE[p]).replace(/\/+$/, ''),
      key,
      fetchImpl: deps.fetch ?? fetch,
      log: deps.log,
      now,
      // Plain-http media URLs only ever show up behind a base-URL override (a local test server).
      allowHttp: !!override,
      signal,
      timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    };
  }

  return {
    status() {
      return { pexels: keyOf('pexels') !== null, pixabay: keyOf('pixabay') !== null };
    },

    async search({ provider, query, orientation, page, signal }): Promise<BrollSearchResult> {
      if (signal?.aborted) throw abortError();
      const q = query.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY);
      if (!q) throw new BrollError('invalid', 'Type something to search for.', provider);
      const pageNo = Number.isInteger(page) && page >= 1 ? page : 1;
      const ctx = ctxFor(provider, signal);
      const cacheKey = `${provider}|${orientation}|${pageNo}|${q.toLowerCase()}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.key === ctx.key) return clone(hit.result);

      const res = await ADAPTERS[provider].search(ctx, { query: q, orientation, page: pageNo });
      const result: BrollSearchResult = { items: res.items, page: pageNo, nextPage: res.nextPage };
      cache.set(cacheKey, { key: ctx.key, result });
      return clone(result);
    },

    async resolveDownload(item: BrollItem, opts): Promise<BrollDownload> {
      if (opts?.signal?.aborted) throw abortError();
      const providerId = providerIdOf(item);
      const ctx = ctxFor(item.provider, opts?.signal);
      const clip = await ADAPTERS[item.provider].fetchOne(ctx, providerId);
      // Orientation to honour: the clip's own (fresh data), else what the user saw in the results.
      const w = clip.width > 0 && clip.height > 0 ? clip.width : item.width;
      const h = clip.width > 0 && clip.height > 0 ? clip.height : item.height;
      const file = pickRendition(clip.files, w / h);
      if (!file) throw noFileError(item.provider);
      return {
        url: file.url,
        ext: 'mp4',
        width: file.width,
        height: file.height,
        durationSec: clip.durationSec > 0 ? clip.durationSec : item.durationSec,
        credit: {
          source: item.provider,
          author: clip.author ?? item.author,
          url: clip.pageUrl ?? item.pageUrl,
        },
      };
    },
  };
}

/** `pexels:3015510` -> `3015510`. The id goes into a URL path, so only digits are accepted. */
function providerIdOf(item: BrollItem): string {
  const m = /^(pexels|pixabay):(\d{1,15})$/.exec(item.id);
  if (!m || m[1] !== item.provider)
    throw new BrollError('invalid', 'That clip reference is not valid.', item.provider);
  return m[2]!;
}

const clone = (r: BrollSearchResult): BrollSearchResult => ({
  ...r,
  items: r.items.map((i) => ({ ...i })),
});
