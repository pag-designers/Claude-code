/**
 * SVG -> PNG with a hidden, offscreen Electron window (Chromium renders SVG far more faithfully than ffmpeg can).
 *
 * Safety: an uploaded SVG is untrusted input. It is shown through an `<img>` (SVG-as-image mode: no script
 * execution, no external subresources, no foreignObject network loads), in a window with JavaScript disabled, a
 * sandboxed renderer, a throw-away in-memory session that CANCELS every request except the two temp files, a
 * deny-all permission handler, a hard timeout, and the window is always destroyed. Needs `app` to be ready; this module
 * must only be imported from the main process (never from vitest: `electron` is not loadable there).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, nativeImage, session } from 'electron';
import type { SvgRasterizer } from '../../pipeline/contracts4';
import { svgRenderLongSide } from './images';

const RENDER_TIMEOUT_MS = 20_000;
const MAX_SVG_BYTES = 25 * 2 ** 20;
/** Chromium's own default for an <svg> without size. */
const FALLBACK_SIZE = { width: 300, height: 150 };

const UNITS_TO_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const f = UNITS_TO_PX[unit];
  if (f === undefined) return null; // %, em, ex ...: relative, fall back to the viewBox
  const n = Number(m[1]) * f;
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** Intrinsic size of an SVG document: width/height attributes, else the viewBox, else Chromium's default. */
export function intrinsicSvgSize(svgText: string): { width: number; height: number } {
  const root = /<svg\b([^>]*)>/i.exec(svgText);
  const attrs = root?.[1] ?? '';
  const attr = (name: string): string | undefined =>
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
      .exec(attrs)
      ?.slice(1)
      .find(Boolean);
  const w = parseLength(attr('width'));
  const h = parseLength(attr('height'));
  const vb = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbW = vb && vb.length === 4 && (vb[2] as number) > 0 ? (vb[2] as number) : null;
  const vbH = vb && vb.length === 4 && (vb[3] as number) > 0 ? (vb[3] as number) : null;
  if (w && h) return { width: w, height: h };
  if (vbW && vbH) {
    if (w) return { width: w, height: (w * vbH) / vbW };
    if (h) return { width: (h * vbW) / vbH, height: h };
    return { width: vbW, height: vbH };
  }
  return w || h ? { width: w ?? (h as number), height: h ?? (w as number) } : FALLBACK_SIZE;
}

/** Target pixel size: the intrinsic aspect ratio, long side = min(maxPx, max(intrinsic, 1024)). */
export function svgTargetSize(
  intrinsic: { width: number; height: number },
  maxPx: number,
): { width: number; height: number } {
  const long = Math.max(intrinsic.width, intrinsic.height);
  const side = svgRenderLongSide(long, maxPx);
  const k = side / long;
  return {
    width: Math.max(1, Math.round(intrinsic.width * k)),
    height: Math.max(1, Math.round(intrinsic.height * k)),
  };
}

let queue: Promise<unknown> = Promise.resolve();

export function createElectronSvgRasterizer(): SvgRasterizer {
  return (svgPath, outPng, maxPx) => {
    const run = queue.then(
      () => render(svgPath, outPng, maxPx),
      () => render(svgPath, outPng, maxPx),
    );
    queue = run.catch(() => undefined);
    return run;
  };
}

async function render(
  svgPath: string,
  outPng: string,
  maxPx: number,
): Promise<{ width: number; height: number }> {
  const st = await fs.promises.stat(svgPath);
  if (!st.isFile() || st.size === 0 || st.size > MAX_SVG_BYTES) {
    throw new Error('SVG file is empty or too large.');
  }
  const text = await fs.promises.readFile(svgPath, 'utf8');
  if (!/<svg[\s>]/i.test(text)) throw new Error('not an SVG document');
  const size = svgTargetSize(intrinsicSvgSize(text), Math.max(16, Math.floor(maxPx)));

  await app.whenReady();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipfern-svg-'));
  const svgCopy = path.join(dir, 'in.svg');
  const page = path.join(dir, 'page.html');
  await fs.promises.copyFile(svgPath, svgCopy);
  await fs.promises.writeFile(
    page,
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'">` +
      `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
      `img{display:block;width:${size.width}px;height:${size.height}px}</style></head>` +
      `<body><img src="in.svg" alt=""></body></html>`,
  );
  const allowed = new Set([pathToFileURL(svgCopy).href, pathToFileURL(page).href]);

  // an in-memory partition used once: nothing persisted, no shared handlers
  const ses = session.fromPartition(`clipfern-svg-${process.pid}-${Date.now()}-${Math.random()}`, {
    cache: false,
  });
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !allowed.has(details.url) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  let win: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let pump: NodeJS.Timeout | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      webPreferences: {
        session: ses,
        offscreen: true,
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true,
        nodeIntegration: false,
        webviewTag: false,
        allowRunningInsecureContent: false,
        images: true,
        plugins: false,
        spellcheck: false,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setFrameRate(30);

    // Page scripts are off, so the page cannot tell us when the image has been painted, and the load event can fire a
    // few frames before the SVG shows up (those frames are fully transparent). So: after the load event keep forcing
    // repaints and accept the first frame that (a) is not the blank transparent frame and (b) equals the frame before
    // it. An animated SVG never settles (the latest frame is taken after SETTLE_MAX_MS) and a genuinely empty SVG
    // stays blank (accepted after BLANK_GRACE_MS).
    const SETTLE_MAX_MS = 1500;
    const BLANK_GRACE_MS = 2500;
    const png = await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SVG rendering timed out after ${RENDER_TIMEOUT_MS / 1000}s`)),
        RENDER_TIMEOUT_MS,
      );
      let loadedAt = 0;
      let frames = 0;
      let prev: string | null = null;
      let blankHash: string | null = null;
      const done = (image: Electron.NativeImage): void => {
        if (pump) clearInterval(pump);
        resolve(image.toPNG());
      };
      wc.on('paint', (_e, _dirty, image) => {
        if (!loadedAt) return; // frames before the load event are not the SVG yet
        frames++;
        const bitmap = image.toBitmap();
        const hash = createHash('sha1').update(bitmap).digest('hex');
        blankHash ??= createHash('sha1').update(Buffer.alloc(bitmap.length)).digest('hex');
        const age = Date.now() - loadedAt;
        const blank = hash === blankHash;
        if (hash === prev && (!blank || age > BLANK_GRACE_MS)) return done(image);
        prev = hash;
        if (frames >= 3 && age > SETTLE_MAX_MS && !blank) done(image);
      });
      wc.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`SVG failed to load: ${desc} (${code})`)),
      );
      wc.once('did-finish-load', () => {
        loadedAt = Date.now();
        pump = setInterval(() => {
          try {
            wc.invalidate();
          } catch {
            /* window already gone */
          }
        }, 40);
        wc.invalidate();
      });
      wc.loadFile(page).catch(reject);
    });

    // HiDPI hosts capture at device pixels: normalise to the planned size
    let image = nativeImage.createFromBuffer(png);
    const got = image.getSize();
    if (got.width !== size.width || got.height !== size.height) {
      image = image.resize({ width: size.width, height: size.height, quality: 'best' });
    }
    const out = image.toPNG();
    await fs.promises.mkdir(path.dirname(outPng), { recursive: true });
    const tmp = `${outPng}.partial`;
    await fs.promises.writeFile(tmp, out);
    await fs.promises.rename(tmp, outPng);
    return { width: size.width, height: size.height };
  } finally {
    if (timer) clearTimeout(timer);
    if (pump) clearInterval(pump);
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
    try {
      await ses.clearStorageData();
    } catch {
      /* in-memory partition */
    }
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
