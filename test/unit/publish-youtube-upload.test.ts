import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OAuthTokens, ProviderAccount, PublisherProvider } from '@main/pipeline/contracts5';
import { isPublishError, type PublishError } from '@main/services/publish/errors';
import { nextPacificMidnight } from '@main/services/publish-youtube';
import { startFakeYoutube, type FakeYoutube } from '../support/fake-youtube';
import {
  connect,
  makeProvider,
  publishArgs,
  rmDir,
  shorts,
  tmpDir,
  writeMedia,
} from './publish-youtube-helpers';

const KiB = 1024;
const MiB = 1024 * KiB;

let fake: FakeYoutube;
let dir: string;
let provider: PublisherProvider;
let tokens: OAuthTokens;
let account: ProviderAccount;
const sleeps: number[] = [];

async function setup(
  o: { now?: () => number; chunkBytes?: number; maxRetries?: number; fetch?: typeof fetch } = {},
) {
  provider = makeProvider(fake, {
    now: o.now,
    fetch: o.fetch,
    options: {
      chunkBytes: o.chunkBytes ?? 1 * MiB,
      maxRetries: o.maxRetries,
      retryBaseMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
  ({ tokens, account } = await connect(provider));
}

async function failure(p: Promise<unknown>): Promise<PublishError> {
  try {
    await p;
  } catch (e) {
    if (isPublishError(e)) return e;
    throw e;
  }
  throw new Error('expected the publish to fail');
}

beforeEach(async () => {
  fake = await startFakeYoutube();
  dir = tmpDir();
  sleeps.length = 0;
});
afterEach(async () => {
  await fake.stop();
  rmDir(dir);
});

describe('publish: resumable upload, happy path', () => {
  it('uploads in chunks, sends the documented metadata and headers, and returns the Shorts link', async () => {
    await setup();
    const media = writeMedia(dir, 2 * MiB + 12_345);
    const progress: (number | null)[] = [];
    const res = await provider.publish(
      publishArgs(tokens, account, media, {
        fields: shorts({
          title: 'Hello 🌍',
          description: 'Body text',
          tags: ['a', 'two words'],
          categoryId: '24',
          visibility: 'unlisted',
          madeForKids: true,
          notifySubscribers: false,
        }),
        progress: (f) => progress.push(f),
      }),
    );

    const v = fake.state.videos[0]!;
    expect(fake.state.videos).toHaveLength(1);
    expect(res).toEqual({
      platformPostId: v.id,
      url: `https://youtube.com/shorts/${v.id}`,
      outcome: 'published',
      note: null,
      quotaUnits: 1,
    });
    // byte-identical on the server
    expect(v.byteCount).toBe(media.sizeBytes);
    expect(v.sha256).toBe(media.sha256);
    expect(v.contentType).toBe('video/mp4');
    // metadata
    expect(v.metadata.snippet).toEqual({
      title: 'Hello 🌍',
      description: 'Body text\n\n#Shorts',
      tags: ['a', 'two words'],
      categoryId: '24',
    });
    expect(v.metadata.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: true });
    expect(v.metadata.status).not.toHaveProperty('publishAt');
    expect(v.notifySubscribers).toBe(false);
    // protocol details
    expect(fake.state.lastInit?.query).toMatchObject({
      uploadType: 'resumable',
      part: 'snippet,status',
      notifySubscribers: 'false',
    });
    expect(fake.state.lastInit?.headers).toMatchObject({
      'x-upload-content-length': String(media.sizeBytes),
      'x-upload-content-type': 'video/mp4',
      'content-type': 'application/json; charset=UTF-8',
    });
    const chunks = fake.state.requests.filter((r) => r.route === 'upload.chunk');
    expect(chunks.map((c) => c.contentRange)).toEqual([
      `bytes 0-${MiB - 1}/${media.sizeBytes}`,
      `bytes ${MiB}-${2 * MiB - 1}/${media.sizeBytes}`,
      `bytes ${2 * MiB}-${media.sizeBytes - 1}/${media.sizeBytes}`,
    ]);
    expect(chunks.map((c) => c.status)).toEqual([308, 308, 200]);
    expect(fake.state.counters.badChunks).toBe(0);
    expect(fake.state.quota.insert).toBe(1);
    // progress: starts at 0, ends at 1, never goes back
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    const nums = progress as number[];
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThanOrEqual(nums[i - 1]!);
    expect(nums.filter((n) => n > 0 && n < 1)).toHaveLength(2);
  });

  it('a file smaller than one chunk goes up in a single request; #Shorts is not duplicated', async () => {
    await setup({ chunkBytes: 4 * MiB });
    const media = writeMedia(dir, 100_000);
    await provider.publish(
      publishArgs(tokens, account, media, { fields: shorts({ description: 'Fun #shorts' }) }),
    );
    expect(fake.state.counters.chunkRequests).toBe(1);
    expect(fake.state.videos[0]!.metadata.snippet?.description).toBe('Fun #shorts');
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
  });

  it('does not add #Shorts when addShortsTag is off', async () => {
    await setup();
    await provider.publish(
      publishArgs(tokens, account, writeMedia(dir, 300_000), {
        fields: shorts({ description: 'Plain', addShortsTag: false }),
      }),
    );
    expect(fake.state.videos[0]!.metadata.snippet?.description).toBe('Plain');
  });

  it('accepts the 201 Created the docs describe', async () => {
    await fake.stop();
    fake = await startFakeYoutube({ finalStatus: 201 });
    await setup();
    const media = writeMedia(dir, 600 * KiB);
    const res = await provider.publish(publishArgs(tokens, account, media));
    expect(res.platformPostId).toBe(fake.state.videos[0]!.id);
  });

  it('reports a note when YouTube applies a different privacy than requested', async () => {
    await setup();
    fake.control.forcePrivacy('private');
    const res = await provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000)));
    expect(res.note).toMatch(/"private" instead of "public"/);
  });

  it('refuses invalid fields before any network request', async () => {
    await setup();
    const err = await failure(
      provider.publish(
        publishArgs(tokens, account, writeMedia(dir, 300_000), {
          fields: shorts({ title: 'bad <title>' }),
        }),
      ),
    );
    expect(err.code).toBe('validation');
    expect(err.retryable).toBe(false);
    expect(fake.state.counters.uploadInits).toBe(0);
  });

  it('a missing file is a media error', async () => {
    await setup();
    const media = writeMedia(dir, 300_000);
    const err = await failure(
      provider.publish(publishArgs(tokens, account, { ...media, file: `${dir}/nope.mp4` })),
    );
    expect(err.code).toBe('media');
    expect(fake.state.counters.uploadInits).toBe(0);
  });
});

describe('publish: resume', () => {
  it('after a connection dropped MID-CHUNK it asks for the status and continues from the committed range', async () => {
    await setup();
    const media = writeMedia(dir, 3 * MiB);
    // 600 KiB of the first 1 MiB chunk arrive; the server persists whole 256 KiB blocks = 512 KiB
    fake.control.failNext('drop-connection', 1, { afterBytes: 600 * KiB });
    const res = await provider.publish(publishArgs(tokens, account, media));
    const v = fake.state.videos[0]!;
    expect(res.platformPostId).toBe(v.id);
    expect(v.sha256).toBe(media.sha256); // byte-identical despite the drop
    expect(v.byteCount).toBe(3 * MiB);
    expect(fake.state.videos).toHaveLength(1);
    expect(fake.state.counters.droppedConnections).toBe(1);
    expect(fake.state.counters.statusQueries).toBe(1);
    expect(fake.state.counters.badChunks).toBe(0);
    const ranges = fake.state.requests
      .filter((r) => r.route === 'upload.chunk' && r.status !== 0)
      .map((r) => r.contentRange);
    expect(ranges[0]).toBe(`bytes ${512 * KiB}-${512 * KiB + MiB - 1}/${3 * MiB}`);
    expect(fake.state.quota.insert).toBe(1); // one session, not a new upload
  });

  it('a drop before a single block was stored resumes from 0 (no Range header in the 308)', async () => {
    await setup();
    const media = writeMedia(dir, 2 * MiB);
    fake.control.failNext('drop-connection', 1, { afterBytes: 10 * KiB });
    await provider.publish(publishArgs(tokens, account, media));
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
    expect(fake.state.counters.badChunks).toBe(0);
  });

  it('the final chunk stored but its answer lost: the status query returns the finished video, no duplicate', async () => {
    await setup();
    const media = writeMedia(dir, 2 * MiB + 1000);
    fake.control.failNext('drop-connection', 1, {
      phase: 'after-commit',
      atOffset: 2 * MiB,
    });
    const res = await provider.publish(publishArgs(tokens, account, media));
    expect(fake.state.videos).toHaveLength(1);
    expect(res.platformPostId).toBe(fake.state.videos[0]!.id);
    expect(fake.state.counters.statusQueries).toBe(1);
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
  });

  it('recovers from 503s with growing back-off and finishes identical', async () => {
    await setup();
    const media = writeMedia(dir, 2 * MiB);
    fake.control.failNext('5xx', 3, { status: 503 });
    await provider.publish(publishArgs(tokens, account, media));
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
    expect(sleeps).toEqual([100, 200, 400]);
    expect(fake.state.counters.statusQueries).toBe(3);
  });

  it.each([500, 502, 504])('treats HTTP %i as resumable too', async (status) => {
    await setup();
    const media = writeMedia(dir, 1 * MiB + 5);
    fake.control.failNext('5xx', 1, { status });
    await provider.publish(publishArgs(tokens, account, media));
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
  });

  it('gives up after the bounded number of retries with a retryable platform error', async () => {
    await setup({ maxRetries: 3 });
    fake.control.failNext('5xx', 50);
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 2 * MiB))),
    );
    expect(err.code).toBe('platform');
    expect(err.retryable).toBe(true);
    expect(fake.state.videos).toHaveLength(0);
    expect(sleeps).toHaveLength(3);
  });

  it('retries a 503 on session creation', async () => {
    await setup();
    fake.control.failNext('5xx', 2, { on: ['init'] });
    await provider.publish(publishArgs(tokens, account, writeMedia(dir, 500_000)));
    expect(fake.state.videos).toHaveLength(1);
    expect(fake.state.counters.uploadInits).toBe(3);
  });

  it('starts a new session when the old one expired (404), delivers identical bytes and progress never goes back', async () => {
    await setup();
    const media = writeMedia(dir, 3 * MiB);
    let expired = false;
    const progress: number[] = [];
    await provider.publish(
      publishArgs(tokens, account, media, {
        progress: (f) => {
          if (f === null) return;
          progress.push(f);
          if (!expired && f > 0.5 && f < 1) {
            expired = true;
            fake.control.expireSessions();
          }
        },
      }),
    );
    expect(fake.state.counters.uploadInits).toBe(2);
    expect(fake.state.videos).toHaveLength(1);
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  });

  it('a network that is simply gone is a retryable network error', async () => {
    await setup({ maxRetries: 2 });
    await fake.stop();
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 500_000))),
    );
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
    fake = await startFakeYoutube(); // for afterEach
  });
});

describe('publish: abort', () => {
  it('aborting from onProgress after the first chunk stops the upload (AbortError, no more chunks)', async () => {
    await setup();
    const ac = new AbortController();
    const media = writeMedia(dir, 4 * MiB);
    let err: unknown;
    try {
      await provider.publish(
        publishArgs(tokens, account, media, {
          signal: ac.signal,
          progress: (f) => {
            if (f !== null && f > 0) ac.abort();
          },
        }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('AbortError');
    expect(fake.state.counters.chunkRequests).toBe(1);
    expect(fake.state.videos).toHaveLength(0);
  });

  it('aborting while a chunk is in flight cancels the request', async () => {
    const ac = new AbortController();
    let puts = 0;
    const abortingFetch: typeof fetch = async (input, init) => {
      if (init?.method === 'PUT' && ++puts === 2) ac.abort();
      return fetch(input, init);
    };
    await setup({ fetch: abortingFetch });
    let err: unknown;
    try {
      await provider.publish(
        publishArgs(tokens, account, writeMedia(dir, 4 * MiB), { signal: ac.signal }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('AbortError');
    expect(fake.state.videos).toHaveLength(0);
  });

  it('an already aborted signal sends nothing', async () => {
    await setup();
    const ac = new AbortController();
    ac.abort();
    let err: unknown;
    try {
      await provider.publish(
        publishArgs(tokens, account, writeMedia(dir, 300_000), { signal: ac.signal }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('AbortError');
    expect(fake.state.counters.uploadInits).toBe(0);
  });

  it('aborting during a back-off sleep stops immediately', async () => {
    const ac = new AbortController();
    provider = makeProvider(fake, {
      options: {
        chunkBytes: 1 * MiB,
        retryBaseMs: 100,
        sleep: (_ms, signal) =>
          new Promise((_res, rej) => {
            ac.abort();
            if (signal?.aborted) {
              const e = new Error('Aborted');
              e.name = 'AbortError';
              rej(e);
            }
          }),
      },
    });
    ({ tokens, account } = await connect(provider));
    fake.control.failNext('5xx', 1);
    let err: unknown;
    try {
      await provider.publish(
        publishArgs(tokens, account, writeMedia(dir, 2 * MiB), { signal: ac.signal }),
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('AbortError');
  });
});

describe('publish: error mapping', () => {
  it('quota exceeded → quota error that retries after the next Pacific midnight, with the extension hint', async () => {
    const now = Date.parse('2026-01-15T20:00:00Z'); // noon PST
    await setup({ now: () => now });
    fake.control.failNext('quota');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('quota');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSec).toBe(12 * 3600);
    expect(err.hint).toMatch(/Quota Extension/i);
    expect(err.hint).toMatch(/midnight Pacific/i);
  });

  it.each([
    ['2026-03-08T12:00:00Z', 19 * 3600, 'spring forward'],
    ['2026-11-01T08:00:00Z', 24 * 3600, 'fall back'],
    ['2026-07-15T06:59:00Z', 60, 'one minute before PDT midnight'],
  ])('quota retryAfter on %s is %i s (%s)', async (iso, secs) => {
    const now = Date.parse(iso);
    await setup({ now: () => now });
    fake.control.failNext('quota');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.retryAfterSec).toBe(secs);
    expect(now + err.retryAfterSec! * 1000).toBe(nextPacificMidnight(now));
  });

  it('the real 101st upload of the day is refused with the same quota error', async () => {
    await setup({ now: () => Date.parse('2026-01-15T20:00:00Z') });
    fake.control.setInsertDailyLimit(1);
    const media = writeMedia(dir, 300_000);
    await provider.publish(publishArgs(tokens, account, media));
    const err = await failure(provider.publish(publishArgs(tokens, account, media)));
    expect(err.code).toBe('quota');
    expect(fake.state.videos).toHaveLength(1);
  });

  it('401 → auth, not retryable, with a reconnect hint', async () => {
    await setup();
    fake.control.failNext('auth');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(err.hint).toMatch(/connect/i);
  });

  it('an access token the server no longer knows is an auth error', async () => {
    await setup();
    fake.control.expireAccessTokens();
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('auth');
  });

  it('400 invalidTitle → validation with the API wording', async () => {
    await setup();
    fake.control.failNext('invalid-title');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('validation');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/invalid or empty video title/);
  });

  it('403 forbidden → platform with the API message, not retryable', async () => {
    await setup();
    fake.control.failNext('forbidden');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('platform');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/does not have permission to upload/);
  });

  it('uploadLimitExceeded → platform with the API message and a hint', async () => {
    await setup();
    fake.control.failNext('upload-limit');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('platform');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/exceeded the number of videos/);
    expect(err.hint).toMatch(/tomorrow|verify/i);
  });

  it('429 → rate-limit honouring Retry-After', async () => {
    await setup();
    fake.control.failNext('rate-limit');
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('rate-limit');
    expect(err.retryAfterSec).toBe(30);
  });

  it('a file YouTube refuses as too large → media error', async () => {
    await setup();
    fake.control.setMaxUploadBytes(1000);
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('media');
    expect(err.retryable).toBe(false);
  });

  it('refuses an upload address on a foreign host and never sends the token there', async () => {
    const seen: string[] = [];
    const evil: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (init?.method === 'POST' && url.includes('/upload/')) {
        const r = await fetch(input, init);
        return new Response(await r.text(), {
          status: r.status,
          headers: { location: 'https://evil.example/steal' },
        });
      }
      return fetch(input, init);
    };
    await setup({ fetch: evil });
    const err = await failure(
      provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
    );
    expect(err.code).toBe('platform');
    expect(err.retryable).toBe(false);
    expect(seen.some((u) => u.includes('evil.example'))).toBe(false);
  });

  it.each([
    'quota',
    'auth',
    '5xx',
    'invalid-title',
    'forbidden',
    'upload-limit',
    'rate-limit',
  ] as const)('the %s error text never contains a token or the client secret', async (kind) => {
    const logs: string[] = [];
    await setup({ maxRetries: 1 });
    fake.control.failNext(kind, 50, kind === '5xx' ? { on: ['init'] } : {});
    const err = await failure(
      provider.publish(
        publishArgs(tokens, account, writeMedia(dir, 300_000), { log: (m) => logs.push(m) }),
      ),
    );
    const text = [err.message, err.hint ?? '', String(err.stack), ...logs].join('\n');
    for (const s of [tokens.accessToken, tokens.refreshToken!, fake.clientSecret])
      expect(text).not.toContain(s);
    expect(text).not.toMatch(/upload_id=/);
  });
});

describe('publish: a real ~20 MB file', () => {
  it('uploads 20 MB in default-size chunks with monotonic progress and a matching sha256', async () => {
    provider = makeProvider(fake, { options: { sleep: async () => {} } }); // default 4 MiB chunks
    ({ tokens, account } = await connect(provider));
    const media = writeMedia(dir, 20 * MiB + 12_345, 'big');
    const progress: number[] = [];
    const res = await provider.publish(
      publishArgs(tokens, account, media, { progress: (f) => f !== null && progress.push(f) }),
    );
    const v = fake.state.videos[0]!;
    expect(res.platformPostId).toBe(v.id);
    expect(v.byteCount).toBe(media.sizeBytes);
    expect(v.sha256).toBe(media.sha256);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(new Set(progress).size).toBeGreaterThanOrEqual(6);
    expect(fake.state.counters.chunkRequests).toBe(6);
  }, 60_000);

  it('survives two dropped connections and a 503 in the middle of 20 MB, progress never goes back', async () => {
    await setup({ chunkBytes: 2 * MiB });
    const media = writeMedia(dir, 20 * MiB + 777, 'big2');
    fake.control.failNext('drop-connection', 1, { afterBytes: 1_300_000, atOffset: 4 * MiB });
    fake.control.failNext('drop-connection', 1, { afterBytes: 100, atOffset: 13 * MiB });
    fake.control.failNext('5xx', 1, { atOffset: 17 * MiB });
    const progress: number[] = [];
    await provider.publish(
      publishArgs(tokens, account, media, { progress: (f) => f !== null && progress.push(f) }),
    );
    expect(fake.state.videos[0]!.sha256).toBe(media.sha256);
    expect(fake.state.counters.droppedConnections).toBe(2);
    expect(fake.state.requests.some((r) => r.status === 503)).toBe(true);
    expect(fake.state.counters.badChunks).toBe(0);
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
  }, 60_000);
});

describe('fetchStats and quota', () => {
  it('reads views, likes and comments; shares are null', async () => {
    await setup();
    await provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000)));
    const id = fake.state.videos[0]!.id;
    fake.control.setStats(id, { viewCount: 12_345, likeCount: 67, commentCount: 8 });
    let t = 777;
    provider = makeProvider(fake, { now: () => t });
    const s = await provider.fetchStats!({ tokens, account, platformPostId: id });
    expect(s).toEqual({ views: 12_345, likes: 67, comments: 8, shares: null, fetchedAt: 777 });
    t++;
  });

  it('hidden likes become null; an unknown or private video gives null', async () => {
    await setup();
    await provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000)));
    const id = fake.state.videos[0]!.id;
    fake.control.setStats(id, { viewCount: 5, likeCount: null });
    expect(await provider.fetchStats!({ tokens, account, platformPostId: id })).toMatchObject({
      views: 5,
      likes: null,
    });
    expect(await provider.fetchStats!({ tokens, account, platformPostId: 'nope' })).toBeNull();
  });

  it('a dead token is an auth error', async () => {
    await setup();
    fake.control.expireAccessTokens();
    const err = await failure(provider.fetchStats!({ tokens, account, platformPostId: 'x' }));
    expect(err.code).toBe('auth');
  });

  it('quota(): 100 uploads/day, reset at the next Pacific midnight, postsLeft from the posts used', async () => {
    await setup();
    const now = Date.parse('2026-03-08T12:00:00Z');
    const q = await provider.quota({ tokens, account, usedUnits: 3, usedPosts: 3, now });
    expect(q).toMatchObject({
      used: 3,
      limit: 100,
      unit: 'posts',
      resetsAt: Date.parse('2026-03-09T07:00:00Z'),
      postsLeft: 97,
    });
    expect(q.note).toMatch(/Quota Extension/i);
    const over = await provider.quota({ tokens, account, usedUnits: 0, usedPosts: 130, now });
    expect(over.postsLeft).toBe(0);
  });

  it('quota() respects a raised limit; quotaCost is one unit', async () => {
    const p = makeProvider(fake, { options: { dailyUploadLimit: 250 } });
    const q = await p.quota({
      tokens: {} as OAuthTokens,
      account: {} as ProviderAccount,
      usedUnits: 50,
      usedPosts: 50,
      now: 0,
    });
    expect(q.limit).toBe(250);
    expect(q.postsLeft).toBe(200);
    expect(p.quotaCost(shorts())).toBe(1);
  });
});

describe('hostile server that echoes secrets into its error texts', () => {
  it.each(['auth', 'invalid-title', 'forbidden', 'upload-limit'] as const)(
    'scrubs tokens from the %s error',
    async (kind) => {
      await fake.stop();
      fake = await startFakeYoutube({ echoSecretsInErrors: true });
      await setup({ maxRetries: 1 });
      fake.control.failNext(kind, 5);
      const err = await failure(
        provider.publish(publishArgs(tokens, account, writeMedia(dir, 300_000))),
      );
      const text = `${err.message} ${err.hint ?? ''}`;
      for (const s of [tokens.accessToken, tokens.refreshToken!]) expect(text).not.toContain(s);
      if (kind === 'forbidden') expect(err.message).toContain('***'); // the scrub really ran
    },
  );
});
