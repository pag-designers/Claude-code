import { describe, expect, it } from 'vitest';
import {
  candidateTimes,
  compositionScore,
  exposureScore,
  faceScore,
  faceSizeScore,
  layoutThumbText,
  mainFace,
  parseRmsSeries,
  scoreMeasurements,
  sharpnessAbsolute,
  sharpnessScores,
  thumbWords,
  buildThumbAss,
  wrapWords,
  WEIGHTS,
} from '../../electron/main/services/thumbnails';

const face = (x: number, y: number, w: number, h: number, score = 0.9) => ({ x, y, w, h, score });

describe('sharpness', () => {
  it('is monotone in the Laplacian variance, 0 for flat and 1 for very crisp', () => {
    expect(sharpnessAbsolute(0)).toBe(0);
    expect(sharpnessAbsolute(10)).toBe(0);
    expect(sharpnessAbsolute(5000)).toBe(1);
    let prev = -1;
    for (const v of [20, 40, 80, 160, 320, 640, 900]) {
      const s = sharpnessAbsolute(v);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('batch scores are half relative: the sharpest candidate gets the highest score, a blurry one the lowest', () => {
    const s = sharpnessScores([16, 70, 112, 60]);
    expect(s.indexOf(Math.max(...s))).toBe(2);
    expect(s.indexOf(Math.min(...s))).toBe(0);
    expect(sharpnessScores([0, 0])).toEqual([0, 0]);
  });
});

describe('face score', () => {
  it('no face = 0; any good face is well above', () => {
    expect(faceScore([])).toBe(0);
    expect(faceScore([face(0.4, 0.3, 0.2, 0.2)])).toBeGreaterThan(0.85);
  });

  it('size: ideal 8-35% of the height, penalised when tiny or huge', () => {
    expect(faceSizeScore(0.2)).toBe(1);
    expect(faceSizeScore(0.08)).toBe(1);
    expect(faceSizeScore(0.35)).toBe(1);
    expect(faceSizeScore(0.04)).toBeCloseTo(0.5, 6);
    expect(faceSizeScore(0.6)).toBe(0);
    const small = faceScore([face(0.45, 0.3, 0.04, 0.04)]);
    const ideal = faceScore([face(0.4, 0.3, 0.2, 0.2)]);
    const huge = faceScore([face(0.2, 0.1, 0.6, 0.6)]);
    expect(ideal).toBeGreaterThan(small);
    expect(ideal).toBeGreaterThan(huge);
  });

  it('prefers a horizontally centred face and the biggest/most confident one', () => {
    const centred = faceScore([face(0.4, 0.3, 0.2, 0.2)]);
    const edge = faceScore([face(0.0, 0.3, 0.2, 0.2)]);
    expect(centred).toBeGreaterThan(edge);
    expect(mainFace([face(0.1, 0.1, 0.05, 0.05), face(0.4, 0.3, 0.2, 0.2)])?.w).toBe(0.2);
  });
});

describe('composition', () => {
  const ok = { brightness: 0.5, contrast: 0.2 };
  it('face in the upper-middle beats a face at the bottom; cut-off faces are penalised', () => {
    const upper = compositionScore({ ...ok, faces: [face(0.4, 0.2, 0.2, 0.2)] });
    const low = compositionScore({ ...ok, faces: [face(0.4, 0.7, 0.2, 0.2)] });
    const cut = compositionScore({
      ...ok,
      faces: [face(0.4, -0.01 + 0.0, 0.2, 0.3)].map((f) => ({ ...f, y: 0 })),
    });
    expect(upper).toBeGreaterThan(low);
    expect(upper).toBeGreaterThan(cut);
  });

  it('exposure: too dark / too bright / flat frames score lower', () => {
    expect(exposureScore(0.5, 0.2)).toBeCloseTo(1, 6);
    expect(exposureScore(0.05, 0.2)).toBeLessThan(0.3);
    expect(exposureScore(0.97, 0.2)).toBeLessThan(0.3);
    expect(exposureScore(0.5, 0.02)).toBeLessThan(exposureScore(0.5, 0.2));
    expect(compositionScore({ ...ok, faces: [] })).toBeLessThan(0.31);
  });
});

describe('scoreMeasurements', () => {
  it('total = 0.35 sharp + 0.40 face + 0.25 composition; the best frame (sharp + good face) wins', () => {
    expect(WEIGHTS.sharpness + WEIGHTS.face + WEIGHTS.composition).toBeCloseTo(1, 9);
    const m = [
      { sharpness: 20, brightness: 0.5, contrast: 0.2, faces: [face(0.4, 0.3, 0.2, 0.2)] }, // blurry
      { sharpness: 300, brightness: 0.5, contrast: 0.2, faces: [face(0.4, 0.3, 0.2, 0.2)] }, // best
      { sharpness: 300, brightness: 0.5, contrast: 0.2, faces: [] }, // sharp but no face
      { sharpness: 300, brightness: 0.5, contrast: 0.2, faces: [face(0.0, 0.8, 0.05, 0.05)] }, // tiny, low, at the edge
    ];
    const s = scoreMeasurements(m);
    expect(s.map((x) => x.total).indexOf(Math.max(...s.map((x) => x.total)))).toBe(1);
    for (const x of s) {
      for (const v of [x.sharpness, x.face, x.composition, x.total]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(x.total).toBeCloseTo(
        WEIGHTS.sharpness * x.sharpness +
          WEIGHTS.face * x.face +
          WEIGHTS.composition * x.composition,
        2,
      );
    }
    expect(s[2]!.total).toBeLessThan(s[1]!.total);
    expect(s[0]!.total).toBeLessThan(s[1]!.total);
  });
});

describe('candidate times', () => {
  const flat = Array.from({ length: 120 }, (_, i) => ({ t: i * 0.25, db: -30 }));
  it('spreads evenly inside [from, to] and is deterministic', () => {
    const t = candidateTimes(3, 27, 8, []);
    expect(t).toHaveLength(8);
    expect(t[0]!).toBeCloseTo(4.5, 6);
    expect(t[7]!).toBeCloseTo(25.5, 6);
    expect(candidateTimes(3, 27, 8, flat)).toEqual(candidateTimes(3, 27, 8, flat));
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
  });

  it('nudges toward louder moments (speech) inside the slot, never outside [from, to]', () => {
    const rms = flat.map((r) => (Math.abs(r.t - 9.5) < 0.2 ? { ...r, db: -12 } : r));
    const t = candidateTimes(3, 27, 8, rms);
    expect(t.some((x) => Math.abs(x - 9.5) < 0.3)).toBe(true);
    for (const x of t) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(27);
    }
  });

  it('degenerate spans still give a time', () => {
    expect(candidateTimes(5, 5, 8, [])).toEqual([5]);
    expect(candidateTimes(1, 1.5, 8, []).length).toBeGreaterThanOrEqual(1);
  });

  it('parses ametadata output', () => {
    const txt =
      'frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-23.5\nframe:1    pts:2000    pts_time:0.25\nlavfi.astats.Overall.RMS_level=-inf\n';
    expect(parseRmsSeries(txt)).toEqual([
      { t: 0, db: -23.5 },
      { t: 0.25, db: -90 },
    ]);
  });
});

describe('overlay text', () => {
  it('keeps at most 5 words, upper-cased, markup-safe', () => {
    expect(thumbWords('he told me to stop right there now')).toEqual([
      'HE',
      'TOLD',
      'ME',
      'TO',
      'STOP',
    ]);
    expect(thumbWords('{\\an9}evil')).toEqual(['AN9EVIL']);
    expect(thumbWords('   ')).toEqual([]);
  });

  it('wraps into <= 3 balanced lines and auto-fits inside the safe margins', () => {
    expect(wrapWords(['HE', 'TOLD', 'ME', 'TO', 'STOP']).length).toBeLessThanOrEqual(3);
    for (const text of [
      'Wow',
      'He told me to stop',
      'Extraordinarily unbelievable circumstances happened',
    ]) {
      const lay = layoutThumbText(text, 720, 1280)!;
      const longest = Math.max(...lay.lines.map((l) => l.join(' ').length));
      expect(longest * lay.fontSize * 0.72).toBeLessThanOrEqual(720 * 0.84 + 1);
      expect(lay.fontSize).toBeLessThanOrEqual(0.095 * 1280);
      expect(lay.cy).toBeGreaterThan(0.5 * 1280);
    }
    expect(layoutThumbText('', 720, 1280)).toBeNull();
  });

  it('ASS document: shipped font, stroke, accent on the last word; null without text', () => {
    const ass = buildThumbAss('He told me to stop', 720, 1280)!;
    expect(ass).toContain('PlayResX: 720');
    expect(ass).toContain('Montserrat ExtraBold');
    expect(ass).toContain('HE TOLD');
    expect(ass).toContain('\\1c&H000AD6FF&');
    expect(ass).toContain('Dialogue: 0,');
    expect(buildThumbAss(null, 720, 1280)).toBeNull();
    expect(buildThumbAss('  ', 720, 1280)).toBeNull();
  });
});
