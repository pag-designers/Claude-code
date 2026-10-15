/**
 * Field rules of `videos.insert` beyond the zod schema. Docs checked 2026-10-15
 * (https://developers.google.com/youtube/v3/docs/videos):
 *  - title: <= 100 characters, any UTF-8 except `<` `>`
 *  - description: <= 5000 BYTES (UTF-8), no `<` `>`
 *  - tags: list, total <= 500 characters; commas between items count; a tag containing a space is treated as quoted
 *    and the two quotation marks count ("Foo-Baz" = 7, "Foo Baz" = 9)
 *  - categoryId: numeric string
 * "Characters" are counted as Unicode code points (an emoji is 1); the shared zod schema counts UTF-16 units and is
 * therefore stricter for astral characters, which only ever errs on the safe side.
 */
import {
  shortsFieldsSchema,
  type FieldIssue,
  type PostFields,
  type ShortsFields,
} from '@shared/publish';
import { DESCRIPTION_MAX_BYTES, TAGS_MAX_CHARS, TAG_MAX_CHARS, TITLE_MAX_CHARS } from './constants';

export const codePoints = (s: string): number => Array.from(s).length;
export const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const HAS_SHORTS_TAG = /(^|[^\p{L}\p{N}_])#shorts(?![\p{L}\p{N}_])/iu;

/** The description that is actually sent: "#Shorts" appended when requested and not already there. */
export function effectiveDescription(
  f: Pick<ShortsFields, 'description' | 'addShortsTag'>,
): string {
  const d = f.description;
  if (!f.addShortsTag || HAS_SHORTS_TAG.test(d)) return d;
  const body = d.trimEnd();
  return body ? `${body}\n\n#Shorts` : '#Shorts';
}

/** Characters the tags consume of the 500 budget: lengths + 2 for each tag with a space + commas between tags. */
export function tagBudgetUsed(tags: readonly string[]): number {
  let n = 0;
  for (const t of tags) n += codePoints(t) + (/\s/.test(t) ? 2 : 0);
  return n + Math.max(0, tags.length - 1);
}

const label = (path: PropertyKey[]): string => path.map(String).join('.') || 'fields';

export function validateShortsFields(fields: PostFields): FieldIssue[] {
  if (fields.platform !== 'shorts')
    return [{ field: 'platform', message: 'These are not YouTube Shorts fields.' }];

  const issues: FieldIssue[] = [];
  const parsed = shortsFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    for (const i of parsed.error.issues)
      issues.push({ field: label(i.path), message: schemaMessage(i.path, i.code, i.message) });
    return issues; // the API rules below assume a well-formed object
  }
  const f = parsed.data;

  const title = f.title.trim();
  if (!title) issues.push({ field: 'title', message: 'Add a title.' });
  if (codePoints(f.title) > TITLE_MAX_CHARS)
    issues.push({
      field: 'title',
      message: `The title has ${codePoints(f.title)} characters; YouTube allows ${TITLE_MAX_CHARS}.`,
    });
  if (/[<>]/.test(f.title))
    issues.push({ field: 'title', message: 'YouTube does not allow < or > in the title.' });

  const desc = effectiveDescription(f);
  const bytes = utf8Bytes(desc);
  if (bytes > DESCRIPTION_MAX_BYTES) {
    const added = utf8Bytes(desc) - utf8Bytes(f.description);
    issues.push({
      field: 'description',
      message:
        `The description is ${bytes} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES} bytes (emoji and accented ` +
        `letters take 2 to 4 bytes each)` +
        (added > 0 ? `, including the ${added} bytes of the #Shorts tag Clipfern adds.` : '.'),
    });
  }
  if (/[<>]/.test(f.description))
    issues.push({
      field: 'description',
      message: 'YouTube does not allow < or > in the description.',
    });

  f.tags.forEach((t, idx) => {
    if (!t.trim()) issues.push({ field: `tags.${idx}`, message: 'A tag is empty.' });
    else if (codePoints(t) > TAG_MAX_CHARS)
      issues.push({
        field: `tags.${idx}`,
        message: `The tag "${t.slice(0, 20)}…" is longer than ${TAG_MAX_CHARS} characters.`,
      });
  });
  const used = tagBudgetUsed(f.tags);
  if (used > TAGS_MAX_CHARS)
    issues.push({
      field: 'tags',
      message:
        `The tags use ${used} of the ${TAGS_MAX_CHARS} characters YouTube allows (commas between tags count, and ` +
        `a tag with a space counts 2 extra for the quotation marks). Remove a few tags.`,
    });

  if (!/^\d{1,4}$/.test(f.categoryId))
    issues.push({
      field: 'categoryId',
      message:
        'The category must be a number (for example 22 = People & Blogs, 24 = Entertainment).',
    });

  return issues;
}

function schemaMessage(path: PropertyKey[], code: string, fallback: string): string {
  const where = label(path);
  if (code === 'too_big') return `${where}: too long.`;
  if (code === 'too_small') return `${where}: missing or too short.`;
  if (code === 'invalid_type') return `${where}: has the wrong type or is missing.`;
  return `${where}: ${fallback}`;
}
