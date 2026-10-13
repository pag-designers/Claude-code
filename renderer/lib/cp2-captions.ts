'use client';

/**
 * Data layer for caption styles: query/mutation hooks (`captions:*`, `videos:setCaptionStyle`, `clips:restyle`) and the
 * preview pipeline. `captions:preview` is a REAL libass render in main, so requests are cached in memory by a hash of the
 * style JSON, de-duplicated while in flight, and (for gallery tiles) limited to two at a time.
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DEFAULT_STYLE_ID, type CaptionStyle, type ReframeMode } from '@shared/cp2';
import type { ClipView } from '@shared/pipeline';
import { invoke, ipcKey, useIpcQuery, type IpcCallError } from './ipc';
import { patchClipsInCache } from './pipeline-cache';

export { DEFAULT_STYLE_ID };

/* --------------------------------------------------------------- queries --------------------------------------- */

interface StylesData {
  styles: CaptionStyle[];
}

export function useCaptionStyles() {
  return useIpcQuery('captions:styles', undefined, { staleTime: 5 * 60_000 });
}
export function useCaptionFonts() {
  return useIpcQuery('captions:fonts', undefined, { staleTime: 30 * 60_000 });
}

/** The style object for an id (undefined while loading or when the id no longer exists). */
export function useCaptionStyle(id: string | null | undefined): CaptionStyle | undefined {
  const q = useCaptionStyles();
  return React.useMemo(
    () => (id ? q.data?.styles.find((s) => s.id === id) : undefined),
    [q.data, id],
  );
}

const fail = (title: string) => (e: IpcCallError) => toast.error(title, { description: e.message });

export function useSaveCaptionStyle() {
  const qc = useQueryClient();
  return useMutation<CaptionStyle, IpcCallError, CaptionStyle>({
    mutationFn: (style) => invoke('captions:saveStyle', { style }),
    onSuccess: (saved) => {
      qc.setQueryData<StylesData>(ipcKey('captions:styles'), (old) => {
        const list = old?.styles ?? [];
        const at = list.findIndex((s) => s.id === saved.id);
        return { styles: at >= 0 ? list.map((s, i) => (i === at ? saved : s)) : [...list, saved] };
      });
    },
    onError: fail('Could not save the style'),
  });
}

export function useDeleteCaptionStyle() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { id: string; name?: string }>({
    mutationFn: ({ id }) => invoke('captions:deleteStyle', { id }),
    onSuccess: (_d, { id, name }) => {
      qc.setQueryData<StylesData>(ipcKey('captions:styles'), (old) =>
        old ? { styles: old.styles.filter((s) => s.id !== id) } : old,
      );
      toast.success(name ? `Deleted “${name}”` : 'Style deleted');
    },
    onError: fail('Could not delete the style'),
  });
}

/** Sets the style new clips of this video use (and that "Re-render" picks). */
export function useSetVideoCaptionStyle() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { id: string; styleId: string }>({
    mutationFn: (p) => invoke('videos:setCaptionStyle', p),
    onSuccess: (_d, { id, styleId }) => {
      const patch = (v: { id: string; options: { captionStyleId: string } }) =>
        v.id === id ? { ...v, options: { ...v.options, captionStyleId: styleId } } : v;
      qc.setQueriesData<{ items: { id: string; options: { captionStyleId: string } }[] }>(
        { queryKey: ['videos:list'] },
        (old) => (old ? { items: old.items.map(patch) } : old),
      );
      qc.setQueryData<{ video: { id: string; options: { captionStyleId: string } } }>(
        ipcKey('videos:get', { id }),
        (old) => (old ? { ...old, video: patch(old.video) } : old),
      );
    },
    onError: fail('Could not change the caption style'),
  });
}

/** Re-renders clips with another caption style and/or reframe mode. Clips show as queued immediately. */
export function useRestyleClips() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    IpcCallError,
    { ids: string[]; styleId?: string; reframeMode?: ReframeMode }
  >({
    mutationFn: (p) => invoke('clips:restyle', p),
    onSuccess: (_d, { ids, styleId, reframeMode }) => {
      const patch: Partial<ClipView> = { status: 'queued', renderProgress: null, error: null };
      if (styleId) patch.captionStyleId = styleId;
      if (reframeMode) patch.reframeMode = reframeMode;
      patchClipsInCache(qc, ids, patch);
    },
    onError: fail('Could not re-render the clips'),
  });
}

/* --------------------------------------------------------------- preview ---------------------------------------- */

export interface PreviewRequest {
  style: CaptionStyle;
  /** Sample text; undefined = main's default line. */
  text?: string;
  clipId?: string;
  aspect?: '9:16' | '1:1' | '4:5' | '16:9';
  /** Index of the highlighted (spoken) word. */
  activeWord?: number;
}
export interface PreviewImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** Everything that changes how a style looks; `id`, `name` and `builtin` do not, so renaming never re-renders. */
export function styleRenderKey(style: CaptionStyle): string {
  const { id: _id, name: _name, builtin: _builtin, ...rest } = style;
  void _id;
  void _name;
  void _builtin;
  return stableStringify(rest);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function previewKey(r: PreviewRequest): string {
  return [
    styleRenderKey(r.style),
    r.text ?? '',
    r.clipId ?? '',
    r.aspect ?? '9:16',
    r.activeWord ?? 1,
  ].join('|');
}

const CACHE_MAX = 120;
const cache = new Map<string, PreviewImage>();
const inflight = new Map<string, Promise<PreviewImage>>();

function remember(key: string, img: PreviewImage) {
  cache.delete(key);
  cache.set(key, img);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test/diagnostic hook: forget every cached render (e.g. after fonts change). */
export function clearPreviewCache() {
  cache.clear();
  inflight.clear();
}

export const peekPreview = (r: PreviewRequest): PreviewImage | undefined => cache.get(previewKey(r));

/** At most `limit` gallery thumbnails render at once; the live editor preview is never queued behind them. */
class Limiter {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((res) => this.waiting.push(res));
    this.running += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
export const TILE_CONCURRENCY = 2;
const tileLimiter = new Limiter(TILE_CONCURRENCY);

export function fetchPreview(r: PreviewRequest, lane: 'tile' | 'live'): Promise<PreviewImage> {
  const key = previewKey(r);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const running = inflight.get(key);
  if (running) return running;
  const exec = () =>
    invoke('captions:preview', {
      style: r.style,
      ...(r.text ? { text: r.text } : {}),
      ...(r.clipId ? { clipId: r.clipId } : {}),
      aspect: r.aspect ?? '9:16',
      activeWord: r.activeWord ?? 1,
    });
  const p = (lane === 'tile' ? tileLimiter.run(exec) : exec())
    .then((img) => {
      remember(key, img);
      return img;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface PreviewState {
  /** The image for the CURRENT request, or the previous one while the new one loads (check `stale`). */
  image: PreviewImage | null;
  /** True while `image` belongs to an earlier request. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Subscribes a component to a preview render. Pass `null` to pause (e.g. an invalid draft or an off-screen tile); the
 * last good image stays on screen so the editor never flashes empty.
 */
export function usePreview(request: PreviewRequest | null, lane: 'tile' | 'live'): PreviewState {
  const key = request ? previewKey(request) : null;
  const reqRef = React.useRef(request);
  React.useEffect(() => {
    reqRef.current = request;
  });
  const [last, setLast] = React.useState<{ key: string; image: PreviewImage } | null>(null);
  const [failed, setFailed] = React.useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const r = reqRef.current;
    if (!r || !key) return;
    if (cache.has(key)) return; // rendered from the cache during render
    let alive = true;
    fetchPreview(r, lane)
      .then((image) => {
        if (alive) setLast({ key, image });
      })
      .catch((e: unknown) => {
        if (alive)
          setFailed({ key, message: e instanceof Error ? e.message : 'The preview failed.' });
      });
    return () => {
      alive = false;
    };
  }, [key, lane, attempt]);

  const current = key && last?.key === key;
  const fromCache = key ? cache.get(key) : undefined;
  const image = fromCache ?? last?.image ?? null;
  return {
    image,
    stale: !!key && !fromCache && !current,
    loading: !!key && !fromCache && !current && failed?.key !== key,
    error: key && failed?.key === key ? failed.message : null,
    retry: () => {
      setFailed(null);
      setAttempt((n) => n + 1);
    },
  };
}

/* --------------------------------------------------------------- helpers ---------------------------------------- */

export function newCustomStyleId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `custom-${Date.now().toString(36)}-${rand}`;
}

/** Copy of a style as a custom preset (new id, never built-in). */
export function copyAsCustom(style: CaptionStyle, name?: string): CaptionStyle {
  return { ...style, id: newCustomStyleId(), name: (name ?? `${style.name} copy`).slice(0, 40), builtin: false };
}
