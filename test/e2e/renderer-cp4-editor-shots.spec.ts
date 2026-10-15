import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { openEditor, type EditorSession } from './support/editor-timeline-harness';
import { seedEditorBrand, type SeedBrandOptions } from './support/editor-brand-stub';

/**
 * CP4 editor Brand Kit screenshots (dark + light): the Apply Brand Kit dialog, the Brand Kit sections of every bin tab,
 * the inspector brand style chip, font picker and palette, and the editor after applying a kit.
 *   CLIPFERN_E2E_OUT=<private snapshot of the static export> CLIPFERN_SHOTS_DIR=<dir> npx playwright test test/e2e/renderer-cp4-editor-shots.spec.ts
 */
const SHOTS =
  process.env.CLIPFERN_SHOTS_DIR ?? path.resolve(__dirname, '../../.tmp/shots-cp4-editor');
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
const edit = (id = 'br-1', seed: SeedBrandOptions = {}, opts: OpenOptions = {}) =>
  openEditor(h, open, id, {
    seed: false,
    prepareState: (st) => void seedEditorBrand(st, seed),
    ...opts,
  });
const shot = async (s: EditorSession, name: string) => {
  await s.page.waitForTimeout(500);
  await s.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const binTab = (p: Page, t: string) => p.getByTestId(`bin-tab-${t}`).click();

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CP4 editor / ${theme}`, () => {
    test.setTimeout(240_000);

    test('apply dialog, bin tabs', async () => {
      const s = await edit('br-1', {}, { theme });
      const p = s.page;
      await shot(s, `editor-${theme}`);
      await p.getByTestId('open-apply-brand').click();
      await p.getByTestId('apply-part-intro').waitFor();
      await shot(s, `apply-dialog-${theme}`);
      await p.getByTestId('apply-brand-kit').click();
      await p.getByRole('option', { name: /Neon/ }).click();
      await shot(s, `apply-dialog-neon-${theme}`);
      await p.keyboard.press('Escape'); // select
      await p.keyboard.press('Escape'); // dialog
      for (const [tab, id] of [
        ['media', 'bin-brandkit-videos'],
        ['stickers', 'bin-brandkit-images'],
        ['audio', 'bin-brandkit-audio'],
        ['text', 'bin-brandkit-text'],
      ] as const) {
        await binTab(p, tab);
        await p.getByTestId(id).scrollIntoViewIfNeeded();
        await p.waitForTimeout(400);
        await shot(s, `bin-${tab}-${theme}`);
      }
      await binTab(p, 'media');
      await p.getByTestId('bin-stock').scrollIntoViewIfNeeded();
      await s.act('select', ['cue_1']);
      await shot(s, `bin-stock-${theme}`);
      expect(s.problems.filter((x) => !/GL Driver Message|GPU stall/.test(x))).toEqual([]);
      await s.close();
    });

    test('inspector: chip, font picker, palette; after applying', async () => {
      const s = await edit('br-1', {}, { theme });
      const p = s.page;
      await s.act('select', ['hook']);
      await p.getByTestId('brand-style-chip').click();
      await p.getByTestId('brand-style-popover').waitFor();
      await shot(s, `inspector-chip-${theme}`);
      await p.keyboard.press('Escape');
      await p.getByTestId('font-family').click();
      await p.getByRole('listbox').waitFor();
      await shot(s, `inspector-fonts-${theme}`);
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Colour: pick colour' }).click();
      await p.getByTestId('brand-swatches').waitFor();
      await shot(s, `inspector-swatches-${theme}`);
      await p.keyboard.press('Escape');
      // apply everything and look at the result
      await p.getByTestId('open-apply-brand').click();
      await p.getByTestId('apply-part-intro').waitFor();
      await p.getByTestId('apply-brand-go').click();
      await s.act('select', ['hook']);
      await s.act('setPlayhead', 4.5);
      await p.getByTestId('timeline').waitFor();
      await shot(s, `after-apply-${theme}`);
      expect(s.problems.filter((x) => !/GL Driver Message|GPU stall/.test(x))).toEqual([]);
      await s.close();
    });
  });
}

test('top bar at the minimum width keeps every control reachable', async () => {
  const s = await edit('br-1', {}, { width: 1280, height: 720 });
  const bar = s.page.getByTestId('editor-topbar');
  await shot(s, 'topbar-1280');
  const box = await bar.boundingBox();
  const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const id of ['open-apply-brand', 'open-versions', 'open-export']) {
    const b = await s.page.getByTestId(id).boundingBox();
    expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
  }
  await s.close();
});
