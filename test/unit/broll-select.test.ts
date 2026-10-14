import { describe, expect, it } from 'vitest';
import {
  isMp4Url,
  matchesOrientation,
  pickPreview,
  pickRendition,
  shapeOf,
  titleFromSlug,
  titleFromTags,
  withinHd,
} from '@main/services/broll/select';
import { TtlLru } from '@main/services/broll/cache';
import { retryAfterSeconds } from '@main/services/broll/http';

const r = (width: number, height: number, size?: number) => ({
  url: `https://cdn/x-${width}x${height}.mp4`,
  width,
  height,
  size,
});

describe('orientation', () => {
  it('classifies by aspect with a square band', () => {
    expect(shapeOf(1080, 1920)).toBe('portrait');
    expect(shapeOf(1920, 1080)).toBe('landscape');
    expect(shapeOf(1080, 1080)).toBe('square');
    expect(shapeOf(1000, 1050)).toBe('square');
    expect(matchesOrientation(1, 1, 'any')).toBe(true);
    expect(matchesOrientation(0, 0, 'portrait')).toBe(false);
  });
});

describe('pickRendition', () => {
  it('<= 1080p only, prefers the 1080 class, never 4K', () => {
    expect(withinHd({ width: 3840, height: 2160 })).toBe(false);
    expect(withinHd({ width: 2560, height: 1440 })).toBe(false);
    expect(withinHd({ width: 1920, height: 1080 })).toBe(true);
    expect(withinHd({ width: 1080, height: 1920 })).toBe(true);
    const got = pickRendition([r(3840, 2160), r(1280, 720), r(1920, 1080), r(960, 540)], 16 / 9);
    expect(got).toMatchObject({ width: 1920, height: 1080 });
    expect(pickRendition([r(3840, 2160), r(4096, 2160)], 16 / 9)).toBeNull();
    expect(pickRendition([], 1)).toBeNull();
  });

  it("keeps the clip's orientation over a bigger rendition of another shape", () => {
    const got = pickRendition([r(1920, 1080), r(720, 1280), r(540, 960)], 9 / 16);
    expect(got).toMatchObject({ width: 720, height: 1280 });
  });

  it('with no matching orientation, takes the closest aspect available', () => {
    const got = pickRendition([r(1920, 1080), r(1280, 720)], 9 / 16);
    expect(got).toMatchObject({ width: 1920, height: 1080 });
  });

  it('breaks ties by file size', () => {
    expect(pickRendition([r(1920, 1080, 5), r(1920, 1080, 9)], 16 / 9)?.size).toBe(9);
  });
});

describe('pickPreview / titles / urls', () => {
  it('picks the smallest decent rendition', () => {
    expect(pickPreview([r(1920, 1080), r(640, 360), r(320, 180)])).toMatchObject({ width: 640 });
    expect(pickPreview([r(160, 90), r(100, 60)])).toMatchObject({ width: 100 });
    expect(pickPreview([])).toBeNull();
  });
  it('titles', () => {
    expect(titleFromSlug('https://www.pexels.com/video/a-woman-on-the-beach-3015510/', 'F')).toBe(
      'A woman on the beach',
    );
    expect(titleFromSlug('https://www.pexels.com/video/3015510/', 'F')).toBe('F');
    expect(titleFromSlug(null, 'F')).toBe('F');
    expect(titleFromSlug('not a url', 'F')).toBe('F');
    expect(titleFromTags(' sea , waves,, sun, extra', 'F')).toBe('Sea, waves, sun');
    expect(titleFromTags('', 'F')).toBe('F');
  });
  it('mp4 urls', () => {
    expect(isMp4Url('https://a/b.mp4?x=1', false)).toBe(true);
    expect(isMp4Url('http://a/b.mp4', false)).toBe(false);
    expect(isMp4Url('http://a/b.mp4', true)).toBe(true);
    expect(isMp4Url('https://a/b.m3u8', false)).toBe(false);
    expect(isMp4Url('https://a/b.webm', false, false)).toBe(false);
    expect(isMp4Url('https://a/b', false, false)).toBe(true);
    expect(isMp4Url('javascript:alert(1)', true)).toBe(false);
  });
});

describe('TtlLru / Retry-After', () => {
  it('expires and evicts', () => {
    let t = 0;
    const c = new TtlLru<number>(2, 100, () => t);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a is now most recent
    c.set('c', 3); // evicts b
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    t = 101;
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBeLessThanOrEqual(2);
  });
  it('parses Retry-After in seconds and dates, Pixabay relative reset', () => {
    expect(retryAfterSeconds('pexels', new Headers({ 'retry-after': '12' }), 0)).toBe(12);
    expect(retryAfterSeconds('pixabay', new Headers({ 'x-ratelimit-reset': '33' }), 0)).toBe(33);
    expect(retryAfterSeconds('pexels', new Headers(), 0)).toBeNull();
    expect(retryAfterSeconds('pexels', new Headers({ 'retry-after': 'garbage' }), 0)).toBeNull();
  });
});
