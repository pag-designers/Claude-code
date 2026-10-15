import path from 'node:path';
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@main/db/migrations.generated';
import { openDatabase, runMigrations } from '@main/db/client';
import { tmpDir } from './helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Applies exactly the CP1 migrations (0001, 0002) the way the embedded runner does. */
async function applyUpTo(url: string, last: string): Promise<void> {
  const c = createClient({ url });
  try {
    await c.execute(
      'CREATE TABLE IF NOT EXISTS _clipfern_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)',
    );
    for (const m of MIGRATIONS) {
      if (m.name > last) break;
      const statements = m.sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) =>
          s
            .split(/\r?\n/)
            .filter((l) => !l.trim().startsWith('--'))
            .join('\n')
            .trim(),
        )
        .filter(Boolean);
      await c.batch(
        [
          ...statements,
          {
            sql: 'INSERT INTO _clipfern_migrations (name, appliedAt) VALUES (?, ?)',
            args: [m.name, 'x'],
          },
        ],
        'write',
      );
    }
  } finally {
    c.close();
  }
}

describe('migrations 0003 (CP2), 0004 (CP3) and 0005 (CP4) on an existing CP1 database', () => {
  it('keeps every video and clip, and gives them the new column defaults', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const file = path.join(dir, 'upgrade.db');
    const url = `file:${file}`;
    expect(MIGRATIONS.map((m) => m.name)).toContain('0003_cp2');
    await applyUpTo(url, '0002_pipeline');

    const c = createClient({ url });
    await c.execute(
      `INSERT INTO "Video" ("id","sourceUrl","title","status","updatedAt") VALUES ('v1','https://x','Old video','ready',CURRENT_TIMESTAMP)`,
    );
    await c.execute(
      `INSERT INTO "Clip" ("id","videoId","title","startSec","endSec","score","status","favorite","updatedAt") VALUES ('c1','v1','Old clip',1,31,80,'rendered',1,CURRENT_TIMESTAMP)`,
    );
    c.close();

    const applied = await runMigrations(url);
    expect(applied).toEqual(['0003_cp2', '0004_editor', '0005_brand_kit', '0006_posting']);

    const db = await openDatabase(file);
    try {
      const v = await db.prisma.video.findUniqueOrThrow({ where: { id: 'v1' } });
      expect(v.title).toBe('Old video');
      expect(v.subtitleRev).toBe(0);
      const clip = await db.prisma.clip.findUniqueOrThrow({ where: { id: 'c1' } });
      expect(clip).toMatchObject({
        title: 'Old clip',
        score: 80,
        favorite: true,
        status: 'rendered',
        kind: 'clip',
        runId: null,
        captionStyleId: 'clean-pop',
        reframeMode: 'auto',
        layout: null,
        subtitleRev: 0,
        brandKitId: null,
      });
      // new tables work, and chat messages cascade with their thread
      const t = await db.prisma.chatThread.create({ data: { videoId: 'v1', title: 't' } });
      await db.prisma.chatMessage.create({ data: { threadId: t.id, role: 'user', text: 'hi' } });
      await db.prisma.chatThread.delete({ where: { id: t.id } });
      expect(await db.prisma.chatMessage.count()).toBe(0);
      await db.prisma.momentRun.create({ data: { videoId: 'v1', prompt: 'funny' } });
      await db.prisma.marker.create({ data: { videoId: 'v1', atSec: 3, label: 'm' } });
      await db.prisma.captionStylePreset.create({ data: { name: 'mine', spec: '{}' } });
      // CP3 tables: versions cascade with their project; exports survive it (no FK)
      const ep = await db.prisma.editorProject.create({ data: { name: 'p', data: '{}' } });
      await db.prisma.editorVersion.create({ data: { projectId: ep.id, rev: 1, data: '{}' } });
      await db.prisma.editorExport.create({ data: { projectId: ep.id, name: 'e' } });
      await db.prisma.editorProject.delete({ where: { id: ep.id } });
      expect(await db.prisma.editorVersion.count()).toBe(0);
      expect(await db.prisma.editorExport.count()).toBe(1);
      // CP4 tables
      const kit = await db.prisma.brandKit.create({ data: { name: 'k' } });
      await db.prisma.brandAsset.create({
        data: { kitId: kit.id, kind: 'logo', name: 'l', ext: 'png' },
      });
      expect(await db.prisma.brandAsset.count()).toBe(1);
      // CP5 tables
      const acc = await db.prisma.socialAccount.create({
        data: { platform: 'shorts', externalId: 'UC1', displayName: 'Me' },
      });
      await db.prisma.post.create({
        data: { accountId: acc.id, platform: 'shorts', title: 't', fields: '{}', mediaKey: 'k' },
      });
      await db.prisma.quotaUsage.create({ data: { accountId: acc.id, day: '2026-10-15' } });
      await expect(
        db.prisma.socialAccount.create({
          data: { platform: 'shorts', externalId: 'UC1', displayName: 'dup' },
        }),
      ).rejects.toThrow();
      await db.prisma.clip.update({ where: { id: 'c1' }, data: { brandKitId: kit.id } });
    } finally {
      await db.close();
    }
    // idempotent
    expect(await runMigrations(url)).toEqual([]);
  });
});
