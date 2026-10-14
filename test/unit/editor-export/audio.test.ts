/** Audio mix: gains, fades, placement, speed / pitch, reverse, gate, ducking, crossfades, loudness. */
import { describe, expect, it, vi } from 'vitest';
import {
  audioStreamInfo, avClip, decodeAudio, exportProject, files, flatClip, haveFfmpeg, loudness, makeProject, peak, rampTone, rmsDb, settingsFor,
  sineWav, toneThenNoise, tonePower, track, twoTone, vitem, zcr,
} from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const dbOf = (amp: number) => 20 * Math.log10(amp / Math.SQRT2);
const aitem = (id: string, assetId: string, start: number, dur: number, over: Record<string, unknown> = {}) => ({ type: 'audio', id, assetId, startSec: start, durationSec: dur, ...over });
const kf = (a: [number, number][]) => ({ v: 1, kf: a.map(([t, v]) => ({ t, v, ease: 'linear' })) });

const tone = sineWav(440, 4, 0.5); // amplitude 0.5 → -9.03 dB rms
const tone2 = sineWav(1000, 4, 0.5);
const specsA = [
  { id: 'a', kind: 'audio' as const, path: tone, dur: 4, hasAudio: true },
  { id: 'b', kind: 'audio' as const, path: tone2, dur: 4, hasAudio: true },
  { id: 'two', kind: 'audio' as const, path: twoTone(440, 880, 4), dur: 4, hasAudio: true },
  { id: 'ramp', kind: 'audio' as const, path: rampTone(440, 2), dur: 2, hasAudio: true },
  { id: 'gate', kind: 'audio' as const, path: toneThenNoise(), dur: 2, hasAudio: true },
  { id: 'vid', kind: 'video' as const, path: avClip('FF0000', 440, 4, 0.5), w: 160, h: 284, fps: 30, dur: 4, hasAudio: true },
  { id: 'vidsilent', kind: 'video' as const, path: flatClip('00FF00', 4), w: 160, h: 284, fps: 30, dur: 4, hasAudio: false },
];

async function render(tracks: ReturnType<typeof track>[], settings: Parameters<typeof settingsFor>[2] = {}, extra: Parameters<typeof exportProject>[3] = {}) {
  const p = makeProject(tracks, specsA);
  const r = await exportProject(p, files(specsA), settingsFor(160, 284, { loudnessLufs: null, ...settings }), { name: 'audio', ...extra });
  return { r, a: decodeAudio(r.out) };
}
const withVideo = (tr: ReturnType<typeof track>[]) => [track('video', [vitem('pad', 'vidsilent', 0, 4)]), ...tr];

describe.skipIf(!haveFfmpeg)('audio: gain', () => {
  it('unity gain keeps the level (sine amp 0.5 → -9 dB rms)', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2)])]));
    expect(rmsDb(a, 0.2, 1.8)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('item volume 0.5 → -6 dB, volume 2 → +6 dB', async () => {
    const lo = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { volume: { v: 0.5, kf: [] } })])]));
    const hi = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { volume: { v: 2, kf: [] } })])]));
    expect(rmsDb(lo.a, 0.2, 1.8)).toBeCloseTo(dbOf(0.25), 0);
    expect(rmsDb(hi.a, 0.2, 1.8)).toBeCloseTo(dbOf(1.0), 0);
  });

  it('track gain multiplies', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2)], { gain: 0.5 })]));
    expect(rmsDb(a, 0.2, 1.8)).toBeCloseTo(dbOf(0.25), 0);
  });

  it('muted and hidden tracks are silent; other tracks still play', async () => {
    const { a, r } = await render(withVideo([track('audio', [aitem('m', 'a', 0, 2)], { muted: true }), track('audio', [aitem('h', 'a', 0, 2)], { hidden: true }), track('audio', [aitem('b', 'b', 0, 2, { volume: { v: 0.5, kf: [] } })])]));
    expect(tonePower(a, 440, 0.2, 1.8)).toBeLessThan(1e-6);
    expect(tonePower(a, 1000, 0.2, 1.8)).toBeGreaterThan(0.01);
    expect(r.notes.join()).toMatch(/1 item\(s\) mixed/);
  });

  it('a video item with audioEnabled = false is silent; with it enabled the clip audio plays', async () => {
    const off = await render([track('video', [vitem('v', 'vid', 0, 2, { audioEnabled: false })])]);
    expect(off.r.notes.join()).toMatch(/no audible items/);
    expect(audioStreamInfo(off.r.out)).toBeNull();
    const on = await render([track('video', [vitem('v', 'vid', 0, 2)])]);
    expect(rmsDb(on.a, 0.2, 1.8)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('assets without an audio stream are ignored (no audio stream when nothing is audible)', async () => {
    const { r } = await render([track('video', [vitem('v', 'vidsilent', 0, 2)])]);
    expect(audioStreamInfo(r.out)).toBeNull();
  });

  it('volume keyframes 0 → 1 over 1 s: level follows the ramp (itemGainAt)', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { volume: kf([[0, 0], [1, 1]]) })])]));
    expect(rmsDb(a, 0.2, 0.3)).toBeCloseTo(dbOf(0.5 * 0.25), 0); // t = .25 → gain .25
    expect(rmsDb(a, 0.45, 0.55)).toBeCloseTo(dbOf(0.5 * 0.5), 0);
    expect(rmsDb(a, 0.7, 0.8)).toBeCloseTo(dbOf(0.5 * 0.75), 0);
    expect(rmsDb(a, 1.2, 1.8)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('fadeIn / fadeOut are linear gain ramps (shared field)', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { fadeInSec: 0.8, fadeOutSec: 0.8 })])]));
    expect(rmsDb(a, 0.0, 0.05)).toBeLessThan(dbOf(0.5) - 20);
    expect(rmsDb(a, 0.38, 0.42)).toBeCloseTo(dbOf(0.25), 0); // half-way up → half amplitude
    expect(rmsDb(a, 0.9, 1.1)).toBeCloseTo(dbOf(0.5), 0);
    expect(rmsDb(a, 1.58, 1.62)).toBeCloseTo(dbOf(0.25), 0);
    expect(rmsDb(a, 1.95, 2.0)).toBeLessThan(dbOf(0.5) - 20);
  });

  it('the peak never exceeds the mix (no hidden limiter / normaliser)', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2)])]));
    expect(peak(a, 0.2, 1.8)).toBeGreaterThan(0.45);
    expect(peak(a, 0.2, 1.8)).toBeLessThan(0.56);
  });
});

describe.skipIf(!haveFfmpeg)('audio: placement and trimming', () => {
  it('startSec places the item on the timeline (silence before, tone after, ±2 ms)', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 1.0, 1.5)])]));
    expect(rmsDb(a, 0.0, 0.99)).toBeLessThan(-80);
    expect(peak(a, 0.9, 0.998)).toBeLessThan(0.001);
    expect(peak(a, 1.003, 1.02)).toBeGreaterThan(0.2);
  });

  it('inSec trims the source: skipping the first tone leaves only the second', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'two', 0, 1.5, { inSec: 2 })])]));
    expect(tonePower(a, 880, 0.1, 1.4)).toBeGreaterThan(0.05);
    expect(tonePower(a, 440, 0.1, 1.4)).toBeLessThan(0.001);
  });

  it('an item longer than its source is silent after the source ends', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'ramp', 0, 3.5)])]));
    expect(rmsDb(a, 2.2, 3.4)).toBeLessThan(-70);
  });

  it('range export: item audio is cut and shifted to the range start', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0.5, 2)])]), {}, { range: { startSec: 1.0, endSec: 2.0 } });
    expect(a.data.length / a.rate).toBeCloseTo(1.0, 1);
    expect(rmsDb(a, 0.1, 0.9)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('range starting inside the item with a delay keeps absolute placement', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 1.5, 2)])]), {}, { range: { startSec: 1.0, endSec: 2.5 } });
    expect(rmsDb(a, 0.0, 0.45)).toBeLessThan(-80);
    expect(rmsDb(a, 0.6, 1.4)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('mono sources are mixed to stereo (both channels carry the signal)', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2)])]));
    expect(audioStreamInfo(r.out)).toMatchObject({ codec: 'aac', rate: 48000, channels: 2 });
  });

  it('audio duration matches the video duration (±50 ms) even if the last item ends early', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 1)])]));
    expect(Math.abs((audioStreamInfo(r.out)?.dur ?? 0) - 4)).toBeLessThan(0.06);
  });
});

describe.skipIf(!haveFfmpeg)('audio: speed, pitch, reverse', () => {
  const zc = (a: ReturnType<typeof decodeAudio>, t0: number, t1: number) => zcr(a, t0, t1) / 2;

  it('speed 2 with preservePitch keeps the pitch and halves the duration', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'two', 0, 2, { speed: 2 })])]));
    expect(zc(a, 0.2, 0.9)).toBeGreaterThan(425); // first half of the source (440 Hz) plays in 1 s
    expect(zc(a, 0.2, 0.9)).toBeLessThan(455);
    expect(zc(a, 1.2, 1.9)).toBeGreaterThan(860); // second half (880 Hz)
    expect(zc(a, 1.2, 1.9)).toBeLessThan(900);
  });

  it('speed 2 with preservePitch = false doubles the pitch', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { speed: 2, preservePitch: false })])]));
    expect(zc(a, 0.2, 1.8)).toBeGreaterThan(860);
    expect(zc(a, 0.2, 1.8)).toBeLessThan(900);
  });

  it('speed 0.5 without pitch preservation halves the pitch; with it the pitch stays', async () => {
    const raw = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { speed: 0.5, preservePitch: false })])]));
    const keep = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { speed: 0.5 })])]));
    expect(zc(raw.a, 0.2, 1.8)).toBeGreaterThan(210);
    expect(zc(raw.a, 0.2, 1.8)).toBeLessThan(230);
    expect(zc(keep.a, 0.2, 1.8)).toBeGreaterThan(425);
    expect(zc(keep.a, 0.2, 1.8)).toBeLessThan(455);
  });

  it('speed 0.25 (two atempo stages) keeps the pitch', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { speed: 0.25 })])]));
    expect(zc(a, 0.3, 1.7)).toBeGreaterThan(420);
    expect(zc(a, 0.3, 1.7)).toBeLessThan(460);
  });

  it('speed ramp 1 → 3 (pitch not preserved): frequency rises with time', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { preservePitch: false, speedCurve: [{ t: 0, v: 1, ease: 'linear' }, { t: 2, v: 3, ease: 'linear' }] })])]));
    const f0 = zc(a, 0.1, 0.4);
    const f1 = zc(a, 0.9, 1.2);
    const f2 = zc(a, 1.6, 1.9);
    expect(f1).toBeGreaterThan(f0 * 1.3);
    expect(f2).toBeGreaterThan(f1 * 1.2);
    expect(f0).toBeGreaterThan(440 * 1.0);
  });

  it('reverse plays the window backwards (an upward amplitude ramp becomes downward)', async () => {
    const fwd = await render(withVideo([track('audio', [aitem('x', 'ramp', 0, 2)])]));
    const rev = await render(withVideo([track('audio', [aitem('x', 'ramp', 0, 2, { reverse: true })])]));
    expect(rmsDb(fwd.a, 1.6, 1.9)).toBeGreaterThan(rmsDb(fwd.a, 0.1, 0.4) + 6);
    expect(rmsDb(rev.a, 0.1, 0.4)).toBeGreaterThan(rmsDb(rev.a, 1.6, 1.9) + 6);
  });

  it('reverse with inSec reverses only the selected window', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'two', 0, 1, { inSec: 1.5, reverse: true })])]));
    // window 1.5..2.5 = 0.5 s of 440 Hz then 0.5 s of 880 Hz; reversed → 880 first
    expect(tonePower(a, 880, 0.05, 0.45)).toBeGreaterThan(0.05);
    expect(tonePower(a, 440, 0.55, 0.95)).toBeGreaterThan(0.05);
  });

  it('noise gate (-45 dB) silences a quiet passage; without it the noise stays', async () => {
    const open = await render(withVideo([track('audio', [aitem('x', 'gate', 0, 2)])]));
    const gated = await render(withVideo([track('audio', [aitem('x', 'gate', 0, 2, { noiseGate: true })])]));
    expect(rmsDb(open.a, 1.3, 1.9)).toBeGreaterThan(-75);
    expect(rmsDb(gated.a, 1.3, 1.9)).toBeLessThan(rmsDb(open.a, 1.3, 1.9) - 8);
    expect(rmsDb(gated.a, 0.2, 0.9)).toBeCloseTo(rmsDb(open.a, 0.2, 0.9), 0); // loud part untouched
  });
});

describe.skipIf(!haveFfmpeg)('audio: mixing and ducking', () => {
  it('two overlapping items add (amix normalize = 0): both tones keep their level', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2)]), track('audio', [aitem('y', 'b', 0, 2)])]));
    expect(tonePower(a, 440, 0.2, 1.8)).toBeCloseTo(0.125, 2); // amp²/2
    expect(tonePower(a, 1000, 0.2, 1.8)).toBeCloseTo(0.125, 2);
  });

  it('a sequence on one track is not attenuated by the number of inputs', async () => {
    const { a } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 1), aitem('y', 'a', 1, 1), aitem('z', 'a', 2, 1)])]));
    expect(rmsDb(a, 0.2, 0.8)).toBeCloseTo(dbOf(0.5), 0);
    expect(rmsDb(a, 2.2, 2.8)).toBeCloseTo(dbOf(0.5), 0);
  });

  const duckSettings = { enabled: true, reductionDb: 12, attackSec: 0.15, releaseSec: 0.5 };
  const speechTrack = track('video', [vitem('sp', 'vidsilent', 1.0, 1.0, { audioEnabled: false })], { speech: true });

  it('ducking: -12 dB inside speech, unducked outside, attack ramp BEFORE the speech, release after', async () => {
    const pad = track('video', [vitem('pad', 'vidsilent', 3.0, 1.0, { audioEnabled: false })], { speech: false });
    const { a } = await render([speechTrack, pad, track('audio', [aitem('m', 'b', 0, 4)], { ducking: duckSettings })]);
    const full = dbOf(0.5);
    expect(rmsDb(a, 0.2, 0.7)).toBeCloseTo(full, 0);
    expect(rmsDb(a, 1.1, 1.95)).toBeCloseTo(full - 12, 0);
    expect(rmsDb(a, 0.83, 0.87)).toBeCloseTo(full, 0); // before the attack window (1.0 - 0.15)
    const mid = rmsDb(a, 0.94, 0.96); // inside the attack ramp
    expect(mid).toBeLessThan(full - 1);
    expect(mid).toBeGreaterThan(full - 11);
    const rel = rmsDb(a, 2.2, 2.3); // 0.25 s after speech end: half way through the release
    expect(rel).toBeGreaterThan(full - 12 + 1);
    expect(rel).toBeLessThan(full - 1);
    expect(rmsDb(a, 3.0, 3.8)).toBeCloseTo(full, 0);
  });

  it('ducking only affects tracks with ducking enabled', async () => {
    const { a } = await render([speechTrack, track('audio', [aitem('m', 'b', 0, 4)]), track('video', [vitem('pad', 'vidsilent', 3.0, 1.0, { audioEnabled: false })])]);
    expect(rmsDb(a, 1.1, 1.9)).toBeCloseTo(dbOf(0.5), 0);
  });

  it('speech ranges come from the subtitle cues when there are any', async () => {
    const sub = track('subtitle', [{ type: 'subtitle', id: 's', startSec: 2.0, durationSec: 1, words: [{ w: 'talk', s: 0, e: 0.8, color: null }], styleId: 'clean-pop' }]);
    const { a } = await render([track('video', [vitem('pad', 'vidsilent', 0, 4, { audioEnabled: false })], { speech: true }), sub, track('audio', [aitem('m', 'b', 0, 4)], { ducking: duckSettings })], { burnCaptions: false });
    expect(rmsDb(a, 0.2, 1.5)).toBeCloseTo(dbOf(0.5), 0); // video speech track ignored: subtitles decide
    expect(rmsDb(a, 2.1, 2.7)).toBeCloseTo(dbOf(0.5) - 12, 0);
  });

  it('video audio on a speech track counts as speech and ducks the music', async () => {
    const { a } = await render([track('video', [vitem('v', 'vid', 1.0, 1.5)], { speech: true }), track('audio', [aitem('m', 'b', 0, 4)], { ducking: duckSettings })]);
    expect(tonePower(a, 1000, 1.2, 2.3)).toBeCloseTo(0.125 * Math.pow(10, -12 / 10), 3);
    expect(tonePower(a, 440, 1.2, 2.3)).toBeGreaterThan(0.1);
  });

  it('transition overlap crossfades the audio of the two items (linear gain ramps)', async () => {
    const vids = [
      { id: 'v1', kind: 'video' as const, path: avClip('FF0000', 440, 4, 0.5), w: 160, h: 284, fps: 30, dur: 4, hasAudio: true },
      { id: 'v2', kind: 'video' as const, path: avClip('0000FF', 1000, 4, 0.5), w: 160, h: 284, fps: 30, dur: 4, hasAudio: true },
    ];
    const p = makeProject([track('video', [vitem('a', 'v1', 0, 2), vitem('b', 'v2', 1.5, 2, { transitionIn: { type: 'crossfade', durationSec: 1 } })])], vids);
    const r = await exportProject(p, files(vids), settingsFor(160, 284, { loudnessLufs: null }), { name: 'xfade' });
    const a = decodeAudio(r.out);
    expect(tonePower(a, 440, 0.2, 1.2)).toBeCloseTo(0.125, 2);
    expect(tonePower(a, 1000, 0.2, 1.2)).toBeLessThan(1e-4);
    // overlap 1.5 .. 2.5: at 1.75 (p = .25) 440 Hz has 0.75, 1000 Hz 0.25
    expect(tonePower(a, 440, 1.7, 1.8) / 0.125).toBeCloseTo(0.75 ** 2, 1);
    expect(tonePower(a, 1000, 1.7, 1.8) / 0.125).toBeCloseTo(0.25 ** 2, 1);
    expect(tonePower(a, 1000, 2.7, 3.4)).toBeCloseTo(0.125, 2);
  });
});

describe.skipIf(!haveFfmpeg)('audio: loudness (two-pass loudnorm)', () => {
  it('normalises a quiet source to -14 LUFS (±0.5 LU)', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4, { volume: { v: 0.15, kf: [] } })])]), { loudnessLufs: -14 });
    expect(Math.abs(loudness(r.out).lufs - -14)).toBeLessThan(0.5);
    expect(r.notes.join()).toMatch(/two-pass/);
  });

  it('normalises a loud source down; custom target -18', async () => {
    const hot = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4, { volume: { v: 1.9, kf: [] } })])]), { loudnessLufs: -14 });
    expect(Math.abs(loudness(hot.r.out).lufs - -14)).toBeLessThan(0.5);
    const t18 = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4)])]), { loudnessLufs: -18 });
    expect(Math.abs(loudness(t18.r.out).lufs - -18)).toBeLessThan(0.5);
  });

  it('true peak stays below -1 dBTP after normalisation', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4, { volume: { v: 0.15, kf: [] } })])]), { loudnessLufs: -9 });
    expect(loudness(r.out).peakDb).toBeLessThan(-0.9);
  });

  it('loudnessLufs = null leaves the level untouched', async () => {
    const { a, r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4, { volume: { v: 0.15, kf: [] } })])]), { loudnessLufs: null });
    expect(rmsDb(a, 0.5, 3.5)).toBeCloseTo(dbOf(0.075), 0);
    expect(r.notes.join()).not.toMatch(/loudnorm/);
  });

  it('measureLoudness = false falls back to single-pass loudnorm and says so', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 4)])]), { loudnessLufs: -14 }, { measureLoudness: false });
    expect(r.notes.join()).toMatch(/single pass/);
  });

  it('a silent mix skips loudnorm instead of amplifying noise', async () => {
    const { r } = await render(withVideo([track('audio', [aitem('x', 'a', 0, 2, { volume: { v: 0, kf: [] } })])]), { loudnessLufs: -14 });
    expect(r.notes.join()).toMatch(/silent/);
  });
});
