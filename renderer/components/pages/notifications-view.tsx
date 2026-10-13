'use client';

import { CheckCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/skeleton';
import { useIpcMutation } from '@/lib/ipc';
import { useNotifications } from '@/lib/queries';
import { NotificationRow, NotificationsEmpty } from '@/components/shell/notification-list';

export function NotificationsView() {
  const { data, isPending } = useNotifications();
  const markAll = useIpcMutation('notifications:markAllRead', {
    invalidate: ['notifications:list'],
  });
  const clear = useIpcMutation('notifications:clear', { invalidate: ['notifications:list'] });
  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;
  return (
    <Page className="max-w-[860px]">
      <PageHeader
        title="Notifications"
        description="Job results, ready clips, storage warnings, post outcomes and updates."
        actions={
          <>
            <Button
              variant="outline"
              disabled={unread === 0}
              loading={markAll.isPending}
              onClick={() => markAll.mutate(undefined)}
            >
              <CheckCheck /> Mark all read
            </Button>
            <Button
              variant="outline"
              disabled={items.length === 0}
              loading={clear.isPending}
              onClick={() => clear.mutate(undefined)}
            >
              <Trash2 /> Clear all
            </Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        {isPending ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : items.length === 0 ? (
          <NotificationsEmpty />
        ) : (
          <ul className="divide-y">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
