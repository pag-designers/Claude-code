'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { SETTINGS_SECTIONS, settingsHref } from '@/lib/nav';
import { Page } from '@/components/ui/page';

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <Page className="grid grid-cols-[212px_minmax(0,1fr)] items-start gap-10 max-[1000px]:grid-cols-1">
      <nav
        aria-label="Settings sections"
        className="sticky top-8 flex flex-col gap-0.5 max-[1000px]:static max-[1000px]:flex-row max-[1000px]:flex-wrap"
      >
        {SETTINGS_SECTIONS.map((s) => {
          const active = pathname.startsWith(settingsHref(s.slug).slice(0, -1));
          return (
            <Link
              key={s.slug}
              href={settingsHref(s.slug)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary-soft text-foreground'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
              )}
            >
              <s.icon
                className={cn('size-4', active ? 'text-primary-text' : 'text-subtle')}
                aria-hidden
              />
              {s.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex min-w-0 max-w-[820px] flex-col gap-6">{children}</div>
    </Page>
  );
}

export function SettingsHeading({ title, description }: { title: string; description: string }) {
  return (
    <header>
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <p className="mt-1 text-base text-muted-foreground">{description}</p>
    </header>
  );
}
