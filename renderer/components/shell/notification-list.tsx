'use client';

import { useRouter } from 'next/navigation';
import { Bell, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { AppNotification } from '@shared/domain';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';
import { normalizeHref } from '@/lib/hrefs';
import { useIpcMutation } from '@/lib/ipc';

const LEVEL = {
  info: { icon: Info, cls: 'bg-info-soft text-info' },
  success: { icon: CircleCheck, cls: 'bg-success-soft text-success' },
  warning: { icon: TriangleAlert, cls: 'bg-warning-soft text-warning' },
  error: { icon: CircleAlert, cls: 'bg-danger-soft text-danger' },
} as const;

export function NotificationRow({
  n,
  onNavigate,
}: {
  n: AppNotification;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const markRead = useIpcMutation('notifications:markRead', { invalidate: ['notifications:list'] });
  const { icon: Icon, cls } = LEVEL[n.level];
  const unread = n.readAt === null;
  const go = () => {
    if (unread) markRead.mutate({ ids: [n.id] });
    if (n.href) {
      onNavigate?.();
      router.push(normalizeHref(n.href));
    }
  };
  return (
    <li>
      <button
        type="button"
        onClick={go}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60',
          !n.href && !unread && 'cursor-default',
        )}
      >
        <span
          className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md', cls)}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span
              className={cn(
                'text-sm leading-5',
                unread ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
              )}
            >
              {n.title}
            </span>
            <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
              {timeAgo(n.createdAt)}
              {unread ? (
                <span className="size-1.5 rounded-full bg-primary-text" aria-label="Unread" />
              ) : null}
            </span>
          </span>
          {n.body ? (
            <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
              {n.body}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

export function NotificationsEmpty({ compact }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 text-center',
        compact ? 'px-6 py-10' : 'px-6 py-16',
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-subtle">
        <Bell className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold">You&apos;re all caught up</p>
      <p className="max-w-64 text-xs text-muted-foreground">
        Finished jobs, ready clips, storage warnings and post results will appear here.
      </p>
    </div>
  );
}
