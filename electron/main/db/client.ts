import { PrismaClient } from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';
import { MIGRATIONS } from './migrations.generated';

export type Db = PrismaClient;

export interface DbHandle {
  prisma: Db;
  close(): Promise<void>;
}

/** Opens (and migrates) a SQLite database through Prisma + the libsql driver adapter (ADR-004). */
export async function openDatabase(filePath: string): Promise<DbHandle> {
  const url = filePath === ':memory:' ? 'file::memory:' : `file:${filePath}`;
  await runMigrations(url);
  const adapter = new PrismaLibSQL({ url });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  return { prisma, close: () => prisma.$disconnect() };
}

/**
 * Minimal embedded migration runner: applies each embedded migration once, in order,
 * tracking them in `_clipfern_migrations`. (`prisma migrate deploy` is a CLI and is not
 * available inside a packaged app.)
 */
export async function runMigrations(url: string): Promise<string[]> {
  const client = createClient({ url });
  const applied: string[] = [];
  try {
    await client.execute(
      'CREATE TABLE IF NOT EXISTS _clipfern_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)',
    );
    const done = new Set(
      (await client.execute('SELECT name FROM _clipfern_migrations')).rows.map((r) =>
        String(r.name),
      ),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
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
      await client.batch(
        [
          ...statements,
          {
            sql: 'INSERT INTO _clipfern_migrations (name, appliedAt) VALUES (?, ?)',
            args: [m.name, new Date().toISOString()],
          },
        ],
        'write',
      );
      applied.push(m.name);
    }
  } finally {
    client.close();
  }
  return applied;
}
