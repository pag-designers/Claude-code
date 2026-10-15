'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { ClientRoot } from './client-root';

const subscribe = () => () => {};

/**
 * The whole interface depends on `window.clipfern` (Electron preload) and the user's theme, so
 * nothing meaningful can be prerendered. This gate renders a static placeholder for the server
 * HTML AND for the hydration pass (React uses the *server* snapshot while hydrating), then switches
 * to the real UI. Unlike `next/dynamic({ ssr: false })`, a cached chunk can never make the client
 * render the full tree during hydration, so React error #418 cannot occur.
 */
export function ClientRootLazy({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (!mounted) return <div className="h-dvh bg-background" aria-hidden />;
  return <ClientRoot>{children}</ClientRoot>;
}
