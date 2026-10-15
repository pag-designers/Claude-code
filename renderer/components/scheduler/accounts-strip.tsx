'use client';

import * as React from 'react';
import Link from 'next/link';
import { Settings2, TriangleAlert } from 'lucide-react';
import type { Platform } from '@shared/cp2';
import type { PlatformSetup, QuotaInfo, SocialAccount } from '@shared/publish';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUntil } from '@/lib/publish/dates';
import {
  PLATFORM_INFO,
  PLATFORM_ORDER,
  describeQuota,
  isTiktokUnaudited,
  postsLeftLabel,
  quotaFraction,
  quotaTone,
} from '@/lib/publish/model';
import { cn } from '@/lib/utils';
import { ConnectControl } from './connect';
import { AccountAvatar, PlatformMark } from './platform';

export function AccountStatusChip({ account }: { account: Pick<SocialAccount, 'status'> }) {
  if (account.status === 'connected')
    return (
      <Badge variant="success" dot>
        Connected
      </Badge>
    );
  if (account.status === 'needs-reauth')
    return (
      <Badge variant="warning">
        <TriangleAlert aria-hidden /> Needs re-auth
      </Badge>
    );
  return <Badge variant="danger">Error</Badge>;
}

export function QuotaMeter({ quota, now }: { quota: QuotaInfo; now: number | null }) {
  const tone = quotaTone(quota);
  const left = postsLeftLabel(quota);
  return (
    <div className="flex flex-col gap-1" data-testid="quota-meter" data-tone={tone}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-2xs font-semibold uppercase tracking-wider text-subtle">
          {quota.label}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {describeQuota(quota)}
        </span>
      </div>
      <Progress
        value={quotaFraction(quota) * 100}
        tone={tone}
        className="h-1.5"
        aria-label={`${quota.label}: ${describeQuota(quota)}`}
      />
      <p className="flex flex-wrap items-center justify-between gap-x-3 text-2xs text-muted-foreground">
        <span className={cn(quota.postsLeft === 0 && 'font-medium text-danger')}>{left}</span>
        {now !== null ? <span>Resets {formatUntil(quota.resetsAt, now)}</span> : null}
      </p>
      {quota.note ? (
        <p className="truncate text-2xs text-subtle" data-testid="quota-note" title={quota.note}>
          {quota.note}
        </p>
      ) : null}
    </div>
  );
}

function AccountCard({
  account,
  quota,
  now,
  configured,
}: {
  account: SocialAccount;
  quota: QuotaInfo | undefined;
  now: number | null;
  configured: boolean;
}) {
  const unaudited = isTiktokUnaudited(account);
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5 shadow-xs',
        account.status !== 'connected' && 'border-warning/40',
      )}
      data-testid="account-card"
      data-account-id={account.id}
      data-status={account.status}
    >
      <div className="flex items-center gap-3">
        <div className="relative">
          <AccountAvatar account={account} className="size-9" />
          <PlatformMark
            platform={account.platform}
            size="sm"
            className="absolute -bottom-1 -right-1 border-2 border-card"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" data-testid="account-name">
            {account.displayName}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {account.handle ? `@${account.handle} · ` : ''}
            {PLATFORM_INFO[account.platform].name}
          </p>
        </div>
        <AccountStatusChip account={account} />
      </div>
      {account.status !== 'connected' ? (
        <div className="flex flex-col items-start gap-2">
          <p
            className="text-xs leading-4 text-muted-foreground"
            data-testid="account-status-message"
          >
            {account.statusMessage ??
              (account.status === 'needs-reauth'
                ? 'The sign-in expired or was revoked. Reconnect to keep posting.'
                : 'Something is wrong with this account.')}
          </p>
          <ConnectControl platform={account.platform} configured={configured} reconnect />
        </div>
      ) : null}
      {unaudited ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-2xs leading-4 text-foreground">
          <TriangleAlert className="mt-px size-3 shrink-0 text-warning" aria-hidden />
          <span>
            App not audited: posts are private.{' '}
            <Link
              href="/settings/integrations/#tiktok-audit"
              className="font-medium text-primary-text underline-offset-2 hover:underline"
            >
              Audit checklist
            </Link>
          </span>
        </p>
      ) : null}
      {quota ? <QuotaMeter quota={quota} now={now} /> : null}
    </li>
  );
}

function ConnectCard({
  platform,
  setup,
}: {
  platform: Platform;
  setup: PlatformSetup | undefined;
}) {
  const info = PLATFORM_INFO[platform];
  const blurb: Record<Platform, string> = {
    shorts: 'Official YouTube Data API. About 6 uploads a day on the default quota.',
    reels: 'Business or Creator account linked to a Facebook Page.',
    tiktok: 'Unaudited apps post privately until TikTok approves a free audit.',
  };
  return (
    <li
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-dashed border-border-strong bg-card/50 px-4 py-3.5"
      data-testid="connect-card"
      data-platform={platform}
    >
      <div className="flex items-center gap-3">
        <PlatformMark platform={platform} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{info.name}</p>
          <p className="text-xs text-muted-foreground">Not connected</p>
        </div>
      </div>
      <p className="text-xs leading-4 text-muted-foreground">{blurb[platform]}</p>
      <ConnectControl
        platform={platform}
        configured={setup?.configured ?? false}
        label={`Connect ${info.short}`}
        variant="soft"
      />
    </li>
  );
}

/** Connected accounts per platform with status, quota meter and a Connect card for platforms with none. */
export function AccountsStrip({
  accounts,
  setup,
  quota,
  loading,
  now,
}: {
  accounts: readonly SocialAccount[] | undefined;
  setup: readonly PlatformSetup[] | undefined;
  quota: readonly QuotaInfo[] | undefined;
  loading: boolean;
  now: number | null;
}) {
  if (loading || !accounts)
    return (
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3"
        aria-busy
        aria-label="Loading accounts"
      >
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    );
  const setupOf = (p: Platform) => setup?.find((s) => s.platform === p);
  return (
    <section aria-label="Connected accounts" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-md font-semibold">Accounts</h2>
        <Button variant="ghost" size="xs" asChild>
          <Link href="/settings/integrations/">
            <Settings2 /> Manage in Settings
          </Link>
        </Button>
      </div>
      <ul
        className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3"
        data-testid="accounts-strip"
      >
        {PLATFORM_ORDER.flatMap((platform) => {
          const mine = accounts.filter((a) => a.platform === platform);
          if (!mine.length)
            return [<ConnectCard key={platform} platform={platform} setup={setupOf(platform)} />];
          return mine.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              now={now}
              quota={quota?.find((q) => q.accountId === a.id)}
              configured={setupOf(a.platform)?.configured ?? true}
            />
          ));
        })}
      </ul>
    </section>
  );
}
