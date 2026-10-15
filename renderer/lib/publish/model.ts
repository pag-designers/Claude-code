/**
 * Pure helpers for the Scheduler UI: platform identity, status vocabulary, filtering/grouping of posts, quota maths and
 * per-platform field limits with live counters. No React, no I/O, no clock reads.
 */
import {
  EDITABLE_POST_STATUSES,
  PLATFORM_PROVIDER,
  isPendingStatus,
  type MediaReport,
  type PostFields,
  type PostMediaInfo,
  type PostStatus,
  type PostView,
  type PublishErrorCode,
  type QuotaInfo,
  type SocialAccount,
} from '@shared/publish';
import type { Platform } from '@shared/cp2';
import { dayKey } from './dates';

/* ---------------------------------------------------------------------------------- platforms ----- */

export const PLATFORM_ORDER: readonly Platform[] = ['shorts', 'reels', 'tiktok'];

export interface PlatformInfo {
  name: string;
  /** Short label for chips and filters. */
  short: string;
  /** What this platform calls a post, for copy ("Short", "Reel", "TikTok"). */
  noun: string;
  provider: 'youtube' | 'instagram' | 'tiktok';
}

export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  shorts: { name: 'YouTube Shorts', short: 'YouTube', noun: 'Short', provider: 'youtube' },
  reels: { name: 'Instagram Reels', short: 'Instagram', noun: 'Reel', provider: 'instagram' },
  tiktok: { name: 'TikTok', short: 'TikTok', noun: 'TikTok', provider: 'tiktok' },
};

/**
 * Static class names per platform (Tailwind needs literals). Colours come from existing design tokens only:
 * YouTube = danger, Instagram = viral accent, TikTok = info.
 */
export const PLATFORM_STYLE: Record<
  Platform,
  { text: string; bar: string; soft: string; border: string; edge: string }
> = {
  shorts: {
    text: 'text-danger',
    bar: 'bg-danger',
    soft: 'bg-danger-soft',
    border: 'border-danger/45',
    edge: 'border-l-danger',
  },
  reels: {
    text: 'text-viral-text',
    bar: 'bg-viral-text',
    soft: 'bg-[color-mix(in_srgb,var(--viral-text)_13%,transparent)]',
    border: 'border-viral-text/45',
    edge: 'border-l-viral-text',
  },
  tiktok: {
    text: 'text-info',
    bar: 'bg-info',
    soft: 'bg-info-soft',
    border: 'border-info/45',
    edge: 'border-l-info',
  },
};

export const platformOf = (id: string): Platform | null =>
  (PLATFORM_ORDER as readonly string[]).includes(id) ? (id as Platform) : null;

/* ------------------------------------------------------------------------------------ statuses ----- */

export type StatusTone = 'neutral' | 'primary' | 'info' | 'success' | 'danger' | 'warning';

export const STATUS_META: Record<PostStatus, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'primary' },
  queued: { label: 'Queued', tone: 'info' },
  publishing: { label: 'Publishing', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  missed: { label: 'Missed — reschedule?', tone: 'warning' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const isEditable = (s: PostStatus): boolean => EDITABLE_POST_STATUSES.includes(s);
export const isNeedsAttention = (s: PostStatus): boolean => s === 'failed' || s === 'missed';
/** A post that can still be canceled by the user (it has not started publishing). */
export const isCancelable = (s: PostStatus): boolean => s === 'scheduled' || s === 'queued';
export const canPostNow = (s: PostStatus): boolean => isEditable(s);
export const canRetry = (s: PostStatus): boolean => s === 'failed' || s === 'missed';

/** The moment a post sits on in the calendar (drafts without a date are not on it). */
export const calendarTime = (p: PostView): number | null => p.scheduledAt ?? p.publishedAt ?? null;

/* -------------------------------------------------------------------------- filtering / grouping ----- */

export type StatusFilter = 'all' | 'upcoming' | 'published' | 'attention' | 'draft' | 'canceled';

export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'published', label: 'Published' },
  { value: 'attention', label: 'Failed or missed' },
  { value: 'draft', label: 'Drafts' },
  { value: 'canceled', label: 'Canceled' },
];

export interface PostFilters {
  status: StatusFilter;
  platform: Platform | 'all';
  accountId: string | 'all';
  query: string;
}

export const NO_FILTERS: PostFilters = {
  status: 'all',
  platform: 'all',
  accountId: 'all',
  query: '',
};

export function matchesStatus(s: PostStatus, f: StatusFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'upcoming':
      return isPendingStatus(s);
    case 'published':
      return s === 'published';
    case 'attention':
      return isNeedsAttention(s);
    case 'draft':
      return s === 'draft';
    case 'canceled':
      return s === 'canceled';
  }
}

export function filterPosts(posts: readonly PostView[], f: PostFilters): PostView[] {
  const q = f.query.trim().toLowerCase();
  return posts.filter((p) => {
    if (!matchesStatus(p.status, f.status)) return false;
    if (f.platform !== 'all' && p.platform !== f.platform) return false;
    if (f.accountId !== 'all' && p.accountId !== f.accountId) return false;
    if (q) {
      const hay = `${p.title} ${p.accountName} ${PLATFORM_INFO[p.platform].name} ${STATUS_META[p.status].label}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

export const hasActiveFilters = (f: PostFilters): boolean =>
  f.status !== 'all' || f.platform !== 'all' || f.accountId !== 'all' || f.query.trim() !== '';

/** Posts grouped by local day key, each day sorted by time (calendar views). */
export function postsByDay(posts: readonly PostView[]): Map<string, PostView[]> {
  const map = new Map<string, PostView[]>();
  for (const p of posts) {
    const t = calendarTime(p);
    if (t === null) continue;
    const key = dayKey(t);
    const list = map.get(key);
    if (list) list.push(p);
    else map.set(key, [p]);
  }
  for (const list of map.values())
    list.sort(
      (a, b) => (calendarTime(a) ?? 0) - (calendarTime(b) ?? 0) || a.id.localeCompare(b.id),
    );
  return map;
}

export type QueueSectionId = 'attention' | 'upcoming' | 'draft' | 'history';

export interface QueueSection {
  id: QueueSectionId;
  title: string;
  posts: PostView[];
}

/** Queue view sections: what needs you first, then what is next, then drafts, then history (newest first). */
export function queueSections(posts: readonly PostView[]): QueueSection[] {
  const byTime = (a: PostView, b: PostView) =>
    (calendarTime(a) ?? 0) - (calendarTime(b) ?? 0) || a.id.localeCompare(b.id);
  const attention = posts.filter((p) => isNeedsAttention(p.status)).sort(byTime);
  const upcoming = posts.filter((p) => isPendingStatus(p.status)).sort(byTime);
  const draft = posts
    .filter((p) => p.status === 'draft')
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const history = posts
    .filter((p) => p.status === 'published' || p.status === 'canceled')
    .sort((a, b) => -byTime(a, b));
  return (
    [
      { id: 'attention', title: 'Needs attention', posts: attention },
      { id: 'upcoming', title: 'Upcoming', posts: upcoming },
      { id: 'draft', title: 'Drafts', posts: draft },
      { id: 'history', title: 'History', posts: history },
    ] satisfies QueueSection[]
  ).filter((s) => s.posts.length > 0);
}

/** Replaces or inserts a post (event from main) keeping the list's identity-stable order. */
export function upsertPost(list: readonly PostView[], post: PostView): PostView[] {
  const i = list.findIndex((p) => p.id === post.id);
  if (i < 0) return [...list, post];
  const next = list.slice();
  next[i] = post;
  return next;
}

/* ---------------------------------------------------------------------------------- accounts ----- */

/** TikTok apps are "unaudited" until `info.audited` is explicitly true. */
export const isTiktokUnaudited = (a: Pick<SocialAccount, 'platform' | 'info'>): boolean =>
  a.platform === 'tiktok' && a.info.audited !== true;

export const accountLabel = (a: Pick<SocialAccount, 'displayName' | 'handle'>): string =>
  a.handle ? `${a.displayName} (@${a.handle})` : a.displayName;

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function accountsByPlatform(accounts: readonly SocialAccount[]) {
  return PLATFORM_ORDER.map((platform) => ({
    platform,
    accounts: accounts.filter((a) => a.platform === platform),
  }));
}

/* ------------------------------------------------------------------------------------- quota ----- */

export type QuotaTone = 'primary' | 'warning' | 'danger';

export function quotaFraction(q: Pick<QuotaInfo, 'used' | 'limit'>): number {
  return q.limit > 0 ? Math.min(1, Math.max(0, q.used / q.limit)) : 0;
}

export function quotaTone(q: Pick<QuotaInfo, 'used' | 'limit' | 'postsLeft'>): QuotaTone {
  if (q.postsLeft === 0) return 'danger';
  const f = quotaFraction(q);
  return f >= 0.9 ? 'danger' : f >= 0.7 ? 'warning' : 'primary';
}

export function describeQuota(q: QuotaInfo): string {
  const n = (v: number) => new Intl.NumberFormat('en-US').format(Math.round(v));
  const unit = q.unit === 'units' ? 'units' : 'posts';
  return `${n(q.used)} of ${n(q.limit)} ${unit}`;
}

export function postsLeftLabel(q: Pick<QuotaInfo, 'postsLeft'>): string | null {
  if (q.postsLeft === null) return null;
  if (q.postsLeft === 0) return 'Daily limit reached';
  return `${q.postsLeft} more ${q.postsLeft === 1 ? 'post' : 'posts'} today`;
}

/* ------------------------------------------------------------------------------ field limits ----- */

export const LIMITS = {
  shorts: { title: 100, descriptionBytes: 5000, tagChars: 500, tags: 40 },
  reels: { caption: 2200, hashtags: 30, mentions: 20, collaborators: 3, firstComment: 2200 },
  tiktok: { title: 2200 },
} as const;

/** UTF-8 byte length (YouTube counts descriptions in bytes). */
export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** UTF-16 code units, which is how TikTok counts the caption. */
export const unitLength = (s: string): number => s.length;

export const countHashtags = (s: string): number =>
  (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
export const countMentions = (s: string): number => (s.match(/(^|\s)@[\w.]+/g) ?? []).length;

export const tagsLength = (tags: readonly string[]): number =>
  tags.reduce((n, t) => n + t.length, 0) + Math.max(0, tags.length - 1);

export interface Counter {
  label: string;
  value: number;
  max: number;
  unit: string;
}

/** Live counters for the active platform's fields (shown next to the inputs). */
export function fieldCounters(f: PostFields): Record<string, Counter> {
  switch (f.platform) {
    case 'shorts':
      return {
        title: { label: 'Title', value: f.title.length, max: LIMITS.shorts.title, unit: 'chars' },
        description: {
          label: 'Description',
          value: byteLength(f.description),
          max: LIMITS.shorts.descriptionBytes,
          unit: 'bytes',
        },
        tags: {
          label: 'Tags',
          value: tagsLength(f.tags),
          max: LIMITS.shorts.tagChars,
          unit: 'chars',
        },
      };
    case 'reels':
      return {
        caption: {
          label: 'Caption',
          value: f.caption.length,
          max: LIMITS.reels.caption,
          unit: 'chars',
        },
        hashtags: {
          label: 'Hashtags',
          value: countHashtags(f.caption),
          max: LIMITS.reels.hashtags,
          unit: 'tags',
        },
        mentions: {
          label: 'Mentions',
          value: countMentions(f.caption),
          max: LIMITS.reels.mentions,
          unit: 'mentions',
        },
        firstComment: {
          label: 'First comment',
          value: (f.firstComment ?? '').length,
          max: LIMITS.reels.firstComment,
          unit: 'chars',
        },
      };
    case 'tiktok':
      return {
        title: {
          label: 'Caption',
          value: unitLength(f.title),
          max: LIMITS.tiktok.title,
          unit: 'chars',
        },
      };
  }
}

export type CounterState = 'ok' | 'near' | 'over';
export const counterState = (c: Pick<Counter, 'value' | 'max'>): CounterState =>
  c.value > c.max ? 'over' : c.value >= c.max * 0.9 ? 'near' : 'ok';

/**
 * Cheap local checks that mirror the hard limits, so the form reacts instantly; `publish:validate` stays the
 * authority (it also knows platform rules we cannot see here). Returns `{ field, message }` like the contract.
 */
export function localFieldIssues(f: PostFields): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  const counters = fieldCounters(f);
  for (const [field, c] of Object.entries(counters))
    if (counterState(c) === 'over')
      out.push({
        field,
        message: `${c.label} is ${c.value - c.max} ${c.unit} over the ${c.max} limit.`,
      });
  if (f.platform === 'shorts') {
    if (f.title.trim() === '') out.push({ field: 'title', message: 'A title is required.' });
    if (/[<>]/.test(f.title))
      out.push({ field: 'title', message: 'Titles cannot contain < or >.' });
  }
  if (f.platform === 'reels' && f.collaborators.length > LIMITS.reels.collaborators)
    out.push({ field: 'collaborators', message: 'Instagram allows up to 3 collaborators.' });
  return out;
}

export function issuesFor(
  field: string,
  ...lists: readonly (readonly { field: string; message: string }[])[]
): string | undefined {
  const seen = new Set<string>();
  const msgs: string[] = [];
  for (const l of lists)
    for (const i of l)
      if (i.field === field && !seen.has(i.message)) {
        seen.add(i.message);
        msgs.push(i.message);
      }
  return msgs.length ? msgs.join(' ') : undefined;
}

/** Normalises a typed token ("#Fun", " @bob ") for tag/collaborator inputs. */
export const cleanToken = (raw: string, strip: RegExp): string => raw.replace(strip, '').trim();

export const providerOf = (platform: Platform) => PLATFORM_PROVIDER[platform];

/* ------------------------------------------------------------------------------ media report ----- */

/** Does the media report stop a post (errors the auto-fix cannot or may not repair)? */
export function reportBlocks(report: MediaReport | null | undefined, autoFix: boolean): boolean {
  if (!report) return false;
  return report.issues.some((i) => i.severity === 'error' && !(i.fixable && autoFix));
}

/** Errors that only re-encoding can fix (drives the "Auto-fix will re-encode" note). */
export function reportNeedsFix(report: MediaReport | null | undefined): boolean {
  return !!report?.issues.some((i) => i.severity === 'error' && i.fixable);
}

/** "0:42 · 1080×1920 · 30 fps · 18 MB · H.264 / AAC" */
export function describeMedia(m: PostMediaInfo): string {
  const s = Math.max(0, Math.round(m.durationSec));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const mb = m.sizeBytes / 1e6;
  const size =
    mb >= 100
      ? `${mb.toFixed(0)} MB`
      : mb >= 1
        ? `${mb.toFixed(1)} MB`
        : `${(m.sizeBytes / 1e3).toFixed(0)} KB`;
  const codec = (c: string | null) => c?.toUpperCase() ?? null;
  return [
    clock,
    `${m.width}×${m.height}`,
    m.fps ? `${Math.round(m.fps)} fps` : null,
    size,
    [codec(m.videoCodec), codec(m.audioCodec)].filter(Boolean).join(' / ') || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ---------------------------------------------------------------------------------- errors ----- */

export const ERROR_LABEL: Record<PublishErrorCode, string> = {
  auth: 'Sign-in problem',
  'rate-limit': 'Rate limited',
  quota: 'Daily quota reached',
  validation: 'Rejected by the platform',
  media: 'Video problem',
  network: 'Network problem',
  platform: 'Platform error',
  unknown: 'Unknown error',
};

/** Does fixing this error need the account to be reconnected? */
export const needsReconnect = (code: PublishErrorCode): boolean => code === 'auth';

/* --------------------------------------------------------------------- bulk (shared settings) ----- */

/**
 * Settings that make sense to apply to MANY clips at once (everything except per-clip text, cover frames,
 * collaborators and locations). Bulk scheduling edits one "shared" object and merges it into each clip's own
 * prefilled fields.
 */
export function mergeShared(own: PostFields, shared: PostFields): PostFields {
  if (own.platform === 'shorts' && shared.platform === 'shorts')
    return {
      ...own,
      visibility: shared.visibility,
      madeForKids: shared.madeForKids,
      categoryId: shared.categoryId,
      notifySubscribers: shared.notifySubscribers,
      addShortsTag: shared.addShortsTag,
    };
  if (own.platform === 'reels' && shared.platform === 'reels')
    return { ...own, shareToFeed: shared.shareToFeed };
  if (own.platform === 'tiktok' && shared.platform === 'tiktok')
    return {
      ...own,
      mode: shared.mode,
      privacyLevel: shared.privacyLevel,
      allowComment: shared.allowComment,
      allowDuet: shared.allowDuet,
      allowStitch: shared.allowStitch,
      commercial: shared.commercial,
      aigc: shared.aigc,
    };
  return own;
}

/** Forces what an unaudited TikTok app is allowed to do (private only). */
export function enforceTiktokAudit(f: PostFields, unaudited: boolean): PostFields {
  if (f.platform !== 'tiktok') return f;
  return unaudited ? { ...f, privacyLevel: 'SELF_ONLY' } : f;
}
