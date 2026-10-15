'use client';

import * as React from 'react';
import { getEngine } from '@/lib/editor/playback';
import type { PlaybackEngine } from '@/lib/editor/playback/api';

/**
 * Bridges the playback engine's waveform / thumbnail caches to React: one subscription, rAF-coalesced, exposed as a
 * monotonically increasing version number that item renderers depend on.
 */
let version = 0;
const listeners = new Set<() => void>();
let attached: PlaybackEngine | null = null;
let detach: (() => void) | null = null;
let raf = 0;

function bump() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    version++;
    listeners.forEach((l) => l());
  });
}

/** (Re)binds to the current engine instance; cheap to call repeatedly. */
export function syncEngineBinding(): PlaybackEngine | null {
  const e = getEngine();
  if (e === attached) return e;
  detach?.();
  attached = e;
  detach = e ? e.onCacheChange(bump) : null;
  if (e) bump();
  return e;
}

export function unbindEngine() {
  detach?.();
  detach = null;
  attached = null;
}

export function useEngineVersion(): number {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => version,
    () => 0,
  );
}

/** Returns `value` once it has stopped changing for `ms` (used to avoid re-requesting thumbnails on every zoom step). */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** The render window, held back while the zoom is changing (so bitmaps are redrawn once it settles, not every frame). */
export function useSettledWindow(
  win: { start: number; end: number },
  ms: number,
): { start: number; end: number } {
  const key = `${win.start}:${win.end}`;
  const settledKey = useSettled(key, ms);
  return React.useMemo(() => {
    const [s, e] = settledKey.split(':').map(Number);
    return { start: s ?? win.start, end: e ?? win.end };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the settled key is the only input
  }, [settledKey]);
}
