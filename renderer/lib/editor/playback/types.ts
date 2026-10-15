import type { EditorStore } from '../core/api';
import type { Compositor } from '../compositor/api';
import type { PlaybackEngine } from './api';
import type { AudioGraphSnapshot } from './mixer';
import type { FrameSummary } from './frame-stats';
import type { AssetStatus, PoolSlotDebug } from './pool';

/** The slice of the zustand store the engine needs (so tests can pass a plain fake). */
export interface StoreLike {
  getState(): EditorStore;
  subscribe(listener: (state: EditorStore, prev: EditorStore) => void): () => void;
}

export interface EngineDebugState {
  attached: number;
  playing: boolean;
  playheadSec: number;
  clock: { running: boolean; source: 'audio' | 'perf'; driftSec: number };
  render: FrameSummary & { skippedForMissing: number; renders: number };
  pool: PoolSlotDebug[];
  caches: { waveforms: number; strips: number };
  audio: { created: boolean; state: string | null };
}

/** The engine as the preview panel and the tests see it: the public contract plus the editor-internal surface. */
export interface PlaybackEngineExt extends PlaybackEngine {
  readonly projectId: string;
  /** Hand the engine the preview's compositor (null on unmount). The engine owns `setProject` on it. */
  bindCompositor(compositor: Compositor | null): void;
  /** A frame is wanted even though the transport is paused (resize, overlay edit…). */
  requestRender(): void;
  assetStatus(assetId: string): AssetStatus;
  /** Statuses of every asset the project references. */
  assetStatuses(): Record<string, AssetStatus>;
  /** Fires when any asset's loading status changes. */
  onStatusChange(cb: () => void): () => void;
  /** Re-fetch the preview URL of an asset and reload it (the error state's Retry). */
  retryAsset(assetId: string): void;
  /** Beat times of an audio/video asset in asset time (cached). */
  beats(assetId: string): Promise<number[]>;
  /** Resume the AudioContext (call from a user gesture when the browser suspended it). */
  resumeAudio(): Promise<void>;
  /** Test / diagnostics: the live Web Audio graph and the gains the scheduling maths expects. null before audio started. */
  debugAudioGraph(): AudioGraphSnapshot | null;
  debugState(): EngineDebugState;
  /** Test / diagnostics: the compositor's last rendered frame (RGBA, preview size), or null when no compositor is bound. */
  debugReadPixels(): { width: number; height: number; data: Uint8Array } | null;
}
