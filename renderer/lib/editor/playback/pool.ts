import type { Asset, Project } from '@shared/editor';
import type { FrameRequest, FrameSource } from '../compositor/api';
import type { UpcomingFrame } from './prefetch';
import {
  DEFAULT_SEEK_CONFIG,
  planVideoSync,
  staleToleranceSec,
  type SeekPlan,
  type SeekWant,
} from './seek-policy';
import { clampToAsset, isMediaItem, sourceRateAt } from './src-time';
import type { PreviewUrls } from './urls';
import { findItem } from '@shared/editor-eval';

/**
 * Media pool: the picture side of playback. One <video> per decoder slot (muted — sound goes through Web Audio), at most
 * `maxPerAsset` (3) slots per video asset so split-screens and transitions between two cuts of one source get
 * independent decoders; <img> for images; parsed .cube LUTs. Slots are owned by ITEM id (sticky), so each visible item
 * keeps its own decoder across frames; spare slots are pre-seeked to upcoming cuts.
 *
 * `update()` runs once per rendered frame: it assigns slots to the compositor's FrameRequests, applies the seek policy
 * (play vs. seek) and rebuilds the FrameSource the compositor reads.
 */
export interface PoolDeps {
  createVideo(): HTMLVideoElement;
  createImage(): HTMLImageElement;
  urls: Pick<PreviewUrls, 'get' | 'invalidate'>;
  /** A frame/asset became available: schedule a render. */
  requestRender(): void;
  /** Loading status of some asset changed. */
  onStatus(): void;
  fetchText(url: string): Promise<string>;
  parseCube(text: string): { size: number; data: Float32Array };
  perfNow(): number;
  maxPerAsset?: number;
  maxTotal?: number;
}

export interface UpdateArgs {
  project: Pick<Project, 'tracks' | 'assets'>;
  tSec: number;
  playing: boolean;
  /** Transport rate (J/K/L). */
  rate: number;
  requests: readonly FrameRequest[];
  upcoming: readonly UpcomingFrame[];
}

export type AssetStatus =
  | { state: 'loading'; reason: null }
  | { state: 'ready'; reason: null }
  | { state: 'error'; reason: string | null };

interface Slot {
  id: number;
  assetId: string;
  el: HTMLVideoElement;
  key: string | null;
  usedFrame: number;
  loadedVersion: number;
  inFlight: number | null;
  deferred: number | null;
  errors: number;
  failed: boolean;
  /** rVFC bookkeeping (diagnostics + "a new frame is on screen" notifications). */
  presentedMediaTime: number | null;
  presentedFrames: number;
  rvfcHandle: number | null;
  lastWant: SeekWant | null;
  lastPlan: SeekPlan | null;
  dispose(): void;
}

interface FrameEntry {
  assetId: string;
  srcSec: number;
  slot: Slot;
  tol: number;
}

interface ImageRec {
  img: HTMLImageElement;
  loadedVersion: number;
  state: 'loading' | 'ready' | 'error';
  errors: number;
}

interface LutRec {
  state: 'loading' | 'ready' | 'error';
  lut: { size: number; data: Float32Array } | null;
  version: number;
}

export interface PoolSlotDebug {
  assetId: string;
  itemId: string | null;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  readyState: number;
  seeking: boolean;
  mode: string | null;
  drift: number | null;
  presentedMediaTime: number | null;
  presentedFrames: number;
}

export class MediaPool {
  private readonly slots = new Map<string, Slot[]>();
  private readonly images = new Map<string, ImageRec>();
  private readonly luts = new Map<string, LutRec>();
  private assets = new Map<string, Asset>();
  private frameMap: FrameEntry[] = [];
  private imageIds = new Set<string>();
  private frameCounter = 0;
  private nextSlotId = 1;
  private lastStatusSig = '';
  private disposed = false;
  private readonly maxPerAsset: number;
  private readonly maxTotal: number;

  readonly frameSource: FrameSource;

  constructor(private readonly deps: PoolDeps) {
    this.maxPerAsset = deps.maxPerAsset ?? 3;
    this.maxTotal = deps.maxTotal ?? 10;
    this.frameSource = {
      video: (assetId, srcSec) => this.videoFrame(assetId, srcSec),
      image: (assetId) => this.imageFrame(assetId),
      lut: (assetId) => this.lutFor(assetId),
    };
  }

  /* ---------------------------------------------------------------- project / warmup --------- */

  setProject(project: Pick<Project, 'assets'>): void {
    this.assets = new Map(project.assets.map((a) => [a.id, a] as const));
    for (const [assetId, list] of [...this.slots]) {
      if (this.assets.get(assetId)?.kind === 'video') continue;
      for (const s of list) s.dispose();
      this.slots.delete(assetId);
    }
    for (const [assetId, rec] of [...this.images])
      if (!this.assets.has(assetId)) {
        rec.img.removeAttribute('src');
        this.images.delete(assetId);
      }
  }

  /** Start loading everything the project references. */
  warmup(): void {
    for (const a of this.assets.values()) {
      if (a.kind === 'video') {
        const list = this.slots.get(a.id);
        if (!list?.length) this.acquire(a.id, null, new Set());
        else this.ensureSrc(list[0] as Slot, false);
      } else if (a.kind === 'image') this.ensureImage(a.id);
      else if (a.kind === 'lut') this.lutFor(a.id);
      else this.deps.urls.get(a.id);
    }
    this.publishStatus();
  }

  /* ---------------------------------------------------------------- per-frame ---------------- */

  update(args: UpdateArgs): void {
    this.frameCounter++;
    const { project, tSec, playing, rate } = args;
    const needed = new Set<string>();
    for (const r of args.requests) needed.add(r.itemId);
    for (const u of args.upcoming) needed.add(u.itemId);
    const map: FrameEntry[] = [];
    for (const req of args.requests) {
      const asset = this.assets.get(req.assetId);
      if (!asset) continue;
      if (asset.kind === 'image') {
        this.ensureImage(asset.id);
        continue;
      }
      if (asset.kind !== 'video') continue;
      const slot = this.acquire(asset.id, req.itemId, needed);
      if (!slot) continue;
      slot.usedFrame = this.frameCounter;
      const found = findItem(project, req.itemId);
      const item = found && isMediaItem(found.item) ? found.item : null;
      const srcRate = item ? sourceRateAt(item, tSec, rate) : 0;
      const frameSec = 1 / Math.max(1, asset.fps ?? 30);
      const srcSec = clampToAsset(req.srcSec, asset.durationSec);
      this.drive(slot, { srcSec, rate: srcRate, playing, frameSec, inFlight: slot.inFlight });
      map.push({
        assetId: asset.id,
        srcSec: req.srcSec,
        slot,
        tol: staleToleranceSec(srcRate, playing, frameSec),
      });
    }
    for (const u of args.upcoming) {
      const asset = this.assets.get(u.assetId);
      if (!asset || asset.kind !== 'video') continue;
      const slot = this.acquire(asset.id, u.itemId, needed);
      if (!slot) continue;
      slot.usedFrame = this.frameCounter;
      const frameSec = 1 / Math.max(1, asset.fps ?? 30);
      this.drive(slot, {
        srcSec: clampToAsset(u.srcSec, asset.durationSec),
        rate: 0,
        playing: false,
        frameSec,
        inFlight: slot.inFlight,
      });
    }
    this.frameMap = map;
    // park slots nobody asked for
    for (const list of this.slots.values())
      for (const s of list) {
        if (s.usedFrame !== this.frameCounter && !s.el.paused) {
          s.el.pause();
        }
      }
    this.publishStatus();
  }

  /** Requests whose picture is not on a decoder yet (the host keeps the previous frame while any are missing). */
  missing(requests: readonly FrameRequest[]): FrameRequest[] {
    const out: FrameRequest[] = [];
    for (const r of requests) {
      const asset = this.assets.get(r.assetId);
      if (!asset) continue;
      if (asset.kind === 'image') {
        if (!this.imageFrame(asset.id)) out.push(r);
      } else if (asset.kind === 'video') {
        if (!this.videoFrame(r.assetId, r.srcSec)) out.push(r);
      }
    }
    return out;
  }

  status(assetId: string): AssetStatus {
    const asset = this.assets.get(assetId);
    const u = this.deps.urls.get(assetId);
    if (u.status === 'error') return { state: 'error', reason: u.reason };
    if (u.status === 'loading') return { state: 'loading', reason: null };
    if (!asset) return { state: 'ready', reason: null };
    if (asset.kind === 'video') {
      const list = this.slots.get(assetId) ?? [];
      if (list.some((s) => s.failed) && !list.some((s) => s.el.readyState >= 2))
        return { state: 'error', reason: 'the media could not be decoded' };
      return list.some((s) => s.el.readyState >= 2)
        ? { state: 'ready', reason: null }
        : { state: 'loading', reason: null };
    }
    if (asset.kind === 'image') {
      const rec = this.images.get(assetId);
      if (rec?.state === 'error')
        return { state: 'error', reason: 'the image could not be loaded' };
      return rec?.state === 'ready'
        ? { state: 'ready', reason: null }
        : { state: 'loading', reason: null };
    }
    if (asset.kind === 'lut') {
      const rec = this.luts.get(assetId);
      if (rec?.state === 'error') return { state: 'error', reason: 'the LUT could not be read' };
      return rec?.state === 'ready'
        ? { state: 'ready', reason: null }
        : { state: 'loading', reason: null };
    }
    return { state: 'ready', reason: null };
  }

  debug(): PoolSlotDebug[] {
    const out: PoolSlotDebug[] = [];
    for (const list of this.slots.values())
      for (const s of list)
        out.push({
          assetId: s.assetId,
          itemId: s.key,
          currentTime: s.el.currentTime,
          paused: s.el.paused,
          playbackRate: s.el.playbackRate,
          readyState: s.el.readyState,
          seeking: s.el.seeking,
          mode: s.lastPlan?.mode ?? null,
          drift: s.lastPlan?.drift ?? null,
          presentedMediaTime: s.presentedMediaTime,
          presentedFrames: s.presentedFrames,
        });
    return out;
  }

  slotCount(assetId?: string): number {
    if (assetId) return this.slots.get(assetId)?.length ?? 0;
    let n = 0;
    for (const l of this.slots.values()) n += l.length;
    return n;
  }

  /** The media URL went stale / the user pressed retry: reload every decoder of the asset. */
  reload(assetId: string): void {
    for (const s of this.slots.get(assetId) ?? []) {
      s.failed = false;
      s.errors = 0;
      s.loadedVersion = -1;
    }
    const rec = this.images.get(assetId);
    if (rec) {
      rec.state = 'loading';
      rec.errors = 0;
      rec.loadedVersion = -1;
    }
    const lut = this.luts.get(assetId);
    if (lut) this.luts.delete(assetId);
  }

  dispose(): void {
    this.disposed = true;
    for (const list of this.slots.values()) for (const s of list) s.dispose();
    this.slots.clear();
    for (const rec of this.images.values()) rec.img.removeAttribute('src');
    this.images.clear();
    this.luts.clear();
    this.frameMap = [];
  }

  /* ---------------------------------------------------------------- FrameSource -------------- */

  private videoFrame(assetId: string, srcSec: number): CanvasImageSource | null {
    let best: FrameEntry | null = null;
    let bd = Infinity;
    for (const e of this.frameMap) {
      if (e.assetId !== assetId) continue;
      const d = Math.abs(e.srcSec - srcSec);
      if (d < bd) {
        best = e;
        bd = d;
      }
    }
    // The compositor asks with the exact times it got from framesNeeded; anything else belongs to a request with no decoder.
    if (!best || bd > 0.05) return null;
    const el = best.slot.el;
    if (el.readyState < 2 || el.videoWidth === 0) return null;
    // A decoder that is still far from the wanted time would show the wrong picture: report "not ready" instead.
    if (Math.abs(el.currentTime - best.srcSec) > best.tol) return null;
    return el;
  }

  private imageFrame(assetId: string): CanvasImageSource | null {
    const rec = this.images.get(assetId);
    if (!rec || rec.state !== 'ready') {
      if (!rec) this.ensureImage(assetId);
      return null;
    }
    return rec.img;
  }

  private lutFor(assetId: string): { size: number; data: Float32Array } | null {
    const u = this.deps.urls.get(assetId);
    let rec = this.luts.get(assetId);
    if (u.status !== 'ready') return null;
    if (!rec || (rec.state === 'error' && rec.version !== u.version)) {
      rec = { state: 'loading', lut: null, version: u.version };
      this.luts.set(assetId, rec);
      const r = rec;
      void this.deps
        .fetchText(u.url)
        .then((text) => {
          r.lut = this.deps.parseCube(text);
          r.state = 'ready';
        })
        .catch(() => {
          r.state = 'error';
        })
        .finally(() => {
          if (!this.disposed) {
            this.deps.requestRender();
            this.publishStatus();
          }
        });
    }
    return rec.state === 'ready' ? rec.lut : null;
  }

  /* ---------------------------------------------------------------- slots -------------------- */

  private acquire(assetId: string, key: string | null, needed: ReadonlySet<string>): Slot | null {
    let list = this.slots.get(assetId);
    if (!list) {
      list = [];
      this.slots.set(assetId, list);
    }
    if (key !== null) {
      const own = list.find((s) => s.key === key);
      if (own) return this.ensureSrc(own, true);
    }
    let slot = list.find((s) => s.key === null);
    if (!slot && list.length < this.maxPerAsset) {
      if (this.totalSlots() >= this.maxTotal && !this.evictIdle(assetId)) return null;
      slot = this.createSlot(assetId);
      list.push(slot);
    }
    if (!slot) {
      // reuse the least recently used slot whose item isn't needed right now
      const free = list.filter((s) => s.key === null || !needed.has(s.key));
      free.sort((a, b) => a.usedFrame - b.usedFrame);
      slot = free[0];
    }
    if (!slot) return null;
    if (key !== null || slot.key !== null) {
      slot.key = key;
      slot.inFlight = null;
      slot.deferred = null;
    }
    return this.ensureSrc(slot, true);
  }

  private totalSlots(): number {
    let n = 0;
    for (const l of this.slots.values()) n += l.length;
    return n;
  }

  /** Frees the least recently used slot of another asset (decoders are scarce). */
  private evictIdle(except: string): boolean {
    let victim: { list: Slot[]; s: Slot } | null = null;
    for (const [id, list] of this.slots) {
      if (id === except) continue;
      for (const s of list)
        if (s.usedFrame < this.frameCounter - 2 && (!victim || s.usedFrame < victim.s.usedFrame))
          victim = { list, s };
    }
    if (!victim) return false;
    victim.s.dispose();
    victim.list.splice(victim.list.indexOf(victim.s), 1);
    return true;
  }

  private createSlot(assetId: string): Slot {
    const el = this.deps.createVideo();
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    const slot: Slot = {
      id: this.nextSlotId++,
      assetId,
      el,
      key: null,
      usedFrame: 0,
      loadedVersion: -1,
      inFlight: null,
      deferred: null,
      errors: 0,
      failed: false,
      presentedMediaTime: null,
      presentedFrames: 0,
      rvfcHandle: null,
      lastWant: null,
      lastPlan: null,
      dispose: () => {},
    };
    const onSeeked = () => {
      slot.inFlight = null;
      if (slot.deferred !== null) {
        const to = slot.deferred;
        slot.deferred = null;
        slot.inFlight = to;
        el.currentTime = to;
      }
      this.deps.requestRender();
    };
    const onLoaded = () => {
      this.deps.requestRender();
      this.publishStatus();
    };
    const onError = () => {
      slot.errors++;
      if (slot.errors === 1) {
        // Most likely an expired presigned URL: ask for a fresh one and reload.
        this.deps.urls.invalidate(assetId);
        slot.loadedVersion = -1;
      } else slot.failed = true;
      this.publishStatus();
    };
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadeddata', onLoaded);
    el.addEventListener('error', onError);
    const rvfc = (el as HTMLVideoElement & { requestVideoFrameCallback?: unknown })
      .requestVideoFrameCallback;
    const pump = (_now: number, meta: VideoFrameCallbackMetadata) => {
      slot.presentedMediaTime = meta.mediaTime;
      slot.presentedFrames = meta.presentedFrames;
      // A frame was presented while nobody is playing (a seek landed): show it.
      if (el.paused) this.deps.requestRender();
      if (!this.disposed && slot.rvfcHandle !== -1)
        slot.rvfcHandle = el.requestVideoFrameCallback(pump);
    };
    if (typeof rvfc === 'function') slot.rvfcHandle = el.requestVideoFrameCallback(pump);
    slot.dispose = () => {
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('loadeddata', onLoaded);
      el.removeEventListener('error', onError);
      if (slot.rvfcHandle !== null && slot.rvfcHandle !== -1 && 'cancelVideoFrameCallback' in el)
        el.cancelVideoFrameCallback(slot.rvfcHandle);
      slot.rvfcHandle = -1;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
    return slot;
  }

  /** Points the element at the current preview URL (never while the old URL is the picture on screen mid-play). */
  private ensureSrc(slot: Slot, inUse: boolean): Slot {
    const u = this.deps.urls.get(slot.assetId);
    if (u.status !== 'ready' || slot.failed) return slot;
    if (slot.loadedVersion === u.version) return slot;
    const idle = !inUse || slot.el.paused;
    if (slot.loadedVersion !== -1 && !idle && slot.errors === 0) return slot;
    const resume = slot.el.currentTime;
    slot.el.src = u.url;
    slot.loadedVersion = u.version;
    slot.inFlight = null;
    if (resume > 0) slot.el.currentTime = resume;
    return slot;
  }

  private drive(slot: Slot, want: SeekWant): void {
    const el = slot.el;
    if (slot.loadedVersion < 0 || el.readyState < 1) {
      // metadata not here yet: remember the target; the browser applies it as the default start position.
      const target = want.srcSec;
      if (slot.loadedVersion >= 0 && Math.abs(el.currentTime - target) > want.frameSec)
        el.currentTime = target;
      slot.lastWant = want;
      return;
    }
    const plan = planVideoSync(
      {
        currentTime: el.currentTime,
        paused: el.paused,
        seeking: el.seeking,
        ended: el.ended,
        playbackRate: el.playbackRate,
        readyState: el.readyState,
        duration: el.duration,
      },
      want,
      DEFAULT_SEEK_CONFIG,
    );
    slot.lastWant = want;
    slot.lastPlan = plan;
    if (plan.rate !== null) el.playbackRate = Math.min(16, Math.max(0.0625, plan.rate));
    if (plan.seekTo !== null) {
      slot.inFlight = plan.seekTo;
      el.currentTime = plan.seekTo;
    }
    slot.deferred = plan.deferSeek;
    if (plan.play) {
      if (el.paused) void el.play().catch(() => {});
    } else if (!el.paused) el.pause();
  }

  /* ---------------------------------------------------------------- images ------------------- */

  private ensureImage(assetId: string): void {
    const u = this.deps.urls.get(assetId);
    if (u.status !== 'ready') return;
    let rec = this.images.get(assetId);
    if (!rec) {
      const img = this.deps.createImage();
      img.crossOrigin = 'anonymous';
      rec = { img, loadedVersion: -1, state: 'loading', errors: 0 };
      const r = rec;
      img.addEventListener('load', () => {
        r.state = 'ready';
        this.deps.requestRender();
        this.publishStatus();
      });
      img.addEventListener('error', () => {
        r.errors++;
        if (r.errors === 1) {
          this.deps.urls.invalidate(assetId);
          r.loadedVersion = -1;
        } else r.state = 'error';
        this.publishStatus();
      });
      this.images.set(assetId, rec);
    }
    if (rec.loadedVersion !== u.version) {
      rec.loadedVersion = u.version;
      rec.state = 'loading';
      rec.img.src = u.url;
    }
  }

  private publishStatus(): void {
    if (this.disposed) return;
    const sig = [...this.assets.keys()].map((id) => `${id}:${this.status(id).state}`).join('|');
    if (sig !== this.lastStatusSig) {
      this.lastStatusSig = sig;
      this.deps.onStatus();
    }
  }
}
