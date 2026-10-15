import * as React from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(
        'animate-shimmer rounded-md bg-[linear-gradient(100deg,var(--muted)_30%,var(--accent)_50%,var(--muted)_70%)] bg-[length:200%_100%]',
        className,
      )}
      {...props}
    />
  );
}
