import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { decodePng } from '../unit/brand-media-helpers';

/**
 * The real Electron SVG rasteriser (offscreen hidden BrowserWindow): pixels, transparency, size rules and, above all,
 * the sandbox: an SVG with <script> / external references must not execute or fetch anything.
 *   xvfb-run -a npx playwright test test/e2e/brand-media-electron.spec.ts
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const ROOT = path.resolve(__dirname, '../..');
let work: string;
let app: ElectronApplication;
let hits: string[] = [];
let server: http.Server;
let port = 0;

test.beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-svg-e2e-'));
  const main = path.join(work, 'main.cjs');
  await build({
    entryPoints: [path.join(ROOT, 'test/e2e/support/brand-svg-main.ts')],
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    absWorkingDir: ROOT,
    alias: { '@shared': './shared', '@main': './electron/main' },
    logLevel: 'error',
  });
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  app = await electron.launch({
    args: ['--no-sandbox', '--disable-gpu', main],
    cwd: ROOT,
    env: { ...process.env, CLIPFERN_USER_DATA: path.join(work, 'ud') },
  });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  fs.rmSync(work, { recursive: true, force: true });
});

test.beforeEach(() => {
  hits = [];
});

async function rasterize(svg: string, maxPx = 2048, name = 'in.svg') {
  const dir = fs.mkdtempSync(path.join(work, 'r-'));
  const src = path.join(dir, name);
  const out = path.join(dir, 'out.png');
  fs.writeFileSync(src, svg);
  const size = await app.evaluate(
    async (_e, a) =>
      (
        globalThis as unknown as {
          __rasterize: (
            s: string,
            o: string,
            m: number,
          ) => Promise<{ width: number; height: number }>;
        }
      ).__rasterize(a.src, a.out, a.maxPx),
    { src, out, maxPx },
  );
  return { size, png: decodePng(fs.readFileSync(out)), out };
}

const windowCount = (): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as { __windowCount: () => number }).__windowCount());

/** Left half red square (#FF0000), a green (#00FF00) disc, nothing else: the rest must stay transparent. */
const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <rect x="0" y="0" width="100" height="100" fill="#ff0000"/>
  <circle cx="150" cy="50" r="30" fill="#00ff00"/>
</svg>`;

test('renders a viewBox-only SVG at 1024 px with exact colours and a transparent background', async () => {
  const { size, png } = await rasterize(LOGO);
  expect(size).toEqual({ width: 1024, height: 512 });
  expect([png.width, png.height]).toEqual([1024, 512]);
  // red square: x 0..512 of 1024
  expect(png.at(100, 100)).toEqual([255, 0, 0, 255]);
  expect(png.at(500, 480)).toEqual([255, 0, 0, 255]);
  // green disc centred at (768, 256) r=154
  expect(png.at(768, 256)).toEqual([0, 255, 0, 255]);
  // outside both shapes: fully transparent (corner of the right half, top right)
  expect(png.at(1020, 5)[3]).toBe(0);
  expect(png.at(600, 10)[3]).toBe(0);
  // disc edge is anti-aliased: some partially transparent pixel exists on the circle's rim
  let partial = 0;
  for (let x = 600; x < 940; x++) {
    const a = png.at(x, 256)[3];
    if (a > 0 && a < 255) partial++;
  }
  expect(partial).toBeGreaterThan(0);
  expect(await windowCount()).toBe(0);
});

test('width/height in physical units define the aspect ratio; large art is capped at maxPx', async () => {
  const inch = await rasterize(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in"><rect width="100%" height="100%" fill="#112233"/></svg>`,
  );
  expect(inch.size).toEqual({ width: 1024, height: 512 });
  expect(inch.png.at(512, 256)).toEqual([0x11, 0x22, 0x33, 255]);

  const big = await rasterize(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="4000"><rect width="8000" height="4000" fill="#445566"/></svg>`,
  );
  expect(big.size).toEqual({ width: 2048, height: 1024 });
  expect(big.png.width).toBe(2048);

  const small = await rasterize(LOGO, 256);
  expect(small.size).toEqual({ width: 256, height: 128 });
  expect(small.png.at(20, 20)).toEqual([255, 0, 0, 255]);

  const portrait = await rasterize(
    `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="200"><rect width="50" height="200" fill="#778899"/></svg>`,
  );
  expect(portrait.size).toEqual({ width: 256, height: 1024 });
});

test('SVG with script and external references: nothing executes, nothing is fetched', async () => {
  const url = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(work, 'secret.png'), 'local file');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
  <style>@import url(${url}/css-import.css); rect.x { fill: red; background: url(${url}/css-bg.png) }</style>
  <rect id="r" class="x" width="100" height="100" fill="#ff0000"/>
  <script><![CDATA[
    document.getElementById('r').setAttribute('fill', '#0000ff');
    fetch('${url}/script-fetch'); new Image().src = '${url}/script-img';
  ]]></script>
  <rect width="10" height="10" fill="#ff0000" onload="fetch('${url}/onload')" onclick="fetch('${url}/onclick')"/>
  <image href="${url}/image-href.png" x="0" y="0" width="50" height="50"/>
  <image xlink:href="${url}/image-xlink.png" x="50" y="0" width="50" height="50"/>
  <image href="file://${path.join(work, 'secret.png')}" x="0" y="50" width="50" height="50"/>
  <use href="${url}/use.svg#a"/>
  <foreignObject x="0" y="50" width="100" height="50">
    <div xmlns="http://www.w3.org/1999/xhtml"><img src="${url}/fo-img.png"/><iframe src="${url}/fo-iframe"></iframe><link rel="stylesheet" href="${url}/fo-link.css"/></div>
  </foreignObject>
</svg>`;
  const { png } = await rasterize(svg);
  // the script did not run: the big rect is still red, not blue
  expect(png.at(png.width - 8, 8).slice(0, 3)).toEqual([255, 0, 0]);
  await new Promise((r) => setTimeout(r, 500)); // late requests would land by now
  expect(hits).toEqual([]);
  expect(await windowCount()).toBe(0);
});

test('an animated SVG still produces a frame (it never "settles", so the renderer gives up waiting)', async () => {
  const t0 = Date.now();
  const { size, png } = await rasterize(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"><animate attributeName="x" from="0" to="50" dur="0.5s" repeatCount="indefinite"/></rect></svg>`,
  );
  expect(size).toEqual({ width: 1024, height: 1024 });
  expect(png.at(900, 500)[3]).toBeGreaterThan(0);
  expect(Date.now() - t0).toBeLessThan(8000);
  expect(await windowCount()).toBe(0);
});

test('a genuinely empty SVG gives a fully transparent PNG of the right size', async () => {
  const { size, png } = await rasterize(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"></svg>`,
  );
  expect(size).toEqual({ width: 1024, height: 512 });
  expect([png.width, png.height]).toEqual([1024, 512]);
  expect(png.rgba.every((b) => b === 0)).toBe(true);
});

test('invalid input rejects and still leaves no window behind', async () => {
  await expect(rasterize('this is not svg', 2048)).rejects.toThrow();
  expect(await windowCount()).toBe(0);
});

test('concurrent calls are serialised and all complete', async () => {
  const results = await Promise.all([rasterize(LOGO), rasterize(LOGO, 512), rasterize(LOGO, 300)]);
  expect(results.map((r) => r.size.width)).toEqual([1024, 512, 300]);
  expect(await windowCount()).toBe(0);
});
