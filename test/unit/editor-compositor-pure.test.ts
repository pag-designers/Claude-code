import { afterEach, describe, expect, it } from 'vitest';
import {
  assetSchema,
  imageItemSchema,
  projectSchema,
  shapeItemSchema,
  textItemSchema,
  trackSchema,
  videoItemSchema,
} from '@shared/editor';
import { computeDrag } from '../../renderer/lib/editor/compositor/drag';
import { parseCube } from '../../renderer/lib/editor/compositor/cube';
import {
  geomBounds,
  geomContains,
  geomCorners,
  rotationHandlePoint,
  type Geom,
} from '../../renderer/lib/editor/compositor/geometry';
import { layoutText, setTextMeasurer } from '../../renderer/lib/editor/compositor/text-layout';
import { measureTextItem } from '../../renderer/lib/editor/compositor/compositor';
import {
  framesNeededAt,
  interactionLayers,
  buildScene,
} from '../../renderer/lib/editor/compositor/scene';
import type { DragInput } from '../../renderer/lib/editor/compositor/api';

const base: DragInput = {
  kind: 'move',
  start: { x: 100, y: 100 },
  current: { x: 100, y: 100 },
  initial: { x: 0, y: 0, scale: 1, rotation: 0 },
  previewScale: 0.5,
  rectW: 400,
  rectH: 200,
  canvasW: 1080,
  canvasH: 1920,
  shift: false,
  alt: false,
  snapPx: 0,
};
const drag = (o: Partial<DragInput>) => computeDrag({ ...base, ...o });

describe('computeDrag — move', () => {
  it('converts the preview-px delta to canvas px', () => {
    const r = drag({ current: { x: 130, y: 90 } });
    expect(r.x).toBeCloseTo(60, 9);
    expect(r.y).toBeCloseTo(-20, 9);
    expect(r.guides).toEqual([]);
  });
  it('shift locks to the dominant axis', () => {
    const r = drag({ current: { x: 130, y: 110 }, shift: true });
    expect(r).toMatchObject({ x: 60, y: 0 });
    const r2 = drag({ current: { x: 110, y: 160 }, shift: true });
    expect(r2).toMatchObject({ x: 0, y: 120 });
  });
  it('snaps the centre to the canvas centre lines and reports guides', () => {
    // 6 preview px from the centre, snapPx 8 → snaps; each axis independently
    const r = drag({
      current: { x: 106, y: 190 },
      initial: { x: 0, y: 0, scale: 1, rotation: 0 },
      snapPx: 8,
    });
    expect(r.x).toBe(0);
    expect(r.guides).toContainEqual({ x: 540 });
    expect(r.y).toBe(180); // 90 preview px = 180 canvas px: not near anything
    // out of range → untouched
    const r2 = drag({ current: { x: 130, y: 140 }, snapPx: 8 });
    expect(r2.x).toBe(60);
    expect(r2.guides).toEqual([]);
  });
  it('snaps edges flush with the canvas edges (rotated bounding box)', () => {
    // 400×200 rect rotated 90° has half extents 100 × 200; left edge flush at x = -540 + 100
    const r = drag({
      initial: { x: -430, y: 0, scale: 1, rotation: 90 },
      current: { x: 100, y: 100 },
      snapPx: 10,
    });
    expect(r.x).toBeCloseTo(-440, 6);
    expect(r.guides).toContainEqual({ x: 0 });
    // y 0 is also the centre
    expect(r.guides).toContainEqual({ y: 960 });
  });
});

describe('computeDrag — scale', () => {
  const corner = (g: Geom, i: number) => geomCorners(g)[i]!;
  it('SE handle: uniform scale about the centre by the diagonal projection', () => {
    // centre (540, 960) canvas = (270, 480) preview; SE corner at +200,+100 canvas = +100,+50 preview
    const start = { x: 270 + 100, y: 480 + 50 };
    const r = computeDrag({
      ...base,
      kind: 'scale-se',
      start,
      current: { x: 270 + 200, y: 480 + 100 },
    });
    expect(r.scale).toBeCloseTo(2, 9);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it('shift has no effect (uniform only)', () => {
    const a = computeDrag({
      ...base,
      kind: 'scale-ne',
      start: { x: 370, y: 430 },
      current: { x: 420, y: 400 },
    });
    const b = computeDrag({
      ...base,
      kind: 'scale-ne',
      start: { x: 370, y: 430 },
      current: { x: 420, y: 400 },
      shift: true,
    });
    expect(a).toEqual(b);
  });
  it('alt anchors the opposite corner', () => {
    const initial = { x: 40, y: -30, scale: 1.5, rotation: 25 };
    const g0: Geom = { cx: 540 + 40, cy: 960 - 30, hw: 300, hh: 150, rot: 25 };
    const nw0 = corner(g0, 0);
    const se0 = corner(g0, 2);
    const ps = 0.5;
    const start = { x: se0.x * ps, y: se0.y * ps };
    const current = {
      x: nw0.x * ps + (se0.x - nw0.x) * ps * 1.4,
      y: nw0.y * ps + (se0.y - nw0.y) * ps * 1.4,
    };
    const r = computeDrag({ ...base, kind: 'scale-se', initial, start, current, alt: true });
    expect(r.scale).toBeCloseTo(1.5 * 1.4, 9);
    const g1: Geom = {
      cx: 540 + r.x,
      cy: 960 + r.y,
      hw: 200 * r.scale,
      hh: 100 * r.scale,
      rot: 25,
    };
    expect(corner(g1, 0).x).toBeCloseTo(nw0.x, 6);
    expect(corner(g1, 0).y).toBeCloseTo(nw0.y, 6);
  });
  it('clamps to a minimum and ignores pointer jitter through the centre', () => {
    const r = computeDrag({
      ...base,
      kind: 'scale-se',
      start: { x: 370, y: 530 },
      current: { x: 100, y: 100 },
    });
    expect(r.scale).toBeGreaterThan(0);
    expect(r.scale).toBeLessThanOrEqual(0.02 + 1e-12);
  });
});

describe('computeDrag — rotate', () => {
  const c = { x: 270, y: 480 };
  it('is clockwise on screen (y down)', () => {
    // pointer from the right of the centre to below it = +90°
    const r = computeDrag({
      ...base,
      kind: 'rotate',
      start: { x: c.x + 100, y: c.y },
      current: { x: c.x, y: c.y + 100 },
    });
    expect(r.rotation).toBeCloseTo(90, 9);
  });
  it('adds to the initial rotation and takes the short way round', () => {
    const r = computeDrag({
      ...base,
      kind: 'rotate',
      initial: { x: 0, y: 0, scale: 1, rotation: 170 },
      start: { x: c.x - 100, y: c.y - 5 },
      current: { x: c.x - 100, y: c.y + 5 },
    });
    // left of the centre, moving down = counter-clockwise on screen, and the ±180° wrap does not jump
    expect(r.rotation).toBeLessThan(170);
    expect(r.rotation).toBeGreaterThan(160);
  });
  it('shift snaps the absolute angle to 15°', () => {
    const r = computeDrag({
      ...base,
      kind: 'rotate',
      shift: true,
      initial: { x: 0, y: 0, scale: 1, rotation: 3 },
      start: { x: c.x + 100, y: c.y },
      current: { x: c.x + 100, y: c.y + 30 }, // ≈ 16.7° → 3 + 16.7 = 19.7 → 15
    });
    expect(r.rotation).toBe(15);
  });
});

describe('parseCube', () => {
  const cube2 = [
    '# comment',
    'TITLE "x"',
    'LUT_3D_SIZE 2',
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '1 1 0',
    '0 0 1',
    '1 0 1',
    '0 1 1',
    '1 1 1',
  ].join('\r\n');
  it('parses an identity LUT with red fastest', () => {
    const l = parseCube(cube2);
    expect(l.size).toBe(2);
    expect(l.data).toBeInstanceOf(Float32Array);
    expect(Array.from(l.data)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
    ]);
  });
  it('validates', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/expected 8 entries/);
    expect(() => parseCube('0 0 0')).toThrow(/missing LUT_3D_SIZE/);
    expect(() => parseCube('LUT_3D_SIZE 66')).toThrow(/2\.\.65/);
    expect(() => parseCube('LUT_3D_SIZE 1')).toThrow();
    expect(() => parseCube('LUT_1D_SIZE 16')).toThrow(/1D/);
    expect(() => parseCube('LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2')).toThrow(/domain/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x')).toThrow(/bad number/);
    expect(() => parseCube('FOO 1')).toThrow(/unknown keyword/);
  });
  it('accepts the maximum size 65', () => {
    const n = 65;
    const body = Array.from({ length: n ** 3 }, () => '0.5 0.5 0.5').join('\n');
    expect(parseCube(`LUT_3D_SIZE ${n}\n${body}`).data.length).toBe(n ** 3 * 3);
  });
});

describe('geometry / hit-test maths', () => {
  const g: Geom = { cx: 200, cy: 300, hw: 100, hh: 50, rot: 90 };
  it('contains() respects rotation', () => {
    expect(geomContains(g, 200, 380)).toBe(true); // 80 below the centre: inside the rotated (now tall) rect
    expect(geomContains(g, 280, 300)).toBe(false); // 80 to the right: outside
    expect(geomContains(g, 200, 405)).toBe(false);
    expect(geomContains(g, 200, 405, 6)).toBe(true);
  });
  it('corners run clockwise from the rect’s own top-left', () => {
    const c = geomCorners({ cx: 0, cy: 0, hw: 10, hh: 5, rot: 0 });
    expect(c).toEqual([
      { x: -10, y: -5 },
      { x: 10, y: -5 },
      { x: 10, y: 5 },
      { x: -10, y: 5 },
    ]);
    const r = geomCorners({ cx: 0, cy: 0, hw: 10, hh: 5, rot: 90 });
    expect(r[0]!.x).toBeCloseTo(5, 9); // own top-left (-10,-5) rotated 90° cw → (5,-10)
    expect(r[0]!.y).toBeCloseTo(-10, 9);
  });
  it('bounds and rotation handle', () => {
    expect(geomBounds(g).hx).toBeCloseTo(50, 9);
    expect(geomBounds(g).hy).toBeCloseTo(100, 9);
    const h = rotationHandlePoint({ cx: 100, cy: 100, hw: 30, hh: 20, rot: 0 }, 1, 28);
    expect(h).toEqual({ x: 100, y: 100 - 20 - 28 });
  });
});

/* ------------------------------------------------------------------ text layout ------------------ */

const fixed = (t: string, s: { size: number }) => Array.from(t).length * s.size * 0.5; // 0.5 em per char
afterEach(() => setTextMeasurer(null));
const style = (over: Record<string, unknown> = {}) =>
  textItemSchema.parse({
    type: 'text',
    id: 'x',
    text: '',
    startSec: 0,
    durationSec: 1,
    style: { size: 20, ...over },
  }).style;

describe('text layout', () => {
  it('wraps greedily at maxWidth, keeps explicit breaks and indices', () => {
    const l = layoutText('aa bb cc\ndd', style({ maxWidth: 60 }), 1000, fixed); // 6 chars = 60px
    expect(l.lines.map((x) => x.text)).toEqual(['aa bb', 'cc', 'dd']);
    expect(l.lines.map((x) => [x.start, x.end])).toEqual([
      [0, 5],
      [6, 8],
      [9, 11],
    ]);
    expect(l.contentWidth).toBe(50);
    expect(l.height).toBeCloseTo(3 * 1.15 * 20, 9);
  });
  it('default wrap width is 80 % of the canvas; an over-long word stays whole', () => {
    const l = layoutText('abcdefghijklmnopqrstuvwxyz zz', style(), 100, fixed); // wrap 80 px, word = 260 px
    expect(l.lines.map((x) => x.text)).toEqual(['abcdefghijklmnopqrstuvwxyz', 'zz']);
  });
  it('letter spacing adds after every glyph; box padding grows the rect', () => {
    const l = layoutText(
      'abcd',
      style({ letterSpacing: 3, box: { color: '#000000', opacity: 1, padding: 10, radius: 0 } }),
      1000,
      fixed,
    );
    expect(l.contentWidth).toBe(4 * 10 + 4 * 3);
    expect(l.width).toBe(l.contentWidth + 20);
    expect(l.height).toBeCloseTo(1.15 * 20 + 20, 9);
  });
  it('blank lines and trailing newline are kept; spaces collapse at wraps only', () => {
    expect(layoutText('a\n\nb', style(), 1000, fixed).lines.map((x) => x.text)).toEqual([
      'a',
      '',
      'b',
    ]);
    expect(layoutText('a\n', style(), 1000, fixed).lines.map((x) => x.text)).toEqual(['a', '']);
    expect(layoutText('a  b', style(), 1000, fixed).lines[0]!.text).toBe('a  b');
  });
  it('measureTextItem uses the active measurer', () => {
    setTextMeasurer(fixed);
    const item = textItemSchema.parse({
      type: 'text',
      id: 't',
      text: 'hello world',
      startSec: 0,
      durationSec: 1,
      style: { size: 40, maxWidth: 150 },
    });
    const m = measureTextItem(item, 1080);
    expect(m.lines).toEqual(['hello', 'world']);
    expect(m.width).toBe(100);
    expect(m.height).toBeCloseTo(2 * 1.15 * 40, 9);
    expect(
      measureTextItem(
        imageItemSchema.parse({
          type: 'image',
          id: 'i',
          assetId: 'a',
          startSec: 0,
          durationSec: 1,
        }),
        1080,
      ),
    ).toEqual({ width: 0, height: 0, lines: [] });
  });
});

/* ------------------------------------------------------------------ scene / frames ---------------- */

const asset = (id: string, w = 1920, h = 1080, kind: 'video' | 'image' = 'video', dur = 10) =>
  assetSchema.parse({
    id,
    kind,
    name: id,
    source: { kind: 'upload', key: id, fileName: id },
    width: w,
    height: h,
    durationSec: kind === 'video' ? dur : null,
  });

describe('framesNeededAt / scene', () => {
  const proj = (items: unknown[], extraTracks: unknown[] = []) =>
    projectSchema.parse({
      canvas: { width: 1080, height: 1920 },
      assets: [asset('a'), asset('b', 1920, 1080, 'video', 8), asset('img', 400, 400, 'image')],
      tracks: [trackSchema.parse({ id: 'v', kind: 'video', name: 'v', items }), ...extraTracks],
    });
  const idx = (p: ReturnType<typeof proj>) => new Map(p.assets.map((a) => [a.id, a]));
  const vid = (id: string, assetId: string, startSec: number, durationSec: number, extra = {}) =>
    videoItemSchema.parse({ type: 'video', id, assetId, startSec, durationSec, ...extra });

  it('maps timeline → SOURCE time with speed, reverse, freeze, ramps and clamping', () => {
    const p = proj([vid('x', 'a', 2, 4, { inSec: 1, speed: 2 })]);
    expect(framesNeededAt(p, idx(p), 3)).toEqual([
      { assetId: 'a', srcSec: 1 + 2 * 1, itemId: 'x' },
    ]);
    const rev = proj([vid('x', 'a', 0, 4, { inSec: 1, reverse: true })]);
    expect(framesNeededAt(rev, idx(rev), 1)[0]!.srcSec).toBeCloseTo(1 + 4 - 1, 9);
    const fr = proj([vid('x', 'a', 0, 4, { freezeAtSec: 3.25 })]);
    expect(framesNeededAt(fr, idx(fr), 2)[0]!.srcSec).toBe(3.25);
    const ramp = proj([
      vid('x', 'a', 0, 4, {
        speedCurve: [
          { t: 0, v: 1 },
          { t: 4, v: 3 },
        ],
      }),
    ]);
    // ∫ (1 + t/2) dt from 0 to 2 = 2 + 1 = 3
    expect(framesNeededAt(ramp, idx(ramp), 2)[0]!.srcSec).toBeCloseTo(3, 2);
    const clamp = proj([vid('x', 'a', 0, 4, { inSec: 9, speed: 4 })]);
    expect(framesNeededAt(clamp, idx(clamp), 2)[0]!.srcSec).toBe(10);
  });
  it('two frames during a transition overlap, none for images/hidden tracks/audio', () => {
    const p = proj([
      vid('x', 'a', 0, 2),
      vid('y', 'b', 1.5, 3, { transitionIn: { type: 'crossfade', durationSec: 0.5 } }),
    ]);
    expect(framesNeededAt(p, idx(p), 1.7).map((f) => f.itemId)).toEqual(['x', 'y']);
    expect(framesNeededAt(p, idx(p), 1.4).map((f) => f.itemId)).toEqual(['x']);
    const img = proj([
      imageItemSchema.parse({
        type: 'image',
        id: 'i',
        assetId: 'img',
        startSec: 0,
        durationSec: 2,
      }),
    ]);
    expect(framesNeededAt(img, idx(img), 1)).toEqual([]);
  });
  it('geometry: cover / contain / transform / ops follow the shared rules', () => {
    const items = [
      vid('x', 'a', 0, 4, {
        fit: 'contain',
        transform: { x: { v: 100 }, scale: { v: 0.5 }, rotation: { v: 10 } },
      }),
    ];
    const p = proj(items);
    const env = { project: p, assets: idx(p), captionStyles: [] };
    const [g] = buildScene(env, 1);
    const l = g!.layers[0]!;
    // 1920×1080 contained in 1080×1920 → 1080×607.5; scale .5
    expect(l.geom.hw).toBeCloseTo(270, 6);
    expect(l.geom.hh).toBeCloseTo(151.875, 6);
    expect(l.geom.cx).toBeCloseTo(640, 6);
    expect(l.geom.cy).toBeCloseTo(960, 6);
    expect(l.geom.rot).toBe(10);
  });
  it('transition ops move whole layers about the canvas centre; interaction geometry ignores them', () => {
    const p = proj([
      vid('x', 'a', 0, 2),
      vid('y', 'a', 1.5, 3, { transitionIn: { type: 'slide-left', durationSec: 0.5 } }),
    ]);
    const env = { project: p, assets: idx(p), captionStyles: [] };
    const g = buildScene(env, 1.75)[0]!;
    // p = .5 → from dx −.5·1080, to dx +.5·1080
    expect(g.layers[0]!.geom.cx).toBeCloseTo(540 - 540, 6);
    expect(g.layers[1]!.geom.cx).toBeCloseTo(540 + 540, 6);
    const il = interactionLayers(env, 1.75);
    expect(il[0]!.item.id).toBe('y');
    expect(il[0]!.geom.cx).toBeCloseTo(540, 6);
  });
  it('text animations feed position / scale / opacity from textAnimAt', () => {
    setTextMeasurer(fixed);
    const t = textItemSchema.parse({
      type: 'text',
      id: 't',
      text: 'hi',
      startSec: 0,
      durationSec: 4,
      animIn: { type: 'slide', durationSec: 1 },
      animOut: { type: 'scale', durationSec: 1 },
      style: { size: 40 },
    });
    const p = projectSchema.parse({
      canvas: { width: 1080, height: 1920 },
      assets: [],
      tracks: [trackSchema.parse({ id: 'x', kind: 'text', name: 'x', items: [t] })],
    });
    const env = { project: p, assets: new Map(), captionStyles: [] };
    const at = (s: number) => buildScene(env, s)[0]!.layers[0]!;
    // slide-in: u = 0 → dy = +8 % of the canvas height, opacity 0; u = 1 → settled
    expect(at(0).geom.cy).toBeCloseTo(960 + 0.08 * 1920, 6);
    expect(at(0).opacity).toBeCloseTo(0, 9);
    expect(at(1.5).geom.cy).toBeCloseTo(960, 6);
    expect(at(1.5).opacity).toBe(1);
    // scale-out: last second, scale .6 + .4·ease at u→0 (just before the end)
    expect(at(3.999).scaleK).toBeCloseTo(0.6, 2);
    expect(at(3.999).opacity).toBeCloseTo(0, 2);
  });
  it('typewriter reveals ceil(n·u) code points', () => {
    setTextMeasurer(fixed);
    const t = textItemSchema.parse({
      type: 'text',
      id: 't',
      text: 'abcdefgh',
      startSec: 0,
      durationSec: 4,
      animIn: { type: 'typewriter', durationSec: 2 },
    });
    const p = projectSchema.parse({
      canvas: { width: 1080, height: 1920 },
      assets: [],
      tracks: [trackSchema.parse({ id: 'x', kind: 'text', name: 'x', items: [t] })],
    });
    const env = { project: p, assets: new Map(), captionStyles: [] };
    const n = (s: number) =>
      (buildScene(env, s)[0]!.layers[0]!.content as { nVisible: number }).nVisible;
    expect(n(0.5)).toBe(2);
    expect(n(1)).toBe(4);
    expect(n(1.01)).toBe(5);
    expect(n(3)).toBe(Infinity);
  });
  it('z-order: later tracks on top; hidden skipped; hit-test order', () => {
    const p = proj(
      [vid('x', 'a', 0, 4)],
      [
        trackSchema.parse({
          id: 'o',
          kind: 'overlay',
          name: 'o',
          items: [
            shapeItemSchema.parse({
              type: 'shape',
              id: 's',
              shape: 'rect',
              startSec: 0,
              durationSec: 4,
              width: 100,
              height: 100,
            }),
          ],
        }),
        trackSchema.parse({
          id: 'h',
          kind: 'overlay',
          name: 'h',
          hidden: true,
          items: [
            shapeItemSchema.parse({
              type: 'shape',
              id: 'hid',
              shape: 'rect',
              startSec: 0,
              durationSec: 4,
            }),
          ],
        }),
      ],
    );
    const env = { project: p, assets: idx(p), captionStyles: [] };
    expect(interactionLayers(env, 1).map((l) => l.item.id)).toEqual(['s', 'x']);
  });
});
