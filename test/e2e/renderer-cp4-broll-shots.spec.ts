import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openBroll, type BrollOpenOptions, type BrollSession } from './support/broll-stub';

/**
 * CP4 stock B-roll screenshots (dark + light, laptop to ultrawide).
 *   CLIPFERN_E2E_OUT=<snapshot of renderer/out> CLIPFERN_SHOTS_DIR=<dir> npx playwright test test/e2e/renderer-cp4-broll-shots.spec.ts
 */
const SHOTS =
  process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp4-broll');
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = async (query: string, opts: BrollOpenOptions = {}): Promise<BrollSession> => {
  const s = await openBroll(h, `/design/broll/${query}`, { settle: 700, ...opts });
  await expect(s.page.getByTestId('broll-dialog')).toBeVisible();
  return s;
};
const shot = (s: BrollSession, name: string) =>
  s.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CP4 B-roll / ${theme}`, () => {
    test.setTimeout(240_000);

    test('results, selection, hover preview, import in progress', async () => {
      const s = await open('?q=city%20night&suggest=We%20left%20the%20city%20at%20dawn', {
        theme,
        width: 1440,
        height: 900,
        stub: { importDelayMs: 4000 },
      });
      const p = s.page;
      await expect(p.getByTestId('broll-card')).toHaveCount(8);
      await p.waitForTimeout(400);
      await shot(s, `${theme}-1-results`);
      await p.getByTestId('broll-suggest').click();
      await expect(p.getByTestId('broll-chip').first()).toBeVisible();
      await p.getByTestId('broll-option').nth(1).click();
      await p.getByTestId('broll-option').nth(2).click();
      await p.getByTestId('broll-option').nth(3).hover();
      await p.waitForTimeout(1200);
      await shot(s, `${theme}-2-ideas-selected-preview`);
      await p.getByTestId('broll-add').click();
      await expect(p.getByTestId('broll-card').nth(1)).toHaveAttribute('data-state', 'busy');
      await p.mouse.move(5, 5);
      await p.waitForTimeout(300);
      await shot(s, `${theme}-3-importing`);
      await s.close();
    });

    test('missing key, empty, failure', async () => {
      const s = await open('', { theme, stub: { keys: { pexels: false, pixabay: true } } });
      await s.page.getByTestId('broll-tab-pexels').click();
      await expect(s.page.getByTestId('broll-missing-key')).toBeVisible();
      await shot(s, `${theme}-4-missing-key`);
      await s.close();

      const e = await open('?q=nothing', { theme });
      await expect(e.page.getByText('No clips found')).toBeVisible();
      await shot(e, `${theme}-5-empty`);
      await e.close();

      const f = await open('?q=ocean', {
        theme,
        stub: {
          searchFailure: { message: 'Pexels rate limit reached; try again in 42 s', times: 5 },
        },
      });
      await expect(f.page.getByTestId('broll-search-error')).toBeVisible();
      await shot(f, `${theme}-6-rate-limit`);
      await f.close();
    });

    test('landscape + pixabay + kit', async () => {
      const s = await open('?target=kit&q=forest', { theme });
      await s.page.getByTestId('broll-tab-pixabay').click();
      await s.page.getByRole('radio', { name: 'Landscape' }).click();
      await expect(s.page.getByTestId('broll-card')).toHaveCount(8);
      await s.page.waitForTimeout(400);
      await shot(s, `${theme}-7-pixabay-landscape-kit`);
      await s.close();
    });

    test('laptop 1280x720 and ultrawide 3440x1440', async () => {
      const a = await open('?q=ocean', { theme, width: 1280, height: 720 });
      await expect(a.page.getByTestId('broll-card')).toHaveCount(8);
      await a.page.waitForTimeout(300);
      await shot(a, `${theme}-8-1280x720`);
      await a.close();
      const b = await open('?q=ocean', { theme, width: 3440, height: 1440 });
      await expect(b.page.getByTestId('broll-card')).toHaveCount(8);
      await b.page.waitForTimeout(300);
      await shot(b, `${theme}-9-3440x1440`);
      await b.close();
    });
  });
}
