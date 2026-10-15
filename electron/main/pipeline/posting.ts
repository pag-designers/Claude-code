import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { ClipMeta } from '@shared/cp2';
import { keysEditor } from '@shared/editor';
import { keys as clipKeys } from '@shared/pipeline';
import type { BrandKit } from '@shared/brand';
import {
  defaultFieldsFrom,
  EDITABLE_POST_STATUSES,
  PLATFORM_PROVIDER,
  platformSetupSchema,
  postErrorSchema,
  postFieldsSchema,
  postMediaInfoSchema,
  postStatsSchema,
  postTitleOf,
  type FieldIssue,
  type MediaReport,
  type Platform,
  type PlatformSetup,
  type PostDraft,
  type PostError,
  type PostFields,
  type PostMediaInfo,
  type PostSource,
  type PostStatus,
  type PostView,
  type QuotaInfo,
  type SocialAccount,
} from '@shared/publish';
import { nextOccurrence, planSchedule } from '@shared/scheduling';
import type { SecretKey } from '@shared/secrets';
import type { Settings } from '@shared/settings';
import type { AppNotification } from '@shared/domain';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import { isPublishError, PublishError } from '../services/publish/errors';
import { OAuthFlowError, type OAuthLoopback } from '../services/publish/oauth';
import { decideRetry } from '../services/publish/retry';
import type { TokenStore } from '../services/publish/token-store';
import type { JobQueue } from '../services/queue';
import type { StorageProvider } from '../services/storage/provider';
import type {
  OAuthTokens,
  ProviderAccount,
  PublisherProvider,
  PublishMediaService,
} from './contracts5';
import type { BrandService } from './brand';
import { parseJson } from './views';

export const JOB_PUBLISH = 'posts.publish';

/**
 * Refresh tokens that expire within this window before using them. Instagram's long-lived tokens last 60 days and can
 * only be refreshed after 24 h, so they are renewed a week ahead (the provider returns a too-young token unchanged).
 */
const REFRESH_SKEW_MS: Record<Platform, number> = {
  shorts: 3 * 60_000,
  tiktok: 5 * 60_000,
  reels: 7 * 24 * 3_600_000,
};
const MAX_ATTEMPTS = 4;

/** Platform-side quota day: YouTube resets at midnight Pacific; the others are metered on a rolling/UTC basis. */
export function quotaDay(platform: Platform, at: number): string {
  const tz = platform === 'shorts' ? 'America/Los_Angeles' : 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

type PostRow = Awaited<ReturnType<Db['post']['findFirstOrThrow']>>;
type AccountRow = Awaited<ReturnType<Db['socialAccount']['findFirstOrThrow']>>;

export interface PostingDeps {
  db: Db;
  queue: JobQueue;
  brand: Pick<BrandService, 'getKit' | 'defaultKitId'>;
  providers: Record<Platform, PublisherProvider>;
  tokens: TokenStore;
  oauth: OAuthLoopback;
  media: PublishMediaService;
  getSettings(): Promise<Settings>;
  hasSecret(key: SecretKey): boolean;
  getStorage(): StorageProvider | null;
  cacheDir: string;
  ffmpegPath(): string;
  notify(n: {
    kind: AppNotification['kind'];
    level: AppNotification['level'];
    title: string;
    body?: string | null;
    href?: string | null;
    os?: boolean;
  }): Promise<unknown>;
  emit: { post(p: PostView): void; accountsChanged(platform: Platform | null): void };
  now?: () => number;
  timeZone?: () => string;
  log: (m: string) => void;
}

const SECRETS_OF: Record<'youtube' | 'instagram' | 'tiktok', [SecretKey, SecretKey]> = {
  youtube: ['google.clientId', 'google.clientSecret'],
  instagram: ['meta.appId', 'meta.appSecret'],
  tiktok: ['tiktok.clientKey', 'tiktok.clientSecret'],
};

const PLATFORM_LABEL: Record<Platform, string> = {
  shorts: 'YouTube Shorts',
  reels: 'Instagram Reels',
  tiktok: 'TikTok',
};

/** Local fallbacks for the quota meter when the platform cannot be asked. */
const LOCAL_QUOTA: Record<Platform, { limit: number; unit: 'units' | 'posts' }> = {
  shorts: { limit: 10_000, unit: 'units' },
  reels: { limit: 100, unit: 'posts' },
  tiktok: { limit: 15, unit: 'posts' },
};

/** Accounts, posts and the publish job (BRIEF §9). The scheduler loop (scheduler.ts) only decides WHEN to dispatch. */
export class PostingService {
  private readonly progress = new Map<string, { fraction: number | null; message: string | null }>();
  private readonly quotaCache = new Map<string, { at: number; q: QuotaInfo }>();

  constructor(private readonly d: PostingDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private tz(): string {
    return this.d.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /* ------------------------------------------------------------------------------ accounts ---- */

  private accountOf(r: AccountRow): SocialAccount {
    return {
      id: r.id,
      platform: r.platform as Platform,
      externalId: r.externalId,
      displayName: r.displayName,
      handle: r.handle,
      avatarUrl: r.avatarUrl,
      status: r.status as SocialAccount['status'],
      statusMessage: r.statusMessage,
      scopes: parseJson<string[]>(r.scopes, []),
      info: parseJson<SocialAccount['info']>(r.info, {}),
      connectedAt: r.connectedAt.getTime(),
    };
  }

  setup(): PlatformSetup[] {
    return (['shorts', 'reels', 'tiktok'] as const).map((platform) => {
      const [id, secret] = SECRETS_OF[PLATFORM_PROVIDER[platform]];
      return platformSetupSchema.parse({
        platform,
        configured: this.d.hasSecret(id) && this.d.hasSecret(secret),
        redirectUri: this.d.oauth.redirectUri(platform),
      });
    });
  }

  async listAccounts(): Promise<{ accounts: SocialAccount[]; setup: PlatformSetup[] }> {
    const rows = await this.d.db.socialAccount.findMany({ orderBy: { connectedAt: 'asc' } });
    return { accounts: rows.map((r) => this.accountOf(r)), setup: this.setup() };
  }

  private async mustAccountRow(id: string): Promise<AccountRow> {
    const r = await this.d.db.socialAccount.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', 'That account is no longer connected.');
    return r;
  }

  private providerAccountOf(r: AccountRow): ProviderAccount {
    return {
      externalId: r.externalId,
      displayName: r.displayName,
      handle: r.handle,
      avatarUrl: r.avatarUrl,
      scopes: parseJson<string[]>(r.scopes, []),
      info: parseJson<ProviderAccount['info']>(r.info, {}),
    };
  }

  async connect(platform: Platform): Promise<SocialAccount> {
    const setup = this.setup().find((s) => s.platform === platform);
    if (!setup?.configured)
      throw new AppError(
        'UNAVAILABLE',
        `Save your ${PLATFORM_LABEL[platform]} developer-app credentials in Settings → Integrations first.`,
      );
    const provider = this.d.providers[platform];
    let granted;
    try {
      granted = await this.d.oauth.authorize(platform, (a) => provider.authUrl(a));
    } catch (e) {
      if (e instanceof OAuthFlowError)
        throw new AppError(e.kind === 'canceled' ? 'CANCELED' : 'FAILED', e.message);
      throw e;
    }
    let exchanged;
    try {
      exchanged = await provider.exchangeCode({
        code: granted.code,
        redirectUri: granted.redirectUri,
        codeVerifier: granted.codeVerifier,
      });
    } catch (e) {
      throw new AppError('FAILED', this.errorText(e));
    }
    const { tokens, account } = exchanged;
    const data = {
      displayName: account.displayName,
      handle: account.handle,
      avatarUrl: account.avatarUrl,
      status: 'connected',
      statusMessage: null,
      scopes: JSON.stringify(account.scopes),
      info: JSON.stringify(account.info),
    };
    const row = await this.d.db.socialAccount.upsert({
      where: { platform_externalId: { platform, externalId: account.externalId } },
      create: { platform, externalId: account.externalId, ...data },
      update: data,
    });
    this.d.tokens.set(row.id, tokens);
    // Posts that were parked while this account was disconnected stay drafts; nothing to restore automatically.
    this.d.emit.accountsChanged(platform);
    this.d.log(`account connected: ${platform} (${row.id})`);
    return this.accountOf(row);
  }

  cancelConnect(platform: Platform): void {
    this.d.oauth.cancel(platform);
  }

  async disconnect(id: string): Promise<void> {
    const row = await this.mustAccountRow(id);
    const platform = row.platform as Platform;
    const tokens = this.d.tokens.get(id);
    if (tokens) {
      try {
        await this.d.providers[platform].revoke(tokens);
      } catch (e) {
        this.d.log(`revoke failed for ${id}: ${this.errorText(e)}`); // best effort
      }
    }
    // Pending posts become drafts (they can be moved to another account); finished ones keep their history.
    await this.d.db.post.updateMany({
      where: { accountId: id, status: { in: ['scheduled', 'queued'] } },
      data: {
        status: 'draft',
        scheduledAt: null,
        nextAttemptAt: null,
        error: JSON.stringify(
          this.errorOf(
            'auth',
            `The ${PLATFORM_LABEL[platform]} account was disconnected.`,
            false,
            'Connect an account again and re-schedule this post.',
          ),
        ),
      },
    });
    this.d.tokens.delete(id);
    await this.d.db.quotaUsage.deleteMany({ where: { accountId: id } });
    this.quotaCache.delete(id);
    await this.d.db.socialAccount.delete({ where: { id } });
    this.d.emit.accountsChanged(platform);
  }

  async testAccount(id: string): Promise<{
    ok: boolean;
    message: string;
    detail: string | null;
    account: SocialAccount | null;
  }> {
    const row = await this.mustAccountRow(id);
    const platform = row.platform as Platform;
    const provider = this.d.providers[platform];
    try {
      const tokens = await this.freshTokens(row);
      const res = await provider.testConnection(tokens);
      if (res.ok) {
        const updated = await this.d.db.socialAccount.update({
          where: { id },
          data: {
            status: 'connected',
            statusMessage: null,
            ...(res.account
              ? {
                  displayName: res.account.displayName,
                  handle: res.account.handle,
                  avatarUrl: res.account.avatarUrl,
                  info: JSON.stringify(res.account.info),
                }
              : {}),
          },
        });
        this.d.emit.accountsChanged(platform);
        return { ...res, account: this.accountOf(updated) };
      }
      return { ...res, account: this.accountOf(row) };
    } catch (e) {
      const text = this.errorText(e);
      if (isPublishError(e) && e.code === 'auth') await this.markNeedsReauth(row, text);
      return { ok: false, message: text, detail: null, account: null };
    }
  }

  private async markNeedsReauth(row: AccountRow, message: string): Promise<void> {
    await this.d.db.socialAccount.update({
      where: { id: row.id },
      data: { status: 'needs-reauth', statusMessage: message },
    });
    this.d.emit.accountsChanged(row.platform as Platform);
  }

  /** The stored tokens, refreshed first when they are about to expire. Throws PublishError('auth') when there are none. */
  private async freshTokens(row: AccountRow, signal?: AbortSignal): Promise<OAuthTokens> {
    const platform = row.platform as Platform;
    let tokens = this.d.tokens.get(row.id);
    if (!tokens)
      throw new PublishError('auth', `${PLATFORM_LABEL[platform]} needs to be connected again.`, {
        retryable: false,
        hint: 'Settings → Integrations → Connect.',
      });
    if (tokens.expiresAt !== null && tokens.expiresAt - this.now() < REFRESH_SKEW_MS[platform]) {
      tokens = await this.d.providers[platform].refresh(tokens, { signal });
      this.d.tokens.set(row.id, tokens);
      this.d.log(`token refreshed: ${platform} (${row.id})`);
    }
    return tokens;
  }

  /* ------------------------------------------------------------------------------- sources ---- */

  private async resolveSource(source: PostSource): Promise<{
    key: string;
    title: string;
    clipId: string | null;
    exportId: string | null;
    meta: ClipMeta | null;
    brandKitId: string | null;
    thumbKey: string | null;
  }> {
    if ('clipId' in source) {
      const clip = await this.d.db.clip.findUnique({ where: { id: source.clipId } });
      if (!clip) throw new AppError('NOT_FOUND', 'That clip no longer exists.');
      if (clip.status !== 'rendered')
        throw new AppError('CONFLICT', 'That clip has not finished rendering yet.');
      const md = parseJson<{ meta?: ClipMeta | null }>(clip.metadata, {});
      return {
        key: clipKeys.clip(clip.id),
        title: clip.title,
        clipId: clip.id,
        exportId: null,
        meta: md.meta ?? null,
        brandKitId: clip.brandKitId,
        thumbKey: clipKeys.thumb(clip.id),
      };
    }
    const ex = await this.d.db.editorExport.findUnique({ where: { id: source.exportId } });
    if (!ex) throw new AppError('NOT_FOUND', 'That export no longer exists.');
    if (ex.status !== 'done')
      throw new AppError('CONFLICT', 'That export has not finished yet.');
    const k = parseJson<Record<string, string>>(ex.storageKeys, {});
    return {
      key: k.video ?? keysEditor.exportFile(ex.id),
      title: ex.name,
      clipId: null,
      exportId: ex.id,
      meta: null,
      brandKitId: null,
      thumbKey: k.thumb ?? null,
    };
  }

  private requireStorage(): StorageProvider {
    const s = this.d.getStorage();
    if (!s)
      throw new AppError(
        'UNAVAILABLE',
        'Object storage is not connected. Check Settings → Storage.',
      );
    return s;
  }

  /** Downloads (once; cached by key + size) a storage object into the cache dir and returns the local path. */
  private async localCopy(key: string, signal?: AbortSignal): Promise<string> {
    const storage = this.requireStorage();
    const head = await storage.head(key);
    if (!head) throw new PublishError('media', 'The video file is missing from storage.', { retryable: false });
    const dir = path.join(this.d.cacheDir, 'publish');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${crypto.createHash('sha1').update(`${key}:${head.size}`).digest('hex')}.mp4`,
    );
    if (fs.existsSync(file) && fs.statSync(file).size === head.size) return file;
    const tmp = `${file}.${process.pid}.part`;
    try {
      const body = await storage.getStream(key);
      await streamPipeline(body, fs.createWriteStream(tmp), { signal });
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return file;
  }

  /** Removes cached publish copies older than a day. */
  sweepCache(): void {
    const dir = path.join(this.d.cacheDir, 'publish');
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (this.now() - fs.statSync(p).mtimeMs > 24 * 3_600_000) fs.rmSync(p, { force: true });
      }
    } catch {
      /* no cache dir yet */
    }
  }

  /* ------------------------------------------------------------------------ prefill / validate ---- */

  private async kitFor(kitId: string | null): Promise<BrandKit | null> {
    try {
      if (kitId === 'none') return null;
      const id = kitId ?? (await this.d.brand.defaultKitId());
      return id ? await this.d.brand.getKit(id) : null;
    } catch {
      return null;
    }
  }

  async prefill(source: PostSource, platform: Platform) {
    const src = await this.resolveSource(source);
    const kit = await this.kitFor(src.brandKitId);
    const sets = kit?.spec.defaults.hashtagSets ?? [];
    const meta = src.meta?.[platform] ?? null;
    // Brand Kit hashtag sets are suggestions: the first set is pre-applied only when the clip has no hashtags of its own.
    const fields = defaultFieldsFrom(platform, meta, src.title, {
      hashtagSet: meta && meta.hashtags.length ? [] : (sets[0]?.tags ?? []),
    });
    const windows = (kit?.spec.defaults.postingWindows ?? []).filter(
      (w) => w.platform === null || w.platform === platform,
    );
    const from = this.now() + 10 * 60_000;
    let suggestedAt: number | null = null;
    if (windows.length) {
      const plan = planSchedule({
        clips: 1,
        accounts: [{ id: 'x', platform }],
        startAt: from,
        timeZone: this.tz(),
        windows: windows.map((w) => ({
          platform: w.platform,
          days: w.days,
          start: w.start,
          end: w.end,
        })),
        minGapMinutes: 0,
        maxPerDay: 99,
        existing: [],
        jitterMinutes: 0,
        seed: 1,
      });
      suggestedAt = plan.slots[0]?.at ?? null;
    }
    if (suggestedAt === null && meta?.postingTime)
      suggestedAt = nextOccurrence(meta.postingTime, from, this.tz());
    return {
      title: postTitleOf(fields),
      fields,
      suggestedAt,
      hashtagSets: sets.map((s) => ({ id: s.id, name: s.name, tags: s.tags })),
    };
  }

  private fieldIssues(fields: PostFields): FieldIssue[] {
    return this.d.providers[fields.platform].validateFields(fields);
  }

  async validate(args: { source: PostSource; platform: Platform; fields?: PostFields }): Promise<{
    report: MediaReport;
    fieldIssues: FieldIssue[];
  }> {
    const src = await this.resolveSource(args.source);
    const report = await this.mediaReport(src.key, args.platform);
    return { report, fieldIssues: args.fields ? this.fieldIssues(args.fields) : [] };
  }

  private async mediaReport(key: string, platform: Platform): Promise<MediaReport> {
    let file: string;
    try {
      file = await this.localCopy(key);
    } catch (e) {
      if (isPublishError(e)) throw new AppError('NOT_FOUND', e.message);
      throw e;
    }
    const info = await this.d.media.probe(file);
    return this.d.media.validate({ info, platform });
  }

  /* --------------------------------------------------------------------------------- posts ---- */

  private async accountNames(): Promise<Map<string, string>> {
    const rows = await this.d.db.socialAccount.findMany();
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  private async toView(r: PostRow, names?: Map<string, string>): Promise<PostView> {
    const map = names ?? (await this.accountNames());
    const fields = postFieldsSchema.catch(
      defaultFieldsFrom(r.platform as Platform, null, r.title),
    ).parse(parseJson<unknown>(r.fields, {}));
    const err = r.error ? postErrorSchema.safeParse(parseJson<unknown>(r.error, null)) : null;
    const media = r.media ? postMediaInfoSchema.safeParse(parseJson<unknown>(r.media, null)) : null;
    const stats = r.stats ? postStatsSchema.safeParse(parseJson<unknown>(r.stats, null)) : null;
    const result = r.result
      ? parseJson<PostView['result']>(r.result, null)
      : null;
    let thumbUrl: string | null = null;
    const storage = this.d.getStorage();
    if (storage) {
      try {
        const thumbKey = r.clipId
          ? clipKeys.thumb(r.clipId)
          : r.exportId
            ? keysEditor.exportThumb(r.exportId)
            : null;
        if (thumbKey) thumbUrl = await storage.presignGet(thumbKey, 3600);
      } catch {
        thumbUrl = null;
      }
    }
    return {
      id: r.id,
      platform: r.platform as Platform,
      accountId: r.accountId,
      accountName: map.get(r.accountId) ?? 'Disconnected account',
      clipId: r.clipId,
      exportId: r.exportId,
      title: r.title,
      status: r.status as PostStatus,
      scheduledAt: r.scheduledAt ? r.scheduledAt.getTime() : null,
      publishedAt: r.publishedAt ? r.publishedAt.getTime() : null,
      nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.getTime() : null,
      attempts: r.attempts,
      fields,
      media: media?.success ? media.data : null,
      autoFixed: !!r.fixedMediaKey,
      autoFix: r.autoFix,
      error: err?.success ? err.data : null,
      result,
      stats: stats?.success ? stats.data : null,
      groupId: r.groupId,
      thumbUrl,
      createdAt: r.createdAt.getTime(),
    };
  }

  private async emitPost(id: string): Promise<PostView> {
    const r = await this.mustPost(id);
    const v = await this.toView(r);
    this.d.emit.post(v);
    return v;
  }

  private async mustPost(id: string): Promise<PostRow> {
    const r = await this.d.db.post.findUnique({ where: { id } });
    if (!r) throw new AppError('NOT_FOUND', 'That post no longer exists.');
    return r;
  }

  async create(items: PostDraft[]) {
    const posts: PostView[] = [];
    const refused: {
      index: number;
      reason: string;
      report: MediaReport | null;
      fieldIssues: FieldIssue[];
    }[] = [];
    for (const [index, item] of items.entries()) {
      try {
        const account = await this.d.db.socialAccount.findUnique({ where: { id: item.accountId } });
        if (!account) {
          refused.push({ index, reason: 'That account is no longer connected.', report: null, fieldIssues: [] });
          continue;
        }
        if (account.platform !== item.fields.platform) {
          refused.push({
            index,
            reason: `These fields are for ${PLATFORM_LABEL[item.fields.platform]}, but the account is ${PLATFORM_LABEL[account.platform as Platform]}.`,
            report: null,
            fieldIssues: [],
          });
          continue;
        }
        const issues = this.fieldIssues(item.fields);
        if (issues.length) {
          refused.push({
            index,
            reason: issues.map((i) => i.message).join(' '),
            report: null,
            fieldIssues: issues,
          });
          continue;
        }
        const src = await this.resolveSource(item.source);
        const report = await this.mediaReport(src.key, item.fields.platform);
        const blocking = report.issues.filter((i) => i.severity === 'error');
        const fixable = blocking.every((i) => i.fixable);
        if (blocking.length && !(item.autoFix && fixable)) {
          refused.push({
            index,
            reason: blocking.map((i) => i.message).join(' '),
            report,
            fieldIssues: [],
          });
          continue;
        }
        const now = this.now();
        const groupId = item.groupId ?? null;
        const row = await this.d.db.post.create({
          data: {
            accountId: account.id,
            platform: account.platform,
            clipId: src.clipId,
            exportId: src.exportId,
            title: postTitleOf(item.fields),
            status: item.scheduledAt === null ? 'queued' : 'scheduled',
            scheduledAt: new Date(item.scheduledAt ?? now),
            fields: JSON.stringify(item.fields),
            media: JSON.stringify(report.media),
            mediaKey: src.key,
            autoFix: item.autoFix,
            groupId,
          },
        });
        if (item.scheduledAt === null) await this.enqueue(row.id);
        posts.push(await this.emitPost(row.id));
      } catch (e) {
        refused.push({ index, reason: this.errorText(e), report: null, fieldIssues: [] });
      }
    }
    return { posts, refused };
  }

  async list(q: {
    from?: number;
    to?: number;
    statuses?: PostStatus[];
    accountId?: string;
    clipId?: string;
    limit: number;
  }): Promise<{ items: PostView[] }> {
    const where: Record<string, unknown> = {};
    if (q.statuses?.length) where.status = { in: q.statuses };
    if (q.accountId) where.accountId = q.accountId;
    if (q.clipId) where.clipId = q.clipId;
    if (q.from !== undefined || q.to !== undefined) {
      // a post belongs to the window by its scheduled time, else by its publish / creation time
      where.OR = [
        {
          scheduledAt: {
            ...(q.from !== undefined ? { gte: new Date(q.from) } : {}),
            ...(q.to !== undefined ? { lte: new Date(q.to) } : {}),
          },
        },
        {
          scheduledAt: null,
          createdAt: {
            ...(q.from !== undefined ? { gte: new Date(q.from) } : {}),
            ...(q.to !== undefined ? { lte: new Date(q.to) } : {}),
          },
        },
      ];
    }
    const rows = await this.d.db.post.findMany({
      where,
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: q.limit,
    });
    const names = await this.accountNames();
    return { items: await Promise.all(rows.map((r) => this.toView(r, names))) };
  }

  async get(id: string): Promise<PostView> {
    return this.toView(await this.mustPost(id));
  }

  async update(args: {
    id: string;
    fields?: PostFields;
    scheduledAt?: number | null;
    autoFix?: boolean;
  }): Promise<PostView> {
    const row = await this.mustPost(args.id);
    if (!EDITABLE_POST_STATUSES.includes(row.status as PostStatus))
      throw new AppError('CONFLICT', `A ${row.status} post can no longer be edited.`);
    const data: Record<string, unknown> = {};
    let fields: PostFields | null = null;
    if (args.fields) {
      if (args.fields.platform !== row.platform)
        throw new AppError('INVALID', 'The fields do not match the post platform.');
      const issues = this.fieldIssues(args.fields);
      if (issues.length) throw new AppError('INVALID', issues.map((i) => i.message).join(' '));
      fields = args.fields;
      data.fields = JSON.stringify(fields);
      data.title = postTitleOf(fields);
    }
    if (args.autoFix !== undefined) data.autoFix = args.autoFix;
    if (args.scheduledAt !== undefined) {
      if (args.scheduledAt === null) {
        data.status = 'draft';
        data.scheduledAt = null;
      } else {
        data.status = 'scheduled';
        data.scheduledAt = new Date(args.scheduledAt);
      }
      data.nextAttemptAt = null;
    } else if (row.status === 'failed' || row.status === 'missed') {
      // Editing the fields of a failed/missed post leaves it as is; the user chooses Retry or a new time.
    }
    await this.d.db.post.update({ where: { id: row.id }, data });
    return this.emitPost(row.id);
  }

  async postNow(id: string): Promise<PostView> {
    const row = await this.mustPost(id);
    if (!EDITABLE_POST_STATUSES.includes(row.status as PostStatus) && row.status !== 'scheduled')
      throw new AppError('CONFLICT', `A ${row.status} post cannot be posted now.`);
    await this.d.db.post.update({
      where: { id },
      data: { status: 'queued', scheduledAt: new Date(this.now()), nextAttemptAt: null, attempts: 0, error: null },
    });
    await this.enqueue(id);
    return this.emitPost(id);
  }

  async cancel(id: string): Promise<PostView> {
    const row = await this.mustPost(id);
    if (row.status === 'publishing')
      throw new AppError('CONFLICT', 'This post is uploading right now and cannot be canceled.');
    if (row.status === 'published' || row.status === 'canceled')
      throw new AppError('CONFLICT', `This post is already ${row.status}.`);
    await this.d.db.post.update({
      where: { id },
      data: { status: 'canceled', nextAttemptAt: null },
    });
    return this.emitPost(id);
  }

  async retry(id: string): Promise<PostView> {
    const row = await this.mustPost(id);
    if (row.status !== 'failed' && row.status !== 'missed')
      throw new AppError('CONFLICT', 'Only failed or missed posts can be retried.');
    return this.postNow(id);
  }

  async delete(ids: string[]): Promise<void> {
    const rows = await this.d.db.post.findMany({ where: { id: { in: ids } } });
    if (rows.some((r) => r.status === 'publishing'))
      throw new AppError('CONFLICT', 'A post that is uploading right now cannot be deleted.');
    const storage = this.d.getStorage();
    const fixed = rows.flatMap((r) => (r.fixedMediaKey ? [r.fixedMediaKey] : []));
    await this.d.db.post.deleteMany({ where: { id: { in: ids } } });
    if (storage && fixed.length) await storage.delete(fixed).catch(() => {});
  }

  async refreshStats(ids: string[]): Promise<{ items: PostView[] }> {
    const out: PostView[] = [];
    for (const id of ids) {
      const row = await this.d.db.post.findUnique({ where: { id } });
      if (!row || row.status !== 'published' || !row.result) continue;
      const result = parseJson<{ platformPostId?: string }>(row.result, {});
      const acc = await this.d.db.socialAccount.findUnique({ where: { id: row.accountId } });
      const provider = this.d.providers[row.platform as Platform];
      if (!acc || !result.platformPostId || !provider.fetchStats) {
        out.push(await this.toView(row));
        continue;
      }
      try {
        const tokens = await this.freshTokens(acc);
        const stats = await provider.fetchStats({
          tokens,
          account: this.providerAccountOf(acc),
          platformPostId: result.platformPostId,
        });
        if (stats)
          await this.d.db.post.update({ where: { id }, data: { stats: JSON.stringify(stats) } });
      } catch (e) {
        this.d.log(`stats failed for ${id}: ${this.errorText(e)}`);
        if (isPublishError(e) && e.code === 'auth') await this.markNeedsReauth(acc, e.message);
      }
      out.push(await this.emitPost(id));
    }
    return { items: out };
  }

  /* ------------------------------------------------------------------------------ dispatch ---- */

  /** Marks a post `queued` and puts the publish job on the durable queue. */
  async enqueue(postId: string): Promise<void> {
    await this.d.db.post.updateMany({
      where: { id: postId, status: { in: ['scheduled', 'draft', 'failed', 'missed', 'queued'] } },
      data: { status: 'queued' },
    });
    await this.d.queue.enqueue({
      kind: JOB_PUBLISH,
      payload: { postId },
      groupKey: `post:${postId}`,
      maxAttempts: 1,
      priority: 5,
    });
  }

  /** Called by the scheduler for posts that are due: queue them, or mark them missed when too late. */
  async dispatchDue(args: { graceMs: number; limit?: number }): Promise<{
    queued: string[];
    missed: string[];
  }> {
    const now = this.now();
    const due = await this.d.db.post.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: new Date(now) },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }],
      },
      orderBy: { scheduledAt: 'asc' },
      take: args.limit ?? 50,
    });
    const queued: string[] = [];
    const missed: string[] = [];
    for (const p of due) {
      const due0 = p.nextAttemptAt ?? p.scheduledAt;
      const late = due0 ? now - due0.getTime() : 0;
      // A retry already had its chance within the grace window; only first attempts can be "missed".
      if (p.attempts === 0 && late > args.graceMs) {
        await this.d.db.post.update({
          where: { id: p.id },
          data: {
            status: 'missed',
            error: JSON.stringify(
              this.errorOf(
                'unknown',
                'Clipfern was not running at the scheduled time.',
                false,
                'Reschedule it or post it now.',
              ),
            ),
          },
        });
        missed.push(p.id);
        await this.emitPost(p.id);
        continue;
      }
      await this.enqueue(p.id);
      queued.push(p.id);
      await this.emitPost(p.id);
    }
    return { queued, missed };
  }

  async counts(): Promise<{ upcoming: number; nextAt: number | null; publishing: number }> {
    const [upcoming, publishing, next] = await Promise.all([
      this.d.db.post.count({ where: { status: { in: ['scheduled', 'queued'] } } }),
      this.d.db.post.count({ where: { status: 'publishing' } }),
      this.d.db.post.findFirst({
        where: { status: 'scheduled' },
        orderBy: [{ nextAttemptAt: 'asc' }, { scheduledAt: 'asc' }],
      }),
    ]);
    const nextAt = next ? (next.nextAttemptAt ?? next.scheduledAt)?.getTime() ?? null : null;
    return { upcoming, nextAt, publishing };
  }

  async todaysPosts(from: number, to: number): Promise<PostRow[]> {
    return this.d.db.post.findMany({
      where: { status: 'scheduled', scheduledAt: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /* -------------------------------------------------------------------------------- quota ---- */

  async quotas(): Promise<QuotaInfo[]> {
    const rows = await this.d.db.socialAccount.findMany({ where: { status: 'connected' } });
    const out: QuotaInfo[] = [];
    for (const row of rows) {
      const platform = row.platform as Platform;
      const cached = this.quotaCache.get(row.id);
      if (cached && this.now() - cached.at < 5 * 60_000) {
        out.push(cached.q);
        continue;
      }
      const usage = await this.d.db.quotaUsage.findUnique({
        where: { accountId_day: { accountId: row.id, day: quotaDay(platform, this.now()) } },
      });
      const label = `${PLATFORM_LABEL[platform]} · ${row.displayName}`;
      const local = LOCAL_QUOTA[platform];
      let q: QuotaInfo = {
        accountId: row.id,
        platform,
        label,
        used: local.unit === 'units' ? (usage?.units ?? 0) : (usage?.posts ?? 0),
        limit: local.limit,
        unit: local.unit,
        resetsAt: this.nextResetAfter(platform, this.now()),
        postsLeft: null,
        note: null,
      };
      const tokens = this.d.tokens.get(row.id);
      if (tokens) {
        try {
          const pq = await this.d.providers[platform].quota({
            tokens,
            account: this.providerAccountOf(row),
            usedUnits: usage?.units ?? 0,
            usedPosts: usage?.posts ?? 0,
            now: this.now(),
          });
          q = { ...q, ...pq, accountId: row.id, platform, label };
        } catch (e) {
          this.d.log(`quota lookup failed for ${row.id}: ${this.errorText(e)}`);
        }
      }
      this.quotaCache.set(row.id, { at: this.now(), q });
      out.push(q);
    }
    return out;
  }

  private nextResetAfter(platform: Platform, at: number): number {
    // Next midnight in the platform's quota zone, found by scanning forward (DST-safe, no tz library).
    const day = quotaDay(platform, at);
    let t = at;
    while (quotaDay(platform, t) === day) t += 15 * 60_000;
    return t - (t % (15 * 60_000));
  }

  private async recordUsage(row: AccountRow, units: number): Promise<void> {
    const platform = row.platform as Platform;
    const day = quotaDay(platform, this.now());
    await this.d.db.quotaUsage.upsert({
      where: { accountId_day: { accountId: row.id, day } },
      create: { accountId: row.id, day, units, posts: 1 },
      update: { units: { increment: units }, posts: { increment: 1 } },
    });
    this.quotaCache.delete(row.id);
  }

  /* -------------------------------------------------------------------------- publish job ---- */

  registerJobs(): void {
    this.d.queue.register<{ postId: string }>(
      JOB_PUBLISH,
      async (ctx) => this.runPublish(ctx.payload.postId, ctx.signal),
      { concurrency: 2, maxAttempts: 1 },
    );
  }

  /** Live progress of a publishing post (merged into events as `error`-less views by the scheduler status). */
  progressOf(postId: string) {
    return this.progress.get(postId) ?? null;
  }

  private errorOf(
    code: PostError['code'],
    message: string,
    retryable: boolean,
    hint: string | null = null,
  ): PostError {
    return { code, message, retryable, at: this.now(), hint };
  }

  errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  private async runPublish(postId: string, signal: AbortSignal): Promise<void> {
    const row = await this.d.db.post.findUnique({ where: { id: postId } });
    if (!row) return;
    if (row.status === 'published' || row.status === 'canceled') return;
    const platform = row.platform as Platform;
    const account = await this.d.db.socialAccount.findUnique({ where: { id: row.accountId } });
    if (!account) {
      await this.finishFailed(row, this.errorOf('auth', 'The account is no longer connected.', false));
      return;
    }
    await this.d.db.post.update({
      where: { id: postId },
      data: { status: 'publishing', attempts: { increment: 1 }, nextAttemptAt: null },
    });
    await this.emitPost(postId);
    const attempts = row.attempts + 1;
    const provider = this.d.providers[platform];
    const fields = postFieldsSchema.parse(parseJson<unknown>(row.fields, {}));
    this.progress.set(postId, { fraction: null, message: 'Preparing the video' });

    try {
      const storage = this.requireStorage();
      let mediaKey = row.fixedMediaKey ?? row.mediaKey;
      let file = await this.localCopy(mediaKey, signal);
      let info: PostMediaInfo = await this.d.media.probe(file, { signal });
      let report = this.d.media.validate({ info, platform });
      const blocking = report.issues.filter((i) => i.severity === 'error');
      if (blocking.length) {
        if (!row.autoFix || !blocking.every((i) => i.fixable))
          throw new PublishError(
            'media',
            blocking.map((i) => i.message).join(' '),
            {
              retryable: false,
              hint: blocking.every((i) => i.fixable)
                ? 'Switch on “Fix the video automatically” for this post.'
                : 'Re-render the clip in a different format.',
            },
          );
        this.progress.set(postId, { fraction: null, message: 'Re-encoding to fit the platform rules' });
        const outFile = path.join(this.d.cacheDir, 'publish', `${postId}.fixed.mp4`);
        info = await this.d.media.fix({
          file,
          outFile,
          platform,
          report,
          ffmpegPath: this.d.ffmpegPath(),
          signal,
        });
        mediaKey = `posts/${postId}/media.mp4`;
        await storage.putFile(mediaKey, outFile, { contentType: 'video/mp4' });
        fs.rmSync(outFile, { force: true });
        file = await this.localCopy(mediaKey, signal);
        report = this.d.media.validate({ info, platform });
        await this.d.db.post.update({
          where: { id: postId },
          data: { fixedMediaKey: mediaKey, media: JSON.stringify(info) },
        });
      }

      const tokens = await this.freshTokens(account, signal);
      const providerAccount = this.providerAccountOf(account);
      const cost = provider.quotaCost(fields);

      // Stop before the platform does: a rejected upload can still burn quota (YouTube charges failed inserts too).
      const usage = await this.d.db.quotaUsage.findUnique({
        where: { accountId_day: { accountId: account.id, day: quotaDay(platform, this.now()) } },
      });
      try {
        const q = await provider.quota({
          tokens,
          account: providerAccount,
          usedUnits: usage?.units ?? 0,
          usedPosts: usage?.posts ?? 0,
          now: this.now(),
        });
        const exhausted =
          (q.unit === 'units' && cost > 0 && q.used + cost > q.limit) ||
          (q.unit === 'posts' && q.postsLeft === 0);
        if (exhausted)
          throw new PublishError(
            'quota',
            `${PLATFORM_LABEL[platform]} daily limit reached (${q.used} of ${q.limit} ${q.unit === 'units' ? 'quota units' : 'posts'} used).`,
            {
              retryAfterSec: Math.max(60, Math.ceil((q.resetsAt - this.now()) / 1000)),
              hint: q.note,
            },
          );
      } catch (e) {
        if (isPublishError(e) && e.code === 'quota') throw e;
        this.d.log(`quota pre-check skipped: ${this.errorText(e)}`); // informational only
      }

      this.progress.set(postId, { fraction: 0, message: 'Uploading' });
      const result = await provider.publish({
        tokens,
        account: providerAccount,
        fields,
        media: {
          file,
          sizeBytes: info.sizeBytes,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          contentType: 'video/mp4',
          presignedUrl: (ttl = 3600) => storage.presignGet(mediaKey, ttl),
        },
        signal,
        onProgress: (fraction, message) => {
          this.progress.set(postId, { fraction, message: message ?? null });
        },
        log: (m) => this.d.log(`${platform}: ${m}`),
      });

      await this.recordUsage(account, result.quotaUnits);
      await this.d.db.post.update({
        where: { id: postId },
        data: {
          status: 'published',
          publishedAt: new Date(this.now()),
          error: null,
          nextAttemptAt: null,
          result: JSON.stringify({
            platformPostId: result.platformPostId,
            url: result.url,
            outcome: result.outcome,
            note: result.note,
          }),
        },
      });
      this.progress.delete(postId);
      const v = await this.emitPost(postId);
      await this.d.notify({
        kind: 'post',
        level: 'success',
        title:
          result.outcome === 'draft-uploaded'
            ? `Sent to your ${PLATFORM_LABEL[platform]} drafts`
            : `Published to ${PLATFORM_LABEL[platform]}`,
        body: [v.title, result.note].filter(Boolean).join(' — '),
        href: '/scheduler/',
        os: true,
      });
    } catch (e) {
      this.progress.delete(postId);
      if (signal.aborted) {
        // App quitting / job canceled: leave it queued so it resumes after the restart.
        await this.d.db.post.update({ where: { id: postId }, data: { status: 'queued' } });
        return;
      }
      await this.handleFailure(row, account, attempts, e);
    }
  }

  private async handleFailure(
    row: PostRow,
    account: AccountRow,
    attempts: number,
    e: unknown,
  ): Promise<void> {
    const pe = isPublishError(e)
      ? e
      : new PublishError('unknown', this.errorText(e), { retryable: false });
    this.d.log(`publish failed (${row.platform}, attempt ${attempts}): ${pe.code}: ${pe.message}`);
    const quotaResetsAt =
      pe.code === 'quota' && pe.retryAfterSec ? this.now() + pe.retryAfterSec * 1000 : null;
    const decision = decideRetry({
      error: { code: pe.code, retryable: pe.retryable, retryAfterSec: pe.retryAfterSec },
      attempts,
      maxAttempts: MAX_ATTEMPTS,
      now: this.now(),
      quotaResetsAt,
    });
    if (pe.code === 'auth') await this.markNeedsReauth(account, pe.message);
    const error = this.errorOf(pe.code, pe.message, !decision.giveUp, pe.hint);
    if (!decision.giveUp && decision.retryAt !== null) {
      await this.d.db.post.update({
        where: { id: row.id },
        data: {
          status: 'scheduled',
          nextAttemptAt: new Date(decision.retryAt),
          error: JSON.stringify(error),
        },
      });
      await this.emitPost(row.id);
      return;
    }
    await this.finishFailed(row, error);
  }

  private async finishFailed(row: PostRow, error: PostError): Promise<void> {
    await this.d.db.post.update({
      where: { id: row.id },
      data: { status: 'failed', nextAttemptAt: null, error: JSON.stringify(error) },
    });
    const v = await this.emitPost(row.id);
    await this.d.notify({
      kind: 'post',
      level: 'error',
      title: `Could not post to ${PLATFORM_LABEL[row.platform as Platform]}`,
      body: `${v.title} — ${error.message}${error.hint ? ` ${error.hint}` : ''}`,
      href: '/scheduler/',
      os: true,
    });
  }
}
