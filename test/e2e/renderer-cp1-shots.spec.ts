import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  canRun,
  createHarness,
  type Harness,
  type OpenOptions,
  type Session,
} from './support/harness';

/**
 * CP1 screenshots: every new screen and state in dark and light (1440x900), plus 1280 and an ultrawide.
 *   pnpm build:renderer && npx playwright test test/e2e/renderer-cp1-shots.spec.ts
 * Output: $CLIPFERN_SHOTS_DIR (default .tmp/shots-cp1). Zero console errors/warnings/external requests is asserted.
 */
const SHOTS = process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp1');

// our own browser/contexts: the runner's auto-trace artifacts would race with manual context.close()
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = (route: string, opts: OpenOptions = {}) => h.open(route, opts);
const shot = (s: Session, name: string, full = false) =>
  s.page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
const settle = (s: Session, ms = 500) => s.page.waitForTimeout(ms);

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CP1 screens / ${theme}`, () => {
    test.setTimeout(180_000);

    test(`home states`, async () => {
      const problems: string[] = [];
      // fresh install: Start is blocked with a specific reason
      let s = await open('/', { scenario: 'fresh', theme });
      await s.page
        .getByRole('textbox', { name: 'YouTube URL' })
        .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await settle(s, 700);
      await shot(s, `home-fresh-blocked-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // configured, empty library
      s = await open('/', { scenario: 'configured', theme });
      await shot(s, `home-configured-empty-${theme}`);
      const input = s.page.getByRole('textbox', { name: 'YouTube URL' });
      await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await expect(s.page.getByTestId('url-preview')).toBeVisible();
      await settle(s, 500);
      await shot(s, `home-preview-${theme}`);
      await s.page.getByRole('radio', { name: 'Custom' }).click();
      await s.page.getByRole('radio', { name: 'All above score' }).click();
      await s.page
        .getByRole('textbox', { name: 'Steering prompt' })
        .fill('moments about focus and attention');
      await settle(s, 300);
      await shot(s, `home-options-custom-${theme}`);
      problems.push(...s.problems);
      await s.close();

      for (const [id, name] of [
        ['BotCheck001', 'botcheck'],
        ['Private0001', 'private'],
        ['AgeLimit001', 'age'],
        ['LiveStream1', 'live'],
      ] as const) {
        s = await open('/', { scenario: 'configured', theme, settle: 300 });
        await s.page.getByRole('textbox', { name: 'YouTube URL' }).fill(`https://youtu.be/${id}`);
        await settle(s, 900);
        await shot(s, `home-${name}-${theme}`);
        problems.push(...s.problems);
        await s.close();
      }

      // library populated: running video, continue list, real stats
      s = await open('/', { scenario: 'library', theme });
      await shot(s, `home-library-${theme}`);
      problems.push(...s.problems);
      await s.close();
      s = await open('/', { scenario: 'library', theme, height: 1700 });
      await shot(s, `home-library-tall-${theme}`);
      problems.push(...s.problems);
      await s.close();
      expect(problems).toEqual([]);
    });

    test(`library tabs`, async () => {
      const problems: string[] = [];
      let s = await open('/library/', { scenario: 'configured', theme });
      await shot(s, `library-empty-videos-${theme}`);
      await s.page.getByRole('tab', { name: /Clips/ }).click();
      await settle(s, 400);
      await shot(s, `library-empty-clips-${theme}`);
      await s.page.getByRole('tab', { name: /Favorites/ }).click();
      await settle(s, 400);
      await shot(s, `library-empty-favorites-${theme}`);
      await s.page.getByRole('tab', { name: /Edited/ }).click();
      await settle(s, 400);
      await shot(s, `library-edited-${theme}`);
      await s.page.getByRole('tab', { name: /Exported/ }).click();
      await settle(s, 400);
      await shot(s, `library-exported-${theme}`);
      problems.push(...s.problems);
      await s.close();

      s = await open('/library/', { scenario: 'library', theme, settle: 1400 });
      await shot(s, `library-videos-grid-${theme}`);
      await s.page
        .getByRole('radio', { name: 'Video layout' })
        .first()
        .isVisible()
        .catch(() => undefined);
      await s.page
        .getByRole('radiogroup', { name: 'Video layout' })
        .getByRole('radio', { name: 'List' })
        .click();
      await settle(s, 500);
      await shot(s, `library-videos-list-${theme}`);
      await s.page.getByRole('tab', { name: /^Clips/ }).click();
      await settle(s, 1600);
      await shot(s, `library-clips-grid-${theme}`);
      await s.page.getByTestId('clip-card').first().hover();
      await settle(s, 900);
      await shot(s, `library-clips-hover-preview-${theme}`);
      await s.page
        .getByRole('radiogroup', { name: 'Layout' })
        .getByRole('radio', { name: 'List' })
        .click();
      await settle(s, 500);
      await shot(s, `library-clips-list-${theme}`);
      await s.page
        .getByRole('radiogroup', { name: 'Layout' })
        .getByRole('radio', { name: 'Grid' })
        .click();
      await settle(s, 500);
      // selection + bulk bar
      await s.page
        .getByRole('checkbox', { name: /^Select / })
        .nth(1)
        .click();
      await s.page
        .getByRole('checkbox', { name: /^Select / })
        .nth(2)
        .click();
      await settle(s, 500);
      await shot(s, `library-clips-selection-${theme}`);
      await s.page.keyboard.press('Escape');
      // filters
      await s.page.getByLabel('Minimum score').fill('80');
      await settle(s, 400);
      await shot(s, `library-clips-filtered-${theme}`);
      await s.page.getByRole('tab', { name: /Favorites/ }).click();
      await settle(s, 1200);
      await shot(s, `library-favorites-${theme}`);
      problems.push(...s.problems);
      await s.close();
      expect(problems).toEqual([]);
    });

    test(`video detail`, async () => {
      const problems: string[] = [];
      const s = await open('/library/video/?id=vid-interview', {
        scenario: 'library',
        theme,
        settle: 1500,
      });
      await shot(s, `video-overview-${theme}`);
      await s.page.getByRole('tab', { name: 'Transcript' }).click();
      await settle(s, 700);
      await shot(s, `video-transcript-${theme}`);
      await s.page.getByRole('textbox', { name: 'Search transcript' }).fill('collage');
      await settle(s, 700);
      await shot(s, `video-transcript-search-${theme}`);
      await s.page.getByTestId('transcript-row').nth(3).click();
      await settle(s, 1200);
      await shot(s, `video-transcript-playing-${theme}`);
      await s.page.getByRole('tab', { name: 'Chapters' }).click();
      await settle(s, 700);
      await shot(s, `video-chapters-${theme}`);
      await s.page.getByRole('tab', { name: /^Clips/ }).click();
      await settle(s, 1600);
      await shot(s, `video-clips-${theme}`);
      await s.page.getByRole('tab', { name: 'Notes' }).click();
      await settle(s, 700);
      await shot(s, `video-notes-${theme}`);
      await s.page.getByRole('tab', { name: /^Clips/ }).click();
      await settle(s, 500);
      await s.page
        .getByTestId('clip-card')
        .first()
        .getByRole('button', { name: /Open clip/ })
        .click();
      await settle(s, 1800);
      await shot(s, `clip-drawer-${theme}`);
      await s.page.getByRole('button', { name: 'Next clip' }).click();
      await settle(s, 1200);
      await shot(s, `clip-drawer-2-${theme}`);
      await s.page.keyboard.press('Escape');
      problems.push(...s.problems);
      await s.close();

      // long podcast without a proxy
      const p = await open('/library/video/?id=vid-podcast', {
        scenario: 'library',
        theme,
        settle: 1200,
      });
      await p.page.getByRole('tab', { name: 'Transcript' }).click();
      await settle(p, 900);
      await shot(p, `video-podcast-transcript-${theme}`);
      problems.push(...p.problems);
      await p.close();

      // failed
      const f = await open('/library/video/?id=vid-failed', {
        scenario: 'library',
        theme,
        settle: 1200,
      });
      await shot(f, `video-failed-${theme}`);
      problems.push(...f.problems);
      await f.close();

      // processing (seeded) with live clips
      const r = await open('/library/video/?id=vid-processing', {
        scenario: 'library',
        theme,
        settle: 1500,
      });
      await shot(r, `video-processing-seeded-${theme}`);
      problems.push(...r.problems);
      await r.close();
      expect(problems).toEqual([]);
    });

    test(`live pipeline run`, async () => {
      const problems: string[] = [];
      const s = await open('/', { scenario: 'configured', theme });
      await s.page
        .getByRole('textbox', { name: 'YouTube URL' })
        .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      await expect(s.page.getByTestId('url-preview')).toBeVisible();
      await s.page.getByRole('button', { name: /Start clipping/ }).click();
      await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-new-1/);
      await settle(s, 800);
      await shot(s, `run-0-queued-${theme}`);
      const sim = s.sim('vid-new-1');
      await sim.run(2);
      await settle(s, 700);
      await shot(s, `run-1-download-${theme}`);
      await sim.run(2);
      await settle(s, 700);
      await shot(s, `run-2-transcribe-${theme}`);
      await sim.run(3);
      await settle(s, 1800);
      await shot(s, `run-3-first-clips-${theme}`);
      await sim.run(3);
      await settle(s, 1400);
      await shot(s, `run-4-rendering-${theme}`);
      await sim.run();
      await settle(s, 1500);
      await shot(s, `run-5-done-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // failure + retry
      const f = await open('/', { scenario: 'configured', theme });
      await f.page
        .getByRole('textbox', { name: 'YouTube URL' })
        .fill('https://youtu.be/FailAtStt01');
      await expect(f.page.getByTestId('url-preview')).toBeVisible();
      await f.page.getByRole('button', { name: /Start clipping/ }).click();
      await expect(f.page).toHaveURL(/id=vid-new-1/);
      await f.sim('vid-new-1').run();
      await settle(f, 1200);
      await shot(f, `run-failed-${theme}`);
      problems.push(...f.problems);
      await f.close();
      expect(problems).toEqual([]);
    });

    test(`cost chip + delete dialog + shell`, async () => {
      const problems: string[] = [];
      const s = await open('/library/', { scenario: 'library', theme, settle: 1200 });
      await s.page
        .getByRole('button', { name: /More actions for Community/ })
        .click({ force: true });
      await settle(s, 300);
      await shot(s, `video-menu-${theme}`);
      await s.page.getByRole('menuitem', { name: /Delete/ }).click();
      await settle(s, 400);
      await shot(s, `video-delete-dialog-${theme}`);
      problems.push(...s.problems);
      await s.close();
      for (const spent of [26, 31, 74]) {
        const c = await open('/library/', {
          scenario: 'library',
          theme,
          settle: 600,
          prepare: (st) => (st.costSpent = spent),
        });
        await c.page.getByTestId('cost-chip').hover();
        await settle(c, 600);
        await c.page.screenshot({
          path: path.join(SHOTS, `cost-chip-${spent}-${theme}.png`),
          clip: { x: 700, y: 0, width: 740, height: 120 },
        });
        problems.push(...c.problems);
        await c.close();
      }
      expect(problems).toEqual([]);
    });
  });
}

test('sizes: 1280 and ultrawide', async () => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  for (const [w, hh, name] of [
    [1280, 800, '1280'],
    [2560, 1200, 'ultrawide'],
  ] as const) {
    for (const [route, label] of [
      ['/', 'home'],
      ['/library/?tab=clips', 'library-clips'],
      ['/library/video/?id=vid-interview', 'video'],
    ] as const) {
      const s = await open(route, {
        scenario: 'library',
        theme: 'dark',
        width: w,
        height: hh,
        settle: 1600,
      });
      await shot(s, `size-${name}-${label}-dark`);
      problems.push(...s.problems);
      await s.close();
    }
  }
  expect(problems).toEqual([]);
});
