'use client';

import { usePathname } from 'next/navigation';
import { ChevronRight, Search } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { titleForPath } from '@/lib/nav';
import { useUi } from '@/lib/store';
import { CostChip } from './cost-chip';
import { NotificationsPopover } from './notifications-popover';
import { SchedulerIndicator } from './scheduler-indicator';
import { ThemeToggle } from './theme-toggle';

export function Topbar() {
  const pathname = usePathname();
  const { title, parent } = titleForPath(pathname);
  const toggle = useUi((s) => s.togglePalette);
  return (
    <header className="shell-topbar relative z-10 flex h-12 shrink-0 items-center gap-4 border-b bg-background/80 px-6 backdrop-blur">
      <div className="flex min-w-0 items-center gap-1.5">
        {parent ? (
          <>
            <span className="text-sm font-medium text-muted-foreground">{parent}</span>
            <ChevronRight className="size-3.5 text-subtle" aria-hidden />
          </>
        ) : null}
        <p className="truncate text-md font-semibold" id="page-title">
          {title}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-label="Search or run a command"
          className="group mr-1 flex h-8 w-72 items-center gap-2.5 rounded-md border border-input bg-field px-2.5 text-sm text-subtle transition-colors hover:border-border-strong hover:text-muted-foreground max-[1180px]:w-44"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 truncate text-left">Search or run a command…</span>
          <Kbd keys={['mod', 'K']} />
        </button>
        <SchedulerIndicator />
        <CostChip />
        <NotificationsPopover />
        <ThemeToggle />
      </div>
    </header>
  );
}
