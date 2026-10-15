/**
 * Local `node:http` fakes of the Pexels and Pixabay VIDEO APIs, with payloads written from the documented shapes
 * (including the quirks: Pexels' `hls` pseudo-file without size, Pixabay's empty `large` rendition, extra fields).
 * One server speaks both (paths do not collide): /videos/search + /videos/videos/:id and /api/videos/.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
}

export interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  /** Raw body (string) or JSON-able value. */
  body?: unknown;
  /** Delay before answering (ms). */
  delayMs?: number;
}

export interface FakeApi {
  url: string;
  hits: Hit[];
  /** Answer the next N requests whose path starts with `prefix` with `r` instead of the normal handler. */
  script(prefix: string, r: Scripted, times?: number): void;
  /** Total clips behind the search (drives `total_results` / `totalHits`). */
  setCatalog(c: { pexels?: PexelsClip[]; pixabay?: PixabayClip[] }): void;
  close(): Promise<void>;
}

export interface Shape {
  w: number;
  h: number;
}
export const PORTRAIT: Shape = { w: 1080, h: 1920 };
export const LANDSCAPE: Shape = { w: 1920, h: 1080 };
export const SQUARE: Shape = { w: 1080, h: 1080 };

export interface PexelsClip {
  id: number;
  shape: Shape;
  duration?: number;
  slug?: string;
  user?: string | null;
  /** Rendition set. Default = full realistic set (uhd + hd + sd + hls). */
  files?: 'full' | 'uhd-only' | 'sd-only' | 'none';
  /** Drop/garble fields to test tolerance. */
  broken?: 'no-image' | 'no-dims' | 'no-duration' | 'string-id' | 'files-not-array';
}

const scaleTo = (s: Shape, shortSide: number): Shape => {
  const f = shortSide / Math.min(s.w, s.h);
  return { w: Math.round(s.w * f), h: Math.round(s.h * f) };
};

export function pexelsJson(c: PexelsClip, base: string): Record<string, unknown> {
  const slug = c.slug ?? `stock-clip-${c.id}`;
  const mk = (q: string, short: number, id: number) => {
    const d = scaleTo(c.shape, short);
    return {
      id,
      quality: q,
      file_type: 'video/mp4',
      width: d.w,
      height: d.h,
      fps: 25,
      link: `${base}/files/pexels-${c.id}-${short}.mp4?token=abc`,
    };
  };
  let files: unknown[] = [];
  const hls = {
    id: c.id * 10 + 9,
    quality: 'hls',
    file_type: 'application/x-mpegURL',
    width: null,
    height: null,
    fps: 25,
    link: `${base}/files/pexels-${c.id}.m3u8`,
  };
  switch (c.files ?? 'full') {
    case 'full':
      files = [
        mk('uhd', 2160, c.id * 10 + 1),
        mk('hd', 1080, c.id * 10 + 2),
        mk('sd', 540, c.id * 10 + 3),
        mk('sd', 360, c.id * 10 + 4),
        hls,
      ];
      break;
    case 'uhd-only':
      files = [mk('uhd', 2160, c.id * 10 + 1), hls];
      break;
    case 'sd-only':
      files = [mk('sd', 540, c.id * 10 + 3), hls];
      break;
    case 'none':
      files = [hls];
      break;
  }
  const top = scaleTo(c.shape, 2160);
  const out: Record<string, unknown> = {
    id: c.id,
    width: top.w,
    height: top.h,
    url: `https://www.pexels.com/video/${slug}-${c.id}/`,
    image: `${base}/thumbs/pexels-${c.id}.jpeg`,
    full_res: null,
    tags: [],
    duration: c.duration ?? 12,
    user:
      c.user === null
        ? undefined
        : { id: 99, name: c.user ?? 'Jane Photographer', url: 'https://www.pexels.com/@jane' },
    video_files: files,
    video_pictures: [{ id: 1, nr: 0, picture: `${base}/thumbs/pexels-${c.id}-0.jpeg` }],
    extra_field_from_the_future: { nested: true },
  };
  switch (c.broken) {
    case 'no-image':
      delete out.image;
      out.video_pictures = [];
      break;
    case 'no-dims':
      delete out.width;
      delete out.height;
      out.video_files = [];
      break;
    case 'no-duration':
      delete out.duration;
      break;
    case 'string-id':
      out.id = 'abc';
      break;
    case 'files-not-array':
      out.video_files = 'nope';
      break;
  }
  return out;
}

export interface PixabayClip {
  id: number;
  shape: Shape;
  duration?: number;
  tags?: string;
  user?: string;
  pictureId?: string;
  /** Which renditions exist. Default = 4K large + 1080 medium + 720 small + 540 tiny. */
  files?: 'full' | 'no-large' | 'only-4k' | 'none';
  broken?: 'no-picture' | 'no-duration';
}

export function pixabayJson(c: PixabayClip, base: string): Record<string, unknown> {
  const r = (short: number, name: string, size: number) => {
    const d = scaleTo(c.shape, short);
    return {
      url: `${base}/files/pixabay-${c.id}_${name}.mp4`,
      width: d.w,
      height: d.h,
      size,
      thumbnail: `${base}/thumbs/x.jpg`,
    };
  };
  const empty = { url: '', width: 0, height: 0, size: 0 };
  let videos: Record<string, unknown>;
  switch (c.files ?? 'full') {
    case 'full':
      videos = {
        large: r(2160, 'large', 40e6),
        medium: r(1080, 'medium', 18e6),
        small: r(720, 'small', 9e6),
        tiny: r(540, 'tiny', 4e6),
      };
      break;
    case 'no-large':
      videos = {
        large: empty,
        medium: r(1080, 'medium', 18e6),
        small: r(720, 'small', 9e6),
        tiny: r(540, 'tiny', 4e6),
      };
      break;
    case 'only-4k':
      videos = { large: r(2160, 'large', 40e6), medium: empty, small: empty, tiny: empty };
      break;
    case 'none':
      videos = { large: empty, medium: empty, small: empty, tiny: empty };
      break;
  }
  const out: Record<string, unknown> = {
    id: c.id,
    pageURL: `https://pixabay.com/videos/stock-${c.id}/`,
    type: 'film',
    tags: c.tags ?? 'ocean, waves, beach',
    duration: c.duration ?? 15,
    picture_id: c.pictureId ?? `${c.id}1234567`,
    videos,
    views: 1000,
    downloads: 500,
    likes: 20,
    comments: 1,
    user_id: 7,
    user: c.user ?? 'someartist',
    userImageURL: 'https://cdn.pixabay.com/user/x.jpg',
  };
  if (c.broken === 'no-picture') delete out.picture_id;
  if (c.broken === 'no-duration') delete out.duration;
  return out;
}

/** n clips cycling through shapes, ids from `from`. */
export function pexelsCatalog(n: number, shapes: Shape[] = [PORTRAIT], from = 1000): PexelsClip[] {
  return Array.from({ length: n }, (_, i) => ({
    id: from + i,
    shape: shapes[i % shapes.length]!,
    slug: `a-clip-about-things-${i}`,
  }));
}
export function pixabayCatalog(
  n: number,
  shapes: Shape[] = [LANDSCAPE],
  from = 5000,
): PixabayClip[] {
  return Array.from({ length: n }, (_, i) => ({ id: from + i, shape: shapes[i % shapes.length]! }));
}

export async function startFakeApi(): Promise<FakeApi> {
  const hits: Hit[] = [];
  let catalog: { pexels: PexelsClip[]; pixabay: PixabayClip[] } = { pexels: [], pixabay: [] };
  const scripts: { prefix: string; r: Scripted; left: number }[] = [];
  let base = '';

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push({
      method: req.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      headers: req.headers,
    });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    };
    const s = scripts.find((x) => u.pathname.startsWith(x.prefix) && x.left > 0);
    if (s) s.left -= 1; // consumed at arrival, even if the client gives up before the delayed answer
    const run = () => {
      if (s) {
        return send(s.r.status ?? 200, s.r.body ?? {}, s.r.headers);
      }
      const page = Math.max(1, Number(u.searchParams.get('page') ?? '1'));
      const perPage = Math.max(1, Number(u.searchParams.get('per_page') ?? '15'));
      if (u.pathname === '/videos/search') {
        if (!req.headers.authorization) return send(401, { error: 'Unauthorized' });
        const orient = u.searchParams.get('orientation');
        const all = catalog.pexels.filter((c) => {
          if (!orient) return true;
          const r = c.shape.w / c.shape.h;
          return orient === 'portrait' ? r < 1 : orient === 'landscape' ? r > 1 : r === 1;
        });
        const slice = all.slice((page - 1) * perPage, page * perPage);
        return send(200, {
          page,
          per_page: perPage,
          total_results: all.length,
          url: 'https://www.pexels.com/search/videos/x/',
          ...(page * perPage < all.length
            ? { next_page: `${base}/videos/search?page=${page + 1}` }
            : {}),
          videos: slice.map((c) => pexelsJson(c, base)),
        });
      }
      const one = /^\/videos\/videos\/(\d+)$/.exec(u.pathname);
      if (one) {
        if (!req.headers.authorization) return send(401, { error: 'Unauthorized' });
        const c = catalog.pexels.find((x) => String(x.id) === one[1]);
        return c ? send(200, pexelsJson(c, base)) : send(404, { error: 'Not Found' });
      }
      if (u.pathname === '/api/videos/') {
        if (u.searchParams.get('key') !== 'pixabay-test-key')
          return send(400, '[ERROR 400] Invalid API key', { 'content-type': 'text/plain' });
        const id = u.searchParams.get('id');
        if (id) {
          const c = catalog.pixabay.find((x) => String(x.id) === id);
          return send(200, {
            total: c ? 1 : 0,
            totalHits: c ? 1 : 0,
            hits: c ? [pixabayJson(c, base)] : [],
          });
        }
        const slice = catalog.pixabay.slice((page - 1) * perPage, page * perPage);
        return send(200, {
          total: catalog.pixabay.length,
          totalHits: catalog.pixabay.length,
          hits: slice.map((c) => pixabayJson(c, base)),
        });
      }
      send(404, { error: 'no route' });
    };
    if (s?.r.delayMs) setTimeout(run, s.r.delayMs);
    else run();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    hits,
    script: (prefix, r, times = 1) => void scripts.push({ prefix, r, left: times }),
    setCatalog: (c) =>
      void (catalog = {
        pexels: c.pexels ?? catalog.pexels,
        pixabay: c.pixabay ?? catalog.pixabay,
      }),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
