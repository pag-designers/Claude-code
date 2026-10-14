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
import type { StubState } from './support/clipfern-stub';
import {
  editorControls,
  editorState,
  seedEditor,
  seedExports,
  uploadAsset,
} from './support/editor-stub-panels';

/**
 * CP3 panels screenshots (dark + light): the dock tabs, Export / Versions dialogs and the Library Edited / Exported tabs.
 *   CLIPFERN_E2E_OUT=<snapshot of renderer/out> CLIPFERN_SHOTS_DIR=<dir> npx playwright test test/e2e/renderer-cp3-panels-shots.spec.ts
 */
const SHOTS =
  process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp3-panels');
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

const seed = (st: StubState) => {
  seedEditor(st);
  seedExports(st);
};
const open = (route: string, opts: OpenOptions = {}) =>
  h.open(route, { settle: 800, scenario: 'library', prepare: seed, ...opts });
const shot = (s: Session, name: string) =>
  s.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const host = async (opts: OpenOptions, id = 'ep-clip') => {
  const s = await open(`/design/editor-panels/?id=${id}`, opts);
  await expect(s.page.getByTestId('panels-host')).not.toHaveAttribute('data-loaded', '');
  return s;
};
const tab = (p: Page, t: string) => p.getByTestId(`bin-tab-${t}`).click();

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CP3 panels / ${theme}`, () => {
    test.setTimeout(240_000);

    test('dock tabs', async () => {
      const s = await host({ theme });
      editorState(s.state).importQueue.push({
        canceled: false,
        assets: [
          uploadAsset('as_song', 'audio', 'summer-loop.mp3', { durationSec: 74 }),
          uploadAsset('as_img', 'image', 'logo.png'),
          uploadAsset('as_lut', 'lut', 'teal-orange.cube'),
        ],
      });
      await s.page.getByTestId('bin-import').click();
      await s.page.waitForTimeout(700);
      await shot(s, `bin-media-${theme}`);
      await tab(s.page, 'audio');
      await s.page.getByTestId('bin-audio-detect').click();
      await s.page.waitForTimeout(500);
      await shot(s, `bin-audio-${theme}`);
      await tab(s.page, 'text');
      await s.page.locator('[data-preset="anim-bounce"]').hover();
      await s.page.waitForTimeout(500);
      await shot(s, `bin-text-${theme}`);
      await tab(s.page, 'stickers');
      await s.page.waitForTimeout(300);
      await shot(s, `bin-stickers-${theme}`);
      await tab(s.page, 'transitions');
      await s.page.locator('[data-type="whip-pan"]').hover();
      await s.page.waitForTimeout(400);
      await shot(s, `bin-transitions-${theme}`);
      await tab(s.page, 'effects');
      await s.page.locator('[data-testid="host-item"][data-id="it_a"]').click();
      await s.page.locator('[data-filter="noir"]').click();
      await s.page.waitForTimeout(400);
      await shot(s, `bin-effects-${theme}`);
      await s.close();
    });

    test('export panel states', async () => {
      const s = await host({ theme });
      const c = editorControls(s.state);
      await s.page.getByTestId('host-open-export').click();
      await s.page.waitForTimeout(500);
      await shot(s, `export-idle-${theme}`);
      await s.page.locator('[data-testid="export-preset"][data-preset="youtube-1080p"]').click();
      await s.page.getByTestId('export-width').fill('1921');
      await s.page.waitForTimeout(300);
      await shot(s, `export-invalid-${theme}`);
      await s.page.locator('[data-testid="export-preset"][data-preset="tiktok"]').click();
      await s.page.getByTestId('export-start').click();
      await expect(s.page.getByText('Waiting in the queue').first()).toBeVisible();
      await c.progress(c.lastExport().id, 0.58, 'Encoding video · 9 s of 16 s');
      await expect(s.page.getByTestId('export-percent')).toHaveText('58%');
      await shot(s, `export-progress-${theme}`);
      await c.finish(c.lastExport().id);
      await expect(s.page.getByTestId('export-thumb')).toBeVisible();
      await s.page.waitForTimeout(500);
      await shot(s, `export-done-${theme}`);
      await s.page.getByTestId('export-again').click();
      await s.page.getByTestId('export-start').click();
      await expect(s.page.getByText('Waiting in the queue').first()).toBeVisible();
      await c.failJob(c.lastExport().id, 'ffmpeg exited with code 1: Invalid filtergraph');
      await expect(s.page.getByTestId('export-failed')).toBeVisible();
      await shot(s, `export-failed-${theme}`);
      await s.close();
    });

    test('versions panel', async () => {
      const s = await host({ theme });
      await s.page.getByTestId('host-open-versions').click();
      await s.page.waitForTimeout(600);
      await shot(s, `versions-${theme}`);
      await s.close();
    });

    test('library tabs and entry points', async () => {
      let s = await open('/library/?tab=edited', { theme });
      await shot(s, `library-edited-${theme}`);
      await s.page.getByTestId('edited-new').click();
      await s.page.waitForTimeout(400);
      await shot(s, `new-project-${theme}`);
      await s.close();

      s = await h.open('/library/?tab=edited', { theme, scenario: 'configured', settle: 800 });
      await shot(s, `library-edited-empty-${theme}`);
      await s.close();

      s = await open('/library/?tab=exported', { theme });
      await shot(s, `library-exported-${theme}`);
      await s.page.locator('[data-export-id="ex-done"]').getByTestId('export-play').click();
      await s.page.waitForTimeout(900);
      await shot(s, `library-exported-play-${theme}`);
      await s.close();

      s = await open('/library/?tab=clips', { theme });
      await s.page
        .getByTestId('clip-card')
        .first()
        .getByRole('button', { name: /^Open clip/ })
        .click();
      await s.page.getByTestId('clip-drawer').getByTestId('open-in-editor-button').click();
      await expect(s.page.getByTestId('open-in-editor')).toHaveAttribute('data-phase', 'choose');
      await s.page.waitForTimeout(400);
      await shot(s, `open-in-editor-choose-${theme}`);
      await s.close();

      s = await open('/library/?tab=clips', { theme, prepare: seedExports });
      editorState(s.state).createDelayMs = 6000;
      await s.page
        .getByTestId('clip-card')
        .first()
        .getByRole('button', { name: /^Open clip/ })
        .click();
      await s.page.getByTestId('clip-drawer').getByTestId('open-in-editor-button').click();
      await expect(s.page.getByTestId('open-in-editor')).toHaveAttribute('data-phase', 'preparing');
      await s.page.waitForTimeout(500);
      await shot(s, `open-in-editor-preparing-${theme}`);
      await s.close();

      s = await open('/tools/', { theme });
      await shot(s, `tools-${theme}`);
      await s.close();
    });
  });
}
