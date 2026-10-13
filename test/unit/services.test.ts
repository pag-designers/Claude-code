import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeCostUsd, priceFor } from '@main/services/cost';
import { Validators } from '@main/services/validators';
import { ytdlpAssetName } from '@main/services/binaries';
import { settingsSchema, DEFAULT_SETTINGS } from '@shared/settings';
import { makeServices } from './helpers';

describe('migrations + settings', () => {
  it('creates schema v1 and is idempotent across reopen', async () => {
    const { svc, dir, cleanup } = await makeServices();
    try {
      const tables = (
        await svc.dbHandle.prisma.$queryRawUnsafe<{ name: string }[]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' AND name NOT LIKE '!_%' ESCAPE '!'",
        )
      ).map((t) => t.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'Setting',
          'Job',
          'Notification',
          'CostEvent',
          'StorageSnapshot',
          'Video',
          'Clip',
        ]),
      );
      const { runMigrations } = await import('@main/db/client');
      expect(await runMigrations(`file:${dir}/test.db`)).toEqual([]); // nothing re-applied
    } finally {
      await cleanup();
    }
  });

  it('every domain table carries ownerId defaulting to "local"', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      const n = await svc.notifications.create({ kind: 'system', title: 't' });
      const row = await svc.dbHandle.prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
      expect(row.ownerId).toBe('local');
    } finally {
      await cleanup();
    }
  });

  it('defaults are valid, patches merge and persist, bad persisted values fall back per-field', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
      const s = await svc.settings.set({ modelSmart: 'claude-x', cacheCapGb: 50 });
      expect(s.modelSmart).toBe('claude-x');
      expect(s.modelFast).toBe(DEFAULT_SETTINGS.modelFast);
      await svc.dbHandle.prisma.setting.upsert({
        where: { key: 'concurrency' },
        create: { key: 'concurrency', value: '"oops"' },
        update: { value: '"oops"' },
      });
      const { SettingsService } = await import('@main/services/settings');
      const fresh = await new SettingsService(svc.dbHandle.prisma).get();
      expect(fresh.concurrency).toBe(DEFAULT_SETTINGS.concurrency);
      expect(fresh.modelSmart).toBe('claude-x');
    } finally {
      await cleanup();
    }
  });
});

describe('notifications', () => {
  it('create / list / unread / markRead / clear, and emits hooks', async () => {
    const pushed: string[] = [];
    const os: string[] = [];
    const { svc, cleanup } = await makeServices({
      emit: { notification: (n) => pushed.push(n.title), osNotify: (n) => os.push(n.title) },
    });
    try {
      const a = await svc.notifications.create({ kind: 'job', title: 'A', level: 'success' });
      await svc.notifications.create({ kind: 'system', title: 'B', os: true });
      expect(pushed).toEqual(['A', 'B']);
      expect(os).toEqual(['B']);
      let l = await svc.notifications.list();
      expect(l.unread).toBe(2);
      expect(l.items[0]?.title).toBe('B');
      await svc.notifications.markRead([a.id]);
      l = await svc.notifications.list();
      expect(l.unread).toBe(1);
      await svc.notifications.markAllRead();
      expect((await svc.notifications.list()).unread).toBe(0);
      await svc.notifications.clear();
      expect((await svc.notifications.list()).items).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe('cost tracker', () => {
  it('prices tokens per model family (cache reads/writes included)', () => {
    expect(priceFor('claude-haiku-4-5').input).toBe(1);
    expect(priceFor('claude-sonnet-4-5').output).toBe(15);
    const c = computeCostUsd('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 100_000,
    });
    expect(c).toBeCloseTo(3 + 1.5 + 0.6 + 0.375);
  });

  it('summarises the month and flags budget levels', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      expect((await svc.cost.summary()).level).toBe('ok');
      await svc.settings.set({ budgetTargetUsd: 1, budgetHardCapUsd: 2 });
      await svc.cost.record('claude-sonnet-4-5', 'test', {
        inputTokens: 100_000,
        outputTokens: 50_000,
      }); // 0.3 + 0.75 = 1.05
      let s = await svc.cost.summary();
      expect(s.spentUsd).toBeCloseTo(1.05);
      expect(s.calls).toBe(1);
      expect(s.level).toBe('over-target');
      await svc.cost.record('claude-sonnet-4-5', 'test', { inputTokens: 0, outputTokens: 100_000 });
      s = await svc.cost.summary();
      expect(s.level).toBe('hard-cap');
      expect(s.projectedUsd).toBeGreaterThanOrEqual(s.spentUsd);
    } finally {
      await cleanup();
    }
  });
});

describe('validators (against local stub servers — no real keys needed)', () => {
  let server: http.Server;
  let base: string;
  const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      const auth = String(req.headers['x-api-key'] ?? req.headers.authorization ?? '');
      const good = auth.includes('good');
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] }));
      }
      if (req.url?.startsWith('/accounts/me')) {
        res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'biz_1', title: 'My Biz' }));
      }
      if (req.url?.startsWith('/videos/search')) {
        res.writeHead(good ? 200 : 401, { 'x-ratelimit-remaining': '19990' });
        return res.end('{}');
      }
      if (req.url?.startsWith('/api/')) {
        const ok = req.url.includes('key=good');
        res.writeHead(ok ? 200 : 400);
        return res.end(ok ? '{}' : '[ERROR 400] Invalid API key');
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function validators(env: Record<string, string>) {
    const { svc, cleanup } = await makeServices({ env });
    const v = new Validators({
      secrets: svc.secrets,
      getSettings: () => svc.settings.get(),
      anthropicBaseUrl: base,
      whopBaseUrl: base,
      pexelsBaseUrl: base,
      pixabayBaseUrl: base,
    });
    return { v, cleanup };
  }

  it('anthropic: ok / rejected / missing, sends the right headers', async () => {
    let { v, cleanup } = await validators({ ANTHROPIC_API_KEY: 'sk-good' });
    const ok = await v.run('anthropic');
    expect(ok.ok).toBe(true);
    expect(seen.at(-1)?.headers['anthropic-version']).toBe('2023-06-01');
    await cleanup();
    ({ v, cleanup } = await validators({ ANTHROPIC_API_KEY: 'sk-bad' }));
    const bad = await v.run('anthropic');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/rejected/);
    await cleanup();
    ({ v, cleanup } = await validators({}));
    expect((await v.run('anthropic')).message).toMatch(/No Anthropic API key/);
    await cleanup();
  });

  it('whop, pexels, pixabay validate through their documented endpoints', async () => {
    const { v, cleanup } = await validators({
      WHOP_API_KEY: 'good',
      PEXELS_API_KEY: 'good',
      PIXABAY_API_KEY: 'good',
    });
    const whop = await v.run('whop');
    expect(whop).toMatchObject({ ok: true, detail: 'Account: My Biz' });
    expect(seen.find((s) => s.url.startsWith('/accounts/me'))?.headers.authorization).toBe(
      'Bearer good',
    );
    expect((await v.run('pexels')).detail).toMatch(/19990/);
    expect((await v.run('pixabay')).ok).toBe(true);
    await cleanup();
    const bad = await validators({
      WHOP_API_KEY: 'nope',
      PEXELS_API_KEY: 'nope',
      PIXABAY_API_KEY: 'nope',
    });
    expect((await bad.v.run('whop')).ok).toBe(false);
    expect((await bad.v.run('pexels')).ok).toBe(false);
    expect((await bad.v.run('pixabay')).ok).toBe(false);
    await bad.cleanup();
  });

  it('storage validator explains missing configuration', async () => {
    const { v, cleanup } = await validators({});
    const r = await v.run('storage');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Cloudflare R2 is missing/);
    await cleanup();
  });

  it('reports a clear network error instead of throwing', async () => {
    const { svc, cleanup } = await makeServices({ env: { WHOP_API_KEY: 'good' } });
    const v = new Validators({
      secrets: svc.secrets,
      getSettings: () => svc.settings.get(),
      whopBaseUrl: 'http://127.0.0.1:1',
    });
    const r = await v.run('whop');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Network error|fetch failed/);
    await cleanup();
  });
});

describe('binaries', () => {
  it('picks the right yt-dlp release asset per platform', () => {
    expect(ytdlpAssetName('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytdlpAssetName('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(ytdlpAssetName('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytdlpAssetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
  });
});
