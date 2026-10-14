/**
 * Seek policy for a picture-only <video> element: decides, from the element's state and what the timeline wants, whether to
 * let it PLAY (60 fps without a seek per frame) or to SEEK discretely. Pure, so it is unit-tested without a browser.
 *
 *  - forward playback inside the element's native range (speed ramps and J/K/L included): the element plays at the wanted
 *    rate; small drift is steered with a ±10 % rate nudge, only a large drift triggers a hard seek;
 *  - reverse, freeze, paused / scrubbing and rates outside the native range: the element is paused and seeked to the
 *    frame; at most ONE seek is in flight (latest wins) so a long scrub still shows frames instead of cancelling forever.
 */
export interface ElementState {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  /** NaN / Infinity until metadata is loaded. */
  duration: number;
}

export interface SeekWant {
  /** Source time wanted NOW (already clamped to the asset). */
  srcSec: number;
  /** Source seconds per wall second: >0 forward, <0 reverse, 0 still. */
  rate: number;
  /** The transport is playing. */
  playing: boolean;
  /** Seconds per frame of the source (decides the "close enough" tolerance). */
  frameSec: number;
  /** The source time of the seek currently in flight, or null. */
  inFlight: number | null;
}

export interface SeekConfig {
  /** Native playback range of the element (source seconds per wall second). */
  minPlayRate: number;
  maxPlayRate: number;
  /** Drift above which a playing element is hard-seeked, in seconds (scaled by max(1, rate)). */
  hardDriftSec: number;
  /** Drift above which a playing element's rate is nudged, in seconds. */
  softDriftSec: number;
  /** Max relative rate nudge. */
  nudge: number;
}

export const DEFAULT_SEEK_CONFIG: SeekConfig = {
  minPlayRate: 0.1,
  maxPlayRate: 8,
  hardDriftSec: 0.3,
  softDriftSec: 0.04,
  nudge: 0.1,
};

export interface SeekPlan {
  mode: 'play' | 'discrete';
  /** Assign `currentTime` now. */
  seekTo: number | null;
  /** A seek is wanted but one is in flight: remember it and issue it on `seeked`. */
  deferSeek: number | null;
  /** true = ensure playing, false = ensure paused. */
  play: boolean;
  /** `playbackRate` to set (always the right value for the mode), or null to leave it. */
  rate: number | null;
  /** Signed drift (element − wanted), seconds. */
  drift: number;
}

/** Frame-grid target: lands inside frame k (a quarter frame in) so float noise never picks frame k−1. */
export function quantizeToFrame(srcSec: number, frameSec: number): number {
  if (!(frameSec > 0)) return srcSec;
  return (Math.floor(srcSec / frameSec + 1e-6) + 0.25) * frameSec;
}

export function canPlayNatively(rate: number, cfg: SeekConfig = DEFAULT_SEEK_CONFIG): boolean {
  return rate >= cfg.minPlayRate && rate <= cfg.maxPlayRate;
}

export function planVideoSync(
  el: ElementState,
  want: SeekWant,
  cfg: SeekConfig = DEFAULT_SEEK_CONFIG,
): SeekPlan {
  const drift = el.currentTime - want.srcSec;
  if (want.playing && canPlayNatively(want.rate, cfg)) {
    const hard = cfg.hardDriftSec * Math.max(1, want.rate);
    const wantedRate = want.rate;
    const needsStart = el.paused || el.ended;
    if (el.seeking) {
      // Let the seek in flight finish unless the target moved far from where it is going.
      const far = want.inFlight !== null && Math.abs(want.inFlight - want.srcSec) > hard;
      return {
        mode: 'play',
        seekTo: null,
        deferSeek: far ? want.srcSec : null,
        play: true,
        rate: null,
        drift,
      };
    }
    if (Math.abs(drift) > hard || (needsStart && Math.abs(drift) > want.frameSec)) {
      return {
        mode: 'play',
        seekTo: want.srcSec,
        deferSeek: null,
        play: true,
        rate: wantedRate,
        drift,
      };
    }
    let rate = wantedRate;
    if (Math.abs(drift) > cfg.softDriftSec) {
      // Element ahead (drift > 0) → slow down; behind → speed up.
      const k = Math.max(-cfg.nudge, Math.min(cfg.nudge, -drift / 0.5));
      rate = wantedRate * (1 + k);
    }
    const rateChanged = Math.abs(el.playbackRate - rate) > 1e-3;
    return {
      mode: 'play',
      seekTo: null,
      deferSeek: null,
      play: true,
      rate: rateChanged || needsStart ? rate : null,
      drift,
    };
  }

  // Discrete: pause on the frame.
  const target = quantizeToFrame(want.srcSec, want.frameSec);
  const tol = want.frameSec * 0.5;
  const settled = !el.seeking && Math.abs(el.currentTime - target) <= tol;
  const base: Omit<SeekPlan, 'seekTo' | 'deferSeek'> = {
    mode: 'discrete',
    play: false,
    rate: null,
    drift,
  };
  if (settled) return { ...base, seekTo: null, deferSeek: null };
  if (el.seeking) {
    const sameTarget = want.inFlight !== null && Math.abs(want.inFlight - target) <= tol;
    return { ...base, seekTo: null, deferSeek: sameTarget ? null : target };
  }
  return { ...base, seekTo: target, deferSeek: null };
}

/** How stale a frame may be (source seconds from the wanted time) before it counts as "not ready". */
export function staleToleranceSec(rate: number, playing: boolean, frameSec: number): number {
  if (!playing) return Math.max(0.25, frameSec * 3);
  return Math.max(0.25, Math.abs(rate) * 0.25, frameSec * 3);
}
