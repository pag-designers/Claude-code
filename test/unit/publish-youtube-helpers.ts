/** Shared helpers of the publish-youtube tests: provider wired to the fake server, an OAuth driver, media files. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  OAuthTokens,
  ProviderAccount,
  PublishArgs,
  PublishMedia,
  PublisherProvider,
} from '@main/pipeline/contracts5';
import { createYoutubeProvider, type YoutubeProviderOptions } from '@main/services/publish-youtube';
import { shortsFieldsSchema, type ShortsFields } from '@shared/publish';
import type { FakeYoutube } from '../support/fake-youtube';

export const REDIRECT = 'http://127.0.0.1:53682/oauth/shorts';

export function makeProvider(
  fake: FakeYoutube,
  o: {
    now?: () => number;
    options?: YoutubeProviderOptions;
    credentials?: { clientId: string; clientSecret: string } | null;
    log?: (m: string) => void;
    fetch?: typeof fetch;
  } = {},
): PublisherProvider {
  return createYoutubeProvider(
    {
      getCredentials: () =>
        o.credentials === undefined
          ? { clientId: fake.clientId, clientSecret: fake.clientSecret }
          : o.credentials,
      baseUrls: fake.urls,
      now: o.now,
      log: o.log,
      fetch: o.fetch,
    },
    { sleep: async () => {}, retryBaseMs: 10, ...o.options },
  );
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
}

/** What the system browser + the lead's loopback server do: GET the consent URL, read `code` + `state` off the 302. */
export async function consent(
  provider: PublisherProvider,
  state = 'state-123',
): Promise<{ code: string; state: string | null; verifier: string; error: string | null }> {
  const { verifier, challenge } = pkce();
  const url = provider.authUrl({ redirectUri: REDIRECT, state, codeChallenge: challenge });
  const res = await fetch(url, { redirect: 'manual' });
  const loc = res.headers.get('location');
  if (res.status !== 302 || !loc)
    throw new Error(`consent failed: HTTP ${res.status} ${await res.text()}`);
  const q = new URL(loc).searchParams;
  return { code: q.get('code') ?? '', state: q.get('state'), verifier, error: q.get('error') };
}

export async function connect(
  provider: PublisherProvider,
): Promise<{ tokens: OAuthTokens; account: ProviderAccount }> {
  const c = await consent(provider);
  return provider.exchangeCode({ code: c.code, redirectUri: REDIRECT, codeVerifier: c.verifier });
}

/** Deterministic pseudo-random bytes (AES-CTR keystream), so a file's hash can be recomputed anywhere. */
export function writeMedia(
  dir: string,
  bytes: number,
  seed = 'seed',
): PublishMedia & { sha256: string } {
  const key = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, Buffer.alloc(16));
  const file = path.join(dir, `clip-${seed}-${bytes}.mp4`);
  const fd = fs.openSync(file, 'w');
  const hash = crypto.createHash('sha256');
  const block = Buffer.alloc(1024 * 1024);
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, block.length);
    const out = cipher.update(block.subarray(0, n));
    fs.writeSync(fd, out);
    hash.update(out);
    left -= n;
  }
  fs.closeSync(fd);
  return {
    file,
    sizeBytes: bytes,
    durationSec: 30,
    width: 1080,
    height: 1920,
    contentType: 'video/mp4',
    presignedUrl: async () => 'https://unused.example/never-called',
    sha256: hash.digest('hex'),
  };
}

export const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-yt-'));
export const rmDir = (d: string): void => fs.rmSync(d, { recursive: true, force: true });

export function shorts(over: Partial<ShortsFields> = {}): ShortsFields {
  return shortsFieldsSchema.parse({
    platform: 'shorts',
    title: 'A great moment',
    description: 'Watch till the end',
    tags: ['clips', 'podcast'],
    madeForKids: false,
    ...over,
  });
}

export function publishArgs(
  tokens: OAuthTokens,
  account: ProviderAccount,
  media: PublishMedia,
  o: {
    fields?: ShortsFields;
    signal?: AbortSignal;
    progress?: (f: number | null, m?: string) => void;
    log?: (m: string) => void;
  } = {},
): PublishArgs {
  return {
    tokens,
    account,
    fields: o.fields ?? shorts(),
    media,
    signal: o.signal,
    onProgress: o.progress ?? (() => {}),
    log: o.log ?? (() => {}),
  };
}
