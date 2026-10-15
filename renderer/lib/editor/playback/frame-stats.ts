export interface FrameSummary {
  frames: number;
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  slowFrames: number;
  avgRenderMs: number;
  lastRenderMs: number;
  /** Mean ms per named section of a frame (clock, mixer, pool, framesNeeded, render…). */
  sections: Record<string, number>;
}

/** Ring buffer of frame intervals → fps / jank numbers for diagnostics and the performance report. */
export class FrameStats {
  private readonly buf: Float64Array;
  private n = 0;
  private head = 0;
  private last: number | null = null;
  total = 0;
  lastRenderMs = 0;
  private renderMsSum = 0;
  private renderCount = 0;
  private readonly sectionSum = new Map<string, { sum: number; n: number }>();

  constructor(size = 240) {
    this.buf = new Float64Array(size);
  }

  /** Call once per presented frame with a monotonic ms timestamp. */
  tick(nowMs: number): void {
    if (this.last !== null) {
      const dt = nowMs - this.last;
      this.buf[this.head] = dt;
      this.head = (this.head + 1) % this.buf.length;
      this.n = Math.min(this.buf.length, this.n + 1);
    }
    this.last = nowMs;
    this.total++;
  }

  /** Time the compositor + pool spent on a frame. */
  render(ms: number): void {
    this.lastRenderMs = ms;
    this.renderMsSum += ms;
    this.renderCount++;
  }

  /** Accumulates time spent in a named part of the frame. */
  section(name: string, ms: number): void {
    const e = this.sectionSum.get(name) ?? { sum: 0, n: 0 };
    e.sum += ms;
    e.n++;
    this.sectionSum.set(name, e);
  }

  /** Forget the previous timestamp (after a pause) so idle gaps do not count as slow frames. */
  gap(): void {
    this.last = null;
  }

  reset(): void {
    this.n = 0;
    this.head = 0;
    this.last = null;
    this.total = 0;
    this.renderMsSum = 0;
    this.renderCount = 0;
    this.sectionSum.clear();
  }

  summary(): FrameSummary {
    const xs = Array.from(this.buf.subarray(0, this.n)).slice(0, this.n);
    // ring order doesn't matter for statistics
    const sorted = [...xs].sort((a, b) => a - b);
    const sum = xs.reduce((a, b) => a + b, 0);
    const avg = xs.length ? sum / xs.length : 0;
    return {
      frames: this.total,
      fps: avg > 0 ? 1000 / avg : 0,
      avgFrameMs: avg,
      p95FrameMs: sorted.length
        ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number)
        : 0,
      maxFrameMs: sorted.length ? (sorted[sorted.length - 1] as number) : 0,
      slowFrames: xs.filter((x) => x > 25).length,
      avgRenderMs: this.renderCount ? this.renderMsSum / this.renderCount : 0,
      lastRenderMs: this.lastRenderMs,
      sections: Object.fromEntries(
        [...this.sectionSum].map(([k, v]) => [k, v.n ? v.sum / v.n : 0]),
      ),
    };
  }
}
