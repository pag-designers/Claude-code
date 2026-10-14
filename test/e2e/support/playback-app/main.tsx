/**
 * TEST-ONLY page for the playback/preview e2e specs: mounts the REAL <PreviewPlayer/> bound to the REAL editor store and
 * the REAL compositor (WebGL2 on SwiftShader). Bundled by playback-harness.ts with esbuild (never touches renderer/out).
 * `window.__t` exposes what the specs need to drive and inspect it.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { useEditorStore } from '@/lib/editor/core';
import { getEngine, PreviewPlayer } from '@/lib/editor/playback';
import type { EditorProjectDoc } from '@shared/editor';

interface Blob {
  cx: number;
  cy: number;
  n: number;
}

/** Centroid of near-white pixels (the moving square) inside an optional box of the preview, normalised 0..1. */
function whiteBlob(box?: { x0: number; y0: number; x1: number; y1: number }): Blob | null {
  const px = getEngine()?.debugReadPixels();
  if (!px) return null;
  const { width: w, height: h, data } = px;
  const x0 = Math.floor((box?.x0 ?? 0) * w);
  const x1 = Math.ceil((box?.x1 ?? 1) * w);
  const y0 = Math.floor((box?.y0 ?? 0) * h);
  const y1 = Math.ceil((box?.y1 ?? 1) * h);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (
        (data[i] as number) > 215 &&
        (data[i + 1] as number) > 215 &&
        (data[i + 2] as number) > 215
      ) {
        sx += x;
        sy += y;
        n++;
      }
    }
  return n ? { cx: sx / n / w, cy: sy / n / h, n } : null;
}

function meanColor(box: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): [number, number, number] | null {
  const px = getEngine()?.debugReadPixels();
  if (!px) return null;
  const { width: w, height: h, data } = px;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(box.y0 * h); y < Math.ceil(box.y1 * h); y++)
    for (let x = Math.floor(box.x0 * w); x < Math.ceil(box.x1 * w); x++) {
      const i = (y * w + x) * 4;
      r += data[i] as number;
      g += data[i + 1] as number;
      b += data[i + 2] as number;
      n++;
    }
  return n ? [r / n, g / n, b / n] : null;
}

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') ?? 420);
const H = Number(params.get('h') ?? 760);

function App() {
  const [size, setSize] = React.useState({ w: W, h: H });
  const [mounted, setMounted] = React.useState(true);
  React.useEffect(() => {
    (window as unknown as { __t: unknown }).__t = {
      store: useEditorStore,
      getEngine,
      load: (doc: EditorProjectDoc) => useEditorStore.getState().load(doc),
      resize: (w: number, h: number) => setSize({ w, h }),
      unmount: () => setMounted(false),
      remount: () => setMounted(true),
      whiteBlob,
      meanColor,
    };
    (window as unknown as { __ready: boolean }).__ready = true;
  }, []);
  return (
    <div style={{ padding: 16 }}>
      <div
        id="frame"
        data-testid="frame"
        style={{ width: size.w, height: size.h }}
        className="flex rounded-lg border border-border bg-card"
      >
        {mounted ? <PreviewPlayer className="h-full min-w-0 flex-1" /> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
