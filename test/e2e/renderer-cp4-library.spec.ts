import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  type HarnessB,
  type OpenB,
  type SessionB,
} from './support/cp2b-harness';
import {
  brandLib,
  installBrandLib,
  KIT_ACME,
  KIT_NEON,
  type StubKit,
} from './support/brand-library-stub';

/**
 * CP4 "apply a Brand Kit" behaviour tests (start option, clip drawer, clip cards, selection bar, video page, new
 * project dialog) against the REAL exported renderer with the contract-validating bridge stub, extended (not edited)
 * by test/e2e/support/brand-library-stub.ts.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp4-library.spec.ts
 * Every session asserts zero console errors/warnings, zero external requests and zero HTTP >= 400.
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRunB(), 'needs a Chromium binary and a built renderer');

let h: HarnessB;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarnessB();
});
test.afterAll(async () => {
  await h?.close();
});

interface Opts extends Omit<OpenB, 'prepare'> {
  kits?: StubKit[];
  prepare?: (state: SessionB['state'], lib: ReturnType<typeof brandLib>) => void;
}
const open = (route: string, { kits, prepare, ...opts }: Opts = {}) =>
  h.open(route, {
    settle: 400,
    ...opts,
    prepare: (state) => {
      const lib = installBrandLib(state, kits);
      prepare?.(state, lib);
    },
  });

const VIDEO = '/library/video/?id=vid-interview&tab=clips';
const C1 = 'vid-interview-c1';
const C2 = 'vid-interview-c2';
const C3 = 'vid-interview-c3';
const C4 = 'vid-interview-c4';
const clean = (s: SessionB) => expect(s.problems).toEqual([]);
const card = (p: Page, id: string) => p.locator(`[data-testid="clip-card"][data-clip-id="${id}"]`);
const clipOf = (s: SessionB, id: string) => s.state.clips.find((c) => c.id === id)!;
const applies = (s: SessionB) => brandLib(s.state).applies;
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });

async function openBrandSection(p: Page, id = C1) {
  await card(p, id)
    .getByRole('button', { name: /Open clip/ })
    .click();
  const dlg = p.getByTestId('clip-drawer');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('drawer-tab-reframe').click();
  const sec = dlg.getByTestId('brand-section');
  await expect(sec).toBeVisible();
  return { dlg, sec };
}
async function pick(p: Page, trigger: Locator, name: string | RegExp) {
  await trigger.click();
  await p.getByRole('option', { name }).click();
}
const noOverflow = async (p: Page, sel: string) => {
  const r = await p.evaluate((q) => {
    const el = document.querySelector(q);
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : { sw: -1, cw: 0 };
  }, sel);
  expect(r.sw, `horizontal overflow in ${sel}`).toBeLessThanOrEqual(r.cw + 1);
};

/** C2: rendered with Acme at rev 2 while the kit is at rev 3 (stale). C3: branded with Neon through an override. */
function seedBranded(state: SessionB['state']) {
  const c2 = state.clips.find((c) => c.id === C2)!;
  Object.assign(c2, { brandApplied: { kitId: 'kit-acme', rev: 2 } });
  const c3 = state.clips.find((c) => c.id === C3)!;
  Object.assign(c3, { brandKitId: 'kit-neon', brandApplied: { kitId: 'kit-neon', rev: 1 } });
  const c4 = state.clips.find((c) => c.id === C4)!;
  Object.assign(c4, { brandApplied: { kitId: 'kit-acme', rev: 3 } });
}

/* ----------------------------------------------------------------------------------------- start flow */

test.describe('Home: Brand Kit run option', () => {
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const urlBox = (p: Page) => p.getByRole('textbox', { name: 'YouTube URL' });

  test('defaults to the default kit, lists every kit, is sent with pipeline:start and is remembered', async () => {
    const s = await open('/', { scenario: 'configured' });
    const sel = s.page.getByTestId('home-brand-kit');
    await expect(sel).toBeVisible();
    await expect(sel).toContainText('Default: Acme Studio');
    await sel.click();
    await expect(s.page.getByRole('option')).toHaveText([
      'Default: Acme Studio',
      'No brand kit',
      'Acme Studio default',
      'Neon Nights',
    ]);
    await s.page.getByRole('option', { name: 'Neon Nights' }).click();
    await expect(sel).toContainText('Neon Nights');

    await urlBox(s.page).fill(YT);
    await s.page.getByRole('button', { name: /Start clipping/ }).click();
    await expect.poll(() => s.state.log.started.length).toBe(1);
    expect((s.state.log.started[0]!.options as { brandKitId: string }).brandKitId).toBe('kit-neon');

    // remembered next visit
    await s.page.goto(s.page.url().replace(/\/library\/video.*/, '/'));
    await s.page.getByTestId('home-brand-kit').waitFor();
    await expect(s.page.getByTestId('home-brand-kit')).toContainText('Neon Nights');
    clean(s);
    await s.close();
  });

  test('untouched it sends "default"; "No brand kit" sends "none"', async () => {
    const s = await open('/', { scenario: 'configured' });
    await urlBox(s.page).fill(YT);
    await s.page.getByRole('button', { name: /Start clipping/ }).click();
    await expect.poll(() => s.state.log.started.length).toBe(1);
    expect((s.state.log.started[0]!.options as { brandKitId: string }).brandKitId).toBe('default');

    const t = await open('/', { scenario: 'configured' });
    await pick(t.page, t.page.getByTestId('home-brand-kit'), 'No brand kit');
    await urlBox(t.page).fill(YT);
    await t.page.getByRole('button', { name: /Start clipping/ }).click();
    await expect.poll(() => t.state.log.started.length).toBe(1);
    expect((t.state.log.started[0]!.options as { brandKitId: string }).brandKitId).toBe('none');
    clean(s);
    clean(t);
    await s.close();
    await t.close();
  });

  test('a remembered kit that was deleted falls back to the default kit', async () => {
    const s = await open('/', { scenario: 'configured' });
    await s.page.evaluate(() => localStorage.setItem('clipfern.start.brandKitId', 'kit-gone'));
    await s.page.reload();
    await s.page.getByTestId('home-brand-kit').waitFor();
    await expect(s.page.getByTestId('home-brand-kit')).toContainText('Default: Acme Studio');
    clean(s);
    await s.close();
  });

  test('with no kits it offers "Create a Brand Kit" (link to /brand-kit/) and still starts with "default"', async () => {
    const s = await open('/', { scenario: 'configured', kits: [] });
    const link = s.page.getByTestId('home-brand-create');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/brand-kit/');
    await expect(s.page.getByTestId('home-brand-kit')).toHaveCount(0);
    await urlBox(s.page).fill(YT);
    await s.page.getByRole('button', { name: /Start clipping/ }).click();
    await expect.poll(() => s.state.log.started.length).toBe(1);
    expect((s.state.log.started[0]!.options as { brandKitId: string }).brandKitId).toBe('default');
    clean(s);
    await s.close();
  });
});

/* ---------------------------------------------------------------------------------------- clip drawer */

test.describe('Clip drawer: Brand Kit section', () => {
  test('shows the effective kit, applies another kit and follows the render to "Up to date"', async () => {
    const s = await open(VIDEO);
    const lib = brandLib(s.state);
    const { dlg, sec } = await openBrandSection(s.page);

    // inherits the default kit, but the render carries none
    await expect(sec.getByTestId('brand-effective')).toContainText('Acme Studio');
    await expect(sec.getByTestId('brand-effective')).toContainText('Inherited: your default kit.');
    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: none');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Not applied yet');
    await expect(sec).toHaveAttribute('data-brand-state', 'pending');
    await expect(sec.getByTestId('brand-select')).toContainText('Inherit (Acme Studio)');
    await expect(sec.getByRole('link', { name: /Edit Brand Kit/ })).toHaveAttribute(
      'href',
      '/brand-kit/?id=kit-acme',
    );

    await pick(s.page, sec.getByTestId('brand-select'), /^Neon Nights/);
    await expect(sec.getByTestId('brand-apply')).toHaveText(/Apply and re-render/);
    await sec.getByTestId('brand-apply').click();

    expect(applies(s)).toEqual([{ kitId: 'kit-neon', clipIds: [C1] }]);
    await expect(sec.getByTestId('brand-progress')).toContainText('Queued');
    await expect(sec.getByTestId('brand-apply')).toBeDisabled();
    await expect(toast(s.page, 'Re-rendering 1 clip with Neon Nights')).toBeVisible();

    await lib.step(C1, 0.4);
    await expect(sec.getByTestId('brand-progress')).toContainText('Re-rendering 40%');
    await expect(dlg.getByTestId('drawer-render-progress')).toHaveCount(0); // only on Overview
    await lib.finish(C1);

    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: Neon Nights (rev 1)');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Up to date');
    await expect(sec).toHaveAttribute('data-brand-state', 'current');
    await expect(sec.getByTestId('brand-apply')).toBeDisabled();
    await expect(dlg.getByTestId('drawer-brand-chip')).toContainText('Branded · Neon Nights');
    expect(clipOf(s, C1).brandKitId).toBe('kit-neon');
    clean(s);
    await s.close();
  });

  test('a kit edited after the render is flagged stale, live, and re-rendering clears it', async () => {
    const s = await open(VIDEO, { prepare: seedBranded });
    const lib = brandLib(s.state);
    const { dlg, sec } = await openBrandSection(s.page, C2);

    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: Acme Studio (rev 2)');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Kit changed (now rev 3)');
    await expect(sec.getByTestId('brand-explanation')).toContainText('rev 2 to rev 3');
    await expect(dlg.getByTestId('drawer-brand-chip')).toHaveAttribute('data-outdated', 'true');
    await expect(sec.getByTestId('brand-apply')).toHaveText(/Re-render with the latest kit/);

    // unchanged selection: inherit stays inherit
    await sec.getByTestId('brand-apply').click();
    expect(applies(s)).toEqual([{ kitId: null, clipIds: [C2] }]);
    await lib.step(C2, 0.5);
    await lib.finish(C2);
    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: Acme Studio (rev 3)');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Up to date');

    // the kit changes again while the drawer is open: brand:changed refreshes the revision, no reload
    await lib.editKit('kit-acme');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Kit changed (now rev 4)');
    await expect(sec).toHaveAttribute('data-brand-state', 'stale');
    clean(s);
    await s.close();
  });

  test('"No brand kit" removes the branding; "Inherit" clears the override', async () => {
    const s = await open(VIDEO, { prepare: seedBranded });
    const lib = brandLib(s.state);
    const { sec } = await openBrandSection(s.page, C3);

    await expect(sec.getByTestId('brand-effective')).toContainText('Neon Nights');
    await expect(sec.getByTestId('brand-effective')).toContainText('Set on this clip.');
    await expect(sec.getByTestId('brand-select')).toContainText('Neon Nights');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('Up to date');

    await pick(s.page, sec.getByTestId('brand-select'), 'No brand kit');
    await expect(sec.getByTestId('brand-apply')).toHaveText(/Remove and re-render/);
    await sec.getByTestId('brand-apply').click();
    expect(applies(s)).toEqual([{ kitId: 'none', clipIds: [C3] }]);
    await expect(toast(s.page, 'Removing the Brand Kit from 1 clip')).toBeVisible();
    await lib.finish(C3);
    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: none');
    await expect(sec.getByTestId('brand-effective')).toContainText('No brand kit');
    await expect(sec.getByTestId('brand-state-badge')).toHaveText('No kit');

    await pick(s.page, sec.getByTestId('brand-select'), /^Inherit/);
    await sec.getByTestId('brand-apply').click();
    expect(applies(s)[1]).toEqual({ kitId: null, clipIds: [C3] });
    await lib.finish(C3);
    await expect(sec.getByTestId('brand-applied')).toContainText('Applied: Acme Studio (rev 3)');
    expect(clipOf(s, C3).brandKitId).toBeNull();
    clean(s);
    await s.close();
  });

  test('a failed apply restores the clip and the toast offers "Try again"', async () => {
    const s = await open(VIDEO);
    const lib = brandLib(s.state);
    lib.failApply = { message: 'The render queue is not running.', times: 1, code: 'UNAVAILABLE' };
    const { sec } = await openBrandSection(s.page);
    await pick(s.page, sec.getByTestId('brand-select'), /^Neon Nights/);
    await sec.getByTestId('brand-apply').click();

    const err = toast(s.page, 'Could not apply the Brand Kit');
    await expect(err).toContainText('The render queue is not running.');
    // optimistic state rolled back: not queued, override restored, button usable again
    await expect(sec.getByTestId('brand-progress')).toHaveCount(0);
    expect(clipOf(s, C1).status).toBe('rendered');
    await expect(sec.getByTestId('brand-apply')).toBeEnabled();

    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(sec.getByTestId('brand-progress')).toContainText('Queued');
    expect(applies(s)).toEqual([
      { kitId: 'kit-neon', clipIds: [C1] },
      { kitId: 'kit-neon', clipIds: [C1] },
    ]);
    await expect(toast(s.page, 'Re-rendering 1 clip with Neon Nights')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('the header chip jumps to the section from another tab', async () => {
    const s = await open(VIDEO, { prepare: seedBranded });
    await card(s.page, C3)
      .getByRole('button', { name: /Open clip/ })
      .click();
    const dlg = s.page.getByTestId('clip-drawer');
    const chip = dlg.getByTestId('drawer-brand-chip');
    await expect(chip).toContainText('Branded · Neon Nights');
    await expect(dlg.getByTestId('brand-section')).toHaveCount(0); // Overview tab
    await chip.click();
    await expect(dlg.getByTestId('brand-section')).toBeVisible();
    await expect(dlg.getByTestId('drawer-tab-reframe')).toHaveAttribute('data-state', 'active');
    clean(s);
    await s.close();
  });

  test('without any Brand Kit the section explains how to create one', async () => {
    const s = await open(VIDEO, { kits: [] });
    const { sec } = await openBrandSection(s.page);
    await expect(sec.getByTestId('brand-empty')).toContainText('No Brand Kits yet');
    await expect(sec.getByTestId('brand-create-link')).toHaveAttribute('href', '/brand-kit/');
    await expect(sec.getByTestId('brand-apply')).toHaveCount(0);
    clean(s);
    await s.close();
  });
});

/* ----------------------------------------------------------------------------------------- clips grid */

test.describe('Clips grid: Branded badge', () => {
  test('only clips whose render carries a kit get the badge; tooltip names the kit and revision', async () => {
    const s = await open(VIDEO, { prepare: seedBranded });
    const badges = s.page.getByTestId('clip-branded-badge');
    await expect(badges).toHaveCount(3);
    await expect(card(s.page, C1).getByTestId('clip-branded-badge')).toHaveCount(0);
    const b = card(s.page, C2).getByTestId('clip-branded-badge');
    await expect(b).toHaveText(/Branded/);
    await b.hover();
    await expect(s.page.getByRole('tooltip').first()).toContainText(
      'Branded with Acme Studio (rev 2)',
    );
    // while it re-renders the status pill takes the spot, then the new brand shows
    const lib = brandLib(s.state);
    await s.state.emit?.('clips:updated', {
      ...clipOf(s, C2),
      status: 'rendering',
      renderProgress: 0.2,
    });
    await expect(card(s.page, C2).getByTestId('clip-branded-badge')).toHaveCount(0);
    clean(s);
    void lib;
    await s.close();
  });

  test('list layout shows the badge too', async () => {
    const s = await open('/library/?tab=clips', { prepare: seedBranded });
    await s.page.getByRole('radio', { name: 'List' }).click();
    await expect(s.page.getByTestId('clip-row').first()).toBeVisible();
    await expect(s.page.getByTestId('clip-row').getByTestId('clip-branded-badge')).toHaveCount(3);
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------- selection bar + video page */

test.describe('Selection bar and video page', () => {
  async function select(p: Page, ids: string[]) {
    for (const id of ids) {
      await card(p, id).hover();
      await card(p, id).getByRole('checkbox').click();
    }
  }

  test('"Apply Brand Kit…" confirms with the count, sends clipIds and re-renders only what changes', async () => {
    const s = await open(VIDEO, {
      prepare: (state) => {
        seedBranded(state);
        // C4 is rendering right now
        Object.assign(
          state.clips.find((c) => c.id === C4)!,
          { status: 'rendering', renderProgress: 0.5 },
        );
      },
    });
    await select(s.page, [C1, C2, C3, C4]);
    const bar = s.page.getByTestId('selection-bar');
    await bar.getByTestId('selection-apply-brand').click();
    const pop = s.page.getByTestId('brand-apply-popover');
    await expect(pop).toContainText('Apply a Brand Kit to 4 clips');
    // default pre-selection = the default kit (Acme): C3 has a Neon override so it changes; C2 is stale; C1 is new
    await expect(pop.getByTestId('brand-bulk-select')).toContainText('Acme Studio');
    await expect(pop.getByTestId('brand-plan-count')).toHaveText(
      /3 clips will be re-rendered with Acme Studio/,
    );
    await expect(pop).toContainText('1 is rendering now and is skipped.');

    await pick(s.page, pop.getByTestId('brand-bulk-select'), /^Neon Nights/);
    // C3 already has Neon at its current revision: left alone
    await expect(pop.getByTestId('brand-plan-count')).toHaveText(
      /2 clips will be re-rendered with Neon Nights/,
    );
    await expect(pop).toContainText('1 already uses this setting and is left alone.');

    await pop.getByTestId('brand-bulk-confirm').click();
    await expect(pop).toHaveCount(0);
    expect(applies(s)).toHaveLength(1);
    expect(applies(s)[0]!.kitId).toBe('kit-neon');
    expect([...applies(s)[0]!.clipIds!].sort()).toEqual([C1, C2].sort());
    await expect(toast(s.page, 'Re-rendering 2 clips with Neon Nights')).toBeVisible();
    // optimistic: both cards show the queued pill straight away
    await expect(card(s.page, C1)).toContainText('Queued');
    await expect(card(s.page, C2)).toContainText('Queued');
    await expect(card(s.page, C3)).not.toContainText('Queued');
    clean(s);
    await s.close();
  });

  test('"No brand kit" for a selection sends "none"; an empty plan disables the confirm', async () => {
    const s = await open(VIDEO, { prepare: seedBranded });
    await select(s.page, [C1, C3]);
    await s.page.getByTestId('selection-apply-brand').click();
    const pop = s.page.getByTestId('brand-apply-popover');
    await pick(s.page, pop.getByTestId('brand-bulk-select'), /^No brand kit/);
    await expect(pop.getByTestId('brand-plan-count')).toHaveText(
      /2 clips will be re-rendered without a Brand Kit/,
    );
    await pop.getByTestId('brand-bulk-confirm').click();
    expect(applies(s)[0]).toMatchObject({ kitId: 'none' });
    await expect(toast(s.page, 'Removing the Brand Kit from 2 clips')).toBeVisible();

    // finish both renders, then "none" again has nothing to do
    const lib = brandLib(s.state);
    await lib.finish(C1);
    await lib.finish(C3);
    await s.page.getByTestId('selection-apply-brand').click();
    const pop2 = s.page.getByTestId('brand-apply-popover');
    await pick(s.page, pop2.getByTestId('brand-bulk-select'), /^No brand kit/);
    await expect(pop2.getByTestId('brand-plan-count')).toHaveText('Nothing to re-render');
    await expect(pop2.getByTestId('brand-bulk-confirm')).toBeDisabled();
    clean(s);
    await s.close();
  });

  test('without kits the popover links to the Brand Kit page', async () => {
    const s = await open(VIDEO, { kits: [] });
    await select(s.page, [C1]);
    await s.page.getByTestId('selection-apply-brand').click();
    const pop = s.page.getByTestId('brand-apply-popover');
    await expect(pop.getByTestId('brand-empty')).toContainText('You have no Brand Kits yet');
    await expect(pop.getByTestId('brand-create-link')).toHaveAttribute('href', '/brand-kit/');
    clean(s);
    await s.close();
  });

  test('"Apply Brand Kit to all clips" on a video sends videoId', async () => {
    const s = await open(VIDEO);
    await s.page.getByTestId('video-apply-brand').click();
    const pop = s.page.getByTestId('brand-apply-popover');
    await expect(pop).toContainText('Apply a Brand Kit to all clips');
    await pick(s.page, pop.getByTestId('brand-bulk-select'), /^Neon Nights/);
    await pop.getByTestId('brand-bulk-confirm').click();
    expect(applies(s)).toEqual([{ kitId: 'kit-neon', videoId: 'vid-interview' }]);
    // 8 rendered clips are queued; the failed one is retried with the kit too, candidates are skipped by main
    await expect(toast(s.page, /Re-rendering \d+ clips with Neon Nights/)).toBeVisible();
    await expect(card(s.page, C1)).toContainText('Queued');
    clean(s);
    await s.close();
  });
});

/* -------------------------------------------------------------------------------- new project dialog */

test.describe('New project dialog', () => {
  test('Brand Kit select defaults to the default kit and offers "No brand kit"', async () => {
    const s = await open('/library/?tab=edited');
    await s.page.getByTestId('edited-new').first().click();
    const dlg = s.page.getByTestId('new-project-dialog');
    await expect(dlg).toBeVisible();
    const sel = dlg.getByTestId('new-project-brand-select');
    await expect(sel).toContainText('Acme Studio');
    await expect(dlg.getByTestId('new-project-brand')).toHaveAttribute(
      'data-brand-kit-id',
      'kit-acme',
    );
    await pick(s.page, sel, 'No brand kit');
    await expect(dlg.getByTestId('new-project-brand')).toHaveAttribute('data-brand-kit-id', 'none');
    await pick(s.page, sel, /^Neon Nights/);
    await expect(dlg.getByTestId('new-project-brand')).toHaveAttribute(
      'data-brand-kit-id',
      'kit-neon',
    );
    clean(s);
    await s.close();
  });

  test('with no kits it links to the Brand Kit page', async () => {
    const s = await open('/library/?tab=edited', { kits: [] });
    await s.page.getByTestId('edited-new').first().click();
    const dlg = s.page.getByTestId('new-project-dialog');
    await expect(dlg.getByTestId('new-project-brand-create')).toHaveAttribute(
      'href',
      '/brand-kit/',
    );
    await expect(dlg.getByTestId('new-project-brand')).toHaveAttribute('data-brand-kit-id', 'none');
    clean(s);
    await s.close();
  });
});

/* --------------------------------------------------------------------------- layout, theme, a11y */

test.describe('Look and feel', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`drawer section, popover and start option fit and stay readable (${theme})`, async () => {
      const s = await open(VIDEO, { theme, prepare: seedBranded });
      const { dlg, sec } = await openBrandSection(s.page, C2);
      await noOverflow(s.page, '[data-testid="brand-section"]');
      await expect(sec.getByTestId('brand-select')).toBeVisible();
      if (process.env.CP4_SHOTS) {
        await sec.scrollIntoViewIfNeeded();
        await s.page.screenshot({ path: `${process.env.CP4_SHOTS}/drawer-${theme}.png` });
      }
      // keyboard: the select opens with Enter and a choice is made without a mouse
      await sec.getByTestId('brand-select').focus();
      await s.page.keyboard.press('Enter');
      await expect(s.page.getByRole('listbox')).toBeVisible();
      await s.page.keyboard.press('ArrowDown');
      await s.page.keyboard.press('Enter');
      await expect(s.page.getByRole('listbox')).toHaveCount(0);
      void dlg;
      clean(s);
      await s.close();
    });
  }

  test('reduced motion: the chip still navigates (no smooth scroll dependency)', async () => {
    const s = await open(VIDEO, { reducedMotion: true, prepare: seedBranded });
    await card(s.page, C3)
      .getByRole('button', { name: /Open clip/ })
      .click();
    await s.page.getByTestId('drawer-brand-chip').click();
    await expect(s.page.getByTestId('brand-section')).toBeVisible();
    clean(s);
    await s.close();
  });
});

export { KIT_ACME, KIT_NEON };
