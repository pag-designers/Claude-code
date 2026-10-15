/**
 * Platform rules beyond the zod schema. Sources (2026-10-15):
 *  - title <= 2200 UTF-16 runes: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *  - commercial content + privacy rules: https://developers.tiktok.com/doc/content-sharing-guidelines
 *    ("at least one of Your brand / Branded content"; "Branded content visibility cannot be set to private")
 */
import type { FieldIssue, PostFields } from '@shared/publish';
import { TIKTOK_PRIVACY_LEVELS } from '@shared/publish';

export const TITLE_MAX_UTF16 = 2200;

/** Most private first. */
export const PRIVACY_RANK: Record<string, number> = {
  SELF_ONLY: 0,
  MUTUAL_FOLLOW_FRIENDS: 1,
  FOLLOWER_OF_CREATOR: 2,
  PUBLIC_TO_EVERYONE: 3,
};

export const PRIVACY_LABEL: Record<string, string> = {
  SELF_ONLY: 'Only me',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  PUBLIC_TO_EVERYONE: 'Everyone',
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `"A,B"` -> known privacy levels only. Empty when the string is missing / unknown. */
export function parsePrivacyOptions(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(s));
}

export function validateTiktokFields(
  fields: PostFields,
  ctx?: { privacyOptions?: string[] },
): FieldIssue[] {
  if (fields.platform !== 'tiktok')
    return [{ field: 'platform', message: 'These are not TikTok fields.' }];
  const issues: FieldIssue[] = [];
  const len = fields.title.length; // UTF-16 code units, which is what TikTok counts
  if (len > TITLE_MAX_UTF16)
    issues.push({
      field: 'title',
      message: `The caption is ${len} characters long; TikTok allows ${TITLE_MAX_UTF16} (emoji count as 2).`,
    });
  if (LONE_SURROGATE.test(fields.title))
    issues.push({
      field: 'title',
      message: 'The caption contains a broken emoji character. Remove or retype it.',
    });

  const options = ctx?.privacyOptions ?? [];
  if (fields.mode === 'direct' && options.length > 0 && !options.includes(fields.privacyLevel)) {
    issues.push({
      field: 'privacyLevel',
      message: `This TikTok account cannot post as “${PRIVACY_LABEL[fields.privacyLevel] ?? fields.privacyLevel}”. Available: ${options
        .map((o) => PRIVACY_LABEL[o] ?? o)
        .join(', ')}.`,
    });
  }

  const c = fields.commercial;
  if (c.enabled && !c.yourBrand && !c.brandedContent)
    issues.push({
      field: 'commercial',
      message: 'Choose "Your brand", "Branded content" or both, or turn commercial content off.',
    });
  if (
    c.enabled &&
    c.brandedContent &&
    fields.mode === 'direct' &&
    fields.privacyLevel === 'SELF_ONLY'
  )
    issues.push({
      field: 'privacyLevel',
      message:
        'Branded content visibility cannot be set to private. Choose another visibility, or upload to drafts.',
    });
  return issues;
}
