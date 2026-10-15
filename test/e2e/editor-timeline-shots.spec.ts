import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { editorState } from './support/editor-stub-panels';
import { itemBox, laneXY, openEditor } from './support/editor-timeline-harness';

/**
 * Editor shell + timeline screenshots, dark and light, 1440x900 and 1280x720.
 *   CLIPFERN_E2E_OUT=<private snapshot of the static export> npx playwright test test/e2e/editor-timeline-shots.spec.ts
 * Output: $CLIPFERN_SHOTS_DIR (default .tmp/shots-editor-timeline).
 */
const SHOTS =
  process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-editor-timeline');
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
const open = (route: string, opts: OpenOptions = {}) => h.open(route, { settle: 0, ...opts });

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1280, h: 720 },
] as const;

for (const theme of ['dark', 'light'] as const) {
  for (const size of SIZES) {
    test(`editor ${theme} ${size.w}x${size.h}`, async () => {
      test.setTimeout(180_000);
      const tag = `${theme}-${size.w}`;
      const shot = (s: { page: Page }, name: string) =>
        s.page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
      const s = await openEditor(h, open, 'tl-demo', { theme, width: size.w, height: size.h });
      const p = s.page;
      await p.waitForTimeout(1200); // thumbnails, waveforms
      await shot(s, '01-default');

      // selected clip + keyframes, playhead mid-project, a marker
      await s.act('setPlayhead', 7.2);
      await p.locator('[data-item-id="pip"][role="option"]').click();
      await p.mouse.move(size.w / 2, 10);
      await p.waitForTimeout(300);
      await shot(s, '02-selected-keyframes');

      // drag with snapping guide + ghost
      const px = (await s.store()).pxPerSec;
      const b = await itemBox(p, 'v4');
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.down();
      await p.mouse.move(b.x + b.width / 2 + 2.9 * px, b.y + b.height / 2, { steps: 8 });
      await p.waitForTimeout(200);
      await shot(s, '03-drag-snap-guide');
      await p.keyboard.press('Escape');
      await p.mouse.up();

      // right-click menu
      await p.locator('[data-item-id="v1"][role="option"]').click({ button: 'right' });
      await p.waitForTimeout(200);
      await shot(s, '04-context-menu');
      await p.keyboard.press('Escape');

      // zoomed in: frame ticks
      await s.act('setZoom', 400, 7.2);
      await p.waitForTimeout(500);
      await shot(s, '05-zoom-frames');
      await p.getByRole('button', { name: 'Zoom to fit' }).click();

      // shortcuts overlay
      await p.keyboard.press('?');
      await p.waitForTimeout(400);
      await shot(s, '06-shortcuts');
      await p.keyboard.press('Escape');
      expect(s.problems.filter((x) => !/GL Driver|GPU stall/.test(x))).toEqual([]);
      await s.close();
    });
  }
}

test('editor states: empty, conflict, locked/hidden tracks, big project', async () => {
  test.setTimeout(180_000);
  const s = await openEditor(h, open, 'tl-empty', { theme: 'dark' });
  await s.page.waitForTimeout(500);
  await s.page.screenshot({ path: path.join(SHOTS, '10-empty-dark-1440.png') });
  await s.close();

  const c = await openEditor(h, open, 'tl-demo', { theme: 'dark' });
  editorState(c.state).docs.get('tl-demo')!.rev += 1;
  await c.act('setPlayhead', 5);
  await c.page.locator('[data-item-id="v1"][role="option"]').click();
  await c.page.keyboard.press('s');
  await c.page.getByTestId('conflict-banner').waitFor({ timeout: 9000 });
  await c.page.waitForTimeout(500);
  await c.page.screenshot({ path: path.join(SHOTS, '11-conflict-dark-1440.png') });
  await c.close();

  const l = await openEditor(h, open, 'tl-demo', { theme: 'light' });
  await l.act('updateTrack', 'tr_sub', { locked: true });
  await l.act('updateTrack', 'tr_overlay', { hidden: true });
  await l.act('updateTrack', 'tr_music', { muted: true });
  await l.act('select', ['music', 'cue_3'], 'replace');
  await l.page.waitForTimeout(700);
  await l.page.screenshot({ path: path.join(SHOTS, '12-locked-hidden-light-1440.png') });
  await l.close();

  const big = await openEditor(h, open, 'tl-big', { theme: 'dark' });
  await big.act('setZoom', 90, 0);
  await big.page.waitForTimeout(800);
  await big.page.screenshot({ path: path.join(SHOTS, '13-big-dark-1440.png') });
  await big.close();
  expect(laneXY).toBeTruthy();
});
