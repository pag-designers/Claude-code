'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tip } from '@/components/ui/tooltip';
import { useIpcMutation } from '@/lib/ipc';
import { useNotifications } from '@/lib/queries';
import { NotificationRow, NotificationsEmpty } from './notification-list';

export function NotificationsPopover() {
  const [open, setOpen] = React.useState(false);
  const { data } = useNotifications();
  const markAll = useIpcMutation('notifications:markAllRead', {
    invalidate: ['notifications:list'],
  });
  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip content="Notifications" side="bottom">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          >
            <Bell aria-hidden />
            {unread > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground ring-2 ring-background">
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-[380px] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-display text-md font-semibold">Notifications</p>
          <Button
            variant="ghost"
            size="xs"
            disabled={unread === 0}
            loading={markAll.isPending}
            onClick={() => markAll.mutate(undefined)}
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
        {items.length === 0 ? (
          <NotificationsEmpty compact />
        ) : (
          <ScrollArea className="max-h-[380px]">
            <ul className="divide-y">
              {items.slice(0, 12).map((n) => (
                <NotificationRow key={n.id} n={n} onNavigate={() => setOpen(false)} />
              ))}
            </ul>
          </ScrollArea>
        )}
        <div className="border-t px-4 py-2.5">
          <Link
            href="/notifications/"
            onClick={() => setOpen(false)}
            className="text-xs font-medium text-primary-text hover:underline"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
