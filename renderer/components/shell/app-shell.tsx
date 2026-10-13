'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useHotkeys } from 'react-hotkeys-hook';
import { NAV_ITEMS, SETTINGS_ITEM } from '@/lib/nav';
import { useUi } from '@/lib/store';
import { useSidebar } from '@/lib/shell';
import { CommandPalette } from './command-palette';
import { Sidebar } from './sidebar';
import { StorageDialog } from './storage-dialog';
import { Topbar } from './topbar';

const OPTS = { enableOnFormTags: true, preventDefault: true } as const;

function GlobalHotkeys() {
  const router = useRouter();
  const toggle = useUi((s) => s.togglePalette);
  const { toggle: toggleSidebar } = useSidebar();
  useHotkeys('mod+k', toggle, OPTS);
  useHotkeys('mod+b', toggleSidebar, OPTS);
  useHotkeys('mod+comma', () => router.push(SETTINGS_ITEM.href), OPTS);
  const pages = [...NAV_ITEMS, SETTINGS_ITEM];
  useHotkeys(
    pages.map((_, i) => `mod+${i + 1}`),
    (e) => {
      const n = Number(e.key);
      const target = pages[n - 1];
      if (target) router.push(target.href);
    },
    OPTS,
  );
  return null;
}

/**
 * Window chrome. The top 36px strip is the drag region (hidden title bar); every interactive element is
 * `no-drag` via the base layer. macOS traffic lights (left) and Windows caption buttons (right) are
 * cleared through html[data-platform] rules in globals.css.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-background">
      <a
        href="#main"
        className="sr-only z-[200] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <div aria-hidden className="app-drag absolute inset-x-0 top-0 z-[5] h-(--titlebar-h)" />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main
          id="main"
          tabIndex={-1}
          aria-labelledby="page-title"
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {children}
        </main>
      </div>
      <GlobalHotkeys />
      <CommandPalette />
      <StorageDialog />
    </div>
  );
}
