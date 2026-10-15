/** Hook card style (Brand Kit): default output pinned byte for byte, custom style fields, real libass render. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_HOOK_STYLE, type HookStyle } from '../../shared/brand';
import { appendHookToAss, buildHookEvent } from '../../electron/main/services/captions/hook';
import { measureText } from '../../electron/main/services/captions/fontbook';
import { fontBook } from '../../electron/main/services/captions/fontbook';
import golden from '../fixtures/brand-finish-hook-golden.json';

const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');
const FONTS = path.resolve(__dirname, '../../electron/main/assets/fonts');
const haveFfmpeg = fs.existsSync(FFMPEG);

const style = (over: Partial<HookStyle>): HookStyle => ({ ...DEFAULT_HOOK_STYLE, ...over });

describe('hook card: default look is byte-identical to CP1/CP2', () => {
  const g = golden as Record<string, unknown>;
  const cases = Object.keys(g).filter((k) => k !== 'append');
  it('has a golden for every text x size combination', () => {
    expect(cases.length).toBe(25);
  });
  it.each(cases)('golden %s (no style and DEFAULT_HOOK_STYLE)', (key) => {
    const [text, size] = key.split('|') as [string, string];
    const [w, h] = size.split('x').map(Number) as [number, number];
    expect(buildHookEvent(text, 2.5, w, h)).toEqual(g[key]);
    expect(buildHookEvent(text, 2.5, w, h, undefined)).toEqual(g[key]);
    expect(buildHookEvent(text, 2.5, w, h, { ...DEFAULT_HOOK_STYLE })).toEqual(g[key]);
    expect(buildHookEvent(text, 2.5, w, h, null)).toEqual(g[key]);
  });
  it('appendHookToAss with no / default style equals the golden document', () => {
    const a = appendHookToAss(null, { text: 'Big hook', durationSec: 2.5 }, 1080, 1920);
    expect(a).toBe(g.append);
    expect(
      appendHookToAss(null, { text: 'Big hook', durationSec: 2.5 }, 1080, 1920, DEFAULT_HOOK_STYLE),
    ).toBe(a);
  });
  it('any single changed field leaves the default path', () => {
    const base = buildHookEvent('Nobody tells you this', 2.5, 1080, 1920);
    for (const over of [
      { textColor: '#102030' },
      { cardColor: '#EEEEEE' },
      { cardOpacity: 0.9 },
      { yPct: 30 },
      { sizePct: 6 },
      { textCase: 'upper' as const },
      { weight: 700 },
      { fontFamily: 'Poppins' },
    ]) {
      expect(buildHookEvent('Nobody tells you this', 2.5, 1080, 1920, style(over))).not.toEqual(
        base,
      );
    }
  });
});

const fields = (styleLine: string): string[] => styleLine.replace(/^Style: /, '').split(',');

describe('hook card: custom style -> ASS', () => {
  it('maps colours, card opacity, font, weight and bold flag', () => {
    const h = buildHookEvent(
      'Money talks',
      3,
      1080,
      1920,
      style({
        fontFamily: 'Poppins',
        weight: 700,
        textColor: '#112233',
        cardColor: '#FF8000',
        cardOpacity: 0.5,
      }),
    );
    const f = fields(h.style);
    expect(f[0]).toBe('Hook');
    expect(f[1]).toBe('Poppins'); // the shipped Poppins Bold face's libass name
    expect(f[3]).toBe('&H00332211'); // text, BGR
    expect(f[5]).toBe('&H80' + '0080FF'); // card = OutlineColour, alpha 0x80 for 50 %
    expect(f[6]).toMatch(/^&H[0-9A-F]{2}000000$/); // shadow follows the card opacity
    expect(parseInt(f[6]!.slice(2, 4), 16)).toBeGreaterThan(0xb0);
    expect(f[7]).toBe('-1'); // bold face
    expect(f[15]).toBe('3'); // BorderStyle 3 (opaque box)
  });

  it('light weights are not bold; unknown families fall back to the family name', () => {
    const light = fields(
      buildHookEvent('x', 2, 1080, 1920, style({ fontFamily: 'Bebas Neue', weight: 400 })).style,
    );
    expect(light[1]).toBe('Bebas Neue');
    expect(light[7]).toBe('0');
    const unknown = fields(
      buildHookEvent('x', 2, 1080, 1920, style({ fontFamily: 'Zz Unknown Face', weight: 800 }))
        .style,
    );
    expect(unknown[1]).toBe('Zz Unknown Face');
    expect(unknown[7]).toBe('-1');
  });

  it('cardOpacity 0 removes the card and its shadow', () => {
    const f = fields(buildHookEvent('x', 2, 1080, 1920, style({ cardOpacity: 0 })).style);
    expect(f[5]).toBe('&HFFFFFFFF');
    expect(f[6]).toBe('&HFF000000');
  });

  it('size is sizePct of the short side (portrait: width, landscape: height at the built-in ratio)', () => {
    const size = (w: number, h: number, pct: number): number =>
      Number(fields(buildHookEvent('Hi', 2, w, h, style({ sizePct: pct })).style)[2]);
    expect(size(1080, 1920, 10)).toBe(108);
    expect(size(720, 1280, 5)).toBe(36);
    // landscape keeps the 0.066/0.074 ratio of the built-in card
    expect(size(1920, 1080, 7.4)).toBe(Math.round(1080 * 0.074 * (0.066 / 0.074)));
    expect(size(1920, 1080, 7.4)).toBe(71);
  });

  it('positions the card centre at yPct of the frame height', () => {
    const pos = (y: number): [number, number] => {
      const ev = buildHookEvent('Hi', 2, 1080, 1920, style({ yPct: y })).event;
      const m = /\\pos\((\d+),(\d+)\)/.exec(ev)!;
      return [Number(m[1]), Number(m[2])];
    };
    expect(pos(50)).toEqual([540, 960]);
    expect(pos(30)[1]).toBe(576);
    // never pushes the card out of the frame
    const edge = pos(5)[1];
    expect(edge).toBeGreaterThan(Math.round(1920 * 0.05) - 1);
    expect(pos(90)[1]).toBeLessThan(1920 - 40);
  });

  it('applies the text case BEFORE wrapping and measuring', () => {
    const text = 'iiii iiii iiii iiii mmmm mmmm mmmm mmmm wwww wwww';
    const lines = (t: string, c: HookStyle['textCase']): string[] =>
      buildHookEvent(t, 2, 1080, 1920, style({ textCase: c, sizePct: 9 }))
        .event.split('}')
        .pop()!
        .split('\\N');
    expect(lines(text, 'upper').join(' ')).toBe(text.toUpperCase());
    expect(lines(text, 'lower').join(' ')).toBe(text.toLowerCase());
    expect(lines(text.toUpperCase(), 'upper').join(' ')).toContain('IIII');
    expect(lines(text, 'none').join(' ')).toBe(text);
    // casing happens before wrapping: 'upper' on mixed input wraps exactly like already-upper input with 'none'
    // (and 'none' keeps the original case, so a different measure/wrap is possible)
    const mixed = 'Wide Wide Wide wide wide wide mmm mmm';
    expect(lines(mixed, 'upper')).toEqual(lines(mixed.toUpperCase(), 'none'));
    expect(lines(mixed, 'lower')).toEqual(lines(mixed.toLowerCase(), 'none'));
  });

  it('shrinks the font until the widest line fits between the margins', () => {
    const text = 'Supercalifragilisticexpialidocious Pneumonoultramicroscopicsilicovolcanoconiosis';
    const st = style({ sizePct: 12, fontFamily: 'Poppins', weight: 800 });
    const h = buildHookEvent(text, 2, 1080, 1920, st);
    const fs = Number(fields(h.style)[2]);
    expect(fs).toBeLessThan(Math.round(1080 * 0.12));
    const face = fontBook.resolve('Poppins', 800, false);
    const lines = h.event.split('}').pop()!.split('\\N');
    const budget = 1080 - 2 * Math.round(1080 * 0.08) - 2 * Math.round(fs * 0.34);
    for (const l of lines) expect(measureText(face, l, fs)).toBeLessThanOrEqual(budget + 1);
    // and a normal hook at the same size is NOT shrunk
    expect(Number(fields(buildHookEvent('Short one', 2, 1080, 1920, st).style)[2])).toBe(130);
  });

  it('keeps escaping braces/backslashes and the 1.2-4 s clamp with a style', () => {
    const st = style({ textCase: 'upper' });
    expect(buildHookEvent('use {this} \\ trick', 3, 1080, 1920, st).event).toContain('\\{THIS\\}');
    expect(buildHookEvent('x', 10, 1080, 1920, st).event).toMatch(/0:00:04\.00/);
    expect(buildHookEvent('x', 0.1, 1080, 1920, st).event).toMatch(/0:00:01\.20/);
  });

  it('appendHookToAss with a style stays idempotent and replaces a previous (default) hook', () => {
    const st = style({ cardColor: '#00FF00' });
    const first = appendHookToAss(null, { text: 'A hook', durationSec: 2.5 }, 1080, 1920);
    const once = appendHookToAss(first, { text: 'A hook', durationSec: 2.5 }, 1080, 1920, st);
    const twice = appendHookToAss(once, { text: 'A hook', durationSec: 2.5 }, 1080, 1920, st);
    expect(twice).toBe(once);
    expect(once.match(/^Style: Hook,/gm)).toHaveLength(1);
    expect(once).toContain('&H0000FF00');
    expect(once.indexOf('Style: Hook,')).toBeLessThan(once.indexOf('[Events]'));
  });
});

describe.skipIf(!haveFfmpeg)('hook card: real libass render', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-hook-'));
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
  const W = 540;
  const H = 960;
  const BG: [number, number, number] = [0x20, 0x40, 0x60];

  /** Renders the hook over a flat background and returns the RGB frame at t = 1.0 s (animations settled). */
  function render(hookStyle: HookStyle | undefined, text = 'Money talks louder'): Buffer {
    const ass = appendHookToAss(null, { text, durationSec: 2.5 }, W, H, hookStyle);
    const assFile = path.join(work, `h${Math.random().toString(36).slice(2)}.ass`);
    fs.writeFileSync(assFile, ass, 'utf8');
    const r = spawnSync(
      FFMPEG,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x204060:s=${W}x${H}:r=10:d=1.5`,
        '-vf',
        `ass=filename=${assFile}:fontsdir=${FONTS}`,
        '-ss',
        '1.0',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    expect(r.status, r.stderr?.toString()).toBe(0);
    expect(r.stdout.length).toBe(W * H * 3);
    return r.stdout;
  }

  const px = (f: Buffer, x: number, y: number): [number, number, number] => {
    const i = (y * W + x) * 3;
    return [f[i]!, f[i + 1]!, f[i + 2]!];
  };
  const near = (a: number[], b: number[], tol: number): boolean =>
    a.every((v, i) => Math.abs(v - b[i]!) <= tol);

  /** Bounding box of pixels close to `rgb`. */
  function bbox(f: Buffer, rgb: number[], tol = 12) {
    let x0 = W,
      y0 = H,
      x1 = -1,
      y1 = -1,
      n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (near(px(f, x, y), rgb, tol)) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    return { x0, y0, x1, y1, n, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  it('draws the custom card colour centred at xPct/yPct, and nothing at the default position', () => {
    const red = [0xe1, 0x1d, 0x48];
    const f = render(
      style({
        cardColor: '#E11D48',
        textColor: '#FFFFFF',
        yPct: 62,
        sizePct: 6,
        textCase: 'upper',
      }),
    );
    const b = bbox(f, red);
    expect(b.n).toBeGreaterThan(2000);
    expect(Math.abs(b.cx - W / 2)).toBeLessThan(6);
    expect(Math.abs(b.cy - 0.62 * H)).toBeLessThan(0.02 * H);
    // nothing red near the built-in 18 % position
    expect(bbox(f, red).y0).toBeGreaterThan(0.5 * H);
    // the text colour (white) is present inside the card
    const w = bbox(f, [255, 255, 255], 8);
    expect(w.n).toBeGreaterThan(100);
    expect(w.y0).toBeGreaterThanOrEqual(b.y0);
    expect(w.y1).toBeLessThanOrEqual(b.y1);
    // card edge pixel (inside, left of the text) is the exact card colour
    expect(near(px(f, b.x0 + 3, Math.round(b.cy)), red, 6)).toBe(true);
    // pixels outside the card are the background
    expect(near(px(f, 3, 3), BG, 2)).toBe(true);
    expect(near(px(f, W - 4, H - 4), BG, 2)).toBe(true);
  });

  it('the default style renders the white card near the top', () => {
    const f = render(undefined);
    const b = bbox(f, [255, 255, 255], 6);
    expect(Math.abs(b.cy - 0.18 * H)).toBeLessThan(0.03 * H);
    const same = render({ ...DEFAULT_HOOK_STYLE });
    expect(same.equals(f)).toBe(true);
  });

  it('cardOpacity blends the card with the video', () => {
    const half = render(style({ cardColor: '#FFFFFF', cardOpacity: 0.5, yPct: 50 }));
    const full = render(style({ cardColor: '#FFFFFF', cardOpacity: 1, yPct: 50 }));
    const bf = bbox(full, [255, 255, 255], 6);
    const x = bf.x0 + 4;
    const y = Math.round(bf.cy);
    const p = px(half, x, y);
    // strictly between the background and the opaque card on every channel
    p.forEach((v, i) => {
      expect(v).toBeGreaterThan(BG[i]! + 25);
      expect(v).toBeLessThan(235);
    });
    expect(near(px(full, x, y), [255, 255, 255], 4)).toBe(true);
    const none = render(style({ cardOpacity: 0, yPct: 50 }));
    expect(near(px(none, x, y), BG, 6)).toBe(true);
  });
});
