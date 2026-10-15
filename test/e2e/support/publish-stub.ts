/**
 * TEST-ONLY stand-in for main's CP5 behaviour (accounts, posting, scheduler), layered over the CP1/CP2 stubs WITHOUT
 * editing them: it wraps `stubB.handle` (which the main stub consults for every channel it does not know), exactly like
 * brand-library-stub.ts. Every request and every response still passes the real zod contract: the harness parses the
 * payload and the result against `invokeContract[channel]`, and this file additionally parses everything it builds with
 * the shared schemas (`postViewSchema`, `socialAccountSchema`, ...), so it cannot drift from shared/ipc.ts.
 *
 * Time is injectable: pass `now` (and pair it with Playwright's `page.clock`, see publish-harness.ts) so calendars are
 * deterministic. Publishing progress is driven by the test (`lib.progress`) unless `lib.autoPublishMs` is set.
 */
import { encodeIpcError, invokeContract } from '../../../shared/ipc';
import {
  accountStatusSchema,
  defaultFieldsFrom,
  mediaReportSchema,
  platformSetupSchema,
  postDraftSchema,
  postTitleOf,
  postViewSchema,
  quotaInfoSchema,
  schedulerStatusSchema,
  socialAccountSchema,
  type FieldIssue,
  type MediaIssue,
  type MediaReport,
  type Platform,
  type PostDraft,
  type PostFields,
  type PostSource,
  type PostStatus,
  type PostView,
  type QuotaInfo,
  type SocialAccount,
} from '../../../shared/publish';
import { brandKitSchema, defaultBrandSpec, type PostingWindow } from '../../../shared/brand';
import type { StubState } from './clipfern-stub';
import { stubB } from './cp2-stub-b';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** A fixed "now": Wed 14 Oct 2026, 10:00 local. Pair with `page.clock` so the browser agrees. */
export const FIXED_NOW = new Date(2026, 9, 14, 10, 0, 0, 0).getTime();

const AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#6a4bf2"/><circle cx="20" cy="15" r="7" fill="#fff"/><rect x="8" y="26" width="24" height="14" rx="7" fill="#fff"/></svg>',
  );

export interface PublishLog {
  created: PostDraft[];
  updates: { id: string; fields?: PostFields; scheduledAt?: number | null; autoFix?: boolean }[];
  postNow: string[];
  cancels: string[];
  retries: string[];
  deletes: string[][];
  statsRefreshed: string[][];
  connects: Platform[];
  cancelConnects: Platform[];
  tests: string[];
  disconnects: string[];
  paused: boolean[];
  validates: { source: PostSource; platform: Platform; fields?: PostFields }[];
  prefills: { source: PostSource; platform: Platform }[];
  digests: number;
}

export interface Refusal {
  reason: string;
  report?: MediaReport | null;
  fieldIssues?: FieldIssue[];
}

export interface PublishLib {
  now: () => number;
  accounts: SocialAccount[];
  setup: { platform: Platform; configured: boolean; redirectUri: string }[];
  posts: PostView[];
  quota: QuotaInfo[];
  scheduler: {
    paused: boolean;
    active: boolean;
    trayMode: boolean;
    trayAvailable: boolean;
    catchUp: { pending: number; lastRunAt: number | null };
  };
  log: PublishLog;
  /** Source titles (clips come from the CP1 state; exports are named here). */
  exportTitles: Record<string, string>;
  /** Suggested time returned by publish:prefill (null = none). */
  suggestedAt: number | null;
  /** Brand Kit posting windows served through brand:defaultKit / brand:get (null = leave those channels alone). */
  windows: PostingWindow[] | null;
  /** Media issues to report for `${sourceKey}|${platform}` (default: a clean 42 s 1080x1920 file). */
  mediaIssues: Record<string, MediaIssue[]>;
  /** Extra field issues (return a list for a given platform/fields). */
  fieldIssues: (platform: Platform, fields: PostFields | undefined) => FieldIssue[];
  /** Make posts:create refuse an item (index in the request). */
  refuse: (item: PostDraft, index: number) => Refusal | null;
  /** Failures for the next calls: `failNext['posts:update'] = { message, times }`. */
  failNext: Record<string, { message: string; times: number; code?: 'FAILED' | 'UNAVAILABLE' }>;
  /** accounts:connect: 'instant' adds an account at once, 'hold' waits for `connectOutcome`. */
  connectMode: 'instant' | 'hold';
  /** Settle a held accounts:connect. */
  connectOutcome: (
    platform: Platform,
    result: { ok: true } | { ok: false; message: string },
  ) => Promise<void>;
  /** accounts:test result per account id (default: ok). */
  testResult: Record<string, { ok: boolean; message: string; detail?: string | null }>;
  /** Publish "post now" items by themselves after this many ms (null = the test drives them). */
  autoPublishMs: number | null;
  /** Moves a post to a status (emits posts:updated). */
  progress: (id: string, status: PostStatus, patch?: Partial<PostView>) => Promise<PostView>;
  /** Adds a ready-made post and announces it. */
  addPost: (p: Partial<PostView> & { accountId: string; status: PostStatus }) => Promise<PostView>;
  post: (id: string) => PostView;
  emitStatus: () => Promise<void>;
  emitAccounts: (platform: Platform | null) => Promise<void>;
}

const libs = new WeakMap<StubState, PublishLib>();
let patched = false;

export const PUBLISH_CHANNELS = [
  'accounts:list',
  'accounts:connect',
  'accounts:cancelConnect',
  'accounts:disconnect',
  'accounts:test',
  'publish:prefill',
  'publish:validate',
  'posts:create',
  'posts:list',
  'posts:get',
  'posts:update',
  'posts:postNow',
  'posts:cancel',
  'posts:retry',
  'posts:delete',
  'posts:refreshStats',
  'scheduler:status',
  'scheduler:setPaused',
  'scheduler:digestNow',
] as const;

const fail = (message: string, code: 'NOT_FOUND' | 'FAILED' | 'UNAVAILABLE' = 'FAILED') =>
  new Error(encodeIpcError(code, message));

export const sourceKeyOf = (s: PostSource): string =>
  'clipId' in s ? `c:${s.clipId}` : `e:${s.exportId}`;

/* ------------------------------------------------------------------------------- fixtures ----- */

export function makeAccount(
  platform: Platform,
  over: Partial<SocialAccount> & { id: string },
): SocialAccount {
  const base: Record<Platform, Partial<SocialAccount>> = {
    shorts: {
      externalId: 'UC-demo-channel',
      displayName: 'Riverside Shorts',
      handle: 'riversideshorts',
      scopes: ['youtube.upload'],
      info: {},
    },
    reels: {
      externalId: 'ig-17841400',
      displayName: 'Riverside Reels',
      handle: 'riverside.reels',
      scopes: ['instagram_content_publish'],
      info: { pageName: 'Riverside Community TV' },
    },
    tiktok: {
      externalId: 'tt-open-id-1',
      displayName: 'Riverside TV',
      handle: 'riversidetv',
      scopes: ['video.publish', 'video.upload'],
      info: { audited: false },
    },
  };
  return socialAccountSchema.parse({
    platform,
    avatarUrl: platform === 'shorts' ? AVATAR : null,
    status: 'connected',
    statusMessage: null,
    connectedAt: FIXED_NOW - 9 * DAY,
    ...base[platform],
    ...over,
  });
}

export const ACC_YT = 'acc-yt';
export const ACC_IG = 'acc-ig';
export const ACC_TT = 'acc-tt';

export function defaultAccounts(): SocialAccount[] {
  return [
    makeAccount('shorts', { id: ACC_YT }),
    makeAccount('reels', { id: ACC_IG }),
    makeAccount('tiktok', { id: ACC_TT }),
  ];
}

function defaultQuota(accounts: SocialAccount[], now: number): QuotaInfo[] {
  return accounts.flatMap((a) => {
    if (a.platform === 'shorts')
      return [
        quotaInfoSchema.parse({
          accountId: a.id,
          platform: 'shorts',
          label: 'YouTube API quota',
          used: 32,
          limit: 100,
          unit: 'posts',
          resetsAt: now + 7 * HOUR,
          postsLeft: 68,
          note: 'YouTube allows 100 uploads a day for a new project (1 unit each). Request more for free in the YouTube API quota form.',
        }),
      ];
    if (a.platform === 'reels')
      return [
        quotaInfoSchema.parse({
          accountId: a.id,
          platform: 'reels',
          label: 'Instagram publishing limit',
          used: 2,
          limit: 25,
          unit: 'posts',
          resetsAt: now + 18 * HOUR,
          postsLeft: 23,
          note: null,
        }),
      ];
    return [];
  });
}

/* --------------------------------------------------------------------------------- install ----- */

export interface InstallOptions {
  now?: number;
  accounts?: SocialAccount[];
  /** Platforms whose developer credentials are saved (default all). */
  configured?: Platform[];
  seed?: boolean;
}

export function installPublishLib(state: StubState, opts: InstallOptions = {}): PublishLib {
  const t0Real = Date.now();
  const t0 = opts.now ?? FIXED_NOW;
  const now = () => t0 + (Date.now() - t0Real);
  const accounts = (opts.accounts ?? defaultAccounts()).map((a) => ({ ...a }));
  const configured = opts.configured ?? ['shorts', 'reels', 'tiktok'];
  const held = new Map<Platform, { resolve: () => void; reject: (e: Error) => void }>();
  let n = 0;

  const lib: PublishLib = {
    now,
    accounts,
    setup: (['shorts', 'reels', 'tiktok'] as const).map((p) =>
      platformSetupSchema.parse({
        platform: p,
        configured: configured.includes(p),
        redirectUri: `http://127.0.0.1:53682/oauth/${p === 'shorts' ? 'youtube' : p === 'reels' ? 'instagram' : 'tiktok'}/callback`,
      }),
    ),
    posts: [],
    quota: defaultQuota(accounts, t0),
    scheduler: {
      paused: false,
      active: true,
      trayMode: true,
      trayAvailable: true,
      catchUp: { pending: 0, lastRunAt: null },
    },
    log: {
      created: [],
      updates: [],
      postNow: [],
      cancels: [],
      retries: [],
      deletes: [],
      statsRefreshed: [],
      connects: [],
      cancelConnects: [],
      tests: [],
      disconnects: [],
      paused: [],
      validates: [],
      prefills: [],
      digests: 0,
    },
    exportTitles: { 'exp-1': 'Launch teaser (final cut)' },
    suggestedAt: t0 + 28 * HOUR,
    windows: null,
    mediaIssues: {},
    fieldIssues: () => [],
    refuse: () => null,
    failNext: {},
    connectMode: 'instant',
    connectOutcome: async (platform, result) => {
      const h = held.get(platform);
      if (!h) throw new Error(`no accounts:connect is waiting for ${platform}`);
      held.delete(platform);
      if (result.ok) h.resolve();
      else h.reject(new Error(result.message));
    },
    testResult: {},
    autoPublishMs: null,
    post(id) {
      const p = lib.posts.find((x) => x.id === id);
      if (!p) throw new Error(`no post ${id}`);
      return p;
    },
    async progress(id, status, patch = {}) {
      const i = lib.posts.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`no post ${id}`);
      const next = postViewSchema.parse({ ...lib.posts[i], ...patch, status });
      lib.posts[i] = next;
      await state.emit?.('posts:updated', next);
      await lib.emitStatus();
      return next;
    },
    async addPost(p) {
      const acc = lib.accounts.find((a) => a.id === p.accountId);
      if (!acc) throw new Error(`no account ${p.accountId}`);
      const fields =
        p.fields ?? defaultFieldsFrom(acc.platform, null, p.title ?? 'Seeded post', {});
      const post = buildPost(lib, {
        id: p.id ?? `post-${++n}`,
        account: acc,
        fields,
        status: p.status,
        scheduledAt: p.scheduledAt ?? null,
        source: p.clipId ? { clipId: p.clipId } : { clipId: 'vid-interview-c1' },
        extra: p,
      });
      lib.posts.push(post);
      await state.emit?.('posts:updated', post);
      await lib.emitStatus();
      return post;
    },
    emitStatus: async () => {
      await state.emit?.('scheduler:status', statusOf(lib));
    },
    emitAccounts: async (platform) => {
      await state.emit?.('accounts:changed', { platform });
    },
  };
  libs.set(state, lib);
  (lib as unknown as { _held: typeof held })._held = held;
  (lib as unknown as { _nextId: () => string })._nextId = () => `post-${++n}`;
  patch();
  if (opts.seed) seedPosts(lib);
  return lib;
}

export function publishLib(state: StubState): PublishLib {
  const l = libs.get(state);
  if (!l) throw new Error('installPublishLib was not called for this session');
  return l;
}

/* ----------------------------------------------------------------------------------- posts ----- */

function clipTitle(state: StubState, source: PostSource, lib: PublishLib): string {
  if ('clipId' in source) return state.clips.find((c) => c.id === source.clipId)?.title ?? 'Clip';
  return lib.exportTitles[source.exportId] ?? 'Export';
}

function buildPost(
  lib: PublishLib,
  a: {
    id: string;
    account: SocialAccount;
    fields: PostFields;
    status: PostStatus;
    scheduledAt: number | null;
    source: PostSource;
    extra?: Partial<PostView>;
    autoFix?: boolean;
    groupId?: string | null;
  },
): PostView {
  const e = a.extra ?? {};
  return postViewSchema.parse({
    id: a.id,
    platform: a.account.platform,
    accountId: a.account.id,
    accountName: a.account.displayName,
    clipId: 'clipId' in a.source ? a.source.clipId : null,
    exportId: 'exportId' in a.source ? a.source.exportId : null,
    title: postTitleOf(a.fields),
    status: a.status,
    scheduledAt: a.scheduledAt,
    publishedAt: null,
    nextAttemptAt: null,
    attempts: 0,
    fields: a.fields,
    media: cleanMedia(),
    autoFixed: false,
    autoFix: a.autoFix ?? true,
    error: null,
    result: null,
    stats: null,
    groupId: a.groupId ?? null,
    thumbUrl: null,
    createdAt: lib.now() - HOUR,
    ...e,
    // title always follows the fields unless the test set one explicitly
    ...(e.title ? {} : { title: postTitleOf(a.fields) }),
  });
}

function cleanMedia() {
  return {
    durationSec: 42,
    width: 1080,
    height: 1920,
    fps: 30,
    sizeBytes: 18_400_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
}

function reportFor(lib: PublishLib, source: PostSource, platform: Platform): MediaReport {
  const issues = lib.mediaIssues[`${sourceKeyOf(source)}|${platform}`] ?? [];
  return mediaReportSchema.parse({
    platform,
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    media: cleanMedia(),
  });
}

function fieldIssuesFor(lib: PublishLib, platform: Platform, fields: PostFields | undefined) {
  const out: FieldIssue[] = [];
  if (fields?.platform === 'shorts' && !fields.title.trim())
    out.push({ field: 'title', message: 'YouTube needs a title.' });
  if (fields?.platform === 'reels' && /(^|\s)#\w+/g.test(fields.caption)) {
    const tags = fields.caption.match(/(^|\s)#\w+/g) ?? [];
    if (tags.length > 30)
      out.push({ field: 'caption', message: 'Instagram allows at most 30 hashtags.' });
  }
  return [...out, ...lib.fieldIssues(platform, fields)];
}

export const statusOf = (lib: PublishLib) => {
  const pending = lib.posts.filter((p) => p.status === 'scheduled' || p.status === 'queued');
  const next = pending
    .map((p) => p.scheduledAt)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  return schedulerStatusSchema.parse({
    active: lib.scheduler.active,
    paused: lib.scheduler.paused,
    trayMode: lib.scheduler.trayMode,
    trayAvailable: lib.scheduler.trayAvailable,
    upcoming: pending.length,
    nextAt: next ?? null,
    publishing: lib.posts.filter((p) => p.status === 'publishing').length,
    catchUp: lib.scheduler.catchUp,
    quota: lib.quota,
    now: lib.now(),
  });
};

/* ------------------------------------------------------------------------------------ seed ----- */

/**
 * A realistic week around FIXED_NOW (Wed 14 Oct 2026 10:00): published yesterday with stats, a publishing one, two
 * scheduled today/tomorrow, a failed one with the platform's error, a missed one, a draft and a canceled one.
 */
export function seedPosts(lib: PublishLib) {
  const at = (dayOffset: number, h: number, m = 0) =>
    new Date(2026, 9, 14 + dayOffset, h, m, 0, 0).getTime();
  const mk = (
    id: string,
    accountId: string,
    status: PostStatus,
    scheduledAt: number | null,
    title: string,
    extra: Partial<PostView> = {},
  ) => {
    const acc = lib.accounts.find((a) => a.id === accountId);
    if (!acc) return; // seeding without that account (e.g. a fresh install)
    const fields = defaultFieldsFrom(acc.platform, null, title, {});
    lib.posts.push(
      buildPost(lib, {
        id,
        account: acc,
        fields,
        status,
        scheduledAt,
        source: { clipId: 'vid-interview-c1' },
        extra: { title, ...extra },
      }),
    );
  };
  mk('p-pub', ACC_YT, 'published', at(-1, 18, 30), 'Why local art matters', {
    publishedAt: at(-1, 18, 31),
    attempts: 1,
    result: {
      platformPostId: 'yt-abc123',
      url: 'https://www.youtube.com/shorts/abc123',
      outcome: 'published',
      note: null,
    },
    stats: { views: 12840, likes: 912, comments: 64, shares: null, fetchedAt: at(0, 9, 40) },
  });
  mk('p-now', ACC_IG, 'publishing', at(0, 9, 55), 'The one question every host dreads', {
    attempts: 1,
  });
  mk('p-today', ACC_TT, 'scheduled', at(0, 18, 0), 'Autism awareness in 30 seconds');
  mk('p-tom-yt', ACC_YT, 'scheduled', at(1, 12, 15), 'Behind the mural');
  mk('p-tom-ig', ACC_IG, 'scheduled', at(1, 12, 15), 'Behind the mural');
  mk('p-fail', ACC_YT, 'failed', at(0, 8, 0), 'A conversation that stuck with me', {
    attempts: 3,
    error: {
      code: 'quota',
      message:
        'The request cannot be completed because you have exceeded your quota. (quotaExceeded)',
      retryable: true,
      at: at(0, 8, 2),
      hint: 'YouTube allows about 6 uploads a day. It resets at midnight Pacific time; request more quota for free.',
    },
  });
  mk('p-miss', ACC_IG, 'missed', at(-1, 9, 0), 'Community garden tour', {
    error: null,
  });
  mk('p-draft', ACC_TT, 'draft', null, 'Rough cut for the weekend');
  mk('p-cancel', ACC_IG, 'canceled', at(2, 17, 0), 'Old idea, canceled');
}

/* ----------------------------------------------------------------------------------- patch ----- */

function patch() {
  if (patched) return;
  patched = true;
  const orig = stubB.handle.bind(stubB);
  stubB.handle = async (state, channel, payload) => {
    const lib = libs.get(state as StubState);
    if (!lib) return orig(state, channel, payload);
    const mine = (PUBLISH_CHANNELS as readonly string[]).includes(channel);
    const brand =
      lib.windows !== null && (channel === 'brand:defaultKit' || channel === 'brand:get');
    if (!mine && !brand) return orig(state, channel, payload);
    const f = lib.failNext[channel];
    if (f && f.times > 0) {
      f.times -= 1;
      throw fail(f.message, f.code ?? 'FAILED');
    }
    return { value: await handle(state as StubState, lib, channel, payload) };
  };
}

async function handle(
  state: StubState,
  lib: PublishLib,
  channel: string,
  payload: unknown,
): Promise<unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const emit = state.emit!;
  const held = (
    lib as unknown as { _held: Map<Platform, { resolve: () => void; reject: (e: Error) => void }> }
  )._held;
  const nextId = (lib as unknown as { _nextId: () => string })._nextId;

  switch (channel) {
    case 'brand:defaultKit':
      return { id: 'kit-windows' };
    case 'brand:get':
      return {
        kit: brandKitSchema.parse({
          id: 'kit-windows',
          name: 'Windows kit',
          isDefault: true,
          spec: {
            ...defaultBrandSpec(),
            defaults: { ...defaultBrandSpec().defaults, postingWindows: lib.windows },
          },
          rev: 1,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        }),
        assets: [],
      };

    case 'accounts:list':
      return { accounts: lib.accounts, setup: lib.setup };

    case 'accounts:connect': {
      const platform = invokeContract['accounts:connect'].input.parse(p).platform;
      lib.log.connects.push(platform);
      const setup = lib.setup.find((s) => s.platform === platform);
      if (!setup?.configured) throw fail('Save the developer app credentials first.');
      if (lib.connectMode === 'hold')
        await new Promise<void>((resolve, reject) => held.set(platform, { resolve, reject }));
      const existing = lib.accounts.find(
        (a) => a.platform === platform && a.status !== 'connected',
      );
      const account =
        existing ??
        makeAccount(platform, {
          id: `acc-${platform}-${lib.accounts.length + 1}`,
          displayName:
            platform === 'shorts' ? 'New Channel' : platform === 'reels' ? 'New IG' : 'New TikTok',
          handle: `new${platform}`,
          connectedAt: lib.now(),
        });
      if (existing) {
        existing.status = accountStatusSchema.parse('connected');
        existing.statusMessage = null;
      } else lib.accounts.push(account);
      await emit('accounts:changed', { platform });
      return { account: lib.accounts.find((a) => a.id === account.id)! };
    }
    case 'accounts:cancelConnect': {
      const platform = invokeContract['accounts:cancelConnect'].input.parse(p).platform;
      lib.log.cancelConnects.push(platform);
      held.get(platform)?.reject(new Error('Connection canceled.'));
      held.delete(platform);
      return { ok: true };
    }
    case 'accounts:disconnect': {
      const id = String(p.id);
      lib.log.disconnects.push(id);
      const i = lib.accounts.findIndex((a) => a.id === id);
      if (i < 0) throw fail('Account not found.', 'NOT_FOUND');
      const [gone] = lib.accounts.splice(i, 1);
      for (const post of lib.posts.filter(
        (x) => x.accountId === id && (x.status === 'scheduled' || x.status === 'queued'),
      )) {
        await lib.progress(post.id, 'draft', { scheduledAt: null });
      }
      await emit('accounts:changed', { platform: gone!.platform });
      return { ok: true };
    }
    case 'accounts:test': {
      const id = String(p.id);
      lib.log.tests.push(id);
      const acc = lib.accounts.find((a) => a.id === id);
      if (!acc) throw fail('Account not found.', 'NOT_FOUND');
      const r = lib.testResult[id] ?? { ok: true, message: `Signed in as ${acc.displayName}.` };
      return { ok: r.ok, message: r.message, detail: r.detail ?? null, account: r.ok ? acc : null };
    }

    case 'publish:prefill': {
      const input = invokeContract['publish:prefill'].input.parse(p);
      lib.log.prefills.push(input);
      const title = clipTitle(state, input.source, lib);
      const fields = defaultFieldsFrom(
        input.platform,
        { title, description: `Highlights from “${title}”.`, hashtags: ['clipfern', 'shorts'] },
        title,
        {},
      );
      return {
        title,
        fields,
        suggestedAt: lib.suggestedAt,
        hashtagSets: [{ id: 'hs-1', name: 'Community', tags: ['localart', 'community'] }],
      };
    }
    case 'publish:validate': {
      const input = invokeContract['publish:validate'].input.parse(p);
      lib.log.validates.push(input as PublishLog['validates'][number]);
      return {
        report: reportFor(lib, input.source, input.platform),
        fieldIssues: fieldIssuesFor(lib, input.platform, input.fields),
      };
    }

    case 'posts:create': {
      const input = invokeContract['posts:create'].input.parse(p);
      const posts: PostView[] = [];
      const refused: {
        index: number;
        reason: string;
        report: MediaReport | null;
        fieldIssues: FieldIssue[];
      }[] = [];
      for (const [index, raw] of input.items.entries()) {
        const item = postDraftSchema.parse(raw);
        lib.log.created.push(item);
        const acc = lib.accounts.find((a) => a.id === item.accountId);
        const platform = item.fields.platform;
        if (!acc || acc.status !== 'connected') {
          refused.push({
            index,
            reason: 'This account needs to be reconnected.',
            report: null,
            fieldIssues: [],
          });
          continue;
        }
        const custom = lib.refuse(item, index);
        if (custom) {
          refused.push({
            index,
            reason: custom.reason,
            report: custom.report ?? null,
            fieldIssues: custom.fieldIssues ?? [],
          });
          continue;
        }
        const report = reportFor(lib, item.source, platform);
        const blocking = report.issues.filter(
          (i) => i.severity === 'error' && !(i.fixable && item.autoFix),
        );
        if (blocking.length) {
          refused.push({
            index,
            reason: `The video does not meet ${platform === 'shorts' ? 'YouTube' : platform === 'reels' ? 'Instagram' : 'TikTok'}'s requirements.`,
            report,
            fieldIssues: [],
          });
          continue;
        }
        const post = buildPost(lib, {
          id: nextId(),
          account: acc,
          fields: item.fields,
          status: item.scheduledAt === null ? 'queued' : 'scheduled',
          scheduledAt: item.scheduledAt ?? lib.now(),
          source: item.source,
          autoFix: item.autoFix,
          groupId: item.groupId,
          extra: { autoFixed: report.issues.some((i) => i.fixable) && item.autoFix },
        });
        lib.posts.push(post);
        posts.push(post);
        await emit('posts:updated', post);
        if (item.scheduledAt === null && lib.autoPublishMs !== null) void autoPublish(lib, post.id);
      }
      await lib.emitStatus();
      return { posts, refused };
    }
    case 'posts:list': {
      const input = invokeContract['posts:list'].input.parse(p);
      let items = lib.posts.slice();
      if (input.statuses) items = items.filter((x) => input.statuses!.includes(x.status));
      if (input.accountId) items = items.filter((x) => x.accountId === input.accountId);
      if (input.clipId) items = items.filter((x) => x.clipId === input.clipId);
      return { items: items.slice(0, input.limit) };
    }
    case 'posts:get':
      return lib.post(String(p.id));
    case 'posts:update': {
      const input = invokeContract['posts:update'].input.parse(p);
      lib.log.updates.push({
        id: input.id,
        ...(input.fields ? { fields: input.fields } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        ...(input.autoFix !== undefined ? { autoFix: input.autoFix } : {}),
      });
      const cur = lib.post(input.id);
      if (!['draft', 'scheduled', 'failed', 'missed'].includes(cur.status))
        throw fail(`A ${cur.status} post can no longer be edited.`);
      const patchObj: Partial<PostView> = {};
      if (input.fields) {
        patchObj.fields = input.fields;
        patchObj.title = postTitleOf(input.fields);
      }
      if (input.autoFix !== undefined) patchObj.autoFix = input.autoFix;
      let status: PostStatus = cur.status;
      if (input.scheduledAt !== undefined) {
        patchObj.scheduledAt = input.scheduledAt;
        status = input.scheduledAt === null ? 'draft' : 'scheduled';
        if (input.scheduledAt !== null) patchObj.error = null;
      }
      return lib.progress(input.id, status, patchObj);
    }
    case 'posts:postNow': {
      const id = String(p.id);
      lib.log.postNow.push(id);
      const post = await lib.progress(id, 'queued', { scheduledAt: lib.now() });
      if (lib.autoPublishMs !== null) void autoPublish(lib, id);
      return post;
    }
    case 'posts:cancel': {
      const id = String(p.id);
      lib.log.cancels.push(id);
      return lib.progress(id, 'canceled');
    }
    case 'posts:retry': {
      const id = String(p.id);
      lib.log.retries.push(id);
      return lib.progress(id, 'scheduled', {
        scheduledAt: lib.now(),
        error: null,
        attempts: 0,
        nextAttemptAt: null,
      });
    }
    case 'posts:delete': {
      const ids = (p.ids as string[]) ?? [];
      lib.log.deletes.push(ids);
      lib.posts = lib.posts.filter((x) => !ids.includes(x.id));
      await lib.emitStatus();
      return { ok: true };
    }
    case 'posts:refreshStats': {
      const ids = (p.ids as string[]) ?? [];
      lib.log.statsRefreshed.push(ids);
      const items: PostView[] = [];
      for (const id of ids) {
        const cur = lib.post(id);
        items.push(
          await lib.progress(id, cur.status, {
            stats: {
              views: (cur.stats?.views ?? 1000) + 2150,
              likes: (cur.stats?.likes ?? 90) + 130,
              comments: cur.stats?.comments ?? 4,
              shares: cur.stats?.shares ?? null,
              fetchedAt: lib.now(),
            },
          }),
        );
      }
      return { items };
    }

    case 'scheduler:status':
      return statusOf(lib);
    case 'scheduler:setPaused': {
      const paused = Boolean(p.paused);
      lib.log.paused.push(paused);
      lib.scheduler.paused = paused;
      const s = statusOf(lib);
      await emit('scheduler:status', s);
      return s;
    }
    case 'scheduler:digestNow':
      lib.log.digests += 1;
      return { sent: true };
  }
  throw fail(`publish-stub: unhandled channel ${channel}`);
}

async function autoPublish(lib: PublishLib, id: string) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(lib.autoPublishMs ?? 300);
    await lib.progress(id, 'publishing');
    await sleep(lib.autoPublishMs ?? 300);
    await lib.progress(id, 'published', {
      publishedAt: lib.now(),
      attempts: 1,
      result: {
        platformPostId: `plat-${id}`,
        url: `https://www.youtube.com/shorts/${id}`,
        outcome: 'published',
        note: null,
      },
    });
  } catch {
    /* page closed mid-publish */
  }
}
