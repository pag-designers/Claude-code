/**
 * Test doubles for the playback engine: a fake Web Audio graph whose AudioParams EVALUATE the automation they are given
 * (so tests assert on the gain heard at a given context time), and fake media elements.
 */
import {
  audioItemSchema,
  projectSchema,
  trackSchema,
  videoItemSchema,
  assetSchema,
  subtitleItemSchema,
  type Project,
} from '../../shared/editor';

interface Ev {
  type: 'set' | 'ramp';
  v: number;
  t: number;
}

export class FakeParam {
  events: Ev[] = [];
  private initial: number;
  constructor(
    private readonly ctx: { currentTime: number },
    init = 1,
  ) {
    this.initial = init;
  }
  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }
  set value(v: number) {
    this.initial = v;
    this.events = [];
  }
  setValueAtTime(v: number, t: number) {
    this.events.push({ type: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ type: 'ramp', v, t });
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  setTargetAtTime(v: number, t: number) {
    this.events.push({ type: 'set', v, t });
    return this;
  }
  /** Value of the automation timeline at context time t (Web Audio semantics for set / linear ramp). */
  valueAt(t: number): number {
    // stable sort by time: later insertions win at equal times
    const evs = this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map((x) => x.e);
    let prevV = this.initial;
    let prevT = -Infinity;
    for (const e of evs) {
      if (e.t > t) {
        if (e.type === 'ramp') {
          if (prevT === -Infinity) return prevV;
          return prevV + ((e.v - prevV) * (t - prevT)) / Math.max(1e-12, e.t - prevT);
        }
        return prevV; // a set in the future: hold
      }
      prevV = e.v;
      prevT = e.t;
    }
    return prevV;
  }
}

export class FakeNode {
  out: FakeNode[] = [];
  connect(n: FakeNode) {
    this.out.push(n);
    return n;
  }
  disconnect() {
    this.out = [];
  }
}

export class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: { currentTime: number }) {
    super();
    this.gain = new FakeParam(ctx, 1);
  }
}

export class FakeBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  data: Float32Array[];
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.data[c] as Float32Array;
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate: FakeParam;
  started: { when: number; offset: number; dur?: number } | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: { currentTime: number }) {
    super();
    this.playbackRate = new FakeParam(ctx, 1);
  }
  start(when = 0, offset = 0, dur?: number) {
    this.started = { when, offset, dur };
  }
  stop(when = 0) {
    this.stopped = when;
  }
}

export class FakeCtx {
  currentTime = 100;
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 48000;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeBufferSource[] = [];
  mediaSources: FakeNode[] = [];
  compressor = Object.assign(new FakeNode(), {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    reduction: 0,
  });
  createGain() {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    return this.compressor;
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 2048,
      getFloatTimeDomainData: (b: Float32Array) => b.fill(0),
    });
  }
  createMediaElementSource() {
    const n = new FakeNode();
    this.mediaSources.push(n);
    return n;
  }
  createBufferSource() {
    const s = new FakeBufferSource(this);
    this.sources.push(s);
    return s;
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new FakeBuffer(ch, len, sr);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

export class FakeMedia {
  playbackRate = 1;
  paused = true;
  seeking = false;
  ended = false;
  readyState = 4;
  duration = 60;
  videoWidth = 320;
  videoHeight = 568;
  preservesPitch = true;
  src = '';
  crossOrigin: string | null = null;
  preload = '';
  muted = false;
  playsInline = false;
  playCalls = 0;
  pauseCalls = 0;
  /** Every value assigned to `currentTime` (a seek request). */
  seekWrites: number[] = [];
  private ct = 0;
  private listeners = new Map<string, Set<() => void>>();
  get currentTime(): number {
    return this.ct;
  }
  set currentTime(v: number) {
    this.ct = v;
    this.seekWrites.push(v);
  }
  /** Move the playback position WITHOUT recording a seek (the element advancing by itself). */
  advanceTo(t: number): void {
    this.ct = t;
  }
  play() {
    this.paused = false;
    this.playCalls++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauseCalls++;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  addEventListener(ev: string, fn: () => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)?.add(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners.get(ev)?.delete(fn);
  }
  emit(ev: string) {
    for (const f of [...(this.listeners.get(ev) ?? [])]) f();
  }
}

/* ------------------------------------------------------------------ project builders -------- */

export const asset = (o: Record<string, unknown> = {}) =>
  assetSchema.parse({
    id: 'a1',
    kind: 'video',
    name: 'a',
    source: { kind: 'upload', key: 'k', fileName: 'f.mp4' },
    durationSec: 60,
    width: 320,
    height: 568,
    fps: 30,
    hasAudio: true,
    ...o,
  });

export const vItem = (o: Record<string, unknown> = {}) =>
  videoItemSchema.parse({
    type: 'video',
    id: 'v1',
    startSec: 0,
    durationSec: 10,
    assetId: 'a1',
    ...o,
  });

export const aItem = (o: Record<string, unknown> = {}) =>
  audioItemSchema.parse({
    type: 'audio',
    id: 'au1',
    startSec: 0,
    durationSec: 10,
    assetId: 'm1',
    ...o,
  });

export const cue = (id: string, startSec: number, words: [string, number, number][]) =>
  subtitleItemSchema.parse({
    type: 'subtitle',
    id,
    startSec,
    durationSec: Math.max(...words.map((w) => w[2])) + 0.2,
    words: words.map(([w, s, e]) => ({ w, s, e })),
  });

export const track = (o: Record<string, unknown>) =>
  trackSchema.parse({ id: 't1', kind: 'video', name: 'T', items: [], ...o });

export const project = (tracks: unknown[], assets: unknown[]): Project =>
  projectSchema.parse({ tracks, assets });
