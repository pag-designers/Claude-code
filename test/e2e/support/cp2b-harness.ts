/**
 * Browser harness for UI-B specs. Same contract-validated `window.clipfern` bridge as harness.ts, plus the CP2 stub
 * (`stubB`) for the clip-intelligence channels. Independent of the main stub's merge state: the bridge routes exactly
 * `STUB_B_CHANNELS` to stubB (validated against the real zod contract) and everything else to the main stub.
 *
 * `CP2B_OUT` selects the exported renderer (default renderer/out) so a private build can be tested while other agents
 * rebuild renderer/out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { invokeContract, type InvokeChannel } from '../../../shared/ipc';
import { findChrome } from './harness';
import { ensureCp1Assets } from './cp1-fixtures';
import { installClipfernStub, makeState, type Scenario, type StubState } from './clipfern-stub';
import { serveApp } from './static-server';
import { STUB_B_CHANNELS, controls, stubB, type StubBControls } from './cp2-stub-b';

export const OUT_B = process.env.CP2B_OUT
  ? path.resolve(process.env.CP2B_OUT)
  : path.resolve(__dirname, '../../../renderer/out');
export const CHROME_B = findChrome();
export const canRunB = () => !!CHROME_B && fs.existsSync(path.join(OUT_B, 'index.html'));

export interface SessionB {
  page: Page;
  state: StubState;
  ctl: StubBControls;
  problems: string[];
  emit: Awaited<ReturnType<typeof installClipfernStub>>['emit'];
  close: () => Promise<void>;
}

export interface OpenB {
  scenario?: Scenario;
  theme?: 'dark' | 'light';
  width?: number;
  height?: number;
  settle?: number;
  reducedMotion?: boolean;
  prepare?: (state: StubState, ctl: StubBControls) => void;
}

export interface HarnessB {
  base: string;
  browser: Browser;
  assetHits: string[];
  open: (route: string, opts?: OpenB) => Promise<SessionB>;
  close: () => Promise<void>;
}

export async function createHarnessB(): Promise<HarnessB> {
  const assets = ensureCp1Assets();
  const srv = await serveApp(OUT_B, assets.dir);
  const base = srv.url;
  const browser = await chromium.launch({
    executablePath: CHROME_B,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const open: HarnessB['open'] = async (route, opts = {}) => {
    const {
      scenario = 'library',
      theme = 'dark',
      width = 1440,
      height = 900,
      settle = 500,
      reducedMotion = false,
      prepare,
    } = opts;
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
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
    const state = makeState(scenario, 'linux', { assetBase: base });
    const ctl = controls(state);
    prepare?.(state, ctl);

    const h = await installClipfernStub(page, state);
    await page.exposeFunction('__stubBInvoke', async (channel: string, payload: unknown) => {
      const spec = invokeContract[channel as InvokeChannel];
      const input = spec.input.parse(payload);
      state.calls.push({ channel, payload: input });
      const res = await stubB.handle(state, channel, input);
      if (!res) throw new Error(`stubB does not handle ${channel}`);
      return spec.output.parse(res.value);
    });
    await page.addInitScript(
      (channels: string[]) => {
        const w = window as unknown as {
          clipfern: { invoke: (c: string, p?: unknown) => Promise<unknown> };
          __stubBInvoke: (c: string, p?: unknown) => Promise<unknown>;
        };
        const orig = w.clipfern.invoke;
        w.clipfern.invoke = (c, p) => (channels.includes(c) ? w.__stubBInvoke(c, p) : orig(c, p));
      },
      [...STUB_B_CHANNELS],
    );
    await page.addInitScript(
      ([t]) => {
        try {
          localStorage.setItem('clipfern.theme', t as string);
        } catch {
          /* ignore */
        }
      },
      [theme] as const,
    );
    await page.goto(base + route);
    await page.locator('nav[aria-label="Main"]').waitFor();
    await page.waitForLoadState('networkidle');
    if (settle) await page.waitForTimeout(settle);
    return { page, state, ctl, problems, emit: h.emit, close: () => context.close() };
  };

  return {
    base,
    browser,
    assetHits: srv.hits,
    open,
    close: async () => {
      await browser.close();
      srv.close();
    },
  };
}
