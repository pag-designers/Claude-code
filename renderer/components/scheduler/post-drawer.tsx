'use client';

import * as React from 'react';
import {
  Ban,
  Calendar,
  ExternalLink,
  Eye,
  Heart,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Share2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { PostFields, PostSource, PostView } from '@shared/publish';
import { openExternal } from '@/components/settings/common';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { formatBytes, formatCompact, timeAgo } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { formatUntil, formatWhen } from '@/lib/publish/dates';
import {
  ERROR_LABEL,
  PLATFORM_INFO,
  canPostNow,
  canRetry,
  isCancelable,
  isEditable,
  isTiktokUnaudited,
  localFieldIssues,
  needsReconnect,
  reportBlocks,
} from '@/lib/publish/model';
import { useNowMs } from '@/lib/publish/now';
import {
  useAccounts,
  useCancelPost,
  useDeletePosts,
  usePosts,
  usePostNow,
  useRefreshStats,
  useRetryPost,
  useUpdatePost,
  useValidate,
} from '@/lib/publish/queries';
import { DateTimeField, FormField } from './fields';
import { MediaReportView } from './media-report';
import { PlatformFields } from './platform-fields';
import { PlatformMark, PostStatusChip } from './platform';
import { Sheet, SheetDescription, SheetTitle } from './sheet';

const sourceOf = (p: PostView): PostSource | null =>
  p.clipId ? { clipId: p.clipId } : p.exportId ? { exportId: p.exportId } : null;

interface Draft {
  fields: PostFields;
  scheduledAt: number | null;
  autoFix: boolean;
}

const signature = (p: PostView) => JSON.stringify([p.fields, p.scheduledAt, p.autoFix, p.status]);

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden /> {label}
      </span>
      <span
        className="font-display text-lg font-semibold tabular-nums"
        data-testid={`stat-${label.toLowerCase()}`}
      >
        {value === null ? '–' : formatCompact(value)}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b px-6 py-5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Body({ post, onClose }: { post: PostView; onClose: () => void }) {
  const now = useNowMs();
  const accounts = useAccounts();
  const account = accounts.data?.accounts.find((a) => a.id === post.accountId);
  const editable = isEditable(post.status);
  const source = sourceOf(post);

  const [draft, setDraft] = React.useState<Draft>({
    fields: post.fields,
    scheduledAt: post.scheduledAt,
    autoFix: post.autoFix,
  });
  const [sig, setSig] = React.useState(() => signature(post));
  const dirty =
    JSON.stringify(draft.fields) !== JSON.stringify(post.fields) ||
    draft.scheduledAt !== post.scheduledAt ||
    draft.autoFix !== post.autoFix;
  // the scheduler changed the post underneath us (status, retry, reschedule): follow it unless the user has edits
  if (sig !== signature(post)) {
    setSig(signature(post));
    if (!dirty)
      setDraft({ fields: post.fields, scheduledAt: post.scheduledAt, autoFix: post.autoFix });
  }

  const debouncedFields = useDebounced(draft.fields, 400);
  const validation = useValidate(source, post.platform, debouncedFields, editable);
  const report = validation.data?.report;
  const fieldIssues = validation.data?.fieldIssues ?? [];
  const hasIssues = fieldIssues.length > 0 || localFieldIssues(draft.fields).length > 0;
  const blocked = reportBlocks(report, draft.autoFix) || hasIssues;

  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const update = useUpdatePost();
  const postNow = usePostNow();
  const cancel = useCancelPost();
  const retry = useRetryPost();
  const del = useDeletePosts(onClose);
  const stats = useRefreshStats();

  const info = PLATFORM_INFO[post.platform];
  const unaudited = account ? isTiktokUnaudited(account) : post.platform === 'tiktok';
  const busy = update.isPending || postNow.isPending || cancel.isPending || retry.isPending;
  const timeInPast =
    now !== null &&
    draft.scheduledAt !== null &&
    draft.scheduledAt !== post.scheduledAt &&
    draft.scheduledAt <= now;

  const save = () =>
    update.mutate({
      id: post.id,
      fields: draft.fields,
      scheduledAt: draft.scheduledAt,
      autoFix: draft.autoFix,
    });
  const doPostNow = async () => {
    try {
      if (dirty)
        await update.mutateAsync({
          id: post.id,
          fields: draft.fields,
          autoFix: draft.autoFix,
        });
      postNow.mutate({ id: post.id });
    } catch {
      /* the failed save already toasted */
    }
  };

  const err = post.error;
  const when = post.scheduledAt;

  return (
    <>
      <header className="flex flex-col gap-3 border-b px-6 pb-5 pr-16 pt-6">
        <div className="flex items-start gap-3.5">
          <PlatformMark platform={post.platform} size="lg" />
          <div className="min-w-0 flex-1">
            <SheetTitle
              className="font-display text-xl font-semibold leading-7"
              data-testid="drawer-title"
            >
              {post.title}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-sm text-muted-foreground">
              {info.name} · {post.accountName}
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PostStatusChip status={post.status} />
          {when !== null && now !== null ? (
            <span className="text-sm tabular-nums text-muted-foreground" data-testid="drawer-when">
              {post.status === 'published' && post.publishedAt
                ? `Published ${formatWhen(post.publishedAt, now)}`
                : `${formatWhen(when, now)}${post.status === 'scheduled' ? ` · ${formatUntil(when, now)}` : ''}`}
            </span>
          ) : null}
          {post.autoFixed ? (
            <span className="text-xs text-muted-foreground">Re-encoded copy used</span>
          ) : null}
        </div>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {post.status === 'publishing' ? (
          <div className="flex flex-col gap-2 border-b px-6 py-4" data-testid="drawer-publishing">
            <p className="text-sm font-medium">Publishing to {info.name}…</p>
            <Progress value={null} aria-label="Publishing progress" />
            <p className="text-xs text-muted-foreground">
              Uploading and waiting for {info.name} to confirm. This can take a minute.
            </p>
          </div>
        ) : null}

        {err &&
        (post.status === 'failed' || post.status === 'scheduled' || post.status === 'queued') ? (
          <div className="border-b px-6 py-4">
            <Banner
              tone={post.status === 'failed' ? 'danger' : 'warning'}
              title={`${post.status === 'failed' ? 'Posting failed' : 'Last attempt failed'} · ${ERROR_LABEL[err.code]}`}
            >
              <p data-testid="post-error" className="break-words text-foreground">
                {err.message}
              </p>
              {err.hint ? (
                <p className="mt-1.5" data-testid="post-error-hint">
                  <strong className="font-semibold text-foreground">What to do: </strong>
                  {err.hint}
                </p>
              ) : null}
              <p className="mt-1.5 text-xs">
                {post.attempts} {post.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
                {post.nextAttemptAt !== null && now !== null
                  ? `Clipfern will try again ${formatUntil(post.nextAttemptAt, now)}.`
                  : err.retryable
                    ? 'You can retry now.'
                    : 'This will not succeed on its own. Fix the cause, then retry.'}
                {needsReconnect(err.code)
                  ? ' Reconnect the account in Settings → Integrations.'
                  : ''}
              </p>
            </Banner>
          </div>
        ) : null}

        {post.status === 'missed' ? (
          <div className="border-b px-6 py-4">
            <Banner tone="warning" title="Missed — reschedule?">
              This post was due {when !== null && now !== null ? formatWhen(when, now) : ''} while
              Clipfern was closed, and it was too late to publish automatically. Pick a new time
              below, or post it now.
            </Banner>
          </div>
        ) : null}

        {post.status === 'published' && post.result ? (
          <Section title="Result">
            {post.result.outcome === 'draft-uploaded' ? (
              <Banner tone="info" title="Uploaded to your TikTok drafts">
                Open the TikTok app, go to your inbox, and publish it from there.
              </Banner>
            ) : null}
            {post.result.note ? (
              <Banner tone="warning" title={`${info.short} adjusted this post`}>
                <span data-testid="result-note">{post.result.note}</span>
              </Banner>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {post.result.url ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void openExternal(post.result!.url!)}
                  data-testid="result-link"
                >
                  <ExternalLink /> View on {info.short}
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {info.noun} id <code className="font-mono">{post.result.platformPostId}</code>
              </span>
            </div>
          </Section>
        ) : null}

        {post.status === 'published' ? (
          <Section
            title="Performance"
            action={
              <Button
                variant="ghost"
                size="xs"
                loading={stats.isPending}
                onClick={() => stats.mutate({ ids: [post.id] })}
                data-testid="stats-refresh"
              >
                <RefreshCw /> Refresh
              </Button>
            }
          >
            {post.stats ? (
              <>
                <div className="grid grid-cols-4 gap-2 max-[520px]:grid-cols-2">
                  <Stat icon={Eye} label="Views" value={post.stats.views} />
                  <Stat icon={Heart} label="Likes" value={post.stats.likes} />
                  <Stat icon={MessageCircle} label="Comments" value={post.stats.comments} />
                  <Stat icon={Share2} label="Shares" value={post.stats.shares} />
                </div>
                <p className="text-2xs text-subtle">Updated {timeAgo(post.stats.fetchedAt)}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No numbers yet. Press Refresh to ask {info.short} for the latest views and likes.
              </p>
            )}
          </Section>
        ) : null}

        {editable ? (
          <Section title="When">
            <FormField
              id="drawer-when"
              label="Publish at"
              error={
                timeInPast
                  ? 'This time has already passed. Saving it will post the moment you save.'
                  : undefined
              }
            >
              <DateTimeField
                id="drawer-when"
                label="Publish at"
                value={draft.scheduledAt}
                onChange={(scheduledAt) => setDraft((d) => ({ ...d, scheduledAt }))}
              />
            </FormField>
            {draft.scheduledAt === null && post.status !== 'draft' ? (
              <p className="text-xs text-muted-foreground">
                With no date this post becomes a draft. Nothing is published until you pick a time.
              </p>
            ) : null}
          </Section>
        ) : null}

        <Section title="Video">
          <div className="flex gap-4">
            <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-lg border bg-black">
              {post.thumbUrl ? (
                <img src={post.thumbUrl} alt="" className="size-full object-cover" />
              ) : (
                <Skeleton className="size-full rounded-none" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {editable ? (
                <MediaReportView
                  platform={post.platform}
                  report={report}
                  loading={validation.isFetching}
                  error={validation.error?.message}
                  autoFix={draft.autoFix}
                  onAutoFixChange={(autoFix) => setDraft((d) => ({ ...d, autoFix }))}
                  switchId="drawer-autofix"
                />
              ) : post.media ? (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {Math.round(post.media.durationSec)} s · {post.media.width}×{post.media.height}
                  {post.media.fps ? ` · ${Math.round(post.media.fps)} fps` : ''} ·{' '}
                  {formatBytes(post.media.sizeBytes)}
                </p>
              ) : null}
            </div>
          </div>
        </Section>

        <Section title={`${info.noun} details`}>
          <PlatformFields
            fields={draft.fields}
            onChange={(fields) => setDraft((d) => ({ ...d, fields }))}
            issues={fieldIssues}
            idPrefix="drawer"
            disabled={!editable}
            durationSec={post.media?.durationSec ?? report?.media.durationSec ?? null}
            tiktokUnaudited={unaudited}
          />
          {!editable ? (
            <p className="text-xs text-muted-foreground">
              {post.status === 'published'
                ? `Published posts cannot be edited from here. Edit it on ${info.short}.`
                : post.status === 'publishing'
                  ? 'Locked while publishing.'
                  : 'Canceled posts cannot be edited. Delete it and schedule the clip again.'}
            </p>
          ) : null}
        </Section>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t bg-card/60 px-6 py-3.5">
        <Tip content="Delete from Clipfern">
          <Button
            variant="danger-ghost"
            size="icon"
            aria-label="Delete post"
            onClick={() => setConfirmDelete(true)}
            disabled={post.status === 'publishing'}
            data-testid="drawer-delete"
          >
            <Trash2 />
          </Button>
        </Tip>
        {isCancelable(post.status) ? (
          <Button
            variant="outline"
            loading={cancel.isPending}
            onClick={() => cancel.mutate({ id: post.id })}
            data-testid="drawer-cancel"
          >
            <Ban /> Cancel post
          </Button>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {canRetry(post.status) && !dirty ? (
            <Button
              variant="primary"
              loading={retry.isPending}
              disabled={busy}
              onClick={() => retry.mutate({ id: post.id })}
              data-testid="drawer-retry"
            >
              <RotateCcw /> Retry now
            </Button>
          ) : null}
          {canPostNow(post.status) ? (
            <Button
              variant={dirty || canRetry(post.status) ? 'outline' : 'secondary'}
              loading={postNow.isPending}
              disabled={busy || blocked}
              onClick={() => void doPostNow()}
              data-testid="drawer-post-now"
            >
              <Send /> Post now
            </Button>
          ) : null}
          {editable ? (
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty || busy || blocked}
              onClick={save}
              data-testid="drawer-save"
            >
              <Calendar /> {post.status === 'missed' ? 'Reschedule' : 'Save changes'}
            </Button>
          ) : null}
        </span>
      </footer>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this post?"
        description={
          post.status === 'published'
            ? `This removes it from Clipfern's history. The ${info.noun} stays on ${info.short}.`
            : 'It will not be published. The clip in your Library is not affected.'
        }
        loading={del.isPending}
        onConfirm={() => del.mutate({ ids: [post.id] })}
      />
    </>
  );
}

/** Right-hand panel for one post: status, platform error, result, stats, reschedule, fields. */
export function PostDrawer({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const posts = usePosts();
  const post = posts.data?.items.find((p) => p.id === postId) ?? null;
  // a deleted post (here or by the scheduler) closes the panel instead of leaving it empty
  const known = React.useRef(false);
  React.useEffect(() => {
    if (post) known.current = true;
    else if (postId && known.current && posts.isSuccess) {
      known.current = false;
      onClose();
    }
  }, [post, postId, posts.isSuccess, onClose]);
  return (
    <Sheet
      open={!!postId && !!post}
      onOpenChange={(o) => !o && onClose()}
      data-testid="post-drawer"
    >
      {post ? <Body key={post.id} post={post} onClose={onClose} /> : null}
    </Sheet>
  );
}
