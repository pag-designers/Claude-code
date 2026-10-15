/* eslint-disable no-console -- metrics lines are the point of the perf / accuracy tests */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import type { CmpApi } from './support/editor-compositor-page';
import {
  CH,
  CW,
  asset,
  blendRef,
  colorRef,
  decode,
  image,
  maxDiff,
  project,
  px,
  to255,
  shape as shapeItem,
  subtitle,
  text,
  track,
  video as videoItem,
  type Img,
  type RGB,
} from './support/editor-compositor-utils';
import { resolveColor, transitionOps } from '../../shared/editor-eval';
import { colorSchema, type TransitionType } from '../../shared/editor';

/**
 * Golden-frame tests for the editor preview compositor, run in a real Chromium (SwiftShader WebGL2) with synthetic
 * deterministic media. The harness is bundled by esbuild and injected into a blank page; fonts are served by route
 * interception. No Electron, no built renderer needed:
 *   pnpm exec playwright test test/e2e/editor-compositor.spec.ts
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const ROOT = path.resolve(__dirname, '../..');
const FONT_DIR = path.join(ROOT, 'renderer/public/fonts/editor');
const SCRATCH =
  process.env.CLIPFERN_COMPOSITOR_OUT ??
  '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/editor-compositor-work';

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  for (const d of fs
    .readdirSync(root)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort()
    .reverse()) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const CHROME = findChrome();
test.skip(!CHROME, 'needs a Chromium binary');

let browser: Browser;
let page: Page;
const problems: string[] = [];

type R = Awaited<ReturnType<typeof renderRaw>>;
const call = <K extends keyof CmpApi>(name: K, ...args: Parameters<CmpApi[K]>) =>
  page.evaluate(
    ([n, a]) =>
      (window as unknown as { CMP: Record<string, (...x: unknown[]) => unknown> }).CMP[
        n as string
      ]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<CmpApi[K]>>>;

const renderRaw = (p: ReturnType<typeof project>, t: number, pw: number) =>
  call('render', p, t, pw);
async function shot(p: ReturnType<typeof project>, t: number, pw = CW): Promise<Img & { raw: R }> {
  const raw = await renderRaw(p, t, pw);
  return { ...decode(raw), raw };
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const out = await build({
    entryPoints: [path.join(__dirname, 'support/editor-compositor-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    alias: { '@shared': path.join(ROOT, 'shared') },
    logLevel: 'silent',
  });
  const js = (out.outputFiles[0] as { text: string }).text;
  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.route('http://cmp.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/fonts/')) {
      const f = path.join(FONT_DIR, path.basename(u.pathname));
      if (fs.existsSync(f)) return route.fulfill({ path: f, contentType: 'font/ttf' });
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body></body></html>',
    });
  });
  await page.goto('http://cmp.test/index.html');
  await page.addScriptTag({ content: js });
  await call('init', 'http://cmp.test/fonts/');
  await call('media', [
    { id: 'wide', kind: 'quad', w: 200, h: 100 },
    { id: 'wgrad', kind: 'hgrad', w: 200, h: 100 },
    { id: 'chart', kind: 'chart', w: 256, h: 256 },
    { id: 'hgrad256', kind: 'hgrad', w: 256, h: 256 },
    { id: 'quad', kind: 'quad', w: CW, h: CH },
    { id: 'hgrad', kind: 'hgrad', w: CW, h: CH },
    { id: 'checker', kind: 'checker', w: CW, h: CH },
    { id: 'red', kind: 'flat', w: CW, h: CH, rgb: [255, 0, 0] },
    { id: 'blue', kind: 'flat', w: CW, h: CH, rgb: [0, 0, 255] },
    { id: 'base', kind: 'flat', w: CW, h: CH, rgb: [200, 100, 50] },
    { id: 'top', kind: 'flat', w: CW, h: CH, rgb: [90, 180, 240] },
  ]);
});

test.afterAll(async () => {
  await browser?.close();
  // the harness must not have produced console errors / GL warnings
  expect(problems).toEqual([]);
});

const A = (id: string, w = CW, h = CH) => asset(id, w, h);

test.describe('compositor basics', () => {
  test('flat image covers the canvas and canvas background shows elsewhere', async () => {
    const p = project(
      [
        track('v', 'video', [
          image('i', 'red', 0, 2, { fit: 'contain', transform: { scale: { v: 0.5 } } }),
        ]),
      ],
      [A('red')],
      { background: '#102030' },
    );
    const s = await shot(p, 1);
    expect(maxDiff(px(s, CW / 2, CH / 2), [255, 0, 0])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(s, 5, 5), [0x10, 0x20, 0x30])).toBeLessThanOrEqual(1);
    expect(px(s, 5, 5)[3]).toBe(255);
  });
});

test.describe('opacity, fades, blend modes', () => {
  test('transform opacity and fades give exact flat values', async () => {
    const p = project(
      [
        track('v', 'video', [
          image('i', 'red', 0, 2, { transform: { opacity: { v: 0.5 } } }),
          image('j', 'red', 2, 2, { fadeInSec: 1, fadeOutSec: 1 }),
        ]),
      ],
      [A('red')],
    );
    expect(maxDiff(px(await shot(p, 0.5), 100, 100), [128, 0, 0])).toBeLessThanOrEqual(1);
    // j: fade-in 1 s → at local 0.25 s opacity .25; at local 1.5 s (middle) 1; at local 1.75 s fade-out .75→ .25
    expect(maxDiff(px(await shot(p, 2.25), 100, 100), [64, 0, 0])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(await shot(p, 3.0), 100, 100), [255, 0, 0])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(await shot(p, 3.75), 100, 100), [64, 0, 0])).toBeLessThanOrEqual(1);
    // half-open interval: nothing is drawn at the very end → background
    expect(maxDiff(px(await shot(p, 4.0), 100, 100), [0, 0, 0])).toBeLessThanOrEqual(0);
  });

  for (const alpha of [1, 0.6]) {
    test(`blend modes vs CPU reference (opacity ${alpha})`, async () => {
      const base: RGB = [200, 100, 50];
      const top: RGB = [90, 180, 240];
      let worst = 0;
      for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten']) {
        const p = project(
          [
            track('v', 'video', [image('a', 'base', 0, 2)]),
            track('o', 'overlay', [
              image('b', 'top', 0, 2, { blend: mode, transform: { opacity: { v: alpha } } }),
            ]),
          ],
          [A('base'), A('top')],
        );
        const got = px(await shot(p, 1), 180, 320);
        const want = to255(
          blendRef(mode, base.map((v) => v / 255) as RGB, top.map((v) => v / 255) as RGB, alpha),
        );
        const d = maxDiff(got, want);
        worst = Math.max(worst, d);
        expect(d, `${mode}: got ${got} want ${want}`).toBeLessThanOrEqual(1);
      }
      console.log(`[metrics] blend modes max error: ${worst}/255`);
    });
  }

  test('blend modes also work through the offscreen path (blurred overlay) and for rotated partial layers', async () => {
    const base: RGB = [200, 100, 50];
    const top: RGB = [90, 180, 240];
    for (const mode of ['multiply', 'overlay', 'add']) {
      const p = project(
        [
          track('v', 'video', [image('a', 'base', 0, 2)]),
          track('o', 'overlay', [
            image('b', 'top', 0, 2, {
              blend: mode,
              blur: { v: 8 },
              transform: { opacity: { v: 0.7 } },
            }),
          ]),
        ],
        [A('base'), A('top')],
      );
      const got = px(await shot(p, 1), 180, 320);
      const want = to255(
        blendRef(mode, base.map((v) => v / 255) as RGB, top.map((v) => v / 255) as RGB, 0.7),
      );
      expect(maxDiff(got, want), `${mode}: got ${got} want ${want}`).toBeLessThanOrEqual(1);
    }
    // outside a rotated, scaled layer the backdrop is untouched (no blend bleed)
    const q = project(
      [
        track('v', 'video', [image('a', 'base', 0, 2)]),
        track('o', 'overlay', [
          image('b', 'top', 0, 2, {
            blend: 'multiply',
            fit: 'contain',
            transform: { scale: { v: 0.3 }, rotation: { v: 20 } },
          }),
        ]),
      ],
      [A('base'), A('top')],
    );
    const s = await shot(q, 1);
    expect(px(s, 10, 10).slice(0, 3)).toEqual([200, 100, 50]);
    expect(
      maxDiff(
        px(s, 180, 320),
        to255(
          blendRef(
            'multiply',
            [200 / 255, 100 / 255, 50 / 255],
            [90 / 255, 180 / 255, 240 / 255],
            1,
          ),
        ),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test('images with alpha stay transparent; mutable sources are re-uploaded', async () => {
    await call('media', [{ id: 'disc', kind: 'alpha-disc', w: 200, h: 200, rgb: [0, 255, 0] }]);
    const p = project(
      [
        track('v', 'video', [image('bg', 'red', 0, 2)]),
        track('o', 'overlay', [image('d', 'disc', 0, 2, { fit: 'native' })]),
      ],
      [A('red'), asset('disc', 200, 200)],
    );
    const s = await shot(p, 1);
    expect(maxDiff(px(s, 180, 320), [0, 255, 0])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(s, 180 - 96, 320 - 96), [255, 0, 0])).toBeLessThanOrEqual(1); // bbox corner: transparent → red below
    // edge ring: straight-alpha mixes of red and green keep r + g = 255 (a premultiplication bug darkens the fringe)
    let worst = 0;
    for (let a = 0; a < 360; a += 10) {
      const q = px(
        s,
        180 + 99.5 * Math.cos((a * Math.PI) / 180),
        320 + 99.5 * Math.sin((a * Math.PI) / 180),
      );
      worst = Math.max(worst, Math.abs(q[0] + q[1] - 255));
    }
    expect(worst).toBeLessThanOrEqual(3);

    await call('liveCanvas', 'live', CW, CH, [10, 20, 30]);
    const live = project([track('v', 'video', [image('l', 'live', 0, 2)])], [A('live')]);
    const r1 = await shot(live, 1);
    expect(maxDiff(px(r1, 50, 50), [10, 20, 30])).toBeLessThanOrEqual(1);
    await call('repaint', 'live', [200, 50, 50]);
    const r2 = await shot(live, 1);
    expect(maxDiff(px(r2, 50, 50), [200, 50, 50])).toBeLessThanOrEqual(1);
    expect(r2.raw.uploads).toBeGreaterThan(r1.raw.uploads);
  });

  test('hidden tracks are skipped and tracks stack bottom to top', async () => {
    const p = project(
      [
        track('v', 'video', [image('a', 'red', 0, 2)]),
        track('o', 'overlay', [image('b', 'blue', 0, 2)], { hidden: true }),
        track('o2', 'overlay', [
          image('c', 'top', 0, 2, { fit: 'contain', transform: { scale: { v: 0.5 } } }),
        ]),
      ],
      [A('red'), A('blue'), A('top')],
    );
    const s = await shot(p, 1);
    expect(maxDiff(px(s, 180, 320), [90, 180, 240])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(s, 10, 10), [255, 0, 0])).toBeLessThanOrEqual(1);
  });
});

const rot = (x: number, y: number, deg: number): [number, number] => {
  const c = Math.cos((deg * Math.PI) / 180);
  const sn = Math.sin((deg * Math.PI) / 180);
  return [c * x - sn * y, sn * x + c * y];
};

test.describe('geometry', () => {
  test('rotated / scaled / translated rect lands where handlesFor says; orientation is clockwise', async () => {
    const item = image('i', 'wide', 0, 2, {
      fit: 'contain',
      transform: { x: { v: 40 }, y: { v: -30 }, scale: { v: 0.5 }, rotation: { v: 30 } },
    });
    const p = project([track('v', 'video', [item])], [A('wide', 200, 100)]);
    const s = await shot(p, 1);
    const h = await call('handles', p, 1, CW, 'i');
    expect(h).not.toBeNull();
    const hh = h as NonNullable<typeof h>;
    // analytic: contain → 360×180 rect; scale .5 → 180×90 around (220, 290)
    const want = [
      [-90, -45],
      [90, -45],
      [90, 45],
      [-90, 45],
    ]
      .map(([x, y]) => rot(x as number, y as number, 30))
      .map(([x, y]) => [220 + (x as number), 290 + (y as number)]);
    hh.corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo((want[i] as number[])[0] as number, 6);
      expect(c.y).toBeCloseTo((want[i] as number[])[1] as number, 6);
    });
    expect(hh.center).toEqual({ x: 220, y: 290 });
    expect(hh.rotation).toBe(30);
    // rotation handle sits above the top edge middle, along the rotated up axis
    const topMid = {
      x: (hh.corners[0].x + hh.corners[1].x) / 2,
      y: (hh.corners[0].y + hh.corners[1].y) / 2,
    };
    const up = rot(0, -28, 30);
    expect(hh.rotationHandle.x).toBeCloseTo(topMid.x + up[0], 6);
    expect(hh.rotationHandle.y).toBeCloseTo(topMid.y + up[1], 6);
    // pixels: just inside every corner is painted, just outside is background
    for (const c of hh.corners) {
      const dx = hh.center.x - c.x;
      const dy = hh.center.y - c.y;
      const n = Math.hypot(dx, dy);
      const inside = px(s, c.x + (dx / n) * 5, c.y + (dy / n) * 5);
      const outside = px(s, c.x - (dx / n) * 5, c.y - (dy / n) * 5);
      expect(inside[0] + inside[1] + inside[2], `inside ${c.x},${c.y}`).toBeGreaterThan(150);
      expect(outside.slice(0, 3)).toEqual([0, 0, 0]);
    }
    // clockwise: the item's own top-right corner moved DOWN relative to the centre
    expect(hh.corners[1].y).toBeGreaterThan(hh.corners[0].y);
    // hit-testing agrees
    expect(await call('hit', p, 1, CW, 220, 290)).toBe('i');
    expect(await call('hit', p, 1, CW, 5, 5)).toBeNull();
    const [ox, oy] = rot(88, -43, 30); // inside near the rotated top-right corner
    expect(await call('hit', p, 1, CW, 220 + ox, 290 + oy)).toBe('i');
    const [fx, fy] = rot(96, -43, 30); // just outside the right edge
    expect(await call('hit', p, 1, CW, 220 + fx, 290 + fy)).toBeNull();
  });

  test('preview scale: everything is in project canvas px scaled by canvas.width / project width', async () => {
    const p = project(
      [
        track('v', 'video', [
          image('i', 'red', 0, 2, {
            fit: 'contain',
            transform: { scale: { v: 0.5 }, x: { v: 90 } },
          }),
        ]),
      ],
      [A('red')],
    );
    const s = await shot(p, 1, 180);
    expect(s.w).toBe(180);
    expect(s.h).toBe(320);
    // 360×640 asset scaled .5 → 180×320 centred at canvas x 270 → spans canvas x 180..360 → preview 90..180
    expect(maxDiff(px(s, 135, 160), [255, 0, 0])).toBeLessThanOrEqual(1);
    expect(px(s, 85, 160).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(s, 60, 160).slice(0, 3)).toEqual([0, 0, 0]);
    const h = (await call('handles', p, 1, 180, 'i')) as NonNullable<
      Awaited<ReturnType<CmpApi['handles']>>
    >;
    expect(h.corners[0].x).toBeCloseTo(90, 6);
    expect(h.corners[2].x).toBeCloseTo(180, 6);
  });

  test('contain letterboxes, cover centre-crops, mirror flips', async () => {
    const contain = project(
      [track('v', 'video', [image('i', 'wgrad', 0, 2, { fit: 'contain' })])],
      [A('wgrad', 200, 100)],
    );
    const c = await shot(contain, 1);
    expect(px(c, 180, 200).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(c, 180, 440).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(c, 180, 320)[0]).toBeGreaterThan(120);
    expect(px(c, 1, 320)[0]).toBeLessThan(4);
    expect(px(c, 358, 320)[0]).toBeGreaterThan(250);

    const cover = project(
      [track('v', 'video', [image('i', 'wgrad', 0, 2, { fit: 'cover' })])],
      [A('wgrad', 200, 100)],
    );
    const v = await shot(cover, 1);
    // cover keeps the central 56.25/200 = 28.1 % of the width: u ∈ [0.3594, 0.6406]
    expect(Math.abs(px(v, 1, 320)[0] - 0.3594 * 255 - 0.4)).toBeLessThanOrEqual(3);
    expect(Math.abs(px(v, 358, 320)[0] - 0.6406 * 255)).toBeLessThanOrEqual(3);
    expect(px(v, 180, 5)[0]).toBeGreaterThan(100); // no bars

    const mir = project(
      [track('v', 'video', [image('i', 'quad', 0, 2, { mirror: true })])],
      [A('quad')],
    );
    const m = await shot(mir, 1);
    expect(px(m, 20, 20).slice(0, 3)).toEqual([0, 255, 0]); // source top-left red → now top-right... mirrored: green on the left
    expect(px(m, 340, 20).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(m, 20, 620).slice(0, 3)).toEqual([255, 255, 0]);
    const plain = await shot(
      project([track('v', 'video', [image('i', 'quad', 0, 2)])], [A('quad')]),
      1,
    );
    expect(px(plain, 20, 20).slice(0, 3)).toEqual([255, 0, 0]); // upright, not flipped vertically
    expect(px(plain, 20, 620).slice(0, 3)).toEqual([0, 0, 255]);
  });

  test("'native' draws source pixels 1:1 (asset dims, not frame dims)", async () => {
    // asset claims 100×100 while the bitmap is 360×640: native uses the ASSET size (centred 100×100 square)
    const p = project(
      [track('v', 'video', [image('i', 'red', 0, 2, { fit: 'native' })])],
      [asset('red', 100, 100)],
    );
    const s = await shot(p, 1);
    expect(maxDiff(px(s, 180, 320), [255, 0, 0])).toBeLessThanOrEqual(1);
    expect(px(s, 120, 320).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(s, 240, 320).slice(0, 3)).toEqual([0, 0, 0]);
  });

  test('crop keyframes move the sampled region', async () => {
    const cropper = (kfX: boolean) =>
      project(
        [
          track('v', 'video', [
            image('i', 'hgrad256', 0, 2, {
              crop: {
                x: kfX
                  ? {
                      v: 0,
                      kf: [
                        { t: 0, v: 0 },
                        { t: 1, v: 0.5 },
                      ],
                    }
                  : { v: 0 },
                w: { v: 0.5 },
              },
            }),
          ]),
        ],
        [asset('hgrad256', 256, 256)],
        { width: 256, height: 256 },
      );
    const p = cropper(true);
    for (const [t, x0] of [
      [0, 0],
      [0.5, 0.25],
      [1, 0.5],
    ] as const) {
      const s = await shot(p, t, 256);
      for (const col of [4, 128, 250]) {
        const want = (x0 + ((col + 0.5) / 256) * 0.5) * 255;
        expect(Math.abs(px(s, col, 128)[0] - want), `t=${t} col=${col}`).toBeLessThanOrEqual(2.5);
      }
    }
  });
});

const chartRgb = (px_: number, py: number): RGB => [
  (px_ * 17) & 255,
  (py * 17) & 255,
  ((py * 16 + px_) * 37 + 11) & 255,
];

function cubeText(
  size: number,
  f: (r: number, g: number, b: number) => RGB,
  title = 'test',
): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const o = f(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(`${o[0]} ${o[1]} ${o[2]}`);
      }
  return lines.join('\n');
}

test.describe('colour', () => {
  const chartProject = (color: Record<string, unknown>) =>
    project(
      [track('v', 'video', [image('i', 'chart', 0, 2, { fit: 'native', color })])],
      [asset('chart', 256, 256)],
      { width: 256, height: 256 },
    );

  async function chartError(
    color: Record<string, unknown>,
    lutFn?: (c: RGB) => RGB,
    lutAmount = 1,
  ): Promise<number> {
    const p = chartProject(color);
    const s = await shot(p, 1, 256);
    const eff = resolveColor(colorSchema.parse(color), 0);
    let worst = 0;
    for (let py = 0; py < 16; py++)
      for (let pxl = 0; pxl < 16; pxl++) {
        const src = chartRgb(pxl, py);
        let want = colorRef(src, { ...eff, lutAssetId: null });
        if (lutFn) {
          const l = lutFn(want.map((v) => v / 255) as RGB).map((v) => v * 255) as RGB;
          want = want.map((v, i) =>
            Math.round(v * (1 - lutAmount) + (l[i] as number) * lutAmount),
          ) as RGB;
        }
        const got = px(s, pxl * 16 + 8, py * 16 + 8);
        worst = Math.max(worst, maxDiff(got, want));
      }
    return worst;
  }

  test('colour shader equals applyColor on a 256-patch chart (≤ 1/255)', async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { exposure: { v: 0.3 } },
      { exposure: { v: -0.4 }, contrast: { v: 0.25 } },
      { saturation: { v: -0.6 } },
      { saturation: { v: 0.8 }, temperature: { v: 0.5 } },
      {
        exposure: { v: 0.2 },
        contrast: { v: -0.3 },
        saturation: { v: 0.4 },
        temperature: { v: -0.7 },
      },
      { filter: 'vivid' },
      { filter: 'noir', exposure: { v: 0.1 } },
      { filter: 'fade', temperature: { v: 0.3 } },
    ];
    let worst = 0;
    for (const c of cases) {
      const e = await chartError(c);
      worst = Math.max(worst, e);
      expect(e, JSON.stringify(c)).toBeLessThanOrEqual(1);
    }
    console.log(`[metrics] colour shader max error: ${worst}/255`);
  });

  test('.cube LUT (3D texture, lutAmount mix) after the colour ops', async () => {
    const inv = (c: RGB): RGB => [1 - c[0], 1 - c[1], 1 - c[2]];
    const swap = (c: RGB): RGB => [c[1], c[2], c[0]];
    await call(
      'cube',
      'inv',
      cubeText(5, (r, g, b) => inv([r, g, b])),
    );
    await call(
      'cube',
      'swap',
      cubeText(9, (r, g, b) => swap([r, g, b])),
    );
    expect(await chartError({ lutAssetId: 'inv' }, inv)).toBeLessThanOrEqual(1);
    expect(await chartError({ lutAssetId: 'swap', lutAmount: 0.7 }, swap, 0.7)).toBeLessThanOrEqual(
      1,
    );
    expect(
      await chartError({ lutAssetId: 'inv', lutAmount: 0.5, exposure: { v: 0.2 } }, inv, 0.5),
    ).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ transitions ------------------ */

const TRANSITIONS: TransitionType[] = [
  'crossfade',
  'dip-black',
  'dip-white',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'zoom',
  'blur',
  'whip-pan',
  'glitch',
];
const PROGRESS = [0, 0.25, 0.5, 0.75, 1];
const TR_BG: RGB = [10, 20, 30];

/** CPU reference of one transition frame between two flat full-canvas items, built from `transitionOps`. */
function transitionRef(type: TransitionType, p: number, from: RGB, to: RGB) {
  const ops = transitionOps(type, p);
  const short = Math.min(CW, CH);
  const layers = [
    { ops: ops.from, col: from },
    { ops: ops.to, col: to },
  ].map(({ ops: o, col }) => {
    const x0 = (CW / 2) * (1 - o.scale) + o.dx * CW;
    const y0 = (CH / 2) * (1 - o.scale) + o.dy * CH;
    return {
      x0,
      y0,
      x1: x0 + CW * o.scale,
      y1: y0 + CH * o.scale,
      a: o.opacity,
      col,
      margin: o.blur > 0 ? 3 * o.blur * short + 2 : 2,
    };
  });
  return (x: number, y: number): RGB | null => {
    // premultiplied group, transparent start
    let g: [number, number, number, number] = [0, 0, 0, 0];
    const cx = x + 0.5;
    const cy = y + 0.5;
    for (const l of layers) {
      const edge = (v: number, e: number, interior: boolean): boolean =>
        interior && Math.abs(v - e) < l.margin;
      if (
        edge(cx, l.x0, l.x0 > 0.5) ||
        edge(cx, l.x1, l.x1 < CW - 0.5) ||
        edge(cy, l.y0, l.y0 > 0.5) ||
        edge(cy, l.y1, l.y1 < CH - 0.5)
      )
        return null;
      if (cx < l.x0 || cx >= l.x1 || cy < l.y0 || cy >= l.y1) continue;
      g = [
        l.col[0] * l.a + g[0] * (1 - l.a),
        l.col[1] * l.a + g[1] * (1 - l.a),
        l.col[2] * l.a + g[2] * (1 - l.a),
        l.a + g[3] * (1 - l.a),
      ];
    }
    if (ops.veil) {
      const v = ops.veil.color === '#000000' ? 0 : 255;
      const a = ops.veil.alpha;
      g = [
        v * a * g[3] + g[0] * (1 - a),
        v * a * g[3] + g[1] * (1 - a),
        v * a * g[3] + g[2] * (1 - a),
        g[3],
      ];
    }
    return [0, 1, 2].map((i) => (g[i] as number) + (1 - g[3]) * (TR_BG[i] as number)) as RGB;
  };
}

function transitionProject(type: TransitionType, a: string, b: string) {
  return project(
    [
      track('v', 'video', [
        image('A', a, 0, 2),
        image('B', b, 1.5, 2, { transitionIn: { type, durationSec: 0.5 } }),
      ]),
    ],
    [A(a), A(b)],
    { background: '#0A141E' },
  );
}

test.describe('transitions', () => {
  test('every transition frame at p = 0, .25, .5, .75, 1 matches the transitionOps CPU reference', async () => {
    let worst = 0;
    let compared = 0;
    for (const type of TRANSITIONS) {
      const p = transitionProject(type, 'red', 'blue');
      for (const pr of PROGRESS) {
        const s = await shot(p, 1.5 + 0.5 * pr);
        const ref = transitionRef(type, pr, [255, 0, 0], [0, 0, 255]);
        let frameWorst = 0;
        let n = 0;
        for (let y = 3; y < CH; y += 7)
          for (let x = 3; x < CW; x += 7) {
            const want = ref(x, y);
            if (!want) continue;
            const got = px(s, x, y);
            frameWorst = Math.max(frameWorst, maxDiff(got, want));
            n++;
          }
        expect(n, `${type} p=${pr}: samples`).toBeGreaterThan(30);
        expect(frameWorst, `${type} p=${pr}`).toBeLessThanOrEqual(2);
        worst = Math.max(worst, frameWorst);
        compared += n;
      }
    }
    console.log(`[metrics] transitions max error: ${worst}/255 over ${compared} sampled px`);
  });

  test('framesNeeded: 2 frames per track during a transition, source time via makeSourceTime', async () => {
    const assets = [asset('va', 360, 640, 'video', 5), asset('vb', 360, 640, 'video', 8)];
    const mk = (extra: Record<string, unknown>) =>
      project(
        [
          track('v', 'video', [
            videoItem('A', 'va', 0, 2),
            videoItem('B', 'vb', 1.5, 3, {
              inSec: 2,
              transitionIn: { type: 'crossfade', durationSec: 0.5 },
              ...extra,
            }),
          ]),
        ],
        assets,
      );
    const p = mk({});
    expect(await call('framesNeeded', p, 0.5)).toEqual([
      { assetId: 'va', srcSec: 0.5, itemId: 'A' },
    ]);
    const during = await call('framesNeeded', p, 1.75);
    expect(during).toEqual([
      { assetId: 'va', srcSec: 1.75, itemId: 'A' },
      { assetId: 'vb', srcSec: 2.25, itemId: 'B' },
    ]);
    expect(await call('framesNeeded', p, 3)).toEqual([{ assetId: 'vb', srcSec: 3.5, itemId: 'B' }]);
    // speed 2, reverse, freeze and clamping to the asset duration
    const fast = mk({ speed: 2 });
    expect(((await call('framesNeeded', fast, 3)) as { srcSec: number }[])[0]!.srcSec).toBeCloseTo(
      2 + 2 * 1.5,
      9,
    );
    const rev = mk({ reverse: true, speed: 1 });
    // window [2, 2+3]: reverse plays it backwards → at local 1.5 → 2 + 3 − 1.5
    expect(((await call('framesNeeded', rev, 3)) as { srcSec: number }[])[0]!.srcSec).toBeCloseTo(
      3.5,
      9,
    );
    const frozen = mk({ freezeAtSec: 7.5 });
    expect(((await call('framesNeeded', frozen, 3)) as { srcSec: number }[])[0]!.srcSec).toBe(7.5);
    const clamped = mk({ inSec: 7, speed: 4 });
    expect(((await call('framesNeeded', clamped, 3)) as { srcSec: number }[])[0]!.srcSec).toBe(8);
    // hidden track → nothing
    const hidden = project(
      [track('v', 'video', [videoItem('A', 'va', 0, 2)], { hidden: true })],
      assets,
    );
    expect(await call('framesNeeded', hidden, 1)).toEqual([]);
  });

  test('render asks the FrameSource for exactly the frames framesNeeded lists', async () => {
    const assets = [asset('red', 360, 640, 'video', 5), asset('blue', 360, 640, 'video', 8)];
    const p = project(
      [
        track('v', 'video', [
          videoItem('A', 'red', 0, 2),
          videoItem('B', 'blue', 1.5, 3, {
            inSec: 2,
            transitionIn: { type: 'crossfade', durationSec: 0.5 },
          }),
        ]),
      ],
      assets,
    );
    const r = await renderRaw(p, 1.75, 90);
    const needed = (await call('framesNeeded', p, 1.75)) as { assetId: string; srcSec: number }[];
    expect(r.frameLog.map((f) => `${f.assetId}@${f.srcSec}`).sort()).toEqual(
      needed.map((f) => `${f.assetId}@${f.srcSec}`).sort(),
    );
    expect(r.missing).toEqual([]);
    const miss = await renderRaw(
      project(
        [track('v', 'video', [videoItem('Z', 'nope', 0, 2)])],
        [asset('nope', 360, 640, 'video')],
      ),
      1,
      90,
    );
    expect(miss.missing).toEqual([{ assetId: 'nope', srcSec: 1, itemId: 'Z' }]);
  });
});

/* ------------------------------------------------------------------ blur ------------------------- */

const erf = (x: number): number => {
  // Abramowitz–Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return s * y;
};
const Phi = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

test.describe('blur', () => {
  test('item blur equals a gaussian of the box (σ = blur px)', async () => {
    await call('media', [{ id: 'white100', kind: 'flat', w: 100, h: 100, rgb: [255, 255, 255] }]);
    for (const sigma of [6, 14]) {
      const p = project(
        [
          track('v', 'video', [
            image('i', 'white100', 0, 2, { fit: 'native', blur: { v: sigma } }),
          ]),
        ],
        [asset('white100', 100, 100)],
      );
      const s = await shot(p, 1);
      let worst = 0;
      const x0 = 130;
      const x1 = 230;
      const y0 = 270;
      const y1 = 370;
      for (const [x, y] of [
        [180, 320],
        [x0 - 5, 320],
        [x0, 320],
        [x0 + 5, 320],
        [x1 - 5, 320],
        [x1 + 8, 320],
        [180, y0 - 4],
        [180, y1 + 9],
        [x0 - 6, y0 - 6],
        [x1 + 3, y1 + 3],
        [x0 + 3, y0 + 2],
      ] as const) {
        const cx = Phi((x + 0.5 - x0) / sigma) - Phi((x + 0.5 - x1) / sigma);
        const cy = Phi((y + 0.5 - y0) / sigma) - Phi((y + 0.5 - y1) / sigma);
        const want = 255 * cx * cy;
        worst = Math.max(worst, Math.abs(px(s, x, y)[0] - want));
      }
      console.log(`[metrics] item blur σ=${sigma}: max error ${worst.toFixed(2)}/255`);
      expect(worst).toBeLessThanOrEqual(sigma > 10 ? 5 : 3.5);
    }
  });

  test('backgroundBlur fills the letterbox with a blurred cover copy', async () => {
    const mk = (bg: boolean) =>
      project(
        [track('v', 'video', [image('i', 'wgrad', 0, 2, { fit: 'contain', backgroundBlur: bg })])],
        [asset('wgrad', 200, 100)],
      );
    const off = await shot(mk(false), 1);
    expect(px(off, 100, 50).slice(0, 3)).toEqual([0, 0, 0]);
    const on = await shot(mk(true), 1);
    // cover copy: central 28 % of the gradient → red at x=100 is u = .3594 + (100.5/360)·.2812 = .4379
    const got = px(on, 100, 50);
    expect(Math.abs(got[0] - 0.4379 * 255)).toBeLessThanOrEqual(5);
    expect(Math.abs(got[2] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(px(on, 100, 600)[0] - 0.4379 * 255)).toBeLessThanOrEqual(5);
    // the sharp item itself is untouched and sits on top
    expect(Math.abs(px(on, 1, 320)[0] - 0.005 * 255)).toBeLessThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ text, shapes, subtitles ------ */

function bbox(
  im: Img,
  pred: (p: [number, number, number, number]) => boolean,
  x0 = 0,
  y0 = 0,
  x1 = im.w,
  y1 = im.h,
) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (!pred(px(im, x, y))) continue;
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { minX, minY, maxX, maxY, count };
}
const lit = (p: number[]): boolean => (p[0] as number) + (p[1] as number) + (p[2] as number) > 300;

test.describe('text', () => {
  const txt = (extra: Record<string, unknown>, style: Record<string, unknown> = {}, str = 'IIII') =>
    project(
      [
        track('t', 'text', [
          text('x', str, 0, 3, {
            style: { fontFamily: 'Anton', weight: 400, size: 100, ...style },
            ...extra,
          }),
        ]),
      ],
      [],
    );

  test('fonts: Anton ink box sits where the layout rules say (width, baseline from ascent/descent)', async () => {
    const p = txt({});
    const s = await shot(p, 1);
    const m = await call('measure', p.tracks[0]!.items[0] as never, CW);
    expect(m.lines).toEqual(['IIII']);
    const b = bbox(s, lit);
    expect(b.count).toBeGreaterThan(500);
    // vertical: baseline = centre + (ascent − descent)/2·size; cap top = baseline − capHeight·size  (Anton 1.404/.329/.859)
    const baseline = CH / 2 + ((1.404 - 0.329) / 2) * 100;
    expect(Math.abs(b.maxY + 1 - baseline)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.minY - (baseline - 85.9))).toBeLessThanOrEqual(1.5);
    // horizontal: ink is centred on the canvas centre and no wider than the advance width
    expect(Math.abs((b.minX + b.maxX) / 2 - CW / 2)).toBeLessThanOrEqual(3);
    expect(b.maxX - b.minX).toBeLessThanOrEqual(m.width);
    expect(b.maxX - b.minX).toBeGreaterThan(m.width * 0.8);
  });

  test('box, stroke and shadow', async () => {
    const boxed = await shot(
      txt({}, { box: { color: '#FF0000', opacity: 0.5, padding: 20, radius: 0 } }),
      1,
    );
    const m = await call(
      'measure',
      txt({}, { box: { color: '#FF0000', opacity: 0.5, padding: 20, radius: 0 } }).tracks[0]!
        .items[0] as never,
      CW,
    );
    expect(
      maxDiff(px(boxed, CW / 2 - m.width / 2 + 3, CH / 2 - m.height / 2 + 3), [128, 0, 0]),
    ).toBeLessThanOrEqual(1);
    expect(px(boxed, CW / 2 - m.width / 2 - 4, CH / 2).slice(0, 3)).toEqual([0, 0, 0]);

    const stroked = await shot(
      txt({}, { size: 200, stroke: { color: '#FF0000', width: 10 } }, 'I'),
      1,
    );
    const white = bbox(stroked, (q) => q[0] > 240 && q[1] > 240 && q[2] > 240);
    expect(white.count).toBeGreaterThan(200);
    const y = Math.round(CH / 2);
    expect(px(stroked, white.minX - 5, y).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(stroked, white.minX - 14, y).slice(0, 3)).toEqual([0, 0, 0]);

    const shad = await shot(
      txt(
        {},
        { size: 200, shadow: { color: '#00FF00', opacity: 1, blur: 0, offsetX: 20, offsetY: 20 } },
        'I',
      ),
      1,
    );
    const ink = bbox(shad, (q) => q[0] > 240 && q[1] > 240 && q[2] > 240);
    expect(px(shad, ink.maxX + 10, Math.round(CH / 2 + 30)).slice(0, 3)).toEqual([0, 255, 0]);
    expect(px(shad, ink.minX - 10, Math.round(CH / 2 + 30)).slice(0, 3)).toEqual([0, 0, 0]);
  });

  test('typewriter reveals ceil(n·u) characters without reflowing; fade scales opacity', async () => {
    const tw = txt({ animIn: { type: 'typewriter', durationSec: 1 } }, { size: 60 }, 'IIIIIIII');
    const half = bbox(await shot(tw, 0.5), lit);
    const full = bbox(await shot(tw, 1.5), lit);
    expect(Math.abs(half.minX - full.minX)).toBeLessThanOrEqual(1);
    const fourOfEight = (full.maxX - full.minX) / 2;
    expect(Math.abs(half.maxX - half.minX - fourOfEight)).toBeLessThan(
      full.maxX - full.minX < 80 ? 6 : 14,
    );
    const none = await shot(tw, 0);
    expect(bbox(none, lit).count).toBe(0);

    const fade = txt({ animIn: { type: 'fade', durationSec: 0.4 } }, { size: 100 });
    const f = await shot(fade, 0.2);
    const bb = bbox(f, (q) => q[0] > 20);
    const maxV = Math.max(
      ...Array.from(
        { length: 40 },
        (_, i) => px(f, bb.minX + 4 + i, Math.round((bb.minY + bb.maxY) / 2))[0],
      ),
    );
    expect(Math.abs(maxV - 128)).toBeLessThanOrEqual(2);
  });

  test('wrap, line height, letter spacing and alignment are reflected in measureTextItem', async () => {
    const mk = (style: Record<string, unknown>, str: string) =>
      text('x', str, 0, 3, { style: { fontFamily: 'Poppins', weight: 700, size: 50, ...style } });
    const one = await call('measure', mk({ size: 30 }, 'one two three') as never, CW);
    expect(one.lines).toEqual(['one two three']);
    const narrow = await call(
      'measure',
      mk({ size: 30, maxWidth: 160 }, 'one two three') as never,
      CW,
    );
    expect(narrow.lines.length).toBeGreaterThan(1);
    expect(narrow.height).toBeCloseTo(narrow.lines.length * 30 * 1.15, 6);
    const spaced = await call(
      'measure',
      mk({ size: 30, letterSpacing: 3 }, 'one two three') as never,
      CW,
    );
    expect(spaced.width).toBeCloseTo(one.width + 13 * 3, 4);
    const tall = await call('measure', mk({ lineHeight: 2 }, 'a\nb') as never, CW);
    expect(tall.height).toBeCloseTo(2 * 100, 6); // 2 lines × (2 × size 50)
  });
});

test.describe('shapes', () => {
  const sp = (kind: string, extra: Record<string, unknown> = {}, items: unknown[] = []) =>
    project([track('s', 'overlay', [shapeItem('s', kind, 0, 2, extra), ...items])], []);

  test('rect: exact fill, opacity, inside stroke, rounded corner', async () => {
    const r = await shot(sp('rect', { width: 200, height: 100, fill: '#FF8800' }), 1);
    expect(maxDiff(px(r, 180, 320), [255, 136, 0])).toBeLessThanOrEqual(1);
    expect(px(r, 70, 320).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(r, 77, 320).slice(0, 3)).toEqual([0, 0, 0]);
    expect(maxDiff(px(r, 83, 320), [255, 136, 0])).toBeLessThanOrEqual(1);
    expect(maxDiff(px(r, 277, 270 + 3), [255, 136, 0])).toBeLessThanOrEqual(1);
    const half = await shot(
      sp('rect', { width: 200, height: 100, fill: '#FF8800', fillOpacity: 0.5 }),
      1,
    );
    expect(maxDiff(px(half, 180, 320), [128, 68, 0])).toBeLessThanOrEqual(1);
    const st = await shot(
      sp('rect', {
        width: 200,
        height: 100,
        fill: '#FF8800',
        stroke: { color: '#0000FF', width: 10 },
      }),
      1,
    );
    expect(maxDiff(px(st, 84, 320), [0, 0, 255])).toBeLessThanOrEqual(1); // inside band (x 80..90)
    expect(maxDiff(px(st, 95, 320), [255, 136, 0])).toBeLessThanOrEqual(1);
    expect(px(st, 77, 320).slice(0, 3)).toEqual([0, 0, 0]); // stroke does not grow outwards
    const round = await shot(
      sp('rect', { width: 200, height: 100, fill: '#FF8800', radius: 40 }),
      1,
    );
    expect(px(round, 82, 272).slice(0, 3)).toEqual([0, 0, 0]);
    expect(maxDiff(px(round, 180, 272), [255, 136, 0])).toBeLessThanOrEqual(1);
  });

  test('ellipse, line, arrow, progress-bar', async () => {
    const e = await shot(sp('ellipse', { width: 200, height: 100, fill: '#00FF00' }), 1);
    expect(maxDiff(px(e, 180, 320), [0, 255, 0])).toBeLessThanOrEqual(1);
    expect(px(e, 84, 272).slice(0, 3)).toEqual([0, 0, 0]); // bbox corner is outside
    expect(maxDiff(px(e, 178 - 90, 320), [0, 255, 0])).toBeLessThanOrEqual(1);
    const l = await shot(sp('line', { width: 200, height: 6, fill: '#FFFFFF' }), 1);
    expect(px(l, 180, 320)[0]).toBe(255);
    expect(px(l, 180, 310).slice(0, 3)).toEqual([0, 0, 0]);
    const a = await shot(sp('arrow', { width: 200, height: 100, fill: '#FFFF00' }), 1);
    expect(maxDiff(px(a, 150, 320), [255, 255, 0])).toBeLessThanOrEqual(1); // shaft
    expect(px(a, 150, 280).slice(0, 3)).toEqual([0, 0, 0]); // above the shaft
    expect(maxDiff(px(a, 262, 320), [255, 255, 0])).toBeLessThanOrEqual(1); // head
    const pb = sp('progress-bar', { width: 200, height: 20, fill: '#FF0000' });
    expect(px(await shot(pb, 0), 150, 320).slice(0, 3)).toEqual([0, 0, 0]);
    const mid = await shot(pb, 1);
    expect(maxDiff(px(mid, 100, 320), [255, 0, 0])).toBeLessThanOrEqual(1);
    expect(px(mid, 200, 320).slice(0, 3)).toEqual([0, 0, 0]);
    expect(Math.abs(bbox(mid, (q) => q[0] > 128).maxX + 1 - 180)).toBeLessThanOrEqual(1); // 80 + 100 px
  });
});

test.describe('subtitles', () => {
  type W = { w: string; s: number; e: number; color?: string | null };
  const WORDS: W[] = [
    { w: 'hello', s: 0, e: 0.5 },
    { w: 'brave', s: 0.5, e: 1 },
    { w: 'world', s: 1, e: 1.5 },
  ];
  const sub = (extra: Record<string, unknown> = {}, words: W[] = WORDS) =>
    project([track('c', 'subtitle', [subtitle('c', words, 0, 2, extra)])], [], {
      background: '#202020',
    });
  const yellow = (q: number[]) =>
    (q[0] as number) > 230 && (q[1] as number) > 180 && (q[2] as number) < 80;

  test('Clean Pop: upper-case white text, the active word is yellow, positioned at yPct', async () => {
    const p = sub();
    const a = await shot(p, 0.25);
    const textBox = bbox(a, (q) =>
      q[0] > 60 || q[1] > 60 || q[2] > 60
        ? Math.abs(q[0] - 0x20) + Math.abs(q[1] - 0x20) > 50
        : false,
    );
    expect(textBox.count).toBeGreaterThan(300);
    // vertically centred on 69 % of the height (± one text height)
    expect(Math.abs((textBox.minY + textBox.maxY) / 2 - CH * 0.69)).toBeLessThan(18);
    const ya = bbox(a, yellow);
    const yb = bbox(await shot(p, 0.75), yellow);
    const yc = bbox(await shot(p, 1.25), yellow);
    expect(ya.count).toBeGreaterThan(40);
    // yellow moves right as the active word advances: hello → brave → world
    expect(ya.maxX).toBeLessThan(yb.minX + 6);
    expect(yb.maxX).toBeLessThan(yc.minX + 6);
    // white (idle) words exist while another is yellow
    expect(bbox(a, (q) => q[0] > 240 && q[1] > 240 && q[2] > 240).count).toBeGreaterThan(40);
    // before the first word nothing is active
    const before = sub({}, [{ w: 'late', s: 0.6, e: 1 }]);
    expect(bbox(await shot(before, 0.2), yellow).count).toBe(0);
  });

  test('per-word colour overrides, boxes and style override', async () => {
    const red = sub({}, [
      { w: 'one', s: 0, e: 0.5, color: '#FF0000' },
      { w: 'two', s: 0.5, e: 1 },
    ]);
    // while "two" is active, "one" keeps its override colour
    const r = await shot(red, 0.75);
    expect(bbox(r, (q) => q[0] > 240 && q[1] < 20 && q[2] < 20).count).toBeGreaterThan(40);
    // typewriter preset has a dark caption box: a pixel just left of the text inside the box is darker than the page bg
    const tw = await shot(sub({ styleId: 'typewriter' }), 1.2);
    const b = bbox(tw, (q) => Math.abs(q[0] - 0x20) + Math.abs(q[1] - 0x20) > 12);
    expect(b.count).toBeGreaterThan(300);
    const inside = px(tw, b.minX + 3, Math.round((b.minY + b.maxY) / 2));
    expect(inside[0]).toBeLessThan(0x20);
  });
});

/* ------------------------------------------------------------------ interaction / perf / sheets --- */

test.describe('interaction', () => {
  test('hitTest picks the topmost item incl. text and shapes; handlesFor follows text size', async () => {
    const p = project(
      [
        track('v', 'video', [image('bg', 'red', 0, 4)]),
        track('o', 'overlay', [
          shapeItem('box', 'rect', 0, 4, {
            width: 120,
            height: 120,
            fill: '#00FF00',
            transform: { x: { v: -60 }, y: { v: -100 } },
          }),
        ]),
        track('o2', 'overlay', [
          text('txt', 'HI', 0, 4, {
            style: { fontFamily: 'Anton', weight: 400, size: 100 },
            transform: { y: { v: 150 } },
          }),
        ]),
      ],
      [A('red')],
    );
    expect(await call('hit', p, 1, CW, 120, 220)).toBe('box'); // inside the green square (centre 120,220)
    expect(await call('hit', p, 1, CW, 300, 100)).toBe('bg');
    const h = (await call('handles', p, 1, CW, 'txt')) as NonNullable<
      Awaited<ReturnType<CmpApi['handles']>>
    >;
    const m = await call('measure', p.tracks[2]!.items[0] as never, CW);
    expect(h.corners[2].x - h.corners[0].x).toBeCloseTo(m.width, 6);
    expect(h.corners[2].y - h.corners[0].y).toBeCloseTo(m.height, 6);
    expect(h.center).toEqual({ x: 180, y: 470 });
    expect(await call('hit', p, 1, CW, 180, 470)).toBe('txt');
    expect(await call('handles', p, 9, CW, 'txt')).toBeNull(); // not active at t = 9
  });

  test('static layers cost no texture uploads or re-rasterisation between frames; reports timing', async () => {
    const W = 540;
    const H = 960;
    await call('media', [{ id: 'bigchecker', kind: 'checker', w: W, h: H }]);
    const p = project(
      [
        track('v', 'video', [
          image('bg', 'bigchecker', 0, 4, {
            color: { saturation: { v: 0.2 }, exposure: { v: 0.1 } },
          }),
        ]),
        track('o', 'overlay', [
          image('pip', 'blue', 0, 4, {
            fit: 'contain',
            transform: { scale: { v: 0.4 }, rotation: { v: 12 }, x: { v: 100 }, y: { v: -200 } },
          }),
          shapeItem('bar', 'progress-bar', 0, 4, {
            width: 400,
            height: 16,
            fill: '#FFFFFF',
            transform: { y: { v: 380 } },
          }),
        ]),
        track('t', 'text', [
          text('t', 'Static headline', 0, 4, {
            style: {
              fontFamily: 'Montserrat',
              weight: 800,
              size: 80,
              stroke: { color: '#000000', width: 6 },
            },
          }),
        ]),
      ],
      [asset('bigchecker', W, H), A('blue')],
      { width: W, height: H },
    );
    const first = await call('render', p, 1, W);
    const second = await call('render', p, 1.01, W);
    console.log(
      'UPLOADS',
      first.uploads,
      second.uploads,
      (await call('render', p, 1.02, W)).uploads,
      (await call('render', p, 1.03, W)).uploads,
    );
    expect(second.uploads).toBe(first.uploads); // nothing re-uploaded: sources are ImageBitmaps, text is cached
    // best of three: the machine is shared, software GL timings are noisy
    let b = await call('bench', p, 1, W, 30);
    for (let i = 0; i < 2; i++) {
      const again = await call('bench', p, 1, W, 30);
      if (again.perFrameMs < b.perFrameMs) b = again;
    }
    expect(b.uploadsDuring).toBe(0);
    console.log(
      `[metrics] 4 layers @ ${W}x${H} (SwiftShader, software GL): ${b.perFrameMs.toFixed(1)} ms/frame incl. GPU finish, ${b.cpuMs.toFixed(2)} ms CPU submit; uploads during bench: ${b.uploadsDuring}`,
    );
    // 3-layer transition + blur on the same canvas for reference
    for (const ty of ['crossfade', 'dip-black', 'blur'] as const) {
      const t2 = transitionProject(ty, 'bigchecker', 'blue');
      const q2 = await call(
        'bench',
        { ...t2, canvas: { ...t2.canvas, width: W, height: H } },
        1.75,
        W,
        20,
      );
      console.log(`[metrics] ${ty} transition @ ${W}x${H}: ${q2.perFrameMs.toFixed(1)} ms/frame`);
    }
    const tr = transitionProject('whip-pan', 'bigchecker', 'blue');
    const q = await call(
      'bench',
      { ...tr, canvas: { ...tr.canvas, width: W, height: H } },
      1.75,
      W,
      20,
    );
    console.log(
      `[metrics] whip-pan transition (2 blurred layers) @ ${W}x${H}: ${q.perFrameMs.toFixed(1)} ms/frame`,
    );
  });
});

test.describe('contact sheets', () => {
  const save = async (
    name: string,
    imgs: { w: number; h: number; b64: string; label: string }[],
    cols: number,
  ) => {
    const url = await call('sheet', imgs, cols, 6);
    fs.mkdirSync(SCRATCH, { recursive: true });
    fs.writeFileSync(path.join(SCRATCH, name), Buffer.from(url.split(',')[1] as string, 'base64'));
  };

  test('transitions sheet', async () => {
    const imgs: { w: number; h: number; b64: string; label: string }[] = [];
    for (const type of TRANSITIONS) {
      const p = transitionProject(type, 'hgrad', 'quad');
      for (const pr of PROGRESS) {
        const r = await renderRaw(p, 1.5 + 0.5 * pr, 90);
        imgs.push({ w: r.w, h: r.h, b64: r.b64, label: `${type} ${pr}` });
      }
    }
    await save('sheet-transitions.png', imgs, 10);
  });

  test('text / shapes / subtitles sheet', async () => {
    const imgs: { w: number; h: number; b64: string; label: string }[] = [];
    const add = async (label: string, p: ReturnType<typeof project>, t: number) => {
      const r = await renderRaw(p, t, 180);
      imgs.push({ w: r.w, h: r.h, b64: r.b64, label });
    };
    await call('media', [{ id: 'vgrad', kind: 'vgrad', w: CW, h: CH }]);
    const bg = track('v', 'video', [image('bg', 'vgrad', 0, 5)]);
    const mkText = (
      label: string,
      style: Record<string, unknown>,
      extra: Record<string, unknown> = {},
      str = 'Hello Clipfern\nsecond line',
    ) =>
      add(
        label,
        project(
          [
            bg,
            track('t', 'text', [text('x', str, 0, 5, { style: { size: 56, ...style }, ...extra })]),
          ],
          [A('vgrad')],
        ),
        1,
      );
    await mkText('Montserrat 800 stroke+shadow', {
      fontFamily: 'Montserrat',
      weight: 800,
      stroke: { color: '#000000', width: 4 },
      shadow: { color: '#000000', opacity: 0.6, blur: 8, offsetX: 4, offsetY: 6 },
    });
    await mkText('Anton box', {
      fontFamily: 'Anton',
      weight: 400,
      size: 70,
      box: { color: '#E11D48', opacity: 0.9, padding: 18, radius: 16 },
    });
    await mkText('Bebas right', {
      fontFamily: 'Bebas Neue',
      weight: 400,
      size: 80,
      align: 'right',
      letterSpacing: 4,
      color: '#FFE45C',
    });
    await mkText('DM Serif left', {
      fontFamily: 'DM Serif Display',
      weight: 400,
      size: 60,
      align: 'left',
      lineHeight: 1.4,
    });
    await mkText(
      'Plex Mono typewriter',
      { fontFamily: 'IBM Plex Mono', weight: 600, size: 40, align: 'left' },
      { animIn: { type: 'typewriter', durationSec: 2 } },
      'const x = 42;\nreturn x;',
    );
    await mkText(
      'Poppins 600 wrap',
      { fontFamily: 'Poppins', weight: 600, size: 44, maxWidth: 260 },
      {},
      'A longer sentence that must wrap onto several lines nicely',
    );
    const shapes = project(
      [
        bg,
        track('s1', 'overlay', [
          shapeItem('r', 'rect', 0, 4, {
            width: 220,
            height: 120,
            fill: '#38BDF8',
            radius: 24,
            stroke: { color: '#FFFFFF', width: 6 },
            transform: { y: { v: -200 }, rotation: { v: -8 } },
          }),
        ]),
        track('s2', 'overlay', [
          shapeItem('e', 'ellipse', 0, 4, {
            width: 200,
            height: 110,
            fill: '#F472B6',
            fillOpacity: 0.7,
            transform: { y: { v: -40 } },
          }),
        ]),
        track('s3', 'overlay', [
          shapeItem('a', 'arrow', 0, 4, {
            width: 240,
            height: 90,
            fill: '#FACC15',
            transform: { y: { v: 90 }, rotation: { v: 20 } },
          }),
        ]),
        track('s4', 'overlay', [
          shapeItem('l', 'line', 0, 4, {
            width: 260,
            height: 8,
            fill: '#FFFFFF',
            transform: { y: { v: 180 } },
          }),
        ]),
        track('s5', 'overlay', [
          shapeItem('p', 'progress-bar', 0, 4, {
            width: 280,
            height: 18,
            fill: '#4ADE80',
            radius: 9,
            transform: { y: { v: 240 } },
          }),
        ]),
      ],
      [A('vgrad')],
    );
    await add('shapes t=2', shapes, 2);
    const words = [
      { w: "that's", s: 0, e: 0.4 },
      { w: 'how', s: 0.4, e: 0.7 },
      { w: 'you', s: 0.7, e: 1.0 },
      { w: 'clip', s: 1.0, e: 1.5, color: '#FF5C8A' },
    ];
    const subs: [string, number][] = [];
    for (const [id, t] of [
      ['clean-pop', 0.45],
      ['hormozi-bold', 1.2],
      ['karaoke-highlight', 0.55],
      ['tiktok-classic', 0.8],
      ['minimal-lower-third', 0.8],
      ['neon-glow', 0.5],
      ['boxed-highlight', 0.5],
      ['typewriter', 0.75],
      ['bounce-word', 0.5],
      ['gradient-glow', 0.8],
      ['outline-only', 0.8],
      ['caption-bubble', 0.5],
      ['podcast-lower-third', 0.8],
      ['subtle-serif', 0.8],
    ] as const)
      subs.push([id, t]);
    await save('sheet-text-shapes.png', imgs, 6);
    // subtitle presets at the real 1080×1920 design size (half-size preview), cropped to the caption band
    await call('media', [{ id: 'vgrad1080', kind: 'vgrad', w: 1080, h: 1920 }]);
    const crops: { w: number; h: number; b64: string; label: string }[] = [];
    for (const [id, t] of subs) {
      const p = project(
        [
          track('v', 'video', [image('bg', 'vgrad1080', 0, 5)]),
          track('c', 'subtitle', [subtitle('c', words, 0, 2, { styleId: id })]),
        ],
        [asset('vgrad1080', 1080, 1920)],
        { width: 1080, height: 1920 },
      );
      const r = decode(await renderRaw(p, t, 540));
      const y0 = 480;
      const y1 = 700;
      crops.push({
        w: r.w,
        h: y1 - y0,
        b64: r.data.subarray(y0 * r.w * 4, y1 * r.w * 4).toString('base64'),
        label: `${id} t=${t}`,
      });
    }
    await save('sheet-subtitles.png', crops, 3);
  });

  test('colour / blend / blur sheet', async () => {
    const imgs: { w: number; h: number; b64: string; label: string }[] = [];
    const add = async (label: string, p: ReturnType<typeof project>, t = 1) => {
      const r = await renderRaw(p, t, 120);
      imgs.push({ w: r.w, h: r.h, b64: r.b64, label });
    };
    const base = (c: Record<string, unknown>) =>
      project([track('v', 'video', [image('i', 'quad', 0, 3, { color: c })])], [A('quad')]);
    await add('neutral', base({}));
    for (const f of ['vivid', 'warm', 'cool', 'mono', 'fade', 'punch', 'noir'])
      await add(f, base({ filter: f }));
    await add('exposure +.5', base({ exposure: { v: 0.5 } }));
    await add('contrast +.6', base({ contrast: { v: 0.6 } }));
    for (const mode of ['multiply', 'screen', 'overlay', 'add', 'darken', 'lighten'])
      await add(
        mode,
        project(
          [
            track('v', 'video', [image('a', 'hgrad', 0, 3)]),
            track('o', 'overlay', [
              image('b', 'quad', 0, 3, { blend: mode, transform: { opacity: { v: 0.8 } } }),
            ]),
          ],
          [A('hgrad'), A('quad')],
        ),
      );
    await add(
      'blur 12',
      project(
        [track('v', 'video', [image('i', 'checker', 0, 3, { blur: { v: 12 } })])],
        [A('checker')],
      ),
    );
    await add(
      'contain + bg blur',
      project(
        [track('v', 'video', [image('i', 'wide', 0, 3, { fit: 'contain', backgroundBlur: true })])],
        [asset('wide', 200, 100)],
      ),
    );
    await add(
      'rot 25 scale .6 mirror',
      project(
        [
          track('v', 'video', [
            image('i', 'quad', 0, 3, {
              mirror: true,
              transform: { rotation: { v: 25 }, scale: { v: 0.6 } },
            }),
          ]),
        ],
        [A('quad')],
      ),
    );
    await save('sheet-colour-blend-blur.png', imgs, 8);
  });
});
