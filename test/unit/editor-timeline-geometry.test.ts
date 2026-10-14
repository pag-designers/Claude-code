import { describe, expect, it } from 'vitest';
import type { Asset, Item, Project, Track } from '../../shared/editor';
import {
  HEADER_W,
  SECTION_GAP,
  TRACK_HEIGHT,
  clampTrim,
  clampZoom,
  collectKeyframes,
  collectSnapPoints,
  cullItems,
  displayOrder,
  edgeScrollSpeed,
  fitZoom,
  formatTimecode,
  groupColorIndex,
  groupKeyframes,
  itemAriaLabel,
  itemAtPoint,
  layoutTracks,
  majorStep,
  marqueeHits,
  newTrackKindForAsset,
  normRect,
  parseTimecode,
  pxToSec,
  renderWindow,
  resolveDropTarget,
  resolveTransitionTarget,
  rulerTicks,
  secToPx,
  secToViewportPx,
  sliderToZoom,
  snapToFrame,
  snapValue,
  trackAtY,
  viewportPxToSec,
  visibleSpan,
  wheelZoomFactor,
  zoomAround,
  zoomToSlider,
} from '../../renderer/components/editor/timeline/geometry';

const video = (id: string, startSec: number, durationSec: number, extra: Partial<Item> = {}) =>
  ({
    type: 'video',
    id,
    startSec,
    durationSec,
    name: id,
    groupId: null,
    locked: false,
    assetId: 'a1',
    inSec: 0,
    speed: 1,
    speedCurve: [],
    reverse: false,
    freezeAtSec: null,
    preservePitch: true,
    noiseGate: false,
    volume: { v: 1, kf: [] },
    fadeInSec: 0,
    fadeOutSec: 0,
    transform: {
      x: { v: 0, kf: [] },
      y: { v: 0, kf: [] },
      scale: { v: 1, kf: [] },
      rotation: { v: 0, kf: [] },
      opacity: { v: 1, kf: [] },
    },
    crop: { x: { v: 0, kf: [] }, y: { v: 0, kf: [] }, w: { v: 1, kf: [] }, h: { v: 1, kf: [] } },
    fit: 'cover',
    backgroundBlur: false,
    blend: 'normal',
    mirror: false,
    blur: { v: 0, kf: [] },
    color: {
      exposure: { v: 0, kf: [] },
      contrast: { v: 0, kf: [] },
      saturation: { v: 0, kf: [] },
      temperature: { v: 0, kf: [] },
      filter: null,
      lutAssetId: null,
      lutAmount: 1,
    },
    transitionIn: null,
    audioEnabled: true,
    ...extra,
  }) as Item;

const track = (
  id: string,
  kind: Track['kind'],
  items: Item[] = [],
  extra: Partial<Track> = {},
): Track => ({
  id,
  kind,
  name: id,
  locked: false,
  muted: false,
  hidden: false,
  gain: 1,
  ducking: { enabled: false, reductionDb: 12, attackSec: 0.15, releaseSec: 0.5 },
  speech: false,
  items,
  ...extra,
});

describe('time <-> px', () => {
  it('round-trips', () => {
    expect(secToPx(2.5, 80)).toBe(200);
    expect(pxToSec(200, 80)).toBe(2.5);
    expect(secToViewportPx(12, 50, 10)).toBe(100);
    expect(viewportPxToSec(100, 50, 10)).toBe(12);
  });
  it('snaps to frames and never goes negative', () => {
    expect(snapToFrame(1.02, 30)).toBeCloseTo(1.0333333, 5);
    expect(snapToFrame(-3, 30)).toBe(0);
  });
  it('clamps the zoom range to 1..600', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(9999)).toBe(600);
  });
  it('zoomAround keeps the anchor under the same pixel', () => {
    const cur = { pxPerSec: 50, scrollSec: 10 };
    const anchor = 14; // 200 px from the left edge
    const next = zoomAround(cur, 200, anchor);
    expect(next.pxPerSec).toBe(200);
    expect((anchor - next.scrollSec) * next.pxPerSec).toBeCloseTo(200, 6);
    // zooming far out never scrolls negative
    expect(zoomAround({ pxPerSec: 200, scrollSec: 1 }, 1, 2).scrollSec).toBeGreaterThanOrEqual(0);
  });
  it('fitZoom fills the viewport', () => {
    expect(fitZoom(10, 1000, 0)).toBe(100);
    expect(fitZoom(0, 1000)).toBe(60);
    expect(fitZoom(100000, 1000)).toBe(1);
  });
  it('slider mapping is a log round trip', () => {
    for (const px of [1, 7, 60, 333, 600])
      expect(sliderToZoom(zoomToSlider(px))).toBeCloseTo(px, 6);
    expect(zoomToSlider(1)).toBe(0);
    expect(zoomToSlider(600)).toBe(1);
  });
  it('wheel zoom is symmetric and bounded', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 9);
    expect(wheelZoomFactor(1e6)).toBe(wheelZoomFactor(240));
  });
  it('edge auto-scroll speeds up near an edge and is zero in the middle', () => {
    expect(edgeScrollSpeed(500, 0, 1000)).toBe(0);
    expect(edgeScrollSpeed(10, 0, 1000)).toBeLessThan(0);
    expect(edgeScrollSpeed(990, 0, 1000)).toBeGreaterThan(0);
    expect(Math.abs(edgeScrollSpeed(2, 0, 1000))).toBeGreaterThan(
      Math.abs(edgeScrollSpeed(40, 0, 1000)),
    );
  });
});

describe('timecode', () => {
  it('formats MM:SS:FF', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(65.5, 30)).toBe('01:05:15');
    expect(formatTimecode(3600 + 61, 30)).toBe('1:01:01:00');
    expect(formatTimecode(1 / 30, 30)).toBe('00:00:01');
    expect(formatTimecode(NaN, 30)).toBe('00:00:00');
  });
  it('parses what people type', () => {
    expect(parseTimecode('12', 30)).toBe(12);
    expect(parseTimecode('1:05', 30)).toBe(65);
    expect(parseTimecode('01:05:15', 30)).toBeCloseTo(65.5, 6);
    expect(parseTimecode('0:1:2:3', 30)).toBeCloseTo(62.1, 6);
    expect(parseTimecode('', 30)).toBeNull();
    expect(parseTimecode('a:b', 30)).toBeNull();
    expect(parseTimecode('1::2', 30)).toBeNull();
    expect(parseTimecode('-3', 30)).toBeNull();
  });
  it('format -> parse is the identity on frame boundaries', () => {
    for (const t of [0, 1, 7.5, 61.2333333, 599.9666667]) {
      const s = snapToFrame(t, 30);
      expect(parseTimecode(formatTimecode(s, 30), 30)).toBeCloseTo(s, 5);
    }
  });
});

describe('ruler ticks', () => {
  it('keeps labels at least ~84 px apart at every zoom', () => {
    for (const px of [1, 2, 5, 10, 25, 60, 120, 300, 600]) {
      const step = majorStep(px, 30);
      expect(step * px).toBeGreaterThanOrEqual(84);
      const ticks = rulerTicks(px, 0, 600 / px + 5, 30).filter((t) => t.kind === 'major');
      for (let i = 1; i < ticks.length; i++) {
        expect(((ticks[i]?.t ?? 0) - (ticks[i - 1]?.t ?? 0)) * px).toBeGreaterThanOrEqual(83);
      }
    }
  });
  it('shows seconds at normal zoom and frames at high zoom', () => {
    const normal = rulerTicks(50, 0, 30, 30).filter((t) => t.kind === 'major');
    expect(normal[0]?.label).toBe('0:00');
    expect(normal[1]?.label).toMatch(/^0:0[1-9]$|^0:[1-5]\d$/);
    const high = rulerTicks(600, 1, 1.5, 30);
    expect(high.some((t) => t.kind === 'minor')).toBe(true);
    const label = high.find((t) => t.kind === 'major' && t.label)?.label ?? '';
    expect(label.split(':').length).toBe(3); // m:ss:ff
  });
  it('uses minutes and hours when zoomed far out', () => {
    const ticks = rulerTicks(1, 0, 7300, 30).filter((t) => t.kind === 'major');
    expect(
      ticks.some((t) => /^\d+:\d\d:\d\d$/.test(t.label ?? '') && (t.label ?? '').startsWith('1:')),
    ).toBe(true);
  });
  it('is bounded and sorted', () => {
    const ticks = rulerTicks(600, 0, 100000, 60);
    expect(ticks.length).toBeLessThan(7000);
    for (let i = 1; i < ticks.length; i++)
      expect(ticks[i]!.t).toBeGreaterThanOrEqual(ticks[i - 1]!.t);
  });
  it('only emits ticks inside [start, end]', () => {
    const ticks = rulerTicks(80, 12.3, 20.1, 30);
    expect(ticks.every((t) => t.t >= 12.3 - 1e-9 && t.t <= 20.1 + 1e-9)).toBe(true);
  });
});

describe('visible-range culling', () => {
  const items = Array.from({ length: 3000 }, (_, i) => video(`i${i}`, i * 2, 1.5));
  it('finds exactly the items intersecting the window', () => {
    const got = cullItems(items, 100, 110).map((i) => i.id);
    const want = items
      .filter((i) => i.startSec + i.durationSec >= 100 && i.startSec <= 110)
      .map((i) => i.id);
    expect(got).toEqual(want);
    expect(got.length).toBeLessThan(10);
  });
  it('keeps a long item that began long before the window', () => {
    const list = [
      video('long', 0, 500),
      ...Array.from({ length: 50 }, (_, i) => video(`s${i}`, 600 + i, 0.5)),
    ];
    expect(cullItems(list, 300, 310).map((i) => i.id)).toEqual(['long']);
  });
  it('handles empty tracks and windows past the end', () => {
    expect(cullItems([], 0, 10)).toEqual([]);
    expect(cullItems(items, 99999, 100000)).toEqual([]);
  });
  it('matches brute force on random windows', () => {
    for (let k = 0; k < 40; k++) {
      const a = (k * 977) % 6000;
      const b = a + (k % 7) + 0.5;
      expect(cullItems(items, a, b).map((i) => i.id)).toEqual(
        items.filter((i) => i.startSec + i.durationSec >= a && i.startSec <= b).map((i) => i.id),
      );
    }
  });
  it('renderWindow quantises so scrolling a little does not change it', () => {
    const w1 = renderWindow(101, 20);
    const w2 = renderWindow(103, 20);
    expect(w2).toEqual(w1);
    expect(w1.start).toBeLessThanOrEqual(101 - 10);
    expect(w1.end).toBeGreaterThanOrEqual(103 + 20 + 10);
    expect(renderWindow(0, 20).start).toBe(0);
  });
  it('visibleSpan clamps to the window', () => {
    expect(visibleSpan({ startSec: 10, durationSec: 100 }, { start: 20, end: 50 })).toEqual({
      from: 10,
      to: 40,
    });
    expect(visibleSpan({ startSec: 0, durationSec: 5 }, { start: 20, end: 50 })).toBeNull();
    expect(visibleSpan({ startSec: 25, durationSec: 5 }, { start: 20, end: 50 })).toEqual({
      from: 0,
      to: 5,
    });
  });
});

describe('track layout and drop targets', () => {
  const tracks = [
    track('V', 'video'),
    track('S', 'subtitle'),
    track('T', 'text'),
    track('M', 'audio'),
    track('F', 'sfx'),
  ];
  it('puts the highest z-order on top and audio below, in order', () => {
    const order = displayOrder(tracks).map((d) => d.track.id);
    expect(order).toEqual(['T', 'S', 'V', 'M', 'F']);
    expect(displayOrder(tracks).map((d) => d.arrayIndex)).toEqual([2, 1, 0, 3, 4]);
  });
  it('stacks rows with a gap between the visual and audio sections', () => {
    const l = layoutTracks(tracks);
    expect(l.rows.map((r) => r.trackId)).toEqual(['T', 'S', 'V', 'M', 'F']);
    expect(l.rows[0]?.top).toBe(0);
    expect(l.rows[1]?.top).toBe(TRACK_HEIGHT.text);
    expect(l.byId.get('M')?.top).toBe(
      TRACK_HEIGHT.text + TRACK_HEIGHT.subtitle + TRACK_HEIGHT.video + SECTION_GAP,
    );
    expect(l.height).toBe(
      TRACK_HEIGHT.text +
        TRACK_HEIGHT.subtitle +
        TRACK_HEIGHT.video +
        SECTION_GAP +
        TRACK_HEIGHT.audio +
        TRACK_HEIGHT.sfx,
    );
  });
  it('trackAtY is a binary search over rows', () => {
    const l = layoutTracks(tracks);
    expect(trackAtY(l, 0)?.trackId).toBe('T');
    expect(trackAtY(l, TRACK_HEIGHT.text - 0.1)?.trackId).toBe('T');
    expect(trackAtY(l, TRACK_HEIGHT.text)?.trackId).toBe('S');
    const gapY = TRACK_HEIGHT.text + TRACK_HEIGHT.subtitle + TRACK_HEIGHT.video + 2;
    expect(trackAtY(l, gapY)).toBeNull();
    expect(trackAtY(l, -5)).toBeNull();
    expect(trackAtY(l, l.height + 5)).toBeNull();
  });
  it('resolves drop targets: row, gap -> nearest row, below -> new track, above -> none', () => {
    const l = layoutTracks(tracks);
    expect(resolveDropTarget(l, 5)).toMatchObject({ kind: 'track', row: { trackId: 'T' } });
    const gapY = TRACK_HEIGHT.text + TRACK_HEIGHT.subtitle + TRACK_HEIGHT.video + 2;
    expect(resolveDropTarget(l, gapY)).toMatchObject({ kind: 'track', row: { trackId: 'V' } });
    expect(resolveDropTarget(l, l.height + 1)).toEqual({ kind: 'new-track' });
    expect(resolveDropTarget(l, -1)).toEqual({ kind: 'none' });
    expect(resolveDropTarget(layoutTracks([]), 10)).toEqual({ kind: 'new-track' });
  });
  it('chooses a track kind for a dropped asset', () => {
    expect(newTrackKindForAsset('audio')).toBe('audio');
    expect(newTrackKindForAsset('video')).toBe('overlay');
    expect(newTrackKindForAsset('image')).toBe('image');
  });
  it('exposes a header width constant the layout code can rely on', () => {
    expect(HEADER_W).toBeGreaterThan(120);
  });
});

describe('marquee and point hit-testing', () => {
  const tracks = [
    track('V', 'video', [video('a', 0, 4), video('b', 5, 4), video('c', 20, 4)]),
    track('T', 'text', [video('t1', 1, 2)]),
    track('L', 'overlay', [video('locked', 0, 10)], { locked: true }),
  ];
  const layout = layoutTracks(tracks);
  const rowV = layout.byId.get('V')!;
  const rowT = layout.byId.get('T')!;
  it('selects items touched by the rectangle on the covered tracks only', () => {
    const rect = normRect({ x: 3 * 50, y: rowV.top + 3 }, { x: 6 * 50, y: rowV.top + 10 });
    expect(marqueeHits(rect, layout, tracks, 50).sort()).toEqual(['a', 'b']);
  });
  it('spans several tracks vertically', () => {
    const rect = normRect({ x: 0, y: rowT.top + 1 }, { x: 10 * 50, y: rowV.top + 5 });
    expect(marqueeHits(rect, layout, tracks, 50).sort()).toEqual(['a', 'b', 't1']);
  });
  it('skips locked tracks and empty areas', () => {
    const rowL = layout.byId.get('L')!;
    const rect = normRect({ x: 0, y: rowL.top }, { x: 600, y: rowL.top + 5 });
    expect(marqueeHits(rect, layout, tracks, 50)).toEqual([]);
    const empty = normRect({ x: 12 * 50, y: rowV.top }, { x: 15 * 50, y: rowV.top + 5 });
    expect(marqueeHits(empty, layout, tracks, 50)).toEqual([]);
  });
  it('normRect works in any drag direction', () => {
    expect(normRect({ x: 10, y: 20 }, { x: 4, y: 2 })).toEqual({ x0: 4, y0: 2, x1: 10, y1: 20 });
  });
  it('itemAtPoint prefers the topmost item and honours the tolerance', () => {
    const t = track('V', 'video', [video('a', 0, 4), video('b', 3, 4)]);
    expect(itemAtPoint(t, 3.5, 50)?.id).toBe('b');
    expect(itemAtPoint(t, 1, 50)?.id).toBe('a');
    expect(itemAtPoint(t, 8, 50)).toBeNull();
    expect(itemAtPoint(t, 7.05, 50, 4)?.id).toBe('b');
  });
});

describe('snapping', () => {
  const asset: Asset = {
    id: 'm',
    kind: 'audio',
    name: 'Beat',
    source: { kind: 'upload', key: 'k', fileName: 'beat.mp3' },
    durationSec: 30,
    width: null,
    height: null,
    fps: null,
    hasAudio: true,
    beats: [0.5, 1, 1.5, 2],
  };
  const project: Pick<Project, 'tracks' | 'markers' | 'assets'> = {
    tracks: [
      track('V', 'video', [video('a', 2, 3), video('b', 8, 2)]),
      track('M', 'audio', [
        {
          ...(video('m1', 10, 2) as object),
          type: 'audio',
          assetId: 'm',
          inSec: 0,
          speed: 1,
        } as unknown as Item,
      ]),
    ],
    markers: [{ id: 'k', atSec: 6, label: 'x', color: '#F5A524' }],
    assets: [asset],
  };
  it('collects item edges, markers, playhead, start and beats', () => {
    const pts = collectSnapPoints(project, 4);
    const kinds = new Set(pts.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['start', 'playhead', 'marker', 'item', 'beat']));
    expect(
      pts
        .filter((p) => p.kind === 'item')
        .map((p) => p.t)
        .sort((a, b) => a - b),
    ).toEqual([2, 5, 8, 10, 10, 12]);
    // beats are placed on the timeline: item start 10 + beat time
    expect(pts.filter((p) => p.kind === 'beat').map((p) => p.t)).toEqual([10.5, 11, 11.5, 12]);
  });
  it('excludes the dragged item and respects the window', () => {
    const pts = collectSnapPoints(project, 4, { exclude: new Set(['a']), from: 6, to: 11 });
    expect(pts.some((p) => p.t === 2 || p.t === 5)).toBe(false);
    expect(pts.every((p) => p.t >= 6 && p.t <= 11)).toBe(true);
  });
  it('snaps within the threshold and prefers the playhead on ties', () => {
    const pts = collectSnapPoints(project, 5.01);
    expect(snapValue(5.04, pts, 0.1)?.t).toBeCloseTo(5.01);
    expect(snapValue(5.04, pts, 0.1)?.kind).toBe('playhead');
    expect(snapValue(7, pts, 0.1)).toBeNull();
    const tie = snapValue(
      6.5,
      [
        { t: 6, kind: 'item' },
        { t: 7, kind: 'playhead' },
      ],
      1,
    );
    expect(tie?.kind).toBe('playhead');
  });
});

describe('trim clamping', () => {
  const asset = { durationSec: 20 };
  const it0 = video('v', 10, 5, { inSec: 3 });
  it('start trims can grow left only while source remains before inSec', () => {
    expect(clampTrim(it0, asset, 'start', 2, 30)).toEqual({ startSec: 7, durationSec: 8 });
    expect(clampTrim(it0, asset, 'start', 12, 30)).toEqual({ startSec: 12, durationSec: 3 });
  });
  it('start trims cannot pass the end minus one frame', () => {
    const r = clampTrim(it0, asset, 'start', 99, 30);
    expect(r.durationSec).toBeCloseTo(0.04, 6); // schema minimum (0.04 s) wins over one frame at 30 fps
    expect(r.startSec + r.durationSec).toBeCloseTo(15, 6);
  });
  it('end trims cannot pass the end of the source (speed aware)', () => {
    expect(clampTrim(it0, asset, 'end', 100, 30)).toEqual({ startSec: 10, durationSec: 17 });
    const fast = video('f', 10, 5, { inSec: 0, speed: 2 });
    expect(clampTrim(fast, asset, 'end', 100, 30).durationSec).toBe(10);
  });
  it('items without media (text) trim freely, never to zero length', () => {
    const t = { ...(video('t', 4, 2) as object), type: 'text' } as unknown as Item;
    expect(clampTrim(t, null, 'end', 400, 30).durationSec).toBe(396);
    expect(clampTrim(t, null, 'end', 0, 30).durationSec).toBeCloseTo(0.04, 6);
    expect(clampTrim(t, null, 'start', -5, 30).startSec).toBe(0);
  });
});

describe('keyframes', () => {
  const item = video('k', 0, 10, {
    transform: {
      x: {
        v: 0,
        kf: [
          { t: 1, v: 5, ease: 'linear' },
          { t: 4, v: 9, ease: 'linear' },
        ],
      },
      y: { v: 0, kf: [{ t: 1, v: 2, ease: 'linear' }] },
      scale: { v: 1, kf: [] },
      rotation: { v: 0, kf: [] },
      opacity: { v: 1, kf: [] },
    },
    volume: { v: 1, kf: [{ t: 2.5, v: 0.5, ease: 'linear' }] },
  } as Partial<Item>);
  it('collects every animated property, sorted by time', () => {
    const k = collectKeyframes(item);
    expect(k.map((e) => `${e.path}@${e.t}`)).toEqual([
      'transform.x@1',
      'transform.y@1',
      'volume@2.5',
      'transform.x@4',
    ]);
    expect(k[0]).toMatchObject({ path: 'transform.x', index: 0, v: 5 });
  });
  it('groups keyframes on the same time into one diamond', () => {
    const g = groupKeyframes(collectKeyframes(item));
    expect(g.map((x) => x.length)).toEqual([2, 1, 1]);
  });
  it('ignores keyframes beyond the item end', () => {
    const far = video('f', 0, 2, {
      volume: { v: 1, kf: [{ t: 5, v: 1, ease: 'linear' }] },
    } as Partial<Item>);
    expect(collectKeyframes(far)).toEqual([]);
  });
});

describe('labels', () => {
  it('describes an item for screen readers', () => {
    const v = video('v', 3, 9.4, { name: 'Interview', locked: true, groupId: 'g' });
    expect(itemAriaLabel(v, { name: 'asset' }, true)).toBe(
      'Interview, video, 0:03.0 to 0:12.4, locked, grouped, selected',
    );
    expect(
      itemAriaLabel(video('w', 0, 1, { name: undefined }), { name: 'Fallback' }, false),
    ).toContain('Fallback');
  });
  it('gives group ids a stable colour slot', () => {
    expect(groupColorIndex('g_1')).toBe(groupColorIndex('g_1'));
    const slots = new Set(Array.from({ length: 60 }, (_, i) => groupColorIndex(`grp${i}`)));
    expect(slots.size).toBeGreaterThan(3);
    for (const s of slots) expect(s).toBeLessThan(6);
  });
});

describe('transition drop target', () => {
  const clips = track('V', 'video', [video('a', 0, 4), video('b', 4, 4), video('c', 10, 2)]);
  it('left half joins the previous clip, right half the next', () => {
    expect(resolveTransitionTarget(clips, 4.5, 50)?.target.id).toBe('b');
    expect(resolveTransitionTarget(clips, 4.5, 50)?.previous.id).toBe('a');
    expect(resolveTransitionTarget(clips, 3.5, 50)?.target.id).toBe('b'); // right half of a -> next (b)
    expect(resolveTransitionTarget(clips, 3.5, 50)?.previous.id).toBe('a');
  });
  it('the first and last clips fall back to their only neighbour', () => {
    expect(resolveTransitionTarget(clips, 0.5, 50)?.target.id).toBe('b');
    // right half of b joins b with the next clip c, even across a gap (the store closes the gap by overlapping)
    expect(resolveTransitionTarget(clips, 7.5, 50)?.target.id).toBe('c');
    // the last clip has no successor, so it blends with its predecessor
    expect(resolveTransitionTarget(clips, 11.5, 50)?.target.id).toBe('c');
    expect(resolveTransitionTarget(clips, 11.5, 50)?.previous.id).toBe('b');
  });
  it('needs a neighbour and a picture clip', () => {
    const lone = track('V', 'video', [video('x', 0, 4)]);
    expect(resolveTransitionTarget(lone, 1, 50)).toBeNull();
    expect(resolveTransitionTarget(clips, 9, 50)).toBeNull(); // empty space
    const text = track('T', 'text', [
      { ...(video('t1', 0, 2) as object), type: 'text' } as unknown as Item,
      { ...(video('t2', 2, 2) as object), type: 'text' } as unknown as Item,
    ]);
    expect(resolveTransitionTarget(text, 1, 50)).toBeNull();
  });
});
