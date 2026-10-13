import { describe, expect, it } from 'vitest';
import { parseYoutubeUrl } from '../../renderer/lib/urls';
import { formatBytes, formatGb, timeAgo } from '../../renderer/lib/format';
import { gbUnit } from '../../renderer/lib/storage';

describe('parseYoutubeUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'watch'],
    ['youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'watch'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'watch'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'short-link'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'shorts'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'live'],
  ])('accepts %s', (url, kind) => {
    const r = parseYoutubeUrl(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe('dQw4w9WgXcQ');
      expect(r.kind).toBe(kind);
    }
  });

  it.each([
    'https://vimeo.com/12345',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://youtu.be/',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'notaurl',
    'https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
  ])('rejects %s with a reason', (url) => {
    const r = parseYoutubeUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
  });

  it('treats blank input as empty, not an error message', () => {
    const r = parseYoutubeUrl('   ');
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('format helpers', () => {
  it('formats storage sizes', () => {
    expect(formatGb(3_690_000_000)).toBe('3.69');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1_500_000)).toBe('1.50 MB');
  });
  it('infers GB unit from limit and free tier', () => {
    expect(gbUnit(10e9, 10)).toBe(1e9);
    expect(gbUnit(10 * 1073741824, 10)).toBe(1073741824);
  });
  it('relative time', () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toMatch(/5 min/);
  });
});
