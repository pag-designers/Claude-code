import { describe, expect, it } from 'vitest';
import {
  cursorFor,
  fitPreview,
  formatTimecode,
  hitHandle,
  naturalSize,
  pointInQuad,
  quadBounds,
  safeRect,
  toBufferPx,
} from '../../renderer/components/editor/preview/layout';
import {
  relevantAssets,
  summarizeStatuses,
} from '../../renderer/components/editor/preview/assets-status';
import { asset, aItem, project, track, vItem } from './editor-playback-fakes';
import { SAFE_AREAS } from '../../shared/editor';

const base = { canvasW: 1080, canvasH: 1920, pad: 12, dpr: 1, maxBufferLong: 960 };

describe('fitPreview', () => {
  it('keeps the project aspect and letterboxes inside the container', () => {
    const r = fitPreview({ ...base, containerW: 800, containerH: 600 });
    expect(r.cssH).toBeLessThanOrEqual(600 - 24);
    expect(r.cssW / r.cssH).toBeCloseTo(1080 / 1920, 2);
  });
  it('width-limited containers fit by width', () => {
    const r = fitPreview({
      ...base,
      canvasW: 1920,
      canvasH: 1080,
      containerW: 400,
      containerH: 900,
    });
    expect(r.cssW).toBe(376);
    expect(r.cssH).toBe(Math.floor(376 / (1920 / 1080)));
  });
  it('is devicePixelRatio aware but caps the buffer long side (proxy resolution)', () => {
    const r1 = fitPreview({ ...base, containerW: 400, containerH: 500, dpr: 1 });
    const r2 = fitPreview({ ...base, containerW: 400, containerH: 500, dpr: 2 });
    expect(r2.bufW).toBeGreaterThan(r1.bufW);
    const big = fitPreview({ ...base, containerW: 1400, containerH: 1400, dpr: 2 });
    expect(Math.max(big.bufW, big.bufH)).toBeLessThanOrEqual(960);
    expect(big.bufW / big.bufH).toBeCloseTo(1080 / 1920, 2);
  });
  it('k and previewScale relate buffer, css and project px', () => {
    const r = fitPreview({ ...base, containerW: 500, containerH: 700, dpr: 2 });
    expect(r.k).toBeCloseTo(r.bufW / r.cssW, 9);
    expect(r.previewScale).toBeCloseTo(r.bufW / 1080, 9);
  });
  it('never returns a zero-size canvas', () => {
    const r = fitPreview({ ...base, containerW: 10, containerH: 10 });
    expect(r.cssW).toBeGreaterThanOrEqual(1);
    expect(r.bufW).toBeGreaterThanOrEqual(2);
  });
  it('supports 1:1, 4:5 and custom aspects', () => {
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
      [777, 333],
    ] as const) {
      const r = fitPreview({ ...base, canvasW: w, canvasH: h, containerW: 600, containerH: 600 });
      expect(r.cssW / r.cssH).toBeCloseTo(w / h, 1);
    }
  });
});

describe('formatTimecode', () => {
  it('mm:ss:ff at the project fps', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(1.5, 30)).toBe('00:01:15');
    expect(formatTimecode(61, 30)).toBe('01:01:00');
    expect(formatTimecode(59.999, 30)).toBe('00:59:29');
    expect(formatTimecode(3, 24)).toBe('00:03:00');
  });
  it('frame numbers never reach the fps and survive float noise', () => {
    expect(formatTimecode(2 - 1e-12, 30)).toBe('00:02:00');
    expect(formatTimecode(0.1 + 0.2, 30)).toBe('00:00:09');
    expect(formatTimecode(-4, 30)).toBe('00:00:00');
  });
});

describe('geometry', () => {
  const quad = [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 110, y: 60 },
    { x: 10, y: 60 },
  ] as const;
  const rotated = [
    { x: 50, y: 0 },
    { x: 100, y: 50 },
    { x: 50, y: 100 },
    { x: 0, y: 50 },
  ] as const;
  it('point in (rotated) quad', () => {
    expect(pointInQuad({ x: 50, y: 30 }, quad)).toBe(true);
    expect(pointInQuad({ x: 5, y: 30 }, quad)).toBe(false);
    expect(pointInQuad({ x: 50, y: 50 }, rotated)).toBe(true);
    expect(pointInQuad({ x: 5, y: 5 }, rotated)).toBe(false);
  });
  const handles = {
    corners: [...quad] as [(typeof quad)[0], (typeof quad)[1], (typeof quad)[2], (typeof quad)[3]],
    center: { x: 60, y: 35 },
    rotationHandle: { x: 60, y: -10 },
    rotation: 0,
  };
  it('hit-testing priority: rotate > corners > body, with a constant on-screen radius', () => {
    expect(hitHandle(handles, { x: 60, y: -8 }, 1)).toBe('rotate');
    expect(hitHandle(handles, { x: 12, y: 12 }, 1)).toBe('scale-nw');
    expect(hitHandle(handles, { x: 108, y: 12 }, 1)).toBe('scale-ne');
    expect(hitHandle(handles, { x: 108, y: 58 }, 1)).toBe('scale-se');
    expect(hitHandle(handles, { x: 12, y: 58 }, 1)).toBe('scale-sw');
    expect(hitHandle(handles, { x: 60, y: 35 }, 1)).toBe('move');
    expect(hitHandle(handles, { x: 300, y: 300 }, 1)).toBeNull();
    // with k = 2 (buffer px per css px) the corner radius doubles
    expect(hitHandle(handles, { x: 22, y: 22 }, 2)).toBe('scale-nw');
    expect(hitHandle(handles, { x: 22, y: 22 }, 1)).toBe('move');
  });
  it('quad bounds and natural size', () => {
    expect(quadBounds(quad)).toEqual({ x: 10, y: 10, w: 100, h: 50 });
    const n = naturalSize(handles, 0.5, 2);
    expect(n.rectW).toBeCloseTo(100, 6);
    expect(n.rectH).toBeCloseTo(50, 6);
    expect(naturalSize(handles, 1, 0).rectW).toBeCloseTo(100, 6);
  });
  it('cursors follow the handle and the item rotation', () => {
    expect(cursorFor(null)).toBe('default');
    expect(cursorFor('move')).toBe('move');
    expect(cursorFor('rotate')).toBe('grab');
    expect(cursorFor('scale-nw', 0)).toBe('nwse-resize');
    expect(cursorFor('scale-ne', 0)).toBe('nesw-resize');
    expect(cursorFor('scale-nw', 90)).toBe('nesw-resize');
    expect(cursorFor('scale-se', 45)).toBe('ns-resize');
  });
  it('client → buffer px mapping', () => {
    const rect = { left: 100, top: 50, width: 200, height: 400 };
    expect(toBufferPx(200, 250, rect, 400, 800)).toEqual({ x: 200, y: 400 });
    expect(toBufferPx(100, 50, rect, 400, 800)).toEqual({ x: 0, y: 0 });
  });
  it('safe-area rectangle from the platform fractions', () => {
    const r = safeRect(SAFE_AREAS.tiktok!, 540, 960);
    expect(r.x).toBeCloseTo(27, 6);
    expect(r.y).toBeCloseTo(96, 6);
    expect(r.w).toBeCloseTo(540 * (1 - 0.05 - 0.14), 6);
    expect(r.h).toBeCloseTo(960 * (1 - 0.1 - 0.2), 6);
  });
});

describe('asset status summary', () => {
  const v = asset({ id: 'v1' });
  const m = asset({ id: 'm1', kind: 'audio' });
  const p = project(
    [
      track({ id: 'v', items: [vItem({ id: 'x', durationSec: 5 })] }),
      track({ id: 'a', kind: 'audio', items: [aItem({ id: 'y', assetId: 'm1', durationSec: 5 })] }),
    ],
    [v, m],
  );
  it('picture assets under the playhead are separated from audio-only ones', () => {
    // the sample video asset id is `a1` in the builders
    const rel = relevantAssets(p, 1);
    expect(rel.visual).toEqual(['a1']);
    expect(rel.audio.sort()).toEqual(['a1', 'm1']);
  });
  it('ignores items far from the playhead and hidden tracks', () => {
    expect(relevantAssets(p, 50)).toEqual({ visual: [], audio: [] });
    const hidden = project(
      [track({ id: 'v', hidden: true, items: [vItem({ durationSec: 5 })] })],
      [v],
    );
    expect(relevantAssets(hidden, 1).visual).toEqual([]);
  });
  it('an error on a visual asset blocks the preview with its reason; loading shows the skeleton', () => {
    const rel = { visual: ['a1', 'b'], audio: ['m1'] };
    const s = summarizeStatuses(rel, {
      a1: { state: 'error', reason: 'this video has no 480p proxy' },
      b: { state: 'error', reason: 'nope' },
      m1: { state: 'error', reason: 'audio gone' },
    });
    expect(s.error).toEqual({ assetId: 'a1', reason: 'this video has no 480p proxy' });
    expect(s.moreErrors).toBe(1);
    expect(s.loading).toBe(false);
    expect(s.audioErrors).toEqual([{ assetId: 'm1', reason: 'audio gone' }]);
    const l = summarizeStatuses(rel, {
      a1: { state: 'loading', reason: null },
      b: { state: 'ready', reason: null },
    });
    expect(l.loading).toBe(true);
    expect(l.error).toBeNull();
  });
  it('unknown assets are neither loading nor failed', () => {
    const s = summarizeStatuses({ visual: ['zzz'], audio: [] }, {});
    expect(s).toEqual({ loading: false, error: null, moreErrors: 0, audioErrors: [] });
  });
});
