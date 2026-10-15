import { describe, expect, it } from 'vitest';
import {
  audioItemSchema,
  projectSchema,
  subtitleItemSchema,
  videoItemSchema,
  type AudioItem,
  type Keyframe,
  type Project,
  type SubtitleItem,
  type VideoItem,
} from '@shared/editor';
import { cubicBezier, ease, interpolate, makeSourceTime, sourceSpan } from '@shared/editor-eval';
import {
  PATH_META,
  dbToGain,
  diamondState,
  formatDb,
  fromDisplay,
  gainToDb,
  getAnimated,
  keyframeIndexAt,
  keyframeToggle,
  localTime,
  neighbourKeyframes,
  nestPatch,
  toDisplay,
  valueAtPlayhead,
} from '../../renderer/components/editor/inspector/lib/animated';
import {
  BEZIER_PRESETS,
  bezierMapper,
  bezierToEasing,
  easingChoice,
  easingToBezier,
  matchPreset,
  moveHandle,
  nearestHandle,
} from '../../renderer/components/editor/inspector/lib/bezier';
import {
  autoDomain,
  clampKeyframeTime,
  graphMapper,
  hitKeyframe,
  sampleCurve,
  segmentAt,
} from '../../renderer/components/editor/inspector/lib/graph';
import {
  clampNum,
  formatNumeric,
  modStep,
  parseNumeric,
  scrubValue,
} from '../../renderer/components/editor/inspector/lib/numeric';
import {
  RAMP_PRESETS,
  averageSpeed,
  clampSpeed,
  constantFromRamp,
  fitRampToSpan,
  formatSpeed,
  rampFromConstant,
  sameRamp,
} from '../../renderer/components/editor/inspector/lib/speed';
import {
  aspectCropRect,
  beatCutTimes,
  cueSourceRange,
  findCueMedia,
  mapSourceWordsToCue,
  reframeToCropTracks,
  reframeWindow,
  sourceToLocal,
  sourceWindow,
  thinCropKeys,
  timelineBeats,
  type CropKey,
} from '../../renderer/components/editor/inspector/lib/retime';

const video = (over: Partial<VideoItem> = {}): VideoItem =>
  videoItemSchema.parse({
    type: 'video',
    id: 'v1',
    assetId: 'a1',
    startSec: 10,
    durationSec: 8,
    inSec: 4,
    ...over,
  });
const audio = (over: Partial<AudioItem> = {}): AudioItem =>
  audioItemSchema.parse({
    type: 'audio',
    id: 'm1',
    assetId: 'a2',
    startSec: 0,
    durationSec: 20,
    ...over,
  });
const kf = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });

describe('animated-value display + keyframe toggle', () => {
  it('shows the animated value at the playhead (item-local), clamped to the clip', () => {
    const it = video({
      transform: {
        x: { v: 0, kf: [kf(0, 0), kf(4, 400)] },
        y: { v: 0, kf: [] },
        scale: { v: 1.5, kf: [] },
        rotation: { v: 0, kf: [] },
        opacity: { v: 1, kf: [] },
      },
    });
    expect(valueAtPlayhead(it, 'transform.x', 12)).toBeCloseTo(200); // 2 s into the clip
    expect(valueAtPlayhead(it, 'transform.x', 0)).toBe(0); // before the clip: first value
    expect(valueAtPlayhead(it, 'transform.x', 99)).toBe(400); // after: last value
    expect(valueAtPlayhead(it, 'transform.scale', 12)).toBe(1.5); // no keyframes: base value
    expect(valueAtPlayhead(audio(), 'transform.x', 1)).toBeNull();
    expect(localTime(it, 12)).toEqual({ t: 2, inside: true });
    expect(localTime(it, 30)).toEqual({ t: 8, inside: false });
  });

  it('diamond: add captures the CURRENT value, remove finds the keyframe under the playhead, none outside', () => {
    const it = video({
      transform: {
        x: { v: 0, kf: [kf(0, 0), kf(4, 400)] },
        y: { v: 25, kf: [] },
        scale: { v: 1, kf: [] },
        rotation: { v: 0, kf: [] },
        opacity: { v: 1, kf: [] },
      },
    });
    // at local 2 s there is no keyframe: add one holding the interpolated 200
    expect(keyframeToggle(it, 'transform.x', 12, 30)).toEqual({ type: 'add', t: 2, v: 200 });
    // at local 4 s (within half a frame) the keyframe at index 1 is removed
    expect(keyframeToggle(it, 'transform.x', 14.01, 30)).toEqual({ type: 'remove', index: 1 });
    // un-animated property: adding captures the base value
    expect(keyframeToggle(it, 'transform.y', 11, 30)).toEqual({ type: 'add', t: 1, v: 25 });
    // playhead outside the clip, or property not on the item
    expect(keyframeToggle(it, 'transform.x', 5, 30).type).toBe('none');
    expect(keyframeToggle(audio(), 'transform.x', 1, 30).type).toBe('none');
  });

  it('diamond state and neighbour keyframes', () => {
    const it = video({
      volume: { v: 1, kf: [kf(1, 1), kf(3, 0.2), kf(6, 1)] },
    });
    expect(diamondState(it, 'volume', 10, 30)).toBe('animated'); // local 0, keyframes elsewhere
    expect(diamondState(it, 'volume', 13, 30)).toBe('on'); // local 3
    expect(diamondState(it, 'blur', 13, 30)).toBe('none');
    const a = getAnimated(it, 'volume')!;
    expect(keyframeIndexAt(a.kf, 3.01, 0.0167)).toBe(1);
    expect(keyframeIndexAt(a.kf, 4.5, 0.0167)).toBe(-1);
    expect(neighbourKeyframes(a.kf, 3, 0.0167)).toEqual({ prev: 1, next: 6 });
    expect(neighbourKeyframes(a.kf, 0, 0.0167)).toEqual({ prev: null, next: 1 });
    expect(neighbourKeyframes(a.kf, 7, 0.0167)).toEqual({ prev: 6, next: null });
  });

  it('nests a dotted path into a patch and converts display ↔ stored units', () => {
    expect(nestPatch('transform.x', { v: 3 })).toEqual({ transform: { x: { v: 3 } } });
    expect(nestPatch('volume', { v: 1 })).toEqual({ volume: { v: 1 } });
    expect(toDisplay('transform.opacity', 0.5)).toBe(50);
    expect(fromDisplay('transform.scale', 150)).toBe(1.5);
    for (const [p, m] of Object.entries(PATH_META)) {
      expect(m.min, p).toBeLessThan(m.max);
      expect(m.neutral, p).toBeGreaterThanOrEqual(m.min);
      expect(m.neutral, p).toBeLessThanOrEqual(m.max);
    }
  });

  it('dB labels', () => {
    expect(gainToDb(1)).toBeCloseTo(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 3);
    expect(formatDb(1)).toBe('0.0 dB');
    expect(formatDb(0.5)).toBe('−6.0 dB');
    expect(formatDb(2)).toBe('+6.0 dB');
    expect(formatDb(0)).toBe('−∞ dB');
  });
});

describe('speed ramp ↔ constant conversion', () => {
  it('a flat ramp consumes the same source as the constant speed it came from', () => {
    const base = video({ speed: 2, durationSec: 6 });
    const ramp = video({ speed: 2, durationSec: 6, speedCurve: rampFromConstant(2, 6) });
    expect(sourceSpan(ramp)).toBeCloseTo(sourceSpan(base), 3);
    expect(constantFromRamp(ramp)).toBeCloseTo(2, 3);
  });

  it('collapsing a real ramp keeps the source span (average speed)', () => {
    const ramp = video({ durationSec: 5, speedCurve: [kf(0, 0.5), kf(5, 3)] });
    const avg = constantFromRamp(ramp);
    expect(avg).toBeCloseTo(averageSpeed(ramp), 6);
    expect(sourceSpan(video({ durationSec: 5, speed: avg }))).toBeCloseTo(sourceSpan(ramp), 2);
  });

  it('presets stay inside 0.1–10× and fitRampToSpan hits the requested span', () => {
    for (const p of RAMP_PRESETS) {
      const keys = p.build(4, 1);
      expect(keys.length, p.id).toBeGreaterThanOrEqual(2);
      for (const k of keys) {
        expect(k.v).toBeGreaterThanOrEqual(0.1);
        expect(k.v).toBeLessThanOrEqual(10);
      }
      expect(keys[0]!.t).toBe(0);
      expect(keys[keys.length - 1]!.t).toBe(4);
    }
    const item = video({ durationSec: 4 });
    const keys = RAMP_PRESETS[0]!.build(4, 1);
    const fitted = fitRampToSpan(item, keys, 4);
    expect(sourceSpan({ ...item, speedCurve: fitted })).toBeCloseTo(4, 1);
    expect(sameRamp(keys, keys)).toBe(true);
    expect(sameRamp(keys, fitted)).toBe(false);
    expect(clampSpeed(50)).toBe(10);
    expect(clampSpeed(0)).toBe(0.1);
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(0.25)).toBe('0.25×');
    expect(formatSpeed(1.5)).toBe('1.5×');
  });
});

describe('source-time mapping (re-sync, reframe, beats)', () => {
  it('sourceToLocal inverts makeSourceTime for constant speed, ramps and reverse', () => {
    const items = [
      video({ speed: 2 }),
      video({ speed: 0.5 }),
      video({ reverse: true, speed: 1.5 }),
      video({ speedCurve: [kf(0, 0.5), kf(4, 3), kf(8, 1)] }),
      video({ reverse: true, speedCurve: [kf(0, 2), kf(8, 0.4)] }),
    ];
    for (const it of items) {
      const f = makeSourceTime(it);
      for (const tl of [0.5, 2, 4.7, 7.5]) {
        const back = sourceToLocal(it, f(tl));
        expect(back, JSON.stringify(it.speedCurve)).not.toBeNull();
        expect(back as number).toBeCloseTo(tl, 2);
      }
    }
  });

  it('is null outside the covered window and for a freeze frame', () => {
    const it = video({ speed: 2 }); // covers source 4..20
    expect(sourceToLocal(it, 3)).toBeNull();
    expect(sourceToLocal(it, 21)).toBeNull();
    expect(sourceToLocal(video({ freezeAtSec: 5 }), 5)).toBeNull();
    expect(sourceWindow(it)).toEqual({ start: 4, end: 20 });
    expect(sourceWindow(video({ reverse: true, speed: 2 }))).toEqual({ start: 4, end: 20 });
  });

  const cue = (over: Partial<SubtitleItem> = {}): SubtitleItem =>
    subtitleItemSchema.parse({
      type: 'subtitle',
      id: 'c1',
      startSec: 12,
      durationSec: 2,
      words: [
        { w: 'hello', s: 0, e: 0.5, color: '#FFE94D' },
        { w: 'brave', s: 0.5, e: 1, color: null },
        { w: 'world', s: 1, e: 2, color: null },
      ],
      ...over,
    });

  it('asks for the cue SOURCE range and maps source words back to cue-local timeline times (speed 2×)', () => {
    const media = video({ speed: 2, startSec: 10, inSec: 4, durationSec: 8 });
    const c = cue(); // timeline 12..14 → media local 2..4 → source 8..12
    const r = cueSourceRange(media, c, 0);
    expect(r).toEqual({ srcStartSec: 8, srcEndSec: 12 });
    const padded = cueSourceRange(media, c, 0.25);
    expect(padded.srcStartSec).toBeCloseTo(7.75);
    expect(padded.srcEndSec).toBeCloseTo(12.25);
    // whisper returns words in SOURCE time (8..12): at 2× each source second is half a timeline second
    const words = mapSourceWordsToCue(media, c, [
      { w: 'hello', s: 8.0, e: 9.0 },
      { w: 'brave', s: 9.0, e: 10.0 },
      { w: 'world', s: 10.0, e: 12.0 },
    ]);
    expect(words.map((w) => w.w)).toEqual(['hello', 'brave', 'world']);
    expect(words[0]!.s).toBeCloseTo(0);
    expect(words[0]!.e).toBeCloseTo(0.5);
    expect(words[1]!.s).toBeCloseTo(0.5);
    expect(words[2]!.e).toBeCloseTo(2);
    expect(words[0]!.color).toBe('#FFE94D'); // same word count: highlight colours survive
  });

  it('drops padding words that fall outside the cue and handles reverse', () => {
    const media = video({ speed: 1, startSec: 10, inSec: 4, durationSec: 8 });
    const c = cue(); // source 6..8
    const words = mapSourceWordsToCue(media, c, [
      { w: 'before', s: 5.7, e: 5.95 },
      { w: 'hello', s: 6.0, e: 6.6 },
      { w: 'there', s: 6.6, e: 8.0 },
      { w: 'after', s: 8.1, e: 8.4 },
    ]);
    expect(words.map((w) => w.w)).toEqual(['hello', 'there']);
    expect(words[0]!.color).toBeNull(); // count changed: colours reset
    const rev = video({ reverse: true, startSec: 10, inSec: 4, durationSec: 8 });
    // reverse plays source 12→4: timeline 12 shows source 10, timeline 14 shows source 8
    const rw = mapSourceWordsToCue(rev, c, [
      { w: 'x', s: 9.0, e: 9.5 },
      { w: 'y', s: 9.5, e: 10 },
    ]);
    expect(rw.map((w) => w.w)).toEqual(['y', 'x']); // spoken order flips with the picture
    expect(rw[0]!.s).toBeCloseTo(0, 2);
    expect(rw[0]!.e).toBeCloseTo(0.5, 2);
    expect(rw[1]!.s).toBeCloseTo(0.5, 2);
    expect(rw[1]!.e).toBeCloseTo(1, 2);
  });

  it('finds the media item carrying the speech (audible, most overlap, speech track wins ties)', () => {
    const v1 = video({ id: 'v1', startSec: 0, durationSec: 13 });
    const v2 = video({ id: 'v2', startSec: 13, durationSec: 10 });
    const muted = video({ id: 'v3', startSec: 0, durationSec: 30, audioEnabled: false });
    const project: Project = projectSchema.parse({
      tracks: [
        { id: 't1', kind: 'video', name: 'V', speech: true, items: [v1, v2] },
        { id: 't2', kind: 'overlay', name: 'O', items: [muted] },
      ],
      assets: [],
    });
    const c = subtitleItemSchema.parse({
      type: 'subtitle',
      id: 'c',
      startSec: 12,
      durationSec: 4,
      words: [],
    });
    expect(findCueMedia(project, c)?.id).toBe('v2'); // 3 s overlap vs 1 s
    const early = subtitleItemSchema.parse({
      type: 'subtitle',
      id: 'c',
      startSec: 1,
      durationSec: 2,
      words: [],
    });
    expect(findCueMedia(project, early)?.id).toBe('v1'); // not the muted overlay
    const none = subtitleItemSchema.parse({
      type: 'subtitle',
      id: 'c',
      startSec: 40,
      durationSec: 2,
      words: [],
    });
    expect(findCueMedia(project, none)).toBeNull();
  });

  it('reframe: source window, local-time crop keyframes through speed, thinning', () => {
    const it = video({ speed: 2, startSec: 0, inSec: 4, durationSec: 8 }); // source 4..20
    expect(reframeWindow(it)).toEqual({ startSec: 4, endSec: 20 });
    expect(reframeWindow(video({ freezeAtSec: 3 }))).toBeNull();
    const keys: CropKey[] = Array.from({ length: 17 }, (_, i) => ({
      t: i, // 0..16 s from the window start
      x: 0.2 + i * 0.02,
      y: 0,
      w: 0.3,
      h: 1,
    }));
    const tracks = reframeToCropTracks(it, keys, 4)!;
    // linear motion thins to its two end points; times are LOCAL (source/2)
    expect(tracks.x).toHaveLength(2);
    expect(tracks.x[0]).toEqual({ t: 0, v: 0.2, ease: 'linear' });
    expect(tracks.x[1]).toEqual({ t: 8, v: 0.52, ease: 'linear' });
    expect(tracks.w.map((k) => k.v)).toEqual([0.3, 0.3]);
    // a key that is not on the item is ignored; nothing left → null
    expect(reframeToCropTracks(it, [{ t: 99, x: 0, y: 0, w: 1, h: 1 }], 4)).toBeNull();
  });

  it('thinning keeps real turns and respects maxKeys', () => {
    const zig: CropKey[] = Array.from({ length: 41 }, (_, i) => ({
      t: i * 0.25,
      x: i % 2 ? 0.6 : 0.2,
      y: 0,
      w: 0.3,
      h: 1,
    }));
    expect(thinCropKeys(zig, 0.004).length).toBe(41);
    expect(thinCropKeys(zig, 0.004, 10)).toHaveLength(10);
    expect(thinCropKeys(zig.slice(0, 2))).toHaveLength(2);
  });

  it('aspect-locked crop rectangles', () => {
    // 16:9 source cropped to 9:16 → full height, 31.6 % of the width, centred
    const r = aspectCropRect(1920, 1080, 9 / 16);
    expect(r.h).toBe(1);
    expect(r.w).toBeCloseTo(0.3164, 3);
    expect(r.x).toBeCloseTo((1 - r.w) / 2, 3);
    // square from a portrait source → full width
    const sq = aspectCropRect(1080, 1920, 1);
    expect(sq.w).toBe(1);
    expect(sq.h).toBeCloseTo(0.5625, 3);
    // centre on the right edge stays inside the frame
    const right = aspectCropRect(1920, 1080, 9 / 16, { cx: 1, cy: 0.5 });
    expect(right.x + right.w).toBeCloseTo(1, 3);
  });

  it('beats: timeline beats from placed audio, cut times strictly inside the clip', () => {
    const project = projectSchema.parse({
      tracks: [
        {
          id: 'tm',
          kind: 'audio',
          name: 'Music',
          // plays source 2..22 at 1× starting at timeline 5
          items: [audio({ id: 'm', startSec: 5, inSec: 2, durationSec: 20 })],
        },
      ],
      assets: [
        {
          id: 'a2',
          kind: 'audio',
          name: 'beat.mp3',
          source: { kind: 'upload', key: 'k', fileName: 'beat.mp3' },
          beats: [0.5, 2, 3, 4, 5, 6, 30],
        },
      ],
    });
    // source 2→timeline 5, 3→6 … 6→9; 0.5 is before the window; 30 after
    expect(timelineBeats(project)).toEqual([5, 6, 7, 8, 9]);
    const clip = video({ startSec: 5, durationSec: 4 });
    expect(beatCutTimes(clip, [5, 6, 7, 8, 9], 5, 2)).toEqual([6, 7]);
    // the playhead excludes earlier beats; the clip end excludes the last beat
    expect(beatCutTimes(clip, [5, 6, 7, 8, 9], 6.5, 5)).toEqual([7, 8]);
    expect(beatCutTimes(clip, [], 0, 3)).toEqual([]);
  });
});

describe('bezier handle ↔ easing', () => {
  it('named easings expose their control points; hold has none', () => {
    expect(easingToBezier('linear')).toEqual([0, 0, 1, 1]);
    expect(easingToBezier('ease-in')).toEqual([0.42, 0, 1, 1]);
    expect(easingToBezier('ease-in-out')).toEqual([0.42, 0, 0.58, 1]);
    expect(easingToBezier('hold')).toBeNull();
    expect(easingToBezier({ type: 'bezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 1.4 })).toEqual([
      0.1, 0.2, 0.3, 1.4,
    ]);
    expect(easingChoice('ease-out')).toBe('ease-out');
    expect(easingChoice({ type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 })).toBe('bezier');
  });

  it('handles → stored bezier easing: rounded, x clamped to 0..1, y limited; same curve as the eval', () => {
    expect(bezierToEasing([0.33333, -0.7777, 0.66666, 1.5555])).toEqual({
      type: 'bezier',
      x1: 0.333,
      y1: -0.778,
      x2: 0.667,
      y2: 1.556,
    });
    expect(bezierToEasing([-1, 5, 2, -9])).toEqual({ type: 'bezier', x1: 0, y1: 2, x2: 1, y2: -2 });
    // the stored easing evaluates identically to the CSS curve it names
    const e = bezierToEasing([0.42, 0, 0.58, 1]);
    for (const p of [0.1, 0.4, 0.75]) expect(ease(e, p)).toBeCloseTo(ease('ease-in-out', p), 6);
    for (const p of BEZIER_PRESETS) {
      const f = cubicBezier(...p.b);
      expect(f(0.5)).toBeCloseTo(ease(bezierToEasing(p.b), 0.5), 3);
      expect(matchPreset(p.b)?.id).toBe(p.id);
    }
    expect(matchPreset([0.11, 0.22, 0.33, 0.44])).toBeNull();
  });

  it('viewport mapping round-trips and clamps; the nearest handle moves', () => {
    const m = bezierMapper({ size: 160, pad: 16, yMin: -0.5, yMax: 1.5 });
    const { px, py } = m.toPx(0.25, 0.75);
    const back = m.fromPx(px, py);
    expect(back.x).toBeCloseTo(0.25);
    expect(back.y).toBeCloseTo(0.75);
    expect(m.fromPx(-500, 9999)).toEqual({ x: 0, y: -0.5 });
    expect(m.fromPx(9999, -500)).toEqual({ x: 1, y: 1.5 });
    const b = [0.2, 0.1, 0.8, 0.9];
    expect(nearestHandle(b, 0.1, 0.1)).toBe(1);
    expect(nearestHandle(b, 0.9, 1)).toBe(2);
    expect(moveHandle(b, 2, 0.5, 1.3)).toEqual([0.2, 0.1, 0.5, 1.3]);
    expect(moveHandle(b, 1, 0, 0)).toEqual([0, 0, 0.8, 0.9]);
  });
});

describe('keyframe graph maths', () => {
  const box = { width: 300, height: 120, padX: 10, padY: 10 };
  it('maps time/value ↔ px both ways, linear and log', () => {
    const g = graphMapper(box, { duration: 8, vMin: 0, vMax: 100 });
    expect(g.tToX(0)).toBe(10);
    expect(g.tToX(8)).toBe(290);
    expect(g.vToY(100)).toBe(10);
    expect(g.vToY(0)).toBe(110);
    expect(g.xToT(g.tToX(3))).toBeCloseTo(3);
    expect(g.yToV(g.vToY(42))).toBeCloseTo(42);
    expect(g.xToT(-100)).toBe(0);
    expect(g.yToV(-100)).toBe(100);
    const log = graphMapper(box, { duration: 8, vMin: 0.25, vMax: 4, scale: 'log' });
    expect(log.vToY(1)).toBeCloseTo(60); // 1× sits at the middle
    expect(log.yToV(log.vToY(2))).toBeCloseTo(2);
  });

  it('frames keyframes with a margin and a minimum span', () => {
    const d = autoDomain([0.2, 0.8]);
    expect(d.vMin).toBeLessThan(0.2);
    expect(d.vMax).toBeGreaterThan(0.8);
    const flat = autoDomain([5]);
    expect(flat.vMax - flat.vMin).toBeGreaterThanOrEqual(1);
    const clamped = autoDomain([0.2, 0.8], { floor: 0, ceil: 1 });
    expect(clamped.vMin).toBe(0);
    expect(clamped.vMax).toBe(1);
    const log = autoDomain([0.5, 2], { scale: 'log', floor: 0.1, ceil: 10 });
    expect(log.vMin).toBeGreaterThanOrEqual(0.1);
    expect(log.vMax).toBeLessThanOrEqual(10);
  });

  it('samples the real interpolation (hold = step) and clamps dragged times between neighbours', () => {
    const keys = [kf(0, 0, 'hold'), kf(2, 10, 'linear'), kf(4, 0)];
    const s = sampleCurve(keys, 0, 4, 8);
    expect(s.find((p) => p.t === 1)?.v).toBe(0); // held until the next keyframe
    expect(s.find((p) => Math.abs(p.t - 3) < 1e-9)?.v).toBeCloseTo(interpolate(keys, 3, 0));
    expect(s.some((p) => Math.abs(p.t - 2) < 1e-9 && p.v === 10)).toBe(true);
    expect(clampKeyframeTime(keys, 1, 9, 4)).toBeLessThan(4);
    expect(clampKeyframeTime(keys, 1, -9, 4)).toBeGreaterThan(0);
    expect(clampKeyframeTime(keys, 0, -1, 4)).toBe(0);
    expect(clampKeyframeTime(keys, 2, 99, 4)).toBe(4);
    expect(segmentAt(keys, 1)).toBe(0);
    expect(segmentAt(keys, 3)).toBe(1);
    expect(segmentAt(keys, 4)).toBe(-1);
    expect(
      hitKeyframe(
        [
          { x: 10, y: 10 },
          { x: 50, y: 50 },
        ],
        52,
        49,
        8,
      ),
    ).toBe(1);
    expect(hitKeyframe([{ x: 10, y: 10 }], 80, 80, 8)).toBe(-1);
  });
});

describe('number field logic', () => {
  it('modifier steps, clamping and scrubbing', () => {
    expect(modStep(1, {})).toBe(1);
    expect(modStep(1, { shift: true })).toBe(10);
    expect(modStep(1, { alt: true })).toBeCloseTo(0.1);
    expect(clampNum(5, 0, 3)).toBe(3);
    expect(scrubValue(50, 12, 1, {}, 0, 100, 0)).toBe(62);
    expect(scrubValue(50, 12, 1, { shift: true }, 0, 100, 0)).toBe(100); // 170 → clamped
    expect(scrubValue(50, 12, 1, { alt: true }, 0, 100, 1)).toBe(51.2);
    expect(scrubValue(50, -80, 1, {}, 0, 100, 0)).toBe(0);
  });

  it('parses what people type', () => {
    expect(parseNumeric('12.5', 0)).toBe(12.5);
    expect(parseNumeric('12,5', 0)).toBe(12.5);
    expect(parseNumeric(' 80 % ', 0)).toBe(80);
    expect(parseNumeric('−5', 0)).toBe(-5);
    expect(parseNumeric('-5px', 0)).toBe(-5);
    expect(parseNumeric('+10', 40)).toBe(50);
    expect(parseNumeric('', 1)).toBeNull();
    expect(parseNumeric('abc', 1)).toBeNull();
    expect(parseNumeric('-', 1)).toBeNull();
  });

  it('formats without noise or negative zero', () => {
    expect(formatNumeric(0.1 + 0.2, 2)).toBe('0.30');
    expect(formatNumeric(-0.0004, 1)).toBe('0.0');
    expect(formatNumeric(-12.5, 1)).toBe('-12.5');
    expect(formatNumeric(100, 0)).toBe('100');
  });
});

describe('axis ticks', () => {
  it('linear axes use 1-2-5 steps inside the range; log axes use powers of two', async () => {
    const { axisTicks } = await import('../../renderer/components/editor/inspector/lib/graph');
    expect(axisTicks({ vMin: 0, vMax: 100 })).toEqual([0, 20, 40, 60, 80, 100]);
    const t = axisTicks({ vMin: -3, vMax: 7 });
    expect(t[0]).toBeGreaterThanOrEqual(-3);
    expect(t[t.length - 1]).toBeLessThanOrEqual(7);
    expect(axisTicks({ vMin: 0.2, vMax: 6, scale: 'log' })).toEqual([0.25, 0.5, 1, 2, 4]);
  });
});

describe('keyframe upsert (reframe drag)', () => {
  it('updates a keyframe under the playhead, inserts otherwise, inheriting the segment easing', async () => {
    const { upsertKeyframe } =
      await import('../../renderer/components/editor/inspector/lib/retime');
    const base: Keyframe[] = [kf(0, 0.2, 'ease-in'), kf(4, 0.6)];
    expect(upsertKeyframe(base, 4.005, 0.7)).toEqual([kf(0, 0.2, 'ease-in'), kf(4, 0.7)]);
    expect(upsertKeyframe(base, 2, 0.4)).toEqual([
      kf(0, 0.2, 'ease-in'),
      kf(2, 0.4, 'ease-in'),
      kf(4, 0.6),
    ]);
    expect(upsertKeyframe([], 1, 0.5)).toEqual([kf(1, 0.5)]);
    expect(upsertKeyframe(base, -0, 0.3)[0]!.v).toBe(0.3);
  });
});

describe('subtitle word edits', () => {
  const w = (t: string, s: number, e: number, color: string | null = null) => ({
    w: t,
    s,
    e,
    color,
  });
  it('replaces, splits on spaces (proportional timing) and deletes on empty', async () => {
    const m = await import('../../renderer/components/editor/inspector/lib/subtitle-edit');
    const words = [w('hello', 0, 0.5, '#FFE94D'), w('big', 0.5, 1), w('world', 1, 2)];
    expect(m.setWordText(words, 1, 'bold').map((x) => x.w)).toEqual(['hello', 'bold', 'world']);
    const split = m.setWordText(words, 2, 'new world');
    expect(split.map((x) => x.w)).toEqual(['hello', 'big', 'new', 'world']);
    expect(split[2]!.s).toBe(1);
    expect(split[3]!.e).toBe(2);
    expect(split[2]!.e).toBeCloseTo(1 + (3 / 8) * 1, 2);
    expect(split[2]!.e).toBe(split[3]!.s);
    const del = m.setWordText(words, 1, '  ');
    expect(del.map((x) => x.w)).toEqual(['hello', 'world']);
    expect(del[0]!.e).toBe(1); // the gap goes to the previous word
    expect(m.setWordText(words, 0, '').map((x) => x.w)).toEqual(['big', 'world']);
    expect(m.setWordText(words, 0, '')[0]!.s).toBe(0);
    expect(words[1]!.w).toBe('big'); // input untouched
  });

  it('colours, boundary moves and active word', async () => {
    const m = await import('../../renderer/components/editor/inspector/lib/subtitle-edit');
    const words = [w('a', 0, 0.5), w('b', 0.5, 1), w('c', 1, 2)];
    expect(m.setWordColor(words, 1, '#FF4D4D')[1]!.color).toBe('#FF4D4D');
    expect(m.setWordColor(m.setWordColor(words, 1, '#FF4D4D'), 1, null)[1]!.color).toBeNull();
    const moved = m.setWordStart(words, 1, 0.7, 2);
    expect(moved[1]!.s).toBe(0.7);
    expect(moved[0]!.e).toBe(0.7); // previous word follows the boundary
    expect(m.setWordStart(words, 1, -5, 2)[1]!.s).toBeCloseTo(0.02); // clamped after the previous start
    expect(m.setWordStart(words, 1, 9, 2)[1]!.s).toBeCloseTo(0.98); // clamped before its own end
    expect(m.setLastWordEnd(words, 9, 2)[2]!.e).toBe(2);
    expect(m.setLastWordEnd(words, 0, 2)[2]!.e).toBeCloseTo(1.02);
    expect(m.activeWordIndex(words, 0.6)).toBe(1);
    expect(m.activeWordIndex(words, -1)).toBe(-1);
    expect(m.activeWordIndex(words, 9)).toBe(-1);
  });
});
