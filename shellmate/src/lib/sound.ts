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

// All sounds run through one soft "master bus": a gentle low-pass to take the edge off,
// a compressor so stacked notes never clip, and a short echo for a little warmth.
let bus: AudioNode | null = null;

function getBus(ac: AudioContext): AudioNode {
  if (bus) return bus;
  const input = ac.createGain();
  input.gain.value = 0.9;

  const lowpass = ac.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3800;
  lowpass.Q.value = 0.5;

  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;

  // Short, quiet echo (feedback delay) for a soft "room".
  const delay = ac.createDelay(0.5);
  delay.delayTime.value = 0.11;
  const feedback = ac.createGain();
  feedback.gain.value = 0.22;
  const wet = ac.createGain();
  wet.gain.value = 0.16;

  input.connect(lowpass);
  lowpass.connect(comp);
  lowpass.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(comp);
  comp.connect(ac.destination);

  bus = input;
  return bus;
}

type NoteOpts = {
  freq: number;
  start?: number;
  /** How long the note rings out. */
  decay: number;
  gain?: number;
  /** Optional pitch glide target (Hz). */
  slideTo?: number;
  /** Adds a quiet octave overtone for a bell / marimba feel. */
  bell?: boolean;
};

/** A soft, rounded note: sine wave, fast-but-not-clicky attack, smooth exponential decay. */
function note(ac: AudioContext, { freq, start = 0, decay, gain = 0.2, slideTo, bell = false }: NoteOpts) {
  const out = getBus(ac);
  const t0 = ac.currentTime + 0.005 + start;
  const partials: [number, number][] = bell ? [[1, 1], [2, 0.25], [3, 0.06]] : [[1, 1]];
  for (const [mult, level] of partials) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo * mult, t0 + decay * 0.8);
    const peak = gain * level;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    // Higher partials fade faster, like a real struck bar.
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay / mult);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }
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

// Note frequencies (Hz).
const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.51, G6 = 1567.98;
const A3 = 220, F3 = 174.61;

export const sfx = {
  /** Bright two-note chime going up. */
  correct: () =>
    play((ac) => {
      note(ac, { freq: G5, decay: 0.35, gain: 0.16, bell: true });
      note(ac, { freq: C6, start: 0.09, decay: 0.6, gain: 0.18, bell: true });
    }),
  /** Soft, low "hmm" going down: says "not quite" without a harsh buzz. */
  wrong: () =>
    play((ac) => {
      note(ac, { freq: A3, decay: 0.28, gain: 0.2 });
      note(ac, { freq: F3, start: 0.13, decay: 0.42, gain: 0.2, slideTo: 165 });
    }),
  /** Little rising arpeggio that lands on a sparkly chord. */
  complete: () =>
    play((ac) => {
      [C5, E5, G5, C6].forEach((f, i) => note(ac, { freq: f, start: i * 0.085, decay: 0.45, gain: 0.13, bell: true }));
      [C6, E6, G6].forEach((f) => note(ac, { freq: f, start: 0.38, decay: 1.2, gain: 0.08, bell: true }));
      note(ac, { freq: A5 * 2, start: 0.52, decay: 0.5, gain: 0.03 });
    }),
  /** Quiet, short wooden "tock" for buttons. */
  tap: () =>
    play((ac) => {
      note(ac, { freq: 740, decay: 0.07, gain: 0.06, slideTo: 520 });
    }),
};
