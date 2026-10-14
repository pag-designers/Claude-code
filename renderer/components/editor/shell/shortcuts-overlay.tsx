'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KbdKey } from '@/components/ui/kbd';
import { useIsMac } from '@/lib/prefs';
import { SHORTCUTS, type ShortcutDef } from '@/lib/editor/core';

const GROUP_ORDER: ShortcutDef['group'][] = [
  'Transport',
  'Edit',
  'Selection',
  'Timeline',
  'View',
  'Project',
];

/** Clipboard-style display: ⌘ on macOS, Ctrl elsewhere. */
export function displayKey(k: string, mac: boolean): string {
  if (k === '⌘' || k.toLowerCase() === 'mod') return mac ? '⌘' : 'Ctrl';
  if (k === '⌥' || k.toLowerCase() === 'alt') return mac ? '⌥' : 'Alt';
  if (k === '⇧' || k.toLowerCase() === 'shift') return mac ? '⇧' : 'Shift';
  return k;
}

export function ShortcutsOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = useIsMac();
  const [query, setQuery] = React.useState('');
  const groups = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: ShortcutDef) =>
      !q ||
      s.label.toLowerCase().includes(q) ||
      s.group.toLowerCase().includes(q) ||
      s.keys.some((k) => displayKey(k, mac).toLowerCase().includes(q));
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: SHORTCUTS.filter((s) => s.group === g && match(s)),
    })).filter((g) => g.items.length > 0);
  }, [query, mac]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl" data-testid="shortcuts-overlay">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Modeled on CapCut and Premiere. Press <KbdKey>?</KbdKey> any time to open this list.
          </DialogDescription>
          <label className="relative mt-3 block">
            <span className="sr-only">Search shortcuts</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              data-testid="shortcuts-search"
              className="h-9 w-full rounded-md border border-input bg-field pl-8 pr-3 text-sm outline-none placeholder:text-subtle focus:border-ring"
            />
          </label>
        </DialogHeader>
        <DialogBody className="py-4">
          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No shortcut matches “{query}”.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-8 gap-y-5 max-[760px]:grid-cols-1">
              {groups.map((g) => (
                <section key={g.group} aria-label={g.group}>
                  <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                    {g.group}
                  </h3>
                  <ul className="flex flex-col">
                    {g.items.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-3 rounded-md py-1.5 text-sm"
                      >
                        <span className="text-foreground">{s.label}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {s.keys.map((k, i) => (
                            <KbdKey key={`${k}-${i}`}>{displayKey(k, mac)}</KbdKey>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
