import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/client';
import { isDbFault } from '@main/db/faults';
import { JobQueue } from '@main/services/queue';
import { SettingsService } from '@main/services/settings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('isDbFault', () => {
  it.each([
    'DriverAdapterError: disk I/O error',
    'SQLITE_IOERR_SHMSIZE',
    'database disk image is malformed',
    'SQLITE_CORRUPT: x',
    'unable to open database file',
  ])('treats "%s" as a connection fault', (m) => expect(isDbFault(new Error(m))).toBe(true));

  it.each([
    'Unique constraint failed on the fields: (`key`)',
    'database is locked',
    'Record not found',
  ])('does not reopen the connection for "%s"', (m) => expect(isDbFault(new Error(m))).toBe(false));

  it('looks at the cause too (Prisma wraps driver errors)', () => {
    expect(isDbFault(new Error('Failed', { cause: new Error('disk I/O error') }))).toBe(true);
  });
});

describe('DbHandle.reconnect', () => {
  it('keeps the data and the same handle usable on a fresh connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-heal-'));
    dirs.push(dir);
    const h = await openDatabase(path.join(dir, 't.db'));
    const db = h.prisma;
    await db.setting.create({ data: { key: 'a', value: '1' } });
    await h.reconnect();
    expect(h.prisma).toBe(db); // services keep their reference
    expect((await db.setting.findUnique({ where: { key: 'a' } }))?.value).toBe('1');
    await db.setting.upsert({
      where: { key: 'a' },
      create: { key: 'a', value: '2' },
      update: { value: '2' },
    });
    await db.$transaction([db.setting.create({ data: { key: 'b', value: '3' } })]);
    await h.reconnect();
    await h.reconnect(); // twice in a row is fine
    expect(await db.setting.count()).toBe(2);
    await h.close();
  });

  it('survives concurrent work while it swaps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-heal-'));
    dirs.push(dir);
    const h = await openDatabase(path.join(dir, 't.db'));
    const db = h.prisma;
    const work = Array.from({ length: 40 }, (_, i) =>
      db.setting.upsert({
        where: { key: `k${i % 8}` },
        create: { key: `k${i % 8}`, value: String(i) },
        update: { value: String(i) },
      }),
    );
    const swap = h.reconnect();
    await Promise.all([...work, swap]);
    expect(await db.setting.count()).toBe(8);
    await h.close();
  });
});

describe('queue fault handling', () => {
  const failing = () =>
    ({
      job: {
        updateMany: async () => ({ count: 0 }),
        findMany: async () => {
          throw new Error('DriverAdapterError: disk I/O error');
        },
      },
    }) as never;

  it('reports the fault to the host, and logs once instead of every poll', async () => {
    const logs: string[] = [];
    let faults = 0;
    const q = new JobQueue(failing(), {
      concurrency: () => 1,
      pollMs: 15,
      log: (m) => logs.push(m),
      onFault: () => {
        faults += 1;
      },
    });
    q.register('x', async () => {});
    await q.start();
    await new Promise((r) => setTimeout(r, 400));
    await q.stop();
    expect(faults).toBeGreaterThan(5); // the host is told every time (it rate-limits itself)
    expect(logs.length).toBeLessThanOrEqual(2); // but the log is not flooded
    expect(logs[0]).toContain('disk I/O error');
  });

  it('a recovered database resets the streak', async () => {
    const logs: string[] = [];
    let broken = true;
    const db = {
      job: {
        updateMany: async () => ({ count: 0 }),
        findMany: async () => {
          if (broken) throw new Error('disk I/O error');
          return [];
        },
      },
    } as never;
    const q = new JobQueue(db, { concurrency: () => 1, pollMs: 15, log: (m) => logs.push(m) });
    q.register('x', async () => {});
    await q.start();
    await new Promise((r) => setTimeout(r, 120));
    broken = false;
    await new Promise((r) => setTimeout(r, 120));
    broken = true;
    await new Promise((r) => setTimeout(r, 120));
    await q.stop();
    expect(logs.filter((l) => l.includes('queue tick failed')).length).toBe(2); // one line per outage
  });
});

describe('settings write', () => {
  it('asks the host to heal before retrying a transient I/O failure', async () => {
    let calls = 0;
    const db = {
      setting: {
        findMany: async () => [],
        upsert: async () => {
          calls += 1;
          if (calls === 1) throw new Error('disk I/O error');
          return {};
        },
      },
    } as never;
    const s = new SettingsService(db);
    let healed = 0;
    s.onFault = () => {
      healed += 1;
    };
    await s.set({ r2AccountId: 'abc' });
    expect(calls).toBe(2);
    expect(healed).toBe(1);
  });
});
