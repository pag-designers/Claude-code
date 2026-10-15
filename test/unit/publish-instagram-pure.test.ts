import { describe, expect, it } from 'vitest';
import { reelsFieldsSchema, type PostFields, type ReelsFields } from '@shared/publish';
import { PublishError } from '@main/services/publish/errors';
import {
  InstagramApiError,
  mapContainerFailure,
  mapFailure,
} from '@main/services/publish-instagram/errors';
import { SecretSet } from '@main/services/publish-instagram/redact';
import {
  parseContainerStatus,
  parseInsights,
  parseMe,
  parsePublishingLimit,
  parseShortToken,
} from '@main/services/publish-instagram/schemas';
import {
  countHashtags,
  countMentions,
  createInstagramProvider,
  validateReelsFields,
} from '@main/services/publish-instagram';

const f = (over: Partial<ReelsFields> = {}): PostFields =>
  reelsFieldsSchema.parse({ platform: 'reels', ...over });
/** The zod schema caps these already; the provider must not depend on it (fields can come from stored JSON). */
const raw = (over: Record<string, unknown>): PostFields =>
  ({ ...reelsFieldsSchema.parse({ platform: 'reels' }), ...over }) as PostFields;
const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ');
const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@user${i}`).join(' ');

describe('validateFields: Instagram limits', () => {
  it('30 hashtags pass, 31 fail', () => {
    expect(validateReelsFields(f({ caption: tags(30) }))).toEqual([]);
    const bad = validateReelsFields(f({ caption: tags(31) }));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ field: 'caption' });
    expect(bad[0]!.message).toContain('31 hashtags');
  });

  it('20 @mentions pass, 21 fail', () => {
    expect(validateReelsFields(f({ caption: mentions(20) }))).toEqual([]);
    expect(validateReelsFields(f({ caption: mentions(21) }))[0]!.message).toContain('21 @mentions');
  });

  it('2200 characters pass, 2201 fail; an emoji counts as one character', () => {
    expect(validateReelsFields(f({ caption: 'a'.repeat(2200) }))).toEqual([]);
    expect(validateReelsFields(raw({ caption: 'a'.repeat(2201) }))[0]!.message).toContain(
      '2201 characters',
    );
    expect(validateReelsFields(raw({ caption: '😀'.repeat(2200) }))).toEqual([]);
  });

  it('does not count e-mail addresses, URL fragments or entities', () => {
    expect(countMentions('mail me: jo@example.com and @real.user')).toBe(1);
    expect(countHashtags('see https://x.dev/page#section and &#39; but #yes #also_yes')).toBe(2);
    expect(countHashtags('#a#b')).toBe(1);
    expect(countHashtags('#ünïcode #日本語 #123')).toBe(3);
  });

  it('applies the same limits to the first comment', () => {
    expect(validateReelsFields(f({ firstComment: tags(30) }))).toEqual([]);
    const bad = validateReelsFields(f({ firstComment: tags(31) }));
    expect(bad[0]).toMatchObject({ field: 'firstComment' });
    expect(validateReelsFields(f({ firstComment: mentions(21) }))[0]!.field).toBe('firstComment');
  });

  it('collaborators: 3 pass, 4 fail; usernames are checked', () => {
    expect(validateReelsFields(f({ collaborators: ['a', '@b.c', 'd_e'] }))).toEqual([]);
    expect(validateReelsFields(raw({ collaborators: ['a', 'b', 'c', 'd'] }))[0]).toMatchObject({
      field: 'collaborators',
    });
    expect(validateReelsFields(f({ collaborators: ['bad name!'] }))[0]!.message).toContain(
      'not a valid',
    );
    expect(validateReelsFields(f({ collaborators: ['Same', '@same'] }))[0]!.message).toContain(
      'twice',
    );
  });

  it('location id must be numeric; other platforms are refused', () => {
    expect(validateReelsFields(f({ locationId: '12345' }))).toEqual([]);
    expect(validateReelsFields(f({ locationId: 'Paris' }))[0]!.field).toBe('locationId');
    expect(
      validateReelsFields({
        platform: 'shorts',
        title: 't',
        description: '',
        tags: [],
        visibility: 'public',
        madeForKids: false,
        categoryId: '22',
        notifySubscribers: true,
        addShortsTag: true,
      }),
    ).toHaveLength(1);
  });

  it('is exposed through the provider (platform reels, quotaCost 0)', () => {
    const p = createInstagramProvider({ getCredentials: () => null });
    expect(p.platform).toBe('reels');
    expect(p.validateFields(f({ caption: tags(31) }))).toHaveLength(1);
    expect(p.quotaCost(f())).toBe(0);
  });
});

const secrets = new SecretSet();
const map = (
  status: number,
  error: Record<string, unknown>,
  retryAfterHeader: string | null = null,
) => mapFailure({ status, retryAfterHeader, body: { error }, now: 1_000_000, secrets });

describe('error mapping by Graph code / subcode', () => {
  it.each([190, 102, 463, 467])('code %i → auth, never retried, with a reconnect hint', (code) => {
    const e = map(400, { message: 'Error validating access token', code });
    expect(e).toBeInstanceOf(PublishError);
    expect(e).toMatchObject({ code: 'auth', retryable: false });
    expect(e.hint).toMatch(/Reconnect/);
    expect(e.message).toContain('Error validating access token'); // the platform's own words
  });

  it.each([4, 17, 32, 613])('code %i → rate-limit, retry in an hour by default', (code) => {
    expect(map(400, { message: 'limit', code })).toMatchObject({
      code: 'rate-limit',
      retryable: true,
      retryAfterSec: 3600,
    });
  });

  it('Retry-After (seconds or date) wins; HTTP 429 alone is a rate limit', () => {
    expect(map(429, { message: 'x', code: 4 }, '90').retryAfterSec).toBe(90);
    expect(
      map(429, { message: 'x' }, new Date(1_000_000 + 45_000).toUTCString()).retryAfterSec,
    ).toBe(45);
    expect(map(429, {}).code).toBe('rate-limit');
  });

  it('media errors are media; transient ones are retryable', () => {
    expect(map(400, { message: 'm', code: 352, error_subcode: 2207026 })).toMatchObject({
      code: 'media',
      retryable: false,
    });
    expect(map(400, { message: 'm', code: 9004, error_subcode: 2207052 })).toMatchObject({
      code: 'media',
      retryable: true,
    });
    expect(map(400, { message: 'm', code: 9004 })).toMatchObject({ code: 'media' }); // by legacy code alone
    expect(map(400, { message: 'm', code: -2, error_subcode: 2207003 })).toMatchObject({
      code: 'media',
      retryable: true,
    });
    expect(map(400, { message: 'm', code: -1, error_subcode: 2207053 })).toMatchObject({
      code: 'media',
    });
  });

  it('9007 (media not ready) is a retryable platform error', () => {
    const e = map(400, { message: 'not ready', code: 9007, error_subcode: 2207027 });
    expect(e).toMatchObject({ code: 'platform', retryable: true });
    expect(e).toBeInstanceOf(InstagramApiError);
  });

  it('daily publishing limit → quota; spam restriction → platform, not retried', () => {
    expect(map(400, { message: 'm', code: 9, error_subcode: 2207042 })).toMatchObject({
      code: 'quota',
      retryAfterSec: 3600,
    });
    // code 4 would be a rate limit, but the documented subcode 2207051 means the post was flagged as spam.
    expect(map(400, { message: 'm', code: 4, error_subcode: 2207051 })).toMatchObject({
      code: 'platform',
      retryable: false,
    });
  });

  it('invalid parameter → validation; 5xx / code 1 / 2 → retryable platform; the rest → platform with the API text', () => {
    expect(map(400, { message: 'bad collaborator', code: 100 })).toMatchObject({
      code: 'validation',
      retryable: false,
    });
    expect(map(400, { message: 'bad cover', code: 1, error_subcode: 2207057 }).code).toBe(
      'validation',
    );
    expect(map(500, { message: 'x' })).toMatchObject({ code: 'platform', retryable: true });
    expect(map(400, { message: 'x', code: 2 })).toMatchObject({
      code: 'platform',
      retryable: true,
    });
    const other = map(400, { message: 'Something odd', code: 12345 });
    expect(other.code).toBe('platform');
    expect(other.message).toContain('Something odd');
  });

  it('survives garbage bodies', () => {
    for (const body of [null, 'oops', 42, [], { error: 5 }, { error: { code: 'abc' } }])
      expect(
        mapFailure({ status: 400, retryAfterHeader: null, body, now: 0, secrets }),
      ).toBeInstanceOf(PublishError);
  });

  it('container ERROR / EXPIRED statuses', () => {
    const err = mapContainerFailure(
      'ERROR',
      'Error: Media upload has failed with error code 2207026',
      secrets,
    );
    expect(err).toMatchObject({ code: 'media', retryable: false });
    expect(err.message).toMatch(/MP4 or MOV/);
    expect(mapContainerFailure('ERROR', null, secrets).message).toMatch(/3 s to 15 min/);
    expect(mapContainerFailure('ERROR', 'Something unexpected', secrets).message).toContain(
      'Something unexpected',
    );
    expect(mapContainerFailure('EXPIRED', null, secrets)).toMatchObject({
      code: 'media',
      retryable: true,
    });
    expect(mapContainerFailure('ERROR', 'Error 2207057', secrets).code).toBe('validation');
  });
});

describe('redaction', () => {
  it('removes registered secrets, parameters, URL query strings and token shapes', () => {
    const s = new SecretSet();
    s.add('my-app-secret-value');
    const out = s.redact(
      'secret my-app-secret-value; access_token=abc123 ; https://b.example.com/clip.mp4?X-Amz-Signature=deadbeef&X-Amz-Credential=k ; IGAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    );
    expect(out).not.toMatch(/my-app-secret-value|abc123|deadbeef|X-Amz|IGAAx/);
    expect(out).toContain('https://b.example.com/clip.mp4?…');
  });
});

describe('tolerant response parsing', () => {
  it('reads both the wrapped and the flat short-lived token, with permissions as list or string', () => {
    expect(
      parseShortToken({ data: [{ access_token: 'a', user_id: 1, permissions: 'x,y' }] }),
    ).toEqual({
      accessToken: 'a',
      permissions: ['x', 'y'],
    });
    expect(parseShortToken({ access_token: 'b', permissions: ['p'] })).toEqual({
      accessToken: 'b',
      permissions: ['p'],
    });
    expect(parseShortToken({ data: [] })).toBeNull();
    expect(parseShortToken('nope')).toBeNull();
  });

  it('keeps /me ids exact and falls back to id; ignores unsafe numbers', () => {
    expect(parseMe({ user_id: '17841405793187218', username: ' u ', extra: 1 })).toMatchObject({
      igUserId: '17841405793187218',
      username: 'u',
    });
    expect(parseMe({ id: '55', user_id: 17841405793187218 })?.igUserId).toBe('55');
    expect(parseMe({ username: 'x' })).toBeNull();
  });

  it('publishing limit, status and insights with missing or odd fields', () => {
    expect(parsePublishingLimit({ data: [{ quota_usage: '3' }] })).toEqual({
      used: 3,
      total: null,
      durationSec: null,
    });
    expect(
      parsePublishingLimit({
        data: { quota_usage: 1, config: { quota_total: 100, quota_duration: 86400 } },
      }),
    ).toEqual({
      used: 1,
      total: 100,
      durationSec: 86400,
    });
    expect(parsePublishingLimit({})).toBeNull();
    expect(parseContainerStatus({ status_code: 'finished' }).statusCode).toBe('FINISHED');
    expect(parseContainerStatus(null).statusCode).toBe('');
    expect(
      parseInsights({
        data: [
          { name: 'views', values: [{ value: 5 }] },
          { name: 'shares', total_value: { value: 2 } },
          { name: 'breakdown', values: [{ value: { a: 1 } }] },
          { values: [{ value: 9 }] },
          'junk',
        ],
      }),
    ).toEqual({ views: 5, shares: 2 });
  });
});
