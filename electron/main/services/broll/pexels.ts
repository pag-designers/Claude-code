/**
 * Pexels Videos API (https://www.pexels.com/api/documentation/#videos).
 *   GET {base}/videos/search?query=&orientation=&per_page=&page=   (Authorization: <key>)
 *   GET {base}/videos/videos/{id}
 * Rate limit: 200 requests/hour, 20 000/month.
 */
import { z } from 'zod';
import type { BrollItem } from '@shared/brand';
import { getJson } from './http';
import { providerError } from './errors';
import { isMp4Url, pickPreview, pickRendition, titleFromSlug, type Rendition } from './select';
import {
  MAX_PAGE,
  PER_PAGE,
  type ProviderAdapter,
  type ProviderCtx,
  type ProviderPage,
  type ResolvedClip,
} from './types';
import { isObject, lenArray, lenId, lenNumber, lenString } from './zod-lenient';

const file = z.object({
  quality: lenString,
  file_type: lenString,
  width: lenNumber,
  height: lenNumber,
  link: lenString,
});
const picture = z.object({ picture: lenString });
const video = z.object({
  id: lenId,
  url: lenString,
  image: lenString,
  duration: lenNumber,
  width: lenNumber,
  height: lenNumber,
  user: z.object({ name: lenString, url: lenString }).optional().catch(undefined),
  video_files: lenArray(file),
  video_pictures: lenArray(picture),
});
type PexelsVideo = z.output<typeof video>;

const page = z.object({
  total_results: lenNumber,
  per_page: lenNumber,
  next_page: lenString,
  videos: z.array(z.unknown()),
});

const httpUrl = (u: string | undefined, allowHttp: boolean): string | null => {
  if (!u) return null;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || (allowHttp && p === 'http:') ? u : null;
  } catch {
    return null;
  }
};

/** mp4 renditions with real dimensions. The `hls` entry (a .m3u8 playlist without size) is not one. */
function renditions(v: PexelsVideo, allowHttp: boolean): Rendition[] {
  const out: Rendition[] = [];
  for (const f of v.video_files) {
    if (!f.link || !f.width || !f.height || f.width < 1 || f.height < 1) continue;
    if (f.file_type && !/mp4/i.test(f.file_type)) continue;
    if (!isMp4Url(f.link, allowHttp)) continue;
    out.push({ url: f.link, width: Math.round(f.width), height: Math.round(f.height) });
  }
  return out;
}

export function toItem(raw: unknown, allowHttp: boolean): BrollItem | null {
  const p = video.safeParse(raw);
  if (!p.success) return null;
  const v = p.data;
  if (!v.id) return null;
  const thumb = httpUrl(v.image ?? v.video_pictures.find((x) => x.picture)?.picture, allowHttp);
  if (!thumb) return null;
  const files = renditions(v, allowHttp);
  const ratioW = v.width && v.width > 0 ? v.width : files[0]?.width;
  const ratioH = v.height && v.height > 0 ? v.height : files[0]?.height;
  if (!ratioW || !ratioH || !v.duration || v.duration <= 0) return null;
  // Show the size that an import would really download (<= 1080p), not the (possibly 4K) master.
  const best = pickRendition(files, ratioW / ratioH);
  return {
    id: `pexels:${v.id}`,
    provider: 'pexels',
    title: titleFromSlug(v.url, `Pexels video ${v.id}`),
    author: v.user?.name?.trim() || null,
    pageUrl: httpUrl(v.url, false),
    thumbUrl: thumb,
    previewUrl: pickPreview(files)?.url ?? null,
    width: Math.round(best?.width ?? ratioW),
    height: Math.round(best?.height ?? ratioH),
    durationSec: v.duration,
  };
}

export const pexelsAdapter: ProviderAdapter = {
  async search(ctx, { query, orientation, page: pageNo }): Promise<ProviderPage> {
    const q = new URLSearchParams({ query, per_page: String(PER_PAGE), page: String(pageNo) });
    if (orientation !== 'any') q.set('orientation', orientation);
    const json = await get(ctx, `/videos/search?${q}`, `/videos/search q="${query.slice(0, 40)}"`);
    const parsed = page.safeParse(json);
    if (!parsed.success) throw providerError('pexels', 'sent an unexpected response.');
    const body = parsed.data;
    const items: BrollItem[] = [];
    const seen = new Set<string>();
    for (const raw of body.videos) {
      const it = toItem(raw, ctx.allowHttp);
      if (it && !seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    }
    const perPage = body.per_page && body.per_page > 0 ? body.per_page : PER_PAGE;
    let more: boolean;
    if (body.videos.length === 0) more = false;
    else if (body.total_results !== undefined) more = pageNo * perPage < body.total_results;
    else more = !!body.next_page;
    return {
      items,
      nextPage: more && pageNo < MAX_PAGE ? pageNo + 1 : null,
      rawCount: body.videos.length,
    };
  },

  async fetchOne(ctx, providerId): Promise<ResolvedClip> {
    const json = await get(ctx, `/videos/videos/${providerId}`, `/videos/videos/${providerId}`);
    const p = isObject(json) ? video.safeParse(json) : null;
    if (!p?.success || !p.data.id) throw providerError('pexels', 'sent an unexpected response.');
    const v = p.data;
    return {
      width: v.width ?? 0,
      height: v.height ?? 0,
      durationSec: v.duration ?? 0,
      author: v.user?.name?.trim() || null,
      pageUrl: httpUrl(v.url, false),
      files: renditions(v, ctx.allowHttp),
    };
  },
};

function get(ctx: ProviderCtx, path: string, label: string): Promise<unknown> {
  return getJson({
    provider: 'pexels',
    url: `${ctx.baseUrl}${path}`,
    label,
    // Pexels takes the raw key in the Authorization header (no "Bearer").
    headers: { Authorization: ctx.key, Accept: 'application/json' },
    secret: ctx.key,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    fetchImpl: ctx.fetchImpl,
    log: ctx.log,
    now: ctx.now,
  });
}
