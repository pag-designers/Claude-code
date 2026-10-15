'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  variant = 'underline',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: 'underline' | 'pill' }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex items-center',
        variant === 'underline' ? 'gap-1 border-b' : 'gap-1 rounded-lg border bg-muted p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  variant = 'underline',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & { variant?: 'underline' | 'pill' }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium text-muted-foreground transition-colors duration-(--duration-fast)',
        'hover:text-foreground disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4',
        variant === 'underline'
          ? "relative -mb-px px-3 pb-2.5 pt-2 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-primary after:transition-transform after:duration-(--duration-base) after:ease-(--ease-standard) after:content-[''] data-[state=active]:text-foreground data-[state=active]:after:scale-x-100"
          : 'rounded-md px-3 py-1.5 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        'outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}
