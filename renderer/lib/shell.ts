'use client';

import { useCallback } from 'react';
import type { Theme } from '@shared/settings';
import {
  applySidebarCollapsed,
  applyTheme,
  useResolvedTheme,
  useSidebarCollapsed,
  useThemePref,
} from './prefs';
import { useUpdateSettings } from './settings';

/** Theme = system | light | dark. Applies instantly (no flash), mirrors to localStorage, persists via settings:set. */
export function useTheme() {
  const pref = useThemePref();
  const resolved = useResolvedTheme();
  const { update } = useUpdateSettings();
  const setTheme = useCallback(
    (t: Theme) => {
      applyTheme(t);
      void update({ theme: t });
    },
    [update],
  );
  const cycle = useCallback(
    () => setTheme(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setTheme],
  );
  return { pref, resolved, setTheme, cycle };
}

export function useSidebar() {
  const collapsed = useSidebarCollapsed();
  const { update } = useUpdateSettings();
  const setCollapsed = useCallback(
    (c: boolean) => {
      applySidebarCollapsed(c);
      void update({ sidebarCollapsed: c });
    },
    [update],
  );
  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
  return { collapsed, setCollapsed, toggle };
}
