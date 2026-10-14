/**
 * Master clock for playback. While the transport plays, the engine asks `step()` once per animation frame and passes the
 * result to `store.tick(dt)` (WALL seconds; the store applies the transport rate).
 *
 * The AudioContext clock is the master when it is running: audio is what the user hears, and element/AudioContext
 * clocks follow the sound card, while `performance.now()` follows the display clock. We therefore measure elapsed time
 * with both, low-pass the difference (the audio clock only advances in render-quantum chunks, so a raw read is jittery)
 * and add the smoothed difference to the performance clock. A sustained drift is tracked continuously; a sudden
 * disagreement (context suspended / resumed, a long stall) re-anchors the audio clock and falls back to
 * `performance.now()` so the picture never freezes with the sound.
 */
export interface ClockDeps {
  /** Milliseconds (performance.now). */
  perfNow(): number;
  /** Seconds of the audio clock, or null when there is none / it is not running. */
  audioNow(): number | null;
}

export interface ClockOptions {
  /** Largest wall step returned (a stalled tab never teleports the playhead). */
  maxStepSec?: number;
  /** Audio/perf disagreement above which the audio clock is distrusted and re-anchored. */
  snapErrSec?: number;
  /** One-pole smoothing factor for the audio-vs-perf error (0..1, per step). */
  smoothing?: number;
  /** A gap longer than this between steps counts as a stall: the step is clamped and the clock re-anchors. */
  stallSec?: number;
}

export class MasterClock {
  private readonly maxStep: number;
  private readonly snapErr: number;
  private readonly smoothing: number;
  private readonly stall: number;
  private p0 = 0;
  private a0: number | null = null;
  private lastEff = 0;
  private lastPerfEl = 0;
  private corr = 0;
  private isRunning = false;
  private src: 'audio' | 'perf' = 'perf';

  constructor(
    private readonly deps: ClockDeps,
    opts: ClockOptions = {},
  ) {
    this.maxStep = opts.maxStepSec ?? 0.5;
    this.snapErr = opts.snapErrSec ?? 0.08;
    this.smoothing = opts.smoothing ?? 0.15;
    this.stall = opts.stallSec ?? 1;
  }

  get running(): boolean {
    return this.isRunning;
  }
  /** Which clock the last step followed. */
  get source(): 'audio' | 'perf' {
    return this.src;
  }
  /** Smoothed (audio − perf) elapsed difference in seconds; positive = the audio clock is ahead. */
  get driftSec(): number {
    return this.corr;
  }

  /** Anchor "now" as time zero. Call when playback starts and after any discontinuity (seek, loop, rate change). */
  start(): void {
    this.p0 = this.deps.perfNow();
    this.a0 = this.deps.audioNow();
    this.lastEff = 0;
    this.lastPerfEl = 0;
    this.corr = 0;
    this.isRunning = true;
    this.src = 'perf';
  }

  stop(): void {
    this.isRunning = false;
  }

  /** Wall seconds elapsed since the previous step (≥ 0, ≤ maxStepSec). */
  step(): number {
    if (!this.isRunning) return 0;
    const perfEl = (this.deps.perfNow() - this.p0) / 1000;
    const gap = perfEl - this.lastPerfEl;
    this.lastPerfEl = perfEl;
    if (gap > this.stall) {
      // The page was throttled (hidden tab, long task). Keep time moving by one capped step and re-anchor.
      this.rebase(perfEl);
      return this.maxStep;
    }
    const a = this.deps.audioNow();
    if (a === null || this.a0 === null) {
      // No audio clock (yet): adopt it if it appears so a context resumed after the first user gesture takes over.
      this.a0 = a === null ? null : a - perfEl;
      this.src = 'perf';
    } else {
      const err = a - this.a0 - perfEl;
      if (Math.abs(err) > this.snapErr) {
        this.a0 = a - perfEl;
        this.corr = 0;
        this.src = 'perf';
      } else {
        this.corr += (err - this.corr) * this.smoothing;
        this.src = 'audio';
      }
    }
    const eff = perfEl + this.corr;
    const dt = Math.min(this.maxStep, Math.max(0, eff - this.lastEff));
    this.lastEff = eff;
    return dt;
  }

  private rebase(perfEl: number): void {
    this.p0 += perfEl * 1000;
    const a = this.deps.audioNow();
    this.a0 = a;
    this.lastEff = 0;
    this.lastPerfEl = 0;
    this.corr = 0;
    this.src = 'perf';
  }
}
