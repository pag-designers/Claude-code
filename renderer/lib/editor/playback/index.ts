/**
 * Playback engine (CP3): media pool, master clock, Web Audio mixer, waveform / thumbnail caches and the preview panel.
 * Contract: ./api.ts. Everything the editor shell and the timeline need is exported from here.
 */
export { createPlaybackEngine, getEngine } from './registry';
export { PreviewPlayer } from '@/components/editor/preview/preview-player';
export type { PlaybackEngine, PlaybackExports, ThumbStrip } from './api';
export type { PlaybackEngineExt, EngineDebugState } from './types';
export type { AudioGraphSnapshot } from './mixer';
export type { AssetStatus } from './pool';
