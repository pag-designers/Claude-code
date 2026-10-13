import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canRunB, createHarnessB, type HarnessB, type SessionB } from './support/cp2b-harness';

/**
 * Screenshots of every CP2 UI-B screen/state (dark + light, 1440x900, 1280 and ultrawide) into
 * $CP2B_SHOTS (default: .tmp/shots-cp2b). Run after a build:
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp2b-shots.spec.ts
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRunB(), 'needs a Chromium binary and a built renderer');

const DIR = process.env.CP2B_SHOTS ?? '.tmp/shots-cp2b';
let h: HarnessB;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(DIR, { recursive: true });
  h = await createHarnessB();
});
test.afterAll(async () => {
  await h?.close();
});

const VIDEO = '/library/video/?id=vid-interview&tab=clips';
const CLIP = 'vid-interview-c1';

async function shot(s: SessionB, name: string, theme: string, w: string) {
  await s.page.waitForTimeout(250);
  await s.page.screenshot({ path: `${DIR}/${name}-${theme}-${w}.png` });
}

async function openDrawer(p: Page, tab?: string) {
  await p.getByTestId('clip-card').first().getByRole('button', { name: /Open clip/ }).click();
  await expect(p.getByTestId('clip-drawer')).toBeVisible();
  if (tab) await p.getByTestId(`drawer-tab-${tab}`).click();
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`shots ${theme}`, () => {
    test('drawer tabs', async () => {
      const s = await h.open(VIDEO, {
        theme,
        prepare: (_st, ctl) => {
          ctl.seedHooks(CLIP, { platform: 'tiktok', index: 1 });
          ctl.seedMeta(CLIP);
          ctl.seedThumbs(CLIP, true);
        },
      });
      await openDrawer(s.page);
      await shot(s, 'drawer-overview', theme, '1440');
      await s.page.getByTestId('drawer-tab-hook').click();
      await expect(s.page.getByTestId('hook-tab')).toBeVisible();
      await shot(s, 'drawer-hook', theme, '1440');
      await s.page.getByTestId('drawer-tab-meta').click();
      await expect(s.page.getByTestId('meta-tab')).toBeVisible();
      await shot(s, 'drawer-meta', theme, '1440');
      await s.page.getByTestId('drawer-tab-thumbnail').click();
      await expect(s.page.getByTestId('thumbnail-tester')).toBeVisible();
      await s.page.waitForTimeout(600);
      await shot(s, 'drawer-thumb', theme, '1440');
      await s.page.getByTestId('drawer-tab-reframe').click();
      await expect(s.page.getByTestId('reframe-tab')).toBeVisible();
      await shot(s, 'drawer-reframe', theme, '1440');
      expect(s.problems).toEqual([]);
      await s.close();
    });
  });
}
