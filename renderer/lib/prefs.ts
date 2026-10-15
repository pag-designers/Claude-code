'use client';

/**
 * Per-window UI preferences that must be correct BEFORE first paint (theme, sidebar width, platform).
 * The inline script in app/layout.tsx writes them onto <html data-*>; React reads them back through
 * useSyncExternalStore so server markup and the first client render agree, then the real values flow in.
 * Source of truth is the `theme` / `sidebarCollapsed` setting (settings:get/set); localStorage mirrors it.
 */
import { useSyncExternalStore } from 'react';
import type { Theme } from '@shared/settings';

import { SIDEBAR_KEY, THEME_KEY } from './pre-paint';

export { SIDEBAR_KEY, THEME_KEY };

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function safeStore(op: () => void) {
  try {
    op();
  } catch {
    /* private mode / blocked storage: the setting is still the source of truth */
  }
}

export function getThemePref(): Theme {
  const v =
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.themePref;
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function getResolvedTheme(): 'light' | 'dark' {
  const v = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
  return v === 'light' ? 'light' : 'dark';
}

export function applyTheme(pref: Theme) {
  const d = document.documentElement;
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  d.dataset.themePref = pref;
  d.dataset.theme = dark ? 'dark' : 'light';
  safeStore(() => localStorage.setItem(THEME_KEY, pref));
  emit();
}

export function applySidebarCollapsed(collapsed: boolean) {
  const d = document.documentElement;
  if (collapsed) d.dataset.sidebar = 'collapsed';
  else delete d.dataset.sidebar;
  safeStore(() => localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded'));
  emit();
}

export function useThemePref(): Theme {
  return useSyncExternalStore(subscribe, getThemePref, () => 'system');
}
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => 'dark');
}
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.sidebar === 'collapsed',
    () => false,
  );
}

/** `window.clipfern.platform` is exposed by preload; absent in a plain browser. */
export function usePlatform(): string {
  return useSyncExternalStore(
    () => () => {},
    () => (typeof window === 'undefined' ? 'unknown' : (window.clipfern?.platform ?? 'unknown')),
    () => 'unknown',
  );
}
export function useIsMac(): boolean {
  return usePlatform() === 'darwin';
}
