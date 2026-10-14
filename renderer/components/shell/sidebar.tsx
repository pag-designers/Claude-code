'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isActivePath, NAV_ITEMS, SETTINGS_ITEM, type NavItem } from '@/lib/nav';
import { spring } from '@/lib/motion';
import { LogoMark } from '@/components/ui/logo';
import { Tip } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { useSidebar } from '@/lib/shell';
import { StorageIndicator } from './storage-indicator';

function NavLink({
  item,
  index,
  collapsed,
}: {
  item: NavItem;
  index?: number;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const active = isActivePath(pathname, item.href);
  const Icon = item.icon;
  return (
    <Tip
      side="right"
      disabled={!collapsed}
      content={
        <span className="flex items-center gap-2">
          {item.label}
          {index !== undefined ? <Kbd keys={['mod', String(index + 1)]} /> : null}
        </span>
      }
    >
      <Link
        href={item.href}
        prefetch={item.href === "/editor/" ? false : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative flex h-9 items-center gap-3 rounded-md px-[13px] text-sm font-medium outline-offset-0 transition-colors duration-(--duration-fast)',
          active
            ? 'text-foreground'
            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
        )}
      >
        {active ? (
          <motion.span
            layoutId="nav-active"
            transition={spring.snappy}
            className="absolute inset-0 rounded-md bg-primary-soft"
            aria-hidden
          >
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary-text" />
          </motion.span>
        ) : null}
        <Icon
          className={cn(
            'relative size-[18px] shrink-0 transition-colors',
            active ? 'text-primary-text' : 'text-subtle group-hover:text-foreground',
          )}
          strokeWidth={active ? 2.1 : 1.8}
          aria-hidden
        />
        <span className="relative truncate transition-opacity duration-(--duration-base) collapsed:opacity-0">
          {item.label}
        </span>
      </Link>
    </Tip>
  );
}

export function Sidebar() {
  const { collapsed, toggle } = useSidebar();
  return (
    <aside
      aria-label="Primary"
      className="shell-sidebar relative z-10 flex h-full shrink-0 flex-col overflow-hidden border-r bg-sidebar"
    >
      <div className="shell-sidebar-head flex h-12 shrink-0 items-center gap-3 px-[18px] box-content">
        <LogoMark className="size-8 shrink-0" />
        <span className="font-display text-lg font-semibold tracking-tight transition-opacity duration-(--duration-base) collapsed:opacity-0">
          Clipfern
        </span>
      </div>

      <nav
        aria-label="Main"
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-3"
      >
        {NAV_ITEMS.map((item, i) => (
          <NavLink key={item.href} item={item} index={i} collapsed={collapsed} />
        ))}
      </nav>

      <div className="flex shrink-0 flex-col gap-0.5 px-3 pb-3 pt-2">
        <NavLink item={SETTINGS_ITEM} index={NAV_ITEMS.length} collapsed={collapsed} />
        <Tip
          side="right"
          disabled={!collapsed}
          content={
            <span className="flex items-center gap-2">
              Expand sidebar <Kbd keys={['mod', 'B']} />
            </span>
          }
        >
          <button
            type="button"
            onClick={toggle}
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="group flex h-9 items-center gap-3 rounded-md px-[13px] text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen
                className="size-[18px] shrink-0 text-subtle group-hover:text-foreground"
                aria-hidden
              />
            ) : (
              <PanelLeftClose
                className="size-[18px] shrink-0 text-subtle group-hover:text-foreground"
                aria-hidden
              />
            )}
            <span className="flex flex-1 items-center justify-between transition-opacity duration-(--duration-base) collapsed:opacity-0">
              Collapse <Kbd keys={['mod', 'B']} />
            </span>
          </button>
        </Tip>
        <div className="mt-2">
          <StorageIndicator />
        </div>
      </div>
    </aside>
  );
}
