import { afterEach, describe, expect, it } from 'vitest';
import { PublishError } from '@main/services/publish/errors';
import {
  graphErrorResponse,
  interceptFetch,
  makeHarness,
  SIGNATURE,
  type Harness,
} from './publish-instagram-helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const catchErr = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
};
const catchPub = async (p: Promise<unknown>): Promise<PublishError> => {
  const e = await catchErr(p);
  expect(e).toBeInstanceOf(PublishError);
  return e as PublishError;
};
const calls = (x: Harness) => x.fake.state.requests.map((r) => `${r.method} ${r.path}`);
const count = (x: Harness, re: RegExp) => calls(x).filter((s) => re.test(s)).length;

describe('instagram publish: happy path', () => {
  it('creates the container, lets Instagram pull the file, polls, publishes, links and comments', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const a = h.args(c, {
      fields: {
        caption: 'Look at this #clipfern @friend',
        shareToFeed: false,
        coverOffsetMs: 4500,
        collaborators: ['@buddy', 'pal.2'],
        locationId: '123456789',
        firstComment: '#reels #clips',
      },
    });
    const res = await h.provider.publish(a);

    const media = h.fake.state.media[0]!;
    expect(res).toEqual({
      platformPostId: media.id,
      url: media.permalink,
      outcome: 'published',
      note: null,
      quotaUnits: 0,
    });
    // Instagram really downloaded the presigned URL and got exactly our file.
    expect(h.fake.state.fetchedVideos).toHaveLength(1);
    expect(h.fake.state.fetchedVideos[0]).toMatchObject({
      ok: true,
      bytes: h.videoBytes,
      sha256: h.videoSha256,
    });
    expect(h.fake.state.fetchedVideos[0]!.url).toBe(h.videoUrl);
    // The container carries the fields.
    const p = h.fake.state.containers[0]!.params;
    expect(p).toMatchObject({
      media_type: 'REELS',
      video_url: h.videoUrl,
      caption: 'Look at this #clipfern @friend',
      share_to_feed: 'false',
      thumb_offset: '4500',
      collaborators: '["buddy","pal.2"]',
      location_id: '123456789',
    });
    // Order: limit check → create → N polls → publish → permalink → comment.
    const seq = calls(h).filter((s) => !/oauth|access_token|\/me$/.test(s));
    expect(seq[0]).toMatch(/content_publishing_limit/);
    expect(seq[1]).toMatch(/POST .*\/media$/);
    expect(seq.slice(2, 5).every((s) => /GET \/1790/.test(s))).toBe(true);
    expect(h.fake.state.containers[0]!.polls).toBe(3); // 2 × IN_PROGRESS, then FINISHED
    expect(seq.findIndex((s) => /media_publish/.test(s))).toBeGreaterThan(4);
    expect(seq.at(-1)).toMatch(/POST \/1800.*\/comments/);
    expect(media.comments.map((x) => x.message)).toEqual(['#reels #clips']);
    // Progress only moves forward and ends at 1.
    const fr = a.progress.map((x) => x.f).filter((x): x is number => x !== null);
    expect(fr).toEqual([...fr].sort((x, y) => x - y));
    expect(fr.at(-1)).toBe(1);
    expect(a.progress.some((x) => /processing/i.test(x.m ?? ''))).toBe(true);
  });

  it('omits what is empty and drops a cover time outside the video (with a note)', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const res = await h.provider.publish(
      h.args(c, { fields: { caption: '', coverOffsetMs: 31_000, firstComment: null } }),
    );
    const p = h.fake.state.containers[0]!.params;
    expect(p.thumb_offset).toBeUndefined();
    expect(p.caption).toBeUndefined();
    expect(p.collaborators).toBeUndefined();
    expect(p.share_to_feed).toBe('true');
    expect(res.note).toMatch(/cover time is outside the video/);
    expect(count(h, /comments/)).toBe(0);
  });

  it('works when the container is ready on the first poll', async () => {
    h = await makeHarness({ fake: { processingPolls: 0 } });
    const c = await h.connect();
    await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    expect(h.fake.state.containers[0]!.polls).toBe(1);
  });

  it('keeps going when a status check fails with a transient error', async () => {
    let failed = 0;
    const f = interceptFetch(({ method, url }) => {
      if (method === 'GET' && /\/1790/.test(url.pathname) && failed < 2) {
        failed++;
        return new Response('oops', { status: 502 });
      }
      return undefined;
    });
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const res = await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    expect(failed).toBe(2);
    expect(res.outcome).toBe('published');
  });

  it('retries media_publish when Instagram says the media is not ready yet (9007)', async () => {
    let n = 0;
    const f = interceptFetch(({ method, url }) =>
      method === 'POST' && url.pathname.endsWith('/media_publish') && n++ < 2
        ? graphErrorResponse(9007, 'Media ID is not available', 2207027)
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const res = await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    expect(n).toBe(3);
    expect(res.outcome).toBe('published');
    expect(h.fake.state.media).toHaveLength(1);
  });
});

describe('instagram publish: failures', () => {
  it('container ERROR → a media error in plain words, nothing is published', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.failNext('container-error');
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e.code).toBe('media');
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/does not support this video format/);
    expect(e.message).toContain('2207026'); // Instagram's own status text is kept
    expect(count(h, /media_publish/)).toBe(0);
    expect(h.fake.state.media).toHaveLength(0);
  });

  it('Instagram cannot download the presigned URL → media error, retryable (a new link next time)', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const a = h.args(c);
    a.media = h.media({ presignedUrl: async () => h!.videoUrl.replace(SIGNATURE, 'expired') });
    const e = await catchPub(h.provider.publish(a));
    expect(e.code).toBe('media');
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/could not download the video/);
    expect(h.fake.state.fetchedVideos[0]).toMatchObject({ ok: false, httpStatus: 403 });
    expect(e.message).not.toContain('expired');
  });

  it('polling timeout → a retryable platform error, nothing is published', async () => {
    h = await makeHarness({ provider: { poll: { timeoutMs: () => 300 } } });
    const c = await h.connect();
    h.fake.control.failNext('status-timeout');
    const t0 = Date.now();
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(e.code).toBe('platform');
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/still processing/);
    expect(h.fake.state.containers[0]!.polls).toBeGreaterThan(2);
    expect(count(h, /media_publish/)).toBe(0);
  });

  it('the timeout scales with the video duration', async () => {
    const { DEFAULT_POLL } = await import('@main/services/publish-instagram');
    expect(DEFAULT_POLL.timeoutMs(10)).toBe(5 * 60_000);
    expect(DEFAULT_POLL.timeoutMs(120)).toBeGreaterThan(DEFAULT_POLL.timeoutMs(60));
    expect(DEFAULT_POLL.timeoutMs(3600)).toBe(30 * 60_000);
  });

  it('abort during polling stops promptly with an AbortError and publishes nothing', async () => {
    h = await makeHarness({
      fake: { processingPolls: 1000 },
      provider: { poll: { initialMs: 20, maxMs: 20 } },
    });
    const c = await h.connect();
    const ctl = new AbortController();
    const a = h.args(c, { signal: ctl.signal });
    const p = h.provider.publish(a);
    const t = setInterval(() => {
      if ((h!.fake.state.containers[0]?.polls ?? 0) >= 2) ctl.abort();
    }, 5);
    const e = await catchErr(p);
    clearInterval(t);
    expect(e.name).toBe('AbortError');
    const polls = h.fake.state.containers[0]!.polls;
    await new Promise((r) => setTimeout(r, 120));
    expect(h.fake.state.containers[0]!.polls).toBe(polls); // no more polling after the abort
    expect(count(h, /media_publish/)).toBe(0);
  });

  it('an already aborted signal sends nothing', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const before = h.fake.state.requests.length;
    const e = await catchErr(h.provider.publish(h.args(c, { signal: AbortSignal.abort() })));
    expect(e.name).toBe('AbortError');
    expect(h.fake.state.requests.length).toBe(before);
  });

  it('a failing first comment leaves the Reel published and says so in the note', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.failNext('comment-fail');
    const res = await h.provider.publish(h.args(c, { fields: { firstComment: 'hello' } }));
    expect(res.outcome).toBe('published');
    expect(res.url).toBe(h.fake.state.media[0]!.permalink);
    expect(res.note).toMatch(/The Reel is live, but the first comment could not be posted/);
    expect(res.note).toMatch(/permission/);
    expect(h.fake.state.media[0]!.comments).toHaveLength(0);
  });

  it('a rate limit becomes rate-limit with a retryAfter', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.failNext('rate-limit');
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e).toMatchObject({ code: 'rate-limit', retryable: true, retryAfterSec: 3600 });
  });

  it('honours a Retry-After header', async () => {
    const f = interceptFetch(({ method, url }) =>
      method === 'POST' && url.pathname.endsWith('/media')
        ? new Response('{"error":{"message":"slow down","code":613}}', {
            status: 429,
            headers: { 'retry-after': '120' },
          })
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e).toMatchObject({ code: 'rate-limit', retryAfterSec: 120 });
  });

  it('an expired token (190) → auth, not retried', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.failNext('auth');
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e).toMatchObject({ code: 'auth', retryable: false });
    expect(e.hint).toMatch(/Reconnect/);
  });

  it('refuses to start a container when the daily limit is already used up', async () => {
    h = await makeHarness({ fake: { quotaTotal: 10, quotaUsage: 10 } });
    const c = await h.connect();
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e).toMatchObject({ code: 'quota', retryable: true, retryAfterSec: 3600 });
    expect(e.message).toMatch(/10/);
    expect(h.fake.state.containers).toHaveLength(0);
  });

  it('maps the publish-time limit error (2207042) to quota', async () => {
    h = await makeHarness();
    const c = await h.connect();
    h.fake.control.failNext('publish-limit');
    const e = await catchPub(h.provider.publish(h.args(c)));
    expect(e).toMatchObject({ code: 'quota', retryAfterSec: 3600 });
    expect(h.fake.state.media).toHaveLength(0);
  });

  it('does not let an unavailable limit endpoint block the post', async () => {
    const f = interceptFetch(({ url }) =>
      url.pathname.endsWith('content_publishing_limit')
        ? new Response('x', { status: 500 })
        : undefined,
    );
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const res = await h.provider.publish(h.args(c, { fields: { firstComment: null } }));
    expect(res.outcome).toBe('published');
  });

  it('refuses invalid fields before touching the network', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const before = h.fake.state.requests.length;
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    const e = await catchPub(h.provider.publish(h.args(c, { fields: { caption: tags } })));
    expect(e).toMatchObject({ code: 'validation', retryable: false });
    expect(e.message).toMatch(/31 hashtags/);
    expect(h.fake.state.requests.length).toBe(before);
  });

  it('rejects fields of another platform', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const a = h.args(c);
    a.fields = {
      platform: 'tiktok',
      title: 'x',
      mode: 'direct',
      privacyLevel: 'SELF_ONLY',
      allowComment: true,
      allowDuet: true,
      allowStitch: true,
      commercial: { enabled: false, yourBrand: false, brandedContent: false },
      coverTimestampMs: null,
      aigc: false,
    };
    expect((await catchPub(h.provider.publish(a))).code).toBe('validation');
  });
});

describe('instagram: secrets never leak', () => {
  it('no token, app secret, code or URL signature in any error, log line or progress text', async () => {
    h = await makeHarness();
    const c = await h.connect();
    const texts: string[] = [];
    const attempt = async (setup: () => void, over?: Parameters<Harness['args']>[1]) => {
      setup();
      const a = h!.args(c, over);
      try {
        const r = await h!.provider.publish(a);
        if (r.note) texts.push(r.note);
      } catch (e) {
        texts.push(
          e instanceof Error ? `${e.message} ${(e as PublishError).hint ?? ''}` : String(e),
        );
      }
      texts.push(...a.plog, ...a.progress.map((p) => p.m ?? ''));
    };
    await attempt(() => h!.fake.control.failNext('container-error'));
    await attempt(() => h!.fake.control.failNext('auth'));
    await attempt(() => h!.fake.control.failNext('rate-limit'));
    await attempt(() => h!.fake.control.failNext('publish-limit'));
    await attempt(() => h!.fake.control.failNext('comment-fail'), {
      fields: { firstComment: 'x' },
    });
    await attempt(() => undefined, {
      media: { ...h!.media(), presignedUrl: async () => h!.videoUrl.replace(SIGNATURE, 'bad') },
    } as never);
    texts.push(...h.logs);
    expect(texts.length).toBeGreaterThan(10);
    const all = texts.join('\n');
    for (const s of h.secretValues()) expect(all).not.toContain(s);
    expect(all).not.toMatch(/access_token=/);
    expect(all).not.toMatch(/X-Amz-/);
  });

  it('scrubs a secret that Instagram itself echoes in an error message', async () => {
    let tokenSeen = '';
    const f = interceptFetch(({ method, url, body }) => {
      if (method === 'POST' && url.pathname.endsWith('/media')) {
        tokenSeen = new URLSearchParams(body).get('access_token') ?? '';
        const video = new URLSearchParams(body).get('video_url') ?? '';
        return graphErrorResponse(
          100,
          `Bad request for ${video} with token ${tokenSeen} access_token=${tokenSeen} secret ${h!.fake.state.appSecret}`,
        );
      }
      return undefined;
    });
    h = await makeHarness({ fetch: f });
    const c = await h.connect();
    const logs: string[] = [];
    const a = h.args(c);
    a.log = (m) => logs.push(m);
    const e = await catchPub(h.provider.publish(a));
    expect(e.code).toBe('validation');
    expect(tokenSeen).toBe(c.tokens.accessToken);
    const all = [e.message, e.hint ?? '', ...h.logs, ...logs].join('\n');
    expect(all).not.toContain(c.tokens.accessToken);
    expect(all).not.toContain(h.fake.state.appSecret);
    expect(all).not.toContain(SIGNATURE);
    expect(e.message).toContain('***');
  });
});
