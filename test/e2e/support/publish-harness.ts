/**
 * Browser harness for the CP5 renderer specs. Same contract-validated `window.clipfern` bridge as cp2b-harness.ts
 * (every payload and result is run through the real zod contract), plus:
 *  - a fixed browser clock (`page.clock`) so calendars are deterministic and agree with the stub's FIXED_NOW,
 *  - the publish layer (publish-stub.ts) installed per session.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-*.spec.ts
 */
import { invokeContract, type InvokeChannel } from '../../../shared/ipc';
import { createHarnessB, canRunB, type HarnessB } from './cp2b-harness';
import { installClipfernStub, makeState, type Scenario } from './clipfern-stub';
import { STUB_B_CHANNELS, controls, stubB } from './cp2-stub-b';
import {
  FIXED_NOW,
  installPublishLib,
  type InstallOptions,
  type PublishLib,
} from './publish-stub';
import type { Page } from '@playwright/test';
import type { StubState } from './clipfern-stub';

export { canRunB, createHarnessB, FIXED_NOW };

export interface PubSession {
  page: Page;
  state: StubState;
  lib: PublishLib;
  problems: string[];
  emit: Awaited<ReturnType<typeof installClipfernStub>>['emit'];
  close: () => Promise<void>;
}

export interface PubOpen extends InstallOptions {
  scenario?: Scenario;
  theme?: 'dark' | 'light';
  width?: number;
  height?: number;
  settle?: number;
  reducedMotion?: boolean;
  /** Called before the page loads (set lib fields, fail plans, ...). */
  prepare?: (lib: PublishLib, state: StubState) => void;
  /** Freeze the browser at FIXED_NOW (default true). */
  fixedClock?: boolean;
}

export async function openPublish(
  h: HarnessB,
  route: string,
  opts: PubOpen = {},
): Promise<PubSession> {
  const {
    scenario = 'library',
    theme = 'dark',
    width = 1440,
    height = 900,
    settle = 500,
    reducedMotion = false,
    prepare,
    fixedClock = true,
    ...install
  } = opts;
  const context = await h.browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  if (fixedClock) await page.clock.install({ time: FIXED_NOW });
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message} @ ${page.url()}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(h.base) && !u.startsWith('data:') && !u.startsWith('blob:'))
      problems.push(`EXTERNAL REQUEST: ${u}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });

  const state = makeState(scenario, 'linux', { assetBase: h.base });
  const lib = installPublishLib(state, { now: FIXED_NOW, ...install });
  prepare?.(lib, state);
  const ctl = controls(state);
  void ctl;

  const stub = await installClipfernStub(page, state);
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
  await page.goto(h.base + route);
  await page.locator('nav[aria-label="Main"]').waitFor();
  await page.waitForLoadState('networkidle');
  if (settle) await page.waitForTimeout(settle);
  return { page, state, lib, problems, emit: stub.emit, close: () => context.close() };
}
