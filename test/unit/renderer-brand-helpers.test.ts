import { describe, expect, it } from 'vitest';
import {
  BRAND_FORMATS,
  brandTextStyleSchema,
  defaultBrandSpec,
  watermarkRect,
  type BrandAsset,
} from '../../shared/brand';
import {
  DAY_LABELS,
  assetAspect,
  bedEnvelope,
  clearRefs,
  colorFamilyName,
  describeDays,
  formatDur,
  formatLufs,
  gridWindow,
  groupByKind,
  groupColors,
  hexToRgba,
  isLightColor,
  newId,
  normalizeHex,
  normalizeTag,
  parseTags,
  refsOfAsset,
  refsOfAssets,
  stageLabel,
  uniqueName,
  validateDrop,
  watermarkPreviewBox,
  windowError,
} from '../../renderer/lib/brand/helpers';
import { TEXT_PRESETS, presetsOfKind } from '../../renderer/lib/brand/text-presets';

describe('validateDrop', () => {
  it('accepts supported extensions case-insensitively', () => {
    const r = validateDrop(
      [
        { name: 'Logo.PNG', size: 10 },
        { name: 'mark.svg', size: 10 },
      ],
      'logo',
    );
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toEqual([]);
  });

  it('rejects wrong types with the supported list and a pointer to the right section', () => {
    const r = validateDrop([{ name: 'song.mp3', size: 10 }], 'logo');
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.message).toContain('.MP3 is not supported here');
    expect(r.rejected[0]!.message).toContain(BRAND_FORMATS.logo.label);
    expect(r.rejected[0]!.message).toContain('Audio');
  });

  it('points an .svg dropped on Fonts at Logos or Images', () => {
    const r = validateDrop([{ name: 'a.svg', size: 1 }], 'font');
    expect(r.rejected[0]!.message).toMatch(/Logos.*Images|Images.*Logos/);
  });

  it('rejects files without an extension and files over the limit', () => {
    const r = validateDrop(
      [
        { name: 'README', size: 1 },
        { name: 'huge.png', size: BRAND_FORMATS.logo.maxBytes + 1 },
      ],
      'logo',
    );
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.message).toContain('This file type is not supported here');
    expect(r.rejected[1]!.message).toContain('Too large');
  });

  it('keeps accepted and rejected files separate in one drop', () => {
    const r = validateDrop(
      [
        { name: 'a.ttf', size: 1 },
        { name: 'b.exe', size: 1 },
        { name: 'c.woff2', size: 1 },
      ],
      'font',
    );
    expect(r.accepted.map((f) => f.name)).toEqual(['a.ttf', 'c.woff2']);
    expect(r.rejected.map((f) => f.name)).toEqual(['b.exe']);
  });
});

describe('asset references', () => {
  const spec = defaultBrandSpec();
  spec.watermark.assetId = 'logo1';
  spec.introAssetId = 'vid1';
  spec.outroAssetId = 'vid1';
  spec.musicBed.assetId = 'aud1';

  it('lists what points at an asset', () => {
    expect(refsOfAsset(spec, 'logo1')).toEqual(['Watermark']);
    expect(refsOfAsset(spec, 'vid1')).toEqual(['Intro', 'Outro']);
    expect(refsOfAsset(spec, 'other')).toEqual([]);
    expect(refsOfAssets(spec, ['vid1', 'aud1', 'logo1'])).toEqual([
      'Intro',
      'Outro',
      'Music bed',
      'Watermark',
    ]);
  });

  it('clearRefs nulls only the references to deleted assets', () => {
    const p = clearRefs(spec, ['vid1']);
    expect(p.introAssetId).toBeNull();
    expect(p.outroAssetId).toBeNull();
    expect(p.watermark).toBeUndefined();
    expect(clearRefs(spec, ['logo1']).watermark?.assetId).toBeNull();
    expect(clearRefs(spec, ['aud1']).musicBed?.assetId).toBeNull();
    expect(clearRefs(spec, ['nothing'])).toEqual({});
  });

  it('groupByKind keeps every kind present', () => {
    const g = groupByKind([{ kind: 'logo' }, { kind: 'font' }, { kind: 'logo' }] as BrandAsset[]);
    expect(g.logo).toHaveLength(2);
    expect(g.audio).toEqual([]);
    expect(Object.keys(g).sort()).toEqual(['audio', 'font', 'image', 'logo', 'video']);
  });
});

describe('colours', () => {
  it('normalizeHex accepts shorthand and missing #', () => {
    expect(normalizeHex('abc')).toBe('#AABBCC');
    expect(normalizeHex('#6a4bf2')).toBe('#6A4BF2');
    expect(normalizeHex(' 6A4BF2 ')).toBe('#6A4BF2');
    expect(normalizeHex('#12')).toBeNull();
    expect(normalizeHex('zzzzzz')).toBeNull();
  });

  it('hexToRgba clamps alpha', () => {
    expect(hexToRgba('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(hexToRgba('#FF0000', 4)).toBe('rgba(255, 0, 0, 1)');
    expect(hexToRgba('nope', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('isLightColor picks the readable overlay', () => {
    expect(isLightColor('#FFFFFF')).toBe(true);
    expect(isLightColor('#FFE94D')).toBe(true);
    expect(isLightColor('#101114')).toBe(false);
    expect(isLightColor('#6A4BF2')).toBe(false);
  });

  it('colorFamilyName names greys and hues', () => {
    expect(colorFamilyName('#FFFFFF')).toBe('White');
    expect(colorFamilyName('#000000')).toBe('Black');
    expect(colorFamilyName('#FF0000')).toMatch(/red/i);
    expect(colorFamilyName('#3EA6FF')).toMatch(/blue/i);
    expect(colorFamilyName('#2EE6D6')).toMatch(/teal|green/i);
  });

  it('uniqueName numbers duplicates case-insensitively and stays within 40 chars', () => {
    expect(uniqueName('Blue', [])).toBe('Blue');
    expect(uniqueName('Blue', ['blue'])).toBe('Blue 2');
    expect(uniqueName('Blue', ['Blue', 'Blue 2'])).toBe('Blue 3');
    expect(uniqueName('x'.repeat(80), ['x'.repeat(34)]).length).toBeLessThanOrEqual(40);
  });

  it('groupColors keeps first-seen group order', () => {
    const g = groupColors([
      { group: 'B', id: 1 },
      { group: 'A', id: 2 },
      { group: 'B', id: 3 },
    ]);
    expect(g.map((x) => [x.group, x.colors.length])).toEqual([
      ['B', 2],
      ['A', 1],
    ]);
  });

  it('newId is unique and prefixed', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('c')));
    expect(ids.size).toBe(200);
    expect([...ids][0]).toMatch(/^c_/);
  });
});

describe('hashtags', () => {
  it('normalizeTag strips # and punctuation, keeps unicode letters', () => {
    expect(normalizeTag('#Growth!')).toBe('Growth');
    expect(normalizeTag('##a b')).toBe('ab');
    expect(normalizeTag('#café_ñ')).toBe('café_ñ');
    expect(normalizeTag('###')).toBe('');
    expect(normalizeTag('x'.repeat(100))).toHaveLength(60);
  });

  it('parseTags splits pasted text and skips duplicates (case-insensitive)', () => {
    expect(parseTags('#a #b, c\nd; A', ['D'])).toEqual(['a', 'b', 'c']);
    expect(parseTags('   ')).toEqual([]);
  });
});

describe('posting windows', () => {
  it('validates ordering, format and days', () => {
    expect(windowError({ start: '09:00', end: '12:00', days: [1] })).toBeNull();
    expect(windowError({ start: '12:00', end: '09:00', days: [1] })).toMatch(/after/);
    expect(windowError({ start: '09:00', end: '09:00', days: [1] })).toMatch(/after/);
    expect(windowError({ start: '9:00', end: '12:00', days: [1] })).toMatch(/HH:MM/);
    expect(windowError({ start: '09:00', end: '12:00', days: [] })).toMatch(/day/);
  });

  it('describeDays reads naturally', () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeDays([6, 0])).toBe('Sat, Sun');
    expect(describeDays([1, 2, 3])).toBe('Mon–Wed');
    expect(describeDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(describeDays([])).toBe('No days');
    expect(DAY_LABELS).toHaveLength(7);
  });
});

describe('watermark preview', () => {
  const wm = { position: 'top-right', sizePct: 16, marginPct: 4, safeArea: 'all' } as const;

  it('is exactly watermarkRect, expressed in percent of the frame', () => {
    const box = watermarkPreviewBox('9:16', wm, 1);
    const r = watermarkRect({ width: 1080, height: 1920 }, wm, 1);
    expect(box.rect).toEqual(r);
    expect(box.left).toBeCloseTo((r.x / 1080) * 100, 10);
    expect(box.top).toBeCloseTo((r.y / 1920) * 100, 10);
    expect(box.width).toBeCloseTo((r.w / 1080) * 100, 10);
    expect(box.height).toBeCloseTo((r.h / 1920) * 100, 10);
  });

  it('keeps the logo inside the frame for every position and aspect', () => {
    for (const aspect of ['9:16', '4:5', '1:1', '16:9'] as const) {
      for (const position of [
        'top-left',
        'top-right',
        'bottom-left',
        'bottom-right',
        'center',
      ] as const) {
        for (const logoAspect of [0.8, 1, 3.2]) {
          const b = watermarkPreviewBox(aspect, { ...wm, position, sizePct: 12 }, logoAspect);
          expect(b.left).toBeGreaterThanOrEqual(0);
          expect(b.top).toBeGreaterThanOrEqual(0);
          expect(b.left + b.width).toBeLessThanOrEqual(100.0001);
          expect(b.top + b.height).toBeLessThanOrEqual(100.0001);
        }
      }
    }
  });

  it('assetAspect falls back to 1', () => {
    expect(assetAspect({ width: 640, height: 200 })).toBeCloseTo(3.2);
    expect(assetAspect({ width: null, height: null })).toBe(1);
    expect(assetAspect(undefined)).toBe(1);
  });
});

describe('music bed envelope', () => {
  const bed = { gainDb: -18, duckEnabled: true, duckAmountDb: 12, fadeInSec: 1, fadeOutSec: 2 };
  const speech = [[3, 6]] as const;
  const at = (pts: { t: number; db: number }[], t: number) => pts.find((p) => p.t === t)!.db;

  it('fades in from silence, sits at the level, ducks under speech and fades out', () => {
    const pts = bedEnvelope(bed, 12, speech);
    expect(at(pts, 0)).toBe(-40);
    expect(at(pts, 2)).toBeCloseTo(-18);
    expect(at(pts, 4.5)).toBeCloseTo(-30);
    expect(at(pts, 12)).toBe(-40);
    expect(at(pts, 11)).toBeCloseTo(-29, 0); // halfway down the 2 s fade
  });

  it('does not duck when ducking is off, and never goes below the floor', () => {
    const flat = bedEnvelope({ ...bed, duckEnabled: false }, 12, speech);
    expect(at(flat, 4.5)).toBeCloseTo(-18);
    const deep = bedEnvelope({ ...bed, gainDb: -35, duckAmountDb: 30 }, 12, speech);
    expect(Math.min(...deep.map((p) => p.db))).toBe(-40);
  });

  it('is sorted by time and spans the whole sample', () => {
    const pts = bedEnvelope(bed, 12, speech);
    expect(pts[0]!.t).toBe(0);
    expect(pts.at(-1)!.t).toBe(12);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThan(pts[i - 1]!.t);
  });
});

describe('gridWindow (virtual grids)', () => {
  const base = { width: 1000, minItemWidth: 190, gap: 10, rowHeight: 100, viewport: 400 };

  it('computes columns from the width', () => {
    expect(gridWindow({ ...base, count: 100, scrollTop: 0 }).cols).toBe(5);
    expect(gridWindow({ ...base, count: 100, width: 100, scrollTop: 0 }).cols).toBe(1);
  });

  it('renders only the visible rows plus overscan, and everything near the end', () => {
    const w = gridWindow({ ...base, count: 500, scrollTop: 0 });
    expect(w.rows).toBe(100);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBeLessThan(60);
    expect(w.totalHeight).toBe(100 * 110 - 10);
    const mid = gridWindow({ ...base, count: 500, scrollTop: 5500 });
    expect(mid.startRow).toBeGreaterThan(40);
    expect(mid.offsetTop).toBe(mid.startRow * 110);
    const end = gridWindow({ ...base, count: 500, scrollTop: 100 * 110 });
    expect(end.endIndex).toBe(499);
  });

  it('handles an empty list and a partial last row', () => {
    expect(gridWindow({ ...base, count: 0, scrollTop: 0 }).endIndex).toBe(-1);
    const w = gridWindow({ ...base, count: 7, scrollTop: 0 });
    expect(w.rows).toBe(2);
    expect(w.endIndex).toBe(6);
  });
});

describe('formatting', () => {
  it('formats loudness, duration and stages', () => {
    expect(formatLufs(-14.04)).toBe('-14.0 LUFS');
    expect(formatLufs(null)).toBeNull();
    expect(formatDur(148)).toBe('2:28');
    expect(formatDur(null)).toBe('--:--');
    expect(stageLabel('upload')).toBe('Uploading');
    expect(stageLabel('loudnorm')).toBe('Measuring loudness');
    expect(stageLabel('weird')).toBe('Weird');
  });
});

describe('text style presets', () => {
  it('every preset parses with the real schema and covers all four kinds', () => {
    expect(TEXT_PRESETS.length).toBeGreaterThanOrEqual(8);
    for (const p of TEXT_PRESETS) {
      const made = p.make();
      expect(made.kind).toBe(p.kind);
      expect(brandTextStyleSchema.safeParse({ id: 'x', ...made }).success, p.key).toBe(true);
    }
    for (const k of ['title', 'hook', 'cta', 'lower-third'] as const)
      expect(presetsOfKind(k).length, k).toBeGreaterThan(0);
    expect(new Set(TEXT_PRESETS.map((p) => p.key)).size).toBe(TEXT_PRESETS.length);
  });
});
