import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { canRun, createHarness, type Harness, type Session } from './support/harness';
import { brandControls, dropFiles, openBrand } from './support/brand-stub';

/**
 * CP4 Brand Kit page screenshots: every section in dark and light at 1440x900 and 1280x720, plus the dialogs and the
 * empty / loading / error states.
 *   test/e2e/support/brand-build.sh <work> <out>     # private static export
 *   CLIPFERN_E2E_OUT=<out> CLIPFERN_SHOTS_DIR=<dir> npx playwright test test/e2e/renderer-cp4-brand-shots.spec.ts
 */
const SHOTS = process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp4-brand');
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

const SECTIONS = [
  'logos',
  'images',
  'videos',
  'audio',
  'fonts',
  'colors',
  'subtitle-styles',
  'text-styles',
  'hook',
  'watermark',
  'intro-outro',
  'music',
  'defaults',
] as const;

const sizes = [
  { w: 1440, h: 900 },
  { w: 1280, h: 720 },
] as const;

for (const theme of ['dark', 'light'] as const) {
  for (const size of sizes) {
    test.describe(`Brand Kit / ${theme} / ${size.w}x${size.h}`, () => {
      test.setTimeout(240_000);
      let s: Session;
      test.beforeAll(async () => {
        s = await openBrand(h, { theme, width: size.w, height: size.h, settle: 1500 });
        await expect(s.page.getByTestId('section-logos')).toBeVisible();
        // let the libass thumbnails render
        await s.page.waitForTimeout(2500);
      });
      test.afterAll(async () => {
        await s?.close();
      });

      test('top of page', async () => {
        await s.page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
        await s.page.screenshot({ path: path.join(SHOTS, `${theme}-${size.w}-top.png`) });
      });

      for (const id of SECTIONS) {
        test(`section ${id}`, async () => {
          const sec = s.page.getByTestId(`section-${id}`);
          await sec.scrollIntoViewIfNeeded();
          await s.page.waitForTimeout(350);
          await sec.screenshot({ path: path.join(SHOTS, `${theme}-${size.w}-${id}.png`) });
        });
      }

      test('no console problems', async () => {
        expect(s.problems.filter((p) => !/preloaded using link preload/.test(p))).toEqual([]);
      });
    });
  }
}

test.describe('Brand Kit / states and dialogs', () => {
  test.setTimeout(240_000);
  for (const theme of ['dark', 'light'] as const) {
    test(`empty ${theme}`, async () => {
      const s = await openBrand(h, { theme, seed: { kits: 'empty' } });
      await expect(s.page.getByText('Create your first Brand Kit')).toBeVisible();
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-empty.png`) });
      await s.close();
    });
    test(`bare kit ${theme}`, async () => {
      const s = await openBrand(h, { theme, seed: { kits: 'bare' }, settle: 1200 });
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-bare-top.png`) });
      await s.page.getByTestId('section-watermark').scrollIntoViewIfNeeded();
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-bare-watermark.png`) });
      await s.close();
    });
    test(`dialogs ${theme}`, async () => {
      const s = await openBrand(h, { theme, settle: 1200 });
      await s.page.getByRole('button', { name: 'Add subtitle styles' }).click();
      await expect(s.page.getByTestId('kit-style-dialog')).toBeVisible();
      await s.page.waitForTimeout(3500);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-dialog-subtitle-pick.png`) });
      await s.page.getByRole('button', { name: 'Start from Hormozi Bold' }).click();
      await s.page.waitForTimeout(2500);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-dialog-subtitle-edit.png`) });
      await s.page.keyboard.press('Escape');
      await s.page.getByRole('button', { name: 'Add text styles' }).click();
      await s.page.waitForTimeout(900);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-dialog-text-pick.png`) });
      await s.page.getByRole('button', { name: 'Start from Hook Card' }).click();
      await s.page.waitForTimeout(900);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-dialog-text-edit.png`) });
      await s.page.keyboard.press('Escape');
      await s.page.getByRole('button', { name: 'New brand kit' }).first().click();
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-dialog-new-kit.png`) });
      await s.close();
    });
    test(`uploads + conflict ${theme}`, async () => {
      const s = await openBrand(h, { theme, settle: 1000 });
      const c = brandControls(s.state);
      c.state.stageDelayMs = 700;
      const panel = s.page.getByTestId('upload-logo');
      await panel.scrollIntoViewIfNeeded();
      void dropFiles(s, panel, [
        { name: 'new-logo.png' },
        { name: 'notes.txt' },
        { name: 'huge.svg', size: 99 * 2 ** 20 },
      ]);
      await s.page.waitForTimeout(900);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-uploading.png`) });
      await s.page.waitForTimeout(3500);
      await c.saveElsewhereAndNotify(c.kit().id, {}, 'Renamed elsewhere');
      await s.page.getByLabel('Kit name').fill('My local name');
      await s.page.waitForTimeout(900);
      await s.page.screenshot({ path: path.join(SHOTS, `${theme}-conflict.png`) });
      await s.close();
    });
  }
});
