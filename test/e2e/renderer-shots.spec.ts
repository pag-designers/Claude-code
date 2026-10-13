import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import {
  installClipfernStub,
  makeState,
  stubNotification,
  type Scenario,
  type StubState,
} from './support/clipfern-stub';

/**
 * Renderer visual + behaviour check. Serves renderer/out statically, injects the contract-validated
 * `window.clipfern` stub (test/e2e/support/clipfern-stub.ts) and screenshots every page in dark and light.
 *   pnpm build:renderer && npx playwright test test/e2e/renderer-shots.spec.ts
 * Screenshots go to $CLIPFERN_SHOTS_DIR (default: .tmp/shots). Skips when renderer/out or Chromium is missing.
 */
const OUT = path.resolve(__dirname, '../../renderer/out');
const SHOTS = process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots');

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  for (const d of fs
    .readdirSync(root)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort()
    .reverse()) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const CHROME = findChrome();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serve(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = path.join(OUT, u);
    if (!file.startsWith(OUT)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

const ROUTES: [string, string][] = [
  ['home', '/'],
  ['library', '/library/'],
  ['editor', '/editor/'],
  ['scheduler', '/scheduler/'],
  ['brand-kit', '/brand-kit/'],
  ['whop', '/whop/'],
  ['tools', '/tools/'],
  ['notifications', '/notifications/'],
  ['design', '/design/'],
  ['settings-general', '/settings/general/'],
  ['settings-api-keys', '/settings/api-keys/'],
  ['settings-storage', '/settings/storage/'],
  ['settings-models', '/settings/models/'],
  ['settings-compute', '/settings/compute/'],
  ['settings-ingest', '/settings/ingest/'],
  ['settings-integrations', '/settings/integrations/'],
  ['settings-diagnostics', '/settings/diagnostics/'],
  ['settings-shortcuts', '/settings/shortcuts/'],
];

let base: string;
let closeServer: () => void;
let browser: Browser;

test.skip(
  !CHROME || !fs.existsSync(path.join(OUT, 'index.html')),
  'needs a Chromium binary and a built renderer/out',
);

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (process.env.CLIPFERN_E2E_BASE) {
    base = process.env.CLIPFERN_E2E_BASE;
    closeServer = () => {};
  } else {
    ({ url: base, close: closeServer } = await serve());
  }
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
});
test.afterAll(async () => {
  await browser?.close();
  closeServer?.();
});

interface Session {
  page: Page;
  state: StubState;
  problems: string[];
  emit: Awaited<ReturnType<typeof installClipfernStub>>['emit'];
  close: () => Promise<void>;
}

async function open(
  route: string,
  opts: {
    scenario?: Scenario;
    theme?: 'dark' | 'light' | 'system';
    platform?: string;
    width?: number;
    height?: number;
    stub?: boolean;
    collapsed?: boolean;
  } = {},
): Promise<Session> {
  const {
    scenario = 'fresh',
    theme = 'dark',
    platform = 'linux',
    width = 1440,
    height = 900,
    stub = true,
    collapsed = false,
  } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme === 'light' ? 'light' : 'dark',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message} @ ${page.url()}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:'))
      problems.push(`EXTERNAL REQUEST: ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  const state = makeState(scenario, platform);
  let emit: Session['emit'] = async () => {};
  if (stub) emit = (await installClipfernStub(page, state)).emit;
  await context.addInitScript(
    ([t, c]) => {
      try {
        localStorage.setItem('clipfern.theme', t as string);
        if (c) localStorage.setItem('clipfern.sidebar', 'collapsed');
      } catch {
        /* ignore */
      }
    },
    [theme, collapsed] as const,
  );
  await page.goto(base + route);
  if (stub) await page.locator('nav[aria-label="Main"]').waitFor();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(900); // let page transition + score/progress animations settle
  return { page, state, problems, emit, close: () => context.close() };
}

const shot = (s: Session, name: string) =>
  s.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

test.describe('every page, dark and light', () => {
  test.setTimeout(10 * 60_000);
  for (const scenario of ['fresh', 'configured'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${scenario} / ${theme}`, async () => {
        const all: string[] = [];
        for (const [name, route] of ROUTES) {
          const s = await open(route, { scenario, theme });
          await expect(s.page.locator('html')).toHaveAttribute('data-theme', theme);
          await shot(s, `${scenario}-${name}-${theme}`);
          all.push(...s.problems.map((p) => `${name}: ${p}`));
          await s.close();
        }
        expect(all, 'console errors / external requests / HTTP errors').toEqual([]);
      });
    }
  }
});

test('without the desktop bridge a clear notice is shown (no crash)', async () => {
  const s = await open('/', { stub: false });
  await expect(s.page.getByRole('heading', { name: /Open Clipfern.s desktop app/ })).toBeVisible();
  await shot(s, 'no-bridge-dark');
  expect(s.problems).toEqual([]);
  await s.close();
});

test('home: URL validation, disabled start with tooltip, live checklist', async () => {
  const s = await open('/', { scenario: 'configured' });
  const input = s.page.getByRole('textbox', { name: 'YouTube URL' });
  await input.fill('https://vimeo.com/12345');
  await input.blur();
  await expect(s.page.getByText(/not a YouTube link/i)).toBeVisible();
  await input.fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(s.page.getByText('dQw4w9WgXcQ')).toBeVisible();
  await expect(s.page.getByRole('button', { name: /Start clipping/ })).toBeDisabled();
  await s.page
    .locator('span[tabindex="0"]')
    .filter({ has: s.page.getByRole('button', { name: /Start clipping/ }) })
    .hover();
  await expect(s.page.getByRole('tooltip').first()).toContainText(
    'Pipeline arrives in the next checkpoint',
  );
  await shot(s, 'home-valid-url-dark');
  // checklist reflects real stub state: anthropic set, storage configured, sidecar ready
  await expect(s.page.getByText('4 / 4')).toBeVisible();
  await expect(s.page.getByText('Running jobs')).toBeVisible();
  await expect(s.page.getByText('Transcribe', { exact: false }).first()).toBeVisible();
  expect(s.problems).toEqual([]);
  await s.close();
});

test('shell: palette, notifications popover + event, storage dialog, theme toggle, collapse', async () => {
  const s = await open('/', { scenario: 'configured' });
  await s.page.keyboard.press('Control+k');
  await expect(s.page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await s.page.waitForTimeout(300);
  await shot(s, 'palette-dark');
  await s.page.keyboard.type('storage settings');
  await s.page.waitForTimeout(150);
  await shot(s, 'palette-search-dark');
  await s.page.keyboard.press('Enter');
  await expect(s.page).toHaveURL(/\/settings\/storage\/$/);

  await s.page.getByRole('button', { name: /^Notifications, 2 unread/ }).click();
  await s.page.waitForTimeout(250);
  await shot(s, 'notifications-popover-dark');
  await s.page.keyboard.press('Escape');

  await s.emit(
    'notifications:new',
    stubNotification({
      id: 'n9',
      title: 'First clips are ready',
      body: '6 clips found in “Podcast ep. 12”.',
      level: 'success',
      kind: 'clips-ready',
      href: '/library/',
    }),
  );
  await expect(s.page.getByText('First clips are ready').first()).toBeVisible();
  await s.page.waitForTimeout(400);
  await shot(s, 'toast-dark');

  await s.page.getByRole('button', { name: /Manage storage/ }).click();
  await expect(s.page.getByRole('dialog', { name: 'Cloud storage' })).toBeVisible();
  await s.page.waitForTimeout(400);
  await shot(s, 'storage-dialog-configured-dark');
  await s.page.keyboard.press('Escape');

  await s.page.getByRole('button', { name: /^Theme/ }).click();
  await s.page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(s.page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => s.state.settings.theme).toBe('light');
  expect(await s.page.evaluate(() => localStorage.getItem('clipfern.theme'))).toBe('light');

  await s.page.keyboard.press('Control+b');
  await expect(s.page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect.poll(() => s.state.settings.sidebarCollapsed).toBe(true);
  // regression: a partial settings patch must not reset other settings (zod defaults re-applied by .partial())
  expect(s.state.settings.theme).toBe('light');
  await expect(s.page.locator('html')).toHaveAttribute('data-theme', 'light');
  await s.page.waitForTimeout(500);
  await shot(s, 'sidebar-collapsed-light');
  expect(s.problems).toEqual([]);
  await s.close();
});

test('storage dialog not configured state', async () => {
  const s = await open('/', { scenario: 'fresh' });
  await s.page
    .getByRole('button', { name: /Storage/ })
    .first()
    .click();
  await expect(s.page.getByText('Not configured')).toBeVisible();
  await s.page.waitForTimeout(400);
  await shot(s, 'storage-dialog-fresh-dark');
  await s.close();
});

test('api keys: save, masked display, test chip, clear', async () => {
  const s = await open('/settings/api-keys/', { scenario: 'fresh' });
  const field = s.page.getByLabel('API key', { exact: true }).first();
  await field.fill('sk-ant-api03-abcdefghij1234');
  await s.page.getByRole('button', { name: 'Save' }).first().click();
  await expect(s.page.getByText('••••1234')).toBeVisible();
  await s.page.getByRole('button', { name: 'Test' }).first().click();
  await expect(s.page.getByText(/Connected · 184 ms/)).toBeVisible();
  await shot(s, 'api-keys-tested-dark');
  await s.page.getByRole('button', { name: 'Clear' }).first().click();
  await s.page.getByRole('button', { name: 'Confirm clear' }).click();
  await expect(s.page.getByText('••••1234')).toHaveCount(0);
  expect(s.problems).toEqual([]);
  await s.close();
});

test('storage form validates and saves', async () => {
  const s = await open('/settings/storage/', { scenario: 'fresh', theme: 'dark' });
  await s.page.getByLabel('Account ID').fill('nothex');
  await expect(s.page.getByText(/32 hexadecimal/)).toBeVisible();
  await shot(s, 'settings-storage-invalid-dark');
  await s.page.getByLabel('Account ID').fill('0123456789abcdef0123456789abcdef');
  await s.page.getByLabel('Bucket').fill('clipfern-media');
  await s.page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => s.state.settings.r2Bucket).toBe('clipfern-media');
  expect(s.problems).toEqual([]);
  await s.close();
});

test('platform chrome: macOS traffic-light room and Windows controls inset, ultrawide', async () => {
  const mac = await open('/', { scenario: 'configured', platform: 'darwin' });
  await shot(mac, 'platform-darwin-dark');
  await mac.close();
  const win = await open('/library/', {
    scenario: 'configured',
    platform: 'win32',
    theme: 'light',
  });
  await shot(win, 'platform-win32-light');
  await win.close();
  const wide = await open('/', { scenario: 'configured', width: 2560, height: 1200 });
  await shot(wide, 'ultrawide-home-dark');
  await wide.close();
  const small = await open('/', {
    scenario: 'configured',
    width: 1280,
    height: 720,
    theme: 'light',
  });
  await shot(small, 'min-1280-home-light');
  await small.close();
});

test('scheduler views switch', async () => {
  const s = await open('/scheduler/', { scenario: 'configured' });
  await s.page.getByRole('radio', { name: 'Week' }).click();
  await s.page.waitForTimeout(400);
  await shot(s, 'scheduler-week-dark');
  await s.page.getByRole('radio', { name: 'Day' }).click();
  await s.page.waitForTimeout(300);
  await shot(s, 'scheduler-day-dark');
  expect(s.problems).toEqual([]);
  await s.close();
});

test.describe('tall viewport (shows content below the fold)', () => {
  test.setTimeout(5 * 60_000);
  const TALL: [string, string][] = [
    ['home', '/'],
    ['tools', '/tools/'],
    ['brand-kit', '/brand-kit/'],
    ['settings-storage', '/settings/storage/'],
    ['settings-models', '/settings/models/'],
    ['settings-compute', '/settings/compute/'],
    ['settings-integrations', '/settings/integrations/'],
    ['settings-diagnostics', '/settings/diagnostics/'],
    ['settings-api-keys', '/settings/api-keys/'],
    ['design', '/design/'],
  ];
  for (const theme of ['dark', 'light'] as const) {
    test(`tall / ${theme}`, async () => {
      const problems: string[] = [];
      for (const [name, route] of TALL) {
        const s = await open(route, { scenario: 'configured', theme, height: 2000 });
        await shot(s, `tall-${name}-${theme}`);
        problems.push(...s.problems);
        await s.close();
      }
      expect(problems).toEqual([]);
    });
  }
});

test('live events update the UI: storage, jobs, sidecar progress', async () => {
  const s = await open('/settings/compute/', { scenario: 'fresh' });
  await expect(s.page.getByRole('button', { name: 'Install transcription engine' })).toBeVisible();
  await s.emit('sidecar:progress', {
    phase: 'installing-packages',
    progress: 0.35,
    message: 'Installing faster-whisper (3/9)',
    installed: false,
    modelReady: false,
    model: 'large-v3-turbo',
    device: null,
    port: null,
    error: null,
    logTail: ['uv pip install faster-whisper', 'Resolved 24 packages in 410ms'],
  });
  await expect(s.page.getByText('Installing faster-whisper (3/9)')).toBeVisible();
  await expect(s.page.getByText('35%')).toBeVisible();
  await s.page.getByRole('button', { name: /Engine log/ }).click();
  await expect(s.page.getByText('Resolved 24 packages')).toBeVisible();
  await s.page.waitForTimeout(400);
  await shot(s, 'compute-engine-installing-dark');

  // storage ring in the sidebar follows storage:updated
  await expect(s.page.getByText('Not connected').first()).toBeVisible();
  await s.emit('storage:updated', {
    configured: true,
    provider: 'r2',
    usedBytes: 8.4e9,
    objectCount: 311,
    limitBytes: 10e9,
    fraction: 0.84,
    breakdown: { videos: 6e9, clips: 2e9, renders: 0.3e9, assets: 0.1e9, thumbs: 0, other: 0 },
    projectedMonthlyUsd: 0,
    updatedAt: Date.now(),
    error: null,
  });
  await expect(s.page.getByText('8.40 GB / 10 GB')).toBeVisible();
  await s.page.getByRole('button', { name: /Manage storage/ }).click();
  await expect(s.page.getByText('Above 80% of free tier')).toBeVisible();
  await s.page.waitForTimeout(400);
  await shot(s, 'storage-dialog-warning-dark');
  await s.page.keyboard.press('Escape');

  // jobs:updated flows into the Home list
  await s.page.goto(`${base}/`);
  await s.page.getByRole('navigation', { name: 'Main' }).waitFor();
  await s.emit('jobs:updated', {
    id: 'job-live',
    kind: 'pipeline.render',
    status: 'running',
    progress: 0.6,
    stage: 'encoding',
    attempts: 1,
    maxAttempts: 3,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
  });
  await expect(s.page.getByText('Pipeline render')).toBeVisible();
  await expect(s.page.getByText('60%')).toBeVisible();
  expect(s.problems).toEqual([]);
  await s.close();
});

test('keyboard: global shortcuts navigate', async () => {
  const s = await open('/', { scenario: 'configured' });
  await s.page.keyboard.press('Control+2');
  await expect(s.page).toHaveURL(/\/library\/$/);
  await s.page.keyboard.press('Control+,');
  await expect(s.page).toHaveURL(/\/settings\/general\/$/);
  await s.page.keyboard.press('Control+8');
  await expect(s.page).toHaveURL(/\/settings\/general\/$/);
  expect(s.problems).toEqual([]);
  await s.close();
});

test('hydration is clean when navigating between full page loads (regression: React #418)', async () => {
  test.setTimeout(120_000);
  const bad: string[] = [];
  for (let i = 0; i < 8; i++) {
    const s = await open('/settings/compute/', { scenario: 'fresh' });
    await s.page.goto(`${base}/`);
    await s.page.getByRole('navigation', { name: 'Main' }).waitFor();
    await s.page.waitForTimeout(400);
    bad.push(...s.problems);
    await s.close();
  }
  expect(bad).toEqual([]);
});
