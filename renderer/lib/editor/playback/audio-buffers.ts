import type { Project } from '@shared/editor';
import { LruCache } from './lru';
import { reverseWindow, type MediaItem } from './mixer-math';

/**
 * Decoded-audio store for the mixer: whole-asset AudioBuffers (reverse playback, extreme speeds, scrub grains) and
 * time-reversed windows cut from them. Decoding is on demand, cached with a byte cap, and reversed windows that no item
 * references any more are freed when the project changes.
 */
export interface AudioBuffersDeps {
  /** Fetches and decodes an asset's audio, or null when unavailable. */
  decode(assetId: string): Promise<AudioBuffer | null>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  /** A buffer became available: the mixer should re-evaluate. */
  onReady(): void;
  /** Assets longer than this are never decoded (memory). Default 900 s. */
  maxDecodeSec?: number;
  maxAssetBytes?: number;
  maxReversedBytes?: number;
}

const bytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

export const reversedKey = (assetId: string, startSrc: number, endSrc: number): string =>
  `${assetId}|${startSrc.toFixed(3)}|${endSrc.toFixed(3)}`;

export class AudioBuffers {
  private readonly full: LruCache<string, AudioBuffer>;
  private readonly reversed: LruCache<string, AudioBuffer>;
  private readonly pendingFull = new Map<string, Promise<AudioBuffer | null>>();
  private readonly failed = new Set<string>();
  private readonly wantedReversed = new Map<
    string,
    { assetId: string; startSrc: number; endSrc: number }
  >();
  private durations = new Map<string, number | null>();
  private disposed = false;

  constructor(private readonly deps: AudioBuffersDeps) {
    this.full = new LruCache({
      maxEntries: 64,
      maxCost: deps.maxAssetBytes ?? 192 * 1024 * 1024,
      cost: bytes,
    });
    this.reversed = new LruCache({
      maxEntries: 64,
      maxCost: deps.maxReversedBytes ?? 128 * 1024 * 1024,
      cost: bytes,
    });
  }

  get stats(): { assets: number; reversed: number; bytes: number } {
    return {
      assets: this.full.size,
      reversed: this.reversed.size,
      bytes: this.full.totalCost + this.reversed.totalCost,
    };
  }

  canDecode(assetId: string): boolean {
    if (this.failed.has(assetId)) return false;
    const d = this.durations.get(assetId);
    return d === undefined || d === null || d <= (this.deps.maxDecodeSec ?? 900);
  }

  peekAsset(assetId: string): AudioBuffer | null {
    return this.full.get(assetId) ?? null;
  }

  requestAsset(assetId: string): void {
    if (
      this.disposed ||
      this.full.has(assetId) ||
      this.pendingFull.has(assetId) ||
      !this.canDecode(assetId)
    )
      return;
    const p = this.deps
      .decode(assetId)
      .catch(() => null)
      .then((buf) => {
        this.pendingFull.delete(assetId);
        if (this.disposed) return null;
        if (!buf) {
          this.failed.add(assetId);
          return null;
        }
        this.full.set(assetId, buf);
        this.buildPendingReversed(assetId);
        this.deps.onReady();
        return buf;
      });
    this.pendingFull.set(assetId, p);
  }

  peekReversed(assetId: string, startSrc: number, endSrc: number): AudioBuffer | null {
    return this.reversed.get(reversedKey(assetId, startSrc, endSrc)) ?? null;
  }

  requestReversed(assetId: string, startSrc: number, endSrc: number): void {
    const key = reversedKey(assetId, startSrc, endSrc);
    if (this.reversed.has(key)) return;
    this.wantedReversed.set(key, { assetId, startSrc, endSrc });
    if (this.full.has(assetId)) this.buildPendingReversed(assetId);
    else this.requestAsset(assetId);
  }

  /** Housekeeping on project change: free reversed windows and decoded assets that nothing references any more. */
  setProject(project: Pick<Project, 'tracks' | 'assets'>): void {
    this.durations = new Map(project.assets.map((a) => [a.id, a.durationSec] as const));
    const assetById = new Map(project.assets.map((a) => [a.id, a] as const));
    const keepRev = new Set<string>();
    const usedAssets = new Set<string>();
    for (const tr of project.tracks)
      for (const it of tr.items) {
        if (it.type !== 'video' && it.type !== 'audio') continue;
        usedAssets.add(it.assetId);
        if (it.reverse) {
          const w = reverseWindow(it as MediaItem, assetById.get(it.assetId)?.durationSec ?? null);
          keepRev.add(reversedKey(it.assetId, w.startSrc, w.endSrc));
        }
      }
    this.reversed.retain((k) => keepRev.has(k));
    for (const k of [...this.wantedReversed.keys()])
      if (!keepRev.has(k)) this.wantedReversed.delete(k);
    this.full.retain((id) => usedAssets.has(id));
    for (const id of [...this.failed]) if (!usedAssets.has(id)) this.failed.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    this.full.clear();
    this.reversed.clear();
    this.wantedReversed.clear();
  }

  private buildPendingReversed(assetId: string): void {
    const src = this.full.peek(assetId);
    if (!src) return;
    for (const [key, w] of [...this.wantedReversed]) {
      if (w.assetId !== assetId) continue;
      this.wantedReversed.delete(key);
      const rb = this.cutReversed(src, w.startSrc, w.endSrc);
      if (rb) this.reversed.set(key, rb);
    }
  }

  private cutReversed(src: AudioBuffer, startSrc: number, endSrc: number): AudioBuffer | null {
    const sr = src.sampleRate;
    const a = Math.max(0, Math.floor(startSrc * sr));
    const b = Math.min(src.length, Math.ceil(endSrc * sr));
    const n = b - a;
    if (n <= 0) return null;
    const out = this.deps.createBuffer(src.numberOfChannels, n, sr);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      const from = src.getChannelData(ch);
      const to = out.getChannelData(ch);
      for (let i = 0; i < n; i++) to[i] = from[b - 1 - i] as number;
    }
    return out;
  }
}
