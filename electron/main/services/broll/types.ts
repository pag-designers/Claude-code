import type { BrollItem } from '@shared/brand';
import type { Fetch } from './http';
import type { Orientation, Rendition } from './select';

/** What an adapter needs for one call. */
export interface ProviderCtx {
  baseUrl: string;
  key: string;
  fetchImpl: Fetch;
  log?: (m: string) => void;
  now: () => number;
  /** http:// media URLs are accepted (only when the base URL was overridden, i.e. in tests). */
  allowHttp: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ProviderPage {
  items: BrollItem[];
  /** The next page to request, null when the provider has no more. */
  nextPage: number | null;
  /** Provider results before dropping malformed / filtered ones (for look-ahead decisions). */
  rawCount: number;
}

/** A single clip re-fetched from its provider, ready for `pickRendition`. */
export interface ResolvedClip {
  width: number;
  height: number;
  durationSec: number;
  author: string | null;
  pageUrl: string | null;
  files: Rendition[];
}

export interface ProviderAdapter {
  search(
    ctx: ProviderCtx,
    args: { query: string; orientation: Orientation; page: number },
  ): Promise<ProviderPage>;
  fetchOne(ctx: ProviderCtx, providerId: string): Promise<ResolvedClip>;
}

export const PER_PAGE = 24;
/** The IPC contract caps `page` at 50. */
export const MAX_PAGE = 50;
export const REQUEST_TIMEOUT_MS = 15_000;
