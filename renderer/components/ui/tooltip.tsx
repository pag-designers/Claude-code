'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

export function TooltipProvider({
  delayDuration = 350,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200} {...props} />
  );
}

export function TooltipContent({
  className,
  sideOffset = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[100] max-w-72 rounded-md border border-border-strong bg-raised px-2.5 py-1.5 text-xs font-medium leading-4 text-foreground shadow-md',
          'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

interface TipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Skip the tooltip entirely (e.g. labels only needed when the sidebar is collapsed). */
  disabled?: boolean;
}

/** Convenience wrapper: `<Tip content="Save"><Button/></Tip>`. */
export function Tip({ content, children, side = 'top', align = 'center', disabled }: TipProps) {
  if (disabled || !content) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );
}

/**
 * Disabled controls swallow pointer events, so a tooltip needs a focusable wrapper.
 * Use for "Coming in a later version" style explanations: keyboard users can focus the wrapper and read the reason.
 */
export function DisabledTip({
  reason,
  children,
  side = 'top',
  className,
}: {
  reason: React.ReactNode;
  children: React.ReactNode;
  side?: TipProps['side'];
  className?: string;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <span
          tabIndex={0}
          className={cn('inline-flex rounded-md focus-visible:outline-offset-1', className)}
        >
          {children}
        </span>
      </TooltipPrimitive.Trigger>
      <TooltipContent side={side}>{reason}</TooltipContent>
    </TooltipPrimitive.Root>
  );
}
