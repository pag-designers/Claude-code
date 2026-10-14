import { describe, expect, it } from 'vitest';
import type { BrollItem } from '../../shared/brand';
import {
  PROVIDER_INFO,
  clipDuration,
  columnsFromOffsets,
  dimensionsLabel,
  gridNavigate,
  gridSpec,
  importSummary,
  mergePages,
  shapeLabel,
  suggestSource,
} from '../../renderer/lib/broll/model';

const item = (id: string, over: Partial<BrollItem> = {}): BrollItem => ({
  id,
  provider: 'pexels',
  title: id,
  author: null,
  pageUrl: null,
  thumbUrl: 'https://x/y.jpg',
  previewUrl: null,
  width: 1080,
  height: 1920,
  durationSec: 5,
  ...over,
});

describe('mergePages', () => {
  it('appends in order and drops repeated ids', () => {
    const out = mergePages([
      { items: [item('a'), item('b')] },
      { items: [item('b'), item('c')] },
      { items: [] },
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('labels', () => {
  it('formats durations and sizes', () => {
    expect(clipDuration(14)).toBe('0:14');
    expect(clipDuration(65.4)).toBe('1:05');
    expect(clipDuration(-3)).toBe('0:00');
    expect(clipDuration(0)).toBe('0:00');
    expect(dimensionsLabel({ width: 1080, height: 1920 })).toBe('1080×1920');
    expect(shapeLabel(1080, 1920)).toBe('Portrait');
    expect(shapeLabel(1920, 1080)).toBe('Landscape');
    expect(shapeLabel(1000, 1000)).toBe('Square');
  });
  it('summarises an import run', () => {
    expect(importSummary(1, 0)).toBe('Added 1 clip');
    expect(importSummary(3, 1)).toBe('Added 3 clips · 1 failed');
    expect(importSummary(0, 2, 1)).toBe('Added 0 clips · 2 failed · 1 not started');
  });
  it("knows both providers' attribution", () => {
    expect(PROVIDER_INFO.pexels.attribution).toBe('Videos provided by');
    expect(PROVIDER_INFO.pexels.homeUrl).toBe('https://www.pexels.com');
    expect(PROVIDER_INFO.pixabay.homeUrl).toBe('https://pixabay.com');
  });
  it('gives portrait a tall thumbnail and landscape a wide one', () => {
    expect(gridSpec('portrait').aspect).toBe('9 / 16');
    expect(gridSpec('landscape').aspect).toBe('16 / 9');
    expect(gridSpec('square').aspect).toBe('1 / 1');
    expect(gridSpec('any').minCol).toBeGreaterThan(100);
  });
});

describe('gridNavigate', () => {
  // 7 cells, 3 columns:  0 1 2 / 3 4 5 / 6
  it.each([
    ['ArrowRight', 0, 1],
    ['ArrowRight', 6, null],
    ['ArrowLeft', 0, null],
    ['ArrowLeft', 4, 3],
    ['ArrowDown', 1, 4],
    ['ArrowDown', 4, 6], // no cell below column 1 in the last row: land on the last cell
    ['ArrowDown', 6, null],
    ['ArrowUp', 4, 1],
    ['ArrowUp', 1, null],
    ['Home', 5, 0],
    ['End', 0, 6],
    ['Home', 0, null],
    ['x', 0, null],
  ] as const)('%s from %i -> %s', (key, from, to) => {
    expect(gridNavigate(key, from, 3, 7)).toBe(to);
  });
  it('is inert for an empty grid and a single column', () => {
    expect(gridNavigate('ArrowRight', 0, 3, 0)).toBeNull();
    expect(gridNavigate('ArrowDown', 0, 1, 3)).toBe(1);
    expect(gridNavigate('ArrowDown', 2, 0, 3)).toBeNull(); // cols clamp to 1
  });
});

describe('columnsFromOffsets', () => {
  it('counts the cells on the first row', () => {
    expect(columnsFromOffsets([10, 10, 10, 330, 330])).toBe(3);
    expect(columnsFromOffsets([10, 11, 330])).toBe(2);
    expect(columnsFromOffsets([10])).toBe(1);
    expect(columnsFromOffsets([])).toBe(1);
  });
});

describe('suggestSource', () => {
  it('prefers the passage, else a descriptive query, else nothing', () => {
    expect(suggestSource('  we left the city at dawn ', 'x')).toBe('we left the city at dawn');
    expect(suggestSource(undefined, 'busy street at night')).toBe('busy street at night');
    expect(suggestSource('   ', '  ')).toBeNull();
    expect(suggestSource(undefined, 'ab')).toBeNull();
    expect(suggestSource('a'.repeat(3000), '')?.length).toBe(2000);
  });
});
