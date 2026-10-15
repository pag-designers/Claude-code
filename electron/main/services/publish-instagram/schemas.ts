/**
 * Tolerant zod schemas for the Instagram API responses this provider reads. Every field is optional/lenient: a field
 * with the wrong type becomes `undefined` instead of failing the response, unknown fields are ignored (Meta adds and
 * renames fields often). What a caller truly needs is checked after parsing, with a user-readable error.
 */
import { z } from 'zod';

const lenString = z.string().optional().catch(undefined);

/** number | numeric string -> number; anything else -> undefined. */
const lenNumber = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite().optional(),
  )
  .catch(undefined);

/**
 * An id as a string. Instagram's OAuth endpoint returns `user_id` as a JSON NUMBER that can exceed 2^53 (precision is
 * already lost by `JSON.parse`), so an unsafe number is dropped rather than trusted.
 */
const lenIdString = z
  .preprocess(
    (v) => (typeof v === 'number' ? (Number.isSafeInteger(v) ? String(v) : undefined) : v),
    z
      .string()
      .regex(/^\d+$/)
      .optional(),
  )
  .catch(undefined);

const permissionsList = z
  .preprocess(
    (v) =>
      typeof v === 'string'
        ? v.split(/[,\s]+/).filter(Boolean)
        : Array.isArray(v)
          ? v.filter((x): x is string => typeof x === 'string')
          : [],
    z.array(z.string()),
  )
  .catch([]);

/* ------------------------------------------------------------------------------------------ OAuth */

const shortTokenRow = z.object({
  access_token: lenString,
  user_id: lenIdString,
  permissions: permissionsList,
});

/** `POST /oauth/access_token`: `{ data: [row] }` (current docs) or the older flat `row`. */
export function parseShortToken(
  json: unknown,
): { accessToken: string; permissions: string[] } | null {
  const wrapped = z.object({ data: z.array(z.unknown()).optional().catch(undefined) }).safeParse(json);
  const first = wrapped.success ? wrapped.data.data?.[0] : undefined;
  const row = shortTokenRow.safeParse(first ?? json);
  if (!row.success || !row.data.access_token) return null;
  return { accessToken: row.data.access_token, permissions: row.data.permissions };
}

const longTokenSchema = z.object({
  access_token: lenString,
  token_type: lenString,
  expires_in: lenNumber,
});

/** `GET /access_token?grant_type=ig_exchange_token` and `GET /refresh_access_token`. */
export function parseLongToken(json: unknown): { accessToken: string; expiresInSec: number | null } | null {
  const r = longTokenSchema.safeParse(json);
  if (!r.success || !r.data.access_token) return null;
  const e = r.data.expires_in;
  return { accessToken: r.data.access_token, expiresInSec: e !== undefined && e > 0 ? e : null };
}

/* ----------------------------------------------------------------------------------------- account */

const meSchema = z.object({
  id: lenIdString,
  user_id: lenIdString,
  username: lenString,
  name: lenString,
  account_type: lenString,
  profile_picture_url: lenString,
});

export interface IgProfile {
  /** The Instagram professional account id (what `/{id}/media` takes). */
  igUserId: string;
  username: string | null;
  name: string | null;
  accountType: string | null;
  pictureUrl: string | null;
}

export function parseMe(json: unknown): IgProfile | null {
  const r = meSchema.safeParse(json);
  if (!r.success) return null;
  const igUserId = r.data.user_id ?? r.data.id;
  if (!igUserId) return null;
  return {
    igUserId,
    username: r.data.username?.trim() || null,
    name: r.data.name?.trim() || null,
    accountType: r.data.account_type?.trim() || null,
    pictureUrl: r.data.profile_picture_url?.trim() || null,
  };
}

/* ------------------------------------------------------------------------------------- publishing */

const idSchema = z.object({ id: lenIdString });
export const parseId = (json: unknown): string | null => {
  const r = idSchema.safeParse(json);
  return r.success && r.data.id ? r.data.id : null;
};

const containerStatusSchema = z.object({ status_code: lenString, status: lenString });
export function parseContainerStatus(json: unknown): { statusCode: string; status: string | null } {
  const r = containerStatusSchema.safeParse(json);
  return {
    statusCode: (r.success ? r.data.status_code : undefined)?.toUpperCase() ?? '',
    status: (r.success ? r.data.status : undefined) ?? null,
  };
}

const permalinkSchema = z.object({ permalink: lenString });
export const parsePermalink = (json: unknown): string | null => {
  const r = permalinkSchema.safeParse(json);
  return r.success && r.data.permalink ? r.data.permalink : null;
};

const limitRow = z.object({
  quota_usage: lenNumber,
  config: z
    .object({ quota_total: lenNumber, quota_duration: lenNumber })
    .optional()
    .catch(undefined),
});

/** `GET /{id}/content_publishing_limit` → `{ data: [{ quota_usage, config: { quota_total, quota_duration } }] }`. */
export function parsePublishingLimit(
  json: unknown,
): { used: number; total: number | null; durationSec: number | null } | null {
  const outer = z.object({ data: z.unknown().optional() }).safeParse(json);
  const d = outer.success ? outer.data.data : undefined;
  const first = Array.isArray(d) ? d[0] : d;
  const r = limitRow.safeParse(first);
  if (!r.success || r.data.quota_usage === undefined) return null;
  return {
    used: Math.max(0, Math.floor(r.data.quota_usage)),
    total: r.data.config?.quota_total ?? null,
    durationSec: r.data.config?.quota_duration ?? null,
  };
}

/* ---------------------------------------------------------------------------------------- insights */

const insightRow = z.object({
  name: lenString,
  values: z
    .array(z.object({ value: z.unknown().optional() }))
    .optional()
    .catch(undefined),
  total_value: z.object({ value: z.unknown().optional() }).optional().catch(undefined),
});

/** `GET /{media-id}/insights` → metric name → number (metrics Instagram did not return are absent). */
export function parseInsights(json: unknown): Record<string, number> {
  const outer = z.object({ data: z.array(z.unknown()).optional().catch(undefined) }).safeParse(json);
  const out: Record<string, number> = {};
  for (const el of outer.success ? (outer.data.data ?? []) : []) {
    const r = insightRow.safeParse(el);
    if (!r.success || !r.data.name) continue;
    const v = r.data.total_value?.value ?? r.data.values?.[0]?.value;
    if (typeof v === 'number' && Number.isFinite(v)) out[r.data.name] = v;
  }
  return out;
}

const mediaCountsSchema = z.object({ like_count: lenNumber, comments_count: lenNumber });
export function parseMediaCounts(json: unknown): { likes: number | null; comments: number | null } {
  const r = mediaCountsSchema.safeParse(json);
  return {
    likes: (r.success ? r.data.like_count : undefined) ?? null,
    comments: (r.success ? r.data.comments_count : undefined) ?? null,
  };
}
