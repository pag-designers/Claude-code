import { describe, expect, it } from 'vitest';
import type { FaceSample, LayoutHint } from '../../electron/main/pipeline/contracts';
import {
  analyzeShots,
  buildTracks,
  centerPlan,
  chooseZoom,
  classifyLayout,
  createReframeService,
  detectTile,
  iou,
  mergeLetterbox,
  parseCropdetect,
  pickPair,
  planMulti,
  regionMotion,
  reframeTuning,
  sampleTimes,
  screenFacePanels,
  screenScore,
  screenStats,
  splitPanels,
  webcamRectFromFace,
  type GrayFrame,
} from '../../electron/main/services/reframe';
import type { Rect01 } from '../../electron/main/services/reframe';

const W = 854;
const H = 480;
const svc = createReframeService();

type Box = { cx: number; cy?: number; size?: number; score?: number };
/** Face samples at 4 fps; `faces(t)` returns boxes in normalised centre coordinates (size = height). */
function samples(t0: number, t1: number, faces: (t: number) => Box[], fps = 4): FaceSample[] {
  const out: FaceSample[] = [];
  for (let t = t0; t < t1 - 1e-9; t += 1 / fps) {
    out.push({
      t: Math.round(t * 1000) / 1000,
      boxes: faces(t).map((b) => {
        const h = b.size ?? 0.28;
        const w = h * (H / W);
        const cy = b.cy ?? 0.35;
        return { x: b.cx - w / 2, y: cy - h / 2, w, h, score: b.score ?? 0.6 };
      }),
    });
  }
  return out;
}

const plan = (faces: FaceSample[], over: Partial<Parameters<typeof svc.plan>[0]> = {}) =>
  svc.plan({
    startSec: 0,
    endSec: 20,
    srcW: W,
    srcH: H,
    aspect: '9:16',
    faces,
    sceneCuts: [],
    ...over,
  });

const two = (t: number): Box[] => [
  { cx: 0.3, cy: 0.27, size: 0.27 + 0.01 * Math.sin(t * 3) },
  { cx: 0.7, cy: 0.27, size: 0.27 + 0.01 * Math.cos(t * 3) },
];

describe('panel geometry', () => {
  it('splits tile the frame exactly (stacked, side by side for 16:9)', () => {
    for (const a of ['9:16', '4:5', '1:1'] as const) {
      const { a: pa, b: pb } = splitPanels(a);
      expect(pa.w).toBe(pb.w);
      expect(pa.y + pa.h).toBe(pb.y);
      expect(pa.h).toBe(pb.h);
    }
    expect(splitPanels('9:16').a).toEqual({ x: 0, y: 0, w: 1080, h: 960 });
    expect(splitPanels('9:16').b).toEqual({ x: 0, y: 960, w: 1080, h: 960 });
    const land = splitPanels('16:9');
    expect(land.a).toEqual({ x: 0, y: 0, w: 960, h: 1080 });
    expect(land.b).toEqual({ x: 960, y: 0, w: 960, h: 1080 });
  });

  it('screen + face panels: 1080x1280 over 1080x640 for 9:16', () => {
    const p = screenFacePanels('9:16');
    expect(p.screen).toEqual({ x: 0, y: 0, w: 1080, h: 1280 });
    expect(p.face).toEqual({ x: 0, y: 1280, w: 1080, h: 640 });
    for (const a of ['4:5', '1:1', '16:9'] as const) {
      const q = screenFacePanels(a);
      const area = q.screen.w * q.screen.h + q.face.w * q.face.h;
      expect(area).toBe(a === '16:9' ? 1920 * 1080 : 1080 * (a === '4:5' ? 1350 : 1080));
    }
  });
});

describe('multi-face: split screen', () => {
  it('two persistent separated faces become two stacked panels, leftmost on top', () => {
    const p = plan(samples(0, 20, two));
    expect(p.mode).toBe('multi-face');
    expect(p.layout).toBe('split');
    expect(p.panels).toHaveLength(2);
    const [a, b] = p.panels!;
    expect(a!.role).toBe('face-a');
    expect(b!.role).toBe('face-b');
    expect(a!.out).toEqual({ x: 0, y: 0, w: 1080, h: 960 });
    expect(b!.out).toEqual({ x: 0, y: 960, w: 1080, h: 960 });
    // window = panel aspect (1080:960), constant size per panel and identical for both
    const k0 = a!.keyframes[0]!;
    expect(k0.w / k0.h).toBeCloseTo(1080 / 960, 1);
    expect(b!.keyframes[0]!.w).toBe(k0.w);
    for (const k of [...a!.keyframes, ...b!.keyframes]) {
      expect([k.w, k.h]).toEqual([k0.w, k0.h]);
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.y).toBeGreaterThanOrEqual(0);
      expect(k.x + k.w).toBeLessThanOrEqual(W + 1e-6);
      expect(k.y + k.h).toBeLessThanOrEqual(H + 1e-6);
    }
    expect(p.keyframes).toEqual(a!.keyframes); // primary track = panel A
  });

  it('each window contains its own face and never the other face (whole clip)', () => {
    const p = plan(samples(0, 20, two));
    const [a, b] = p.panels!;
    for (const k of a!.keyframes) {
      expect(0.3 * W).toBeGreaterThan(k.x);
      expect(0.3 * W).toBeLessThan(k.x + k.w);
      expect(0.7 * W).toBeGreaterThan(k.x + k.w - 1); // the right face is outside A's window
    }
    for (const k of b!.keyframes) {
      expect(0.7 * W).toBeGreaterThan(k.x);
      expect(0.7 * W).toBeLessThan(k.x + k.w);
      expect(0.3 * W).toBeLessThan(k.x + 1); // the left face is outside B's window
    }
  });

  it('puts the face centre at ~42% of the panel height and horizontally centred when there is room', () => {
    const p = plan(
      samples(0, 20, () => [
        { cx: 0.3, cy: 0.5, size: 0.2 },
        { cx: 0.7, cy: 0.5, size: 0.2 },
      ]),
    );
    const k = p.panels![0]!.keyframes[5]!;
    expect((0.5 * H - k.y) / k.h).toBeCloseTo(reframeTuning.SPLIT_FACE_Y, 1);
    expect(0.3 * W - (k.x + k.w / 2)).toBeCloseTo(0, 0);
  });

  it('assignment is stable: no swapping while the faces stay where they are, even if one leans over', () => {
    // the right person leans left to 0.45 (still right of the left one) for a few seconds
    const p = plan(
      samples(0, 20, (t) => [
        { cx: 0.28, cy: 0.3, size: 0.27 },
        {
          cx:
            0.7 - 0.16 * Math.max(0, Math.sin(((t - 6) / 6) * Math.PI)) * (t > 6 && t < 12 ? 1 : 0),
          cy: 0.3,
          size: 0.27,
        },
      ]),
    );
    expect(p.layout).toBe('split');
    const mid = p.panels![0]!.keyframes.map((k) => k.x + k.w / 2);
    const midB = p.panels![1]!.keyframes.map((k) => k.x + k.w / 2);
    for (let i = 0; i < mid.length; i++) expect(mid[i]!).toBeLessThan(midB[i]! + 1);
  });

  it('swaps only at a scene cut (people change places between shots)', () => {
    const f = samples(0, 20, (t) =>
      t < 10
        ? [
            { cx: 0.3, cy: 0.3 },
            { cx: 0.7, cy: 0.3 },
          ]
        : [
            { cx: 0.3, cy: 0.3, size: 0.27 },
            { cx: 0.7, cy: 0.3, size: 0.27 },
          ],
    );
    const p = plan(f, { sceneCuts: [10] });
    expect(p.layout).toBe('split');
    expect(p.cuts).toEqual([10]);
    // A is on the left in both shots
    for (const k of p.panels![0]!.keyframes) expect(k.x + k.w / 2).toBeLessThan(0.5 * W + 1);
  });

  it('a person leaving: after ~1 s the panel eases to its home position, no wandering', () => {
    // right person present for the first 12 s of 16 -> both present 12/16 = 75% of the clip: still a split
    const f = samples(0, 16, (t) =>
      t < 12
        ? [
            { cx: 0.3, cy: 0.3 },
            { cx: 0.72, cy: 0.3 },
          ]
        : [{ cx: 0.3, cy: 0.3 }],
    );
    const p = plan(f, { endSec: 16, mode: 'multi-face' });
    expect(p.layout).toBe('split');
    const b = p.panels![1]!.keyframes;
    const x0 = b[5]!.x;
    const last = b[b.length - 1]!.x;
    expect(Math.abs(last - x0)).toBeLessThan(0.06 * W); // parked near where the person was
    // A is untouched by B leaving
    const a = p.panels![0]!.keyframes;
    expect(Math.abs(a[a.length - 1]!.x - a[5]!.x)).toBeLessThan(2);
  });

  it('auto falls back to single-face when the second person is only there part of the time', () => {
    const f = samples(0, 20, (t) =>
      t < 8 ? [{ cx: 0.3 }, { cx: 0.7, size: 0.2 }] : [{ cx: 0.7, size: 0.2 }],
    );
    expect(plan(f).layout).toBe('single');
    expect(plan(f, { mode: 'multi-face' }).layout).toBe('split'); // forced
  });

  it('forced multi-face with one person falls back to single-face; a lone face never splits in auto', () => {
    const f = samples(0, 10, () => [{ cx: 0.5 }]);
    expect(plan(f, { endSec: 10, mode: 'multi-face' }).mode).toBe('single-face');
    expect(plan(f, { endSec: 10 }).layout).toBe('single');
  });

  it('two detections of one face (too close) are not two people', () => {
    const f = samples(0, 10, () => [{ cx: 0.5 }, { cx: 0.54, size: 0.25 }]);
    expect(plan(f, { endSec: 10 }).layout).toBe('single');
  });

  it('tolerates flaky detection (tile faces score 0.3-0.5 and drop out)', () => {
    let k = 0;
    const f = samples(0, 20, () => {
      k++;
      const boxes: Box[] = [];
      if (k % 4 !== 0) boxes.push({ cx: 0.3, cy: 0.27, size: 0.27, score: 0.34 });
      if (k % 3 !== 0) boxes.push({ cx: 0.7, cy: 0.27, size: 0.29, score: 0.4 });
      return boxes;
    });
    const p = plan(f);
    expect(p.layout).toBe('split');
  });

  it('keeps each panel inside its tile when the layout analysis found video-call tiles', () => {
    const tile: Rect01 = { x: 0.08, y: 0.03, w: 0.84, h: 0.41 }; // top row: 201 px tall
    const hint: LayoutHint = {
      kind: 'multi-face',
      faceRegion: null,
      screenRegion: null,
      confidence: 0.9,
    };
    const p = plan(samples(0, 20, two), { layoutHint: { ...hint, tiles: [tile] } as LayoutHint });
    expect(p.layout).toBe('split');
    for (const pan of p.panels!) {
      for (const k of pan.keyframes) {
        expect(k.y).toBeGreaterThanOrEqual(tile.y * H - 1);
        expect(k.y + k.h).toBeLessThanOrEqual((tile.y + tile.h) * H + 1);
      }
    }
  });

  it('works for 4:5, 1:1 and side-by-side 16:9 outputs', () => {
    const f = samples(0, 10, two);
    const r45 = plan(f, { endSec: 10, aspect: '4:5' });
    expect(r45.panels![0]!.out).toEqual({ x: 0, y: 0, w: 1080, h: 675 });
    const r11 = plan(f, { endSec: 10, aspect: '1:1' });
    expect(r11.panels![1]!.out).toEqual({ x: 0, y: 540, w: 1080, h: 540 });
    const r169 = plan(f, { endSec: 10, aspect: '16:9' });
    expect(r169.panels![0]!.out).toEqual({ x: 0, y: 0, w: 960, h: 1080 });
    expect(r169.panels![1]!.out).toEqual({ x: 960, y: 0, w: 960, h: 1080 });
    for (const r of [r45, r11, r169]) {
      const k = r.panels![0]!.keyframes[0]!;
      const o = r.panels![0]!.out;
      expect(k.w / k.h).toBeCloseTo(o.w / o.h, 1);
    }
  });

  it('is deterministic and analyzeShots reports the pair coverage', () => {
    const f = samples(0, 20, two);
    expect(plan(f)).toEqual(plan(structuredClone(f)));
    const a = analyzeShots(
      { startSec: 0, endSec: 20, srcW: W, srcH: H, aspect: '9:16', faces: f, sceneCuts: [] },
      20,
    );
    expect(a.pairFraction).toBeGreaterThan(0.95);
    expect(
      planMulti(
        { startSec: 0, endSec: 20, srcW: W, srcH: H, aspect: '9:16', faces: [], sceneCuts: [] },
        { region: { x: 0, y: 0, w: W, h: H }, tiles: [], minPairFraction: 0.5 },
      ),
    ).toBeNull();
  });
});

describe('tracks', () => {
  it('builds persistent tracks and orders the pair leftmost first', () => {
    const s = samples(0, 10, () => [{ cx: 0.7 }, { cx: 0.25 }]).map((x) => ({ t: x.t, sample: x }));
    const pair = pickPair(buildTracks(s, W, H))!;
    expect(pair.horizontal).toBe(true);
    expect(pair.a.cx).toBeLessThan(pair.b.cx);
  });

  it('stacked tiles (same x) are ordered top first', () => {
    const s = samples(0, 10, () => [
      { cx: 0.5, cy: 0.75, size: 0.2 },
      { cx: 0.5, cy: 0.25, size: 0.2 },
    ]).map((x) => ({ t: x.t, sample: x }));
    const pair = pickPair(buildTracks(s, W, H))!;
    expect(pair.horizontal).toBe(false);
    expect(pair.a.cy).toBeLessThan(pair.b.cy);
  });
});

describe('single-face improvements (CP2)', () => {
  const src = { srcW: 1920, srcH: 1080 };
  it('zooms in so the face reaches the 40% line when the crop has no vertical room', () => {
    // face centre at 50% of the height: without zoom it stays at 50%
    const f = samples(0, 10, () => [{ cx: 0.5, cy: 0.5, size: 0.2 }]);
    const p = svc.plan({
      startSec: 0,
      endSec: 10,
      ...src,
      aspect: '9:16',
      faces: f,
      sceneCuts: [],
    });
    const k = p.keyframes[20]!;
    expect(k.h).toBeLessThan(1080);
    const zoom = 1080 / k.h;
    expect(zoom).toBeGreaterThan(1.1);
    expect(zoom).toBeLessThanOrEqual(reframeTuning.ZOOM_MAX + 1e-6);
    const frac = (0.5 * 1080 - k.y) / k.h;
    expect(frac).toBeGreaterThan(0.39);
    expect(frac).toBeLessThan(0.45);
    expect(Math.abs(k.w / k.h - 9 / 16)).toBeLessThan(0.02);
  });

  it('does not zoom when the face is already high, or when it would swallow the frame', () => {
    const high = svc.plan({
      startSec: 0,
      endSec: 10,
      ...src,
      aspect: '9:16',
      faces: samples(0, 10, () => [{ cx: 0.5, cy: 0.33, size: 0.2 }]),
      sceneCuts: [],
    });
    expect(high.keyframes[0]!.h).toBe(1080);
    const big = svc.plan({
      startSec: 0,
      endSec: 10,
      ...src,
      aspect: '9:16',
      faces: samples(0, 10, () => [{ cx: 0.5, cy: 0.56, size: 0.5 }]),
      sceneCuts: [],
    });
    expect(1080 / big.keyframes[0]!.h).toBeLessThan(1.05);
  });

  it('chooseZoom is bounded and ignores tiny samples', () => {
    const g = { cropW: 608, cropH: 1080, outW: 1080, outH: 1920 };
    const obs = Array.from({ length: 20 }, (_, i) => ({ t: i, cx: 960, cy: 700, w: 100, h: 140 }));
    const z = chooseZoom(obs, g, { x: 0, y: 0, w: 1920, h: 1080 }, '9:16');
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThanOrEqual(reframeTuning.ZOOM_MAX);
    expect(chooseZoom(obs.slice(0, 2), g, { x: 0, y: 0, w: 1920, h: 1080 }, '9:16')).toBe(1);
  });

  it('a letterboxed source: the crop never leaves the picture area', () => {
    const hint = {
      kind: 'single-face',
      faceRegion: null,
      screenRegion: null,
      confidence: 1,
      contentRect: { x: 0.084, y: 0.02, w: 0.83, h: 0.94 },
    } as LayoutHint;
    const p = plan(
      samples(0, 10, () => [{ cx: 0.5, cy: 0.4, size: 0.28 }]),
      {
        endSec: 10,
        layoutHint: hint,
      },
    );
    const top = 0.02 * H;
    const bottom = 0.96 * H;
    for (const k of p.keyframes) {
      expect(k.y).toBeGreaterThanOrEqual(top - 2);
      expect(k.y + k.h).toBeLessThanOrEqual(bottom + 2);
      expect(k.x).toBeGreaterThanOrEqual(0.084 * W - 2);
    }
    // the crop window is derived from the picture, not the padded frame
    expect(p.keyframes[0]!.h).toBeLessThanOrEqual(Math.round(0.94 * H) + 1);
  });

  it("'center' mode is a static centre crop of the picture area", () => {
    const p = plan(
      samples(0, 10, () => [{ cx: 0.2 }]),
      { endSec: 10, mode: 'center' },
    );
    expect(p.mode).toBe('center');
    expect(p.layout).toBe('single');
    expect(p.keyframes).toHaveLength(2);
    expect(p.keyframes[0]!.x).toBeCloseTo((W - 270) / 2, 0);
    expect(
      centerPlan({
        startSec: 0,
        endSec: 4,
        srcW: W,
        srcH: H,
        aspect: '1:1',
        faces: [],
        sceneCuts: [],
      }).keyframes[0],
    ).toMatchObject({ w: 480, h: 480 });
  });

  it("forced 'single-face' ignores a split-worthy layout", () => {
    const p = plan(samples(0, 20, two), { mode: 'single-face' });
    expect(p.mode).toBe('single-face');
    expect(p.layout).toBe('single');
  });
});

describe('screen + face', () => {
  const cam: Rect01 = { x: 0.8, y: 0.74, w: 0.17, h: 0.23 };
  const hint = (over: Partial<LayoutHint> = {}): LayoutHint => ({
    kind: 'screen-face',
    faceRegion: cam,
    screenRegion: { x: 0, y: 0, w: 1, h: 1 },
    confidence: 0.9,
    ...over,
  });
  // webcam face: small, bottom-right
  const webcam = (t: number): Box[] => [
    { cx: 0.885 + 0.002 * Math.sin(t), cy: 0.85, size: 0.12, score: 0.8 },
  ];

  it('builds a screen panel on top (static region) and a webcam strip below', () => {
    const p = plan(samples(0, 20, webcam), { layoutHint: hint() });
    expect(p.mode).toBe('screen-face');
    expect(p.layout).toBe('screen-face');
    const [screen, face] = p.panels!;
    expect(screen!.role).toBe('screen');
    expect(face!.role).toBe('face');
    expect(screen!.out).toEqual({ x: 0, y: 0, w: 1080, h: 1280 });
    expect(face!.out).toEqual({ x: 0, y: 1280, w: 1080, h: 640 });
    // screen region = the whole picture, static, NOT forced to the panel aspect
    expect(screen!.keyframes[0]).toMatchObject({ x: 0, y: 0, w: W, h: H });
    expect(new Set(screen!.keyframes.map((k) => `${k.x},${k.y},${k.w},${k.h}`)).size).toBe(1);
    // face windows: panel aspect, inside the webcam rectangle, face centred horizontally
    for (const k of face!.keyframes) {
      expect(k.w / k.h).toBeCloseTo(1080 / 640, 1);
      expect(k.x).toBeGreaterThanOrEqual(cam.x * W - 2);
      expect(k.x + k.w).toBeLessThanOrEqual((cam.x + cam.w) * W + 2);
      expect(k.y).toBeGreaterThanOrEqual(cam.y * H - 2);
      expect(k.y + k.h).toBeLessThanOrEqual((cam.y + cam.h) * H + 2);
    }
    const k = face!.keyframes[10]!;
    expect(0.885 * W).toBeGreaterThan(k.x);
    expect(0.885 * W).toBeLessThan(k.x + k.w);
  });

  it('auto only switches on a confident hint; forced mode derives the webcam from the faces', () => {
    const f = samples(0, 20, webcam);
    expect(plan(f, { layoutHint: hint({ confidence: 0.3 }) }).layout).toBe('single');
    expect(plan(f, { layoutHint: hint({ kind: 'single-face' }) }).layout).toBe('single');
    expect(plan(f).layout).toBe('single'); // no hint at all
    const forced = plan(f, { mode: 'screen-face' });
    expect(forced.layout).toBe('screen-face');
    expect(forced.panels![1]!.keyframes[0]!.x).toBeGreaterThan(0.5 * W);
    // no faces and no hint region: nothing to put in the strip -> falls back
    expect(plan([], { mode: 'screen-face' }).layout).toBe('single');
  });

  it('keeps the strip inside the webcam rectangle while the face moves a little', () => {
    const f = samples(0, 20, (t) => [
      { cx: 0.86 + 0.02 * Math.sin(t / 3), cy: 0.85, size: 0.12, score: 0.8 },
    ]);
    const p = plan(f, { layoutHint: hint() });
    const w = p.panels![1]!.keyframes[0]!.w;
    for (const k of p.panels![1]!.keyframes)
      expect(k.x + w).toBeLessThanOrEqual((cam.x + cam.w) * W + 2);
  });

  it('works for the other output aspects', () => {
    const f = samples(0, 10, webcam);
    for (const a of ['4:5', '1:1', '16:9'] as const) {
      const p = plan(f, { endSec: 10, aspect: a, layoutHint: hint() });
      expect(p.layout).toBe('screen-face');
      const [s, fc] = p.panels!;
      expect(s!.out).toEqual(screenFacePanels(a).screen);
      expect(fc!.out).toEqual(screenFacePanels(a).face);
    }
  });

  it('webcamRectFromFace stays inside the frame', () => {
    const r = webcamRectFromFace({ cx: W - 20, cy: H - 20, w: 60, h: 80 }, W, H);
    expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6);
  });
});

/* ------------------------------------------- layout analysis (pure) ---------------------------------------- */

function frame(w: number, h: number, fn: (x: number, y: number) => number): GrayFrame {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y);
  return { w, h, data };
}

/** Deterministic noise 0..1. */
const noise = (x: number, y: number, seed = 0): number => {
  let a = (x * 73856093) ^ (y * 19349663) ^ (seed * 83492791);
  a = Math.imul(a ^ (a >>> 13), 0x5bd1e995);
  return ((a ^ (a >>> 15)) >>> 0) / 4294967296;
};

/** A slide: flat background, crisp text-like bars; a noisy "camera" rectangle bottom-right that moves. */
function slideFrame(i: number): GrayFrame {
  const w = 320;
  const h = 180;
  return frame(w, h, (x, y) => {
    if (x >= 262 && x < 308 && y >= 126 && y < 170)
      return 90 + 100 * noise(x, y, i) + 20 * Math.sin((x + i * 3) / 4);
    if (
      y > 30 &&
      y < 120 &&
      x > 20 &&
      x < 220 &&
      Math.floor(y / 14) % 2 === 0 &&
      noise(Math.floor(x / 5), y, 7) > 0.35
    )
      return 20;
    return 245;
  });
}

/** A talking-head frame: smooth gradients and noise everywhere (camera content). */
function cameraFrame(i: number): GrayFrame {
  return frame(
    320,
    180,
    (x, y) => 120 + 50 * Math.sin(x / 40 + i) * Math.cos(y / 30) + 25 * noise(x, y, i),
  );
}

const faceSamples = (cx: number, cy: number, size: number, n = 24): FaceSample[] =>
  samples(0, n / 4, (t) => [{ cx: cx + 0.002 * Math.sin(t), cy, size, score: 0.8 }]);

describe('layout analysis (pure)', () => {
  const base = { startSec: 0, endSec: 6, srcW: 1280, srcH: 720 };

  it('screen share with a small, stationary, live webcam in the corner -> screen-face', () => {
    const frames = [0, 1, 2, 3, 4, 5].map(slideFrame);
    const h = classifyLayout({ ...base, frames, faces: faceSamples(0.88, 0.85, 0.14) });
    expect(h.kind).toBe('screen-face');
    expect(h.confidence).toBeGreaterThan(0.55);
    expect(h.faceRegion!.x + h.faceRegion!.w).toBeLessThanOrEqual(1.0001);
    expect(h.faceRegion!.x).toBeGreaterThan(0.6);
    expect(h.screenRegion).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('a talking head (big face, camera content) is NOT a screen share', () => {
    const frames = [0, 1, 2, 3, 4, 5].map(cameraFrame);
    expect(classifyLayout({ ...base, frames, faces: faceSamples(0.5, 0.45, 0.4) }).kind).toBe(
      'single-face',
    );
  });

  it('a small face in a corner of CAMERA content is not a screen share either', () => {
    const frames = [0, 1, 2, 3, 4, 5].map(cameraFrame);
    expect(classifyLayout({ ...base, frames, faces: faceSamples(0.88, 0.85, 0.14) }).kind).toBe(
      'single-face',
    );
  });

  it('a static false detection on a slide (does not move between frames) is ignored', () => {
    const frames = [0, 0, 0, 0, 0, 0].map(slideFrame).map((f) => ({ ...f, data: f.data.slice() }));
    // identical frames: the "face" region never changes
    const h = classifyLayout({ ...base, frames, faces: faceSamples(0.88, 0.85, 0.14) });
    expect(h.kind).toBe('none');
  });

  it('a face in the middle of a slide-like frame is not a webcam corner', () => {
    const frames = [0, 1, 2, 3, 4, 5].map(slideFrame);
    expect(classifyLayout({ ...base, frames, faces: faceSamples(0.5, 0.5, 0.14) }).kind).not.toBe(
      'screen-face',
    );
  });

  it('two separated live faces -> multi-face', () => {
    const frames = [0, 1, 2, 3, 4, 5].map(cameraFrame);
    const faces = samples(0, 6, () => [
      { cx: 0.3, cy: 0.3, size: 0.25, score: 0.5 },
      { cx: 0.7, cy: 0.3, size: 0.25, score: 0.5 },
    ]);
    const h = classifyLayout({ ...base, frames, faces });
    expect(h.kind).toBe('multi-face');
  });

  it('no faces -> none, and carries the letterbox rectangle through', () => {
    const h = classifyLayout({
      ...base,
      frames: [cameraFrame(0)],
      faces: [],
      contentRect: { x: 0.08, y: 0, w: 0.84, h: 1 },
    });
    expect(h.kind).toBe('none');
    expect((h as { contentRect?: Rect01 | null }).contentRect).toEqual({
      x: 0.08,
      y: 0,
      w: 0.84,
      h: 1,
    });
  });

  it('screenScore: slides score high, camera content low', () => {
    const slide = screenScore(screenStats(slideFrame(0), { x: 0.8, y: 0.7, w: 0.2, h: 0.3 }));
    const cam = screenScore(screenStats(cameraFrame(0), null));
    expect(slide).toBeGreaterThan(0.6);
    expect(cam).toBeLessThan(0.3);
  });

  it('regionMotion tells a live region from a static one', () => {
    const frames = [0, 1, 2, 3].map(slideFrame);
    expect(regionMotion(frames, { x: 0.82, y: 0.7, w: 0.15, h: 0.25 })!).toBeGreaterThan(10);
    expect(regionMotion(frames, { x: 0.05, y: 0.8, w: 0.2, h: 0.1 })!).toBeLessThan(1);
    expect(regionMotion([frames[0]!], { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it('sampleTimes spreads samples inside the span', () => {
    const t = sampleTimes(10, 40);
    expect(t).toHaveLength(6);
    expect(t[0]!).toBeGreaterThan(10);
    expect(t[5]!).toBeLessThan(40);
    expect(sampleTimes(0, 1.2).length).toBeGreaterThanOrEqual(2);
  });
});

describe('letterbox detection', () => {
  it('parses the last cropdetect line', () => {
    const log = 'x1:71 x2:782 crop=710:448:72:14\n...crop=710:446:72:16\n';
    expect(parseCropdetect(log)).toEqual({ w: 710, h: 446, x: 72, y: 16 });
    expect(parseCropdetect('nothing here')).toBeNull();
  });

  it('merges conservatively: a bar must be present in every frame and >= 3%', () => {
    const c = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
    const r = mergeLetterbox(
      [c(72, 14, 710, 448), c(70, 12, 714, 452), c(72, 14, 710, 448)],
      854,
      480,
    )!;
    expect(r.x).toBeCloseTo(70 / 854, 3);
    expect(r.y).toBe(0); // 12 px = 2.5% < 3%: ignored
    expect(r.w).toBeCloseTo((854 - 70 - 70) / 854, 1);
    // one frame whose picture reaches the edge -> no bar on that side
    expect(
      mergeLetterbox([c(72, 14, 710, 448), c(0, 14, 854, 448), c(72, 14, 710, 448)], 854, 480)!.x,
    ).toBe(0);
    // too few frames / no bars / implausible -> null
    expect(mergeLetterbox([c(72, 14, 710, 448)], 854, 480)).toBeNull();
    expect(
      mergeLetterbox([c(0, 0, 854, 480), c(0, 0, 854, 480), c(0, 0, 854, 480)], 854, 480),
    ).toBeNull();
    expect(
      mergeLetterbox([c(0, 200, 854, 40), c(0, 200, 854, 40), c(0, 200, 854, 40)], 854, 480),
    ).toBeNull();
    // 16:9 picture inside a 4:3 frame (top/bottom bars)
    const lb = mergeLetterbox(
      [c(0, 60, 640, 360), c(0, 60, 640, 360), c(0, 60, 640, 360)],
      640,
      480,
    )!;
    expect(lb).toEqual({ x: 0, y: 0.125, w: 1, h: 0.75 });
  });
});

describe('tile detection', () => {
  // black frame with two touching tiles on top and one below: tiles are noisy "camera" images
  const f = frame(320, 180, (x, y) => {
    const inTop = y >= 6 && y < 80 && x >= 28 && x < 292;
    const inBottom = y >= 80 && y < 160 && x >= 90 && x < 230;
    if (inTop) return (x < 160 ? 170 : 200) + 30 * noise(x, y, 1);
    if (inBottom) return 60 + 40 * noise(x, y, 2);
    return 2;
  });

  it('finds the black margins and the hard edge to the tile below', () => {
    const t = detectTile(f, { x: 70 / 320, y: 20 / 180, w: 40 / 320, h: 44 / 180 })!;
    expect(t.x * 320).toBeGreaterThan(20);
    expect(t.x * 320).toBeLessThan(40);
    expect(t.y * 180).toBeLessThan(10);
    expect((t.y + t.h) * 180).toBeGreaterThan(74);
    expect((t.y + t.h) * 180).toBeLessThan(86); // stops at the tile below, not at its bottom (160)
  });

  it('iou', () => {
    expect(iou({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 0.4, h: 0.4 }, { x: 0.5, y: 0.5, w: 0.4, h: 0.4 })).toBe(0);
  });
});
