'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarClock, ExternalLink } from 'lucide-react';
import type { PostSource } from '@shared/publish';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { usePostsOfClip } from '@/lib/publish/queries';
import { PLATFORM_INFO } from '@/lib/publish/model';
import { SchedulePostDialog } from './schedule-dialog';
import { PlatformIcon } from './platform';

/**
 * A button that opens the schedule dialog for the given sources (clips or an export). Used by the clip drawer,
 * the Library selection bar, the Exported tab and the editor's export panel.
 */
export function ScheduleButton({
  sources,
  label = 'Post…',
  disabledReason,
  testId,
  icon = true,
  ...rest
}: {
  sources: PostSource[];
  label?: string;
  /** When set the button is disabled and explains why (e.g. the clip is not rendered yet). */
  disabledReason?: string;
  testId?: string;
  icon?: boolean;
} & Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const [open, setOpen] = React.useState(false);
  const disabled = !!disabledReason || sources.length === 0;
  const button = (
    <Button
      {...rest}
      disabled={disabled}
      onClick={() => setOpen(true)}
      data-testid={testId}
      aria-haspopup="dialog"
    >
      {icon ? <CalendarClock /> : null} {label}
    </Button>
  );
  return (
    <>
      {disabledReason ? (
        <Tip content={disabledReason}>
          <span className="inline-flex" tabIndex={0}>
            {button}
          </span>
        </Tip>
      ) : (
        button
      )}
      <SchedulePostDialog source={sources} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** "Posted to YouTube · view" links for a clip that has been published (empty when it has not). */
export function PostedLinks({ clipId }: { clipId: string }) {
  const posts = usePostsOfClip(clipId).filter((p) => p.status === 'published');
  if (!posts.length) return null;
  return (
    <ul
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Where this clip was posted"
      data-testid="posted-links"
    >
      {posts.map((p) => (
        <li key={p.id}>
          <Link
            href={`/scheduler/?post=${encodeURIComponent(p.id)}`}
            className="inline-flex h-6 items-center gap-1.5 rounded-full border border-success/40 bg-success-soft px-2.5 text-2xs font-semibold text-success outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PlatformIcon platform={p.platform} className="size-3 text-current" />
            Posted to {PLATFORM_INFO[p.platform].short} · view
            <ExternalLink className="size-3" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
