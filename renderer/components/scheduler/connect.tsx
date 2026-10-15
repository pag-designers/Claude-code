'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Link2, Loader2, RefreshCw } from 'lucide-react';
import type { Platform } from '@shared/cp2';
import type { SocialAccount } from '@shared/publish';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { PLATFORM_INFO } from '@/lib/publish/model';
import { useConnect } from '@/lib/publish/queries';
import { cn } from '@/lib/utils';

/**
 * "Connect account" for one platform. `accounts:connect` blocks until the browser consent finishes, so while it runs
 * this shows a waiting state with Cancel; a failure is shown in plain words with a way to try again.
 * `layout="panel"` is the roomy Settings version, `inline` fits a card in the Scheduler.
 */
export function ConnectControl({
  platform,
  configured,
  label,
  reconnect,
  layout = 'inline',
  variant = 'secondary',
  size = 'sm',
  onConnected,
  className,
}: {
  platform: Platform;
  /** Developer-app credentials are saved. */
  configured: boolean;
  label?: string;
  reconnect?: boolean;
  layout?: 'inline' | 'panel';
  variant?: 'secondary' | 'primary' | 'outline' | 'soft';
  size?: 'xs' | 'sm' | 'md';
  onConnected?: (a: SocialAccount) => void;
  className?: string;
}) {
  const { state, connect, cancel, dismiss } = useConnect(platform, onConnected);
  const info = PLATFORM_INFO[platform];
  const text = label ?? (reconnect ? 'Reconnect' : 'Connect account');
  const waiting = state.phase === 'waiting';

  if (!configured)
    return (
      <div className={cn('flex flex-col items-start gap-1.5', className)}>
        <Button variant="secondary" size={size} asChild>
          <Link href={`/settings/integrations/#${info.provider}`}>
            <ExternalLink /> Add {info.short} credentials first
          </Link>
        </Button>
        {layout === 'panel' ? (
          <p className="text-xs text-muted-foreground">
            Clipfern needs your own developer app credentials before it can ask {info.short} for
            access.
          </p>
        ) : null}
      </div>
    );

  return (
    <div
      className={cn('flex flex-col gap-2', layout === 'inline' && 'items-start', className)}
      data-testid={`connect-${platform}`}
      data-phase={state.phase}
    >
      {waiting ? (
        <div
          role="status"
          className={cn(
            'flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2',
            layout === 'panel' ? 'w-full' : 'w-full',
          )}
        >
          <Loader2 className="size-4 shrink-0 animate-spin text-primary-text" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Waiting for {info.short}…</p>
            <p className="text-xs text-muted-foreground">
              Approve access in the browser window that just opened. This waits up to 5 minutes.
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void cancel()}
            data-testid={`connect-cancel-${platform}`}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant={variant}
          size={size}
          onClick={() => void connect()}
          data-testid={`connect-btn-${platform}`}
        >
          {reconnect ? <RefreshCw /> : <Link2 />} {text}
        </Button>
      )}
      {state.phase === 'error' ? (
        <Banner
          tone="danger"
          title={`Could not connect ${info.short}`}
          action={
            <Button variant="ghost" size="xs" onClick={dismiss}>
              Dismiss
            </Button>
          }
        >
          <span data-testid="connect-error">{state.message}</span>
        </Banner>
      ) : null}
    </div>
  );
}
