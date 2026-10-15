'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Kbd } from '@/components/ui/kbd';

export type MenuEntry =
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string }
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: React.ReactNode;
      keys?: string[];
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    };

export interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
  label: string;
}

/**
 * A light right-click menu (the UI kit has dropdowns but no context menu). Fixed-positioned at the pointer, clamped to the
 * window, `role="menu"` with arrow-key navigation; Esc / outside click / scroll / resize close it.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  if (!menu || typeof document === 'undefined') return null;
  // keyed per open: a fresh instance measures and positions itself, so no stale position can flash
  return <MenuSurface key={`${menu.x}:${menu.y}:${menu.label}`} menu={menu} onClose={onClose} />;
}

function MenuSurface({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu]);

  React.useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('wheel', close, { passive: true });
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus(),
    );
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('wheel', close);
    };
  }, [onClose]);

  const items = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [],
    );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
    e.stopPropagation();
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      data-testid="timeline-menu"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="app-no-drag fixed z-[85] min-w-52 rounded-xl border border-border-strong bg-popover p-1 text-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {menu.entries.map((e) => {
        if (e.kind === 'separator')
          return <div key={e.id} role="separator" className="-mx-1 my-1 h-px bg-border" />;
        if (e.kind === 'label')
          return (
            <div
              key={e.id}
              className="px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle"
            >
              {e.label}
            </div>
          );
        return (
          <div
            key={e.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={e.disabled || undefined}
            onClick={() => {
              if (e.disabled) return;
              onClose();
              e.onSelect();
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                if (e.disabled) return;
                onClose();
                e.onSelect();
              }
            }}
            onMouseMove={(ev) => {
              if (!e.disabled) (ev.currentTarget as HTMLElement).focus();
            }}
            className={cn(
              'flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none focus:bg-accent',
              '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
              e.danger && 'text-danger [&_svg]:text-danger',
              e.disabled && 'pointer-events-none opacity-45',
            )}
          >
            {e.icon}
            <span className="flex-1">{e.label}</span>
            {e.keys ? <Kbd keys={e.keys} /> : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
