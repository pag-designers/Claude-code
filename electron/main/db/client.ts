import { PrismaClient } from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { MIGRATIONS } from './migrations.generated';

export type Db = PrismaClient;

export interface DbHandle {
  prisma: Db;
  close(): Promise<void>;
}

/**
 * Opens (and migrates) a SQLite database through Prisma + the libsql driver adapter (ADR-004).
 *
 * ONE SQLite library per process (ADR-022): the adapter bundles its own libsql build (0.3.x), while `@libsql/client`
 * at the top level is a different build (0.5+). SQLite's POSIX file locks belong to the process, not to the library
 * instance, so closing a connection of one build silently drops the locks the other build holds on the same file, which
 * surfaces as random "disk I/O error" / "database disk image is malformed". Migrations therefore run through the very
 * same Prisma connection, and the second build is never loaded by the app (only by tests via `runMigrations(url)`).
 */
export async function openDatabase(filePath: string): Promise<DbHandle> {
  const url = filePath === ':memory:' ? 'file::memory:' : `file:${filePath}`;
  const adapter = new PrismaLibSQL({ url });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  try {
    await applyMigrations(prisma);
  } catch (e) {
    await prisma.$disconnect();
    throw e;
  }
  return { prisma, close: () => prisma.$disconnect() };
}

/** Splits an embedded migration into single statements (comments dropped). */
function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Minimal embedded migration runner: applies each embedded migration once, in order,
 * tracking them in `_clipfern_migrations`. (`prisma migrate deploy` is a CLI and is not
 * available inside a packaged app.) Each migration and its bookkeeping row commit together.
 */
export async function applyMigrations(prisma: Db): Promise<string[]> {
  const applied: string[] = [];
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS _clipfern_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)',
  );
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    'SELECT name FROM _clipfern_migrations',
  );
  const done = new Set(rows.map((r) => String(r.name)));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await prisma.$transaction([
      ...statementsOf(m.sql).map((st) => prisma.$executeRawUnsafe(st)),
      prisma.$executeRawUnsafe(
        'INSERT INTO _clipfern_migrations (name, appliedAt) VALUES (?, ?)',
        m.name,
        new Date().toISOString(),
      ),
    ]);
    applied.push(m.name);
  }
  return applied;
}

/**
 * Standalone runner on its own connection, for TESTS that prepare a database before the app code opens it. Never call it
 * from application code (see `openDatabase`): it loads the second SQLite build.
 */
export async function runMigrations(url: string): Promise<string[]> {
  const { createClient } = await import('@libsql/client');
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
      await client.batch(
        [
          ...statementsOf(m.sql),
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
