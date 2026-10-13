'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  CheckCheck,
  CornerDownLeft,
  HardDrive,
  Monitor,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  Sun,
  FileDown,
  type LucideIcon,
} from 'lucide-react';
import { ALL_NAV, NOTIFICATIONS_ITEM, SETTINGS_SECTIONS, settingsHref } from '@/lib/nav';
import { TOOLS, toolHint } from '@/lib/tools';
import { invoke, ipcKey } from '@/lib/ipc';
import { STORAGE_PAYLOAD } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { useSidebar, useTheme } from '@/lib/shell';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

/** Predictable ranking: label prefix > label substring > all words in label > words in label or keywords. */
function rank(value: string, search: string, keywords?: string[]): number {
  const q = search.toLowerCase().trim();
  if (!q) return 1;
  const v = value.toLowerCase();
  if (v.startsWith(q)) return 1;
  if (v.includes(q)) return 0.8;
  const words = q.split(/\s+/);
  if (words.every((w) => v.includes(w))) return 0.7;
  const k = (keywords ?? []).join(' ').toLowerCase();
  return words.every((w) => v.includes(w) || k.includes(w)) ? 0.5 : 0;
}

function Item({
  icon: Icon,
  label,
  hint,
  keywords,
  onSelect,
  disabled,
  shortcut,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  keywords?: string[];
  onSelect?: () => void;
  disabled?: boolean;
  shortcut?: string[];
}) {
  return (
    <Command.Item
      value={label}
      keywords={keywords}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'group flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none',
        'data-[selected=true]:bg-accent data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50',
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-data-[selected=true]:text-primary-text">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex-1 truncate font-medium">{label}</span>
      {hint ? <span className="truncate text-xs text-subtle">{hint}</span> : null}
      {shortcut ? <Kbd keys={shortcut} /> : null}
    </Command.Item>
  );
}

/** ⌘/Ctrl+K: jump to any page, tool or setting, or run an action. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const setStorageOpen = useUi((s) => s.setStorageDialogOpen);
  const router = useRouter();
  const qc = useQueryClient();
  const { pref, setTheme } = useTheme();
  const { collapsed, toggle } = useSidebar();
  const run = (fn: () => void | Promise<void>) => () => {
    setOpen(false);
    void Promise.resolve(fn()).catch((e: unknown) =>
      toast.error('Action failed', { description: e instanceof Error ? e.message : undefined }),
    );
  };
  const go = (href: string) => run(() => router.push(href));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="app-no-drag fixed inset-0 z-[70] bg-(--overlay) backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          className="app-no-drag fixed left-1/2 top-[14vh] z-[70] w-[min(640px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border-strong bg-popover shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type to search pages, tools and settings, or run an action.
          </DialogPrimitive.Description>
          <Command label="Command palette" loop filter={rank}>
            <div className="flex items-center gap-3 border-b px-4">
              <Search className="size-4 shrink-0 text-subtle" aria-hidden />
              <Command.Input
                placeholder="Jump to a page, tool or setting, or run an action…"
                className="h-13 w-full bg-transparent text-md text-foreground outline-none placeholder:text-subtle"
              />
              <Kbd keys={['esc']} />
            </div>
            <Command.List className="scrollbar-thin max-h-[min(440px,60vh)] overflow-y-auto p-2">
              <Command.Empty className="px-4 py-10 text-center text-sm text-muted-foreground">
                Nothing matches. Try a page name like “library” or a setting like “cache”.
              </Command.Empty>

              <Command.Group heading="Go to">
                {ALL_NAV.map((n, i) => (
                  <Item
                    key={n.href}
                    icon={n.icon}
                    label={n.label}
                    hint={n.description}
                    shortcut={['mod', String(i + 1)]}
                    onSelect={go(n.href)}
                    keywords={['page', 'open']}
                  />
                ))}
                <Item
                  icon={NOTIFICATIONS_ITEM.icon}
                  label="Notifications"
                  hint={NOTIFICATIONS_ITEM.description}
                  onSelect={go(NOTIFICATIONS_ITEM.href)}
                  keywords={['bell', 'alerts', 'inbox']}
                />
              </Command.Group>

              <Command.Group heading="Actions">
                <Item
                  icon={Moon}
                  label="Theme: Dark"
                  hint={pref === 'dark' ? 'Current' : undefined}
                  onSelect={run(() => setTheme('dark'))}
                  keywords={['appearance', 'night']}
                />
                <Item
                  icon={Sun}
                  label="Theme: Light"
                  hint={pref === 'light' ? 'Current' : undefined}
                  onSelect={run(() => setTheme('light'))}
                  keywords={['appearance', 'day']}
                />
                <Item
                  icon={Monitor}
                  label="Theme: Match system"
                  hint={pref === 'system' ? 'Current' : undefined}
                  onSelect={run(() => setTheme('system'))}
                  keywords={['appearance', 'auto']}
                />
                <Item
                  icon={PanelLeft}
                  label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  shortcut={['mod', 'B']}
                  onSelect={run(toggle)}
                />
                <Item
                  icon={HardDrive}
                  label="Open storage manager"
                  hint="Usage, breakdown, cost"
                  onSelect={run(() => setStorageOpen(true))}
                  keywords={['r2', 'bucket', 'space']}
                />
                <Item
                  icon={RefreshCw}
                  label="Refresh storage usage"
                  hint="Re-count the bucket"
                  keywords={['r2', 'bucket', 'reload']}
                  onSelect={run(async () => {
                    const fresh = await invoke('storage:usage', { refresh: true });
                    qc.setQueryData(ipcKey('storage:usage', STORAGE_PAYLOAD), fresh);
                    toast.success('Storage usage refreshed');
                  })}
                />
                <Item
                  icon={CheckCheck}
                  label="Mark all notifications as read"
                  keywords={['clear', 'bell']}
                  onSelect={run(async () => {
                    await invoke('notifications:markAllRead');
                    await qc.invalidateQueries({ queryKey: ['notifications:list'] });
                  })}
                />
                <Item
                  icon={FileDown}
                  label="Export diagnostic logs"
                  keywords={['debug', 'support']}
                  onSelect={run(async () => {
                    const r = await invoke('diagnostics:exportLogs');
                    if (r.saved)
                      toast.success('Logs exported', { description: r.path ?? undefined });
                  })}
                />
              </Command.Group>

              <Command.Group heading="Settings">
                {SETTINGS_SECTIONS.map((s) => (
                  <Item
                    key={s.slug}
                    icon={s.icon}
                    label={`Settings: ${s.label}`}
                    hint={s.description}
                    keywords={s.keywords}
                    onSelect={go(settingsHref(s.slug))}
                  />
                ))}
              </Command.Group>

              <Command.Group heading="Tools">
                {TOOLS.map((t) => (
                  <Item
                    key={t.id}
                    icon={t.icon}
                    label={t.name}
                    hint={toolHint(t)}
                    disabled
                    keywords={['tool']}
                  />
                ))}
              </Command.Group>
            </Command.List>
            <div className="flex items-center justify-between border-t bg-card/60 px-4 py-2 text-2xs text-subtle">
              <span className="inline-flex items-center gap-1.5">
                <ArrowRight className="size-3" aria-hidden /> Navigate with arrow keys
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CornerDownLeft className="size-3" aria-hidden /> Select
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
