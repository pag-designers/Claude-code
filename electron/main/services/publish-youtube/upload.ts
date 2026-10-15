/**
 * `videos.insert` with the RESUMABLE upload protocol, in 256 KiB-aligned chunks, resuming after dropped connections
 * and 500/502/503/504. Docs checked 2026-10-15:
 *  - https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *  - https://developers.google.com/youtube/v3/docs/videos/insert
 * Protocol recap: POST `…/videos?uploadType=resumable&part=snippet,status` with the metadata → 200 + `Location`
 * (session URI). PUT chunks with `Content-Range: bytes A-B/TOTAL`: 308 + `Range: bytes=0-N` = more please (no Range =
 * nothing stored), 200/201 = done (body = video resource). After a failure, `PUT` empty with
 * `Content-Range: bytes */TOTAL` returns the committed range (or the final resource if it had completed). A session
 * URI that expired answers 404 (start over). Every other 4xx is permanent.
 *
 * Bearer tokens only ever go to the configured upload host (the session URI must be on the same origin).
 */
import fs from 'node:fs/promises';
import type { ShortsFields } from '@shared/publish';
import type { OAuthTokens, PublishMedia } from '../../pipeline/contracts5';
import { PublishError } from '../publish/errors';
import { CHUNK_ALIGN } from './constants';
import { mapApiError, transportError } from './errors';
import {
  TransportError,
  abortError,
  isAbort,
  parseJson,
  retryAfterSec,
  send,
  type HttpCtx,
  type Reply,
} from './http';
import { effectiveDescription } from './validate';
import { z } from 'zod';

export interface UploadTuning {
  /** Multiple of 256 KiB. */
  chunkBytes: number;
  /** Consecutive failures tolerated before giving up. */
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  chunkTimeoutMs: number;
  maxSessionRestarts: number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface InsertedVideo {
  id: string;
  privacyStatus: string | null;
}

const insertedSchema = z.object({
  id: z.string().min(1),
  status: z
    .object({ privacyStatus: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export function alignChunk(bytes: number): number {
  return Math.max(CHUNK_ALIGN, Math.floor(bytes / CHUNK_ALIGN) * CHUNK_ALIGN);
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A failure the loop can recover from by asking the server how much it has. */
class Retryable extends Error {
  constructor(
    readonly asPublishError: PublishError,
    readonly waitMs: number | null = null,
  ) {
    super(asPublishError.message);
  }
}
/** The session URI is gone (404/410): start a new session. */
class SessionGone extends Error {}

const RESUMABLE_5XX = new Set([500, 502, 503, 504]);

type Outcome = { kind: 'done'; video: InsertedVideo } | { kind: 'progress'; offset: number };

export interface UploadArgs {
  ctx: HttpCtx;
  uploadBase: string;
  tokens: OAuthTokens;
  fields: ShortsFields;
  media: PublishMedia;
  tuning: UploadTuning;
  signal?: AbortSignal;
  onProgress(fraction: number | null, message?: string): void;
}

export async function resumableInsert(a: UploadArgs): Promise<InsertedVideo> {
  const { ctx, tuning, signal } = a;
  const secrets = [a.tokens.accessToken, a.tokens.refreshToken ?? ''];
  const auth = { authorization: `Bearer ${a.tokens.accessToken}` };
  const uploadOrigin = new URL(a.uploadBase).origin;

  const stat = await fs.stat(a.media.file).catch(() => null);
  if (!stat || !stat.isFile())
    throw new PublishError('media', 'The video file to upload could not be found on disk.', {
      retryable: false,
    });
  const total = stat.size;
  if (total <= 0)
    throw new PublishError('media', 'The video file is empty.', { retryable: false });
  if (total !== a.media.sizeBytes)
    ctx.log(`youtube: file size on disk (${total}) differs from the probe (${a.media.sizeBytes}); using the disk size`);

  const metadata = {
    snippet: {
      title: a.fields.title.trim(),
      description: effectiveDescription(a.fields),
      tags: a.fields.tags,
      categoryId: a.fields.categoryId,
    },
    status: {
      privacyStatus: a.fields.visibility,
      selfDeclaredMadeForKids: a.fields.madeForKids,
    },
  };

  const fh = await fs.open(a.media.file, 'r');
  try {
    const backoff = (n: number, hint: number | null): number =>
      Math.max(hint ?? 0, Math.min(tuning.retryMaxMs, tuning.retryBaseMs * 2 ** Math.max(0, n - 1)));

    /** Classifies a non-success reply of the upload host. */
    const classify = (reply: Reply): Retryable | SessionGone | PublishError => {
      if (reply.status === 404 || reply.status === 410) return new SessionGone();
      if (RESUMABLE_5XX.has(reply.status)) {
        const ra = retryAfterSec(reply.headers, ctx.now());
        return new Retryable(
          new PublishError('platform', `YouTube is having trouble (HTTP ${reply.status}).`, {
            retryable: true,
          }),
          ra !== null ? Math.min(ra, 60) * 1000 : null,
        );
      }
      return mapApiError(reply, { now: ctx.now(), secrets });
    };

    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof TransportError) throw new Retryable(transportError(e));
        throw e;
      }
    };

    /* ---- 1. session ---- */
    const startSession = async (): Promise<string> => {
      let failures = 0;
      for (;;) {
        try {
          const reply = await guard(() =>
            send(
              ctx,
              `${a.uploadBase}/videos?${new URLSearchParams({
                uploadType: 'resumable',
                part: 'snippet,status',
                notifySubscribers: String(a.fields.notifySubscribers),
              }).toString()}`,
              {
                method: 'POST',
                headers: {
                  ...auth,
                  'content-type': 'application/json; charset=UTF-8',
                  'x-upload-content-length': String(total),
                  'x-upload-content-type': a.media.contentType,
                },
                body: JSON.stringify(metadata),
                signal,
              },
            ),
          );
          if (reply.status === 200) {
            const loc = reply.headers.get('location');
            if (!loc)
              throw new PublishError('platform', 'YouTube did not return an upload address.', {
                retryable: true,
              });
            const session = new URL(loc, a.uploadBase);
            if (session.origin !== uploadOrigin)
              throw new PublishError('platform', 'YouTube returned an unexpected upload address.', {
                retryable: false,
              });
            return session.toString();
          }
          const c = classify(reply);
          if (c instanceof SessionGone)
            throw new PublishError('platform', 'YouTube could not start the upload (HTTP 404).', {
              retryable: false,
            });
          throw c;
        } catch (e) {
          if (!(e instanceof Retryable)) throw e;
          failures++;
          if (failures > tuning.maxRetries) throw e.asPublishError;
          ctx.log(`youtube: upload session start failed (attempt ${failures}); retrying`);
          await tuning.sleep(backoff(failures, e.waitMs), signal);
        }
      }
    };

    /* ---- 2. requests on the session ---- */
    const parseDone = (reply: Reply): InsertedVideo => {
      const r = insertedSchema.safeParse(parseJson(reply.text));
      if (!r.success)
        // The bytes are on YouTube: do not let the scheduler retry blindly and create a duplicate.
        throw new PublishError(
          'platform',
          'The upload finished but YouTube sent no video id. Check YouTube Studio before retrying.',
          { retryable: false },
        );
      return { id: r.data.id, privacyStatus: r.data.status?.privacyStatus ?? null };
    };

    const parseRange = (reply: Reply): number => {
      const range = reply.headers.get('range');
      if (!range) return 0;
      const m = /bytes=0-(\d+)/i.exec(range);
      return m ? Number(m[1]) + 1 : 0;
    };

    const outcome = (reply: Reply): Outcome => {
      if (reply.status === 200 || reply.status === 201)
        return { kind: 'done', video: parseDone(reply) };
      if (reply.status === 308) return { kind: 'progress', offset: parseRange(reply) };
      const c = classify(reply);
      throw c;
    };

    const readChunk = async (offset: number, length: number): Promise<Buffer> => {
      const buf = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await fh.read(buf, got, length - got, offset + got);
        if (bytesRead === 0)
          throw new PublishError('media', 'The video file changed while it was being uploaded.', {
            retryable: false,
          });
        got += bytesRead;
      }
      return buf;
    };

    const putChunk = async (session: string, offset: number): Promise<Outcome> => {
      const end = Math.min(total, offset + tuning.chunkBytes);
      const body = await readChunk(offset, end - offset);
      const reply = await guard(() =>
        send(ctx, session, {
          method: 'PUT',
          headers: {
            ...auth,
            'content-type': a.media.contentType,
            'content-range': `bytes ${offset}-${end - 1}/${total}`,
          },
          body,
          timeoutMs: tuning.chunkTimeoutMs,
          signal,
        }),
      );
      return outcome(reply);
    };

    const queryStatus = async (session: string): Promise<Outcome> => {
      const reply = await guard(() =>
        send(ctx, session, {
          method: 'PUT',
          headers: { ...auth, 'content-range': `bytes */${total}`, 'content-length': '0' },
          body: new Uint8Array(0),
          signal,
        }),
      );
      return outcome(reply);
    };

    /* ---- 3. the loop ---- */
    a.onProgress(0, 'Starting the YouTube upload');
    let session = await startSession();
    let offset = 0;
    let needSync = false;
    let failures = 0;
    let restarts = 0;
    let reported = 0;

    for (;;) {
      if (signal?.aborted) throw abortError();
      try {
        const sentChunk = !needSync;
        const out = needSync ? await queryStatus(session) : await putChunk(session, offset);
        if (out.kind === 'done') {
          a.onProgress(1, 'Uploaded; YouTube is processing the video');
          return out.video;
        }
        if (out.offset > total)
          throw new PublishError('platform', 'YouTube reported more bytes than were sent.', {
            retryable: true,
          });
        const progressed = out.offset > offset;
        if (out.offset < offset)
          ctx.log(`youtube: server holds ${out.offset} bytes, fewer than the ${offset} sent; re-sending`);
        offset = out.offset;
        needSync = false;
        if (progressed) failures = 0;
        else if (sentChunk) {
          failures++;
          if (failures > tuning.maxRetries)
            throw new PublishError('platform', 'YouTube stopped accepting the upload data.', {
              retryable: true,
            });
          await tuning.sleep(backoff(failures, null), signal);
        }
        const frac = Math.min(0.99, offset / total);
        if (frac > reported) {
          reported = frac;
          a.onProgress(frac, `Uploading ${Math.floor(frac * 100)} %`);
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e instanceof Retryable) {
          failures++;
          if (failures > tuning.maxRetries) throw e.asPublishError;
          ctx.log(`youtube: upload interrupted (attempt ${failures}); asking YouTube where to resume`);
          needSync = true;
          await tuning.sleep(backoff(failures, e.waitMs), signal);
          continue;
        }
        if (e instanceof SessionGone) {
          restarts++;
          if (restarts > tuning.maxSessionRestarts)
            throw new PublishError('platform', 'The YouTube upload session expired.', {
              retryable: true,
            });
          ctx.log('youtube: upload session expired; starting a new one');
          session = await startSession();
          offset = 0;
          needSync = false;
          failures = 0;
          continue;
        }
        throw e;
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
}
