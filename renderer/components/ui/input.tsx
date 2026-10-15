import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends Omit<React.ComponentProps<'input'>, 'prefix'> {
  invalid?: boolean;
  /** Decorative node pinned inside the left edge (icon). */
  leading?: React.ReactNode;
  /** Node pinned inside the right edge (button, unit, badge). */
  trailing?: React.ReactNode;
  wrapperClassName?: string;
}

export const inputBase =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-field px-3 text-sm text-foreground shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] outline-none placeholder:text-subtle transition-[border-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25';

export function Input({
  className,
  wrapperClassName,
  invalid,
  leading,
  trailing,
  type = 'text',
  ...props
}: InputProps) {
  const field = (
    <input
      type={type}
      data-slot="input"
      aria-invalid={invalid || undefined}
      className={cn(
        inputBase,
        leading ? 'pl-9' : undefined,
        trailing ? 'pr-10' : undefined,
        className,
      )}
      {...props}
    />
  );
  if (!leading && !trailing) return field;
  return (
    <div className={cn('relative flex w-full items-center', wrapperClassName)}>
      {leading ? (
        <span
          className="pointer-events-none absolute left-3 flex text-subtle [&_svg]:size-4"
          aria-hidden
        >
          {leading}
        </span>
      ) : null}
      {field}
      {trailing ? (
        <span className="absolute right-1.5 flex items-center text-subtle">{trailing}</span>
      ) : null}
    </div>
  );
}
