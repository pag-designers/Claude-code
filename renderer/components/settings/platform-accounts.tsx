'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plug, PlugZap, Unplug, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Platform } from '@shared/cp2';
import type { PlatformSetup, SocialAccount } from '@shared/publish';
import { AccountAvatar } from '@/components/scheduler/platform';
import { AccountStatusChip, QuotaMeter } from '@/components/scheduler/accounts-strip';
import { ConnectControl } from '@/components/scheduler/connect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { copyText } from '@/lib/clipboard';
import { timeAgo } from '@/lib/format';
import { invoke } from '@/lib/ipc';
import { isTiktokUnaudited, PLATFORM_INFO } from '@/lib/publish/model';
import { useNowMs } from '@/lib/publish/now';
import { useAccounts, usePosts, useSchedulerStatus } from '@/lib/publish/queries';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- redirect URI row ----- */

export function RedirectUri({ uri, platform }: { uri: string; platform: Platform }) {
  const [copied, setCopied] = React.useState(false);
  const info = PLATFORM_INFO[platform];
  return (
    <div className="flex flex-col gap-1.5" data-testid={`redirect-${platform}`}>
      <p className="text-sm font-medium">Redirect URI to register</p>
      <p className="text-xs text-muted-foreground">
        Add this exact address as an authorised redirect in your {info.short} developer app. It
        never leaves your computer: {info.short} sends you back to Clipfern on this local port.
      </p>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md border bg-field px-3 py-2 font-mono text-xs text-foreground"
          data-testid="redirect-uri"
          title={uri}
        >
          {uri}
        </code>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Copy the ${info.short} redirect URI`}
          onClick={async () => {
            const ok = await copyText(uri);
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            } else
              toast.error('Could not copy', {
                description: 'Select the address and copy it by hand.',
              });
          }}
          data-testid="redirect-copy"
        >
          {copied ? <Check className="text-success" /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------------- account row ----- */

type TestOutcome =
  { phase: 'running' } | { phase: 'done'; ok: boolean; message: string; detail: string | null };

function AccountRow({
  account,
  configured,
  scheduledCount,
  onDisconnect,
}: {
  account: SocialAccount;
  configured: boolean;
  scheduledCount: number;
  onDisconnect: (a: SocialAccount) => void;
}) {
  const qc = useQueryClient();
  const now = useNowMs();
  const [test, setTest] = React.useState<TestOutcome | null>(null);
  const quota = useSchedulerStatus().data?.quota.find((q) => q.accountId === account.id);
  const unaudited = isTiktokUnaudited(account);

  const runTest = async () => {
    setTest({ phase: 'running' });
    try {
      const r = await invoke('accounts:test', { id: account.id });
      setTest({ phase: 'done', ok: r.ok, message: r.message, detail: r.detail });
      void qc.invalidateQueries({ queryKey: ['accounts:list'] });
    } catch (e) {
      setTest({
        phase: 'done',
        ok: false,
        message: e instanceof Error ? e.message : 'The test failed.',
        detail: null,
      });
    }
  };

  return (
    <li
      className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4"
      data-testid="settings-account"
      data-account-id={account.id}
      data-status={account.status}
    >
      <div className="flex flex-wrap items-center gap-3">
        <AccountAvatar account={account} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{account.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {account.handle ? `@${account.handle} · ` : ''}
            connected {now !== null ? timeAgo(account.connectedAt, now) : ''}
            {account.platform === 'tiktok'
              ? unaudited
                ? ' · unaudited app'
                : ' · audited app'
              : ''}
          </p>
        </div>
        <AccountStatusChip account={account} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            loading={test?.phase === 'running'}
            onClick={() => void runTest()}
            data-testid="account-test"
          >
            <PlugZap /> Test connection
          </Button>
          {account.status !== 'connected' ? (
            <ConnectControl
              platform={account.platform}
              configured={configured}
              reconnect
              size="sm"
              variant="primary"
            />
          ) : null}
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() => onDisconnect(account)}
            data-testid="account-disconnect"
          >
            <Unplug /> Disconnect
          </Button>
        </div>
      </div>
      {account.status !== 'connected' && account.statusMessage ? (
        <p className="text-xs text-warning" data-testid="account-status-message">
          {account.statusMessage}
        </p>
      ) : null}
      {test?.phase === 'done' ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-xs"
          data-testid="account-test-result"
          data-ok={test.ok}
        >
          <Badge variant={test.ok ? 'success' : 'danger'}>
            {test.ok ? <Check /> : <X />} {test.ok ? 'Works' : 'Failed'}
          </Badge>
          <span className={cn(test.ok ? 'text-muted-foreground' : 'text-danger')}>
            {test.message}
          </span>
          {test.detail ? <span className="text-subtle">{test.detail}</span> : null}
        </div>
      ) : null}
      {quota ? <QuotaMeter quota={quota} now={now} /> : null}
      {scheduledCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {scheduledCount} scheduled {scheduledCount === 1 ? 'post' : 'posts'} will go to this
          account.
        </p>
      ) : null}
    </li>
  );
}

/* ----------------------------------------------------------------------------------- section ----- */

/** Connect / list / test / disconnect for one platform's accounts, plus the redirect URI to register. */
export function PlatformAccounts({ platform }: { platform: Platform }) {
  const qc = useQueryClient();
  const accountsQ = useAccounts();
  const postsQ = usePosts();
  const [target, setTarget] = React.useState<SocialAccount | null>(null);
  const [busy, setBusy] = React.useState(false);
  const setup: PlatformSetup | undefined = accountsQ.data?.setup.find(
    (s) => s.platform === platform,
  );
  const accounts = (accountsQ.data?.accounts ?? []).filter((a) => a.platform === platform);
  const info = PLATFORM_INFO[platform];
  const scheduledFor = (id: string) =>
    (postsQ.data?.items ?? []).filter(
      (p) => p.accountId === id && (p.status === 'scheduled' || p.status === 'queued'),
    ).length;

  const disconnect = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await invoke('accounts:disconnect', { id: target.id });
      toast.success(`Disconnected ${target.displayName}`);
      setTarget(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['accounts:list'] }),
        qc.invalidateQueries({ queryKey: ['posts:list'] }),
        qc.invalidateQueries({ queryKey: ['scheduler:status'] }),
      ]);
    } catch (e) {
      toast.error('Could not disconnect', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  if (accountsQ.isPending)
    return (
      <div className="flex flex-col gap-3" aria-busy aria-label="Loading accounts">
        <Skeleton className="h-16 rounded-xl" />
      </div>
    );
  if (accountsQ.isError)
    return (
      <p className="text-sm text-danger" role="alert">
        Could not load accounts: {accountsQ.error.message}
      </p>
    );

  return (
    <div className="flex flex-col gap-4 border-t pt-5" data-testid={`accounts-${platform}`}>
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">
          Connected accounts{' '}
          <span className="font-normal text-muted-foreground tabular-nums">
            ({accounts.length})
          </span>
        </h3>
      </div>
      {setup ? <RedirectUri uri={setup.redirectUri} platform={platform} /> : null}
      {accounts.length ? (
        <ul className="flex flex-col gap-3">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              configured={setup?.configured ?? true}
              scheduledCount={scheduledFor(a.id)}
              onDisconnect={setTarget}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="no-accounts">
          No {info.name} account connected yet.{' '}
          {setup?.configured
            ? 'Press Connect and approve access in your browser.'
            : 'Save the credentials above first, then connect.'}
        </p>
      )}
      <ConnectControl
        platform={platform}
        configured={setup?.configured ?? false}
        label={accounts.length ? 'Connect another account' : 'Connect account'}
        layout="panel"
        variant={accounts.length ? 'secondary' : 'primary'}
        size="md"
      />
      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && !busy && setTarget(null)}
        title={`Disconnect ${target?.displayName ?? 'account'}?`}
        description={
          <>
            Clipfern forgets this sign-in and revokes access at {info.short}.{' '}
            {target && scheduledFor(target.id) > 0
              ? `Its ${scheduledFor(target.id)} scheduled ${scheduledFor(target.id) === 1 ? 'post becomes a draft' : 'posts become drafts'}, so nothing goes out by surprise. `
              : ''}
            Published posts and your clips are not touched. You can reconnect any time.
          </>
        }
        confirmLabel="Disconnect"
        loading={busy}
        onConfirm={() => void disconnect()}
      />
    </div>
  );
}
