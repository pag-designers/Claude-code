import type { Project, Track } from '@shared/editor';
import {
  duckGainAt,
  itemEnd,
  itemGainAt,
  projectDuration,
  speechRanges,
  speedAt,
  type TimeRange,
} from '@shared/editor-eval';
import type { AudioBuffers } from './audio-buffers';
import {
  audioEntries,
  crossfadeMult,
  ctxAt,
  duckPoints,
  elementRateAt,
  entriesActiveAt,
  entriesInWindow,
  expectedGain,
  grainEnvelope,
  itemGainPoints,
  ratePoints,
  reverseBufferPos,
  reverseWindow,
  scheduleLinear,
  tlAt,
  trackLevel,
  voiceKind,
  type Anchor,
  type AudioEntry,
} from './mixer-math';
import { clampToAsset, sourceTimeFn } from './src-time';

/**
 * Web Audio mixer. Graph per track:  voice gain (item volume × fades) → track level (gain, mute) → duck (auto-ducking
 * under speech) → master gain → limiter (DynamicsCompressor) → destination. All automation is scheduled in
 * AudioContext time against an anchor (timeline time `tl0` plays at context time `ctx0`), only for items overlapping
 * [t, t + lookahead], and only for the not-yet-scheduled stretch, so a long project costs nothing.
 *
 * Transitions: during a transition overlap on a track (the later item's `transitionIn`) the two items' voice gains are
 * multiplied by `transitionAudioGains` (linear crossfade; a 'cut' overlap mutes the outgoing item), scheduled with the
 * other gain breakpoints (see mixer-math `transitionWindows` / `itemGainPoints`). Exporter parity: hidden or muted tracks and
 * freeze frames are silent; the noise gate is export-only (not applied here).
 *
 * Voices: 'element' (an <audio> element through MediaElementSource: streaming, pitch-preserving speed) or 'buffer' (a
 * decoded AudioBuffer: reverse via a time-reversed copy, speeds the media pipeline would mute). Freeze = no voice.
 */
export interface MixerDeps {
  ctx: AudioContext;
  createElement(): HTMLMediaElement;
  /** Ready preview URL of an asset or null. */
  urlFor(assetId: string): string | null;
  buffers: Pick<
    AudioBuffers,
    | 'peekAsset'
    | 'requestAsset'
    | 'peekReversed'
    | 'requestReversed'
    | 'canDecode'
    | 'setProject'
    | 'stats'
  >;
  perfNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface MixerOptions {
  /** Timeline seconds ahead of the playhead that get voices and automation. */
  lookaheadSec?: number;
  maxVoices?: number;
}

export interface SyncInput {
  tSec: number;
  playing: boolean;
  /** Transport rate (negative = reverse). */
  rate: number;
}

interface ElementNodes {
  el: HTMLMediaElement;
  src: MediaElementAudioSourceNode;
  gain: GainNode;
  url: string | null;
  releasing: boolean;
}

interface Bus {
  track: Track;
  level: GainNode;
  duck: GainNode;
  /** Timeline time up to which duck automation has been scheduled, or null (nothing scheduled). */
  duckUntil: number | null;
  /** The ducking settings / speech ranges changed: re-schedule (or reset) at the next sync. */
  duckStale: boolean;
}

interface Voice {
  entry: AudioEntry;
  kind: 'element' | 'buffer';
  state: 'armed' | 'playing' | 'done';
  nodes: ElementNodes | null;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  gainUntil: number | null;
  endCut: boolean;
  prerolled: boolean;
  lastSeekAt: number;
  baseRate: number;
}

export interface AudioGraphSnapshot {
  state: AudioContextState;
  sampleRate: number;
  currentTime: number;
  anchor: Anchor | null;
  master: {
    gain: number;
    limiter: { threshold: number; ratio: number; knee: number; reduction: number };
    peak: number;
  };
  speech: TimeRange[];
  tracks: {
    trackId: string;
    kind: string;
    level: number;
    expectedLevel: number;
    duck: number;
    expectedDuck: number;
    duckEnabled: boolean;
  }[];
  voices: {
    itemId: string;
    assetId: string;
    trackId: string;
    kind: 'element' | 'buffer';
    state: string;
    gain: number;
    /** volume × fades at the current timeline time. */
    expectedItemGain: number;
    /** Audio crossfade multiplier of a transition overlap at the current time (1 outside one). */
    transitionGain: number;
    /** expected product incl. transition crossfade, track level and ducking. */
    expectedGain: number;
    /** measured product: voice gain × track level × duck. */
    effectiveGain: number;
    playbackRate: number;
    expectedRate: number;
    preservesPitch: boolean | null;
    srcTime: number | null;
    expectedSrcTime: number;
    paused: boolean | null;
  }[];
  buffers: { assets: number; reversed: number; bytes: number } | null;
  /** Scrub grains played so far. */
  grains: number;
}

const LOOKAHEAD_SEC = 2;
const START_LEAD_SEC = 0.04;
const RESYNC_SEC = 0.15;
const HARD_DRIFT_SEC = 0.15;
const SOFT_DRIFT_SEC = 0.02;
const GRAIN_SEC = 0.08;
const MIN_AUDIBLE_RATE = 0.25;
const MAX_AUDIBLE_RATE = 2;

export class AudioMixer {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  private readonly lookahead: number;
  private readonly maxVoices: number;
  private project: Project | null = null;
  private entries: AudioEntry[] = [];
  private assetDur = new Map<string, number | null>();
  private ranges: TimeRange[] = [];
  private duration = 0;
  private readonly buses = new Map<string, Bus>();
  private readonly voices = new Map<string, Voice>();
  private readonly freeNodes: ElementNodes[] = [];
  private anchor: Anchor | null = null;
  private lastT = 0;
  private lastRate = 1;
  private playLatency = 0.04;
  private lastGrainAt = -Infinity;
  private grainElements = new Map<string, ElementNodes>();
  private grainCount = 0;

  constructor(
    private readonly deps: MixerDeps,
    opts: MixerOptions = {},
  ) {
    this.ctx = deps.ctx;
    this.lookahead = opts.lookaheadSec ?? LOOKAHEAD_SEC;
    this.maxVoices = opts.maxVoices ?? 14;
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(this.analyser);
  }

  resume(): Promise<void> {
    if (this.ctx.state === 'running') return Promise.resolve();
    return this.ctx.resume().catch(() => {});
  }

  /** Hands the mixer a new project (cheap; voices of unchanged items keep playing). */
  setProject(project: Project): void {
    this.project = project;
    this.entries = audioEntries(project);
    this.assetDur = new Map(project.assets.map((a) => [a.id, a.durationSec] as const));
    const prevRanges = JSON.stringify(this.ranges);
    this.ranges = speechRanges(project);
    const rangesChanged = prevRanges !== JSON.stringify(this.ranges);
    this.duration = projectDuration(project);
    this.deps.buffers.setProject(project);
    // buses
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const [id, bus] of [...this.buses])
      if (!ids.has(id)) {
        bus.level.disconnect();
        bus.duck.disconnect();
        this.buses.delete(id);
      }
    const now = this.ctx.currentTime;
    for (const track of project.tracks) {
      let bus = this.buses.get(track.id);
      if (!bus) {
        const level = this.ctx.createGain();
        const duck = this.ctx.createGain();
        level.connect(duck);
        duck.connect(this.master);
        bus = { track, level, duck, duckUntil: null, duckStale: false };
        this.buses.set(track.id, bus);
        level.gain.setValueAtTime(trackLevel(track), now);
      } else {
        const ducking = bus.track.ducking;
        const changed =
          ducking.enabled !== track.ducking.enabled ||
          ducking.reductionDb !== track.ducking.reductionDb ||
          ducking.attackSec !== track.ducking.attackSec ||
          ducking.releaseSec !== track.ducking.releaseSec;
        bus.track = track;
        bus.level.gain.cancelScheduledValues(now);
        bus.level.gain.setValueAtTime(trackLevel(track), now);
        if (changed || rangesChanged) bus.duckStale = true;
      }
      bus.track = track;
    }
    // voices whose item changed or vanished
    const byId = new Map(this.entries.map((e) => [e.item.id, e] as const));
    for (const [id, v] of [...this.voices]) {
      const e = byId.get(id);
      if (
        !e ||
        e.item !== v.entry.item ||
        e.xfades.length !== v.entry.xfades.length ||
        e.xfades.some(
          (x, i) =>
            x.start !== v.entry.xfades[i]?.start ||
            x.end !== v.entry.xfades[i]?.end ||
            x.type !== v.entry.xfades[i]?.type,
        ) ||
        e.asset !== v.entry.asset ||
        e.track.id !== v.entry.track.id
      )
        this.release(v);
      else v.entry = e;
    }
  }

  /** Drives voices for the current transport state. Cheap when nothing changed. */
  sync(input: SyncInput): void {
    const { tSec, playing, rate } = input;
    this.lastT = tSec;
    this.lastRate = rate;
    const audible = playing && rate >= MIN_AUDIBLE_RATE && rate <= MAX_AUDIBLE_RATE;
    if (!audible) {
      if (this.anchor) this.silence();
      return;
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      void this.resume();
      return;
    }
    const now = ctx.currentTime;
    const a = this.anchor;
    if (!a || a.rate !== rate || Math.abs(tlAt(a, now) - tSec) > RESYNC_SEC)
      this.reanchor(tSec, rate, now);
    const anchor = this.anchor as Anchor;
    const horizon = tSec + this.lookahead * rate;
    const wanted = entriesInWindow(this.entries, tSec, horizon);
    const wantedIds = new Set(wanted.map((e) => e.item.id));
    for (const [id, v] of [...this.voices]) if (!wantedIds.has(id)) this.release(v);
    for (const e of wanted) {
      let v: Voice | null | undefined = this.voices.get(e.item.id);
      if (!v) {
        if (this.voices.size >= this.maxVoices) continue;
        v = this.createVoice(e, rate, now);
        if (!v) continue;
      }
      this.drive(v, tSec, rate, now, horizon, anchor);
    }
    for (const bus of this.buses.values()) this.ensureDuck(bus, tSec, now, horizon, anchor);
  }

  /** Everything silent (transport stopped / reverse / fast shuttle). */
  stop(): void {
    this.silence();
  }

  /** Audio scrub: a short grain at timeline time t of every audible item there. */
  scrub(tSec: number): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      void this.resume();
      return;
    }
    const perf = this.deps.perfNow();
    if (perf - this.lastGrainAt < 45) return;
    this.lastGrainAt = perf;
    const active = entriesActiveAt(this.entries, tSec).slice(0, 4);
    this.grainCount += active.length ? 1 : 0;
    const now = ctx.currentTime;
    for (const e of active) {
      const { item, asset } = e;
      const bus = this.buses.get(e.track.id);
      if (!bus) continue;
      const tl = tSec - item.startSec;
      // duck / track level are applied by the bus; here only item volume × fades
      const itemPeak = itemGainAt(item, tl) * crossfadeMult(e.xfades, tSec);
      if (itemPeak <= 0) continue;
      const decoded = item.reverse
        ? (() => {
            const w = reverseWindow(item, asset.durationSec);
            const rb = this.deps.buffers.peekReversed(asset.id, w.startSrc, w.endSrc);
            if (!rb) this.deps.buffers.requestReversed(asset.id, w.startSrc, w.endSrc);
            return rb ? { buf: rb, pos: reverseBufferPos(item, asset.durationSec, tl) } : null;
          })()
        : (() => {
            const b = this.deps.buffers.peekAsset(asset.id);
            if (!b) this.deps.buffers.requestAsset(asset.id);
            return b
              ? { buf: b, pos: clampToAsset(sourceTimeFn(item)(tl), asset.durationSec) }
              : null;
          })();
      if (decoded && decoded.pos >= 0 && decoded.pos < decoded.buf.duration) {
        const g = ctx.createGain();
        const src = ctx.createBufferSource();
        src.buffer = decoded.buf;
        src.connect(g);
        g.connect(bus.level);
        const env = grainEnvelope(itemPeak, GRAIN_SEC);
        g.gain.setValueAtTime(0, now);
        for (const p of env) g.gain.linearRampToValueAtTime(p.v, now + p.t);
        src.start(now, decoded.pos, GRAIN_SEC + 0.01);
        src.onended = () => {
          src.disconnect();
          g.disconnect();
        };
        continue;
      }
      if (!decoded && !this.deps.buffers.canDecode(asset.id))
        this.elementGrain(e, tSec, itemPeak, now, bus);
    }
  }

  /** Test / diagnostics: the live graph with the values the scheduling maths expects. */
  snapshot(): AudioGraphSnapshot {
    const ctx = this.ctx;
    const t = this.anchor ? tlAt(this.anchor, ctx.currentTime) : this.lastT;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const tracks = [...this.buses.values()].map((bus) => ({
      trackId: bus.track.id,
      kind: bus.track.kind,
      level: bus.level.gain.value,
      expectedLevel: trackLevel(bus.track),
      duck: bus.duck.gain.value,
      expectedDuck: duckGainAt(this.ranges, bus.track.ducking, t),
      duckEnabled: bus.track.ducking.enabled,
    }));
    const voices = [...this.voices.values()].map((v) => {
      const { item, track, asset } = v.entry;
      const bus = this.buses.get(track.id);
      const tl = t - item.startSec;
      const el = v.nodes?.el ?? null;
      const g = v.gain.gain.value;
      return {
        itemId: item.id,
        assetId: asset.id,
        trackId: track.id,
        kind: v.kind,
        state: v.state,
        gain: g,
        expectedItemGain: tl >= 0 && tl <= item.durationSec ? itemGainAt(item, tl) : 0,
        transitionGain: crossfadeMult(v.entry.xfades, t),
        expectedGain: expectedGain(v.entry, this.ranges, t),
        effectiveGain: g * (bus ? bus.level.gain.value * bus.duck.gain.value : 0),
        playbackRate: el ? el.playbackRate : v.source ? v.source.playbackRate.value : 0,
        expectedRate:
          v.kind === 'element'
            ? elementRateAt(item, Math.max(0, tl), this.anchor?.rate ?? 1)
            : speedAt(item, Math.max(0, tl)) * (this.anchor?.rate ?? 1),
        preservesPitch: el ? el.preservesPitch : null,
        srcTime: el ? el.currentTime : null,
        expectedSrcTime: clampToAsset(sourceTimeFn(item)(Math.max(0, tl)), asset.durationSec),
        paused: el ? el.paused : null,
      };
    });
    return {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      currentTime: ctx.currentTime,
      anchor: this.anchor ? { ...this.anchor } : null,
      master: {
        gain: this.master.gain.value,
        limiter: {
          threshold: this.limiter.threshold.value,
          ratio: this.limiter.ratio.value,
          knee: this.limiter.knee.value,
          reduction: this.limiter.reduction,
        },
        peak,
      },
      speech: this.ranges.map((r) => ({ ...r })),
      tracks,
      voices,
      buffers: this.deps.buffers.stats,
      grains: this.grainCount,
    };
  }

  dispose(): void {
    this.silence();
    for (const n of this.freeNodes) this.destroyNodes(n);
    this.freeNodes.length = 0;
    for (const n of this.grainElements.values()) this.destroyNodes(n);
    this.grainElements.clear();
    for (const bus of this.buses.values()) {
      bus.level.disconnect();
      bus.duck.disconnect();
    }
    this.buses.clear();
    this.master.disconnect();
    this.limiter.disconnect();
    void this.ctx.close().catch(() => {});
  }

  /* ---------------------------------------------------------------- internals ---------------- */

  private silence(): void {
    for (const v of [...this.voices.values()]) this.release(v);
    this.anchor = null;
    for (const bus of this.buses.values()) bus.duckUntil = null;
  }

  private reanchor(tSec: number, rate: number, now: number): void {
    for (const v of [...this.voices.values()]) this.release(v);
    for (const bus of this.buses.values()) bus.duckUntil = null;
    this.anchor = { tl0: tSec, ctx0: now, rate };
  }

  private createVoice(e: AudioEntry, rate: number, now: number): Voice | null {
    const bus = this.buses.get(e.track.id);
    if (!bus) return null;
    const kind = voiceKind(e.item, rate);
    let nodes: ElementNodes | null = null;
    let gain: GainNode;
    if (kind === 'element') {
      const url = this.deps.urlFor(e.asset.id);
      if (!url) return null;
      nodes = this.acquireNodes(url);
      gain = nodes.gain;
      nodes.el.preservesPitch = e.item.preservePitch;
    } else {
      gain = this.ctx.createGain();
    }
    gain.gain.cancelScheduledValues(0);
    gain.gain.value = 0; // silent from the first render quantum, before any automation is processed
    gain.gain.setValueAtTime(0, now);
    gain.connect(bus.level);
    const v: Voice = {
      entry: e,
      kind,
      state: 'armed',
      nodes,
      gain,
      source: null,
      gainUntil: null,
      endCut: false,
      prerolled: false,
      lastSeekAt: -Infinity,
      baseRate: 1,
    };
    this.voices.set(e.item.id, v);
    return v;
  }

  private acquireNodes(url: string): ElementNodes {
    let n =
      this.freeNodes.find((x) => x.url === url && !x.releasing) ??
      this.freeNodes.find((x) => !x.releasing);
    if (n) this.freeNodes.splice(this.freeNodes.indexOf(n), 1);
    else {
      const el = this.deps.createElement();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      src.connect(gain);
      n = { el, src, gain, url: null, releasing: false };
    }
    if (n.url !== url) {
      n.el.src = url;
      n.url = url;
    }
    return n;
  }

  private destroyNodes(n: ElementNodes): void {
    try {
      n.el.pause();
      n.gain.disconnect();
      n.src.disconnect();
    } catch {
      /* already torn down */
    }
  }

  private release(v: Voice): void {
    this.voices.delete(v.entry.item.id);
    const now = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + 0.006);
    if (v.source) {
      try {
        v.source.stop(now + 0.008);
      } catch {
        /* never started */
      }
      const s = v.source;
      v.source = null;
      this.deps.setTimeout(() => {
        s.disconnect();
        v.gain.disconnect();
      }, 20);
    }
    const nodes = v.nodes;
    if (nodes) {
      nodes.releasing = true;
      this.deps.setTimeout(() => {
        nodes.el.pause();
        nodes.gain.disconnect();
        nodes.releasing = false;
        if (this.freeNodes.length < 8) this.freeNodes.push(nodes);
        else this.destroyNodes(nodes);
      }, 12);
    }
    v.state = 'done';
  }

  private drive(
    v: Voice,
    tSec: number,
    rate: number,
    now: number,
    horizon: number,
    anchor: Anchor,
  ): void {
    this.ensureGain(v, tSec, now, horizon, anchor);
    if (v.state === 'armed') {
      if (v.kind === 'element') this.armElement(v, tSec, rate, now, anchor);
      else this.armBuffer(v, tSec, rate, now, anchor);
    } else if (v.state === 'playing' && v.kind === 'element') {
      this.correctDrift(v, tSec, rate);
    }
  }

  private armElement(v: Voice, tSec: number, rate: number, now: number, anchor: Anchor): void {
    const nodes = v.nodes as ElementNodes;
    const el = nodes.el;
    const { item, asset } = v.entry;
    const startsIn = ctxAt(anchor, item.startSec) - now;
    const local = Math.max(0, tSec - item.startSec);
    if (!v.prerolled) {
      const target = clampToAsset(sourceTimeFn(item)(local), asset.durationSec);
      if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
      v.prerolled = true;
    }
    if (startsIn > START_LEAD_SEC + this.playLatency) return;
    // Start: aim `playLatency` ahead so the first audible sample lines up with the timeline.
    const base = elementRateAt(item, local, rate);
    v.baseRate = base;
    const lead = startsIn > 0 ? 0 : this.playLatency * base;
    const target = clampToAsset(sourceTimeFn(item)(local) + lead, asset.durationSec);
    el.playbackRate = base;
    if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
    const t0 = this.deps.perfNow();
    const onPlaying = () => {
      el.removeEventListener('playing', onPlaying);
      const dt = (this.deps.perfNow() - t0) / 1000;
      if (dt > 0 && dt < 0.5) this.playLatency = this.playLatency * 0.7 + dt * 0.3;
    };
    el.addEventListener('playing', onPlaying);
    void el.play().catch(() => {});
    v.state = 'playing';
  }

  private correctDrift(v: Voice, tSec: number, rate: number): void {
    const el = (v.nodes as ElementNodes).el;
    const { item, asset } = v.entry;
    if (el.seeking) return;
    const local = tSec - item.startSec;
    if (local < 0 || local > item.durationSec) return;
    if (el.paused && !el.ended) {
      void el.play().catch(() => {});
      return;
    }
    const expected = clampToAsset(sourceTimeFn(item)(local), asset.durationSec);
    const base = elementRateAt(item, local, rate);
    const drift = el.currentTime - expected;
    const perf = this.deps.perfNow();
    if (Math.abs(drift) > HARD_DRIFT_SEC && perf - v.lastSeekAt > 400) {
      v.lastSeekAt = perf;
      el.currentTime = clampToAsset(expected + 0.03 * base, asset.durationSec);
      return;
    }
    let r = base;
    if (Math.abs(drift) > SOFT_DRIFT_SEC)
      r = base * (1 - Math.max(-0.05, Math.min(0.05, drift / 0.5)));
    if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
    v.baseRate = base;
  }

  private armBuffer(v: Voice, tSec: number, rate: number, now: number, anchor: Anchor): void {
    const { item, asset } = v.entry;
    let buf: AudioBuffer | null;
    if (item.reverse) {
      const w = reverseWindow(item, asset.durationSec);
      buf = this.deps.buffers.peekReversed(asset.id, w.startSrc, w.endSrc);
      if (!buf) this.deps.buffers.requestReversed(asset.id, w.startSrc, w.endSrc);
    } else {
      buf = this.deps.buffers.peekAsset(asset.id);
      if (!buf) this.deps.buffers.requestAsset(asset.id);
    }
    if (!buf) return; // not decoded yet; try again next tick
    const tlStart = Math.max(item.startSec, tSec);
    const local = tlStart - item.startSec;
    const pts = ratePoints(item, local, item.durationSec, rate);
    let pos = item.reverse
      ? reverseBufferPos(item, asset.durationSec, local)
      : sourceTimeFn(item)(local);
    let ctxStart = Math.max(now + 0.005, ctxAt(anchor, tlStart));
    if (pos < 0) {
      ctxStart += -pos / Math.max(0.1, pts[0]?.v ?? 1);
      pos = 0;
    }
    if (pos >= buf.duration) {
      v.state = 'done';
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const first = pts[0]?.v ?? item.speed * rate;
    src.playbackRate.setValueAtTime(first, ctxStart);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i] as { t: number; v: number };
      src.playbackRate.linearRampToValueAtTime(
        p.v,
        Math.max(ctxStart, ctxAt(anchor, item.startSec + p.t)),
      );
    }
    src.connect(v.gain);
    src.start(ctxStart, pos);
    src.stop(ctxAt(anchor, itemEnd(item)) + 0.05);
    v.source = src;
    v.state = 'playing';
  }

  private ensureGain(v: Voice, tSec: number, now: number, horizon: number, anchor: Anchor): void {
    const { item } = v.entry;
    const endTl = itemEnd(item);
    const upTo = Math.min(endTl, horizon);
    const param = v.gain.gain;
    if (v.gainUntil === null) {
      const startTl = Math.max(item.startSec, tSec);
      const pts = itemGainPoints(
        item,
        startTl - item.startSec,
        upTo - item.startSec,
        v.entry.xfades,
      );
      if (!pts.length) return;
      const t0 = Math.max(now, ctxAt(anchor, startTl));
      param.cancelScheduledValues(0);
      param.setValueAtTime(0, now);
      if (t0 > now) param.setValueAtTime(0, t0);
      const ctxPts = pts.map((p, i) => ({
        ctx: i === 0 ? t0 + 0.002 : Math.max(t0 + 0.002, ctxAt(anchor, item.startSec + p.t)),
        v: p.v,
      }));
      scheduleLinear(param, ctxPts, { continueFrom: t0 });
      v.gainUntil = upTo;
    } else if (upTo > v.gainUntil + 1e-6) {
      const pts = itemGainPoints(
        item,
        v.gainUntil - item.startSec,
        upTo - item.startSec,
        v.entry.xfades,
      ).slice(1);
      scheduleLinear(
        param,
        pts.map((p) => ({ ctx: ctxAt(anchor, item.startSec + p.t), v: p.v })),
        { continueFrom: ctxAt(anchor, v.gainUntil) },
      );
      v.gainUntil = upTo;
    }
    if (v.gainUntil !== null && v.gainUntil >= endTl - 1e-6 && !v.endCut) {
      param.setValueAtTime(0, ctxAt(anchor, endTl));
      v.endCut = true;
    }
  }

  private ensureDuck(bus: Bus, tSec: number, now: number, horizon: number, anchor: Anchor): void {
    const d = bus.track.ducking;
    const param = bus.duck.gain;
    if (!d.enabled || !this.ranges.length) {
      if (bus.duckUntil !== null || bus.duckStale) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(1, now);
        bus.duckUntil = null;
        bus.duckStale = false;
      }
      return;
    }
    const upTo = Math.max(tSec + 0.05, horizon);
    if (bus.duckUntil === null || bus.duckStale) {
      const pts = duckPoints(this.ranges, d, this.duration, tSec, upTo);
      param.cancelScheduledValues(0);
      param.setValueAtTime((pts[0] ?? { v: 1 }).v, now);
      scheduleLinear(
        param,
        pts.slice(1).map((p) => ({ ctx: ctxAt(anchor, p.t), v: p.v })),
        { continueFrom: now },
      );
      bus.duckUntil = upTo;
      bus.duckStale = false;
    } else if (upTo > bus.duckUntil + 0.25) {
      const pts = duckPoints(this.ranges, d, this.duration, bus.duckUntil, upTo).slice(1);
      scheduleLinear(
        param,
        pts.map((p) => ({ ctx: ctxAt(anchor, p.t), v: p.v })),
        { continueFrom: ctxAt(anchor, bus.duckUntil) },
      );
      bus.duckUntil = upTo;
    }
  }

  /** Fallback scrub for assets too long to decode: seek an element and let it speak for one grain. */
  private elementGrain(e: AudioEntry, tSec: number, peak: number, now: number, bus: Bus): void {
    const url = this.deps.urlFor(e.asset.id);
    if (!url) return;
    let n = this.grainElements.get(e.asset.id);
    if (!n) {
      n = this.acquireNodes(url);
      this.grainElements.set(e.asset.id, n);
      n.gain.connect(bus.level);
    }
    const el = n.el;
    const g = n.gain.gain;
    const tl = tSec - e.item.startSec;
    el.currentTime = clampToAsset(sourceTimeFn(e.item)(tl), e.asset.durationSec);
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(peak, now + 0.006);
    g.setValueAtTime(peak, now + GRAIN_SEC - 0.02);
    g.linearRampToValueAtTime(0, now + GRAIN_SEC);
    void el.play().catch(() => {});
    this.deps.setTimeout(() => el.pause(), GRAIN_SEC * 1000 + 30);
  }
}
