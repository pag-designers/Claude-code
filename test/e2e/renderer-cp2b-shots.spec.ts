import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  type HarnessB,
  type OpenB,
  type SessionB,
} from './support/cp2b-harness';
import { BUDGET_ERROR } from './support/cp2-stub-b';

/**
 * Screenshots of every CP2 UI-B screen/state (dark + light at 1440x900; 1280 and ultrawide for the key screens) into
 * $CP2B_SHOTS (default .tmp/shots-cp2b). Every state is reached through the real UI + the contract-validated stub.
 *   CP2B_OUT=<export dir> CP2B_SHOTS=<dir> npx playwright test test/e2e/renderer-cp2b-shots.spec.ts
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRunB(), 'needs a Chromium binary and a built renderer');

const DIR = process.env.CP2B_SHOTS ?? '.tmp/shots-cp2b';
let h: HarnessB;
test.beforeAll(async () => {
  test.setTimeout(600_000);
  fs.mkdirSync(DIR, { recursive: true });
  h = await createHarnessB();
});
test.afterAll(async () => {
  await h?.close();
});

const VIDEO = (tab = 'clips') => `/library/video/?id=vid-interview&tab=${tab}`;
const CLIP = 'vid-interview-c1';
type Size = { w: number; h: number; tag: string };
const S1440: Size = { w: 1440, h: 900, tag: '1440' };
const S1280: Size = { w: 1280, h: 720, tag: '1280' };
const SWIDE: Size = { w: 2560, h: 1080, tag: '2560' };

const open = (route: string, theme: 'dark' | 'light', size: Size, opts: OpenB = {}) =>
  h.open(route, { theme, width: size.w, height: size.h, settle: 500, ...opts });

async function shot(
  s: SessionB,
  name: string,
  theme: string,
  size: Size,
  target?: ReturnType<Page['locator']>,
) {
  await s.page.waitForTimeout(350);
  const path = `${DIR}/${name}-${theme}-${size.tag}.png`;
  if (target) await target.screenshot({ path });
  else await s.page.screenshot({ path });
}

async function openDrawer(p: Page, tab?: string, index = 0) {
  await p
    .getByTestId('clip-card')
    .nth(index)
    .getByRole('button', { name: /Open clip/ })
    .click();
  await expect(p.getByTestId('clip-drawer')).toBeVisible();
  if (tab) await p.getByTestId(`drawer-tab-${tab}`).click();
  return p.getByTestId('clip-drawer');
}
const panel = (p: Page) => p.getByTestId('chat-panel');
const drain = async (s: SessionB) => {
  while ((await s.ctl.chatStep(8)) > 0) {
    /* drain */
  }
};
const send = async (p: Page, text: string) => {
  await panel(p).getByTestId('chat-input').fill(text);
  await panel(p).getByTestId('chat-input').press('Enter');
};

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme}`, () => {
    test('steering panel + highlights', async () => {
      const s = await open(VIDEO(), theme, S1440);
      await shot(s, 'steer-idle', theme, S1440);
      await s.page.getByTestId('steer-chip').nth(2).click();
      await s.page.getByTestId('steer-options-toggle').click();
      await s.page.getByRole('radio', { name: '60–90 s' }).click();
      await shot(s, 'steer-options', theme, S1440);
      await s.page.getByTestId('steer-submit').click();
      await expect(s.page.getByTestId('moment-run')).toHaveCount(1);
      await s.ctl.runStep();
      await s.ctl.runStep();
      await expect(s.page.getByTestId('clip-found-by')).toHaveCount(2);
      await shot(s, 'steer-running', theme, S1440);
      await s.page.getByTestId('clip-found-by').first().scrollIntoViewIfNeeded();
      await s.page.evaluate(() => document.getElementById('main')?.scrollBy(0, 120));
      await shot(s, 'steer-grid-found-by', theme, S1440);
      await s.page.evaluate(() => document.getElementById('main')?.scrollTo(0, 0));
      await s.ctl.finishRun();
      await expect(s.page.getByTestId('run-filters')).toBeVisible();
      await s.page.getByTestId('steer-options-toggle').click();
      await s.page
        .getByTestId('run-filters')
        .getByRole('button', { name: /only the guest/i })
        .click();
      await shot(s, 'steer-filtered', theme, S1440);
      await s.page.getByTestId('run-filter-all').click();
      // failure + budget
      await s.page.getByTestId('steer-input').fill('anything about pricing');
      await s.page.getByTestId('steer-submit').click();
      await s.ctl.failRun(BUDGET_ERROR);
      await expect(s.page.getByTestId('run-error')).toBeVisible();
      await shot(s, 'steer-failed', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('highlights', async () => {
      const s = await open(VIDEO(), theme, S1440);
      await s.page.getByTestId('highlight-button').click();
      await s.page.getByTestId('highlight-prompt').fill('focus on the collage story');
      await shot(s, 'highlight-popover', theme, S1440);
      await s.page.getByTestId('highlight-create').click();
      await expect(s.page.getByTestId('highlight-progress')).toBeVisible();
      const id = s.state.clips[0]!.id;
      await s.ctl.setRender(id, 0.55);
      await expect(s.page.getByTestId('highlight-progress')).toContainText('Rendering');
      await shot(s, 'highlight-progress', theme, S1440);
      await s.ctl.finishRender(id);
      await expect(s.page.getByTestId('highlight-progress')).toHaveAttribute('data-state', 'done');
      await shot(s, 'highlight-ready', theme, S1440);
      await s.page.getByTestId('highlight-open').click();
      await expect(s.page.getByTestId('drawer-highlight-badge')).toBeVisible();
      await shot(s, 'highlight-drawer', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('processing: disabled with a reason', async () => {
      const s = await open(VIDEO('clips').replace('vid-interview', 'vid-processing'), theme, S1440);
      await expect(s.page.getByTestId('steer-disabled-reason')).toBeVisible();
      await shot(s, 'steer-disabled', theme, S1440);
      await s.close();
    });

    test('hook tab: empty, error, populated, applying', async () => {
      const s = await open(VIDEO(), theme, S1440);
      await openDrawer(s.page, 'hook');
      await shot(s, 'hook-empty', theme, S1440);
      s.ctl.failNext('hooks:generate', BUDGET_ERROR);
      await s.page.getByTestId('hook-generate').click();
      await expect(s.page.getByTestId('clip-drawer').locator('[role="alert"]')).toBeVisible();
      await shot(s, 'hook-error', theme, S1440);
      await s.page.getByTestId('clip-drawer').getByRole('button', { name: 'Try again' }).click();
      await expect(s.page.getByTestId('hook-variant-4')).toBeVisible();
      await s.page.getByTestId('hook-use-1').click();
      await s.ctl.setRender(CLIP, 0.45);
      await shot(s, 'hook-applying', theme, S1440);
      await s.ctl.finishRender(CLIP);
      await s.page.getByTestId('platform-reels').click();
      await shot(s, 'hook-applied', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('meta tab: populated, dirty, over limit', async () => {
      const s = await open(VIDEO(), theme, S1440, { prepare: (_st, ctl) => ctl.seedMeta(CLIP) });
      const dlg = await openDrawer(s.page, 'meta');
      await shot(s, 'meta-tiktok', theme, S1440);
      await dlg.getByTestId('platform-shorts').click();
      await dlg
        .getByTestId('meta-title')
        .fill(
          'This title is far too long for a YouTube Short because it keeps going and going and going past one hundred characters',
        );
      await dlg.getByTestId('meta-savebar').scrollIntoViewIfNeeded();
      await shot(s, 'meta-shorts-over', theme, S1440);
      await dlg.getByTestId('meta-time').scrollIntoViewIfNeeded();
      await shot(s, 'meta-time', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('thumbnail tab: empty, generating, candidates, tester, A/B', async () => {
      const s = await open(VIDEO(), theme, S1440);
      const dlg = await openDrawer(s.page, 'thumbnail');
      await shot(s, 'thumb-empty', theme, S1440);
      s.ctl.auto(1400);
      await dlg.getByTestId('thumb-generate').click();
      await expect(dlg.getByTestId('thumb-generating')).toBeVisible();
      await shot(s, 'thumb-generating', theme, S1440);
      await expect(dlg.getByTestId('thumb-candidate-5')).toBeVisible();
      s.ctl.auto(null);
      await dlg.getByTestId('thumb-candidate-3').click();
      await dlg.getByTestId('thumb-overlay').fill('Why we said no');
      await expect(dlg.getByTestId('thumb-candidate-5').locator('img')).toHaveJSProperty(
        'complete',
        true,
      );
      await shot(s, 'thumb-candidates', theme, S1440);
      await dlg.getByTestId('thumbnail-tester').scrollIntoViewIfNeeded();
      await s.page.waitForTimeout(500);
      await shot(s, 'thumb-tester', theme, S1440);
      await dlg.getByTestId('tester-small').scrollIntoViewIfNeeded();
      await shot(s, 'thumb-tester-small', theme, S1440);
      await dlg.getByTestId('thumbnail-tester').getByRole('radio', { name: 'Light' }).click();
      await dlg.getByTestId('thumbnail-tester').scrollIntoViewIfNeeded();
      await shot(s, 'thumb-tester-lightchrome', theme, S1440);
      await dlg.getByTestId('thumbnail-tester').getByRole('radio', { name: 'Dark' }).click();
      await dlg.getByRole('radio', { name: 'A/B compare' }).scrollIntoViewIfNeeded();
      await dlg.getByRole('radio', { name: 'A/B compare' }).click();
      await dlg.getByTestId('thumb-candidate-1').click();
      await dlg.getByTestId('thumb-candidate-4').click();
      await shot(s, 'thumb-ab-pick', theme, S1440);
      await dlg.getByTestId('thumbnail-tester').scrollIntoViewIfNeeded();
      await s.page.waitForTimeout(400);
      await shot(s, 'thumb-ab-tester', theme, S1440);
      await dlg.getByTestId('tester-expand').click();
      await expect(s.page.getByTestId('tester-dialog')).toBeVisible();
      await s.page.waitForTimeout(500);
      await shot(s, 'thumb-tester-full', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('reframe tab', async () => {
      const s = await open(VIDEO(), theme, S1440, {
        prepare: (st) => {
          st.videos.find((v) => v.id === 'vid-interview')!.subtitleRev = 2;
        },
      });
      const dlg = await openDrawer(s.page, 'reframe');
      await shot(s, 'reframe-default', theme, S1440);
      await dlg.getByTestId('reframe-mode-multi-face').click();
      await dlg.getByTestId('reframe-apply').click();
      await s.ctl.setRender(CLIP, 0.6);
      await shot(s, 'reframe-rendering', theme, S1440);
      await s.ctl.finishRender(CLIP);
      await expect(dlg.getByTestId('reframe-note')).toBeVisible();
      await dlg.getByTestId('caption-style-name').scrollIntoViewIfNeeded();
      await shot(s, 'reframe-note', theme, S1440);
      await dlg.getByTestId('caption-style-change').click();
      await s.page.waitForTimeout(500);
      await shot(s, 'reframe-style-studio', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('chat: empty, streaming, answer, action, errors, menus', async () => {
      const s = await open(VIDEO('overview'), theme, S1440, {
        prepare: (_st, ctl) => {
          ctl.seedThread('vid-interview', null, [
            [
              'What is this video about?',
              'A warm community interview about **acceptance** in a small town and a collage artist whose process was reshaped by his nephew.',
            ],
          ]);
          ctl.seedThread('vid-interview', null, [
            ['Summarize this for LinkedIn', 'Here is a short post …'],
          ]);
          ctl.seedMarker('vid-interview', 42, 'Awareness vs acceptance');
          ctl.seedMarker('vid-interview', 118, 'The collage story');
        },
      });
      await s.page.getByTestId('chat-launcher').click();
      await s.page.getByTestId('chat-new').click();
      await expect(s.page.getByTestId('chat-empty')).toBeVisible();
      await shot(s, 'chat-empty', theme, S1440);
      await send(s.page, 'Find the part where they talk about the collage');
      await s.ctl.chatStep(1);
      await shot(s, 'chat-thinking', theme, S1440);
      await s.ctl.chatStep(9);
      await shot(s, 'chat-streaming', theme, S1440);
      await drain(s);
      await expect(panel(s.page).getByTestId('chat-sources')).toBeVisible();
      await shot(s, 'chat-answer', theme, S1440);
      await send(s.page, 'Make a clip of the best story');
      let guard = 0;
      while ((await panel(s.page).getByTestId('chat-action').count()) === 0 && guard++ < 60)
        await s.ctl.chatStep(1);
      await shot(s, 'chat-action-running', theme, S1440);
      await drain(s);
      await expect(panel(s.page).getByTestId('chat-action').last()).toHaveAttribute(
        'data-status',
        'done',
      );
      await shot(s, 'chat-action-done', theme, S1440);
      s.ctl.failChatNext(BUDGET_ERROR, 3);
      await send(s.page, 'What are the key takeaways?');
      await drain(s);
      await expect(panel(s.page).getByTestId('chat-error')).toBeVisible();
      await shot(s, 'chat-error-budget', theme, S1440);
      await panel(s.page).getByTestId('chat-threads').click();
      await shot(s, 'chat-threads-menu', theme, S1440);
      await s.page.keyboard.press('Escape');
      await panel(s.page).getByTestId('chat-markers').click();
      await shot(s, 'chat-markers-menu', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });

    test('chat from a clip next to the drawer', async () => {
      const s = await open(VIDEO(), theme, S1440, { prepare: (_st, ctl) => ctl.seedHooks(CLIP) });
      const dlg = await openDrawer(s.page, 'hook');
      await dlg.getByTestId('chat-launcher-clip').click();
      await send(s.page, 'Rewrite this hook');
      await drain(s);
      await expect(panel(s.page).getByTestId('chat-action')).toHaveAttribute('data-status', 'done');
      await shot(s, 'chat-clip-drawer', theme, S1440);
      expect(s.problems).toEqual([]);
      await s.close();
    });
  });
}

/* ------------------------------------------------------------------ the key screens at 1280 and ultrawide */
for (const size of [S1280, SWIDE]) {
  test(`key screens at ${size.tag}`, async () => {
    const theme = 'dark';
    const s = await open(VIDEO(), theme, size, {
      prepare: (_st, ctl) => {
        ctl.seedHooks(CLIP, { platform: 'tiktok', index: 1 });
        ctl.seedMeta(CLIP);
        ctl.seedThumbs(CLIP, true);
        ctl.seedThread('vid-interview', null, [
          [
            'What is this video about?',
            'A warm community interview about **acceptance** [0:42] and collage art [1:58].',
          ],
        ]);
        ctl.setRun({ videoId: 'vid-interview', prompt: 'only the funny parts', found: 0 });
      },
    });
    await shot(s, 'k-clips-tab', theme, size);
    const dlg = await openDrawer(s.page, 'thumbnail');
    await dlg.getByTestId('thumbnail-tester').scrollIntoViewIfNeeded();
    await s.page.waitForTimeout(500);
    await shot(s, 'k-drawer-thumb', theme, size);
    await dlg.getByTestId('drawer-tab-meta').click();
    await shot(s, 'k-drawer-meta', theme, size);
    await dlg.getByTestId('chat-launcher-clip').click();
    await shot(s, 'k-drawer-chat', theme, size);
    await s.page.keyboard.press('Escape');
    await s.page.keyboard.press('Escape');
    await s.page.getByTestId('chat-launcher').click();
    await shot(s, 'k-page-chat', theme, size);
    expect(s.problems).toEqual([]);
    await s.close();
  });
}
