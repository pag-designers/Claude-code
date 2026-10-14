import type { Waveform } from '@shared/editor';
import { LruCache } from './lru';
import type { ThumbStrip } from './api';

/**
 * Waveform + thumbnail-strip caches (LRU, IPC-backed). `get` returns what is cached or null and starts the fetch; the
 * `onChange` listeners fire (coalesced) when something arrives so the timeline re-renders. Thumbnail requests are
 * quantised to 0.1 s so zooming/scrolling doesn't spray near-identical requests, and run with a small concurrency limit,
 * newest request first (the one the user is looking at).
 */
export interface ThumbPayload {
  dataUrl: string | null;
  tileW: number;
  tileH: number;
  cols: number;
  times: number[];
}

export type DecodedImage = CanvasImageSource & {
  close?: () => void;
  width?: number;
  height?: number;
};

export interface AssetCachesDeps {
  fetchWaveform(assetId: string): Promise<Waveform | null>;
  fetchThumbStrip(
    assetId: string,
    startSec: number,
    endSec: number,
    count: number,
  ): Promise<ThumbPayload>;
  decodeImage(dataUrl: string): Promise<DecodedImage>;
  now(): number;
  /** Coalesce notifications (queueMicrotask / rAF). Default: queueMicrotask. */
  schedule?(fn: () => void): void;
  maxWaveforms?: number;
  maxStrips?: number;
  maxConcurrentThumbs?: number;
  /** A failed fetch is retried no sooner than this. Default 8 s. */
  retryAfterMs?: number;
}

export class AssetCaches {
  private readonly waves: LruCache<string, Waveform>;
  private readonly strips: LruCache<string, ThumbStrip>;
  private readonly waveInflight = new Set<string>();
  private readonly stripInflight = new Set<string>();
  private readonly failedUntil = new Map<string, number>();
  private readonly queue: { key: string; run: () => Promise<void> }[] = [];
  private running = 0;
  private readonly listeners = new Set<() => void>();
  private notifyPending = false;
  private disposed = false;
  private generation = 0;
  private readonly maxConcurrent: number;
  private readonly retryAfter: number;

  constructor(private readonly deps: AssetCachesDeps) {
    this.waves = new LruCache({ maxEntries: deps.maxWaveforms ?? 64 });
    this.strips = new LruCache({
      maxEntries: deps.maxStrips ?? 48,
      onEvict: (_k, v) => (v.image as DecodedImage).close?.(),
    });
    this.maxConcurrent = deps.maxConcurrentThumbs ?? 2;
    this.retryAfter = deps.retryAfterMs ?? 8000;
  }

  /** Waveform peaks, or null while loading / unavailable. */
  waveform(assetId: string): Waveform | null {
    const hit = this.waves.get(assetId);
    if (hit) return hit;
    if (!this.waveInflight.has(assetId) && !this.isCoolingDown(`w|${assetId}`)) {
      this.waveInflight.add(assetId);
      const gen = this.generation;
      void this.deps
        .fetchWaveform(assetId)
        .then(
          (w) => w,
          () => null,
        )
        .then((w) => {
          this.waveInflight.delete(assetId);
          if (this.disposed || gen !== this.generation) return;
          if (w) this.waves.set(assetId, w);
          else this.failedUntil.set(`w|${assetId}`, this.deps.now() + this.retryAfter);
          this.notify();
        });
    }
    return null;
  }

  thumbStrip(assetId: string, startSec: number, endSec: number, count: number): ThumbStrip | null {
    const q = quantizeRange(startSec, endSec, count);
    const key = stripKey(assetId, q.start, q.end, q.count);
    const hit = this.strips.get(key);
    if (hit) return hit;
    if (!this.stripInflight.has(key) && !this.isCoolingDown(key)) {
      this.stripInflight.add(key);
      const gen = this.generation;
      this.queue.push({
        key,
        run: async () => {
          try {
            const p = await this.deps.fetchThumbStrip(assetId, q.start, q.end, q.count);
            if (!p.dataUrl) throw new Error('no strip');
            const image = await this.deps.decodeImage(p.dataUrl);
            if (this.disposed || gen !== this.generation) {
              image.close?.();
              return;
            }
            this.strips.set(key, {
              image,
              tileW: p.tileW,
              tileH: p.tileH,
              cols: p.cols,
              times: p.times,
            });
            this.notify();
          } catch {
            this.failedUntil.set(key, this.deps.now() + this.retryAfter);
          } finally {
            this.stripInflight.delete(key);
          }
        },
      });
      this.pump();
    }
    return null;
  }

  /** Forget everything cached for an asset (re-imported / replaced). */
  invalidate(assetId: string): void {
    this.waves.delete(assetId);
    this.strips.retain((k) => !k.startsWith(`${assetId}|`));
    this.notify();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get sizes(): { waveforms: number; strips: number } {
    return { waveforms: this.waves.size, strips: this.strips.size };
  }

  clear(): void {
    this.generation++;
    this.waves.clear();
    this.strips.clear();
    this.queue.length = 0;
    this.stripInflight.clear();
    this.waveInflight.clear();
    this.failedUntil.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.listeners.clear();
  }

  private isCoolingDown(key: string): boolean {
    const until = this.failedUntil.get(key);
    if (until === undefined) return false;
    if (this.deps.now() >= until) {
      this.failedUntil.delete(key);
      return false;
    }
    return true;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const job = this.queue.pop(); // newest first
      if (!job) break;
      this.running++;
      void job.run().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private notify(): void {
    if (this.notifyPending || this.disposed) return;
    this.notifyPending = true;
    (this.deps.schedule ?? queueMicrotask)(() => {
      this.notifyPending = false;
      for (const l of [...this.listeners]) l();
    });
  }
}

/** Quantise a strip request to 0.1 s so near-identical requests share an entry. */
export function quantizeRange(
  startSec: number,
  endSec: number,
  count: number,
): { start: number; end: number; count: number } {
  const start = Math.max(0, Math.floor(startSec * 10 + 1e-6) / 10);
  const end = Math.max(start + 0.1, Math.ceil(endSec * 10 - 1e-6) / 10);
  return { start, end, count: Math.max(1, Math.min(60, Math.round(count))) };
}

export const stripKey = (assetId: string, start: number, end: number, count: number): string =>
  `${assetId}|${start.toFixed(1)}|${end.toFixed(1)}|${count}`;
