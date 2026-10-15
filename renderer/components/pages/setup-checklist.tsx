'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Cpu,
  HardDrive,
  KeyRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useBinaries, useSidecarStatus, useStorageUsage } from '@/lib/queries';
import { useSecrets } from '@/lib/settings';
import { settingsHref } from '@/lib/nav';

type State = 'loading' | 'done' | 'todo' | 'problem';
interface Item {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  state: State;
  href: string;
  action: string;
}

/** Reads REAL state from main: secrets, bucket, binaries and the sidecar. */
export function SetupChecklist() {
  const secrets = useSecrets();
  const storage = useStorageUsage();
  const bins = useBinaries();
  const sidecar = useSidecarStatus();

  const items: Item[] = [];

  const anthropic = secrets.keys?.['anthropic.apiKey'];
  items.push({
    id: 'anthropic',
    icon: KeyRound,
    title: 'Anthropic API key',
    detail: secrets.loading
      ? ''
      : anthropic?.set
        ? `Saved ${anthropic.masked ?? ''}${anthropic.source === 'env' ? ' (from .env)' : ''}`
        : 'Powers moment-finding, hooks and scoring. The only paid service.',
    state: secrets.loading
      ? 'loading'
      : secrets.error
        ? 'problem'
        : anthropic?.set
          ? 'done'
          : 'todo',
    href: `${settingsHref('api-keys')}`,
    action: 'Add key',
  });

  items.push({
    id: 'storage',
    icon: HardDrive,
    title: 'Cloud storage connected',
    detail: storage.isPending
      ? ''
      : storage.data?.configured
        ? storage.data.error
          ? `Connected, but: ${storage.data.error}`
          : `${storage.data.provider === 'b2' ? 'Backblaze B2' : 'Cloudflare R2'} bucket reachable`
        : 'Videos and clips live in your free R2 or B2 bucket, not on disk.',
    state: storage.isPending
      ? 'loading'
      : storage.data?.configured
        ? storage.data.error
          ? 'problem'
          : 'done'
        : 'todo',
    href: settingsHref('storage'),
    action: storage.data?.configured ? 'Fix' : 'Connect',
  });

  const tools = bins.data?.tools ?? [];
  const needed = ['ffmpeg', 'ffprobe', 'yt-dlp'];
  const found = needed.map((n) => tools.find((t) => t.name.toLowerCase() === n));
  const missing = needed.filter((n, i) => !found[i]?.ok);
  items.push({
    id: 'binaries',
    icon: Wrench,
    title: 'ffmpeg and yt-dlp',
    detail: bins.isPending
      ? ''
      : bins.isError
        ? 'Could not check media tools.'
        : missing.length === 0
          ? found.map((t) => `${t?.name} ${t?.version ?? ''}`.trim()).join(' · ')
          : `Not working: ${missing.join(', ')}`,
    state: bins.isPending ? 'loading' : bins.isError || missing.length ? 'problem' : 'done',
    href: settingsHref('diagnostics'),
    action: 'Diagnose',
  });

  const sc = sidecar.data;
  const scReady = !!sc?.installed && !!sc.modelReady;
  items.push({
    id: 'sidecar',
    icon: Cpu,
    title: 'Transcription engine',
    detail: sidecar.isPending
      ? ''
      : scReady
        ? `Whisper ${sc?.model} ready${sc?.device ? ` on ${sc.device}` : ''}`
        : sc?.phase === 'error'
          ? (sc.error ?? 'Setup failed.')
          : sc && ['idle', 'stopped'].includes(sc.phase)
            ? 'Local Whisper turns speech into word-timed transcripts. One-time install.'
            : (sc?.message ?? 'Setting up…'),
    state: sidecar.isPending
      ? 'loading'
      : scReady
        ? 'done'
        : sc?.phase === 'error'
          ? 'problem'
          : 'todo',
    href: settingsHref('compute'),
    action:
      sc && !['idle', 'stopped', 'error'].includes(sc.phase) && !scReady
        ? 'View progress'
        : 'Set up',
  });

  const done = items.filter((i) => i.state === 'done').length;
  const loading = items.some((i) => i.state === 'loading');

  return (
    <Card>
      <CardHeader className="gap-3 pb-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="font-display text-lg">Setup checklist</CardTitle>
            <CardDescription>
              {loading
                ? 'Checking your setup…'
                : done === items.length
                  ? 'Everything is ready. Paste a URL to begin.'
                  : 'Finish these to run the full pipeline.'}
            </CardDescription>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
            {loading ? '…' : `${done} / ${items.length}`}
          </span>
        </div>
        <Progress
          value={loading ? 0 : (done / items.length) * 100}
          tone={done === items.length ? 'success' : 'primary'}
          className="h-1.5"
          aria-label="Setup progress"
        />
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-3">
        <ul className="flex flex-col">
          {items.map((it) => (
            <li key={it.id}>
              <ChecklistRow item={it} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ChecklistRow({ item }: { item: Item }) {
  const Icon = item.icon;
  return (
    <div className="flex items-center gap-3 rounded-lg px-2.5 py-2.5">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full border',
          item.state === 'done' && 'border-transparent bg-success-soft text-success',
          item.state === 'problem' && 'border-transparent bg-danger-soft text-danger',
          (item.state === 'todo' || item.state === 'loading') &&
            'border-border-strong bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {item.state === 'done' ? (
          <Check className="size-4" />
        ) : item.state === 'problem' ? (
          <CircleAlert className="size-4" />
        ) : (
          <Icon className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-semibold leading-5">
          {item.title}
          <span className="sr-only">
            {item.state === 'done'
              ? '(done)'
              : item.state === 'problem'
                ? '(needs attention)'
                : '(not done)'}
          </span>
        </p>
        {item.state === 'loading' ? (
          <Skeleton className="mt-1.5 h-3 w-44" />
        ) : (
          <p
            className={cn(
              'line-clamp-2 text-xs leading-4',
              item.state === 'problem' ? 'text-danger' : 'text-muted-foreground',
            )}
          >
            {item.detail}
          </p>
        )}
      </div>
      {item.state === 'todo' || item.state === 'problem' ? (
        <Button asChild size="sm" variant={item.state === 'todo' ? 'soft' : 'outline'}>
          <Link href={item.href}>
            {item.action} <ArrowRight />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
