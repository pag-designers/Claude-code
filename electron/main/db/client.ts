import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { MIGRATIONS } from './migrations.generated';
import { isDbFault } from './faults';

export type Db = PrismaClient;

/** What happened when the database file was found damaged at startup (see `recoverDatabase`). */
export interface RecoveryReport {
  /** Why the file was rejected (the SQLite message). */
  reason: string;
  /** Where the damaged file (and its -wal/-shm) were moved to; nothing is deleted. */
  quarantinedTo: string;
  /** Rows copied into the fresh database, per table. */
  recovered: Record<string, number>;
  /** Rows that could not be read or inserted, per table (tables with none are omitted). */
  lost: Record<string, number>;
}

export interface DbHandle {
  /** Set when the previous file was damaged and has been rebuilt on this start. */
  recovery: RecoveryReport | null;
  /** A stable handle: after `reconnect()` it transparently talks to the new connection. */
  prisma: Db;
  close(): Promise<void>;
  /**
   * Opens a fresh Prisma client + SQLite connection and retires the old one. The answer to a connection that went bad
   * (`disk I/O error`, file locks dropped by the OS): every later call uses the new connection.
   */
  reconnect(): Promise<void>;
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
  let recovery: RecoveryReport | null = null;
  if (filePath !== ':memory:' && fs.existsSync(filePath)) {
    const problem = await findProblem(url);
    if (problem) recovery = await recoverDatabase(filePath, problem);
  }
  let current = await connect(url);
  try {
    await applyMigrations(current);
  } catch (e) {
    await current.$disconnect();
    throw e;
  }
  // One stable object for every service; `reconnect()` swaps what it forwards to.
  const prisma = new Proxy({} as Db, {
    get(_t, prop) {
      const v = Reflect.get(current as object, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
    },
    has: (_t, prop) => prop in (current as object),
  });
  let swapping: Promise<void> = Promise.resolve();
  // The retired connection stays open for a moment so queries already running on it can finish.
  const retired = new Set<Db>();
  const RETIRE_AFTER_MS = 5_000;
  return {
    prisma,
    recovery,
    close: async () => {
      // Fold the write-ahead log into the main file so a closed database is one self-contained file.
      await current.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
      const all = [current, ...retired];
      retired.clear();
      await Promise.allSettled(all.map((c) => c.$disconnect()));
    },
    reconnect: () => {
      swapping = swapping.then(async () => {
        const fresh = await connect(url);
        const old = current;
        current = fresh;
        retired.add(old);
        const t = setTimeout(() => {
          if (retired.delete(old)) void old.$disconnect().catch(() => {});
        }, RETIRE_AFTER_MS);
        t.unref?.();
      });
      return swapping;
    },
  };
}

/**
 * `null` when the database is sound, else the SQLite message. Runs BEFORE the real connection is opened and uses the
 * same SQLite build (ADR-022), so no locks of another build are involved.
 */
async function findProblem(url: string): Promise<string | null> {
  const prisma = new PrismaClient({ adapter: new PrismaLibSQL({ url }) });
  try {
    await prisma.$connect();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA quick_check');
    const msgs = rows.map((r) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? null : msgs.slice(0, 3).join('; ');
  } catch (e) {
    if (isDbFault(e)) return e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/**
 * A damaged database is moved aside (never deleted), a fresh one is created and migrated, and every row that can still
 * be read is copied over table by table, row by row (a bad page costs only the rows on it).
 */
export async function recoverDatabase(filePath: string, reason: string): Promise<RecoveryReport> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantined = `${filePath}.corrupt-${stamp}`;
  for (const ext of ['', '-wal', '-shm'])
    if (fs.existsSync(filePath + ext)) fs.renameSync(filePath + ext, quarantined + ext);
  const url = `file:${filePath}`;
  const fresh = await connect(url);
  await applyMigrations(fresh);
  const old = new PrismaClient({ adapter: new PrismaLibSQL({ url: `file:${quarantined}` }) });
  const recovered: Record<string, number> = {};
  const lost: Record<string, number> = {};
  try {
    const tables = (
      await fresh.$queryRawUnsafe<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_clipfern_migrations'",
      )
    ).map((t) => t.name);
    const retry: { table: string; cols: string[]; values: unknown[] }[] = [];
    for (const t of tables) {
      recovered[t] = 0;
      let cols: string[] = [];
      try {
        const mine = (
          await fresh.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${q(t)})`)
        ).map((c) => c.name);
        const theirs = new Set(
          (await old.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(${q(t)})`)).map(
            (c) => c.name,
          ),
        );
        cols = mine.filter((c) => theirs.has(c));
      } catch {
        lost[t] = (lost[t] ?? 0) + 1; // the whole table definition was unreadable
        continue;
      }
      if (!cols.length) continue;
      const list = cols.map(q).join(', ');
      const insert = `INSERT OR IGNORE INTO ${q(t)} (${list}) VALUES (${cols.map(() => '?').join(', ')})`;
      let last = -1n;
      let failures = 0;
      for (;;) {
        let rows: Record<string, unknown>[];
        try {
          rows = await old.$queryRawUnsafe<Record<string, unknown>[]>(
            `SELECT rowid AS __rid, ${list} FROM ${q(t)} WHERE rowid > ${last} ORDER BY rowid LIMIT 100`,
          );
        } catch {
          // an unreadable page: step over it one rowid at a time (bounded)
          last += 1n;
          lost[t] = (lost[t] ?? 0) + 1;
          if (++failures > 2000) break;
          continue;
        }
        if (!rows.length) break;
        for (const r of rows) {
          last = BigInt(r.__rid as bigint | number);
          const values = cols.map((c) => r[c]);
          try {
            await fresh.$executeRawUnsafe(insert, ...values);
            recovered[t] = (recovered[t] ?? 0) + 1;
          } catch {
            retry.push({ table: t, cols, values }); // often a foreign key whose parent comes later
          }
        }
      }
    }
    for (const { table, cols, values } of retry) {
      try {
        await fresh.$executeRawUnsafe(
          `INSERT OR IGNORE INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          ...values,
        );
        recovered[table] = (recovered[table] ?? 0) + 1;
      } catch {
        lost[table] = (lost[table] ?? 0) + 1;
      }
    }
  } finally {
    await old.$disconnect().catch(() => {});
    await fresh.$disconnect().catch(() => {});
  }
  return { reason, quarantinedTo: quarantined, recovered, lost };
}

async function connect(url: string): Promise<Db> {
  const adapter = new PrismaLibSQL({ url });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  return prisma;
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
