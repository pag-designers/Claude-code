/**
 * Pixabay Videos API (https://pixabay.com/api/docs/#api_search_videos).
 *   GET {base}/api/videos/?key=&q=&per_page=&page=&safesearch=true
 *   GET {base}/api/videos/?key=&id=
 * Rate limit: 100 requests/minute. The key is a query parameter (Pixabay offers no header): the URL is never logged.
 *
 * Pixabay's VIDEO endpoint has no orientation parameter. For portrait / landscape / square we therefore filter
 * client-side by the clips' aspect ratio, and because that thins a page out (most Pixabay footage is landscape) a
 * search looks ahead up to LOOKAHEAD further provider pages until it has enough matches. `nextPage` then continues
 * after the last provider page that was read.
 */
import { z } from 'zod';
import type { BrollItem } from '@shared/brand';
import { getJson } from './http';
import { providerError } from './errors';
import {
  isMp4Url,
  matchesOrientation,
  pickPreview,
  pickRendition,
  titleFromTags,
  type Rendition,
} from './select';
import {
  MAX_PAGE,
  PER_PAGE,
  type ProviderAdapter,
  type ProviderCtx,
  type ProviderPage,
  type ResolvedClip,
} from './types';
import { isObject, lenId, lenNumber, lenString } from './zod-lenient';

const MIN_MATCHES = 8;
const LOOKAHEAD = 2;

const rendition = z
  .object({ url: lenString, width: lenNumber, height: lenNumber, size: lenNumber })
  .optional()
  .catch(undefined);
const hit = z.object({
  id: lenId,
  pageURL: lenString,
  tags: lenString,
  duration: lenNumber,
  picture_id: lenString,
  user: lenString,
  videos: z
    .object({ large: rendition, medium: rendition, small: rendition, tiny: rendition })
    .optional()
    .catch(undefined),
});
type Hit = z.output<typeof hit>;

const body = z.object({
  total: lenNumber,
  totalHits: lenNumber,
  hits: z.array(z.unknown()),
});

const httpsUrl = (u: string | undefined, allowHttp: boolean): string | null => {
  if (!u) return null;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || (allowHttp && p === 'http:') ? u : null;
  } catch {
    return null;
  }
};

/** Renditions with a real URL and size ("large" is often `{url: "", width: 0}` for small sources). */
function renditions(h: Hit, allowHttp: boolean): Rendition[] {
  const out: Rendition[] = [];
  for (const r of [h.videos?.large, h.videos?.medium, h.videos?.small, h.videos?.tiny]) {
    if (!r?.url || !r.width || !r.height || r.width < 1 || r.height < 1) continue;
    if (!isMp4Url(r.url, allowHttp, false)) continue;
    out.push({
      url: r.url,
      width: Math.round(r.width),
      height: Math.round(r.height),
      size: r.size && r.size > 0 ? r.size : null,
    });
  }
  return out;
}

export function toItem(raw: unknown, allowHttp: boolean): BrollItem | null {
  const p = hit.safeParse(raw);
  if (!p.success) return null;
  const h = p.data;
  if (!h.id || !h.duration || h.duration <= 0) return null;
  const files = renditions(h, allowHttp);
  if (files.length === 0) return null;
  const biggest = [...files].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  // What an import would download (<= 1080p); falls back to the largest file when the clip only exists above that.
  const best = pickRendition(files, biggest.width / biggest.height) ?? biggest;
  const thumb = h.picture_id?.trim()
    ? `https://i.vimeocdn.com/video/${encodeURIComponent(h.picture_id.trim())}_640x360.jpg`
    : null;
  if (!thumb) return null;
  return {
    id: `pixabay:${h.id}`,
    provider: 'pixabay',
    title: titleFromTags(h.tags, `Pixabay video ${h.id}`),
    author: h.user?.trim() || null,
    pageUrl: httpsUrl(h.pageURL, false),
    thumbUrl: thumb,
    previewUrl: pickPreview(files)?.url ?? null,
    width: best.width,
    height: best.height,
    durationSec: h.duration,
  };
}

export const pixabayAdapter: ProviderAdapter = {
  async search(ctx, { query, orientation, page: pageNo }): Promise<ProviderPage> {
    const items: BrollItem[] = [];
    const seen = new Set<string>();
    let rawCount = 0;
    let cur = pageNo;
    let nextPage: number | null = null;
    for (let step = 0; step <= LOOKAHEAD; step++) {
      const q = new URLSearchParams({
        q: query.slice(0, 100), // Pixabay: max 100 characters
        per_page: String(PER_PAGE),
        page: String(cur),
        safesearch: 'true',
      });
      let b: z.output<typeof body>;
      try {
        const json = await get(ctx, q, `/api/videos/ q="${query.slice(0, 40)}" page=${cur}`);
        const parsed = body.safeParse(json);
        if (!parsed.success) throw providerError('pixabay', 'sent an unexpected response.');
        b = parsed.data;
      } catch (e) {
        // A failing look-ahead page must not throw away the page that already worked: offer it again as "more".
        if (step > 0 && items.length > 0 && !ctx.signal?.aborted) {
          nextPage = cur;
          break;
        }
        throw e;
      }
      rawCount += b.hits.length;
      for (const raw of b.hits) {
        const it = toItem(raw, ctx.allowHttp);
        if (!it || seen.has(it.id) || !matchesOrientation(it.width, it.height, orientation))
          continue;
        seen.add(it.id);
        items.push(it);
      }
      const total = b.totalHits ?? b.total;
      const more =
        b.hits.length > 0 &&
        (total === undefined ? b.hits.length >= PER_PAGE : cur * PER_PAGE < total);
      nextPage = more && cur < MAX_PAGE ? cur + 1 : null;
      if (nextPage === null || orientation === 'any' || items.length >= MIN_MATCHES) break;
      cur = nextPage;
    }
    return { items, nextPage, rawCount };
  },

  async fetchOne(ctx, providerId): Promise<ResolvedClip> {
    const json = await get(
      ctx,
      new URLSearchParams({ id: providerId }),
      `/api/videos/ id=${providerId}`,
    );
    const parsed = isObject(json) ? body.safeParse(json) : null;
    if (!parsed?.success) throw providerError('pixabay', 'sent an unexpected response.');
    const h = parsed.data.hits
      .map((x) => hit.safeParse(x))
      .find((x) => x.success && String(x.data.id) === providerId);
    if (!h?.success) throw providerError('pixabay', 'that clip is no longer available.');
    const files = renditions(h.data, ctx.allowHttp);
    const biggest = [...files].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return {
      width: biggest?.width ?? 0,
      height: biggest?.height ?? 0,
      durationSec: h.data.duration ?? 0,
      author: h.data.user?.trim() || null,
      pageUrl: httpsUrl(h.data.pageURL, false),
      files,
    };
  },
};

function get(ctx: ProviderCtx, params: URLSearchParams, label: string): Promise<unknown> {
  const q = new URLSearchParams({ key: ctx.key });
  for (const [k, v] of params) q.set(k, v);
  return getJson({
    provider: 'pixabay',
    url: `${ctx.baseUrl}/api/videos/?${q}`,
    label,
    headers: { Accept: 'application/json' },
    secret: ctx.key,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    log: ctx.log,
    now: ctx.now,
  });
}
