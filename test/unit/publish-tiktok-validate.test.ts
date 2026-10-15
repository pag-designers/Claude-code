/** Pure `validateFields` rules of the TikTok publisher (title in UTF-16 units, privacy options, commercial content). */
import { describe, expect, it } from 'vitest';
import { tiktokFieldsSchema, type TiktokFields } from '@shared/publish';
import type { ProviderAccount } from '@main/pipeline/contracts5';
import { createTiktokProvider } from '@main/services/publish-tiktok';

const p = createTiktokProvider({ getCredentials: () => null });
const f = (over: Record<string, unknown> = {}): TiktokFields =>
  // The title cap is also in the zod schema; build past it on purpose to test the provider's own check.
  ({ ...tiktokFieldsSchema.parse({ platform: 'tiktok' }), ...over }) as TiktokFields;
const acct = (privacyOptions?: string): Pick<ProviderAccount, 'info'> => ({
  info: privacyOptions === undefined ? {} : { privacyOptions },
});
const fieldsOf = (x: TiktokFields, a?: ReturnType<typeof acct>) =>
  p.validateFields(x, a ? { account: a } : undefined).map((i) => i.field);

describe('TikTok validateFields', () => {
  it('title: 2200 UTF-16 code units pass, 2201 fail', () => {
    expect(fieldsOf(f({ title: 'a'.repeat(2200) }))).toEqual([]);
    expect(fieldsOf(f({ title: 'a'.repeat(2201) }))).toEqual(['title']);
    expect(fieldsOf(f({ title: '' }))).toEqual([]);
  });

  it('title: emoji and other surrogate pairs count as 2 units', () => {
    const e = '\u{1F600}'; // 1 code point, 2 UTF-16 units
    expect(e.length).toBe(2);
    expect(fieldsOf(f({ title: e.repeat(1100) }))).toEqual([]); // exactly 2200
    expect(fieldsOf(f({ title: e.repeat(1101) }))).toEqual(['title']); // 2202
    expect(fieldsOf(f({ title: 'a'.repeat(2198) + e }))).toEqual([]); // 2200
    expect(fieldsOf(f({ title: 'a'.repeat(2199) + e }))).toEqual(['title']); // 2201 although only 2200 code points
    expect([...('a'.repeat(2199) + e)].length).toBe(2200);
  });

  it('title: a lone surrogate is reported, a valid pair is not', () => {
    expect(fieldsOf(f({ title: 'hi \uD83D' }))).toEqual(['title']);
    expect(fieldsOf(f({ title: '\uDE00 hi' }))).toEqual(['title']);
    expect(fieldsOf(f({ title: 'hi \u{1F680}' }))).toEqual([]);
  });

  it('privacy: must be one of the creator’s options when they are known', () => {
    const a = acct('SELF_ONLY');
    const bad = p.validateFields(f({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), { account: a });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ field: 'privacyLevel' });
    expect(bad[0]?.message).toContain('Only me');
    expect(fieldsOf(f({ privacyLevel: 'SELF_ONLY' }), a)).toEqual([]);
    const all = acct('PUBLIC_TO_EVERYONE,MUTUAL_FOLLOW_FRIENDS,SELF_ONLY');
    expect(fieldsOf(f({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), all)).toEqual([]);
    expect(fieldsOf(f({ privacyLevel: 'FOLLOWER_OF_CREATOR' }), all)).toEqual(['privacyLevel']);
  });

  it('privacy: unknown options (no account / empty / garbage) are not guessed at', () => {
    expect(fieldsOf(f({ privacyLevel: 'PUBLIC_TO_EVERYONE' }))).toEqual([]);
    expect(fieldsOf(f({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), acct(''))).toEqual([]);
    expect(fieldsOf(f({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), acct('NOPE'))).toEqual([]);
  });

  it('draft mode ignores the privacy level', () => {
    expect(
      fieldsOf(f({ mode: 'draft', privacyLevel: 'PUBLIC_TO_EVERYONE' }), acct('SELF_ONLY')),
    ).toEqual([]);
  });

  it('commercial content: when enabled, at least one of your brand / branded content', () => {
    const c = (yourBrand: boolean, brandedContent: boolean, enabled = true) => ({
      enabled,
      yourBrand,
      brandedContent,
    });
    expect(fieldsOf(f({ commercial: c(false, false) }))).toEqual(['commercial']);
    expect(fieldsOf(f({ commercial: c(false, false, false) }))).toEqual([]);
    expect(fieldsOf(f({ commercial: c(true, false), privacyLevel: 'SELF_ONLY' }))).toEqual([]);
    expect(fieldsOf(f({ commercial: c(true, true), privacyLevel: 'PUBLIC_TO_EVERYONE' }))).toEqual(
      [],
    );
  });

  it('commercial content: branded content cannot be SELF_ONLY (direct mode only)', () => {
    const branded = { enabled: true, yourBrand: false, brandedContent: true };
    const issues = p.validateFields(f({ commercial: branded, privacyLevel: 'SELF_ONLY' }));
    expect(issues.map((i) => i.field)).toEqual(['privacyLevel']);
    expect(issues[0]?.message).toMatch(/Branded content/);
    expect(fieldsOf(f({ commercial: branded, privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' }))).toEqual([]);
    expect(fieldsOf(f({ commercial: branded, privacyLevel: 'SELF_ONLY', mode: 'draft' }))).toEqual(
      [],
    );
    // disabled commercial content never triggers the rule even with the flag left on
    expect(
      fieldsOf(f({ commercial: { ...branded, enabled: false }, privacyLevel: 'SELF_ONLY' })),
    ).toEqual([]);
  });

  it('rejects other platforms’ fields', () => {
    expect(p.validateFields({ platform: 'reels' } as never)).toHaveLength(1);
  });
});
