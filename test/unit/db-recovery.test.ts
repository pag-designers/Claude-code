import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/client';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-recover-'));
  dirs.push(d);
  return d;
};

async function seed(file: string) {
  const h = await openDatabase(file);
  const db = h.prisma;
  for (let i = 0; i < 5; i++)
    await db.setting.create({ data: { key: `k${i}`, value: JSON.stringify(i) } });
  for (let i = 0; i < 40; i++)
    await db.notification.create({
      data: { kind: 'system', level: 'info', title: `note ${i}`, body: 'x'.repeat(200) },
    });
  const video = await db.video.create({ data: { sourceUrl: 'https://x/y', title: 'My video' } });
  await db.clip.create({ data: { videoId: video.id, title: 'A clip', startSec: 1, endSec: 20 } });
  const root = async (name: string) =>
    Number(
      (
        await db.$queryRawUnsafe<{ rootpage: bigint }[]>(
          `SELECT rootpage FROM sqlite_master WHERE name = '${name}'`,
        )
      )[0]!.rootpage,
    );
  const pageSize = Number(
    (await db.$queryRawUnsafe<{ page_size: bigint }[]>('PRAGMA page_size'))[0]!.page_size,
  );
  const notificationRoot = await root('Notification');
  await h.close();
  return { notificationRoot, pageSize };
}

describe('database recovery at startup', () => {
  it('leaves a healthy database alone', async () => {
    const dir = tmp();
    const file = path.join(dir, 'a.db');
    await seed(file);
    const h = await openDatabase(file);
    expect(h.recovery).toBeNull();
    expect(await h.prisma.setting.count()).toBe(5);
    expect(fs.readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(false);
    await h.close();
  });

  it('a damaged table page: moves the file aside, rebuilds, and salvages every other table', async () => {
    const dir = tmp();
    const file = path.join(dir, 'a.db');
    const { notificationRoot, pageSize } = await seed(file);
    // overwrite the whole root page of the Notification table with garbage
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (notificationRoot - 1) * pageSize);
    fs.closeSync(fd);

    const h = await openDatabase(file);
    const r = h.recovery!;
    expect(r).not.toBeNull();
    expect(r.reason.length).toBeGreaterThan(0);
    expect(fs.existsSync(r.quarantinedTo)).toBe(true); // nothing is deleted
    expect(r.recovered.Setting).toBe(5);
    expect(r.recovered.Video).toBe(1);
    expect(r.recovered.Clip).toBe(1);
    expect(await h.prisma.setting.count()).toBe(5);
    expect((await h.prisma.clip.findFirstOrThrow()).title).toBe('A clip');
    // the notifications on the destroyed page are gone, and said so
    expect(r.recovered.Notification ?? 0).toBeLessThan(40);
    expect(r.lost.Notification ?? 0).toBeGreaterThan(0);
    // and the rebuilt database is fully usable and sound
    await h.prisma.setting.create({ data: { key: 'after', value: '1' } });
    const check = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA quick_check');
    expect(String(Object.values(check[0]!)[0])).toBe('ok');
    await h.close();

    // a second start is clean: no new recovery, the quarantined copy is left alone
    const again = await openDatabase(file);
    expect(again.recovery).toBeNull();
    expect(await again.prisma.setting.count()).toBe(6);
    await again.close();
  });

  it('a file that is not a database at all becomes a fresh one (and is kept aside)', async () => {
    const dir = tmp();
    const file = path.join(dir, 'a.db');
    fs.writeFileSync(
      file,
      'this is not sqlite, it is a text file that is long enough to look like a header '.repeat(80),
    );
    const h = await openDatabase(file);
    expect(h.recovery).not.toBeNull();
    expect(Object.values(h.recovery!.recovered).reduce((a, b) => a + b, 0)).toBe(0);
    expect(fs.existsSync(h.recovery!.quarantinedTo)).toBe(true);
    await h.prisma.setting.create({ data: { key: 'ok', value: '1' } });
    await h.close();
  });
});
