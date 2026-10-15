/**
 * Mapping of TikTok's error vocabulary onto PublishError, and the redaction every message goes through.
 * Docs (read 2026-10-15):
 *  - Direct Post reference     https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *  - Upload (inbox) reference  https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *  - Post status reference     https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *  - Creator info reference    https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 */
import { PublishError } from '../publish/errors';

/** Seconds to wait before retrying after TikTok's daily-cap style refusals (the API does not say when it resets). */
export const DAILY_CAP_RETRY_SEC = 6 * 3600;

export const AUDIT_HINT =
  'TikTok apps that have not passed TikTok’s free audit can only post privately (visible to you). ' +
  'Submit the app for audit in TikTok for Developers, or switch this post to "Upload to TikTok drafts" and publish it from the TikTok app.';

export const REAUTH_HINT = 'Reconnect your TikTok account in Settings → Integrations.';

/** Removes every known secret and every URL query string from `text` (upload URLs carry credentials). */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g, '$1?…');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

export interface ApiFailure {
  httpStatus: number;
  /** TikTok's `error.code` (or OAuth `error`), '' when the body had none. */
  code: string;
  message: string;
  retryAfterSec: number | null;
  /** What the failing call was doing, for the fallback message ("starting the upload"). */
  doing: string;
}

const clean = (m: string, fallback: string): string => {
  const t = m.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : fallback;
};

/** `error` object of a v2 API call (or OAuth token error) -> PublishError. Never returns for code 'ok'. */
export function mapApiFailure(f: ApiFailure): PublishError {
  const msg = clean(f.message, '');
  const withMsg = (ours: string): string =>
    msg && !ours.includes(msg) ? `${ours} (TikTok: ${msg})` : ours;
  switch (f.code) {
    case 'access_token_invalid':
      return new PublishError('auth', 'TikTok says the saved login is no longer valid.', {
        retryable: false,
        hint: REAUTH_HINT,
      });
    case 'scope_not_authorized':
      return new PublishError(
        'auth',
        'TikTok did not grant this app permission to post (a required scope is missing).',
        {
          retryable: false,
          hint: 'Reconnect your TikTok account and accept every permission on the consent screen. Make sure the app has Login Kit and Content Posting API with video.publish and video.upload.',
        },
      );
    case 'rate_limit_exceeded':
      return new PublishError(
        'rate-limit',
        'TikTok is rate limiting requests. Clipfern will retry shortly.',
        {
          retryAfterSec: f.retryAfterSec ?? 60,
        },
      );
    case 'spam_risk_too_many_posts':
      return new PublishError(
        'quota',
        'TikTok’s daily limit of posts through apps has been reached for this account.',
        {
          retryAfterSec: f.retryAfterSec ?? DAILY_CAP_RETRY_SEC,
          hint: 'Post this one from the TikTok mobile app instead, or wait until tomorrow.',
        },
      );
    case 'spam_risk_too_many_pending_share':
      return new PublishError(
        'quota',
        'There are already 5 drafts waiting in your TikTok inbox (the limit per 24 hours).',
        {
          retryAfterSec: f.retryAfterSec ?? DAILY_CAP_RETRY_SEC,
          hint: 'Open the TikTok app and publish or discard the pending drafts first.',
        },
      );
    case 'reached_active_user_cap':
      return new PublishError(
        'quota',
        'This app has reached TikTok’s daily limit of creators it may post for.',
        {
          retryAfterSec: f.retryAfterSec ?? DAILY_CAP_RETRY_SEC,
          hint: 'Unaudited apps can serve up to 5 TikTok accounts per day. Try again tomorrow or complete the TikTok audit.',
        },
      );
    case 'spam_risk_user_banned_from_posting':
      return new PublishError('platform', 'TikTok does not allow this account to post right now.', {
        retryable: false,
        hint: 'Check the account’s status in the TikTok app.',
      });
    case 'unaudited_client_can_only_post_to_private_accounts':
      return new PublishError(
        'validation',
        'TikTok only lets apps that have not been audited post privately, to accounts that are set to private.',
        { retryable: false, hint: AUDIT_HINT },
      );
    case 'privacy_level_option_mismatch':
      return new PublishError(
        'validation',
        'The visibility chosen for this post is not available for this TikTok account.',
        {
          retryable: false,
          hint: 'Pick one of the visibility options TikTok offers for the account, then try again.',
        },
      );
    case 'invalid_param':
      return new PublishError('validation', withMsg('TikTok rejected the post settings.'), {
        retryable: false,
      });
    case 'url_ownership_unverified':
      return new PublishError('validation', 'TikTok could not verify ownership of the video URL.', {
        retryable: false,
      });
    case 'invalid_publish_id':
    case 'token_not_authorized_for_specified_publish_id':
      return new PublishError('platform', withMsg('TikTok no longer recognises this upload.'), {
        retryable: false,
      });
    case 'invalid_grant':
    case 'invalid_client':
    case 'invalid_request':
    case 'unauthorized_client':
      return new PublishError('auth', withMsg('TikTok did not accept the login.'), {
        retryable: false,
        hint:
          f.code === 'invalid_client'
            ? 'Check the client key and client secret in Settings → Integrations.'
            : REAUTH_HINT,
      });
    default:
      break;
  }
  if (f.httpStatus === 401)
    return new PublishError('auth', withMsg('TikTok rejected the login.'), {
      retryable: false,
      hint: REAUTH_HINT,
    });
  if (f.httpStatus === 429)
    return new PublishError(
      'rate-limit',
      'TikTok is rate limiting requests. Clipfern will retry shortly.',
      {
        retryAfterSec: f.retryAfterSec ?? 60,
      },
    );
  if (f.httpStatus >= 500)
    return new PublishError(
      'platform',
      withMsg(`TikTok had a problem ${f.doing} (HTTP ${f.httpStatus}). Try again shortly.`),
    );
  if (f.httpStatus === 403 && /audit|unaudited/i.test(`${f.code} ${msg}`))
    return new PublishError(
      'validation',
      'TikTok blocked this post because the app has not been audited.',
      {
        retryable: false,
        hint: AUDIT_HINT,
      },
    );
  return new PublishError('unknown', withMsg(`TikTok refused the request while ${f.doing}.`), {
    retryable: false,
  });
}

/** `status/fetch` -> `fail_reason` -> plain language. Unknown reasons do not retry (a retry could double-post). */
export function mapFailReason(reasonRaw: string | undefined): PublishError {
  const reason = (reasonRaw ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 60);
  switch (reason) {
    case 'file_format_check_failed':
      return new PublishError('media', 'TikTok could not process this video’s file format.', {
        retryable: false,
        hint: 'Turn on Auto-fix to re-encode it as MP4 (H.264 video + AAC audio).',
      });
    case 'duration_check_failed':
      return new PublishError('media', 'This video’s length is outside what TikTok accepts.', {
        retryable: false,
        hint: 'Trim the clip to the length your TikTok account allows.',
      });
    case 'frame_rate_check_failed':
      return new PublishError('media', 'TikTok does not support this video’s frame rate.', {
        retryable: false,
        hint: 'Turn on Auto-fix to re-encode it at a supported frame rate (30 fps).',
      });
    case 'picture_size_check_failed':
      return new PublishError('media', 'TikTok does not support this video’s picture size.', {
        retryable: false,
        hint: 'Use a vertical 9:16 video (1080×1920 works best).',
      });
    case 'internal':
      return new PublishError(
        'platform',
        'TikTok had a temporary problem processing the video. Clipfern will retry.',
      );
    case 'video_pull_failed':
    case 'photo_pull_failed':
      return new PublishError(
        'platform',
        'TikTok could not download the video. Clipfern will retry.',
      );
    case 'publish_cancelled':
      return new PublishError('platform', 'The TikTok upload was cancelled.', { retryable: false });
    case 'auth_removed':
      return new PublishError(
        'auth',
        'Access was removed in TikTok while the video was processing.',
        {
          retryable: false,
          hint: REAUTH_HINT,
        },
      );
    case 'spam_risk_too_many_posts':
      return mapApiFailure({
        httpStatus: 200,
        code: 'spam_risk_too_many_posts',
        message: '',
        retryAfterSec: null,
        doing: 'processing',
      });
    case 'spam_risk_user_banned_from_posting':
      return mapApiFailure({
        httpStatus: 200,
        code: 'spam_risk_user_banned_from_posting',
        message: '',
        retryAfterSec: null,
        doing: 'processing',
      });
    case 'spam_risk_text':
      return new PublishError('validation', 'TikTok flagged the caption as risky or spammy.', {
        retryable: false,
        hint: 'Reword the caption (fewer hashtags, no repeated text) and try again.',
      });
    case 'spam_risk':
      return new PublishError(
        'platform',
        'TikTok flagged this post as risky and did not publish it.',
        {
          retryable: false,
          hint: 'Wait a while, then try again, or post it from the TikTok app.',
        },
      );
    default:
      if (/audit/i.test(reason))
        return new PublishError(
          'validation',
          'TikTok blocked this post because the app has not been audited.',
          {
            retryable: false,
            hint: AUDIT_HINT,
          },
        );
      return new PublishError(
        'platform',
        `TikTok could not publish the video${reason ? ` (${reason})` : ''}.`,
        {
          retryable: false,
          hint: 'Check the TikTok app before trying again, so the video is not posted twice.',
        },
      );
  }
}
