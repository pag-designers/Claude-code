'use client';

import * as React from 'react';
import type { Platform } from '@shared/cp2';
import type { PostStatus, SocialAccount } from '@shared/publish';
import { InstagramGlyph, TiktokGlyph, YoutubeGlyph } from '@/components/ui/brand-icons';
import { Badge } from '@/components/ui/badge';
import { PLATFORM_INFO, PLATFORM_STYLE, STATUS_META, initialsOf } from '@/lib/publish/model';
import { cn } from '@/lib/utils';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  Hourglass,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

const GLYPH: Record<Platform, typeof YoutubeGlyph> = {
  shorts: YoutubeGlyph,
  reels: InstagramGlyph,
  tiktok: TiktokGlyph,
};

export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const G = GLYPH[platform];
  return <G className={cn('size-4', PLATFORM_STYLE[platform].text, className)} />;
}

/** The platform glyph on a tinted square (accounts, filters, headings). */
export function PlatformMark({
  platform,
  className,
  size = 'md',
}: {
  platform: Platform;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const s = PLATFORM_STYLE[platform];
  return (
    <span
      role="img"
      aria-label={PLATFORM_INFO[platform].name}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        s.soft,
        s.text,
        size === 'sm' ? 'size-6 rounded-md' : size === 'lg' ? 'size-10' : 'size-8',
        className,
      )}
    >
      <PlatformGlyph platform={platform} className={size === 'sm' ? 'size-3.5' : 'size-[18px]'} />
    </span>
  );
}

function PlatformGlyph({ platform, className }: { platform: Platform; className?: string }) {
  const G = GLYPH[platform];
  return <G className={className} />;
}

export function AccountAvatar({
  account,
  className,
}: {
  account: Pick<SocialAccount, 'displayName' | 'avatarUrl' | 'platform'>;
  className?: string;
}) {
  const [broken, setBroken] = React.useState(false);
  const url = account.avatarUrl;
  return (
    <span
      className={cn(
        'relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted text-xs font-semibold text-muted-foreground',
        className,
      )}
    >
      {url && !broken ? (
        <img
          src={url}
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(true)}
          referrerPolicy="no-referrer"
        />
      ) : (
        initialsOf(account.displayName)
      )}
    </span>
  );
}

const STATUS_ICON: Record<PostStatus, LucideIcon> = {
  draft: CircleDashed,
  scheduled: Clock,
  queued: Hourglass,
  publishing: Loader2,
  published: CircleCheck,
  failed: CircleAlert,
  missed: TriangleAlert,
  canceled: CircleSlash,
};

export function PostStatusChip({
  status,
  className,
  short,
}: {
  status: PostStatus;
  className?: string;
  /** "Missed" instead of "Missed — reschedule?" (calendar chips, narrow rows). */
  short?: boolean;
}) {
  const meta = STATUS_META[status];
  const Icon = STATUS_ICON[status];
  const label = short && status === 'missed' ? 'Missed' : meta.label;
  return (
    <Badge
      variant={meta.tone}
      data-status={status}
      data-testid="post-status"
      className={cn('gap-1', className)}
    >
      <Icon className={status === 'publishing' ? 'animate-spin' : undefined} aria-hidden />
      {label}
    </Badge>
  );
}

export { STATUS_ICON };
