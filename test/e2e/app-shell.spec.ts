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

/**
 * Launches the REAL built app (dist-electron + renderer/out) in an isolated userData dir and
 * exercises the security boundary and the IPC bridge end to end.
 * Run: pnpm build && xvfb-run -a pnpm test:e2e
 */
let app: ElectronApplication;
let page: Page;
let userData: string;
const shots = process.env.CLIPFERN_SHOTS_DIR;

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-e2e-'));
  // CLIPFERN_E2E_EXE points at a packaged binary (release/linux-unpacked/clipfern) to test the installer output.
  const exe = process.env.CLIPFERN_E2E_EXE;
  app = await electron.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: exe ? ['--no-sandbox'] : ['--no-sandbox', '.'],
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      CLIPFERN_USER_DATA: userData,
      ANTHROPIC_API_KEY: '',
      R2_ACCESS_KEY_ID: '',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

const invoke = <T = unknown>(channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { clipfern: { invoke(c: string, p?: unknown): Promise<unknown> } }
      ).clipfern.invoke(c as string, p) as Promise<T>,
    [channel, payload] as const,
  );

test('window is sandboxed: no node, no process, no require in the renderer', async () => {
  const leaks = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    buffer: typeof (window as unknown as { Buffer?: unknown }).Buffer,
  }));
  expect(leaks).toEqual({ require: 'undefined', process: 'undefined', buffer: 'undefined' });
});

test('app loads from the app:// protocol with a strict CSP and the right title', async () => {
  expect(page.url()).toMatch(/^app:\/\/clipfern\//);
  await expect(page).toHaveTitle(/Clipfern/);
  const csp = await page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  );
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
});

test('app:info reports the real runtime', async () => {
  const info = await invoke<{
    name: string;
    electron: string;
    userData: string;
    isPackaged: boolean;
  }>('app:info');
  expect(info.name).toBe('Clipfern');
  expect(info.electron).toMatch(/^\d+\./);
  expect(info.userData).toBe(userData);
});

test('IPC rejects unknown channels and invalid payloads with typed errors', async () => {
  const unknown = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { clipfern: { invoke(c: string): Promise<unknown> } }
      ).clipfern.invoke('fs:readFile');
      return 'no-error';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(unknown).toMatch(/^\[\[UNKNOWN_CHANNEL\]\]/);
  const invalid = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { clipfern: { invoke(c: string, p: unknown): Promise<unknown> } }
      ).clipfern.invoke('settings:set', { concurrency: 1000 });
      return 'no-error';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(invalid).toMatch(/^\[\[VALIDATION\]\]/);
});

test('settings persist to SQLite and secrets are masked + encrypted on disk', async () => {
  const s = await invoke<{ theme: string; cacheCapGb: number }>('settings:set', {
    theme: 'light',
    cacheCapGb: 33,
  });
  expect(s).toMatchObject({ theme: 'light', cacheCapGb: 33 });
  expect(fs.existsSync(path.join(userData, 'clipfern.db'))).toBe(true);

  await invoke('secrets:set', { key: 'pexels.apiKey', value: 'pexels-SECRET-VALUE-9876' });
  const st = await invoke<{
    keys: Record<string, { set: boolean; masked: string | null; source: string | null }>;
  }>('secrets:status');
  expect(st.keys['pexels.apiKey']).toEqual({ set: true, masked: '••••9876', source: 'store' });
  expect(JSON.stringify(st)).not.toContain('SECRET-VALUE');
  const disk = fs.readFileSync(path.join(userData, 'secrets.bin'));
  expect(disk.toString('utf8')).not.toContain('SECRET-VALUE');
  await invoke('secrets:clear', { key: 'pexels.apiKey' });
});

test('storage is honestly reported as not configured (no fake numbers)', async () => {
  const u = await invoke<{ configured: boolean; usedBytes: number; error: string | null }>(
    'storage:usage',
    { refresh: true },
  );
  expect(u.configured).toBe(false);
  expect(u.usedBytes).toBe(0);
  expect(u.error).toMatch(/Cloudflare R2 is missing/);
});

test('durable queue ran the startup jobs', async () => {
  await expect
    .poll(
      async () =>
        (
          await invoke<{ items: { kind: string; status: string }[] }>('jobs:list', { limit: 20 })
        ).items.map((j) => `${j.kind}:${j.status}`),
      { timeout: 30_000 },
    )
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^storage\.refresh-usage:(succeeded|failed)$/),
        expect.stringMatching(/^binaries\.ensure-ytdlp:/),
      ]),
    );
});

test('ffmpeg and ffprobe are bundled and runnable', async () => {
  const { tools } = await invoke<{
    tools: { name: string; ok: boolean; version: string | null }[];
  }>('binaries:status');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const t = tools.find((x) => x.name === name);
    expect(t?.ok, `${name} should be ok`).toBe(true);
    expect(t?.version).toBeTruthy();
  }
});

test('theme setting is applied to the document before paint and survives reload', async () => {
  await invoke('settings:set', { theme: 'dark' });
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { clipfern?: unknown }).clipfern);
  const theme = await page.evaluate(
    () => document.documentElement.dataset.theme ?? document.documentElement.className,
  );
  expect(String(theme)).toMatch(/dark/);
});

test('every sidebar destination renders without console errors', async () => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  for (const name of [
    'Home',
    'Library',
    'Editor',
    'Scheduler',
    'Brand Kit',
    'Whop',
    'Tools',
    'Settings',
  ]) {
    await page
      .getByRole('link', { name: new RegExp(`^${name}`) })
      .first()
      .click();
    await page.waitForTimeout(350);
    await expect(page.locator('main')).toBeVisible();
    if (shots)
      await page.screenshot({
        path: path.join(shots, `app-${name.replace(/\s/g, '-').toLowerCase()}.png`),
      });
  }
  expect(errors).toEqual([]);
});

test('full-page loads and reloads never log hydration errors (React #418 regression, real app:// path)', async () => {
  const errors: string[] = [];
  const onErr = (e: Error) => errors.push(`pageerror: ${e.message}`);
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  };
  page.on('pageerror', onErr);
  page.on('console', onConsole);
  const routes = [
    '/',
    '/settings/compute/',
    '/library/',
    '/',
    '/settings/api-keys/',
    '/tools/',
    '/',
  ];
  for (let round = 0; round < 3; round++) {
    for (const r of routes) {
      await page.goto(`app://clipfern${r}`);
      await page.getByRole('navigation', { name: 'Main' }).waitFor();
      await page.waitForTimeout(250);
    }
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.waitForTimeout(250);
  }
  page.off('pageerror', onErr);
  page.off('console', onConsole);
  expect(errors).toEqual([]);
});

test('transcription engine reports an honest not-installed state on a fresh machine', async () => {
  const s = await invoke<{
    phase: string;
    installed: boolean;
    modelReady: boolean;
    error: string | null;
    model: string;
  }>('sidecar:status');
  expect(s.installed).toBe(false);
  expect(s.modelReady).toBe(false);
  expect(s.phase).toBe('idle');
  expect(s.error).toBeNull();
  expect(s.model).toBeTruthy();
  const hw = await invoke<{ cpuCores: number; encoders: string[] }>('system:hardware');
  expect(hw.cpuCores).toBeGreaterThan(0);
  expect(hw.encoders).toContain('libx264');
});
