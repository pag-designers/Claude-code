// Tiny synthesized sound effects via the Web Audio API (no audio files).

let ctx: AudioContext | null = null;
let isMuted: () => boolean = () => false;

/** Let the store tell us whether sound is muted (avoids an import cycle). */
export function setMuteSource(fn: () => boolean): void {
  isMuted = fn;
}

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Create/resume the AudioContext lazily on the first user gesture (autoplay policy). */
export function installAudioUnlock(): () => void {
  const unlock = () => {
    getCtx();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  return unlock;
}

type ToneOpts = {
  freq: number;
  start?: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
};

function tone(ac: AudioContext, { freq, start = 0, duration, type = 'sine', gain = 0.18, slideTo }: ToneOpts) {
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function play(fn: (ac: AudioContext) => void) {
  if (isMuted()) return;
  const ac = getCtx();
  if (!ac) return;
  try {
    fn(ac);
  } catch {
    /* ignore audio errors */
  }
}

export const sfx = {
  correct: () =>
    play((ac) => {
      tone(ac, { freq: 660, duration: 0.12, type: 'triangle' });
      tone(ac, { freq: 990, start: 0.1, duration: 0.2, type: 'triangle' });
    }),
  wrong: () =>
    play((ac) => {
      tone(ac, { freq: 160, duration: 0.28, type: 'sawtooth', gain: 0.09, slideTo: 110 });
      tone(ac, { freq: 120, start: 0.02, duration: 0.26, type: 'square', gain: 0.05 });
    }),
  complete: () =>
    play((ac) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(ac, { freq: f, start: i * 0.1, duration: 0.18, type: 'triangle', gain: 0.16 }),
      );
      tone(ac, { freq: 1318.5, start: 0.42, duration: 0.45, type: 'sine', gain: 0.14 });
    }),
  tap: () =>
    play((ac) => {
      tone(ac, { freq: 1800, duration: 0.03, type: 'square', gain: 0.04 });
    }),
};
