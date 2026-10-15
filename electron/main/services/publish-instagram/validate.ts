/**
 * Instagram Reels field rules. Limits from the IG User Media reference (checked 2026-10-15):
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 *   caption: up to 2,200 characters, 30 hashtags and 20 @mentions; collaborators: up to 3 usernames.
 * The first comment follows the same limits (the brief's rule; Instagram enforces similar ones on comments).
 */
import type { FieldIssue, PostFields } from '@shared/publish';

export const MAX_CAPTION_CHARS = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_MENTIONS = 20;
export const MAX_COLLABORATORS = 3;

/** A hashtag: `#` not glued to a word character / another `#` / `&` (HTML entities) / `/` (URL fragments). */
const HASHTAG = /(?<![\p{L}\p{N}_#&/])#[\p{L}\p{N}_]+/gu;
/** A mention: `@name` (1-30 of letters, digits, `.`, `_`), not part of an e-mail address or a word. */
const MENTION = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9._]{1,30}/gu;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export const countHashtags = (t: string): number => t.match(HASHTAG)?.length ?? 0;
export const countMentions = (t: string): number => t.match(MENTION)?.length ?? 0;
/** Characters as a person counts them (an emoji is one, not two UTF-16 units). */
export const charCount = (t: string): number => [...t].length;

function textIssues(field: string, label: string, text: string, out: FieldIssue[]): void {
  const n = charCount(text);
  if (n > MAX_CAPTION_CHARS)
    out.push({
      field,
      message: `${label} is ${n} characters; Instagram allows ${MAX_CAPTION_CHARS}.`,
    });
  const h = countHashtags(text);
  if (h > MAX_HASHTAGS)
    out.push({ field, message: `${label} has ${h} hashtags; Instagram allows ${MAX_HASHTAGS}.` });
  const m = countMentions(text);
  if (m > MAX_MENTIONS)
    out.push({ field, message: `${label} has ${m} @mentions; Instagram allows ${MAX_MENTIONS}.` });
}

export const cleanUsername = (u: string): string => u.trim().replace(/^@+/, '');

export function validateReelsFields(f: PostFields): FieldIssue[] {
  if (f.platform !== 'reels')
    return [{ field: 'platform', message: 'These fields are not for Instagram Reels.' }];
  const out: FieldIssue[] = [];
  textIssues('caption', 'The caption', f.caption, out);
  if (f.firstComment !== null) textIssues('firstComment', 'The first comment', f.firstComment, out);
  if (f.collaborators.length > MAX_COLLABORATORS)
    out.push({
      field: 'collaborators',
      message: `${f.collaborators.length} collaborators; Instagram allows ${MAX_COLLABORATORS}.`,
    });
  const seen = new Set<string>();
  for (const raw of f.collaborators) {
    const u = cleanUsername(raw);
    if (!USERNAME.test(u))
      out.push({
        field: 'collaborators',
        message: `"${raw}" is not a valid Instagram username (letters, digits, "." and "_", up to 30).`,
      });
    else if (seen.has(u.toLowerCase()))
      out.push({ field: 'collaborators', message: `"${u}" is listed twice.` });
    seen.add(u.toLowerCase());
  }
  if (f.locationId !== null && !/^\d+$/.test(f.locationId.trim()))
    out.push({
      field: 'locationId',
      message: 'The location id must be the numeric id of a Facebook Page with a location.',
    });
  return out;
}
