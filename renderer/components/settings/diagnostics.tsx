'use client';

import * as React from 'react';
import { Check, Copy, FileDown, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { invoke, useIpcMutation, useIpcQuery } from '@/lib/ipc';
import { useBinaries } from '@/lib/queries';
import { useSecrets } from '@/lib/settings';
import { SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

const TOOL_LABEL: Record<string, string> = {
  ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe',
  'yt-dlp': 'yt-dlp',
  uv: 'uv',
  python: 'Python (sidecar)',
};

function BinariesCard() {
  const { data, isPending, isError, refetch, isFetching } = useBinaries();
  const update = useIpcMutation('binaries:updateYtdlp', {
    invalidate: ['binaries:status'],
    onSuccess: (t) =>
      t.ok
        ? toast.success('yt-dlp updated', { description: t.version ?? undefined })
        : toast.error('yt-dlp update failed', { description: t.error ?? undefined }),
    onError: (e) => toast.error('yt-dlp update failed', { description: e.message }),
  });
  return (
    <SettingsCard
      title="Tools and versions"
      description="Everything Clipfern shells out to. Green means found and working."
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate(undefined)}
            loading={update.isPending}
          >
            <RefreshCw /> Update yt-dlp
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Re-check tools"
            onClick={() => void refetch()}
            loading={isFetching}
          >
            <RefreshCw />
          </Button>
        </div>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-danger">Could not check tools.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-subtle">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Tool
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Version
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">
                  Source
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.tools.map((t) => (
                <tr key={t.name} className="[&>*]:align-middle">
                  <th scope="row" className="px-4 py-3 font-medium">
                    {TOOL_LABEL[t.name.toLowerCase()] ?? t.name}
                    {t.path ? (
                      <span
                        className="selectable mt-0.5 block max-w-64 truncate font-mono text-2xs font-normal text-subtle"
                        title={t.path}
                      >
                        {t.path}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-4 py-3">
                    {t.ok ? (
                      <Badge variant="success">
                        <Check /> Working
                      </Badge>
                    ) : (
                      <Badge variant="danger">
                        <TriangleAlert /> Problem
                      </Badge>
                    )}
                    {t.error ? (
                      <p className="mt-1 max-w-56 text-xs text-danger">{t.error}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums text-muted-foreground selectable">
                    {t.version ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}

function AppInfoCard() {
  const { data, isPending } = useIpcQuery('app:info', undefined, { staleTime: Infinity });
  const [exporting, setExporting] = React.useState(false);
  const exportLogs = async () => {
    setExporting(true);
    try {
      const r = await invoke('diagnostics:exportLogs');
      if (r.saved) toast.success('Logs exported', { description: r.path ?? undefined });
    } catch (e) {
      toast.error('Could not export logs', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  };
  const rows: [string, string][] = data
    ? [
        ['Version', `${data.name} ${data.version}${data.isPackaged ? '' : ' (development build)'}`],
        ['Platform', `${data.platform} · ${data.arch}`],
        ['Electron', data.electron],
        ['Chromium', data.chrome],
        ['Node.js', data.node],
      ]
    : [];
  return (
    <SettingsCard
      title="About this install"
      description="Include these details and the log export when you report a problem."
      action={
        <Button variant="outline" size="sm" onClick={exportLogs} loading={exporting}>
          <FileDown /> Export logs
        </Button>
      }
    >
      {isPending || !data ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <dl className="grid grid-cols-[120px_1fr] gap-x-6 gap-y-2.5 text-sm">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="selectable font-medium tabular-nums">{v}</dd>
            </React.Fragment>
          ))}
          <dt className="text-muted-foreground">Data folder</dt>
          <dd className="flex items-center gap-2">
            <span
              className="selectable truncate font-mono text-xs text-muted-foreground"
              title={data.userData}
            >
              {data.userData}
            </span>
            <Tip content="Copy path">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy data folder path"
                onClick={() => {
                  void navigator.clipboard?.writeText(data.userData).then(
                    () => toast.success('Path copied'),
                    () => toast.error('Clipboard unavailable'),
                  );
                }}
              >
                <Copy />
              </Button>
            </Tip>
          </dd>
        </dl>
      )}
    </SettingsCard>
  );
}

export function DiagnosticsSettings() {
  const { backend } = useSecrets();
  return (
    <>
      <SettingsHeading
        title="Diagnostics"
        description="Check that the pieces Clipfern depends on are installed and healthy."
      />
      {backend === 'insecure-fallback' ? (
        <Banner tone="warning" title="Secrets are not protected by an OS keychain">
          This system has no usable keychain (macOS Keychain, Windows DPAPI, or libsecret/KWallet on
          Linux), so API keys are only obfuscated on disk. Run Clipfern in a normal desktop session
          to store keys securely.
        </Banner>
      ) : null}
      <BinariesCard />
      <AppInfoCard />
    </>
  );
}
