'use client';

import * as React from 'react';

let tokenCache = new Map<string, Record<string, string>>();
let tokenCacheVersion = -1;

/**
 * Resolved CSS custom properties for canvas drawing, read from the timeline root (where the `--tl-*` tokens live) and
 * memoised per theme version, so mounting dozens of canvases costs one style read, not one per canvas.
 */
export function readTokens<K extends string>(
  _el: Element | null,
  names: readonly K[],
): Record<K, string> {
  if (tokenCacheVersion !== themeVersion) {
    tokenCache = new Map();
    tokenCacheVersion = themeVersion;
  }
  const key = names.join('|');
  const hit = tokenCache.get(key);
  if (hit) return hit as Record<K, string>;
  const root = document.querySelector('.tl-root') ?? document.documentElement;
  const cs = getComputedStyle(root);
  const out = {} as Record<K, string>;
  for (const n of names) out[n] = cs.getPropertyValue(n).trim();
  tokenCache.set(key, out);
  return out;
}

let themeVersion = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let mq: MediaQueryList | null = null;

function ensureObserver() {
  if (observer || typeof document === 'undefined') return;
  const bump = () => {
    themeVersion++;
    listeners.forEach((l) => l());
  };
  observer = new MutationObserver(bump);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', bump);
}

function subscribe(cb: () => void) {
  ensureObserver();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Number that changes whenever the colour theme changes (use as an effect/memo dependency). */
export function useThemeVersion(): number {
  return React.useSyncExternalStore(
    subscribe,
    () => themeVersion,
    () => 0,
  );
}
