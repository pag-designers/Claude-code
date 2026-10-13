import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categoryOf } from '@main/services/storage/provider';
import { MemoryStorageProvider } from '@main/services/storage/memory';
import { S3Provider } from '@main/services/storage/s3';
import { resolveStorageProvider } from '@main/services/storage/factory';
import {
  buildUsage,
  measureUsage,
  StorageUsageService,
  unconfiguredUsage,
} from '@main/services/storage/usage';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { FileKeyCipher, SecretStore } from '@main/services/secrets';
import { makeServices, tmpDir } from './helpers';
// s3rver: a real S3-protocol server, so S3Provider is tested against the wire protocol, not a mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S3rver = require('s3rver') as new (o: Record<string, unknown>) => {
  run(): Promise<unknown>;
  close(): Promise<void>;
};

const GB = 1024 ** 3;

describe('categoryOf', () => {
  it('maps top-level prefixes to categories', () => {
    expect(categoryOf('videos/abc/proxy.mp4')).toBe('videos');
    expect(categoryOf('clips/x.mp4')).toBe('clips');
    expect(categoryOf('weird/key')).toBe('other');
    expect(categoryOf('rootfile')).toBe('other');
  });
});

describe('MemoryStorageProvider + usage', () => {
  it('measures per-category usage and ignores connection probes', async () => {
    const p = new MemoryStorageProvider();
    await p.put('videos/a/proxy.mp4', Buffer.alloc(1000));
    await p.put('clips/c1.mp4', Buffer.alloc(250));
    await p.put('assets/logo.png', Buffer.alloc(50));
    await p.put('.clipfern/probe-1.txt', 'ok');
    const m = await measureUsage(p);
    expect(m.usedBytes).toBe(1300);
    expect(m.objectCount).toBe(3);
    expect(m.breakdown).toMatchObject({ videos: 1000, clips: 250, assets: 50, renders: 0 });
  });

  it('computes fraction and projected cost above the free tier', () => {
    const u = buildUsage({
      providerId: 'r2',
      freeTierGb: 10,
      usedBytes: 12 * GB,
      objectCount: 1,
      breakdown: { videos: 12 * GB, clips: 0, renders: 0, assets: 0, thumbs: 0, other: 0 },
      updatedAt: 1,
    });
    expect(u.fraction).toBeCloseTo(1.2);
    expect(u.projectedMonthlyUsd).toBeCloseTo(2 * 0.015);
    expect(unconfiguredUsage('r2', 10, 'x').configured).toBe(false);
  });

  it('raises a single 80% notification per day', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      const p = new MemoryStorageProvider();
      // 8.5 "GB" without allocating: use a 0.001 GB free tier instead
      await p.put('videos/big.bin', Buffer.alloc(900_000));
      const usage = new StorageUsageService({
        db: svc.dbHandle.prisma,
        notifications: svc.notifications,
        resolve: async () => ({ ok: true, provider: p, freeTierGb: 0.001 }),
        ttlMs: 0,
      });
      const u1 = await usage.get(true);
      expect(u1.fraction).toBeGreaterThan(0.8);
      await usage.get(true);
      const list = await svc.notifications.list();
      expect(list.items.filter((n) => n.kind === 'storage')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('reports unconfigured state with the reason when keys are missing', async () => {
    const dir = tmpDir();
    const secrets = new SecretStore(
      path.join(dir, 's'),
      new FileKeyCipher(path.join(dir, 'k')),
      {},
    );
    const r = resolveStorageProvider({ ...DEFAULT_SETTINGS }, secrets);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Account ID.*Bucket.*Access Key ID.*Secret Access Key/);
  });

  it('builds an R2 provider from settings + secrets', () => {
    const dir = tmpDir();
    const secrets = new SecretStore(
      path.join(dir, 's'),
      new FileKeyCipher(path.join(dir, 'k')),
      {},
    );
    secrets.set('r2.accessKeyId', 'AKIA');
    secrets.set('r2.secretAccessKey', 'secret');
    const r = resolveStorageProvider(
      { ...DEFAULT_SETTINGS, r2AccountId: 'acc', r2Bucket: 'bkt' },
      secrets,
    );
    expect(r.ok && r.provider.id).toBe('r2');
  });
});

describe('S3Provider against a real S3 protocol server (s3rver)', () => {
  let server: { close(): Promise<void> };
  let dir: string;
  let provider: S3Provider;
  const port = 4569;

  beforeAll(async () => {
    dir = tmpDir('s3rver-');
    const s = new S3rver({
      port,
      address: '127.0.0.1',
      silent: true,
      directory: dir,
      configureBuckets: [{ name: 'clipfern-test', configs: [] }],
    });
    await s.run();
    server = s;
    provider = new S3Provider({
      id: 'r2',
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'clipfern-test',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      forcePathStyle: true,
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('check() verifies bucket + write/read/delete', async () => {
    const r = await provider.check();
    expect(r.detail).toMatch(/verified/);
  });

  it('put / get / head / list / delete round trip', async () => {
    await provider.put('clips/a.txt', 'hello', { contentType: 'text/plain' });
    await provider.put('videos/v1/proxy.mp4', Buffer.alloc(2048, 1));
    expect((await provider.get('clips/a.txt')).toString()).toBe('hello');
    expect(await provider.head('clips/a.txt')).toMatchObject({ size: 5 });
    expect(await provider.head('nope')).toBeNull();
    const keys: string[] = [];
    for await (const o of provider.list('')) keys.push(o.key);
    expect(keys).toEqual(expect.arrayContaining(['clips/a.txt', 'videos/v1/proxy.mp4']));
    const usage = await measureUsage(provider);
    expect(usage.breakdown.videos).toBe(2048);
    await provider.delete(['clips/a.txt']);
    expect(await provider.head('clips/a.txt')).toBeNull();
  });

  it('uploads a larger file with multipart and supports ranged reads', async () => {
    const file = path.join(dir, 'big.bin');
    const buf = Buffer.alloc(20 * 1024 * 1024, 7);
    fs.writeFileSync(file, buf);
    const seen: number[] = [];
    await provider.putFile('videos/big.bin', file, { onProgress: (l) => seen.push(l) });
    expect((await provider.head('videos/big.bin'))?.size).toBe(buf.length);
    const stream = await provider.getStream('videos/big.bin', { start: 10, end: 19 });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks)).toHaveLength(10);
  });

  it('presigned GET URLs actually download the object over HTTP', async () => {
    await provider.put('assets/p.txt', 'presigned!');
    const url = await provider.presignGet('assets/p.txt', 60);
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(url, (res) => {
          let s = '';
          res.on('data', (d) => (s += d));
          res.on('end', () => resolve(s));
        })
        .on('error', reject);
    });
    expect(body).toBe('presigned!');
  });

  it('explains a wrong bucket clearly', async () => {
    const bad = new S3Provider({
      id: 'r2',
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'does-not-exist',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      forcePathStyle: true,
    });
    await expect(bad.check()).rejects.toThrow(/Bucket "does-not-exist" was not found/);
  });
});
