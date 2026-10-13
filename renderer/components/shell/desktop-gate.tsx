'use client';

import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { LogoMark } from '@/components/ui/logo';

type Bridge = 'checking' | 'ready' | 'missing';

function useBridge(): Bridge {
  return useSyncExternalStore(
    () => () => {},
    () => (window.clipfern ? 'ready' : 'missing'),
    () => 'checking',
  );
}

/** Renders children only inside the Electron app; a plain browser gets a clear notice instead of a crash. */
export function DesktopGate({ children }: { children: React.ReactNode }) {
  const bridge = useBridge();
  if (bridge === 'checking') return <div className="h-dvh bg-background" aria-hidden />;
  if (bridge === 'missing') return <DesktopRequired />;
  return <>{children}</>;
}

function DesktopRequired() {
  return (
    <main className="bg-dots flex h-dvh items-center justify-center bg-background p-8">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <LogoMark className="size-14" />
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-semibold">Open Clipfern&apos;s desktop app</h1>
          <p className="text-base text-muted-foreground text-balance">
            This page is the interface of the Clipfern desktop app. It talks to your local engine,
            your keychain and your files, so it can&apos;t run in a regular browser tab.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-sm text-muted-foreground">
          <MonitorSmartphone className="size-4 text-primary-text" aria-hidden />
          Launch Clipfern from your Applications folder or Start menu.
        </div>
        <p className="text-xs text-subtle">
          Developers: run{' '}
          <code className="selectable rounded bg-muted px-1.5 py-0.5 font-mono">pnpm dev</code> to
          start the shell.
        </p>
      </div>
    </main>
  );
}
