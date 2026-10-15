/** Shared harness of the publish-instagram tests: the fake Instagram, a local "bucket" serving the video, a provider. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PostFields, ReelsFields } from '@shared/publish';
import { reelsFieldsSchema } from '@shared/publish';
import type {
  OAuthTokens,
  ProviderAccount,
  PublishArgs,
  PublishMedia,
} from '@main/pipeline/contracts5';
import {
  createInstagramProvider,
  type InstagramProviderOptions,
} from '@main/services/publish-instagram';
import {
  startFakeInstagram,
  type FakeInstagram,
  type FakeInstagramOptions,
} from '../support/fake-instagram';

export const REDIRECT_URI = 'http://127.0.0.1:53682/oauth/reels';
/** What the presigned URL carries; must never show up in an error or a log line. */
export const SIGNATURE = 'SIGSECRETabcdef0123456789';

export interface Harness {
  fake: FakeInstagram;
  provider: ReturnType<typeof createInstagramProvider>;
  logs: string[];
  videoSha256: string;
  videoBytes: number;
  videoFile: string;
  /** A presigned-style URL of the video (the "bucket" demands the signature). */
  videoUrl: string;
  media(over?: Partial<PublishMedia>): PublishMedia;
  /** Browser-less consent: follows the authorize redirect and returns what the loopback server would see. */
  authorize(): Promise<{ code: string; state: string; raw: string }>;
  connect(): Promise<{ tokens: OAuthTokens; account: ProviderAccount }>;
  args(
    c: { tokens: OAuthTokens; account: ProviderAccount },
    over?: Omit<Partial<PublishArgs>, 'fields'> & { fields?: Partial<ReelsFields> },
  ): PublishArgs & { progress: { f: number | null; m?: string }[]; plog: string[] };
  /** Every string a user or a log could see for the secrets check. */
  secretValues(): string[];
  close(): Promise<void>;
}

export async function makeHarness(
  o: {
    fake?: FakeInstagramOptions;
    provider?: InstagramProviderOptions;
    fetch?: typeof fetch;
    credentials?: { clientId: string; clientSecret: string } | null;
  } = {},
): Promise<Harness> {
  const fake = await startFakeInstagram(o.fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-test-'));
  const videoFile = path.join(dir, 'clip.mp4');
  const bytes = crypto.randomBytes(300_000);
  fs.writeFileSync(videoFile, bytes);
  const videoSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const bucket = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/clip.mp4' || u.searchParams.get('X-Amz-Signature') !== SIGNATURE)
      return void res.writeHead(403).end('forbidden');
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }).end(bytes);
  });
  await new Promise<void>((r) => bucket.listen(0, '127.0.0.1', r));
  const bucketBase = `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`;
  const videoUrl = `${bucketBase}/clip.mp4?X-Amz-Algorithm=AWS4&X-Amz-Signature=${SIGNATURE}`;
  const logs: string[] = [];
  const creds =
    o.credentials === undefined
      ? { clientId: fake.state.appId, clientSecret: fake.state.appSecret }
      : o.credentials;
  const provider = createInstagramProvider(
    {
      getCredentials: () => creds,
      baseUrls: { metaOauth: fake.urls.oauthBase, graph: fake.urls.graphBase },
      log: (m) => logs.push(m),
      fetch: o.fetch,
      timeoutMs: 5_000,
    },
    {
      ...o.provider,
      poll: { initialMs: 5, factor: 1.2, maxMs: 20, timeoutMs: () => 10_000, ...o.provider?.poll },
    },
  );

  const h: Harness = {
    fake,
    provider,
    logs,
    videoSha256,
    videoBytes: bytes.length,
    videoFile,
    videoUrl,
    media: (over) => ({
      file: videoFile,
      sizeBytes: bytes.length,
      durationSec: 30,
      width: 1080,
      height: 1920,
      contentType: 'video/mp4',
      presignedUrl: async () => videoUrl,
      ...over,
    }),
    async authorize() {
      const url = provider.authUrl({
        redirectUri: REDIRECT_URI,
        state: 'st-123',
        codeChallenge: 'x',
      });
      const res = await fetch(url, { redirect: 'manual' });
      const loc = res.headers.get('location') ?? '';
      const u = new URL(loc);
      return {
        code: u.searchParams.get('code') ?? '',
        state: u.searchParams.get('state') ?? '',
        raw: loc,
      };
    },
    async connect() {
      const { code } = await h.authorize();
      return provider.exchangeCode({ code, redirectUri: REDIRECT_URI, codeVerifier: 'v' });
    },
    args(c, over = {}) {
      const progress: { f: number | null; m?: string }[] = [];
      const plog: string[] = [];
      const { fields: fo, ...rest } = over;
      const fields: PostFields = reelsFieldsSchema.parse({
        platform: 'reels',
        caption: 'Hello #clipfern @friend',
        ...fo,
      });
      return {
        tokens: c.tokens,
        account: c.account,
        fields,
        media: h.media(),
        onProgress: (f, m) => progress.push({ f, m }),
        log: (m) => plog.push(m),
        progress,
        plog,
        ...rest,
      };
    },
    secretValues() {
      return [
        fake.state.appSecret,
        SIGNATURE,
        ...fake.state.tokens.map((t) => t.value),
        ...fake.state.authCodes.map((c) => c.code),
      ];
    },
    async close() {
      await fake.stop();
      await new Promise<void>((r) => bucket.close(() => r()));
      bucket.closeAllConnections();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Wraps fetch so a test can answer chosen requests itself. Return undefined to pass through. */
export function interceptFetch(
  rule: (req: {
    method: string;
    url: URL;
    body: string;
  }) => Response | undefined | Promise<Response | undefined>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const hit = await rule({ method: init?.method ?? 'GET', url, body: String(init?.body ?? '') });
    return hit ?? fetch(input, init);
  }) as typeof fetch;
}

export const graphErrorResponse = (
  code: number,
  message: string,
  subcode?: number,
  status = 400,
): Response =>
  new Response(
    JSON.stringify({
      error: {
        message,
        type: 'OAuthException',
        code,
        ...(subcode ? { error_subcode: subcode } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
