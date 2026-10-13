'use client';

import * as React from 'react';
import { AppShell } from './app-shell';
import { DesktopGate } from './desktop-gate';
import { LiveBindings, Providers } from './providers';

export function ClientRoot({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <DesktopGate>
        <LiveBindings />
        <AppShell>{children}</AppShell>
      </DesktopGate>
    </Providers>
  );
}
