/**
 * Constants of the YouTube Shorts publisher.
 *
 * Docs checked 2026-10-15:
 *  - https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol (resumable upload)
 *  - https://developers.google.com/youtube/v3/docs/videos/insert (scopes, params, errors)
 *  - https://developers.google.com/youtube/v3/determine_quota_cost (page "Last updated 2026-10-08 UTC")
 *  - https://developers.google.com/youtube/v3/revision_history (2025-12-04, 2026-06-01 quota entries)
 *  - https://developers.google.com/identity/protocols/oauth2/native-app (loopback + PKCE)
 *  - https://developers.google.com/identity/protocols/oauth2#expiration (7-day refresh tokens in "Testing")
 *
 * QUOTA (differs from BRIEF §9, which still says "~1600 units / ~6 uploads a day"): since 2026-06-01 `videos.insert`
 * has its OWN bucket of 100 calls per day at 1 unit per call (before: ~100 units from 2025-12-04, and ~1600 before
 * that). All other methods share a separate 10 000-unit bucket. Everything resets at midnight Pacific Time.
 */

export const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
export const SCOPES = [SCOPE_UPLOAD, SCOPE_READONLY] as const;

export const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DEFAULT_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DEFAULT_API_BASE = 'https://www.googleapis.com/youtube/v3';
export const DEFAULT_UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

/** Quota: videos.insert bucket (calls/day) and the cost of one call. Overridable for projects with an extension. */
export const UPLOAD_COST_UNITS = 1;
export const DEFAULT_DAILY_UPLOAD_LIMIT = 100;

/** Where to ask for more quota (free). */
export const QUOTA_EXTENSION_FORM =
  'the "YouTube API Services - Audit and Quota Extension" form (search for it on support.google.com/youtube)';
export const QUOTA_EXTENSION_HINT = `Google resets the quota at midnight Pacific Time. To post more per day you can request more quota for free with ${QUOTA_EXTENSION_FORM}.`;

export const SHORTS_URL = (id: string): string => `https://youtube.com/shorts/${id}`;

/** Uploads must be sent in multiples of 256 KiB (except the last chunk). */
export const CHUNK_ALIGN = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_RETRIES = 6;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
/** One chunk request (4 MiB) may take a while on a slow uplink. */
export const CHUNK_TIMEOUT_MS = 5 * 60_000;
export const MAX_SESSION_RESTARTS = 1;

export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5000;
export const TAGS_MAX_CHARS = 500;
export const TAG_MAX_CHARS = 100;
