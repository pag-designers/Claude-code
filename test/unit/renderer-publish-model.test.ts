import { describe, expect, it } from 'vitest';
import {
  defaultFieldsFrom,
  type MediaReport,
  type PostFields,
  type PostView,
  type SocialAccount,
} from '../../shared/publish';
import {
  NO_FILTERS,
  byteLength,
  canPostNow,
  canRetry,
  counterState,
  countHashtags,
  countMentions,
  describeMedia,
  describeQuota,
  enforceTiktokAudit,
  fieldCounters,
  filterPosts,
  isCancelable,
  isEditable,
  isTiktokUnaudited,
  issuesFor,
  localFieldIssues,
  mergeShared,
  postsByDay,
  postsLeftLabel,
  queueSections,
  quotaFraction,
  quotaTone,
  reportBlocks,
  reportNeedsFix,
  tagsLength,
  upsertPost,
} from '../../renderer/lib/publish/model';

const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0, 0).getTime();

function post(over: Partial<PostView> & { id: string }): PostView {
  const fields = defaultFieldsFrom('shorts', null, over.title ?? 'A clip');
  return {
    platform: 'shorts',
    accountId: 'a1',
    accountName: 'Riverside',
    clipId: 'c1',
    exportId: null,
    title: 'A clip',
    status: 'scheduled',
    scheduledAt: at(20, 12),
    publishedAt: null,
    nextAttemptAt: null,
    attempts: 0,
    fields,
    media: null,
    autoFixed: false,
    autoFix: true,
    error: null,
    result: null,
    stats: null,
    groupId: null,
    thumbUrl: null,
    createdAt: at(1, 1),
    ...over,
  };
}

describe('status rules', () => {
  it('only draft / scheduled / failed / missed are editable', () => {
    expect(
      (
        [
          'draft',
          'scheduled',
          'queued',
          'publishing',
          'published',
          'failed',
          'missed',
          'canceled',
        ] as const
      ).filter(isEditable),
    ).toEqual(['draft', 'scheduled', 'failed', 'missed']);
  });
  it('cancel is for scheduled / queued, retry for failed / missed', () => {
    expect(isCancelable('scheduled')).toBe(true);
    expect(isCancelable('queued')).toBe(true);
    expect(isCancelable('publishing')).toBe(false);
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('missed')).toBe(true);
    expect(canRetry('scheduled')).toBe(false);
    expect(canPostNow('published')).toBe(false);
  });
});

describe('filtering', () => {
  const posts = [
    post({ id: '1', title: 'Garden tour', status: 'scheduled' }),
    post({ id: '2', title: 'Mural', status: 'failed', platform: 'tiktok', accountId: 'a2' }),
    post({ id: '3', title: 'Interview', status: 'published', platform: 'reels', accountId: 'a3' }),
    post({ id: '4', title: 'Rough cut', status: 'draft', scheduledAt: null }),
    post({ id: '5', title: 'Missed one', status: 'missed' }),
  ];
  it('filters by status group, platform, account and search', () => {
    expect(filterPosts(posts, { ...NO_FILTERS, status: 'upcoming' }).map((p) => p.id)).toEqual([
      '1',
    ]);
    expect(filterPosts(posts, { ...NO_FILTERS, status: 'attention' }).map((p) => p.id)).toEqual([
      '2',
      '5',
    ]);
    expect(filterPosts(posts, { ...NO_FILTERS, platform: 'tiktok' }).map((p) => p.id)).toEqual([
      '2',
    ]);
    expect(filterPosts(posts, { ...NO_FILTERS, accountId: 'a3' }).map((p) => p.id)).toEqual(['3']);
    expect(filterPosts(posts, { ...NO_FILTERS, query: '  MURAL ' }).map((p) => p.id)).toEqual([
      '2',
    ]);
    expect(filterPosts(posts, { ...NO_FILTERS, query: 'instagram' }).map((p) => p.id)).toEqual([
      '3',
    ]);
    expect(filterPosts(posts, NO_FILTERS)).toHaveLength(5);
  });
});

describe('grouping', () => {
  it('postsByDay sorts by time and skips undated drafts', () => {
    const m = postsByDay([
      post({ id: 'b', scheduledAt: at(20, 18) }),
      post({ id: 'a', scheduledAt: at(20, 9) }),
      post({ id: 'c', scheduledAt: at(21, 9) }),
      post({ id: 'd', status: 'draft', scheduledAt: null }),
    ]);
    expect(m.get('2026-10-20')!.map((p) => p.id)).toEqual(['a', 'b']);
    expect(m.get('2026-10-21')!.map((p) => p.id)).toEqual(['c']);
    expect([...m.keys()]).toHaveLength(2);
  });
  it('queueSections puts attention first, history newest first, and drops empty sections', () => {
    const s = queueSections([
      post({ id: 'old', status: 'published', scheduledAt: at(10, 9) }),
      post({ id: 'new', status: 'published', scheduledAt: at(12, 9) }),
      post({ id: 'next', status: 'scheduled', scheduledAt: at(21, 9) }),
      post({ id: 'soon', status: 'scheduled', scheduledAt: at(20, 9) }),
      post({ id: 'bad', status: 'failed', scheduledAt: at(19, 9) }),
    ]);
    expect(s.map((x) => x.id)).toEqual(['attention', 'upcoming', 'history']);
    expect(s[1]!.posts.map((p) => p.id)).toEqual(['soon', 'next']);
    expect(s[2]!.posts.map((p) => p.id)).toEqual(['new', 'old']);
  });
  it('upsertPost replaces in place or appends', () => {
    const list = [post({ id: '1' }), post({ id: '2' })];
    const next = upsertPost(list, post({ id: '2', status: 'published' }));
    expect(next.map((p) => p.status)).toEqual(['scheduled', 'published']);
    expect(upsertPost(list, post({ id: '3' }))).toHaveLength(3);
    expect(list[1]!.status).toBe('scheduled');
  });
});

describe('quota', () => {
  const q = (used: number, limit: number, postsLeft: number | null) => ({
    accountId: 'a',
    platform: 'shorts' as const,
    label: 'q',
    used,
    limit,
    unit: 'units' as const,
    resetsAt: 0,
    postsLeft,
    note: null,
  });
  it('fraction clamps and tone steps up', () => {
    expect(quotaFraction(q(5000, 10000, 3))).toBe(0.5);
    expect(quotaFraction(q(20000, 10000, 0))).toBe(1);
    expect(quotaFraction(q(1, 0, null))).toBe(0);
    expect(quotaTone(q(3200, 10000, 4))).toBe('primary');
    expect(quotaTone(q(7500, 10000, 1))).toBe('warning');
    expect(quotaTone(q(9500, 10000, 1))).toBe('danger');
    expect(quotaTone(q(100, 10000, 0))).toBe('danger');
  });
  it('wording', () => {
    expect(describeQuota(q(3200, 10000, 4))).toBe('3,200 of 10,000 units');
    expect(postsLeftLabel({ postsLeft: 4 })).toBe('4 more posts today');
    expect(postsLeftLabel({ postsLeft: 1 })).toBe('1 more post today');
    expect(postsLeftLabel({ postsLeft: 0 })).toBe('Daily limit reached');
    expect(postsLeftLabel({ postsLeft: null })).toBeNull();
  });
});

describe('counters and local issues', () => {
  it('counts hashtags, mentions, bytes and tag characters', () => {
    expect(countHashtags('Hello #one #two, not#three #4')).toBe(3);
    expect(countMentions('thanks @bob and @a.b_c but not mail@x.com')).toBe(2);
    expect(byteLength('héllo')).toBe(6);
    expect(tagsLength(['ab', 'cde'])).toBe(6);
    expect(tagsLength([])).toBe(0);
  });
  it('counterState: ok, near (90%), over', () => {
    expect(counterState({ value: 50, max: 100 })).toBe('ok');
    expect(counterState({ value: 90, max: 100 })).toBe('near');
    expect(counterState({ value: 100, max: 100 })).toBe('near');
    expect(counterState({ value: 101, max: 100 })).toBe('over');
  });
  it('shorts: description is counted in bytes', () => {
    const f = defaultFieldsFrom('shorts', null, 'T');
    if (f.platform !== 'shorts') throw new Error('shorts');
    const c = fieldCounters({ ...f, description: 'é'.repeat(10) });
    expect(c.description!.value).toBe(20);
    expect(c.description!.max).toBe(5000);
  });
  it('local issues flag over-limit fields and empty or bracketed titles', () => {
    const f = defaultFieldsFrom('shorts', null, 'T');
    if (f.platform !== 'shorts') throw new Error('shorts');
    expect(localFieldIssues(f)).toEqual([]);
    expect(localFieldIssues({ ...f, title: '' }).map((i) => i.field)).toEqual(['title']);
    expect(localFieldIssues({ ...f, title: 'a<b' })[0]!.message).toMatch(/< or >/);
    const over = localFieldIssues({ ...f, title: 'x'.repeat(101) });
    expect(over[0]).toMatchObject({ field: 'title' });
    expect(over[0]!.message).toMatch(/1 chars over the 100 limit/);
    const reels = defaultFieldsFrom('reels', null, 'T');
    if (reels.platform !== 'reels') throw new Error('reels');
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(localFieldIssues({ ...reels, caption: tags }).map((i) => i.field)).toContain('hashtags');
  });
  it('issuesFor merges lists and de-duplicates', () => {
    expect(
      issuesFor(
        'title',
        [{ field: 'title', message: 'A' }],
        [
          { field: 'title', message: 'A' },
          { field: 'title', message: 'B' },
          { field: 'other', message: 'C' },
        ],
      ),
    ).toBe('A B');
    expect(issuesFor('x', [])).toBeUndefined();
  });
});

describe('media report', () => {
  const media = {
    durationSec: 42,
    width: 1080,
    height: 1920,
    fps: 30,
    sizeBytes: 18_400_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };
  const report = (issues: MediaReport['issues']): MediaReport => ({
    platform: 'shorts',
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    media,
  });
  const fixable = {
    severity: 'error' as const,
    code: 'duration-long' as const,
    message: 'x',
    fixable: true,
  };
  const hard = {
    severity: 'error' as const,
    code: 'aspect' as const,
    message: 'x',
    fixable: false,
  };
  const warn = {
    severity: 'warning' as const,
    code: 'bitrate' as const,
    message: 'x',
    fixable: false,
  };
  it('blocks unless every error is fixable and auto-fix is on', () => {
    expect(reportBlocks(report([]), true)).toBe(false);
    expect(reportBlocks(report([warn]), false)).toBe(false);
    expect(reportBlocks(report([fixable]), true)).toBe(false);
    expect(reportBlocks(report([fixable]), false)).toBe(true);
    expect(reportBlocks(report([fixable, hard]), true)).toBe(true);
    expect(reportBlocks(undefined, true)).toBe(false);
  });
  it('needsFix is true for fixable errors only', () => {
    expect(reportNeedsFix(report([fixable]))).toBe(true);
    expect(reportNeedsFix(report([hard, warn]))).toBe(false);
  });
  it('describeMedia is a one-line summary', () => {
    expect(describeMedia(media)).toBe('0:42 · 1080×1920 · 30 fps · 18.4 MB · H264 / AAC');
    expect(describeMedia({ ...media, fps: null, audioCodec: null, sizeBytes: 500_000 })).toBe(
      '0:42 · 1080×1920 · 500 KB · H264',
    );
  });
});

describe('TikTok audit', () => {
  const acc = (info: SocialAccount['info']) => ({ platform: 'tiktok' as const, info });
  it('is unaudited unless info.audited is exactly true', () => {
    expect(isTiktokUnaudited(acc({ audited: false }))).toBe(true);
    expect(isTiktokUnaudited(acc({}))).toBe(true);
    expect(isTiktokUnaudited(acc({ audited: true }))).toBe(false);
    expect(isTiktokUnaudited({ platform: 'shorts', info: {} })).toBe(false);
  });
  it('enforceTiktokAudit forces private posts on an unaudited app only', () => {
    const f = defaultFieldsFrom('tiktok', null, 'T');
    if (f.platform !== 'tiktok') throw new Error('tiktok');
    const pub: PostFields = { ...f, privacyLevel: 'PUBLIC_TO_EVERYONE' };
    expect(enforceTiktokAudit(pub, true)).toMatchObject({ privacyLevel: 'SELF_ONLY' });
    expect(enforceTiktokAudit(pub, false)).toMatchObject({ privacyLevel: 'PUBLIC_TO_EVERYONE' });
    const yt = defaultFieldsFrom('shorts', null, 'T');
    expect(enforceTiktokAudit(yt, true)).toBe(yt);
  });
});

describe('mergeShared (bulk)', () => {
  it('copies shared settings but keeps each clip’s own text', () => {
    const own = defaultFieldsFrom(
      'shorts',
      { title: 'Own title', description: 'own', hashtags: ['a'] },
      'x',
    );
    const shared = defaultFieldsFrom(
      'shorts',
      { title: 'Shared', description: 'shared', hashtags: [] },
      'x',
    );
    if (own.platform !== 'shorts' || shared.platform !== 'shorts') throw new Error('shorts');
    const merged = mergeShared(own, {
      ...shared,
      visibility: 'unlisted',
      madeForKids: true,
      categoryId: '24',
    });
    expect(merged).toMatchObject({
      title: 'Own title',
      visibility: 'unlisted',
      madeForKids: true,
      categoryId: '24',
    });
    expect(merged).toHaveProperty('description', expect.stringContaining('own'));
    const tt = defaultFieldsFrom('tiktok', null, 'Own');
    const tts = defaultFieldsFrom('tiktok', null, 'Shared');
    if (tt.platform !== 'tiktok' || tts.platform !== 'tiktok') throw new Error('tiktok');
    expect(mergeShared(tt, { ...tts, mode: 'draft', allowDuet: false })).toMatchObject({
      title: 'Own',
      mode: 'draft',
      allowDuet: false,
    });
    // different platforms never mix
    expect(mergeShared(own, tt)).toBe(own);
  });
});
