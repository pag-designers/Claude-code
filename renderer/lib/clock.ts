'use client';

import { useSyncExternalStore } from 'react';

/**
 * Current time rounded to the minute, safe for static export: the server snapshot is `null`
 * (so prerendered HTML never bakes in the build date) and the client ticks every 30 s.
 */
function subscribe(cb: () => void) {
  const id = window.setInterval(cb, 30_000);
  return () => window.clearInterval(id);
}
let last = 0;
function snapshot(): number {
  const m = Math.floor(Date.now() / 60_000) * 60_000;
  if (m !== last) last = m;
  return last;
}
export function useNow(): Date | null {
  const ms = useSyncExternalStore(subscribe, snapshot, () => 0);
  return ms === 0 ? null : new Date(ms);
}
