import { describe, expect, it } from 'vitest';
import type { FaceSample } from '../../electron/main/pipeline/contracts';
import {
  cropGeometry,
  createReframeService,
  facesFromSidecar,
  reframeTuning,
  smoothDamp,
} from '../../electron/main/services/reframe';

const W = 854;
const H = 480;
const svc = createReframeService();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Box = { cx: number; cy?: number; size?: number; score?: number };
/** Samples at 4 fps over [t0,t1): `faces(t)` returns boxes in normalised centre coordinates. */
function samples(t0: number, t1: number, faces: (t: number) => Box[], fps = 4): FaceSample[] {
  const out: FaceSample[] = [];
  for (let t = t0; t < t1 - 1e-9; t += 1 / fps) {
    out.push({
      t: Math.round(t * 1000) / 1000,
      boxes: faces(t).map((b) => {
        const h = b.size ?? 0.28;
        const w = h * (H / W);
        const cy = b.cy ?? 0.35;
        return { x: b.cx - w / 2, y: cy - h / 2, w, h, score: b.score ?? 0.9 };
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

const maxStep = (xs: number[], ts: number[]): number => {
  let m = 0;
  for (let i = 1; i < xs.length; i++) {
    const dt = (ts[i] ?? 0) - (ts[i - 1] ?? 0);
    if (dt > 0.01) m = Math.max(m, Math.abs((xs[i] ?? 0) - (xs[i - 1] ?? 0)) / dt);
  }
  return m;
};

describe('cropGeometry', () => {
  it('gives the largest window of the target aspect', () => {
    expect(cropGeometry('9:16', 854, 480)).toEqual({
      cropW: 270,
      cropH: 480,
      outW: 1080,
      outH: 1920,
    });
    expect(cropGeometry('9:16', 1920, 1080)).toEqual({
      cropW: 608,
      cropH: 1080,
      outW: 1080,
      outH: 1920,
    });
    expect(cropGeometry('1:1', 1920, 1080)).toEqual({
      cropW: 1080,
      cropH: 1080,
      outW: 1080,
      outH: 1080,
    });
    expect(cropGeometry('4:5', 1920, 1080)).toEqual({
      cropW: 864,
      cropH: 1080,
      outW: 1080,
      outH: 1350,
    });
    expect(cropGeometry('16:9', 1920, 1080)).toEqual({
      cropW: 1920,
      cropH: 1080,
      outW: 1920,
      outH: 1080,
    });
    // narrower source than the target: full width, reduced height
    const g = cropGeometry('16:9', 1440, 1080);
    expect(g.cropW).toBe(1440);
    expect(g.cropH).toBe(810);
  });
});

describe('smoothDamp', () => {
  it('converges without overshoot and respects the speed limit', () => {
    let v = 0;
    let x = 0;
    let maxV = 0;
    for (let i = 0; i < 200; i++) {
      const r = smoothDamp(x, 100, v, 0.5, 60, 0.1);
      expect(r.value).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.value).toBeGreaterThanOrEqual(x - 1e-9);
      maxV = Math.max(maxV, (r.value - x) / 0.1);
      x = r.value;
      v = r.vel;
    }
    expect(x).toBeCloseTo(100, 1);
    expect(maxV).toBeLessThanOrEqual(60 * 1.35); // limit is on the target distance; allow the spring tail
  });
});

describe('reframe plan: single face', () => {
  it('a still speaker gives a still camera (dead-zone swallows detection jitter)', () => {
    const r = rng(1);
    const p = plan(
      samples(0, 20, () => [{ cx: 0.62 + (r() - 0.5) * 0.012, cy: 0.35 + (r() - 0.5) * 0.01 }]),
    );
    expect(p.mode).toBe('single-face');
    expect(p.faceCoverage).toBe(1);
    const xs = p.keyframes.map((k) => k.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
    // crop centred on the face: 0.62 * 854 - 135
    expect(xs[0]).toBeCloseTo(0.62 * W - 135, -1);
    expect(p.outW).toBe(1080);
    expect(p.outH).toBe(1920);
    expect(p.keyframes[0]).toMatchObject({ w: 270, h: 480, y: 0 });
  });

  it('keyframes run at ~10 Hz and span the whole clip', () => {
    const p = plan(samples(0, 20, () => [{ cx: 0.5 }]));
    expect(p.keyframes[0]?.t).toBe(0);
    expect(p.keyframes[p.keyframes.length - 1]?.t).toBeCloseTo(20, 2);
    const ts = p.keyframes.map((k) => k.t);
    for (let i = 1; i < ts.length; i++)
      expect((ts[i] ?? 0) - (ts[i - 1] ?? 0)).toBeLessThanOrEqual(0.1 + 1e-6);
    expect(p.keyframes.length).toBeGreaterThanOrEqual(200);
  });

  it('follows a moving face smoothly: bounded pan speed, no direction reversals', () => {
    const r = rng(2);
    // face drifts from 0.35 to 0.75 over 16 s with +-1.5% detection noise
    const p = plan(
      samples(0, 20, (t) => {
        const c = 0.35 + 0.4 * Math.min(1, Math.max(0, (t - 2) / 16));
        return [{ cx: c + (r() - 0.5) * 0.03 }];
      }),
    );
    const xs = p.keyframes.map((k) => k.x);
    const ts = p.keyframes.map((k) => k.t);
    expect(xs[xs.length - 1]!).toBeGreaterThan(xs[0]! + 150);
    expect(maxStep(xs, ts)).toBeLessThanOrEqual(reframeTuning.MAX_PAN_CROPS_PER_SEC * 270 + 1);
    // no jitter: the path never moves backwards by more than 0.5 px
    for (let i = 1; i < xs.length; i++)
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(-0.5);
    // second difference (acceleration) stays small: smooth, not stair-stepped
    let maxAcc = 0;
    for (let i = 2; i < xs.length; i++) {
      maxAcc = Math.max(maxAcc, Math.abs((xs[i] ?? 0) - 2 * (xs[i - 1] ?? 0) + (xs[i - 2] ?? 0)));
    }
    expect(maxAcc).toBeLessThan(2.5);
  });

  it('smoothing removes most of the raw detection jitter', () => {
    const r = rng(3);
    const raw: number[] = [];
    const p = plan(
      samples(0, 20, () => {
        const c = 0.5 + (r() - 0.5) * 0.08;
        raw.push(c * W - 135);
        return [{ cx: c }];
      }),
    );
    const sd = (a: number[]): number => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
    };
    const diffs = (a: number[]): number[] => a.slice(1).map((v, i) => v - (a[i] ?? 0));
    expect(sd(diffs(p.keyframes.map((k) => k.x)))).toBeLessThan(sd(diffs(raw)) / 4);
  });

  it('places the face centre at ~40% from the top when the crop is shorter than the source', () => {
    // 1440x1080 source -> 16:9 crop 1440x810: vertical room 270 px; face centre at y = 0.5
    const f = samples(0, 10, () => [{ cx: 0.5, cy: 0.5 }]);
    const p = svc.plan({
      startSec: 0,
      endSec: 10,
      srcW: 1440,
      srcH: 1080,
      aspect: '16:9',
      faces: f,
      sceneCuts: [],
    });
    const k = p.keyframes[5]!;
    expect(k.h).toBe(810);
    // face centre y = 540; crop top = 540 - 0.4*810 = 216
    expect(k.y).toBeCloseTo(216, 0);
  });

  it('clamps the crop inside the frame', () => {
    const left = plan(
      samples(0, 10, () => [{ cx: 0.03 }]),
      { endSec: 10 },
    );
    const right = plan(
      samples(0, 10, () => [{ cx: 0.98 }]),
      { endSec: 10 },
    );
    for (const k of left.keyframes) expect(k.x).toBeGreaterThanOrEqual(0);
    for (const k of right.keyframes) expect(k.x + k.w).toBeLessThanOrEqual(W + 1e-6);
    expect(left.keyframes[3]?.x).toBe(0);
    expect(right.keyframes[3]?.x).toBeCloseTo(W - 270, 1);
  });

  it('is deterministic', () => {
    const f = samples(0, 20, (t) => [{ cx: 0.4 + 0.2 * Math.sin(t / 3) }]);
    expect(plan(f)).toEqual(plan(structuredClone(f)));
  });
});

describe('reframe plan: scene cuts', () => {
  const faces = samples(0, 20, (t) => [{ cx: t < 8 ? 0.25 : 0.75 }]);

  it('jumps at the cut and does not smooth across it', () => {
    const p = plan(faces, { sceneCuts: [8] });
    expect(p.cuts).toEqual([8]);
    const before = p.keyframes.filter((k) => k.t < 8);
    const after = p.keyframes.filter((k) => k.t >= 8);
    const xa = 0.25 * W - 135;
    const xb = 0.75 * W - 135;
    // before the cut: parked on shot A the whole time (including the keyframe right before the cut)
    for (const k of before) expect(Math.abs(k.x - xa)).toBeLessThan(6);
    expect(before[before.length - 1]!.t).toBeGreaterThan(7.99);
    // the first keyframe of shot B sits at the cut and is already on the new face (no ease from A)
    const first = after[0]!;
    expect(first.t).toBeCloseTo(8, 3);
    expect(Math.abs(first.x - xb)).toBeLessThan(6);
    // nothing in between
    expect(
      p.keyframes.some(
        (k) => k.t > 7.99 && k.t < 8 - 1e-6 + 0.0005 && Math.abs(k.x - (xa + xb) / 2) < 50,
      ),
    ).toBe(false);
  });

  it('ignores cuts at the clip edges and handles clips that start mid-video', () => {
    const p = plan(faces, { sceneCuts: [0.05, 19.9, 8] });
    expect(p.cuts).toEqual([8]);
    const q = svc.plan({
      startSec: 100,
      endSec: 120,
      srcW: W,
      srcH: H,
      aspect: '9:16',
      faces: faces.map((f) => ({ ...f, t: f.t + 100 })),
      sceneCuts: [108],
    });
    expect(q.cuts).toEqual([8]);
    expect(q.keyframes[0]?.t).toBe(0);
    expect(q.keyframes.find((k) => k.t >= 8)?.x).toBeCloseTo(0.75 * W - 135, -1);
  });

  it('tracks each shot independently (different faces per shot)', () => {
    const f = samples(0, 20, (t) =>
      t < 10 ? [{ cx: 0.3 }] : [{ cx: 0.6 }, { cx: 0.2, size: 0.1 }],
    );
    const p = plan(f, { sceneCuts: [10] });
    const late = p.keyframes.filter((k) => k.t > 12);
    for (const k of late) expect(Math.abs(k.x - (0.6 * W - 135))).toBeLessThan(6);
  });
});

describe('reframe plan: gaps and fallbacks', () => {
  it('holds through a short detection gap and eases toward the centre after a long one', () => {
    const f = samples(0, 20, (t) =>
      t >= 6 && t < 6.6 ? [] : t >= 12 && t < 16 ? [] : [{ cx: 0.8 }],
    );
    const p = plan(f);
    const xFace = 0.8 * W - 135;
    const short = p.keyframes.filter((k) => k.t > 5 && k.t < 8);
    for (const k of short) expect(Math.abs(k.x - xFace)).toBeLessThan(2); // held
    const centre = (W - 270) / 2;
    const long = p.keyframes.filter((k) => k.t >= 12 && k.t < 15.9);
    expect(long[long.length - 1]!.x).toBeLessThan(xFace - 20); // moved toward the centre
    expect(long[long.length - 1]!.x).toBeGreaterThan(centre - 1); // ...but never past it
    for (let i = 1; i < long.length; i++)
      expect(long[i]!.x).toBeLessThanOrEqual(long[i - 1]!.x + 0.01); // monotone ease
    // and it comes back when the face returns
    expect(Math.abs(p.keyframes[p.keyframes.length - 1]!.x - xFace)).toBeLessThanOrEqual(
      reframeTuning.DEAD_ZONE_FRAC * 270 + 0.5,
    );
    expect(p.faceCoverage).toBeCloseTo(1 - (0.6 + 4) / 20, 1);
  });

  it('falls back to a centred static crop when there are no (or too few) faces', () => {
    const none = plan(samples(0, 20, () => []));
    expect(none.mode).toBe('center');
    expect(none.faceCoverage).toBe(0);
    expect(none.keyframes).toHaveLength(2);
    expect(none.keyframes[0]).toMatchObject({ x: 135 + (W - 270) / 2 - 135, w: 270, h: 480 });
    expect(plan([]).mode).toBe('center');
    const few = plan(samples(0, 20, (t) => (t < 2 ? [{ cx: 0.7 }] : [])));
    expect(few.mode).toBe('center');
    expect(few.faceCoverage).toBeLessThan(0.2);
  });

  it('ignores low-confidence and tiny (background) faces', () => {
    const f = samples(0, 20, () => [
      { cx: 0.15, size: 0.02 },
      { cx: 0.9, score: 0.3 },
      { cx: 0.5 },
    ]);
    const p = plan(f);
    expect(p.mode).toBe('single-face');
    for (const k of p.keyframes) expect(Math.abs(k.x - (0.5 * W - 135))).toBeLessThan(2);
  });

  it('no panning room (source already has the target aspect) -> centre mode, full frame', () => {
    const p = svc.plan({
      startSec: 0,
      endSec: 5,
      srcW: 1920,
      srcH: 1080,
      aspect: '16:9',
      faces: samples(0, 5, () => [{ cx: 0.7 }]),
      sceneCuts: [],
    });
    expect(p.mode).toBe('center');
    expect(p.keyframes[0]).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});

describe('reframe plan: dominant face selection', () => {
  const xOf = (cx: number): number => cx * W - 135;

  it('does not flip between two similar faces that are both present', () => {
    const r = rng(9);
    const f = samples(0, 20, () => [
      { cx: 0.3, size: 0.3 + (r() - 0.5) * 0.04 },
      { cx: 0.7, size: 0.28 + (r() - 0.5) * 0.04 },
    ]);
    // CP2: in 'auto' two persistent faces become a split screen; this test is about forced single-face
    const p = plan(f, { mode: 'single-face' });
    const xs = p.keyframes.map((k) => k.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2);
    expect(Math.abs((xs[0] ?? 0) - xOf(0.3))).toBeLessThan(2);
  });

  it('switches when the other face becomes clearly dominant, or when the followed one leaves', () => {
    const grows = plan(
      samples(0, 20, (t) => [
        { cx: 0.3, size: 0.28 },
        { cx: 0.7, size: t < 6 ? 0.2 : 0.42 },
      ]),
      { mode: 'single-face' },
    );
    expect(grows.keyframes[2]!.x).toBeCloseTo(xOf(0.3), -1);
    // parked at the edge of the dead-zone (3% of the crop width) of the new face
    expect(Math.abs(grows.keyframes[grows.keyframes.length - 1]!.x - xOf(0.7))).toBeLessThanOrEqual(
      reframeTuning.DEAD_ZONE_FRAC * 270 + 0.5,
    );
    const leaves = plan(
      samples(0, 20, (t) =>
        t < 8 ? [{ cx: 0.3 }, { cx: 0.7, size: 0.2 }] : [{ cx: 0.7, size: 0.2 }],
      ),
    );
    expect(leaves.keyframes[2]!.x).toBeCloseTo(xOf(0.3), -1);
    expect(
      Math.abs(leaves.keyframes[leaves.keyframes.length - 1]!.x - xOf(0.7)),
    ).toBeLessThanOrEqual(reframeTuning.DEAD_ZONE_FRAC * 270 + 0.5);
  });
});

describe('reframe plan: unreliable shots', () => {
  it('parks the camera in a flaky shot (sporadic faces at different places) instead of wandering', () => {
    const r = rng(11);
    const f = samples(0, 20, (t) => {
      if (t >= 10) return [{ cx: 0.4 }]; // second shot is a clean talking head
      const u = r();
      return u < 0.15 ? [{ cx: 0.28, size: 0.25 }] : u < 0.3 ? [{ cx: 0.74, size: 0.25 }] : [];
    });
    const p = plan(f, { sceneCuts: [10] });
    const flaky = p.keyframes.filter((k) => k.t < 9.9).map((k) => k.x);
    expect(Math.max(...flaky) - Math.min(...flaky)).toBeLessThan(0.5);
    const clean = p.keyframes.filter((k) => k.t > 12);
    for (const k of clean) expect(Math.abs(k.x - (0.4 * W - 135))).toBeLessThan(6);
  });
});

describe('facesFromSidecar', () => {
  it('maps the wire format to FaceSample[] (keypoints dropped)', () => {
    const out = facesFromSidecar({
      frames: [
        { t: 0, faces: [] },
        {
          t: 0.267,
          faces: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, score: 0.9, keypoints: [[0.1, 0.2]] } as never],
        },
      ],
    });
    expect(out).toEqual([
      { t: 0, boxes: [] },
      { t: 0.267, boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, score: 0.9 }] },
    ]);
  });
});
