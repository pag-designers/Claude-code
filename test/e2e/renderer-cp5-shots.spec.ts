import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { canRunB, createHarnessB, openPublish, type HarnessB } from './support/publish-harness';
import { ACC_TT, ACC_YT, DAY, HOUR, FIXED_NOW } from './support/publish-stub';

/**
 * Screenshots of the CP5 UI (dark + light, 1440x900 and 1280x720) for visual review.
 *   CP5_SHOTS=<dir> CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-shots.spec.ts
 */
const DIR = process.env.CP5_SHOTS;
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRunB() || !DIR, 'needs a Chromium binary, a built renderer and CP5_SHOTS');

let h: HarnessB;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await (await import('./support/publish-harness')).createHarnessB();
  fs.mkdirSync(DIR!, { recursive: true });
});
test.afterAll(async () => {
  await h?.close();
});

const shot = (p: Page, name: string) => p.screenshot({ path: path.join(DIR!, `${name}.png`) });

for (const theme of ['dark', 'light'] as const) {
  for (const [w, hh] of [
    [1440, 900],
    [1280, 720],
  ] as const) {
    const tag = `${theme}-${w}`;
    test.describe(tag, () => {
      test.describe.configure({ timeout: 120_000 });

      test(`scheduler calendar + queue ${tag}`, async () => {
        const s = await openPublish(h, '/scheduler/', {
          theme,
          width: w,
          height: hh,
          seed: true,
        });
        await shot(s.page, `${tag}-scheduler-month`);
        await s.page.getByRole('radio', { name: 'Week' }).click();
        await s.page.waitForTimeout(300);
        await shot(s.page, `${tag}-scheduler-week`);
        await s.page.getByRole('radio', { name: 'Queue' }).click();
        await s.page.waitForTimeout(300);
        await shot(s.page, `${tag}-scheduler-queue`);
        await s.close();
      });

      test(`drawers ${tag}`, async () => {
        const s = await openPublish(h, '/scheduler/', { theme, width: w, height: hh, seed: true });
        await s.page.getByRole('radio', { name: 'Queue' }).click();
        await s.page.locator('[data-post-id="p-fail"] [data-testid="queue-open"]').click();
        await s.page.waitForTimeout(500);
        await shot(s.page, `${tag}-drawer-failed`);
        await s.page.keyboard.press('Escape');
        await s.page.locator('[data-post-id="p-pub"] [data-testid="queue-open"]').click();
        await s.page.waitForTimeout(500);
        await shot(s.page, `${tag}-drawer-published`);
        await s.page.keyboard.press('Escape');
        await s.page.locator('[data-post-id="p-today"] [data-testid="queue-open"]').click();
        await s.page.waitForTimeout(500);
        await shot(s.page, `${tag}-drawer-tiktok`);
        await s.close();
      });

      test(`schedule dialogs ${tag}`, async () => {
        const s = await openPublish(h, '/scheduler/', {
          theme,
          width: w,
          height: hh,
          seed: true,
          prepare: (lib) => {
            lib.mediaIssues['c:vid-interview-c2|shorts'] = [
              {
                severity: 'error',
                code: 'duration-long',
                message: 'The clip is 3:12 long; YouTube Shorts allows up to 3:00.',
                fixable: true,
              },
              {
                severity: 'warning',
                code: 'bitrate',
                message: 'Bitrate is low; the picture may look soft.',
                fixable: false,
              },
            ];
          },
        });
        await s.page.getByTestId('schedule-new').click();
        await s.page.getByTestId('pick-dialog').waitFor();
        await s.page.waitForTimeout(300);
        await shot(s.page, `${tag}-pick`);
        const checks = s.page.getByTestId('pick-check');
        await checks.nth(1).click();
        await s.page.getByTestId('pick-continue').click();
        await s.page.getByTestId('schedule-dialog').waitFor();
        await s.page.waitForTimeout(700);
        await shot(s.page, `${tag}-dialog-single-shorts`);
        await s.page.getByTestId('schedule-tab-tiktok').click();
        await s.page.waitForTimeout(300);
        await shot(s.page, `${tag}-dialog-single-tiktok`);
        await s.page.keyboard.press('Escape');
        await s.page.waitForTimeout(200);

        await s.page.getByTestId('schedule-new').click();
        await s.page.getByTestId('pick-dialog').waitFor();
        await checks.nth(0).click();
        await checks.nth(1).click();
        await checks.nth(2).click();
        await checks.nth(3).click();
        await s.page.getByTestId('pick-continue').click();
        await s.page.getByTestId('schedule-dialog').waitFor();
        await s.page.waitForTimeout(900);
        await shot(s.page, `${tag}-dialog-bulk`);
        await s.page
          .getByTestId('schedule-dialog')
          .locator('[data-testid="smart-plan"]')
          .scrollIntoViewIfNeeded();
        await s.page.waitForTimeout(200);
        await shot(s.page, `${tag}-dialog-bulk-plan`);
        await s.close();
      });

      test(`settings ${tag}`, async () => {
        const s = await openPublish(h, '/settings/integrations/', {
          theme,
          width: w,
          height: hh,
          seed: true,
        });
        await shot(s.page, `${tag}-integrations`);
        await s.page.locator('#tiktok').scrollIntoViewIfNeeded();
        await s.page.locator('#tiktok-audit').scrollIntoViewIfNeeded();
        await s.page.waitForTimeout(200);
        await shot(s.page, `${tag}-integrations-tiktok`);
        const t = await openPublish(h, '/settings/scheduler/', {
          theme,
          width: w,
          height: hh,
          seed: true,
        });
        await shot(t.page, `${tag}-settings-scheduler`);
        await s.close();
        await t.close();
      });
    });
  }
}

test('empty states', async () => {
  test.setTimeout(120_000);
  const fresh = await openPublish(h, '/scheduler/', { accounts: [], configured: ['shorts'] });
  await shot(fresh.page, 'dark-1440-scheduler-no-accounts');
  const none = await openPublish(h, '/scheduler/', { theme: 'light' });
  await shot(none.page, 'light-1440-scheduler-no-posts');
  const paused = await openPublish(h, '/scheduler/', {
    seed: true,
    prepare: (lib) => {
      lib.scheduler.paused = true;
      lib.scheduler.catchUp = { pending: 0, lastRunAt: FIXED_NOW - 3 * HOUR };
      const a = lib.accounts.find((x) => x.id === ACC_YT)!;
      a.status = 'needs-reauth';
      a.statusMessage = 'Google revoked the sign-in. Reconnect to keep posting.';
      void ACC_TT;
      void DAY;
    },
  });
  await shot(paused.page, 'dark-1440-scheduler-paused-reauth');
  await fresh.close();
  await none.close();
  await paused.close();
});
