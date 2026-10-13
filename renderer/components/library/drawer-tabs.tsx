'use client';

/**
 * The clip drawer's CP2 tabs. Each tab is self-contained (takes a `clipId`, loads its own data lazily, reads the live
 * clip for render progress), so the Tools hub can embed them as standalone routes exactly as the drawer does.
 */
import * as React from 'react';
import {
  AlertCircle,
  AudioLines,
  Captions,
  Check,
  Clock,
  Download,
  Hash,
  Image as ImageIcon,
  Maximize2,
  Mic,
  Palette,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import type { ClipView } from '@shared/pipeline';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  REFRAME_MODE_LABELS,
  type ClipMeta,
  type ClipThumbnails,
  type Platform,
  type PlatformMeta,
  type ReframeMode,
} from '@shared/cp2';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { StyleStudio } from '@/components/captions/style-studio';
import {
  DAY_NAMES,
  LAYOUT_LABELS,
  OVERLAY_MAX_WORDS,
  PLATFORM_SHORT,
  PLATFORM_SPECS,
  REFRAME_MODES,
  addHashtags,
  bestCandidateIndex,
  captionLength,
  captionsOutdated,
  cleanOverlay,
  countWords,
  formatCopyAll,
  formatHour,
  formatPostingTime,
  isClipBusy,
  layoutFallbackNote,
  metaEqual,
  metaIssues,
  overlayError,
  percent,
  useApplyHook,
  useCaptionStyles,
  useChooseThumb,
  useClipLookup,
  useExportClipSubtitles,
  useGenerateHooks,
  useGenerateMeta,
  useGenerateThumbs,
  useHooks,
  useMeta,
  useReframeClips,
  useRestyleClips,
  useSaveMeta,
  useThumbCandidateUrl,
  useThumbs,
} from '@/lib/cp2-clips';
import { formatClock, timeAgo } from '@/lib/format';
import { useClipMediaUrl, useRerenderClip, useVideos } from '@/lib/library';
import { useInView } from '@/lib/use-in-view';
import { cn } from '@/lib/utils';
import { CharCounter, CopyButton, ErrorBlock, SectionLabel, TextArea } from './drawer-fields';
import { ThumbnailTester, type TesterSource } from './thumbnail-tester';

interface TabProps {
  clipId: string;
  /** The drawer already holds the live clip; standalone routes omit it and it is looked up. */
  clip?: ClipView;
}

/* ------------------------------------------------------------------------------------------ shared */

function TabSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy aria-label={label} role="status">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function PlatformSwitch({
  value,
  onChange,
  marks,
  label = 'Platform',
}: {
  value: Platform;
  onChange: (p: Platform) => void;
  /** Platforms that get a small dot (e.g. "applied here", "unsaved edits"). */
  marks?: Partial<Record<Platform, 'applied' | 'dirty'>>;
  label?: string;
}) {
  return (
    <Segmented<Platform>
      label={label}
      size="sm"
      value={value}
      onValueChange={onChange}
      options={PLATFORMS.map((p) => ({
        value: p,
        label: (
          <span className="inline-flex items-center gap-1.5" data-testid={`platform-${p}`}>
            {PLATFORM_LABELS[p]}
            {marks?.[p] ? (
              <span
                aria-label={marks[p] === 'dirty' ? 'unsaved changes' : 'in use'}
                className={cn(
                  'size-1.5 rounded-full',
                  marks[p] === 'dirty' ? 'bg-warning' : 'bg-success',
                )}
              />
            ) : null}
          </span>
        ),
      }))}
    />
  );
}

/** Re-render progress of the live clip (shown on every tab that triggers a re-render). */
function RenderStrip({ clip }: { clip: ClipView | undefined }) {
  if (!clip || !isClipBusy(clip)) return null;
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary-soft px-3.5 py-2.5"
      data-testid="tab-render-progress"
      role="status"
    >
      <Progress
        value={clip.renderProgress === null ? null : clip.renderProgress * 100}
        className="h-1.5"
        aria-label="Re-render progress"
      />
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-primary-text">
        {clip.status === 'queued'
          ? 'Queued'
          : `Re-rendering ${Math.round((clip.renderProgress ?? 0) * 100)}%`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- hooks */

export function HookTab({ clipId, clip: provided }: TabProps) {
  const clip = useClipLookup(clipId, provided);
  const q = useHooks(clipId);
  const gen = useGenerateHooks(clipId);
  const apply = useApplyHook(clipId);
  const [picked, setPicked] = React.useState<Platform | null>(null);

  if (q.isPending) return <TabSkeleton label="Loading hooks" />;
  const hooks = q.data;
  const platform = picked ?? hooks?.applied?.platform ?? 'tiktok';
  const busy = !!clip && isClipBusy(clip);

  if (!hooks)
    return (
      <div data-testid="hook-tab" className="flex flex-col gap-3">
        {q.isError ? (
          <ErrorBlock
            error={q.error}
            title="Could not load hooks"
            onRetry={() => void q.refetch()}
          />
        ) : null}
        {gen.isError ? (
          <ErrorBlock
            error={gen.error}
            title="Could not generate hooks"
            onRetry={() => gen.mutate()}
            retrying={gen.isPending}
          />
        ) : null}
        <EmptyState
          size="sm"
          icon={Sparkles}
          title="No hooks for this clip yet"
          description="Claude writes five on-screen hooks per platform for the first seconds, true to what is said in the clip. The best one can be burned in as a title card."
          actions={
            <Button
              variant="primary"
              loading={gen.isPending}
              onClick={() => gen.mutate()}
              data-testid="hook-generate"
            >
              <Sparkles /> Generate hooks
            </Button>
          }
        />
      </div>
    );

  const variants = hooks[platform];
  const applied = hooks.applied;
  const appliedVariant = applied ? hooks[applied.platform][applied.index] : undefined;

  return (
    <div data-testid="hook-tab" className="flex flex-col gap-4">
      <RenderStrip clip={clip} />
      <section
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
          appliedVariant ? 'border-success/35 bg-success-soft' : 'bg-muted/40',
        )}
        data-testid="hook-applied"
        data-applied={appliedVariant ? 'true' : 'false'}
      >
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            appliedVariant ? 'bg-success text-black' : 'bg-muted text-muted-foreground',
          )}
        >
          {appliedVariant ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Captions className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {appliedVariant ? 'Title card is on' : 'No title card on this clip'}
          </p>
          <p className="truncate text-xs text-muted-foreground" data-testid="hook-applied-text">
            {appliedVariant && applied
              ? `“${appliedVariant.text}” · ${PLATFORM_SHORT[applied.platform]} #${applied.index + 1}`
              : 'Pick a variant below to show it for the first 2–3 seconds.'}
          </p>
        </div>
        {appliedVariant ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            loading={apply.isPending && apply.variables === null}
            onClick={() => apply.mutate(null)}
            data-testid="hook-remove"
          >
            <X /> Remove title card
          </Button>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PlatformSwitch
          value={platform}
          onChange={setPicked}
          marks={applied ? { [applied.platform]: 'applied' } : undefined}
          label="Hook platform"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-subtle" data-testid="hook-generated-at">
            Generated {timeAgo(hooks.generatedAt)}
          </span>
          <Button
            variant="outline"
            size="sm"
            loading={gen.isPending}
            disabled={busy}
            onClick={() => gen.mutate()}
            data-testid="hook-regenerate"
          >
            <RotateCcw /> Regenerate
          </Button>
        </div>
      </div>

      {gen.isError ? (
        <ErrorBlock
          error={gen.error}
          title="Could not generate hooks"
          onRetry={() => gen.mutate()}
          retrying={gen.isPending}
        />
      ) : null}

      <ol className="flex flex-col gap-2.5" aria-label={`${PLATFORM_LABELS[platform]} hooks`}>
        {variants.map((v, i) => {
          const isApplied = applied?.platform === platform && applied.index === i;
          return (
            <li
              key={`${platform}-${i}-${v.text}`}
              data-testid={`hook-variant-${i}`}
              data-applied={isApplied || undefined}
              className={cn(
                'flex gap-3 rounded-xl border bg-card p-3.5 transition-colors duration-(--duration-fast)',
                isApplied ? 'border-success/50 bg-success-soft' : 'hover:border-border-strong',
              )}
            >
              <span
                aria-hidden
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-md font-semibold leading-snug">{v.text}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Badge variant="primary" data-testid="hook-angle">
                    {v.angle}
                  </Badge>
                  {v.spoken ? (
                    <span className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
                      <Mic className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        <span className="font-medium text-foreground">Say this: </span>“{v.spoken}”
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {isApplied ? (
                  <Badge variant="success" data-testid="hook-applied-badge">
                    <Check /> On the clip
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={busy}
                    loading={
                      apply.isPending &&
                      apply.variables?.platform === platform &&
                      apply.variables.index === i
                    }
                    onClick={() => apply.mutate({ platform, index: i })}
                    data-testid={`hook-use-${i}`}
                  >
                    Use as title card
                  </Button>
                )}
                <CopyButton text={v.text} label="Copy hook text" testId={`hook-copy-${i}`} />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-subtle">
        The title card is burned into the video and re-renders the clip. Spoken lines are
        suggestions for a re-record or voice-over; they are not added to the audio.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------- metadata */

function HashtagEditor({
  platform,
  tags,
  onChange,
}: {
  platform: Platform;
  tags: string[];
  onChange: (t: string[]) => void;
}) {
  const [draft, setDraft] = React.useState('');
  const spec = PLATFORM_SPECS[platform];
  const commit = () => {
    if (!draft.trim()) return;
    onChange(addHashtags(tags, draft));
    setDraft('');
  };
  const limit = spec.hashtagMax ?? spec.hashtagSoft;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`tags-${platform}`} className="text-sm font-medium">
          Hashtags
        </label>
        <span className="flex items-center gap-2">
          <CharCounter
            value={tags.length}
            max={spec.hashtagMax}
            unit={spec.hashtagMax ? 'tags' : limit ? `tags (aim for ≤ ${limit})` : 'tags'}
            id={`tags-count-${platform}`}
          />
          <CopyButton
            text={tags.join(' ')}
            label="Copy hashtags"
            disabled={tags.length === 0}
            testId="meta-copy-tags"
          />
        </span>
      </div>
      <div
        className="flex flex-wrap gap-1.5 rounded-md border border-input bg-field p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
        data-testid="meta-tags"
      >
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-primary-soft pl-2.5 pr-1 text-xs font-medium text-primary-text"
            data-testid="meta-tag"
          >
            {t}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="flex size-4 items-center justify-center rounded-full hover:bg-primary/20"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={`tags-${platform}`}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            if (/[\s,]$/.test(v) && v.trim()) {
              onChange(addHashtags(tags, v));
              setDraft('');
            } else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={commit}
          placeholder={tags.length ? 'Add a hashtag' : 'Type a hashtag and press Enter'}
          aria-describedby={`tags-count-${platform}`}
          className="min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-subtle"
          data-testid="meta-tag-input"
        />
      </div>
      <p className="text-xs text-muted-foreground">{spec.hashtagHint}</p>
    </div>
  );
}

function PostingTimeEditor({
  value,
  onChange,
}: {
  value: PlatformMeta['postingTime'];
  onChange: (t: PlatformMeta['postingTime']) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="meta-time">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Best time to post</span>
        <CopyButton
          text={formatPostingTime(value)}
          label="Copy posting time"
          testId="meta-copy-time"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value.dayOfWeek === null ? 'any' : String(value.dayOfWeek)}
          onValueChange={(v) => onChange({ ...value, dayOfWeek: v === 'any' ? null : Number(v) })}
        >
          <SelectTrigger className="w-40" aria-label="Day of the week" data-testid="meta-day">
            <span>{value.dayOfWeek === null ? 'Any day' : DAY_NAMES[value.dayOfWeek]}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any day</SelectItem>
            {DAY_NAMES.map((d, i) => (
              <SelectItem key={d} value={String(i)}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(value.hour)}
          onValueChange={(v) => onChange({ ...value, hour: Number(v) })}
        >
          <SelectTrigger className="w-32" aria-label="Hour of the day" data-testid="meta-hour">
            <span className="tabular-nums">{formatHour(value.hour)}</span>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 24 }, (_, h) => (
              <SelectItem key={h} value={String(h)}>
                {formatHour(h)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-subtle">your local time</span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground" data-testid="meta-time-reason">
        {value.reason}
      </p>
      <p
        className="flex items-start gap-1.5 text-xs leading-5 text-subtle"
        data-testid="meta-time-note"
      >
        <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />A general suggestion from typical
        platform patterns, not from your own audience data. Account analytics arrive with posting in
        a later version.
      </p>
    </div>
  );
}

export function MetaTab({ clipId }: TabProps) {
  const q = useMeta(clipId);
  const gen = useGenerateMeta(clipId);
  const save = useSaveMeta(clipId);
  const [platform, setPlatform] = React.useState<Platform>('tiktok');
  const [drafts, setDrafts] = React.useState<Partial<Record<Platform, PlatformMeta>>>({});
  const [saveError, setSaveError] = React.useState<string | null>(null);

  if (q.isPending) return <TabSkeleton label="Loading metadata" />;
  const meta: ClipMeta | null = q.data ?? null;

  if (!meta)
    return (
      <div data-testid="meta-tab" className="flex flex-col gap-3">
        {q.isError ? (
          <ErrorBlock
            error={q.error}
            title="Could not load metadata"
            onRetry={() => void q.refetch()}
          />
        ) : null}
        {gen.isError ? (
          <ErrorBlock
            error={gen.error}
            title="Could not generate metadata"
            onRetry={() => gen.mutate()}
            retrying={gen.isPending}
          />
        ) : null}
        <EmptyState
          size="sm"
          icon={Hash}
          title="No metadata yet"
          description="Claude writes a title, description, hashtags and a posting-time suggestion for TikTok, Reels and Shorts, each within that platform’s limits."
          actions={
            <Button
              variant="primary"
              loading={gen.isPending}
              onClick={() => gen.mutate()}
              data-testid="meta-generate"
            >
              <Sparkles /> Generate metadata
            </Button>
          }
        />
      </div>
    );

  const saved = meta[platform];
  const m = drafts[platform] ?? saved;
  const spec = PLATFORM_SPECS[platform];
  const dirtyOf = (p: Platform) => !!drafts[p] && !metaEqual(drafts[p], meta[p]);
  const dirtyPlatforms = PLATFORMS.filter(dirtyOf);
  const dirty = dirtyPlatforms.length > 0;
  const edit = (patch: Partial<PlatformMeta>) =>
    setDrafts((d) => ({ ...d, [platform]: { ...(d[platform] ?? saved), ...patch } }));
  const issues = metaIssues(platform, m);
  const cap = captionLength(platform, m);

  const saveAll = async () => {
    setSaveError(null);
    try {
      for (const p of dirtyPlatforms) {
        const d = drafts[p];
        if (d) await save.mutateAsync({ platform: p, meta: d });
      }
      setDrafts({});
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  return (
    <div data-testid="meta-tab" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PlatformSwitch
          value={platform}
          onChange={setPlatform}
          marks={Object.fromEntries(dirtyPlatforms.map((p) => [p, 'dirty' as const]))}
          label="Metadata platform"
        />
        <div className="flex items-center gap-2">
          <CopyButton
            text={() => formatCopyAll(platform, m)}
            label={`Copy everything for ${PLATFORM_SHORT[platform]}`}
            variant="primary"
            size="sm"
            testId="meta-copy-all"
          >
            Copy all
          </CopyButton>
          <Tip
            content={
              dirty ? 'Regenerating replaces your unsaved edits' : 'Write new metadata with Claude'
            }
          >
            <Button
              variant="outline"
              size="sm"
              loading={gen.isPending}
              onClick={() =>
                gen.mutate(undefined, {
                  onSuccess: () => {
                    setDrafts({});
                    setSaveError(null);
                  },
                })
              }
              data-testid="meta-regenerate"
            >
              <RotateCcw /> Regenerate
            </Button>
          </Tip>
        </div>
      </div>

      {gen.isError ? (
        <ErrorBlock
          error={gen.error}
          title="Could not generate metadata"
          onRetry={() => gen.mutate()}
          retrying={gen.isPending}
        />
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`title-${platform}`} className="text-sm font-medium">
            {spec.titleMax === null ? 'Title (first line)' : 'Title'}
          </label>
          <span className="flex items-center gap-2">
            <CharCounter
              value={m.title.length}
              max={spec.titleMax}
              id={`title-count-${platform}`}
            />
            <CopyButton text={m.title} label="Copy title" testId="meta-copy-title" />
          </span>
        </div>
        <Input
          id={`title-${platform}`}
          value={m.title}
          invalid={spec.titleMax !== null && m.title.length > spec.titleMax}
          aria-describedby={`title-count-${platform}`}
          onChange={(e) => edit({ title: e.target.value })}
          data-testid="meta-title"
        />
        <p className="text-xs text-muted-foreground">{spec.titleHint}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`desc-${platform}`} className="text-sm font-medium">
            {platform === 'shorts' ? 'Description' : 'Caption'}
          </label>
          <span className="flex items-center gap-2">
            <CharCounter
              value={cap}
              max={spec.captionMax}
              unit="chars"
              id={`desc-count-${platform}`}
            />
            <CopyButton text={m.description} label="Copy description" testId="meta-copy-desc" />
          </span>
        </div>
        <TextArea
          id={`desc-${platform}`}
          rows={6}
          value={m.description}
          invalid={cap > spec.captionMax}
          aria-describedby={`desc-count-${platform}`}
          onChange={(e) => edit({ description: e.target.value })}
          data-testid="meta-desc"
        />
        <p className="text-xs text-muted-foreground">{spec.descHint}</p>
      </div>

      <HashtagEditor
        platform={platform}
        tags={m.hashtags}
        onChange={(hashtags) => edit({ hashtags })}
      />
      <PostingTimeEditor value={m.postingTime} onChange={(postingTime) => edit({ postingTime })} />

      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-testid="meta-issues" aria-label="Limit warnings">
          {issues.map((i) => (
            <li
              key={i.text}
              className={cn(
                'flex items-start gap-2 text-xs',
                i.level === 'error' ? 'text-danger' : 'text-warning',
              )}
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {i.text}
            </li>
          ))}
        </ul>
      ) : null}

      {saveError ? (
        <ErrorBlock
          error={saveError}
          title="Could not save metadata"
          onRetry={() => void saveAll()}
        />
      ) : null}

      <div
        className={cn(
          'sticky bottom-0 z-[5] -mx-1 flex items-center justify-between gap-3 rounded-xl border bg-popover/95 px-4 py-2.5 shadow-sm backdrop-blur transition-opacity duration-(--duration-base)',
          dirty
            ? 'opacity-100'
            : 'pointer-events-none h-0 overflow-hidden border-transparent py-0 opacity-0',
        )}
        data-testid="meta-savebar"
        aria-hidden={!dirty}
      >
        <span className="text-sm text-muted-foreground" role="status">
          {dirtyPlatforms.map((p) => PLATFORM_SHORT[p]).join(', ')}{' '}
          {dirtyPlatforms.length === 1 ? 'has' : 'have'} unsaved changes
        </span>
        <span className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDrafts({})}
            data-testid="meta-discard"
          >
            Discard
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            onClick={() => void saveAll()}
            data-testid="meta-save"
          >
            Save changes
          </Button>
        </span>
      </div>
      <p className="text-xs text-subtle">
        Generated {timeAgo(meta.generatedAt)}. Edits are saved with the clip; Regenerate asks Claude
        again and replaces all three platforms.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------------------- thumbnail */

const STOP = new Set([
  'a',
  'an',
  'the',
  'our',
  'my',
  'your',
  'of',
  'to',
  'in',
  'on',
  'for',
  'and',
  'with',
  'is',
]);
/** First five words of the title, without a dangling article/preposition at the end. */
export function suggestOverlay(title: string): string {
  const words = title.replace(/[“”"]/g, '').trim().split(/\s+/).slice(0, OVERLAY_MAX_WORDS);
  while (
    words.length > 2 &&
    STOP.has(words[words.length - 1]!.toLowerCase().replace(/[^a-z]/g, ''))
  )
    words.pop();
  return words.join(' ');
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5" title={`${label} ${percent(value)}`}>
      <span className="w-7 text-[10px] text-subtle">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${percent(value)}%` }}
        />
      </span>
    </div>
  );
}

function CandidateCard({
  clipId,
  index,
  cand,
  selected,
  isCurrent,
  tag,
  onSelect,
}: {
  clipId: string;
  index: number;
  cand: ClipThumbnails['candidates'][number];
  selected: boolean;
  isCurrent: boolean;
  tag: 'A' | 'B' | null;
  onSelect: () => void;
}) {
  const [ref, inView] = useInView<HTMLButtonElement>();
  const url = useThumbCandidateUrl(clipId, index, inView);
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={`thumb-candidate-${index}`}
      data-selected={selected || undefined}
      aria-label={`Frame at ${formatClock(cand.t)}${cand.llmRank === 1 ? ', ranked best by AI' : ''}`}
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-[border-color,box-shadow] duration-(--duration-fast)',
        selected ? 'border-primary ring-2 ring-primary/40' : 'hover:border-border-strong',
      )}
    >
      <span className="relative block aspect-[9/16] w-full bg-muted">
        {url.data?.url ? (
          <img
            src={url.data.url}
            alt=""
            loading="lazy"
            draggable={false}
            className="absolute inset-0 size-full object-cover"
            onError={() => void url.refetch()}
          />
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1">
          {cand.llmRank !== null ? (
            <span
              className="inline-flex h-5 items-center gap-1 rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground"
              data-testid="thumb-ai-rank"
            >
              <Sparkles className="size-3" aria-hidden /> AI #{cand.llmRank}
            </span>
          ) : null}
          {tag ? (
            <span
              className="inline-flex size-5 items-center justify-center rounded-full bg-black text-2xs font-bold text-white"
              data-testid={`thumb-tag-${tag}`}
            >
              {tag}
            </span>
          ) : null}
        </span>
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white">
          {formatClock(cand.t)}
        </span>
        {isCurrent ? (
          <span className="absolute bottom-1.5 left-1.5 inline-flex h-5 items-center gap-1 rounded-full bg-success px-1.5 text-2xs font-semibold text-black">
            <Check className="size-3" aria-hidden /> In use
          </span>
        ) : null}
      </span>
      <span className="flex flex-col gap-1.5 p-2">
        <span className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-wider text-subtle">Score</span>
          <span className="text-sm font-bold tabular-nums" data-testid="thumb-total">
            {percent(cand.scores.total)}
          </span>
        </span>
        <ScoreBar label="Sharp" value={cand.scores.sharpness} />
        <ScoreBar label="Face" value={cand.scores.face} />
        <ScoreBar label="Comp." value={cand.scores.composition} />
      </span>
    </button>
  );
}

export function ThumbnailTab({ clipId, clip: provided }: TabProps) {
  const clip = useClipLookup(clipId, provided);
  const q = useThumbs(clipId);
  const gen = useGenerateThumbs(clipId);
  const choose = useChooseThumb(clipId);
  const current = useClipMediaUrl(clipId, 'thumb', !!clip?.hasThumb);
  const [sel, setSel] = React.useState<number | null>(null);
  const [mode, setMode] = React.useState<'single' | 'ab'>('single');
  const [ab, setAb] = React.useState<[number | null, number | null]>([null, null]);
  const [overlay, setOverlay] = React.useState<string | null>(null);
  const [full, setFull] = React.useState(false);

  const data = q.data ?? null;
  const cands = React.useMemo(() => data?.candidates ?? [], [data]);
  const savedIdx = data ? cands.findIndex((c) => c.t === data.chosenT) : -1;
  const best = data ? bestCandidateIndex(data) : -1;
  const selIdx = sel ?? (savedIdx >= 0 ? savedIdx : best);
  const picked = selIdx >= 0 ? cands[selIdx] : undefined;
  const suggestion = suggestOverlay(clip?.title ?? '');
  const overlayText = overlay ?? data?.overlayText ?? suggestion;
  const urlA = useThumbCandidateUrl(
    clipId,
    ab[0] ?? selIdx,
    mode === 'ab' ? ab[0] !== null : selIdx >= 0,
  );
  const urlB = useThumbCandidateUrl(clipId, ab[1] ?? 0, mode === 'ab' && ab[1] !== null);

  if (q.isPending) return <TabSkeleton label="Loading thumbnail options" />;

  const onGenerate = () =>
    gen.mutate(undefined, {
      onSuccess: () => {
        setSel(null);
        setAb([null, null]);
        setOverlay(null);
      },
    });

  if (gen.isPending)
    return (
      <div data-testid="thumb-tab" className="flex flex-col gap-4">
        <div
          className="flex flex-col gap-4 rounded-xl border bg-muted/40 p-6"
          role="status"
          aria-live="polite"
          data-testid="thumb-generating"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
              <ImageIcon className="size-5 animate-pulse" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold">Finding the best frames…</p>
              <p className="text-xs text-muted-foreground">
                Sampling frames from the clip, scoring sharpness, faces and composition, then asking
                Claude’s vision model to rank them.
              </p>
            </div>
          </div>
          <Progress value={null} className="h-1.5" aria-label="Generating thumbnail options" />
        </div>
      </div>
    );

  if (!data)
    return (
      <div data-testid="thumb-tab" className="flex flex-col gap-3">
        {q.isError ? (
          <ErrorBlock
            error={q.error}
            title="Could not load thumbnails"
            onRetry={() => void q.refetch()}
          />
        ) : null}
        {gen.isError ? (
          <ErrorBlock
            error={gen.error}
            title="Could not generate thumbnails"
            onRetry={onGenerate}
          />
        ) : null}
        <EmptyState
          size="sm"
          icon={ImageIcon}
          title="Pick the best thumbnail"
          description="Clipfern samples frames from this clip, scores them for sharpness, faces and composition, and lets Claude’s vision model rank the strongest. Then test them in TikTok, Reels and Shorts feeds."
          actions={
            <Button variant="primary" onClick={onGenerate} data-testid="thumb-generate">
              <Sparkles /> Find best frames
            </Button>
          }
        />
      </div>
    );

  const overlayErr = overlayError(overlayText);
  const clean = cleanOverlay(overlayText);
  const unchanged =
    savedIdx >= 0 && picked?.t === data.chosenT && (clean ?? null) === (data.overlayText ?? null);

  const onCard = (i: number) => {
    if (mode === 'single') {
      setSel(i);
      return;
    }
    setSel(i);
    setAb(([a, b]) => {
      if (a === i || b === i) return [a === i ? null : a, b === i ? null : b];
      if (a === null) return [i, b];
      if (b === null) return [a, i];
      return [b, i];
    });
  };

  const sourceFor = (url: string | null | undefined, label: string): TesterSource => ({
    src: url ?? null,
    overlay: clean,
    label,
  });
  const testerA: TesterSource =
    mode === 'ab' && ab[0] !== null
      ? sourceFor(urlA.data?.url, 'Option A')
      : picked
        ? sourceFor(urlA.data?.url, 'Selected frame')
        : { src: current.data?.url ?? null, overlay: null, label: 'Current thumbnail' };
  const testerB: TesterSource | null =
    mode === 'ab' && ab[0] !== null && ab[1] !== null
      ? sourceFor(urlB.data?.url, 'Option B')
      : null;

  return (
    <div data-testid="thumb-tab" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {current.data?.url ? (
            <img
              src={current.data.url}
              alt="Current thumbnail"
              className="h-16 w-9 rounded-md border object-cover"
              data-testid="thumb-current"
            />
          ) : (
            <span className="flex h-16 w-9 items-center justify-center rounded-md border border-dashed text-subtle">
              <ImageIcon className="size-4" aria-hidden />
            </span>
          )}
          <div>
            <p className="text-sm font-semibold">Current thumbnail</p>
            <p className="text-xs text-muted-foreground" data-testid="thumb-current-meta">
              {data.chosenT !== null
                ? `Frame at ${formatClock(data.chosenT)}${data.overlayText ? ` · “${data.overlayText}”` : ' · no text'}`
                : 'Not chosen yet: the default frame is used.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-subtle">Generated {timeAgo(data.generatedAt)}</span>
          <Button variant="outline" size="sm" onClick={onGenerate} data-testid="thumb-regenerate">
            <RotateCcw /> Find again
          </Button>
        </div>
      </div>

      {gen.isError ? (
        <ErrorBlock error={gen.error} title="Could not generate thumbnails" onRetry={onGenerate} />
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Candidate frames">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel>
            {cands.length} candidate {cands.length === 1 ? 'frame' : 'frames'}
          </SectionLabel>
          <Segmented<'single' | 'ab'>
            label="Selection mode"
            size="sm"
            value={mode}
            onValueChange={(m) => {
              setMode(m);
              if (m === 'ab' && ab[0] === null) setAb([selIdx >= 0 ? selIdx : null, null]);
            }}
            options={[
              { value: 'single', label: 'Pick one' },
              { value: 'ab', label: 'A/B compare' },
            ]}
          />
        </div>
        {mode === 'ab' ? (
          <p className="text-xs text-muted-foreground" role="status" data-testid="thumb-ab-hint">
            {ab[0] === null
              ? 'Choose option A.'
              : ab[1] === null
                ? 'Now choose option B. Both appear side by side in the tester below.'
                : 'Comparing A and B below. Pick a frame again to swap it out.'}
          </p>
        ) : null}
        <div
          role="radiogroup"
          aria-label="Candidate frames"
          className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3"
        >
          {cands.map((c, i) => (
            <CandidateCard
              key={c.key}
              clipId={clipId}
              index={i}
              cand={c}
              selected={mode === 'ab' ? ab.includes(i) : i === selIdx}
              isCurrent={i === savedIdx}
              tag={mode === 'ab' ? (ab[0] === i ? 'A' : ab[1] === i ? 'B' : null) : null}
              onSelect={() => onCard(i)}
            />
          ))}
        </div>
        {picked ? (
          <div
            className="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm"
            data-testid="thumb-detail"
          >
            <p className="font-medium">
              Frame at {formatClock(picked.t)} ·{' '}
              <span className="tabular-nums">score {percent(picked.scores.total)}</span>
              {picked.llmRank !== null ? ` · AI rank #${picked.llmRank}` : ' · not ranked by AI'}
            </p>
            {picked.llmNote ? (
              <p
                className="mt-0.5 text-xs leading-5 text-muted-foreground"
                data-testid="thumb-ai-note"
              >
                {picked.llmNote}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-label="Thumbnail text">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={`overlay-${clipId}`} className="text-sm font-medium">
            Text on the thumbnail
          </label>
          <span
            className={cn(
              'text-2xs tabular-nums',
              overlayErr ? 'font-semibold text-danger' : 'text-subtle',
            )}
            data-testid="thumb-overlay-count"
          >
            {countWords(overlayText)} / {OVERLAY_MAX_WORDS} words
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            id={`overlay-${clipId}`}
            value={overlayText}
            invalid={!!overlayErr}
            maxLength={80}
            placeholder="Optional: 2–4 big words work best"
            onChange={(e) => setOverlay(e.target.value)}
            data-testid="thumb-overlay"
          />
          {suggestion && overlayText !== suggestion ? (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setOverlay(suggestion)}
              data-testid="thumb-suggest"
            >
              <Wand2 /> Suggestion
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground" role={overlayErr ? 'alert' : undefined}>
          {overlayErr ?? 'Suggested from the clip title. Leave it empty for a clean frame.'}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="primary"
            disabled={!picked || !!overlayErr || unchanged}
            loading={choose.isPending}
            onClick={() => picked && choose.mutate({ t: picked.t, overlayText: clean })}
            data-testid="thumb-choose"
          >
            <Check /> {unchanged ? 'In use' : 'Use this thumbnail'}
          </Button>
          {mode === 'ab' && ab[0] !== null && ab[1] !== null ? (
            <>
              <Button
                variant="outline"
                size="sm"
                loading={choose.isPending}
                disabled={!!overlayErr}
                onClick={() => {
                  const c = cands[ab[0]!];
                  if (c) choose.mutate({ t: c.t, overlayText: clean });
                }}
                data-testid="thumb-use-a"
              >
                Use A
              </Button>
              <Button
                variant="outline"
                size="sm"
                loading={choose.isPending}
                disabled={!!overlayErr}
                onClick={() => {
                  const c = cands[ab[1]!];
                  if (c) choose.mutate({ t: c.t, overlayText: clean });
                }}
                data-testid="thumb-use-b"
              >
                Use B
              </Button>
            </>
          ) : null}
          {choose.isSuccess && unchanged ? (
            <span className="text-xs text-success" role="status">
              Saved. The clip card now shows this frame.
            </span>
          ) : null}
        </div>
      </section>

      <ThumbnailTester
        a={testerA}
        b={testerB}
        clipTitle={clip?.title ?? ''}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFull(true)}
            data-testid="tester-expand"
          >
            <Maximize2 /> Full size
          </Button>
        }
      />
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent
          className="h-[min(92vh,980px)] max-h-none max-w-[1180px] overflow-y-auto p-6"
          data-testid="tester-dialog"
        >
          <DialogTitle className="sr-only">Thumbnail Tester, full size</DialogTitle>
          <DialogDescription className="sr-only">
            Your thumbnail in TikTok, Reels and Shorts feed mockups at full size.
          </DialogDescription>
          <ThumbnailTester a={testerA} b={testerB} clipTitle={clip?.title ?? ''} maxZoom={1.3} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------- reframe */

const MODE_BLURB: Record<ReframeMode, string> = {
  auto: 'Picks the layout from the footage: one speaker, two people, or a shared screen.',
  'single-face': 'A smooth crop that follows the main speaker.',
  'multi-face': 'Two speakers stacked, each in their own panel.',
  'screen-face': 'The shared screen on top, the speaker’s face below.',
  center: 'A fixed crop of the centre of the frame. No tracking.',
};

/** Tiny diagram of the output frame for a reframe mode. */
function ModeDiagram({ mode }: { mode: ReframeMode }) {
  const panel = 'rounded-[3px] border border-primary/50 bg-primary-soft';
  const face = <span className="block size-2.5 rounded-full bg-primary-text/80" />;
  return (
    <span
      aria-hidden
      className="flex h-14 w-8 shrink-0 flex-col gap-0.5 rounded-md border border-border-strong bg-muted p-0.5"
    >
      {mode === 'multi-face' ? (
        <>
          <span className={cn(panel, 'flex flex-1 items-center justify-center')}>{face}</span>
          <span className={cn(panel, 'flex flex-1 items-center justify-center')}>{face}</span>
        </>
      ) : mode === 'screen-face' ? (
        <>
          <span className={cn(panel, 'flex-[1.6]')} />
          <span className={cn(panel, 'flex flex-1 items-center justify-center')}>{face}</span>
        </>
      ) : mode === 'center' ? (
        <span className={cn(panel, 'mx-auto my-auto h-8 w-5')} />
      ) : mode === 'single-face' ? (
        <span className={cn(panel, 'flex flex-1 items-center justify-center')}>{face}</span>
      ) : (
        <span className={cn(panel, 'flex flex-1 items-center justify-center text-primary-text')}>
          <Wand2 className="size-3" />
        </span>
      )}
    </span>
  );
}

export function ReframeTab({ clipId, clip: provided }: TabProps) {
  const clip = useClipLookup(clipId, provided);
  const videos = useVideos();
  const styles = useCaptionStyles(true);
  const reframe = useReframeClips();
  const rerender = useRerenderClip();
  const exportSubs = useExportClipSubtitles();
  const [mode, setMode] = React.useState<ReframeMode | null>(null);
  const video = videos.data?.items.find((v) => v.id === clip?.videoId);

  if (!clip) return <TabSkeleton label="Loading clip" />;
  const chosen = mode ?? clip.reframeMode;
  const changed = chosen !== clip.reframeMode;
  const busy = isClipBusy(clip);
  const styleName =
    styles.data?.styles.find((s) => s.id === clip.captionStyleId)?.name ?? clip.captionStyleId;
  const note = layoutFallbackNote(clip);
  const outdated = captionsOutdated(clip, video?.subtitleRev);

  return (
    <div data-testid="reframe-tab" className="flex flex-col gap-5">
      <RenderStrip clip={clip} />
      {outdated ? (
        <Banner
          tone="warning"
          title="Captions are outdated"
          action={
            <Button
              size="sm"
              variant="outline"
              loading={rerender.isPending}
              disabled={busy}
              onClick={() => rerender.mutate({ id: clip.id })}
              data-testid="captions-rerender"
            >
              <RotateCcw /> Re-render
            </Button>
          }
        >
          Subtitle edits were saved after this clip was rendered. Re-render to burn them in.
        </Banner>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Reframe mode">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Reframe mode</SectionLabel>
          <span
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="reframe-layout"
          >
            Last render:
            <Badge variant={clip.layout ? 'primary' : 'neutral'}>
              {clip.layout ? LAYOUT_LABELS[clip.layout] : 'not rendered yet'}
            </Badge>
          </span>
        </div>
        <div role="radiogroup" aria-label="Reframe mode" className="grid gap-2">
          {REFRAME_MODES.map((m) => {
            const active = m === chosen;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setMode(m)}
                data-testid={`reframe-mode-${m}`}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-2.5 text-left transition-colors duration-(--duration-fast)',
                  active
                    ? 'border-primary/70 bg-primary-soft'
                    : 'bg-card hover:border-border-strong hover:bg-accent/40',
                )}
              >
                <ModeDiagram mode={m} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {REFRAME_MODE_LABELS[m]}
                    {m === clip.reframeMode ? <Badge variant="neutral">Current</Badge> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {MODE_BLURB[m]}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full border',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border-strong',
                  )}
                >
                  {active ? <Check className="size-3" /> : null}
                </span>
              </button>
            );
          })}
        </div>
        {note ? (
          <p
            className="flex items-start gap-1.5 text-xs leading-5 text-warning"
            data-testid="reframe-note"
          >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {note}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!changed || busy}
            loading={reframe.isPending}
            onClick={() =>
              reframe.mutate({ ids: [clip.id], mode: chosen }, { onSuccess: () => setMode(null) })
            }
            data-testid="reframe-apply"
          >
            <RotateCcw /> Re-render with {REFRAME_MODE_LABELS[chosen].toLowerCase()}
          </Button>
          {changed ? (
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
              Cancel
            </Button>
          ) : (
            <span className="text-xs text-subtle">
              {busy ? 'Wait for the current render to finish.' : 'Pick another mode to re-render.'}
            </span>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Caption style">
        <SectionLabel>Caption style</SectionLabel>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
            <Palette className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" data-testid="caption-style-name">
              {styleName}
            </p>
            <p className="text-xs text-muted-foreground">
              Used for this clip’s burned-in captions.
            </p>
          </div>
          <StyleStudioButton clip={clip} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Subtitle files">
        <SectionLabel>Subtitle files</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          {(['srt', 'vtt'] as const).map((f) => (
            <Button
              key={f}
              variant="outline"
              size="sm"
              loading={exportSubs.isPending && exportSubs.variables?.format === f}
              onClick={() =>
                exportSubs.mutate({ videoId: clip.videoId, clipId: clip.id, format: f })
              }
              data-testid={`subs-${f}`}
            >
              <Download /> Export {f.toUpperCase()}
            </Button>
          ))}
          <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
            <AudioLines className="size-3.5" aria-hidden /> Timed to this clip, from the edited
            transcript.
          </span>
        </div>
      </section>
    </div>
  );
}

/** Opens the Caption Style Studio on this clip's frames; applying a style re-renders just this clip. */
function StyleStudioButton({ clip }: { clip: ClipView }) {
  const [open, setOpen] = React.useState(false);
  const restyle = useRestyleClips();
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={isClipBusy(clip)}
        onClick={() => setOpen(true)}
        data-testid="caption-style-change"
      >
        <Palette /> Change style…
      </Button>
      <StyleStudio
        open={open}
        onOpenChange={setOpen}
        currentStyleId={clip.captionStyleId}
        clipId={clip.id}
        title="Caption style for this clip"
        description="Pick a preset or tune every detail. Only this clip is re-rendered."
        applyLabel="Re-render with this style"
        onApply={async (styleId) => {
          if (styleId !== clip.captionStyleId)
            await restyle.mutateAsync({ ids: [clip.id], styleId });
          setOpen(false);
        }}
      />
    </>
  );
}
