import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  canRun,
  createHarness,
  type Harness,
  type OpenOptions,
  type Session,
} from './support/harness';
import { controls, cp2a } from './support/cp2-stub-a';

/**
 * CP2 (UI-A) screenshots: every new screen and state in dark and light (1440x900), plus 1280 and an ultrawide.
 *   CLIPFERN_E2E_OUT=<snapshot of renderer/out> npx playwright test test/e2e/renderer-cp2a-shots.spec.ts
 * Output: $CLIPFERN_SHOTS_DIR (default .tmp/shots-cp2a). Zero console errors/warnings/external requests is asserted.
 */
const SHOTS = process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp2a');

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

const open = (route: string, opts: OpenOptions = {}) => h.open(route, { settle: 700, ...opts });
const shot = (s: Session, name: string, full = false) =>
  s.page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
const wait = (s: Session, ms = 500) => s.page.waitForTimeout(ms);
const VIDEO = '/library/video/?id=vid-interview';
const studio = (p: Page) => p.getByTestId('style-studio');
const tile = (p: Page, id: string) =>
  studio(p).locator(`[data-testid="style-tile"][data-style-id="${id}"]`);
const rows = (p: Page) => p.getByTestId('cue-row');

async function openStudio(s: Session) {
  await s.page.getByTestId('caption-style-button').first().click();
  await expect(studio(s.page)).toBeVisible();
  await expect(studio(s.page).getByTestId('style-preview-img')).toBeVisible();
  await expect(tile(s.page, 'clean-pop').getByTestId('style-thumb')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await wait(s, 900); // let the visible tiles finish
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CP2a screens / ${theme}`, () => {
    test.setTimeout(240_000);

    test(`subtitles tab states`, async () => {
      const problems: string[] = [];
      let s = await open(`${VIDEO}&tab=subtitles`, { scenario: 'library', theme });
      await shot(s, `subtitles-default-${theme}`);
      // playing: the active cue is highlighted
      await rows(s.page)
        .nth(3)
        .getByRole('button', { name: /^Play from/ })
        .click();
      await wait(s, 1500);
      await shot(s, `subtitles-playing-${theme}`);
      // editing a row
      await rows(s.page).nth(2).getByTestId('cue-text').click();
      await s.page.getByTestId('cue-input').fill('April is Autism Awareness Month, and');
      await wait(s, 300);
      await shot(s, `subtitles-editing-${theme}`);
      await s.page.getByTestId('cue-input').press('Enter');
      // saving / saved
      cp2a(s.state).saveDelayMs = 1500;
      await expect(s.page.getByTestId('save-state')).toHaveAttribute('data-status', 'saving');
      await shot(s, `subtitles-saving-${theme}`);
      await expect(s.page.getByTestId('save-state')).toHaveAttribute('data-status', 'saved');
      await wait(s, 300);
      await shot(s, `subtitles-saved-banner-${theme}`);
      // search
      await s.page.getByRole('textbox', { name: 'Search subtitles' }).fill('awareness');
      await wait(s, 500);
      await shot(s, `subtitles-search-${theme}`);
      // retime popover
      await s.page.getByRole('textbox', { name: 'Search subtitles' }).fill('');
      await rows(s.page).nth(1).getByTestId('cue-time').click();
      await wait(s, 400);
      await shot(s, `subtitles-retime-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // save error
      s = await open(`${VIDEO}&tab=subtitles`, { scenario: 'library', theme });
      controls(s.state).failNext('subtitles:save', 'Storage is unreachable (ECONNRESET).');
      await rows(s.page).nth(1).getByTestId('cue-text').click();
      await s.page.getByTestId('cue-input').fill('I’m so glad you’re here today.');
      await s.page.getByTestId('cue-input').press('Enter');
      await expect(s.page.getByTestId('save-state')).toHaveAttribute('data-status', 'error');
      await wait(s, 500);
      await shot(s, `subtitles-save-error-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // long video (thousands of cues), scrolled
      s = await open('/library/video/?id=vid-podcast&tab=subtitles', {
        scenario: 'library',
        theme,
      });
      await s.page
        .getByTestId('cue-scroller')
        .evaluate((el) => (el.scrollTop = el.scrollHeight * 0.4));
      await wait(s, 600);
      await shot(s, `subtitles-long-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // states: no transcript / loading error
      s = await open('/library/video/?id=vid-failed&tab=subtitles', { scenario: 'library', theme });
      await shot(s, `subtitles-empty-${theme}`);
      problems.push(...s.problems);
      await s.close();
      expect(problems).toEqual([]);
    });

    test(`style studio states`, async () => {
      const problems: string[] = [];
      let s = await open(`${VIDEO}&tab=subtitles`, { scenario: 'library', theme });
      const release = controls(s.state).holdPreviews();
      await s.page.getByTestId('caption-style-button').first().click();
      await wait(s, 700);
      await shot(s, `studio-loading-${theme}`);
      release();
      await expect(tile(s.page, 'clean-pop').getByTestId('style-thumb')).toHaveAttribute(
        'data-state',
        'ready',
      );
      await wait(s, 1500);
      await shot(s, `studio-default-${theme}`);
      await s.page.getByTestId('studio-gallery').evaluate((el) => (el.scrollTop = el.scrollHeight));
      await wait(s, 2500);
      await shot(s, `studio-gallery-scrolled-${theme}`);
      await tile(s.page, 'neon-glow').click();
      await wait(s, 1200);
      await shot(s, `studio-neon-${theme}`);
      await tile(s.page, 'caption-bubble').click();
      await wait(s, 1200);
      // edit: size + colour + switch on the box, then scroll the editor
      await studio(s.page).getByLabel('Size', { exact: true }).fill('9.5');
      await studio(s.page).getByLabel('Text fill', { exact: true }).fill('#FFE94D');
      await wait(s, 1200);
      await shot(s, `studio-edited-${theme}`);
      await studio(s.page)
        .locator('[data-testid="style-editor"]')
        .evaluate((el) => (el.parentElement!.scrollTop = 900));
      await wait(s, 500);
      await shot(s, `studio-editor-scrolled-${theme}`);
      await studio(s.page).getByRole('switch', { name: 'Safe area guide' }).click();
      await wait(s, 300);
      await shot(s, `studio-safe-area-${theme}`);
      // validation
      await studio(s.page)
        .locator('[data-testid="style-editor"]')
        .evaluate((el) => (el.parentElement!.scrollTop = 0));
      await studio(s.page).getByLabel('Size', { exact: true }).fill('99');
      await wait(s, 600);
      await shot(s, `studio-validation-${theme}`);
      await studio(s.page).getByLabel('Size', { exact: true }).fill('9.5');
      // preview error
      controls(s.state).failNext(
        'captions:preview',
        'ffmpeg exited with code 1 (libass: font not found).',
      );
      await studio(s.page).getByLabel('Size', { exact: true }).fill('9.6');
      await wait(s, 1000);
      await shot(s, `studio-preview-error-${theme}`);
      await studio(s.page).getByRole('button', { name: 'Retry' }).click();
      await wait(s, 1200);
      // save as copy, delete confirm
      await studio(s.page).getByRole('button', { name: 'Save as custom copy' }).click();
      await wait(s, 1500);
      await shot(s, `studio-custom-saved-${theme}`);
      await studio(s.page).getByRole('button', { name: 'Delete' }).click();
      await wait(s, 400);
      await shot(s, `studio-delete-confirm-${theme}`);
      await s.page.getByRole('button', { name: 'Cancel' }).click();
      // discard confirm
      await studio(s.page).getByLabel('Size', { exact: true }).fill('11');
      await tile(s.page, 'typewriter').click();
      await wait(s, 400);
      await shot(s, `studio-discard-confirm-${theme}`);
      await s.page.getByRole('button', { name: 'Discard changes' }).click();
      // apply -> apply-all dialog
      await tile(s.page, 'boxed-highlight').click();
      await studio(s.page).getByTestId('studio-apply').click();
      await expect(s.page.getByTestId('apply-all-dialog')).toBeVisible();
      await wait(s, 500);
      await shot(s, `studio-apply-all-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // opened from Home
      s = await open('/', { scenario: 'configured', theme });
      await shot(s, `home-options-${theme}`);
      await s.page.getByTestId('home-caption-style').click();
      await expect(studio(s.page).getByTestId('style-preview-img')).toBeVisible();
      await wait(s, 2500);
      await shot(s, `studio-from-home-${theme}`);
      problems.push(...s.problems);
      await s.close();
      expect(problems.filter((p) => !/libass|captions:preview|ffmpeg/.test(p))).toEqual([]);
    });

    test(`tools hub, pickers and tools`, async () => {
      const problems: string[] = [];
      const grab = async (
        route: string,
        name: string,
        opts: OpenOptions = {},
        more?: (s: Session) => Promise<void>,
        full = false,
      ) => {
        const s = await open(route, { scenario: 'library', theme, ...opts });
        await more?.(s);
        await shot(s, `${name}-${theme}`, full);
        problems.push(...s.problems);
        await s.close();
      };
      await grab('/tools/', 'tools-hub', {}, undefined, true);
      await grab('/tools/', 'tools-hub-empty', { scenario: 'configured' });
      await grab('/tools/summary/', 'tool-picker-summary');
      await grab('/tools/hook/', 'tool-picker-hook');
      await grab('/tools/reframe/', 'tool-picker-empty', { scenario: 'configured' });
      await grab(
        '/tools/summary/',
        'tool-picker-analyse-filled',
        { scenario: 'configured' },
        async (s) => {
          await s.page
            .getByRole('textbox', { name: 'YouTube URL to analyse' })
            .fill('https://youtu.be/dQw4w9WgXcQ');
          await expect(s.page.getByTestId('url-preview')).toBeVisible();
          await wait(s, 400);
        },
      );
      await grab(
        '/tools/transcripts/',
        'tool-picker-analyse-blocked',
        { scenario: 'fresh' },
        async (s) => {
          await s.page
            .getByRole('textbox', { name: 'YouTube URL to analyse' })
            .fill('https://youtu.be/dQw4w9WgXcQ');
          await expect(s.page.getByTestId('url-preview')).toBeVisible();
          await wait(s, 400);
        },
      );
      await grab('/tools/summary/?video=vid-interview', 'tool-summary', { settle: 1200 });
      await grab(
        '/tools/summary/?video=vid-interview',
        'tool-summary-notes',
        { settle: 1200 },
        async (s) => {
          await s.page.getByRole('radio', { name: 'Notes' }).click();
          await wait(s, 400);
        },
      );
      await grab(
        '/tools/transcripts/?video=vid-interview',
        'tool-transcripts',
        { settle: 1200 },
        async (s) => {
          await s.page.getByTestId('transcript-download').click();
          await wait(s, 400);
        },
      );
      await grab('/tools/subtitles/?video=vid-interview', 'tool-subtitles', { settle: 1200 });
      await grab('/tools/reframe/?video=vid-interview', 'tool-reframe', { settle: 1500 });
      await grab(
        '/tools/reframe/?video=vid-interview',
        'tool-reframe-working',
        { settle: 1500 },
        async (s) => {
          const c1 = s.page.locator(
            '[data-testid="reframe-card"][data-clip-id="vid-interview-c1"]',
          );
          await c1.getByRole('radio', { name: 'Split screen (two people)' }).click();
          await c1.getByTestId('reframe-apply').click();
          await wait(s, 600);
          const clip = s.state.clips.find((c) => c.id === 'vid-interview-c2')!;
          Object.assign(clip, {
            status: 'rendered',
            hasRender: true,
            layout: 'split',
            reframeMode: 'multi-face',
          });
          await s.emit('clips:updated', { ...clip });
          await wait(s, 500);
        },
      );
      await grab(
        '/tools/reframe/?video=vid-interview',
        'tool-reframe-confirm',
        { settle: 1500 },
        async (s) => {
          await s.page.getByRole('radio', { name: 'Screen + face' }).first().click();
          await s.page.getByTestId('reframe-all').click();
          await wait(s, 500);
        },
      );
      await grab('/tools/hook/?video=vid-interview', 'tool-hook', { settle: 1500 });
      await grab('/tools/thumbnail/?video=vid-interview', 'tool-thumbnail', { settle: 1500 });
      await grab('/tools/find-moments/?video=vid-interview', 'tool-find-moments', { settle: 1500 });
      await grab('/tools/highlights/?video=vid-interview', 'tool-highlights', { settle: 1500 });
      await grab(
        '/tools/reframe/?video=vid-processing',
        'tool-no-clips',
        { settle: 1200 },
        undefined,
      );
      await grab('/tools/summary/?video=missing', 'tool-video-missing');

      // analysis run: progress mid-way and done
      let s = await open('/tools/summary/', { scenario: 'configured', theme });
      await s.page
        .getByRole('textbox', { name: 'YouTube URL to analyse' })
        .fill('https://youtu.be/dQw4w9WgXcQ');
      await expect(s.page.getByTestId('url-preview')).toBeVisible();
      await s.page.getByRole('button', { name: 'Analyse', exact: true }).click();
      await expect(s.page.getByTestId('pipeline-progress')).toBeVisible();
      await s.sim('vid-new-1').run(4);
      await wait(s, 700);
      await shot(s, `tool-analysis-running-${theme}`);
      await s.sim('vid-new-1').run();
      await wait(s, 1200);
      await shot(s, `tool-analysis-done-${theme}`);
      problems.push(...s.problems);
      await s.close();

      // command palette
      s = await open('/', { scenario: 'library', theme });
      await s.page.keyboard.press('Control+k');
      await s.page.keyboard.type('tool');
      await wait(s, 500);
      await shot(s, `palette-tools-${theme}`);
      problems.push(...s.problems);
      await s.close();
      expect(problems).toEqual([]);
    });
  });
}

test.describe('CP2a widths', () => {
  test.setTimeout(240_000);
  test('1280 and ultrawide (2560x1200) in dark', async () => {
    const problems: string[] = [];
    for (const [w, hgt, tag] of [
      [1280, 800, '1280'],
      [2560, 1200, 'ultrawide'],
    ] as const) {
      let s = await open('/tools/', { scenario: 'library', width: w, height: hgt });
      await shot(s, `w-${tag}-tools-hub`);
      problems.push(...s.problems);
      await s.close();
      s = await open(`${VIDEO}&tab=subtitles`, {
        scenario: 'library',
        width: w,
        height: hgt,
        settle: 1200,
      });
      await shot(s, `w-${tag}-subtitles`);
      await openStudio(s);
      await shot(s, `w-${tag}-studio`);
      problems.push(...s.problems);
      await s.close();
      s = await open('/tools/reframe/?video=vid-interview', {
        scenario: 'library',
        width: w,
        height: hgt,
        settle: 1200,
      });
      await shot(s, `w-${tag}-reframe`);
      problems.push(...s.problems);
      await s.close();
      s = await open('/tools/summary/?video=vid-interview', {
        scenario: 'library',
        width: w,
        height: hgt,
        settle: 1200,
      });
      await shot(s, `w-${tag}-summary`);
      problems.push(...s.problems);
      await s.close();
      s = await open('/', { scenario: 'configured', width: w, height: hgt });
      await shot(s, `w-${tag}-home`);
      problems.push(...s.problems);
      await s.close();
    }
    expect(problems).toEqual([]);
  });
});
