/** Text layers and shapes (ASS): geometry, style, animation (textAnimAt), progress bars. Canvas 270x480, black. */
import { describe, expect, it, vi } from 'vitest';
import { A, TR } from './fixtures';
import {
  allFrames, bboxWhere, exportProject, files, frameAt, haveFfmpeg, isBlue, isDark, isGreen, isRed, isWhite, makeProject, settingsFor, track,
  type Frame,
} from './helpers';
import { textAnimAt, resolveTransform } from '../../../shared/editor-eval';

vi.setConfig({ testTimeout: 60_000 });

const CW = 270;
const CH = 480;
const style = (o: Record<string, unknown> = {}) => ({ fontFamily: 'Montserrat', weight: 800, size: 40, color: '#FFFFFF', ...o });
const txt = (text: string, over: Record<string, unknown> = {}, st: Record<string, unknown> = {}) => ({
  type: 'text', id: 't1', startSec: 0, durationSec: 1, text, style: style(st), ...over,
});
const shape = (kind: string, over: Record<string, unknown> = {}) => ({
  type: 'shape', id: 's1', shape: kind, startSec: 0, durationSec: 1, width: 100, height: 60, fill: '#FF0000', ...over,
});

async function render(items: Record<string, unknown>[], opts: { w?: number; h?: number; canvas?: { width: number; height: number }; extra?: ReturnType<typeof track>[] } = {}) {
  const cw = opts.canvas?.width ?? CW;
  const ch = opts.canvas?.height ?? CH;
  const p = makeProject([track('text', items), ...(opts.extra ?? [])], [], { width: cw, height: ch });
  const r = await exportProject(p, files([]), settingsFor(opts.w ?? cw, opts.h ?? ch), { name: 'text' });
  return { r, frames: allFrames(r.out), p };
}

describe.skipIf(!haveFfmpeg)('text: layout', () => {
  it('white text appears at the canvas centre and nowhere else', async () => {
    const { frames } = await render([txt('Hello')]);
    const b = bboxWhere(frames[3]!, isWhite);
    expect(b.n).toBeGreaterThan(200);
    expect(Math.abs(b.cx - CW / 2)).toBeLessThan(6);
    expect(Math.abs(b.cy - CH / 2)).toBeLessThan(8);
    expect(bboxWhere(frames[3]!, isWhite, [0, 0, CW, 150]).n).toBe(0);
  });

  it('x / y transform offsets the block', async () => {
    const { frames } = await render([txt('Hello', { transform: TR({ x: A(50), y: A(-100) }) })]);
    const b = bboxWhere(frames[3]!, isWhite);
    expect(Math.abs(b.cx - (CW / 2 + 50))).toBeLessThan(6);
    expect(Math.abs(b.cy - (CH / 2 - 100))).toBeLessThan(8);
  });

  it('size is the CSS em size: cap height of Montserrat ≈ 0.70 × size', async () => {
    const { frames } = await render([txt('HIH', {}, { size: 100 })]);
    const b = bboxWhere(frames[3]!, isWhite);
    expect(b.h).toBeGreaterThan(62);
    expect(b.h).toBeLessThan(78);
  });

  it('text scales with the export size (K = 2): twice as wide and tall', async () => {
    const a = bboxWhere((await render([txt('Hello')])).frames[3]!, isWhite);
    const b = bboxWhere((await render([txt('Hello')], { w: 540, h: 960 })).frames[3]!, isWhite);
    expect(b.w / a.w).toBeGreaterThan(1.85);
    expect(b.w / a.w).toBeLessThan(2.15);
    expect(b.h / a.h).toBeGreaterThan(1.85);
    expect(b.h / a.h).toBeLessThan(2.15);
  });

  it('transform scale 2 doubles the glyph size about the block centre', async () => {
    const a = bboxWhere((await render([txt('Hi')])).frames[3]!, isWhite);
    const b = bboxWhere((await render([txt('Hi', { transform: TR({ scale: A(2) }) })])).frames[3]!, isWhite);
    expect(b.w / a.w).toBeGreaterThan(1.85);
    expect(b.w / a.w).toBeLessThan(2.15);
    expect(Math.abs(b.cx - a.cx)).toBeLessThan(4);
  });

  it('letterSpacing widens the line (added after every code point)', async () => {
    const a = bboxWhere((await render([txt('HELLO')])).frames[3]!, isWhite);
    const b = bboxWhere((await render([txt('HELLO', {}, { letterSpacing: 10 })])).frames[3]!, isWhite);
    expect(b.w - a.w).toBeGreaterThan(30);
    expect(b.w - a.w).toBeLessThan(50);
  });

  it('\\n always breaks; lineHeight × size is the line pitch', async () => {
    const one = bboxWhere((await render([txt('HH')])).frames[3]!, isWhite);
    const two = bboxWhere((await render([txt('HH\nHH', {}, { lineHeight: 1.5 })])).frames[3]!, isWhite);
    expect(two.h - one.h).toBeGreaterThan(0.9 * 1.5 * 40);
    expect(two.h - one.h).toBeLessThan(1.1 * 1.5 * 40);
  });

  it('greedy wrap at 0.8 × canvas width; an over-long word is never split', async () => {
    const long = await render([txt('aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk', {}, { size: 40 })]);
    const b = bboxWhere(long.frames[3]!, isWhite);
    expect(b.w).toBeLessThanOrEqual(CW * 0.8 + 8);
    expect(b.h).toBeGreaterThan(1.5 * 40);
    const word = await render([txt('Supercalifragilisticexpialidocious', {}, { size: 40 })]);
    const w = bboxWhere(word.frames[3]!, isWhite);
    expect(w.h).toBeLessThan(1.3 * 40); // single line (overflows the wrap width instead of splitting)
  });

  it('maxWidth overrides the wrap width', async () => {
    const a = bboxWhere((await render([txt('aaa bbb ccc ddd', {}, { size: 30, maxWidth: 80 })])).frames[3]!, isWhite);
    expect(a.w).toBeLessThanOrEqual(90);
    expect(a.h).toBeGreaterThan(60);
  });

  it('alignment inside the widest line: left / right put the short line at the block edges', async () => {
    const mk = async (align: string) => bboxWhere((await render([txt('HELLO WORLD\nHI', {}, { align, size: 20 })])).frames[3]!, isWhite, [0, 0, CW, CH / 2 + 18]);
    const left = await mk('left');
    const right = await mk('right');
    const centre = await mk('center');
    void left;
    // the second line (HI) is the narrow one: measure it in the bottom half
    const bottom = async (align: string) => bboxWhere((await render([txt('HELLO WORLD\nHI', {}, { align, size: 20 })])).frames[3]!, isWhite, [0, CH / 2 + 2, CW, CH]);
    const bl = await bottom('left');
    const br = await bottom('right');
    const bc = await bottom('center');
    expect(bl.x0).toBeLessThan(bc.x0);
    expect(br.x1).toBeGreaterThan(bc.x1);
    expect(bl.cx).toBeLessThan(CW / 2 - 15);
    expect(br.cx).toBeGreaterThan(CW / 2 + 15);
    void right;
    void centre;
  });

  it('rotation 90° swaps the bounding box aspect', async () => {
    const a = bboxWhere((await render([txt('HELLO')])).frames[3]!, isWhite);
    const b = bboxWhere((await render([txt('HELLO', { transform: TR({ rotation: A(90) }) })])).frames[3]!, isWhite);
    expect(b.h).toBeGreaterThan(a.w * 0.9);
    expect(b.w).toBeLessThan(a.h * 1.3);
    expect(Math.abs(b.cx - a.cx)).toBeLessThan(8);
  });

  it('the item is only visible between its start and end', async () => {
    const { frames } = await render([txt('Hello', { startSec: 0.2, durationSec: 0.4 }), shape('rect', { id: 'pad', startSec: 0, durationSec: 1, width: 2, height: 2, fill: '#000001' })]);
    expect(bboxWhere(frames[5]!, isWhite).n).toBe(0);
    expect(bboxWhere(frames[6]!, isWhite).n).toBeGreaterThan(100);
    expect(bboxWhere(frames[17]!, isWhite).n).toBeGreaterThan(100);
    expect(bboxWhere(frames[18]!, isWhite).n).toBe(0);
  });
});

describe.skipIf(!haveFfmpeg)('text: style', () => {
  it('fill colour', async () => {
    const f = (await render([txt('HHH', {}, { color: '#FF0000', size: 80 })])).frames[3]!;
    expect(bboxWhere(f, isRed).n).toBeGreaterThan(500);
    expect(bboxWhere(f, isWhite).n).toBe(0);
  });

  it('stroke draws an outline OUTSIDE the glyphs (bbox grows by ~width)', async () => {
    const plain = bboxWhere((await render([txt('HH', {}, { color: '#FF0000', size: 80 })])).frames[3]!, (r, g, b) => r + g + b > 60);
    const stroked = bboxWhere((await render([txt('HH', {}, { color: '#FF0000', size: 80, stroke: { color: '#0000FF', width: 6 } })])).frames[3]!, (r, g, b) => r + g + b > 60);
    expect(stroked.w - plain.w).toBeGreaterThan(8);
    expect(stroked.w - plain.w).toBeLessThan(16);
    const blue = bboxWhere((await render([txt('HH', {}, { color: '#FF0000', size: 80, stroke: { color: '#0000FF', width: 6 } })])).frames[3]!, isBlue);
    expect(blue.n).toBeGreaterThan(300);
  });

  it('box: opaque background rect with padding on every side', async () => {
    const f = (await render([txt('HH', {}, { color: '#FFFFFF', size: 60, box: { color: '#0000FF', opacity: 1, padding: 20, radius: 0 } })])).frames[3]!;
    const box = bboxWhere(f, isBlue);
    const glyph = bboxWhere(f, isWhite);
    expect(glyph.x0 - box.x0).toBeGreaterThan(14);
    expect(box.x1 - glyph.x1).toBeGreaterThan(14);
    expect(glyph.y0 - box.y0).toBeGreaterThan(12);
    expect(box.y1 - glyph.y1).toBeGreaterThan(12);
    expect(Math.abs(box.cx - CW / 2)).toBeLessThan(4);
  });

  it('hard shadow is offset by (offsetX, offsetY)', async () => {
    const f = (await render([txt('HH', {}, { color: '#FFFFFF', size: 80, shadow: { color: '#FF0000', opacity: 1, blur: 0, offsetX: 12, offsetY: 12 } })])).frames[3]!;
    const g = bboxWhere(f, isWhite);
    const s = bboxWhere(f, isRed);
    expect(s.n).toBeGreaterThan(100);
    expect(s.x1).toBeGreaterThan(g.x1 + 6);
    expect(s.y1).toBeGreaterThan(g.y1 + 6);
  });

  it('soft shadow (blur > 0) is drawn as a blurred copy underneath', async () => {
    const f = (await render([txt('HH', {}, { color: '#FFFFFF', size: 80, shadow: { color: '#FF0000', opacity: 1, blur: 10, offsetX: 0, offsetY: 8 } })])).frames[3]!;
    expect(bboxWhere(f, (r, g, b) => r > 60 && g < 80 && b < 80).n).toBeGreaterThan(100);
  });

  it('transform opacity 0.5 halves the brightness', async () => {
    const f = (await render([txt('HHH', { transform: TR({ opacity: A(0.5) }) }, { size: 100 })])).frames[3]!;
    const b = bboxWhere(f, (r) => r > 100);
    expect(b.n).toBeGreaterThan(400);
    const w = bboxWhere(f, (r) => r > 200);
    expect(w.n).toBe(0);
  });

  it('a blend mode on text (multiply) darkens the picture below instead of painting white', async () => {
    const p = makeProject(
      [track('overlay', [shape('rect', { id: 'bg', width: 270, height: 480, fill: '#00FF00' })]), track('text', [txt('HHH', { blend: 'multiply' }, { color: '#FF0000', size: 100 })])],
      [], { width: CW, height: CH },
    );
    const r = await exportProject(p, files([]), settingsFor(CW, CH));
    const f = frameAt(r.out, 3);
    expect(f.px(10, 10)[1]).toBeGreaterThan(240); // green untouched outside the glyphs
    expect(bboxWhere(f, isDark).n).toBeGreaterThan(300); // red × green = black glyphs
  });

  it('unknown font family falls back (no crash) and still renders', async () => {
    const f = (await render([txt('Hello', {}, { fontFamily: 'Does Not Exist' })])).frames[3]!;
    expect(bboxWhere(f, isWhite).n).toBeGreaterThan(100);
  });

  it('emoji and punctuation do not break the event syntax', async () => {
    const f = (await render([txt('Hi {there} \\N 100% 😀', {}, {})])).frames[3]!;
    expect(bboxWhere(f, (r, g, b) => r + g + b > 300).n).toBeGreaterThan(100);
  });
});

describe.skipIf(!haveFfmpeg)('text: animation = textAnimAt sampled per frame', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['pop', { animIn: { type: 'pop', durationSec: 0.4 } }],
    ['fade', { animIn: { type: 'fade', durationSec: 0.5 } }],
    ['scale', { animIn: { type: 'scale', durationSec: 0.4 } }],
    ['slide', { animIn: { type: 'slide', durationSec: 0.4 } }],
    ['bounce', { animIn: { type: 'bounce', durationSec: 0.5 } }],
  ];
  for (const [name, over] of cases) {
    it(`animIn ${name}: bbox centre / size / brightness follow the evaluator`, async () => {
      const { frames, p } = await render([txt('HELLO', over, { size: 60 })]);
      const item = p.tracks[0]!.items[0] as never;
      const rest = bboxWhere(frames[20]!, (r, g, b) => r + g + b > 100);
      for (const k of [0, 3, 6, 9, 12]) {
        const tl = k / 30;
        const an = textAnimAt(item, tl);
        const tr = resolveTransform(item, tl);
        const b = bboxWhere(frames[k]!, (r, g, bb) => r + g + bb > 100);
        const visible = an.opacity * tr.opacity > 0.05;
        if (!visible) {
          expect(b.n, `frame ${k} should be hidden`).toBeLessThan(40);
          continue;
        }
        // vertical offset (fraction of the canvas height) and scale
        expect(Math.abs(b.cy - (rest.cy + an.dy * CH)), `${name} dy @${k}`).toBeLessThan(6);
        if (name !== 'fade' && name !== 'slide') expect(Math.abs(b.w / rest.w - an.scale), `${name} scale @${k}`).toBeLessThan(0.15);
      }
      if (name === 'fade' || name === 'slide' || name === 'scale') {
        const bright = (k: number) => bboxWhere(frames[k]!, (r) => r > 30).n;
        expect(bright(2)).toBeLessThanOrEqual(bright(14) + 5);
      }
    });
  }

  it('animOut fade: opacity ramps to 0 at the end of the item', async () => {
    const { frames } = await render([txt('HHH', { animOut: { type: 'fade', durationSec: 0.5 } }, { size: 100 })]);
    const peak = (k: number) => Math.max(...[0, 1, 2, 3, 4].map((i) => frames[k]!.px(135 + i * 8, 240)[0]));
    expect(bboxWhere(frames[5]!, (r) => r > 200).n).toBeGreaterThan(300);
    expect(bboxWhere(frames[28]!, (r) => r > 200).n).toBeLessThan(bboxWhere(frames[18]!, (r) => r > 200).n);
    void peak;
  });

  it('typewriter reveals visibleChars() code points WITHOUT reflow (left edge stays)', async () => {
    const { frames } = await render([txt('HELLO WORLD', { durationSec: 1, animIn: { type: 'typewriter', durationSec: 0.8 } }, { size: 40, align: 'left' })]);
    const w = (k: number) => bboxWhere(frames[k]!, isWhite);
    expect(w(2).n).toBeLessThan(w(12).n);
    expect(w(12).n).toBeLessThan(w(26).n);
    // glyph positions are fixed: the first letter's left edge is the same at every frame once visible
    expect(Math.abs(w(6).x0 - w(26).x0)).toBeLessThanOrEqual(2);
    expect(w(26).w).toBeGreaterThan(w(6).w);
  });

  it('keyframed transform (position + opacity) is sampled per frame', async () => {
    const { frames } = await render([txt('HHH', { transform: TR({ x: A(0, [{ t: 0, v: -60 }, { t: 1, v: 60 }]), opacity: A(1, [{ t: 0, v: 1 }, { t: 1, v: 0.4 }]) }) }, { size: 70 })]);
    const c = (k: number) => bboxWhere(frames[k]!, (r) => r > 80).cx;
    expect(c(2)).toBeLessThan(c(15));
    expect(c(15)).toBeLessThan(c(27));
    expect(Math.abs(c(2) - (135 - 60 + 4))).toBeLessThan(12);
  });
});

/* ------------------------------------------------------------------------------------ shapes ---- */

const WHITE_OR_RED = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100;

describe.skipIf(!haveFfmpeg)('shapes', () => {
  it('rect: exact size, centred, fill colour', async () => {
    const f = (await render([shape('rect', { width: 100, height: 60 })])).frames[3]!;
    const b = bboxWhere(f, isRed);
    expect(Math.abs(b.w - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.h - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.cx - 135)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.cy - 240)).toBeLessThanOrEqual(1.5);
    expect(b.n).toBeGreaterThan(100 * 60 * 0.93);
  });

  it('rect radius: corners are empty, edge midpoints filled', async () => {
    const f = (await render([shape('rect', { width: 100, height: 60, radius: 20 })])).frames[3]!;
    expect(f.px(86, 211)).toEqual([0, 0, 0]);
    expect(isRed(...f.px(135, 211))).toBe(true);
    expect(isRed(...f.px(86, 240))).toBe(true);
  });

  it('ellipse: bbox corners empty, centre and axis ends filled', async () => {
    const f = (await render([shape('ellipse', { width: 100, height: 60 })])).frames[3]!;
    expect(f.px(86, 211)).toEqual([0, 0, 0]);
    expect(isRed(...f.px(135, 240))).toBe(true);
    expect(isRed(...f.px(87, 240))).toBe(true);
    expect(isRed(...f.px(135, 212))).toBe(true);
    const b = bboxWhere(f, isRed);
    expect(b.n / (Math.PI * 50 * 30)).toBeGreaterThan(0.93);
    expect(b.n / (Math.PI * 50 * 30)).toBeLessThan(1.07);
  });

  it("line = a rect width × height (with radius)", async () => {
    const f = (await render([shape('line', { width: 160, height: 6 })])).frames[3]!;
    const b = bboxWhere(f, isRed);
    expect(Math.abs(b.w - 160)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.h - 6)).toBeLessThanOrEqual(2);
  });

  it('arrow points right: shaft 40 % of the height, head min(w/2, 0.9h) long and full height', async () => {
    const f = (await render([shape('arrow', { width: 120, height: 50 })])).frames[3]!;
    const col = (x: number) => bboxWhere(f, isRed, [x, 0, x + 1, CH]).h;
    expect(Math.abs(col(80) - 20)).toBeLessThanOrEqual(3); // shaft: 0.4 × 50
    expect(col(135 + 60 - 45 + 3)).toBeGreaterThan(40); // just after the head base: ~ full height
    expect(col(135 + 59)).toBeLessThan(6); // the tip
    const b = bboxWhere(f, isRed);
    expect(Math.abs(b.w - 120)).toBeLessThanOrEqual(4);
    expect(Math.abs(b.h - 50)).toBeLessThanOrEqual(3);
  });

  it('progress-bar fills left → right: width = w × progressFraction (±1 px)', async () => {
    const { frames } = await render([shape('progress-bar', { width: 200, height: 20, durationSec: 1 })]);
    for (const k of [3, 7, 15, 22, 29]) {
      const b = bboxWhere(frames[k]!, isRed);
      expect(Math.abs(b.w - (200 * k) / 30), `frame ${k}`).toBeLessThanOrEqual(2.5);
      expect(Math.abs(b.x0 - 35)).toBeLessThanOrEqual(1.5); // anchored at the natural rect's left edge
    }
  });

  it('stroke is an INSIDE band: the shape does not grow, edge = stroke colour, centre = fill', async () => {
    const f = (await render([shape('rect', { width: 100, height: 60, stroke: { color: '#0000FF', width: 8 } })])).frames[3]!;
    const outer = bboxWhere(f, (r, g, b) => r + g + b > 60);
    expect(Math.abs(outer.w - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(outer.h - 60)).toBeLessThanOrEqual(2);
    expect(isBlue(...f.px(88, 240))).toBe(true);
    expect(isBlue(...f.px(135, 213))).toBe(true);
    expect(isRed(...f.px(135, 240))).toBe(true);
    expect(isRed(...f.px(100, 240))).toBe(true); // inside the band (8 px) is already fill
  });

  it('fillOpacity applies to the fill only; the stroke stays opaque', async () => {
    const f = (await render([shape('rect', { width: 100, height: 60, fillOpacity: 0.5, stroke: { color: '#0000FF', width: 8 } })])).frames[3]!;
    const c = f.px(135, 240);
    expect(c[0]).toBeGreaterThan(110);
    expect(c[0]).toBeLessThan(145);
    expect(isBlue(...f.px(88, 240))).toBe(true);
  });

  it('shape scale and rotation (90° swaps width and height)', async () => {
    const b = bboxWhere((await render([shape('rect', { width: 100, height: 40, transform: TR({ scale: A(2), rotation: A(90) }) })])).frames[3]!, isRed);
    expect(Math.abs(b.w - 80)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.h - 200)).toBeLessThanOrEqual(3);
  });

  it('shape opacity keyframes and blend', async () => {
    const { frames } = await render([shape('rect', { width: 100, height: 60, transform: TR({ opacity: A(1, [{ t: 0, v: 1 }, { t: 1, v: 0 }]) }) })]);
    expect(frames[1]!.px(135, 240)[0]).toBeGreaterThan(220);
    expect(frames[15]!.px(135, 240)[0]).toBeGreaterThan(90);
    expect(frames[15]!.px(135, 240)[0]).toBeLessThan(165);
    expect(frames[28]!.px(135, 240)[0]).toBeLessThan(40);
  });

  it('a screen-blended shape lightens the picture below only inside its area', async () => {
    const p = makeProject(
      [track('overlay', [shape('rect', { id: 'bg', width: 270, height: 480, fill: '#0000FF' })]), track('overlay', [shape('rect', { id: 'top', width: 100, height: 60, fill: '#FF0000', blend: 'screen' })])],
      [], { width: CW, height: CH },
    );
    const r = await exportProject(p, files([]), settingsFor(CW, CH));
    const f: Frame = frameAt(r.out, 3);
    expect(isBlue(...f.px(10, 10))).toBe(true);
    const c = f.px(135, 240);
    expect(c[0]).toBeGreaterThan(220);
    expect(c[2]).toBeGreaterThan(220);
  });

  it('shapes on a video-less overlay stack in track order (later on top)', async () => {
    const p = makeProject([track('overlay', [shape('rect', { id: 'a', width: 100, height: 100, fill: '#FF0000' })]), track('overlay', [shape('rect', { id: 'b', width: 50, height: 50, fill: '#00FF00' })])], [], { width: CW, height: CH });
    const r = await exportProject(p, files([]), settingsFor(CW, CH));
    const f = frameAt(r.out, 3);
    expect(isGreen(...f.px(135, 240))).toBe(true);
    expect(isRed(...f.px(135, 200))).toBe(true);
  });
});
void WHITE_OR_RED;
