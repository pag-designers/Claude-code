import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { ensureCp1Assets } from './cp1-fixtures';
import { installClipfernStub, makeState, type Scenario, type StubState } from './clipfern-stub';
import { serveApp } from './static-server';

/**
 * Browser harness for the renderer e2e/screenshot specs: serves renderer/out + generated media, launches Chromium,
 * and opens pages with the contract-validated `window.clipfern` stub installed. Every session records console
 * errors/warnings, page errors, non-same-origin requests and HTTP >= 400 into `problems`.
 */
/** Override with CLIPFERN_E2E_OUT to test a private snapshot of the export (several agents build renderer/out). */
export const OUT = process.env.CLIPFERN_E2E_OUT ?? path.resolve(__dirname, '../../../renderer/out');

export function findChrome(): string | undefined {
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

export const CHROME = findChrome();
export const canRun = () => !!CHROME && fs.existsSync(path.join(OUT, 'index.html'));

export interface Session {
  page: Page;
  state: StubState;
  problems: string[];
  emit: Awaited<ReturnType<typeof installClipfernStub>>['emit'];
  sim: Awaited<ReturnType<typeof installClipfernStub>>['sim'];
  close: () => Promise<void>;
}

export interface OpenOptions {
  scenario?: Scenario;
  theme?: 'dark' | 'light' | 'system';
  platform?: string;
  width?: number;
  height?: number;
  stub?: boolean;
  collapsed?: boolean;
  reducedMotion?: boolean;
  /** Leave animations/transitions time to settle (ms). */
  settle?: number;
  /** Pre-configure the stub before the page loads. */
  prepare?: (state: StubState) => void;
}

export interface Harness {
  base: string;
  assetHits: string[];
  browser: Browser;
  open: (route: string, opts?: OpenOptions) => Promise<Session>;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  let base: string;
  let closeServer: () => void;
  let assetHits: string[] = [];
  const assets = ensureCp1Assets();
  if (process.env.CLIPFERN_E2E_BASE) {
    base = process.env.CLIPFERN_E2E_BASE;
    closeServer = () => {};
  } else {
    const srv = await serveApp(OUT, assets.dir);
    base = srv.url;
    closeServer = srv.close;
    assetHits = srv.hits;
  }
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const open: Harness['open'] = async (route, opts = {}) => {
    const {
      scenario = 'fresh',
      theme = 'dark',
      platform = 'linux',
      width = 1440,
      height = 900,
      stub = true,
      collapsed = false,
      reducedMotion = false,
      settle = 900,
      prepare,
    } = opts;
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme === 'light' ? 'light' : 'dark',
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
      deviceScaleFactor: 1,
      permissions: ['clipboard-read', 'clipboard-write'],
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
    const state = makeState(scenario, platform, { assetBase: base });
    prepare?.(state);
    let emit: Session['emit'] = async () => {};
    let sim: Session['sim'] = () => {
      throw new Error('stub disabled');
    };
    if (stub) {
      const h = await installClipfernStub(page, state);
      emit = h.emit;
      sim = h.sim;
    }
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
    if (settle) await page.waitForTimeout(settle);
    return { page, state, problems, emit, sim, close: () => context.close() };
  };

  return {
    base,
    assetHits,
    browser,
    open,
    close: async () => {
      await browser.close();
      closeServer();
    },
  };
}
