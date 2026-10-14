/**
 * Browser-side harness for test/e2e/editor-parity.spec.ts: the REAL preview compositor drawing real PNG media.
 * Bundled by esbuild and injected into a blank page; exposes `window.PAR`.
 */
import type { Project } from '../../../shared/editor';
import {
  createCompositor,
  ensureEditorFonts,
  type EditorCompositor,
  type FrameRequest,
  type FrameSource,
} from '../../../renderer/lib/editor/compositor';

const bitmaps = new Map<string, ImageBitmap>();
let comp: EditorCompositor | null = null;

const frames: FrameSource = {
  video: (assetId) => bitmaps.get(assetId) ?? null,
  image: (assetId) => bitmaps.get(assetId) ?? null,
  lut: () => null,
};

function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const api = {
  async init(fontBase: string): Promise<void> {
    await ensureEditorFonts({ baseUrl: fontBase });
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    comp = createCompositor(canvas);
  },
  /** Decode PNG bytes into the bitmap used for asset `id` (replaces the previous one: video frames change per render). */
  async loadPng(id: string, png64: string): Promise<void> {
    const bin = atob(png64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    bitmaps.get(id)?.close();
    bitmaps.set(
      id,
      await createImageBitmap(new Blob([u8], { type: 'image/png' }), {
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'none',
      }),
    );
  },
  framesNeeded(project: Project, t: number): FrameRequest[] {
    const c = comp as EditorCompositor;
    c.setProject(project);
    return c.framesNeeded(t);
  },
  render(project: Project, t: number) {
    const c = comp as EditorCompositor;
    c.setProject(project);
    c.resize(project.canvas.width, project.canvas.height);
    const stats = c.render(t, frames);
    const px = c.readPixels();
    return { w: px.width, h: px.height, b64: b64(px.data), missing: stats.missingFrames };
  },
};
export type ParApi = typeof api;
(window as unknown as { PAR: ParApi }).PAR = api;
