'use client';

import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Accessible checkbox button (role=checkbox) with an indeterminate state. */
export function Checkbox({
  checked,
  onCheckedChange,
  indeterminate,
  className,
  onClick,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onChange'> & {
  checked: boolean;
  indeterminate?: boolean;
  /** Receives the click event so callers can read `shiftKey` for range selection. */
  onCheckedChange?: (checked: boolean, e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={(e) => {
        onClick?.(e);
        onCheckedChange?.(!checked, e);
      }}
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-field text-primary-foreground transition-[background-color,border-color] duration-(--duration-fast)',
        'hover:border-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary aria-[checked=mixed]:border-primary aria-[checked=mixed]:bg-primary',
        className,
      )}
      {...props}
    >
      {indeterminate ? (
        <Minus className="size-3" strokeWidth={3} aria-hidden />
      ) : checked ? (
        <Check className="size-3" strokeWidth={3} aria-hidden />
      ) : null}
    </button>
  );
}
