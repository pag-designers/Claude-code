'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, CircleCheck, Send, Sparkles, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import type { Platform } from '@shared/cp2';
import type {
  FieldIssue,
  MediaReport,
  PostDraft,
  PostFields,
  PostSource,
  SocialAccount,
} from '@shared/publish';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettings } from '@/lib/settings';
import { useDebounced } from '@/lib/use-debounced';
import { formatWhen, localZoneId, localZoneLabel } from '@/lib/publish/dates';
import {
  PLATFORM_INFO,
  PLATFORM_ORDER,
  PLATFORM_STYLE,
  accountLabel,
  enforceTiktokAudit,
  isTiktokUnaudited,
  localFieldIssues,
  mergeShared,
  reportBlocks,
} from '@/lib/publish/model';
import { useNowMs } from '@/lib/publish/now';
import { applyOverrides, earliestStart, planBulk, rowWarnings, seedOf } from '@/lib/publish/plan';
import {
  useAccounts,
  useCreatePosts,
  usePostingWindows,
  usePosts,
  usePrefills,
  useValidations,
} from '@/lib/publish/queries';
import { cn } from '@/lib/utils';
import { DateTimeField, FormField } from './fields';
import { MediaReportView } from './media-report';
import { PlatformFields } from './platform-fields';
import { AccountAvatar, PlatformIcon } from './platform';
import { SourceThumb, sourceKey, useSourceMeta, type SourceMeta } from './source';

type WhenMode = 'now' | 'time' | 'smart';
const LAST_ACCOUNTS_KEY = 'clipfern.schedule.accounts';

function readLastAccounts(): string[] {
  try {
    const raw = localStorage.getItem(LAST_ACCOUNTS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeLastAccounts(ids: string[]) {
  try {
    localStorage.setItem(LAST_ACCOUNTS_KEY, JSON.stringify(ids));
  } catch {
    /* storage blocked: the choice is simply not remembered */
  }
}

interface Refusal {
  label: string;
  platform: Platform;
  accountName: string;
  reason: string;
  report: MediaReport | null;
  fieldIssues: FieldIssue[];
}

const newGroupId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `g-${Math.random().toString(36).slice(2)}`;

/* ------------------------------------------------------------------------------- sub-views ----- */

function SourceSummary({ metas }: { metas: SourceMeta[] }) {
  if (metas.length === 1) {
    const m = metas[0]!;
    return (
      <div className="flex items-center gap-3" data-testid="schedule-source">
        <SourceThumb meta={m} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{m.title}</p>
          <p className="text-xs text-muted-foreground">
            {m.kind === 'export' ? 'Editor export' : 'Library clip'}
            {m.durationSec !== null ? ` · ${Math.round(m.durationSec)} s` : ''}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3" data-testid="schedule-source">
      <div className="flex -space-x-3">
        {metas.slice(0, 4).map((m) => (
          <SourceThumb key={sourceKey(m.source)} meta={m} className="w-9 border-2 border-popover" />
        ))}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{metas.length} clips</p>
        <p className="truncate text-xs text-muted-foreground">
          {metas
            .slice(0, 3)
            .map((m) => m.title)
            .join(' · ')}
          {metas.length > 3 ? ` · +${metas.length - 3} more` : ''}
        </p>
      </div>
    </div>
  );
}

function AccountPicker({
  accounts,
  selected,
  onToggle,
}: {
  accounts: readonly SocialAccount[];
  selected: readonly string[];
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-2 max-[640px]:grid-cols-1" aria-label="Accounts to post to">
      {accounts.map((a) => {
        const usable = a.status === 'connected';
        const on = usable && selected.includes(a.id);
        return (
          <li key={a.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-disabled={!usable || undefined}
              disabled={!usable}
              data-testid="schedule-account"
              data-account-id={a.id}
              data-selected={on || undefined}
              onClick={() => onToggle(a.id)}
              className={cn(
                'flex w-full min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left outline-none transition-[background-color,border-color] duration-(--duration-fast)',
                'focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60',
                on
                  ? 'border-primary/70 bg-primary-soft'
                  : 'border-border-strong bg-transparent hover:bg-accent/60',
              )}
            >
              <AccountAvatar account={a} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.displayName}</span>
                <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <PlatformIcon platform={a.platform} className="size-3" />
                  {PLATFORM_INFO[a.platform].name}
                  {a.handle ? ` · @${a.handle}` : ''}
                </span>
                {!usable ? (
                  <span className="mt-0.5 block text-xs text-warning">
                    Needs re-auth: reconnect in Settings
                  </span>
                ) : null}
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border',
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border-strong text-transparent',
                )}
              >
                <CircleCheck className="size-3.5" />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TiktokAuditBanner({
  mode,
  onUseDrafts,
}: {
  mode: 'direct' | 'draft';
  onUseDrafts: () => void;
}) {
  return (
    <Banner tone="warning" title="TikTok has not audited this app yet">
      <div data-testid="tiktok-unaudited" className="flex flex-col gap-2.5">
        <p>
          Until TikTok approves your app, direct posts can only be <strong>private</strong> (visible
          only to you). To publish publicly now, upload the video to your TikTok drafts and press
          Post in the TikTok app yourself.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={mode === 'draft' ? 'soft' : 'outline'}
            onClick={onUseDrafts}
            aria-pressed={mode === 'draft'}
            data-testid="tiktok-use-drafts"
          >
            <UploadCloud />{' '}
            {mode === 'draft'
              ? 'Uploading to drafts'
              : 'Upload to drafts so I publish in the TikTok app'}
          </Button>
          <Link
            href="/settings/integrations/#tiktok-audit"
            className="text-sm font-medium text-primary-text underline-offset-2 hover:underline"
            data-testid="tiktok-audit-link"
          >
            See the audit checklist
          </Link>
        </div>
      </div>
    </Banner>
  );
}

/* ---------------------------------------------------------------------------------- dialog ----- */

export interface SchedulePostDialogProps {
  source: PostSource | PostSource[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultAccountIds?: string[];
  /** Pre-fills "Pick a time" (a day clicked in the calendar). */
  defaultScheduledAt?: number | null;
}

function Inner({
  sources,
  onOpenChange,
  defaultAccountIds,
  defaultScheduledAt,
}: {
  sources: PostSource[];
  onOpenChange: (open: boolean) => void;
  defaultAccountIds?: string[];
  defaultScheduledAt?: number | null;
}) {
  const router = useRouter();
  const now = useNowMs();
  const multi = sources.length > 1;
  const { settings } = useSettings();
  const metas = useSourceMeta(sources);
  const accountsQ = useAccounts();
  const accounts = React.useMemo(() => accountsQ.data?.accounts ?? [], [accountsQ.data]);
  const connected = React.useMemo(
    () => accounts.filter((a) => a.status === 'connected'),
    [accounts],
  );
  const create = useCreatePosts();

  /* accounts */
  const [picked, setPicked] = React.useState<string[] | null>(null);
  const initialPick = React.useMemo(() => {
    const ids = new Set(connected.map((a) => a.id));
    const fromProps = (defaultAccountIds ?? []).filter((id) => ids.has(id));
    if (fromProps.length) return fromProps;
    const last = readLastAccounts().filter((id) => ids.has(id));
    return last.length ? last : connected.map((a) => a.id);
  }, [connected, defaultAccountIds]);
  const selectedIds = picked ?? initialPick;
  const selectedAccounts = React.useMemo(
    () => connected.filter((a) => selectedIds.includes(a.id)),
    [connected, selectedIds],
  );
  const platforms = PLATFORM_ORDER.filter((p) => selectedAccounts.some((a) => a.platform === p));
  const [tabState, setTab] = React.useState<Platform | null>(null);
  const tab = tabState && platforms.includes(tabState) ? tabState : (platforms[0] ?? null);

  /* prefill */
  const pairs = React.useMemo(
    () => platforms.flatMap((platform) => sources.map((source) => ({ source, platform }))),
    [platforms, sources],
  );
  const prefills = usePrefills(pairs);
  const slot = (platform: Platform, i: number) => platforms.indexOf(platform) * sources.length + i;
  const prefillOf = (platform: Platform, i: number) => prefills[slot(platform, i)]?.data;

  /* fields */
  const [edits, setEdits] = React.useState<Partial<Record<Platform, PostFields>>>({});
  const [kidsDecl, setKidsDecl] = React.useState<boolean | null>(null);
  const currentFields = (platform: Platform): PostFields | undefined =>
    edits[platform] ?? prefillOf(platform, 0)?.fields;

  const fieldsFor = (platform: Platform, i: number, account: SocialAccount): PostFields | null => {
    const own = prefillOf(platform, i)?.fields;
    if (!own) return null;
    const edited = edits[platform];
    let f: PostFields = edited ? (multi ? mergeShared(own, edited) : edited) : own;
    if (f.platform === 'shorts') f = { ...f, madeForKids: kidsDecl ?? false };
    return enforceTiktokAudit(f, isTiktokUnaudited(account));
  };

  /* media + field validation (single clip: with the typed fields) */
  const debouncedEdits = useDebounced(edits, 400);
  const requests = React.useMemo(
    () =>
      platforms.flatMap((platform) =>
        sources.map((source) => {
          const fields = multi ? undefined : debouncedEdits[platform];
          return fields ? { source, platform, fields } : { source, platform };
        }),
      ),
    [platforms, sources, multi, debouncedEdits],
  );
  const validations = useValidations(requests);
  const validationOf = (platform: Platform, i: number) => validations[slot(platform, i)];

  /* auto fix */
  const [autoFixPick, setAutoFix] = React.useState<boolean | null>(null);
  const autoFix = autoFixPick ?? settings.autoFixMedia;

  /* when */
  const [whenMode, setWhenMode] = React.useState<WhenMode>(multi ? 'smart' : 'time');
  const [timePick, setTimePick] = React.useState<number | null>(defaultScheduledAt ?? null);
  const suggestedTimes = multi
    ? []
    : platforms
        .map((p) => prefillOf(p, 0)?.suggestedAt ?? null)
        .filter((t): t is number => t !== null && now !== null && t > now);
  const suggested = suggestedTimes.length ? Math.min(...suggestedTimes) : null;
  const time = timePick ?? suggested ?? (now !== null ? earliestStart(now, 60) : null);
  const [startAfter, setStartAfter] = React.useState<number | null>(null);
  const [overrides, setOverrides] = React.useState<Record<string, number>>({});

  const existing = usePosts().data?.items;
  const windows = usePostingWindows(multi);
  const plan = React.useMemo(
    () =>
      multi && now !== null && selectedAccounts.length
        ? planBulk({
            clips: sources.length,
            accounts: selectedAccounts.map((a) => ({ id: a.id, platform: a.platform })),
            now,
            timeZone: localZoneId(),
            windows,
            minGapMinutes: settings.schedulerMinGapMinutes,
            maxPerDay: settings.schedulerMaxPerDay,
            existing: existing ?? [],
            seed: seedOf(sources.map(sourceKey)),
            notBefore: startAfter,
          })
        : null,
    [
      multi,
      now,
      selectedAccounts,
      sources,
      windows,
      settings.schedulerMinGapMinutes,
      settings.schedulerMaxPerDay,
      existing,
      startAfter,
    ],
  );
  const rows = React.useMemo(
    () => (plan ? applyOverrides(plan.rows, overrides) : []),
    [plan, overrides],
  );
  const warnings = React.useMemo(
    () =>
      now !== null
        ? rowWarnings(rows, {
            now,
            minGapMinutes: settings.schedulerMinGapMinutes,
            maxPerDay: settings.schedulerMaxPerDay,
            existing: existing ?? [],
          })
        : {},
    [rows, now, settings.schedulerMinGapMinutes, settings.schedulerMaxPerDay, existing],
  );

  /* submit */
  const [done, setDone] = React.useState<Set<string>>(new Set());
  const [refusals, setRefusals] = React.useState<Refusal[]>([]);

  const planned = (() => {
    const out: {
      key: string;
      sourceIndex: number;
      account: SocialAccount;
      fields: PostFields | null;
      scheduledAt: number | null;
    }[] = [];
    sources.forEach((_s, i) =>
      selectedAccounts.forEach((account) => {
        const key = `${i}:${account.id}`;
        if (done.has(key)) return;
        const scheduledAt =
          whenMode === 'now'
            ? null
            : whenMode === 'time'
              ? time
              : (rows.find((r) => r.key === key)?.at ?? null);
        out.push({
          key,
          sourceIndex: i,
          account,
          fields: fieldsFor(account.platform, i, account),
          scheduledAt,
        });
      }),
    );
    return out;
  })();

  /* what stops us */
  const problems: string[] = [];
  const platformIssues = (platform: Platform): FieldIssue[] => {
    if (multi) return [];
    const v = validationOf(platform, 0)?.data;
    const f = currentFields(platform);
    return [...(v?.fieldIssues ?? []), ...(f ? localFieldIssues(f) : [])];
  };
  const platformBlocked = (platform: Platform): boolean => {
    if (multi) return false;
    return reportBlocks(validationOf(platform, 0)?.data?.report, autoFix);
  };
  if (!selectedAccounts.length) problems.push('Choose at least one account.');
  if (platforms.includes('shorts') && kidsDecl === null)
    problems.push('Answer “Is this video made for kids?” on the YouTube tab.');
  for (const p of platforms) {
    if (platformIssues(p).length)
      problems.push(`Fix the highlighted fields on the ${PLATFORM_INFO[p].short} tab.`);
    if (platformBlocked(p))
      problems.push(
        `The video does not meet ${PLATFORM_INFO[p].short}'s requirements. Turn on Auto-fix or replace the clip.`,
      );
  }
  if (planned.some((x) => !x.fields)) problems.push('Loading the default fields…');
  if (whenMode === 'time' && (time === null || (now !== null && time <= now)))
    problems.push('Pick a time in the future.');
  if (whenMode === 'smart' && plan && planned.some((x) => x.scheduledAt === null))
    problems.push('Some posts have no free slot. Widen the posting windows or lower the limits.');
  if (
    whenMode === 'smart' &&
    Object.keys(warnings).some((k) => !done.has(k) && warnings[k] === 'This time is in the past.')
  )
    problems.push('One of the times is in the past.');

  const count = planned.length;
  const busy = create.isPending;

  const submit = async () => {
    const items = planned.filter((x) => x.fields);
    if (!items.length) return;
    const groupId = items.length > 1 ? newGroupId() : null;
    const payload: PostDraft[] = items.map((x) => ({
      source: sources[x.sourceIndex]!,
      accountId: x.account.id,
      fields: x.fields!,
      scheduledAt: x.scheduledAt,
      autoFix,
      groupId,
    }));
    writeLastAccounts(selectedAccounts.map((a) => a.id));
    try {
      const res = await create.mutateAsync({ items: payload });
      const refusedIdx = new Set(res.refused.map((r) => r.index));
      const nextDone = new Set(done);
      items.forEach((x, idx) => {
        if (!refusedIdx.has(idx)) nextDone.add(x.key);
      });
      setDone(nextDone);
      setRefusals(
        res.refused.map((r) => {
          const x = items[r.index];
          return {
            label: x ? (metas[x.sourceIndex]?.title ?? 'Clip') : 'Clip',
            platform: x?.account.platform ?? 'shorts',
            accountName: x ? accountLabel(x.account) : '',
            reason: r.reason,
            report: r.report,
            fieldIssues: r.fieldIssues,
          };
        }),
      );
      const made = res.posts.length;
      if (made > 0)
        toast.success(
          whenMode === 'now'
            ? made === 1
              ? 'Posting now'
              : `Posting ${made} posts now`
            : made === 1
              ? 'Post scheduled'
              : `${made} posts scheduled`,
          {
            description: res.refused.length
              ? `${res.refused.length} could not be scheduled. See the details.`
              : undefined,
            action: { label: 'View in Scheduler', onClick: () => router.push('/scheduler/') },
          },
        );
      if (!res.refused.length) onOpenChange(false);
    } catch (e) {
      toast.error('Could not schedule', {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  /* ---------------------------------------------------------------------------- render ----- */

  const loadingAccounts = accountsQ.isPending;
  const noAccounts = !loadingAccounts && connected.length === 0;
  const primaryLabel =
    whenMode === 'now'
      ? count > 1
        ? `Post ${count} now`
        : 'Post now'
      : count > 1
        ? `Schedule ${count} posts`
        : 'Schedule post';

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-semibold">
          {multi ? `Schedule ${sources.length} clips` : 'Schedule a post'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Choose accounts, review the platform details and pick when it goes out.
        </DialogDescription>
        <div className="mt-2">
          <SourceSummary metas={metas} />
        </div>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-6" data-testid="schedule-body">
        {refusals.length ? (
          <div className="flex flex-col gap-3" data-testid="schedule-refusals">
            <Banner
              tone="danger"
              title={`${refusals.length} ${refusals.length === 1 ? 'post was' : 'posts were'} not scheduled`}
            >
              {done.size
                ? `${done.size} other ${done.size === 1 ? 'post is' : 'posts are'} in the queue. `
                : ''}
              Fix the problem below and press the button again to retry only the refused ones.
            </Banner>
            {refusals.map((r, i) => (
              <div
                key={`${r.label}-${r.accountName}-${i}`}
                className="flex flex-col gap-3 rounded-xl border border-danger/35 p-4"
                data-testid="refusal"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <PlatformIcon platform={r.platform} />
                  <span className="truncate">{r.label}</span>
                  <span className="truncate font-normal text-muted-foreground">
                    to {r.accountName}
                  </span>
                </div>
                <p className="text-sm text-danger" data-testid="refusal-reason">
                  {r.reason}
                </p>
                {r.fieldIssues.length ? (
                  <ul className="list-disc pl-5 text-xs text-muted-foreground">
                    {r.fieldIssues.map((f) => (
                      <li key={`${f.field}-${f.message}`}>
                        <strong className="font-medium text-foreground">{f.field}:</strong>{' '}
                        {f.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {r.report ? (
                  <MediaReportView
                    platform={r.platform}
                    report={r.report}
                    autoFix={autoFix}
                    onAutoFixChange={setAutoFix}
                    switchId={`refusal-autofix-${i}`}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <section aria-label="Accounts" className="flex flex-col gap-3">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">Post to</h3>
          {loadingAccounts ? (
            <div className="grid grid-cols-2 gap-2" aria-busy aria-label="Loading accounts">
              <Skeleton className="h-16 rounded-xl" />
              <Skeleton className="h-16 rounded-xl" />
            </div>
          ) : noAccounts ? (
            <Banner
              tone="info"
              title="Connect an account first"
              action={
                <Button size="sm" variant="primary" asChild>
                  <Link href="/settings/integrations/" onClick={() => onOpenChange(false)}>
                    Connect an account
                  </Link>
                </Button>
              }
            >
              Clipfern posts through YouTube, Instagram and TikTok&apos;s official APIs with your
              own accounts. Connect one in Settings → Integrations.
            </Banner>
          ) : (
            <>
              <AccountPicker
                accounts={accounts}
                selected={selectedIds}
                onToggle={(id) =>
                  setPicked(
                    selectedIds.includes(id)
                      ? selectedIds.filter((x) => x !== id)
                      : [...selectedIds, id],
                  )
                }
              />
              {accounts.some((a) => a.status !== 'connected') ? (
                <p className="text-xs text-muted-foreground">
                  Accounts that need re-authorisation can&apos;t be used until you reconnect them in{' '}
                  <Link
                    href="/settings/integrations/"
                    className="font-medium text-primary-text hover:underline"
                  >
                    Settings
                  </Link>
                  .
                </p>
              ) : null}
            </>
          )}
        </section>

        {tab ? (
          <section aria-label="Platform details" className="flex flex-col gap-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">
              Details per platform
            </h3>
            <Tabs value={tab} onValueChange={(v) => setTab(v as Platform)}>
              <TabsList variant="pill" aria-label="Platform" className="w-fit">
                {platforms.map((p) => {
                  const bad =
                    platformIssues(p).length > 0 ||
                    platformBlocked(p) ||
                    (p === 'shorts' && kidsDecl === null);
                  return (
                    <TabsTrigger key={p} value={p} variant="pill" data-testid={`schedule-tab-${p}`}>
                      <PlatformIcon platform={p} />
                      {PLATFORM_INFO[p].short}
                      {bad ? (
                        <span
                          className="size-1.5 rounded-full bg-danger"
                          role="img"
                          aria-label="needs attention"
                        />
                      ) : null}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {platforms.map((p) => {
                const f = currentFields(p);
                const v = validationOf(p, 0);
                const tiktokAccounts = selectedAccounts.filter((a) => a.platform === p);
                const unaudited = tiktokAccounts.some(isTiktokUnaudited);
                const reports = sources.map((_s, i) => validationOf(p, i)?.data?.report);
                const blockedN = reports.filter((r) => reportBlocks(r, autoFix)).length;
                const needFixN = reports.filter((r) => r && r.issues.length).length;
                return (
                  <TabsContent key={p} value={p} className="mt-4 flex flex-col gap-5">
                    {p === 'tiktok' && unaudited && f?.platform === 'tiktok' ? (
                      <TiktokAuditBanner
                        mode={f.mode}
                        onUseDrafts={() =>
                          setEdits((e) => ({
                            ...e,
                            tiktok: { ...f, mode: 'draft', privacyLevel: 'SELF_ONLY' },
                          }))
                        }
                      />
                    ) : null}
                    {multi ? (
                      <div
                        className="rounded-xl border bg-muted/30 p-3.5 text-sm"
                        data-testid="bulk-media-summary"
                      >
                        <p className="font-medium">
                          {reports.some((r) => !r)
                            ? 'Checking every clip against ' + PLATFORM_INFO[p].name + '…'
                            : blockedN
                              ? `${blockedN} of ${sources.length} clips do not meet ${PLATFORM_INFO[p].short}'s requirements`
                              : needFixN
                                ? `${needFixN} of ${sources.length} clips will be re-encoded`
                                : `All ${sources.length} clips meet ${PLATFORM_INFO[p].short}'s requirements`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Titles and descriptions come from each clip&apos;s own metadata. The
                          settings below apply to every clip.
                        </p>
                      </div>
                    ) : (
                      <MediaReportView
                        platform={p}
                        report={v?.data?.report}
                        loading={v?.isFetching}
                        error={v?.error?.message}
                        autoFix={autoFix}
                        onAutoFixChange={setAutoFix}
                        switchId={`schedule-autofix-${p}`}
                      />
                    )}
                    {f ? (
                      <PlatformFields
                        fields={f}
                        onChange={(nf) => setEdits((e) => ({ ...e, [p]: nf }))}
                        issues={v?.data?.fieldIssues ?? []}
                        idPrefix={`sched-${p}`}
                        durationSec={
                          metas[0]?.durationSec ?? v?.data?.report.media.durationSec ?? null
                        }
                        tiktokUnaudited={unaudited}
                        sharedOnly={multi}
                        kids={
                          p === 'shorts'
                            ? {
                                value: kidsDecl,
                                onChange: (val) => setKidsDecl(val),
                              }
                            : undefined
                        }
                      />
                    ) : (
                      <div className="flex flex-col gap-3" aria-busy aria-label="Loading fields">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-9 w-2/3" />
                      </div>
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>
            {multi ? (
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn('size-2 rounded-full', tab ? PLATFORM_STYLE[tab].bar : '')}
                  aria-hidden
                />
                <span className="text-muted-foreground">
                  Showing {PLATFORM_INFO[tab].name}. Switch tabs to change the other platforms.
                </span>
              </div>
            ) : null}
          </section>
        ) : null}

        <section aria-label="When" className="flex flex-col gap-3">
          <h3 className="text-2xs font-semibold uppercase tracking-wider text-subtle">When</h3>
          <Segmented<WhenMode>
            label="When to post"
            value={whenMode}
            onValueChange={setWhenMode}
            options={[
              { value: 'now', label: 'Post now', icon: <Send /> },
              ...(multi
                ? []
                : [{ value: 'time' as const, label: 'Pick a time', icon: <CalendarClock /> }]),
              ...(multi
                ? [{ value: 'smart' as const, label: 'Smart spacing', icon: <Sparkles /> }]
                : []),
            ]}
          />
          {whenMode === 'now' ? (
            <p className="text-sm text-muted-foreground" data-testid="when-now">
              {count > 1
                ? `All ${count} posts start publishing right away. Platforms with daily limits may delay some.`
                : 'Publishing starts as soon as you confirm.'}
            </p>
          ) : null}
          {whenMode === 'time' ? (
            <div className="flex flex-col gap-2.5">
              <FormField
                id="schedule-time"
                label="Publish at"
                error={
                  time !== null && now !== null && time <= now
                    ? 'Pick a time in the future.'
                    : undefined
                }
              >
                <DateTimeField
                  id="schedule-time"
                  label="Publish at"
                  value={time}
                  min={now ?? undefined}
                  onChange={setTimePick}
                />
              </FormField>
              {suggested !== null && now !== null && time !== suggested ? (
                <button
                  type="button"
                  onClick={() => setTimePick(suggested)}
                  className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/50 bg-primary-soft px-3 py-1 text-xs font-medium text-primary-text outline-none transition-colors hover:bg-primary-soft focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="suggested-time"
                >
                  <Sparkles className="size-3" aria-hidden /> Suggested:{' '}
                  {formatWhen(suggested, now)}
                </button>
              ) : null}
            </div>
          ) : null}
          {whenMode === 'smart' && plan ? (
            <div className="flex flex-col gap-3" data-testid="smart-plan">
              <p className="text-sm text-muted-foreground">
                Spreads {sources.length} clips across your best times:{' '}
                {plan.usedDefaultWindows
                  ? 'lunch and evening (set your own posting windows in a Brand Kit)'
                  : 'your Brand Kit posting windows'}
                , at least {settings.schedulerMinGapMinutes} min apart and at most{' '}
                {settings.schedulerMaxPerDay} a day per account. Adjust any time below.
              </p>
              <FormField id="schedule-start" label="Start no earlier than" hint="Optional.">
                <DateTimeField
                  id="schedule-start"
                  label="Start no earlier than"
                  value={startAfter}
                  min={now ?? undefined}
                  onChange={(v) => {
                    setStartAfter(v);
                    setOverrides({});
                  }}
                  hideZone
                  className="w-64"
                />
              </FormField>
              {plan.warnings.map((w) => (
                <Banner key={w} tone="warning" className="py-2 text-xs">
                  {w}
                </Banner>
              ))}
              <div className="flex flex-col gap-2.5" aria-label="Planned times" role="group">
                {rows.length === 0 ? (
                  <p className="rounded-xl border px-3.5 py-4 text-sm text-muted-foreground">
                    Choose an account to see the plan.
                  </p>
                ) : null}
                {metas.map((m, idx) => {
                  const mine = rows.filter(
                    (r) =>
                      r.clipIndex === idx &&
                      !done.has(r.key) &&
                      selectedAccounts.some((a) => a.id === r.accountId),
                  );
                  if (!mine.length) return null;
                  return (
                    <div
                      key={sourceKey(m.source)}
                      className="overflow-hidden rounded-xl border"
                      data-testid="plan-group"
                    >
                      <div className="flex items-center gap-2.5 border-b bg-muted/40 px-3.5 py-2">
                        <SourceThumb meta={m} className="w-5 rounded-sm" />
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">{m.title}</p>
                      </div>
                      <ul className="divide-y">
                        {mine.map((r) => {
                          const x = planned.find((q) => q.key === r.key);
                          const acc = selectedAccounts.find((a) => a.id === r.accountId)!;
                          const w = warnings[r.key];
                          return (
                            <li
                              key={r.key}
                              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3.5 py-2"
                              data-testid="plan-row"
                              data-key={r.key}
                            >
                              <p className="flex min-w-0 items-center gap-2 truncate text-sm">
                                <PlatformIcon platform={acc.platform} />
                                <span className="truncate">{acc.displayName}</span>
                                {r.edited ? (
                                  <span className="text-xs text-primary-text">adjusted</span>
                                ) : null}
                              </p>
                              <DateTimeField
                                id={`plan-${r.key}`}
                                label={`Time for ${m.title} on ${acc.displayName}`}
                                value={x?.scheduledAt ?? r.at}
                                min={now ?? undefined}
                                onChange={(v) =>
                                  v !== null && setOverrides((o) => ({ ...o, [r.key]: v }))
                                }
                                hideZone
                                invalid={!!w}
                                className="w-56"
                              />
                              {w ? (
                                <p
                                  className="col-span-2 text-xs text-warning"
                                  data-testid="plan-warning"
                                >
                                  {w}
                                </p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {whenMode !== 'now' ? (
            <p className="text-xs text-subtle">
              Times are in your local time zone: {localZoneLabel(now ?? undefined)}.
            </p>
          ) : null}
        </section>
      </DialogBody>

      <DialogFooter className="justify-between">
        <p
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          aria-live="polite"
          data-testid="schedule-problem"
        >
          {problems[0] ?? (count > 0 ? `${count} ${count === 1 ? 'post' : 'posts'} ready` : '')}
        </p>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={problems.length > 0 || count === 0 || now === null}
          onClick={() => void submit()}
          data-testid="schedule-submit"
        >
          {whenMode === 'now' ? <Send /> : <CalendarClock />} {primaryLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Schedule one or many clips / exports to the connected accounts (single post, or bulk with smart spacing). */
export function SchedulePostDialog({
  source,
  open,
  onOpenChange,
  defaultAccountIds,
  defaultScheduledAt,
}: SchedulePostDialogProps) {
  const sources = React.useMemo(() => (Array.isArray(source) ? source : [source]), [source]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && sources.length > 0 ? (
        <DialogContent className="max-w-[760px]" data-testid="schedule-dialog">
          <Inner
            sources={sources}
            onOpenChange={onOpenChange}
            defaultAccountIds={defaultAccountIds}
            defaultScheduledAt={defaultScheduledAt}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
