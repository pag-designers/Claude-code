import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createClient } from '@libsql/client';

/**
 * A damaged database file (what "database disk image is malformed" means) is repaired by the REAL app at startup:
 * the file is moved aside, a fresh one is built, settings survive, and the user is told. Needs no media.
 */
test.describe.configure({ mode: 'serial' });

let userData = '';
let app: ElectronApplication;
let page: Page;

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

async function launch(): Promise<void> {
  const exe = process.env.CLIPFERN_E2E_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ['--no-sandbox', ...(exe ? [] : ['.'])],
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, CLIPFERN_USER_DATA: userData, CLIPFERN_SKIP_QUIT_CONFIRM: '1' },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
}

test.beforeAll(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-dbrec-'));
});
test.afterAll(async () => {
  await app?.close().catch(() => {});
});

test('a damaged database is repaired at startup, settings survive, the user is told', async () => {
  test.setTimeout(120_000);
  await launch();
  await invoke('settings:set', { r2Bucket: 'my-bucket', r2AccountId: 'acct-123' });
  await app.close();

  // The app is closed: wreck a table page of the database file (the app checkpoints on close: one file).
  const file = path.join(userData, 'clipfern.db');
  expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  const db = createClient({ url: `file:${file}` });
  const root = Number(
    (await db.execute("SELECT rootpage FROM sqlite_master WHERE name = 'CostEvent'")).rows[0]!
      .rootpage,
  );
  const pageSize = Number((await db.execute('PRAGMA page_size')).rows[0]!.page_size);
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  fs.rmSync(`${file}-shm`, { force: true });
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (root - 1) * pageSize);
  fs.closeSync(fd);

  await launch();
  // the app is up and has the settings back
  const s = await invoke<{ r2Bucket: string; r2AccountId: string }>('settings:get');
  expect(s).toMatchObject({ r2Bucket: 'my-bucket', r2AccountId: 'acct-123' });
  // saving works again (this is the exact action that showed "Could not save setting")
  await invoke('settings:set', { r2AccountId: 'acct-456' });
  expect((await invoke<{ r2AccountId: string }>('settings:get')).r2AccountId).toBe('acct-456');
  // the damaged file was kept, not deleted
  expect(fs.readdirSync(userData).some((f) => f.startsWith('clipfern.db.corrupt-'))).toBe(true);
  // and the user was told, in the app
  const n = await invoke<{ items: { title: string; body: string | null }[] }>(
    'notifications:list',
    { limit: 50 },
  );
  const note = n.items.find((x) => /repaired its database/i.test(x.title));
  expect(note?.body).toMatch(/recovered/);
  const log = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).toMatch(/database was damaged/);

  // a third start is clean
  await app.close();
  await launch();
  expect((await invoke<{ r2AccountId: string }>('settings:get')).r2AccountId).toBe('acct-456');
  const logs3 = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  expect(logs3.match(/database was damaged/g)?.length).toBe(1);
});
