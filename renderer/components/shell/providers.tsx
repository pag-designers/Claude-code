'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { toast } from 'sonner';
import type { JobView } from '@shared/domain';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ipcKey, useIpcEvent } from '@/lib/ipc';
import { JOBS_PAYLOAD, STORAGE_PAYLOAD } from '@/lib/queries';
import { useSettings } from '@/lib/settings';
import { applySidebarCollapsed, applyTheme, getThemePref } from '@/lib/prefs';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: true, gcTime: 5 * 60_000 },
      mutations: { retry: 0 },
    },
  });
}

/** Pushes main→renderer events into the query cache so every view updates live. */
function EventBridge() {
  const qc = useQueryClient();
  const router = useRouter();

  useIpcEvent('settings:changed', (s) => qc.setQueryData(ipcKey('settings:get'), s));
  useIpcEvent('storage:updated', (u) =>
    qc.setQueryData(ipcKey('storage:usage', STORAGE_PAYLOAD), u),
  );
  useIpcEvent('sidecar:progress', (s) => qc.setQueryData(ipcKey('sidecar:status'), s));
  useIpcEvent('jobs:updated', (job) => {
    qc.setQueryData<{ items: JobView[] }>(ipcKey('jobs:list', JOBS_PAYLOAD), (old) => {
      const items = old?.items ?? [];
      const next = items.some((j) => j.id === job.id)
        ? items.map((j) => (j.id === job.id ? job : j))
        : [job, ...items];
      return { items: next.sort((a, b) => b.createdAt - a.createdAt) };
    });
    if (job.status === 'succeeded' || job.status === 'failed')
      void qc.invalidateQueries({ queryKey: ['cost:summary'] });
  });
  useIpcEvent('notifications:new', (n) => {
    void qc.invalidateQueries({ queryKey: ['notifications:list'] });
    const opts = {
      id: n.id,
      description: n.body ?? undefined,
      action: n.href ? { label: 'View', onClick: () => router.push(n.href as string) } : undefined,
    };
    if (n.level === 'error') toast.error(n.title, opts);
    else if (n.level === 'warning') toast.warning(n.title, opts);
    else if (n.level === 'success') toast.success(n.title, opts);
    else toast.info(n.title, opts);
  });
  useIpcEvent('nav:go', ({ href }) => router.push(href));
  return null;
}

/** Settings are the source of truth for theme + sidebar; localStorage only exists so first paint is right. */
function PrefsSync() {
  const { settings, ready } = useSettings();
  React.useEffect(() => {
    if (!ready) return;
    if (settings.theme !== getThemePref()) applyTheme(settings.theme);
    if (settings.sidebarCollapsed !== (document.documentElement.dataset.sidebar === 'collapsed')) {
      applySidebarCollapsed(settings.sidebarCollapsed);
    }
  }, [ready, settings.theme, settings.sidebarCollapsed]);

  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getThemePref() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}

/** Mounted only once the desktop bridge exists. */
export function LiveBindings() {
  return (
    <>
      <EventBridge />
      <PrefsSync />
    </>
  );
}
