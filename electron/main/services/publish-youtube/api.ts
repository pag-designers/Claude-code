/**
 * Read calls of the YouTube Data API v3 (1 quota unit each, general bucket).
 * Docs checked 2026-10-15: https://developers.google.com/youtube/v3/docs/channels/list ,
 * https://developers.google.com/youtube/v3/docs/videos/list . All responses are parsed tolerantly.
 */
import type { PostStats } from '@shared/publish';
import type { OAuthTokens, ProviderAccount } from '../../pipeline/contracts5';
import { PublishError } from '../publish/errors';
import { mapApiError, transportError } from './errors';
import { TransportError, parseJson, send, type HttpCtx } from './http';
import { lenArray, lenNumber, lenString } from '../broll/zod-lenient';
import { z } from 'zod';

const thumbSchema = z.object({ url: lenString });
const channelItemSchema = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      title: lenString,
      customUrl: lenString,
      thumbnails: z.record(z.string(), thumbSchema.catch({ url: undefined })).catch({}),
    })
    .optional()
    .catch(undefined),
  statistics: z
    .object({
      subscriberCount: lenNumber,
      hiddenSubscriberCount: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  status: z
    .object({
      selfDeclaredMadeForKids: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
const channelListSchema = z.object({ items: lenArray(channelItemSchema) });

const videoItemSchema = z.object({
  id: z.string().optional().catch(undefined),
  statistics: z
    .object({ viewCount: lenNumber, likeCount: lenNumber, commentCount: lenNumber })
    .optional()
    .catch(undefined),
});
const videoListSchema = z.object({ items: lenArray(videoItemSchema) });

export async function apiGet(
  ctx: HttpCtx,
  url: string,
  tokens: OAuthTokens,
  signal?: AbortSignal,
): Promise<unknown> {
  const secrets = [tokens.accessToken, tokens.refreshToken ?? ''];
  let reply;
  try {
    reply = await send(ctx, url, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      signal,
    });
  } catch (e) {
    if (e instanceof TransportError) throw transportError(e);
    throw e;
  }
  if (reply.status < 200 || reply.status >= 300)
    throw mapApiError(reply, { now: ctx.now(), secrets });
  const json = parseJson(reply.text);
  if (json === undefined)
    throw new PublishError('platform', 'YouTube sent a response Clipfern could not read.', {
      retryable: true,
    });
  return json;
}

export async function fetchChannel(
  ctx: HttpCtx,
  apiBase: string,
  tokens: OAuthTokens,
  signal?: AbortSignal,
): Promise<ProviderAccount> {
  const q = new URLSearchParams({ part: 'snippet,statistics,status', mine: 'true' });
  const json = await apiGet(ctx, `${apiBase}/channels?${q.toString()}`, tokens, signal);
  const r = channelListSchema.safeParse(json);
  if (!r.success)
    throw new PublishError('platform', 'YouTube sent a channel response Clipfern could not read.', {
      retryable: true,
    });
  const ch = r.data.items[0];
  if (!ch)
    throw new PublishError('auth', 'This Google account has no YouTube channel.', {
      retryable: false,
      hint: 'Create a channel at youtube.com (signed in with the same Google account), then connect again.',
    });
  const thumbs = ch.snippet?.thumbnails ?? {};
  const avatar = thumbs.medium?.url ?? thumbs.default?.url ?? thumbs.high?.url ?? null;
  const custom = ch.snippet?.customUrl?.trim().replace(/^@+/, '') || null;
  const info: ProviderAccount['info'] = {};
  if (ch.statistics?.subscriberCount !== undefined && !ch.statistics.hiddenSubscriberCount)
    info.subscribers = ch.statistics.subscriberCount;
  if (ch.status?.selfDeclaredMadeForKids !== undefined)
    info.madeForKidsDefault = ch.status.selfDeclaredMadeForKids;
  return {
    externalId: ch.id,
    displayName: ch.snippet?.title?.trim() || ch.id,
    handle: custom,
    avatarUrl: avatar,
    scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
    info,
  };
}

export async function fetchVideoStats(
  ctx: HttpCtx,
  apiBase: string,
  tokens: OAuthTokens,
  videoId: string,
  signal?: AbortSignal,
): Promise<PostStats | null> {
  const q = new URLSearchParams({ part: 'statistics', id: videoId });
  const json = await apiGet(ctx, `${apiBase}/videos?${q.toString()}`, tokens, signal);
  const r = videoListSchema.safeParse(json);
  if (!r.success)
    throw new PublishError('platform', 'YouTube sent a statistics response Clipfern could not read.', {
      retryable: true,
    });
  const v = r.data.items.find((i) => i.id === videoId) ?? r.data.items[0];
  if (!v?.statistics) return null; // deleted / private / not yet processed
  return {
    views: v.statistics.viewCount ?? null,
    likes: v.statistics.likeCount ?? null, // absent when the owner hides likes
    comments: v.statistics.commentCount ?? null, // absent when comments are off
    shares: null, // the Data API has no share count
    fetchedAt: ctx.now(),
  };
}
