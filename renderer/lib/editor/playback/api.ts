/**
 * CP3 PLAYBACK ENGINE CONTRACT. Owned by the lead; implemented by the `editor-playback` agent in
 * renderer/lib/editor/playback/*, exported from '@/lib/editor/playback'. It is the glue between the store (transport,
 * project), the compositor (picture) and Web Audio (sound):
 *   - a pool of HTMLVideoElement / HTMLAudioElement / Image per asset, loaded from presigned URLs (`editor:previewUrl`),
 *     seeked to the SOURCE times the compositor asks for (speed, reverse, freeze via shared/editor-eval `makeSourceTime`);
 *   - the master clock: while playing, `store.tick(dt)` is driven by rAF; audio is scheduled against it; picture follows;
 *   - Web Audio mixer: per audio-bearing item gain = itemGainAt × track gain × ducking (`duckGainAt` over `speechRanges`),
 *     mute/solo-by-hidden semantics, playbackRate for speed (preservePitch on `preservesPitch`), reverse by playing a decoded
 *     reversed AudioBuffer (decode on demand, cache), audio scrub (short grains while dragging the playhead);
 *   - waveform + thumbnail-strip caches (IPC `editor:waveform`, `editor:thumbStrip`) with a small LRU;
 *   - a React component <PreviewPlayer/> that owns the preview <canvas>, sizes it to the container with the project's aspect,
 *     draws overlays (safe-area guides, grid, transform handles via compositor.handlesFor/computeDrag, snap guides), and
 *     forwards pointer edits to the store (`setProp` on transform.*, one undo step per drag).
 * It must stay at ~60 fps for a 1080×1920 canvas drawn at ≤ 540×960 with 3–4 simultaneous layers on a laptop GPU.
 */
import type { Waveform } from '@shared/editor';

export interface PlaybackEngine {
  /** Bind to the store (subscribes to project/transport changes). Returns an unsubscribe/cleanup function. */
  attach(): () => void;
  /** Ensure all media for the project is loading (call after project load / asset import). */
  warmup(): void;
  /** Audio scrub: play a short grain at timeline time t (called while the user drags the playhead). */
  scrub(tSec: number): void;
  /** Waveform for an asset (cached; null while loading / unavailable). */
  waveform(assetId: string): Waveform | null;
  /** Thumbnail sprite for a video asset range (cached). */
  thumbStrip(assetId: string, startSec: number, endSec: number, count: number): ThumbStrip | null;
  /** Subscribe to cache changes (waveform / strip arrived) so the timeline re-renders. */
  onCacheChange(cb: () => void): () => void;
  dispose(): void;
}

export interface ThumbStrip {
  /** Sprite as an ImageBitmap/HTMLImageElement + tile geometry (tile i is at col = i % cols, row = floor(i / cols)). */
  image: CanvasImageSource;
  tileW: number;
  tileH: number;
  cols: number;
  times: number[];
}

export interface PlaybackExports {
  createPlaybackEngine(opts: { projectId: string }): PlaybackEngine;
  /** The preview panel. */
  PreviewPlayer: React.ComponentType<{ className?: string }>;
  /** Singleton access for the timeline (waveform/thumbnails); null before the editor mounted. */
  getEngine(): PlaybackEngine | null;
}
