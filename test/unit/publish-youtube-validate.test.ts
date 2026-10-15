import { describe, expect, it } from 'vitest';
import {
  effectiveDescription,
  nextPacificMidnight,
  secondsUntilQuotaReset,
  tagBudgetUsed,
  validateShortsFields,
} from '@main/services/publish-youtube';
import { createYoutubeProvider } from '@main/services/publish-youtube';
import type { ShortsFields } from '@shared/publish';
import { shorts } from './publish-youtube-helpers';

const iso = (ms: number) => new Date(ms).toISOString();
const fields = (o: Partial<ShortsFields> = {}) => validateShortsFields(shorts(o));
/** Bypasses the zod defaults/limits so the API rules themselves are exercised. */
const raw = (o: Partial<ShortsFields>) =>
  validateShortsFields({ ...shorts(), ...o } as ShortsFields);
const by = (issues: { field: string; message: string }[], f: string) =>
  issues.filter((i) => i.field === f);

describe('validateFields (YouTube API rules)', () => {
  it('accepts a normal post', () => {
    expect(fields()).toEqual([]);
  });

  it('rejects non-Shorts fields', () => {
    const p = createYoutubeProvider({ getCredentials: () => null });
    const issues = p.validateFields({
      platform: 'reels',
      caption: '',
      shareToFeed: true,
      coverOffsetMs: null,
      firstComment: null,
      collaborators: [],
      locationId: null,
    });
    expect(issues[0]?.field).toBe('platform');
  });

  describe('title', () => {
    it('allows exactly 100 characters, refuses 101', () => {
      expect(fields({ title: 'a'.repeat(100) })).toEqual([]);
      expect(by(raw({ title: 'a'.repeat(101) }), 'title')[0]?.message).toMatch(
        /too long \(at most 100\)/,
      );
    });
    it('counts an emoji as ONE character (code points), though zod counts UTF-16 units', () => {
      // 50 emoji = 100 UTF-16 units = 50 code points: fine
      expect(fields({ title: '😀'.repeat(50) })).toEqual([]);
      // 100 code points of an astral character pass the API rule…
      expect(by(raw({ title: '😀'.repeat(100) }), 'title')).toEqual([]);
      // …and 101 do not
      expect(by(raw({ title: '😀'.repeat(101) }), 'title')).toHaveLength(1);
    });
    it('refuses < and >, and a blank title', () => {
      expect(by(fields({ title: 'a <b> c' }), 'title')[0]?.message).toMatch(/< or >/);
      expect(by(raw({ title: '   ' }), 'title')[0]?.message).toMatch(/Add a title/);
    });
    it('reports zod schema violations as field issues (empty title, too many tags)', () => {
      expect(by(raw({ title: '' }), 'title').length).toBeGreaterThan(0);
      expect(
        raw({ tags: Array.from({ length: 41 }, (_, i) => `t${i}`) }).some(
          (i) => i.field === 'tags',
        ),
      ).toBe(true);
    });
  });

  describe('description (bytes, not characters)', () => {
    it('5000 ASCII bytes pass, 5001 do not', () => {
      expect(fields({ description: 'a'.repeat(5000), addShortsTag: false })).toEqual([]);
      expect(raw({ description: 'a'.repeat(5001), addShortsTag: false })).not.toEqual([]);
    });
    it('2500 two-byte letters (5000 bytes) pass, 2501 fail although far below 5000 characters', () => {
      expect(fields({ description: 'é'.repeat(2500), addShortsTag: false })).toEqual([]);
      const issues = fields({ description: 'é'.repeat(2501), addShortsTag: false });
      // zod allows it (2501 chars) — the byte rule catches it
      expect(by(issues, 'description')[0]?.message).toMatch(/5002 bytes/);
    });
    it('emoji are 4 bytes each', () => {
      expect(fields({ description: '😀'.repeat(1250), addShortsTag: false })).toEqual([]);
      expect(
        by(fields({ description: '😀'.repeat(1251), addShortsTag: false }), 'description'),
      ).toHaveLength(1);
    });
    it('counts the #Shorts tag the app appends', () => {
      const d = 'a'.repeat(4995); // + "\n\n#Shorts" (9 bytes) = 5004
      expect(fields({ description: d, addShortsTag: false })).toEqual([]);
      const issues = fields({ description: d, addShortsTag: true });
      expect(by(issues, 'description')[0]?.message).toMatch(/#Shorts tag/);
      // already present → nothing appended → fits
      expect(fields({ description: `${'a'.repeat(4985)} #Shorts`, addShortsTag: true })).toEqual(
        [],
      );
    });
    it('refuses < and >', () => {
      expect(by(fields({ description: 'x > y' }), 'description')[0]?.message).toMatch(/< or >/);
    });
  });

  describe('effectiveDescription', () => {
    it('appends #Shorts once, case-insensitively, and not for look-alikes', () => {
      expect(effectiveDescription({ description: 'Hello', addShortsTag: true })).toBe(
        'Hello\n\n#Shorts',
      );
      expect(effectiveDescription({ description: '', addShortsTag: true })).toBe('#Shorts');
      expect(effectiveDescription({ description: 'Hi #shorts yo', addShortsTag: true })).toBe(
        'Hi #shorts yo',
      );
      expect(effectiveDescription({ description: 'Hi #SHORTS', addShortsTag: true })).toBe(
        'Hi #SHORTS',
      );
      expect(effectiveDescription({ description: 'Hi #shortsfeed', addShortsTag: true })).toBe(
        'Hi #shortsfeed\n\n#Shorts',
      );
      expect(effectiveDescription({ description: 'Hello', addShortsTag: false })).toBe('Hello');
      expect(effectiveDescription({ description: 'trailing  \n\n', addShortsTag: true })).toBe(
        'trailing\n\n#Shorts',
      );
    });
  });

  describe('tags (500-character budget)', () => {
    it('follows the documented examples: "Foo-Baz" = 7, "Foo Baz" = 9', () => {
      expect(tagBudgetUsed(['Foo-Baz'])).toBe(7);
      expect(tagBudgetUsed(['Foo Baz'])).toBe(9);
    });
    it('commas between tags count', () => {
      expect(tagBudgetUsed(['ab', 'cd', 'ef'])).toBe(6 + 2);
    });
    it('accepts exactly 500 and refuses 501', () => {
      const t = (n: number) => 'x'.repeat(n);
      expect(fields({ tags: [t(99), t(99), t(99), t(99), t(100)] })).toEqual([]); // 496 + 4 commas = 500
      expect(
        by(fields({ tags: [t(99), t(99), t(99), t(99), t(100), 'a'] }), 'tags')[0]?.message,
      ).toMatch(/502 of the 500/);
    });
    it('quotes around tags with spaces push the budget over', () => {
      const withSpace = 'x'.repeat(48) + ' ' + 'y'.repeat(48); // 97 chars + 2 quotes = 99
      const tags = Array.from({ length: 5 }, () => withSpace); // 5*99 + 4 = 499 → ok
      expect(fields({ tags })).toEqual([]);
      const plain = ['z'.repeat(100)];
      expect(by(fields({ tags: [...tags, ...plain] }), 'tags')).toHaveLength(1);
    });
    it('counts emoji tags as one character each', () => {
      expect(tagBudgetUsed(['😀😀'])).toBe(2);
    });
    it('refuses blank tags and tags over 100 characters', () => {
      expect(by(raw({ tags: ['ok', '  '] }), 'tags.1')).toHaveLength(1);
      expect(raw({ tags: ['a'.repeat(101)] }).length).toBeGreaterThan(0);
    });
  });

  describe('categoryId', () => {
    it.each([
      ['22', true],
      ['24', true],
      ['1', true],
      ['abc', false],
      ['', false],
      ['2 2', false],
      ['-1', false],
    ])('%j -> %s', (categoryId, ok) => {
      expect(fields({ categoryId }).filter((i) => i.field === 'categoryId').length === 0).toBe(ok);
    });
  });
});

describe('Pacific quota reset', () => {
  const utc = (s: string) => Date.parse(s);

  it('winter (PST, UTC-8): from noon PST the reset is 12 h away at 08:00Z', () => {
    const now = utc('2026-01-15T20:00:00Z');
    expect(iso(nextPacificMidnight(now))).toBe('2026-01-16T08:00:00.000Z');
    expect(secondsUntilQuotaReset(now)).toBe(12 * 3600);
  });

  it('summer (PDT, UTC-7): the reset is at 07:00Z', () => {
    const now = utc('2026-07-15T20:00:00Z'); // 13:00 PDT
    expect(iso(nextPacificMidnight(now))).toBe('2026-07-16T07:00:00.000Z');
    expect(secondsUntilQuotaReset(now)).toBe(11 * 3600);
  });

  it('spring-forward day (2026-03-08, 23 h long): before and after the 02:00 jump', () => {
    // 23:00 PST on Mar 7: one hour to the (PST) midnight that starts Mar 8
    expect(iso(nextPacificMidnight(utc('2026-03-08T07:00:00Z')))).toBe('2026-03-08T08:00:00.000Z');
    // 05:00 PDT on Mar 8: the next midnight is PDT already (07:00Z), 19 h away
    const now = utc('2026-03-08T12:00:00Z');
    expect(iso(nextPacificMidnight(now))).toBe('2026-03-09T07:00:00.000Z');
    expect(secondsUntilQuotaReset(now)).toBe(19 * 3600);
  });

  it('fall-back day (2026-11-01, 25 h long): the day ends in PST', () => {
    // 01:00 PDT (first pass) → midnight Nov 2 is PST (08:00Z): 24 h away
    const a = utc('2026-11-01T08:00:00Z');
    expect(iso(nextPacificMidnight(a))).toBe('2026-11-02T08:00:00.000Z');
    expect(secondsUntilQuotaReset(a)).toBe(24 * 3600);
    // 04:00 PST → 20 h away
    const b = utc('2026-11-01T12:00:00Z');
    expect(iso(nextPacificMidnight(b))).toBe('2026-11-02T08:00:00.000Z');
    expect(secondsUntilQuotaReset(b)).toBe(20 * 3600);
  });

  it('exactly at midnight the next reset is a full day away; one second before it is 1 s away', () => {
    const mid = utc('2026-01-16T08:00:00Z');
    expect(iso(nextPacificMidnight(mid))).toBe('2026-01-17T08:00:00.000Z');
    expect(secondsUntilQuotaReset(utc('2026-01-16T07:59:59Z'))).toBe(1);
    expect(secondsUntilQuotaReset(utc('2026-01-16T07:59:59.500Z'))).toBe(1);
  });

  it('crosses month and year ends', () => {
    expect(iso(nextPacificMidnight(utc('2026-12-31T20:00:00Z')))).toBe('2027-01-01T08:00:00.000Z');
    expect(iso(nextPacificMidnight(utc('2028-02-28T20:00:00Z')))).toBe('2028-02-29T08:00:00.000Z'); // leap year
  });
});
