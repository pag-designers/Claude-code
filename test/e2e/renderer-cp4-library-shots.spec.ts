import { test, type Page } from '@playwright/test';
import { canRunB, createHarnessB, type HarnessB, type SessionB } from './support/cp2b-harness';
import { installBrandLib } from './support/brand-library-stub';

/**
 * Screenshots of the CP4 apply-a-Brand-Kit UI (dark + light) for design review.
 *   CP2B_OUT=<export dir> CP4_SHOTS=<dir> npx playwright test test/e2e/renderer-cp4-library-shots.spec.ts
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
const DIR = process.env.CP4_SHOTS;
test.skip(!canRunB() || !DIR, 'needs a Chromium binary, a built renderer and CP4_SHOTS=<dir>');

let h: HarnessB;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarnessB();
});
test.afterAll(async () => {
  await h?.close();
});

const VIDEO = '/library/video/?id=vid-interview&tab=clips';
const seed = (state: SessionB['state']) => {
  if (state.clips.length === 0) return;
  const c = (id: string) => state.clips.find((x) => x.id === id)!;
  Object.assign(c('vid-interview-c2'), { brandApplied: { kitId: 'kit-acme', rev: 2 } });
  Object.assign(c('vid-interview-c3'), {
    brandKitId: 'kit-neon',
    brandApplied: { kitId: 'kit-neon', rev: 1 },
  });
  Object.assign(c('vid-interview-c4'), { brandApplied: { kitId: 'kit-acme', rev: 3 } });
};
const shot = (p: Page, name: string) => p.screenshot({ path: `${DIR}/${name}.png` });

for (const theme of ['dark', 'light'] as const) {
  test(`shots ${theme}`, async () => {
    test.setTimeout(120_000);
    const open = (route: string, scenario: 'library' | 'configured' = 'library') =>
      h.open(route, {
        theme,
        scenario,
        settle: 700,
        prepare: (state) => {
          installBrandLib(state);
          seed(state);
        },
      });

    let s = await open('/', 'configured');
    await s.page.getByRole('textbox', { name: 'YouTube URL' }).fill('https://youtu.be/dQw4w9WgXcQ');
    await s.page.waitForTimeout(600);
    await shot(s.page, `home-${theme}`);
    await s.page.getByTestId('home-brand-kit').click();
    await shot(s.page, `home-open-${theme}`);
    await s.close();

    s = await open(VIDEO);
    await s.page.locator('[data-clip-id="vid-interview-c2"]').scrollIntoViewIfNeeded();
    await s.page.waitForTimeout(300);
    await shot(s.page, `grid-${theme}`);
    await s.page
      .locator('[data-clip-id="vid-interview-c2"] button[aria-label^="Open clip"]')
      .click();
    await s.page.getByTestId('drawer-tab-reframe').click();
    await s.page.getByTestId('brand-section').scrollIntoViewIfNeeded();
    await s.page.waitForTimeout(400);
    await shot(s.page, `drawer-stale-${theme}`);
    await s.page.keyboard.press('Escape');

    for (const id of ['vid-interview-c1', 'vid-interview-c2', 'vid-interview-c3']) {
      await s.page.locator(`[data-clip-id="${id}"]`).first().hover();
      await s.page.locator(`[data-clip-id="${id}"]`).first().getByRole('checkbox').click();
    }
    await s.page.getByTestId('selection-apply-brand').click();
    await s.page.waitForTimeout(400);
    await shot(s.page, `selection-popover-${theme}`);
    await s.close();

    s = await h.open(VIDEO, {
      theme,
      settle: 700,
      prepare: (state) => {
        installBrandLib(state, []);
      },
    });
    await s.page
      .locator('[data-clip-id="vid-interview-c1"] button[aria-label^="Open clip"]')
      .click();
    await s.page.getByTestId('drawer-tab-reframe').click();
    await s.page.getByTestId('brand-section').scrollIntoViewIfNeeded();
    await s.page.waitForTimeout(400);
    await shot(s.page, `drawer-empty-${theme}`);
    await s.close();

    s = await open('/library/?tab=edited');
    await s.page.getByTestId('edited-new').first().click();
    await s.page.waitForTimeout(400);
    await shot(s.page, `new-project-${theme}`);
    await s.close();
  });
}
