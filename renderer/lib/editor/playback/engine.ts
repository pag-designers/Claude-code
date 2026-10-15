import type { Project } from '@shared/editor';
import type { Waveform } from '@shared/editor';
import type { Compositor, CompositorExports } from '../compositor/api';
import type { EditorStore } from '../core/api';
import type { ThumbStrip } from './api';
import { AudioBuffers } from './audio-buffers';
import { AssetCaches, type DecodedImage, type ThumbPayload } from './caches';
import { MasterClock } from './clock';
import { FrameStats } from './frame-stats';
import { AudioMixer, type AudioGraphSnapshot } from './mixer';
import { MediaPool, type AssetStatus } from './pool';
import { upcomingVideoFrames } from './prefetch';
import type { EngineDebugState, PlaybackEngineExt, StoreLike } from './types';
import { PreviewUrls, type UrlResult } from './urls';

/**
 * The playback engine: glue between the editor store (transport + project), the compositor (picture), the media pool
 * (decoders) and the Web Audio mixer. See api.ts for the contract; the notes on sync live at the top of clock.ts,
 * seek-policy.ts and mixer.ts.
 *
 * Loop: one requestAnimationFrame loop that runs only while something needs it (playing, a pending redraw, frames
 * being waited for). While playing each frame (1) steps the master clock → `store.tick(dt)`, (2) syncs the mixer to the
 * playhead, (3) asks the compositor which frames it needs, lets the pool play/seek decoders accordingly, and (4) draws.
 * If a needed picture is not on a decoder yet, the previous frame stays on screen (at most MAX_WAIT_MS) — never blocks.
 */
export interface EngineEnv {
  perfNow(): number;
  raf(cb: (ts: number) => void): number;
  caf(handle: number): void;
  createAudioContext(): AudioContext | null;
  createVideo(): HTMLVideoElement;
  createImage(): HTMLImageElement;
  createAudio(): HTMLAudioElement;
  fetchText(url: string): Promise<string>;
  fetchArrayBuffer(url: string): Promise<ArrayBuffer>;
  decodeImage(dataUrl: string): Promise<DecodedImage>;
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface EngineIpc {
  previewUrl(projectId: string, assetId: string): Promise<UrlResult>;
  waveform(projectId: string, assetId: string): Promise<Waveform | null>;
  thumbStrip(
    projectId: string,
    assetId: string,
    startSec: number,
    endSec: number,
    count: number,
  ): Promise<ThumbPayload>;
  beats(projectId: string, assetId: string): Promise<number[]>;
}

export interface EngineDeps {
  store: StoreLike;
  projectId: string;
  ipc: EngineIpc;
  parseCube: CompositorExports['parseCube'];
  env: EngineEnv;
  /** Resolves when the compositor may draw its first frame (editor fonts loaded). Default: immediately. */
  ready?: Promise<unknown>;
  onDispose?(engine: PlaybackEngineExt): void;
}

const MAX_WAIT_MS = 250;
const PREFETCH_SEC = 0.75;

export class PlaybackEngineImpl implements PlaybackEngineExt {
  readonly projectId: string;
  private readonly store: StoreLike;
  private readonly env: EngineEnv;
  private readonly urls: PreviewUrls;
  private readonly pool: MediaPool;
  private readonly caches: AssetCaches;
  private readonly clock: MasterClock;
  private readonly stats = new FrameStats();
  private readonly beatsCache = new Map<string, Promise<number[]>>();
  private readonly statusListeners = new Set<() => void>();
  private mixer: AudioMixer | null = null;
  private buffers: AudioBuffers | null = null;
  private compositor: Compositor | null = null;
  private project: Project | null = null;
  private refs = 0;
  private unsub: (() => void) | null = null;
  private rafHandle = 0;
  private dirty = true;
  private inTick = false;
  private hasRendered = false;
  private missingSince: number | null = null;
  private skippedForMissing = 0;
  private renders = 0;
  private disposed = false;
  private lastPlaying = false;
  private lastRate = 1;
  private statusNotifyPending = false;
  private ready = false;

  constructor(private readonly deps: EngineDeps) {
    this.projectId = deps.projectId;
    this.store = deps.store;
    this.env = deps.env;
    this.urls = new PreviewUrls({
      fetch: (assetId) => deps.ipc.previewUrl(this.projectId, assetId),
      now: () => Date.now(),
      onChange: () => {
        this.notifyStatus();
        this.requestRender();
      },
    });
    this.pool = new MediaPool({
      createVideo: () => this.env.createVideo(),
      createImage: () => this.env.createImage(),
      urls: this.urls,
      requestRender: () => this.requestRender(),
      onStatus: () => this.notifyStatus(),
      fetchText: (u) => this.env.fetchText(u),
      parseCube: (t) => deps.parseCube(t),
      perfNow: () => this.env.perfNow(),
    });
    this.caches = new AssetCaches({
      fetchWaveform: (id) => deps.ipc.waveform(this.projectId, id),
      fetchThumbStrip: (id, s, e, c) => deps.ipc.thumbStrip(this.projectId, id, s, e, c),
      decodeImage: (u) => this.env.decodeImage(u),
      now: () => Date.now(),
    });
    const ready = deps.ready ?? Promise.resolve();
    void ready
      .catch(() => {})
      .then(() => {
        this.ready = true;
        this.requestRender();
      });
    this.clock = new MasterClock({
      perfNow: () => this.env.perfNow(),
      audioNow: () => {
        const c = this.mixer?.ctx;
        return c && c.state === 'running' ? c.currentTime : null;
      },
    });
  }

  /* ---------------------------------------------------------------- lifecycle ---------------- */

  attach(): () => void {
    if (this.disposed) return () => {};
    this.refs++;
    if (this.refs === 1) {
      this.unsub = this.store.subscribe((s, prev) => this.onStore(s, prev));
      this.onProject(this.store.getState().project);
      this.lastPlaying = this.store.getState().playing;
      this.lastRate = this.store.getState().rate;
      this.kick();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.refs = Math.max(0, this.refs - 1);
      if (this.refs === 0) this.detach();
    };
  }

  private detach(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.rafHandle) this.env.caf(this.rafHandle);
    this.rafHandle = 0;
    this.clock.stop();
    this.mixer?.stop();
    this.stats.gap();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.refs = 0;
    this.compositor = null;
    this.pool.dispose();
    this.urls.dispose();
    this.caches.dispose();
    this.buffers?.dispose();
    this.mixer?.dispose();
    this.mixer = null;
    this.statusListeners.clear();
    this.deps.onDispose?.(this);
  }

  /* ---------------------------------------------------------------- contract ----------------- */

  warmup(): void {
    const project = this.project ?? this.store.getState().project;
    this.pool.setProject(project);
    this.pool.warmup();
    for (const a of project.assets)
      if (a.kind === 'audio' || (a.kind === 'video' && a.hasAudio)) this.caches.waveform(a.id);
  }

  scrub(tSec: number): void {
    if (this.disposed) return;
    this.ensureMixer().scrub(tSec);
  }

  waveform(assetId: string): Waveform | null {
    return this.caches.waveform(assetId);
  }

  thumbStrip(assetId: string, startSec: number, endSec: number, count: number): ThumbStrip | null {
    return this.caches.thumbStrip(assetId, startSec, endSec, count);
  }

  onCacheChange(cb: () => void): () => void {
    return this.caches.onChange(cb);
  }

  /* ---------------------------------------------------------------- extended surface --------- */

  bindCompositor(compositor: Compositor | null): void {
    this.compositor = compositor;
    if (compositor && this.project) compositor.setProject(this.project);
    this.hasRendered = false;
    this.missingSince = null;
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
    this.kick();
  }

  assetStatus(assetId: string): AssetStatus {
    return this.pool.status(assetId);
  }

  assetStatuses(): Record<string, AssetStatus> {
    const out: Record<string, AssetStatus> = {};
    const project = this.project ?? this.store.getState().project;
    for (const a of project.assets) out[a.id] = this.pool.status(a.id);
    return out;
  }

  onStatusChange(cb: () => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  retryAsset(assetId: string): void {
    this.urls.retry(assetId);
    this.pool.reload(assetId);
    this.requestRender();
  }

  beats(assetId: string): Promise<number[]> {
    let p = this.beatsCache.get(assetId);
    if (!p) {
      p = this.deps.ipc.beats(this.projectId, assetId).catch(() => {
        this.beatsCache.delete(assetId);
        return [];
      });
      this.beatsCache.set(assetId, p);
    }
    return p;
  }

  resumeAudio(): Promise<void> {
    return this.ensureMixer().resume();
  }

  debugAudioGraph(): AudioGraphSnapshot | null {
    return this.mixer ? this.mixer.snapshot() : null;
  }

  debugReadPixels(): { width: number; height: number; data: Uint8Array } | null {
    return this.compositor ? this.compositor.readPixels() : null;
  }

  debugState(): EngineDebugState {
    const s = this.store.getState();
    return {
      attached: this.refs,
      playing: s.playing,
      playheadSec: s.playheadSec,
      clock: {
        running: this.clock.running,
        source: this.clock.source,
        driftSec: this.clock.driftSec,
      },
      render: {
        ...this.stats.summary(),
        skippedForMissing: this.skippedForMissing,
        renders: this.renders,
      },
      pool: this.pool.debug(),
      caches: this.caches.sizes,
      audio: { created: !!this.mixer, state: this.mixer ? this.mixer.ctx.state : null },
    };
  }

  /* ---------------------------------------------------------------- store → engine ----------- */

  private onStore(s: EditorStore, prev: EditorStore): void {
    if (s.project !== prev.project) this.onProject(s.project);
    if (s.playing !== prev.playing || s.rate !== prev.rate) this.onTransport(s);
    if (s.playheadSec !== prev.playheadSec) {
      this.dirty = true;
      // A seek while playing (timeline click, marker jump, loop wrap): the clock keeps going, the mixer re-anchors itself.
    }
    this.kick();
  }

  private onProject(project: Project): void {
    this.project = project;
    this.pool.setProject(project);
    this.compositor?.setProject(project);
    this.mixer?.setProject(project);
    this.pool.warmup();
    for (const a of project.assets)
      if (a.kind === 'audio' || (a.kind === 'video' && a.hasAudio)) this.caches.waveform(a.id);
    this.dirty = true;
  }

  private onTransport(s: EditorStore): void {
    if (s.playing && !this.lastPlaying) {
      this.ensureMixer();
      void this.mixer?.resume();
      this.clock.start();
      this.stats.gap();
    } else if (!s.playing && this.lastPlaying) {
      this.clock.stop();
      this.mixer?.stop();
      this.stats.gap();
    } else if (s.playing && s.rate !== this.lastRate) {
      this.clock.start();
    }
    this.lastPlaying = s.playing;
    this.lastRate = s.rate;
    this.dirty = true;
  }

  /* ---------------------------------------------------------------- audio -------------------- */

  private ensureMixer(): AudioMixer {
    if (this.mixer) return this.mixer;
    const ctx = this.env.createAudioContext();
    if (!ctx) throw new Error('Web Audio is not available');
    this.buffers = new AudioBuffers({
      decode: async (assetId) => {
        const u = this.urls.get(assetId);
        if (u.status !== 'ready') return null;
        const data = await this.env.fetchArrayBuffer(u.url);
        return ctx.decodeAudioData(data);
      },
      createBuffer: (ch, len, sr) => ctx.createBuffer(ch, len, sr),
      onReady: () => this.kick(),
    });
    this.mixer = new AudioMixer({
      ctx,
      createElement: () => this.env.createAudio(),
      urlFor: (id) => {
        const u = this.urls.get(id);
        return u.status === 'ready' ? u.url : null;
      },
      buffers: this.buffers,
      perfNow: () => this.env.perfNow(),
      setTimeout: (fn, ms) => this.env.setTimeout(fn, ms),
    });
    this.mixer.setProject(this.project ?? this.store.getState().project);
    return this.mixer;
  }

  /* ---------------------------------------------------------------- loop --------------------- */

  private kick(): void {
    if (this.rafHandle || this.refs === 0 || this.disposed) return;
    this.rafHandle = this.env.raf(this.frame);
  }

  private notifyStatus(): void {
    if (this.statusNotifyPending) return;
    this.statusNotifyPending = true;
    queueMicrotask(() => {
      this.statusNotifyPending = false;
      for (const l of [...this.statusListeners]) l();
    });
  }

  private readonly frame = (): void => {
    this.rafHandle = 0;
    if (this.refs === 0 || this.disposed) return;
    const t0 = this.env.perfNow();
    let s = this.store.getState();

    if (s.playing) {
      if (!this.clock.running) this.clock.start();
      const dt = this.clock.step();
      if (dt > 0) {
        this.inTick = true;
        try {
          s.tick(dt);
        } finally {
          this.inTick = false;
        }
        s = this.store.getState();
      }
      if (!s.playing) {
        // reached the end (or a loop-less stop)
        this.clock.stop();
        this.mixer?.stop();
        this.lastPlaying = false;
      }
      this.stats.tick(t0);
      this.dirty = true;
    } else if (this.clock.running) {
      this.clock.stop();
    }

    if (this.mixer || s.playing) {
      const a0 = this.env.perfNow();
      this.mixer?.sync({ tSec: s.playheadSec, playing: s.playing, rate: s.rate });
      this.stats.section('mixer', this.env.perfNow() - a0);
    }

    if (this.dirty && this.compositor) this.renderFrame(s, t0);
    else if (!s.playing) this.dirty = false;

    if (s.playing || this.dirty) this.kick();
  };

  private renderFrame(s: EditorStore, t0: number): void {
    if (!this.ready) {
      this.dirty = false; // requestRender() fires when the fonts are in
      return;
    }
    const comp = this.compositor as Compositor;
    const project = this.project ?? s.project;
    const t = s.playheadSec;
    const m0 = this.env.perfNow();
    const reqs = comp.framesNeeded(t);
    const visible = new Set(reqs.map((r) => r.itemId));
    const upcoming = upcomingVideoFrames(
      project,
      t,
      s.rate === 0 ? 1 : s.rate,
      PREFETCH_SEC,
      visible,
    );
    const m1 = this.env.perfNow();
    this.pool.update({
      project,
      tSec: t,
      playing: s.playing,
      rate: s.rate,
      requests: reqs,
      upcoming,
    });
    const missing = this.pool.missing(reqs);
    const now = this.env.perfNow();
    this.stats.section('framesNeeded', m1 - m0);
    this.stats.section('pool', now - m1);
    if (missing.length) {
      if (this.missingSince === null) this.missingSince = now;
      if (this.hasRendered && now - this.missingSince < MAX_WAIT_MS) {
        this.skippedForMissing++;
        this.dirty = true; // try again next frame; the previous picture stays on screen
        return;
      }
    } else this.missingSince = null;
    comp.render(t, this.pool.frameSource);
    this.stats.section('compositor', this.env.perfNow() - now);
    this.hasRendered = true;
    this.renders++;
    this.stats.render(this.env.perfNow() - t0);
    // Missing frames after the wait: show what we have and draw again as soon as a decoder reports a frame.
    this.dirty = s.playing;
    if (missing.length) this.missingSince = null;
  }
}
