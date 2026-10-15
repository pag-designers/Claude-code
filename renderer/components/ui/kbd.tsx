'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { useIsMac } from '@/lib/prefs';

const MAC: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  esc: 'Esc',
  backspace: '⌫',
};
const PC: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  esc: 'Esc',
  backspace: 'Backspace',
};

export function KbdKey({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border-strong bg-muted px-1.5 font-sans text-2xs font-medium leading-none text-muted-foreground shadow-[0_1px_0_var(--border-strong)]',
        className,
      )}
      {...props}
    />
  );
}

/** `<Kbd keys={['mod','K']} />` renders ⌘ K on macOS and Ctrl K elsewhere. */
export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  const mac = useIsMac();
  const map = mac ? MAC : PC;
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        <KbdKey key={`${k}-${i}`}>{map[k.toLowerCase()] ?? k}</KbdKey>
      ))}
    </span>
  );
}
