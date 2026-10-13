'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-border-strong p-0.5 transition-colors duration-(--duration-fast) ease-(--ease-standard)',
        'data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform duration-(--duration-base) ease-(--ease-spring) data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
