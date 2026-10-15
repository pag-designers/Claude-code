import { describe, expect, it } from 'vitest';
import { animatedAt, ease } from '../../../shared/editor-eval';
import { adaptiveKnots, tempoChain } from '../../../electron/main/services/editor-export/audio';
import { crfFromQuality } from '../../../electron/main/services/editor-export';
import {
  affineExpr,
  mapSeries,
  num,
  seriesAt,
  seriesExpr,
  seriesRange,
  simplifyIndices,
  toSeries,
  type Series,
} from '../../../electron/main/services/editor-export/pl';
import { ff, haveFfmpeg } from './helpers';

const frames = (n: number, fps = 30): number[] => Array.from({ length: n }, (_v, i) => i / fps);

/** Evaluates an FFmpeg expression of `t` with the REAL expression engine (aevalsrc), 1 kHz samples. */
function evalWithFfmpeg(expr: string, dur: number): number[] {
  const out = ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs='${expr}':s=1000:d=${dur}`,
    '-f',
    'f32le',
    '-',
  ]);
  const copy = Buffer.from(out);
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4));
}

describe('pl: sampling and simplification', () => {
  it('num() never emits exponents or trailing zeros', () => {
    expect(num(1e-7)).toBe('0');
    expect(num(0.1 + 0.2)).toBe('0.3');
    expect(num(-0)).toBe('0');
    expect(num(12345.5)).toBe('12345.5');
    expect(num(1 / 3, 4)).toBe('0.3333');
    expect(num(Infinity)).toBe('0');
  });

  it('a flat signal is a constant (first sample)', () => {
    const t = frames(30);
    expect(
      toSeries(
        t,
        t.map(() => 5),
        0.01,
      ),
    ).toEqual({ kind: 'const', v: 5 });
  });

  it('a straight line collapses to two knots', () => {
    const t = frames(60);
    const s = toSeries(
      t,
      t.map((x) => 10 + 100 * x),
      0.01,
    );
    expect(s.kind).toBe('pl');
    if (s.kind === 'pl') expect(s.knots).toHaveLength(2);
  });

  it('simplifyIndices keeps the first, last and the corner of a ramp', () => {
    const t = frames(31);
    const v = t.map((x) => (x < 0.5 ? x * 2 : 1));
    const idx = simplifyIndices(t, v, 0.001);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(30);
    expect(idx).toContain(15);
    expect(idx.length).toBeLessThanOrEqual(4);
  });

  it('ease-in-out between keyframes: every frame within tol, few knots', () => {
    const a = {
      v: 0,
      kf: [
        { t: 0, v: 0, ease: 'ease-in-out' as const },
        { t: 2, v: 100, ease: 'linear' as const },
      ],
    };
    const t = frames(61);
    const v = t.map((x) => animatedAt(a, x));
    const s = toSeries(t, v, 0.25);
    const worst = Math.max(...t.map((x, i) => Math.abs(seriesAt(s, x) - (v[i] as number))));
    expect(worst).toBeLessThanOrEqual(0.25 + 1e-9);
    if (s.kind === 'pl') expect(s.knots.length).toBeLessThan(25);
  });

  it('every knot is an exact sample (exact at those frames)', () => {
    const a = {
      v: 0,
      kf: [
        { t: 0, v: 3, ease: 'ease-out' as const },
        { t: 1, v: 9, ease: 'linear' as const },
      ],
    };
    const t = frames(31);
    const v = t.map((x) => animatedAt(a, x));
    const s = toSeries(t, v, 0.05);
    if (s.kind !== 'pl') throw new Error('expected pl');
    for (const k of s.knots) expect(k.v).toBeCloseTo(animatedAt(a, k.t), 9);
  });

  it("'hold' keyframes produce a one-frame step at the exact frame", () => {
    const a = {
      v: 0,
      kf: [
        { t: 0, v: 1, ease: 'hold' as const },
        { t: 0.5, v: 5, ease: 'linear' as const },
      ],
    };
    const t = frames(30);
    const v = t.map((x) => animatedAt(a, x));
    const s = toSeries(t, v, 0.01);
    expect(seriesAt(s, 14 / 30)).toBe(1); // last frame before the keyframe
    expect(seriesAt(s, 15 / 30)).toBe(5); // frame exactly at the keyframe
  });

  it('bezier easing is reproduced to 0.5 % of the range', () => {
    const a = {
      v: 0,
      kf: [
        { t: 0, v: 0, ease: { type: 'bezier' as const, x1: 0.2, y1: 1.4, x2: 0.4, y2: 0.9 } },
        { t: 1.5, v: 200, ease: 'linear' as const },
      ],
    };
    const t = frames(46);
    const v = t.map((x) => animatedAt(a, x));
    const s = toSeries(t, v, 1);
    const worst = Math.max(...t.map((x, i) => Math.abs(seriesAt(s, x) - (v[i] as number))));
    expect(worst).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('mapSeries / seriesRange / affineExpr', () => {
    const s: Series = {
      kind: 'pl',
      knots: [
        { t: 0, v: 1 },
        { t: 1, v: 3 },
      ],
    };
    expect(seriesRange(s)).toEqual({ min: 1, max: 3 });
    expect(
      seriesAt(
        mapSeries(s, (v) => v * 2),
        0.5,
      ),
    ).toBe(4);
    expect(affineExpr({ kind: 'const', v: 2 }, 3, 1)).toBe('7');
  });

  it('ease() is what the series are built from (sanity of the shared evaluator)', () => {
    expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5, 6);
    expect(ease('hold', 0.99)).toBe(0);
  });
});

describe.skipIf(!haveFfmpeg)(
  'pl: expressions evaluated by the real FFmpeg expression engine',
  () => {
    const cases: [string, Series][] = [
      [
        'two knots',
        {
          kind: 'pl',
          knots: [
            { t: 0, v: 1 },
            { t: 2, v: 5 },
          ],
        },
      ],
      [
        'step',
        {
          kind: 'pl',
          knots: [
            { t: 0, v: 0 },
            { t: 1, v: 0 },
            { t: 1.034, v: 10 },
            { t: 3, v: 10 },
          ],
        },
      ],
      [
        'five knots',
        {
          kind: 'pl',
          knots: [
            { t: 0, v: 0 },
            { t: 0.5, v: 4 },
            { t: 1.5, v: -2 },
            { t: 2.2, v: 7 },
            { t: 3, v: 1 },
          ],
        },
      ],
    ];
    for (const [name, s] of cases) {
      it(`seriesExpr(${name}) == seriesAt`, () => {
        const got = evalWithFfmpeg(seriesExpr(s), 3);
        let worst = 0;
        const last = s.kind === 'pl' ? (s.knots[s.knots.length - 1] as { t: number }).t : 3;
        for (let i = 0; i < got.length; i++) {
          if (i / 1000 > last) break; // beyond the last knot the expression extends the last segment
          worst = Math.max(worst, Math.abs((got[i] as number) - seriesAt(s, i / 1000)));
        }
        expect(worst).toBeLessThan(0.01);
      });
    }

    it('a 120-knot series builds a log-depth tree that FFmpeg evaluates correctly', () => {
      const t = Array.from({ length: 120 }, (_v, i) => i * 0.025);
      const v = t.map((x) => Math.sin(x * 3) * 10);
      const s: Series = { kind: 'pl', knots: t.map((tt, i) => ({ t: tt, v: v[i] as number })) };
      const e = seriesExpr(s);
      expect(e.split('if(').length - 1).toBe(118);
      // nesting depth ~ log2(119)
      let depth = 0;
      let max = 0;
      for (const ch of e) {
        if (ch === '(') max = Math.max(max, ++depth);
        if (ch === ')') depth--;
      }
      expect(max).toBeLessThan(30);
      const got = evalWithFfmpeg(e, 2.9);
      let worst = 0;
      for (let i = 0; i < got.length; i++)
        worst = Math.max(worst, Math.abs((got[i] as number) - seriesAt(s, i / 1000)));
      expect(worst).toBeLessThan(0.02);
    });

    it('the time variable can be renamed (setpts uses T)', () => {
      const s: Series = {
        kind: 'pl',
        knots: [
          { t: 0, v: 1 },
          { t: 1, v: 2 },
        ],
      };
      expect(seriesExpr(s, 'T')).toContain('(T-');
      expect(seriesExpr(s, 'T')).not.toContain('(t-');
    });
  },
);

describe('audio helpers', () => {
  it('tempoChain: identity, plain range, below 0.5 chains, above 2 single stage', () => {
    expect(tempoChain(1)).toEqual([]);
    expect(tempoChain(1.5)).toEqual(['atempo=1.5']);
    expect(tempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(tempoChain(0.1)).toEqual(['atempo=0.5', 'atempo=0.5', 'atempo=0.5', 'atempo=0.8']);
    expect(tempoChain(8)).toEqual(['atempo=8']);
  });

  it('adaptiveKnots: a linear ramp needs only its endpoints; a curve gets refined; a jump keeps both sides', () => {
    expect(adaptiveKnots((t) => t * 2, [0, 1], 0.003)).toHaveLength(2);
    expect(adaptiveKnots((t) => Math.sin(t * 3), [0, 2], 0.003).length).toBeGreaterThan(8);
    const step = adaptiveKnots((t) => (t < 1 ? 0 : 1), [0, 0.9999, 1, 2], 0.003);
    expect(step.map((k) => k.v)).toContain(0);
    expect(step.map((k) => k.v)).toContain(1);
  });

  it('quality → CRF: 0 → 30, 70 → 20, 100 → 16 (clamped)', () => {
    expect(crfFromQuality(0)).toBe(30);
    expect(crfFromQuality(70)).toBe(20);
    expect(crfFromQuality(100)).toBe(16);
    expect(crfFromQuality(150)).toBe(16);
    expect(crfFromQuality(-5)).toBe(30);
  });
});
