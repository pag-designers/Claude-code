'use client';

import * as React from 'react';

/** Reads CSS custom properties (resolved per theme) for canvas drawing. Re-reads when the theme flips. */
export function readTokens<K extends string>(el: Element, names: readonly K[]): Record<K, string> {
  const cs = getComputedStyle(el);
  const out = {} as Record<K, string>;
  for (const n of names) out[n] = cs.getPropertyValue(n).trim();
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
