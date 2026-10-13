'use client';

import * as React from 'react';
import Link from 'next/link';
import { CloudOff, RefreshCw, Sparkles } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DisabledTip } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Banner } from '@/components/ui/banner';
import { Badge } from '@/components/ui/badge';
import { invoke, ipcKey } from '@/lib/ipc';
import { STORAGE_PAYLOAD, useStorageUsage } from '@/lib/queries';
import { useSettings } from '@/lib/settings';
import { useUi } from '@/lib/store';
import { formatBytes, formatGb, formatUsd, timeAgo } from '@/lib/format';
import { CATEGORY_META, gbUnit, providerName, storageTone } from '@/lib/storage';
import type { StorageUsage } from '@shared/domain';

export function StorageDialog() {
  const open = useUi((s) => s.storageDialogOpen);
  const setOpen = useUi((s) => s.setStorageDialogOpen);
  const { data, isPending } = useStorageUsage();
  const { settings } = useSettings();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await invoke('storage:usage', { refresh: true });
      qc.setQueryData(ipcKey('storage:usage', STORAGE_PAYLOAD), fresh);
    } catch (e) {
      toast.error('Could not refresh storage', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">Cloud storage</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {data ? providerName(data.provider) : 'Cloudflare R2 or Backblaze B2'} · videos never
            live on your disk permanently.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {isPending ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Reading bucket usage…</p>
          ) : !data?.configured ? (
            <NotConfigured freeTierGb={settings.storageFreeTierGb} onClose={() => setOpen(false)} />
          ) : (
            <Breakdown usage={data} freeTierGb={settings.storageFreeTierGb} />
          )}
        </DialogBody>
        {data?.configured ? (
          <DialogFooter className="justify-between">
            <span className="text-xs text-muted-foreground">
              {data.updatedAt ? `Updated ${timeAgo(data.updatedAt)}` : 'Not refreshed yet'}
            </span>
            <div className="flex items-center gap-2">
              <DisabledTip reason="Cleanup plans arrive in a later checkpoint" side="top">
                <Button variant="outline" disabled>
                  <Sparkles /> Free up space
                </Button>
              </DisabledTip>
              <Button onClick={refresh} loading={refreshing}>
                <RefreshCw /> Refresh
              </Button>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NotConfigured({ freeTierGb, onClose }: { freeTierGb: number; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4 rounded-xl border border-dashed border-border-strong bg-muted/40 p-5">
        <ProgressRing value={0} size={56} stroke={5} dashed>
          <CloudOff className="size-5 text-subtle" aria-hidden />
        </ProgressRing>
        <div>
          <p className="font-display text-lg font-semibold">Not configured</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect Cloudflare R2 in Settings to store videos, clips and renders. Clipfern stays
            inside the free tier by design.
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-3 text-sm text-muted-foreground">
        <li className="flex gap-3">
          <Badge variant="primary">1</Badge>
          <span>
            Create a free bucket in Cloudflare R2 (or Backblaze B2):{' '}
            <strong className="text-foreground">{freeTierGb} GB free</strong>, no egress fees.
          </span>
        </li>
        <li className="flex gap-3">
          <Badge variant="primary">2</Badge>
          <span>
            Create an API token with read &amp; write access to that bucket and paste it in Settings
            → Storage.
          </span>
        </li>
        <li className="flex gap-3">
          <Badge variant="primary">3</Badge>
          <span>
            Press Test connection. Usage, free-tier headroom and projected cost appear here.
          </span>
        </li>
      </ul>
      <Button variant="primary" asChild className="self-start">
        <Link href="/settings/storage/" onClick={onClose}>
          Connect storage in Settings
        </Link>
      </Button>
    </div>
  );
}

function Breakdown({ usage, freeTierGb }: { usage: StorageUsage; freeTierGb: number }) {
  const unit = gbUnit(usage.limitBytes, freeTierGb);
  const tone = storageTone(usage);
  const total = Math.max(usage.usedBytes, 1);
  const rows = CATEGORY_META.map((c) => ({ ...c, bytes: usage.breakdown[c.key] ?? 0 }));
  const over = usage.usedBytes > usage.limitBytes;
  return (
    <div className="flex flex-col gap-6">
      {usage.error ? (
        <Banner tone="danger" title="Couldn't read the bucket">
          {usage.error}
        </Banner>
      ) : null}
      <div className="flex items-center gap-5">
        <ProgressRing value={usage.fraction} size={88} stroke={8} tone={tone}>
          <span className="font-display text-xl font-semibold tabular-nums">
            {Math.round(usage.fraction * 100)}%
          </span>
        </ProgressRing>
        <div className="min-w-0">
          <p className="font-display text-3xl font-semibold tabular-nums leading-none">
            {formatGb(usage.usedBytes, unit)}{' '}
            <span className="text-lg font-medium text-muted-foreground">GB</span>
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            of {Math.round(usage.limitBytes / unit)} GB free tier ·{' '}
            {usage.objectCount.toLocaleString()} objects
          </p>
          {tone !== 'primary' ? (
            <Badge variant={tone === 'danger' ? 'danger' : 'warning'} className="mt-2">
              {over
                ? 'Over the free tier'
                : tone === 'danger'
                  ? 'Almost full'
                  : 'Above 80% of free tier'}
            </Badge>
          ) : null}
        </div>
      </div>

      <div>
        <div
          className="mb-2 flex h-2.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label="Storage breakdown by category"
        >
          {rows.map((r) =>
            r.bytes > 0 ? (
              <span
                key={r.key}
                style={{ width: `${(r.bytes / total) * 100}%`, background: r.color }}
                title={`${r.label}: ${formatBytes(r.bytes)}`}
              />
            ) : null,
          )}
        </div>
        <ul className="divide-y rounded-xl border">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: r.color }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-5">{r.label}</p>
                <p className="truncate text-xs text-subtle">{r.hint}</p>
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatBytes(r.bytes)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="text-xs font-medium text-muted-foreground">Projected monthly cost</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {formatUsd(usage.projectedMonthlyUsd)}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {usage.projectedMonthlyUsd === 0
              ? 'Within the free tier.'
              : 'Storage above the free tier (about $0.015 per GB-month).'}
          </p>
        </div>
        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="text-xs font-medium text-muted-foreground">Free headroom</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {formatGb(Math.max(0, usage.limitBytes - usage.usedBytes), unit)} GB
          </p>
          <p className="mt-1 text-xs text-subtle">
            Keeping sources as 480p proxies (the default) uses a fraction of full-resolution size.
          </p>
        </div>
      </div>
    </div>
  );
}
