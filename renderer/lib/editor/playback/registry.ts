import { invoke } from '@/lib/ipc';
import { PlaybackEngineImpl, type EngineDeps, type EngineEnv } from './engine';
import { parseCube, useEditorStore } from './link';
import type { PlaybackEngineExt } from './types';

/** Browser implementation of the engine's environment (everything that touches `window` / `document`). */
export function browserEnv(): EngineEnv {
  return {
    perfNow: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (h) => cancelAnimationFrame(h),
    createAudioContext: () => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
    },
    createVideo: () => document.createElement('video'),
    createImage: () => new Image(),
    createAudio: () => document.createElement('audio'),
    fetchText: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    fetchArrayBuffer: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    },
    decodeImage: async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      return typeof createImageBitmap === 'function' ? createImageBitmap(img) : img;
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  };
}

/** IPC-backed implementation of the engine's data access (`editor:previewUrl|waveform|thumbStrip|beats`). */
export function ipcBackend(): EngineDeps['ipc'] {
  return {
    previewUrl: (projectId, assetId) => invoke('editor:previewUrl', { projectId, assetId }),
    waveform: (projectId, assetId) => invoke('editor:waveform', { projectId, assetId }),
    thumbStrip: (projectId, assetId, startSec, endSec, count) =>
      invoke('editor:thumbStrip', { projectId, assetId, startSec, endSec, count, height: 64 }),
    beats: async (projectId, assetId) =>
      (await invoke('editor:beats', { projectId, assetId })).beats,
  };
}

let current: PlaybackEngineExt | null = null;

/** The live engine (null before the editor mounted). */
export function getEngine(): PlaybackEngineExt | null {
  return current;
}

/**
 * Creates the engine for a project and makes it THE engine (`getEngine()`); a previous engine is disposed. The caller
 * calls `attach()` (the preview panel does it while mounted).
 */
export function createPlaybackEngine(opts: { projectId: string }): PlaybackEngineExt {
  current?.dispose();
  const engine = new PlaybackEngineImpl({
    store: useEditorStore,
    projectId: opts.projectId,
    ipc: ipcBackend(),
    parseCube,
    env: browserEnv(),
    onDispose: (e) => {
      if (current === e) current = null;
    },
  });
  current = engine;
  return engine;
}
