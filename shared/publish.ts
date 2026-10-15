import { z } from 'zod';
import { platformSchema, type Platform } from './cp2';

/* ------------------------------------------------------------------------------------------------
 * CP5 domain types: connected accounts, scheduled/published posts, per-platform fields, scheduler status,
 * quota. Platform ids are the CP2 ones ('shorts' = YouTube Shorts, 'reels' = Instagram Reels, 'tiktok'), so a
 * clip's per-platform metadata (`PlatformMeta`) maps 1:1 onto a post's fields.
 * Static platform limits live in shared/platform-specs.ts; slot planning in shared/scheduling.ts.
 * ---------------------------------------------------------------------------------------------- */

export { platformSchema, type Platform };

/** Which developer-app family a platform belongs to (Settings → Integrations card). */
export const PLATFORM_PROVIDER: Record<Platform, 'youtube' | 'instagram' | 'tiktok'> = {
  shorts: 'youtube',
  reels: 'instagram',
  tiktok: 'tiktok',
};

/* ------------------------------------------------------------------------------------ fields ----- */

/** YouTube Data API v3 `videos.insert` (+ the Shorts conventions). */
export const shortsFieldsSchema = z.object({
  platform: z.literal('shorts'),
  /** ≤ 100 characters, no angle brackets (API rule). */
  title: z.string().min(1).max(100),
  /** ≤ 5000 bytes. The app appends #Shorts when `addShortsTag` and it is missing. */
  description: z.string().max(5000).default(''),
  /** Sum of tag lengths ≤ 500 characters (API rule, checked by `validateFields`). */
  tags: z.array(z.string().min(1).max(100)).max(40).default([]),
  visibility: z.enum(['public', 'unlisted', 'private']).default('public'),
  /** "Made for kids" must be declared on every upload (COPPA): required in the schema, and the form asks explicitly. */
  madeForKids: z.boolean(),
  /** YouTube video category id ('22' = People & Blogs, '24' = Entertainment, …). */
  categoryId: z.string().default('22'),
  notifySubscribers: z.boolean().default(true),
  addShortsTag: z.boolean().default(true),
});
export type ShortsFields = z.infer<typeof shortsFieldsSchema>;

/** Instagram Graph API Reels container + publish. */
export const reelsFieldsSchema = z.object({
  platform: z.literal('reels'),
  /** ≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @mentions. */
  caption: z.string().max(2200).default(''),
  shareToFeed: z.boolean().default(true),
  /** Cover frame as an offset into the video; null = Instagram's default. */
  coverOffsetMs: z.number().int().min(0).nullable().default(null),
  /** Posted as the first comment right after publishing (hashtags often go here). */
  firstComment: z.string().max(2200).nullable().default(null),
  /** Up to 3 collaborator usernames (without @). */
  collaborators: z.array(z.string().min(1).max(60)).max(3).default([]),
  locationId: z.string().nullable().default(null),
});
export type ReelsFields = z.infer<typeof reelsFieldsSchema>;

export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

/** TikTok Content Posting API: Direct Post (`video/init`) or upload to the creator's drafts inbox. */
export const tiktokFieldsSchema = z.object({
  platform: z.literal('tiktok'),
  /** Caption incl. hashtags, ≤ 2200 UTF-16 code units. */
  title: z.string().max(2200).default(''),
  /** 'direct' = Direct Post; 'draft' = upload to the TikTok inbox/drafts so the user publishes in the TikTok app. */
  mode: z.enum(['direct', 'draft']).default('direct'),
  /** Must be one of the options `creator_info/query` returns; unaudited apps only get SELF_ONLY. */
  privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS).default('SELF_ONLY'),
  allowComment: z.boolean().default(true),
  allowDuet: z.boolean().default(true),
  allowStitch: z.boolean().default(true),
  /** Commercial-content disclosure (required by TikTok when promoting a brand). */
  commercial: z
    .object({
      enabled: z.boolean().default(false),
      yourBrand: z.boolean().default(false),
      brandedContent: z.boolean().default(false),
    })
    .default({ enabled: false, yourBrand: false, brandedContent: false }),
  coverTimestampMs: z.number().int().min(0).nullable().default(null),
  /** AI-generated content label. */
  aigc: z.boolean().default(false),
});
export type TiktokFields = z.infer<typeof tiktokFieldsSchema>;

export const postFieldsSchema = z.discriminatedUnion('platform', [
  shortsFieldsSchema,
  reelsFieldsSchema,
  tiktokFieldsSchema,
]);
export type PostFields = z.infer<typeof postFieldsSchema>;

/** A short human title of a post (for lists and notifications). */
export function postTitleOf(f: PostFields): string {
  const raw = f.platform === 'reels' ? f.caption : f.title;
  const t = raw.replace(/\s+/g, ' ').trim();
  return (t.length > 80 ? `${t.slice(0, 79)}…` : t) || 'Untitled post';
}

/* ---------------------------------------------------------------------------------- accounts ----- */

export const accountStatusSchema = z.enum(['connected', 'needs-reauth', 'error']);

export const socialAccountSchema = z.object({
  id: z.string(),
  platform: platformSchema,
  /** Platform-side id (YouTube channel id, Instagram business account id, TikTok open_id). */
  externalId: z.string(),
  displayName: z.string(),
  /** @handle without the @ (null when the platform has none). */
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: accountStatusSchema,
  /** Why it needs attention (revoked token, expired refresh token, …). */
  statusMessage: z.string().nullable(),
  scopes: z.array(z.string()),
  /** Platform extras the UI may show (e.g. { audited: false } for TikTok, { pageName } for Instagram). */
  info: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  connectedAt: z.number(),
});
export type SocialAccount = z.infer<typeof socialAccountSchema>;

/** Per platform: are the developer-app credentials saved, and what must be registered at the platform. */
export const platformSetupSchema = z.object({
  platform: platformSchema,
  configured: z.boolean(),
  /** The exact redirect URI to register in the developer app (loopback on the app's fixed port). */
  redirectUri: z.string(),
});
export type PlatformSetup = z.infer<typeof platformSetupSchema>;

/* ------------------------------------------------------------------------------------- posts ----- */

export const POST_STATUSES = [
  'draft',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'failed',
  'missed',
  'canceled',
] as const;
export const postStatusSchema = z.enum(POST_STATUSES);
export type PostStatus = z.infer<typeof postStatusSchema>;

/** Statuses a person may still edit / reschedule / retry. */
export const EDITABLE_POST_STATUSES: PostStatus[] = ['draft', 'scheduled', 'failed', 'missed'];

export const publishErrorCodeSchema = z.enum([
  'auth',
  'rate-limit',
  'quota',
  'validation',
  'media',
  'network',
  'platform',
  'unknown',
]);
export type PublishErrorCode = z.infer<typeof publishErrorCodeSchema>;

export const postErrorSchema = z.object({
  code: publishErrorCodeSchema,
  /** The platform's own words when it gave any, else ours. */
  message: z.string(),
  retryable: z.boolean(),
  at: z.number(),
  /** What the user can do about it. */
  hint: z.string().nullable().default(null),
});
export type PostError = z.infer<typeof postErrorSchema>;

export const postStatsSchema = z.object({
  views: z.number().nullable(),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
  shares: z.number().nullable(),
  fetchedAt: z.number(),
});
export type PostStats = z.infer<typeof postStatsSchema>;

export const postMediaInfoSchema = z.object({
  durationSec: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number().nullable(),
  sizeBytes: z.number().nonnegative(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
});
export type PostMediaInfo = z.infer<typeof postMediaInfoSchema>;

export const postSourceSchema = z.union([
  /** A rendered Library clip. */
  z.object({ clipId: z.string() }),
  /** A finished editor export (Library → Exported). */
  z.object({ exportId: z.string() }),
]);
export type PostSource = z.infer<typeof postSourceSchema>;

export const postViewSchema = z.object({
  id: z.string(),
  platform: platformSchema,
  accountId: z.string(),
  accountName: z.string(),
  clipId: z.string().nullable(),
  exportId: z.string().nullable(),
  title: z.string(),
  status: postStatusSchema,
  /** Epoch ms; null = draft / post-now not yet started. */
  scheduledAt: z.number().nullable(),
  publishedAt: z.number().nullable(),
  /** Next automatic retry (backoff / rate limit), null when none is pending. */
  nextAttemptAt: z.number().nullable(),
  attempts: z.number().int(),
  fields: postFieldsSchema,
  media: postMediaInfoSchema.nullable(),
  /** The original upload was out of spec and a re-encoded copy will be / was used. */
  autoFixed: z.boolean(),
  autoFix: z.boolean(),
  error: postErrorSchema.nullable(),
  /** After publishing: the platform's id and public link. */
  result: z
    .object({
      platformPostId: z.string(),
      url: z.string().nullable(),
      /** 'draft-uploaded' = in the TikTok inbox, still to be published by the user in the TikTok app. */
      outcome: z.enum(['published', 'draft-uploaded']),
      /** What the platform actually applied (e.g. TikTok forcing SELF_ONLY for an unaudited app). */
      note: z.string().nullable(),
    })
    .nullable(),
  stats: postStatsSchema.nullable(),
  groupId: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  createdAt: z.number(),
});
export type PostView = z.infer<typeof postViewSchema>;

/* ------------------------------------------------------------------------- validation report ----- */

export const mediaIssueSchema = z.object({
  /** 'error' blocks publishing until fixed; 'warning' is advice. */
  severity: z.enum(['error', 'warning']),
  code: z.enum([
    'duration-short',
    'duration-long',
    'size-large',
    'aspect',
    'resolution',
    'codec',
    'audio-codec',
    'fps',
    'container',
    'bitrate',
    'no-audio',
  ]),
  message: z.string(),
  /** Re-encoding can fix it (the user may switch "Auto-fix" on). */
  fixable: z.boolean(),
});
export type MediaIssue = z.infer<typeof mediaIssueSchema>;

export const mediaReportSchema = z.object({
  platform: platformSchema,
  ok: z.boolean(),
  issues: z.array(mediaIssueSchema),
  media: postMediaInfoSchema,
});
export type MediaReport = z.infer<typeof mediaReportSchema>;

export const fieldIssueSchema = z.object({
  field: z.string(),
  message: z.string(),
});
export type FieldIssue = z.infer<typeof fieldIssueSchema>;

/* ---------------------------------------------------------------------------- scheduler status ----- */

export const quotaInfoSchema = z.object({
  accountId: z.string(),
  platform: platformSchema,
  label: z.string(),
  used: z.number(),
  limit: z.number(),
  unit: z.enum(['units', 'posts']),
  /** When the counter resets (epoch ms). */
  resetsAt: z.number(),
  /** How many more posts fit before the limit (null = unknown). */
  postsLeft: z.number().int().nullable(),
  /** Short explanation shown under the meter (e.g. how to request more YouTube quota). */
  note: z.string().nullable(),
});
export type QuotaInfo = z.infer<typeof quotaInfoSchema>;

export const schedulerStatusSchema = z.object({
  /** The scheduler loop is running in this process. */
  active: z.boolean(),
  paused: z.boolean(),
  /** Closing the window keeps the app (and the scheduler) alive in the tray / menu bar. */
  trayMode: z.boolean(),
  trayAvailable: z.boolean(),
  upcoming: z.number().int(),
  nextAt: z.number().nullable(),
  publishing: z.number().int(),
  /** Posts that were due while the app was closed and are being / were handled by catch-up. */
  catchUp: z.object({ pending: z.number().int(), lastRunAt: z.number().nullable() }),
  quota: z.array(quotaInfoSchema),
  now: z.number(),
});
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;

/** Used by `posts:create`: one item = one post (one account, one clip/export, its fields). */
export const postDraftSchema = z.object({
  source: postSourceSchema,
  accountId: z.string(),
  fields: postFieldsSchema,
  /** Epoch ms; null = publish now. */
  scheduledAt: z.number().nullable(),
  /** Re-encode the media when it is out of spec (otherwise the post is refused with the report). */
  autoFix: z.boolean().default(true),
  groupId: z.string().nullable().default(null),
});
export type PostDraft = z.infer<typeof postDraftSchema>;

/* ------------------------------------------------------------------------------ pure helpers ----- */

/** Statuses that count as "upcoming work" for the scheduler indicator. */
export const isPendingStatus = (s: PostStatus): boolean =>
  s === 'scheduled' || s === 'queued' || s === 'publishing';

/** Default per-platform fields from a clip's CP2 metadata (title/description/hashtags). Pure; used by main and the UI. */
export function defaultFieldsFrom(
  platform: Platform,
  meta: { title: string; description: string; hashtags: string[] } | null,
  fallbackTitle: string,
  opts: { hashtagSet?: string[] } = {},
): PostFields {
  const tags = [...(meta?.hashtags ?? []), ...(opts.hashtagSet ?? [])]
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean)
    .filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i);
  const hash = tags.map((t) => `#${t}`).join(' ');
  const title = (meta?.title || fallbackTitle).trim();
  const desc = (meta?.description ?? '').trim();
  if (platform === 'shorts')
    return shortsFieldsSchema.parse({
      platform,
      title: title.slice(0, 100) || 'Untitled',
      description: [desc, hash].filter(Boolean).join('\n\n'),
      tags: tags.slice(0, 15),
      madeForKids: false, // the schedule form still asks the user to confirm it
    });
  if (platform === 'reels')
    return reelsFieldsSchema.parse({
      platform,
      caption: [title, desc, hash].filter(Boolean).join('\n\n').slice(0, 2200),
    });
  return tiktokFieldsSchema.parse({
    platform,
    title: [title, hash].filter(Boolean).join(' ').slice(0, 2200),
  });
}
