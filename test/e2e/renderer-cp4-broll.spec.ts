import { expect, test, type Page } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openBroll, type BrollOpenOptions, type BrollSession } from './support/broll-stub';

/**
 * CP4 stock B-roll dialog against the REAL exported renderer with the contract-validating `window.clipfern` stub
 * (support/broll-stub.ts answers `broll:*`, everything else is the main stub). The dialog is mounted by the unlisted
 * reference page /design/broll/ (query: target=project|kit, q, suggest, open=0).
 *   CLIPFERN_E2E_OUT=<snapshot of renderer/out> npx playwright test test/e2e/renderer-cp4-broll.spec.ts
 * Every session asserts: zero console errors/warnings, zero external requests, zero HTTP >= 400.
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

type Opts = BrollOpenOptions;
const HOST = '/design/broll/';
const open = async (query = '', opts: Opts = {}): Promise<BrollSession> => {
  const s = await openBroll(h, `${HOST}${query}`, opts);
  await expect(dlg(s.page)).toBeVisible();
  return s;
};
const dlg = (p: Page) => p.getByTestId('broll-dialog');
const cards = (p: Page) => p.getByTestId('broll-card');
const card = (p: Page, i: number) => cards(p).nth(i);
const option = (p: Page, i: number) => p.locator(`[data-testid="broll-option"][data-index="${i}"]`);
const calls = (s: BrollSession, channel: string) =>
  s.stub.calls.filter((c) => c.channel === channel);
const searchFor = async (p: Page, q: string) => {
  await p.getByTestId('broll-query').fill(q);
  await p.getByTestId('broll-search').click();
};
const imported = async (p: Page): Promise<Record<string, unknown>[]> =>
  JSON.parse((await p.getByTestId('host-imported').textContent()) || '[]');
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });
/** Known cross-team console noise (route CSS preload of the sidebar's prefetch); everything else must be empty. */
const PRELOAD_NOISE = /was preloaded using link preload but not used within a few seconds/;
const problems = (s: BrollSession) => s.problems.filter((p) => !PRELOAD_NOISE.test(p));
const done = async (s: BrollSession) => {
  expect(problems(s)).toEqual([]);
  await s.close();
};
const itemId = (s: BrollSession, n: number, q = 'ocean', o = 'portrait', p = 'pexels') =>
  `${p}:${q}-${o}-${n}`;

test.describe('stock B-roll dialog', () => {
  test.setTimeout(120_000);

  test('both keys missing: guidance and a way to Settings, no error, no network call', async () => {
    const s = await open('', { stub: { keys: { pexels: false, pixabay: false } } });
    const p = s.page;
    await expect(p.getByTestId('broll-missing-key')).toBeVisible();
    await expect(p.getByText('Add your Pexels API key')).toBeVisible();
    await expect(p.getByTestId('broll-key-pexels')).toHaveAttribute('data-ready', 'false');
    await expect(p.getByTestId('broll-key-pixabay')).toHaveAttribute('data-ready', 'false');
    await expect(p.getByTestId('broll-query')).toBeDisabled();
    await expect(p.getByTestId('broll-search')).toBeDisabled();
    await expect(dlg(p).getByRole('alert')).toHaveCount(0);
    await expect(p.getByTestId('broll-switch-provider')).toHaveCount(0);
    await p.getByTestId('broll-tab-pixabay').click();
    await expect(p.getByText('Add your Pixabay API key')).toBeVisible();
    expect(calls(s, 'broll:search')).toHaveLength(0);

    // "Get a free key" opens the provider in the browser
    await p.getByRole('button', { name: /Get a free Pixabay key/ }).click();
    await expect
      .poll(() =>
        s.state.calls.filter((c) => c.channel === 'shell:openExternal').map((c) => c.payload),
      )
      .toEqual([{ url: 'https://pixabay.com/api/docs/' }]);

    await p.getByTestId('broll-open-settings').click();
    await expect(p).toHaveURL(/\/settings\/api-keys\/$/);
    await expect(dlg(p)).toHaveCount(0);
    await done(s);
  });

  test('one key set: starts on that provider, the other tab guides and offers to switch back', async () => {
    const s = await open('', { stub: { keys: { pexels: false, pixabay: true } } });
    const p = s.page;
    await expect(p.getByTestId('broll-tab-pixabay')).toHaveAttribute('aria-selected', 'true');
    await expect(p.getByTestId('broll-key-pixabay')).toHaveAttribute('data-ready', 'true');
    await expect(p.getByTestId('broll-key-pexels')).toHaveAttribute('data-ready', 'false');
    await searchFor(p, 'ocean');
    await expect(cards(p)).toHaveCount(8);
    expect(calls(s, 'broll:search')[0]!.payload).toMatchObject({ provider: 'pixabay' });

    await p.getByTestId('broll-tab-pexels').click();
    await expect(p.getByTestId('broll-missing-key')).toBeVisible();
    await p.getByTestId('broll-switch-provider').click();
    await expect(p.getByTestId('broll-tab-pixabay')).toHaveAttribute('aria-selected', 'true');
    await expect(cards(p)).toHaveCount(8); // served from the query cache, no new request
    expect(calls(s, 'broll:search')).toHaveLength(1);
    await done(s);
  });

  test('search: request shape, card details, credit link, attribution, orientation, empty result', async () => {
    const s = await open();
    const p = s.page;
    await expect(p.getByTestId('broll-tab-pexels')).toHaveAttribute('aria-selected', 'true');
    await expect(p.getByText('Find a clip to cut to')).toBeVisible();
    await expect(p.getByRole('radio', { name: 'Portrait' })).toBeChecked();
    await expect(p.getByTestId('broll-query')).toBeFocused();

    await searchFor(p, 'ocean');
    await expect(cards(p)).toHaveCount(8);
    expect(calls(s, 'broll:search')[0]!.payload).toEqual({
      provider: 'pexels',
      query: 'ocean',
      orientation: 'portrait',
      page: 1,
    });
    const c0 = card(p, 0);
    await expect(c0).toContainText('Ocean clip 1');
    await expect(c0).toContainText('0:06');
    await expect(c0).toContainText('1080×1920');
    await expect(c0.getByTestId('broll-credit')).toHaveText('by Ana Pexels');
    // portrait thumbnails are tall
    const box = (await option(p, 0).boundingBox())!;
    expect(box.height / box.width).toBeGreaterThan(1.6);
    // no author / no page link degrade gracefully
    await expect(card(p, 4).getByTestId('broll-credit')).toHaveText('View source');
    await expect(card(p, 6).getByTestId('broll-credit')).toHaveCount(0);
    await expect(card(p, 6)).toContainText('by Ben Pexels');

    await c0.getByTestId('broll-credit').click();
    await expect
      .poll(() => s.state.calls.filter((c) => c.channel === 'shell:openExternal').pop()?.payload)
      .toEqual({ url: 'https://www.pexels.com/video/ocean-0/' });
    await expect(c0).toHaveAttribute('data-state', 'idle'); // opening the credit did not select the clip

    const attribution = p.getByTestId('broll-attribution');
    await expect(attribution).toContainText('Videos provided by Pexels');
    await attribution.getByRole('link', { name: 'Pexels' }).click();
    await expect
      .poll(() => s.state.calls.filter((c) => c.channel === 'shell:openExternal').pop()?.payload)
      .toEqual({ url: 'https://www.pexels.com' });

    // orientation: landscape re-runs the search with wide thumbnails
    await p.getByRole('radio', { name: 'Landscape' }).click();
    await expect(card(p, 0)).toContainText('1920×1080');
    expect(calls(s, 'broll:search').pop()!.payload).toMatchObject({
      orientation: 'landscape',
      page: 1,
    });
    const wide = (await option(p, 0).boundingBox())!;
    expect(wide.width / wide.height).toBeGreaterThan(1.6);

    // an empty result is a normal state with a way forward
    await searchFor(p, 'nothing');
    await expect(p.getByText('No clips found')).toBeVisible();
    await p.getByRole('button', { name: 'Search any orientation' }).click();
    await expect(p.getByRole('radio', { name: 'Any' })).toBeChecked();
    await expect(p.getByText('No clips found')).toBeVisible();
    expect(calls(s, 'broll:search').pop()!.payload).toMatchObject({
      query: 'nothing',
      orientation: 'any',
    });
    await done(s);
  });

  test('Pixabay: its own attribution, and the honest note about client-side orientation filtering', async () => {
    const s = await open();
    const p = s.page;
    await p.getByTestId('broll-tab-pixabay').click();
    await searchFor(p, 'forest');
    await expect(cards(p)).toHaveCount(8);
    await expect(p.getByTestId('broll-attribution')).toContainText('Videos from Pixabay');
    await expect(p.getByTestId('broll-pixabay-note')).toContainText(
      'cannot filter videos by shape',
    );
    await p.getByRole('radio', { name: 'Any' }).click();
    await expect(cards(p)).toHaveCount(8);
    await expect(p.getByTestId('broll-pixabay-note')).toHaveCount(0);
    // mixed shapes in "any"
    const dims = await cards(p).evaluateAll((els) =>
      els.map((e) => e.querySelector('[data-testid="broll-option"]')!.getAttribute('aria-label')),
    );
    expect(dims.some((d) => d!.includes('1920×1080'))).toBe(true);
    expect(dims.some((d) => d!.includes('1080×1920'))).toBe(true);
    await done(s);
  });

  test('paging: Load more appends without moving what is on screen, then says it is the end', async () => {
    const s = await open();
    const p = s.page;
    await searchFor(p, 'ocean');
    await expect(cards(p)).toHaveCount(8);
    // position inside the scrolled content (the click itself scrolls the Load more button into view)
    const spot = () =>
      option(p, 0).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const box = el.closest('[data-testid="broll-results"]')!;
        return [r.top - box.getBoundingClientRect().top + box.scrollTop, r.left, r.width, r.height];
      });
    const before = await spot();
    await p.getByTestId('broll-more').click();
    await expect(cards(p)).toHaveCount(16);
    expect(await spot()).toEqual(before);
    await p.getByTestId('broll-more').click();
    await expect(cards(p)).toHaveCount(20);
    await expect(p.getByTestId('broll-more')).toHaveCount(0);
    await expect(p.getByTestId('broll-end')).toContainText('every clip Pexels has');
    expect(calls(s, 'broll:search').map((c) => (c.payload as { page: number }).page)).toEqual([
      1, 2, 3,
    ]);
    const ids = await cards(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(new Set(ids).size).toBe(20);
    await done(s);
  });

  test('failures: a rejected search shows the provider message with Try again; a failing page keeps what was loaded', async () => {
    const s = await open();
    const p = s.page;
    s.stub.searchFailure = { message: 'Pexels rate limit reached; try again in 42 s', times: 1 };
    await searchFor(p, 'ocean');
    const err = p.getByTestId('broll-search-error');
    await expect(err).toContainText('Pexels search failed');
    await expect(err).toContainText('Pexels rate limit reached; try again in 42 s');
    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(cards(p)).toHaveCount(8);

    s.stub.searchFailure = {
      message: 'Pexels did not answer in time. Check your connection and try again.',
      times: 1,
    };
    await p.getByTestId('broll-more').click();
    await expect(p.getByTestId('broll-more-error')).toContainText('did not answer in time');
    await expect(cards(p)).toHaveCount(8);
    await p.getByTestId('broll-more').click(); // button now reads "Try again"
    await expect(cards(p)).toHaveCount(16);
    await expect(p.getByTestId('broll-more-error')).toHaveCount(0);
    // a mid-session bridge failure of the status call is not part of this flow; the console stays clean
    await done(s);
  });

  test('hover and focus play one muted preview at a time; clips without a preview stay still', async () => {
    const s = await open('?q=ocean');
    const p = s.page;
    await expect(cards(p)).toHaveCount(8);
    const previews = p.getByTestId('broll-preview');
    await expect(previews).toHaveCount(0);

    await option(p, 0).hover();
    await expect(previews).toHaveCount(1);
    await expect(card(p, 0).getByTestId('broll-preview')).toHaveAttribute(
      'src',
      /\/__assets\/clip-a\.webm$/,
    );
    const v = card(p, 0).getByTestId('broll-preview');
    expect(await v.evaluate((el: HTMLVideoElement) => el.muted && el.loop)).toBe(true);
    await expect
      .poll(() => v.evaluate((el: HTMLVideoElement) => !el.paused && el.readyState >= 2))
      .toBe(true);

    await option(p, 1).hover();
    await expect(previews).toHaveCount(1);
    await expect(card(p, 1).getByTestId('broll-preview')).toHaveCount(1);
    await expect(card(p, 0).getByTestId('broll-preview')).toHaveCount(0);

    await p.mouse.move(2, 2);
    await expect(previews).toHaveCount(0);

    // a clip with no preview URL: nothing to play
    await option(p, 5).hover();
    await p.waitForTimeout(400);
    await expect(previews).toHaveCount(0);

    // keyboard focus plays too
    await option(p, 2).focus();
    await expect(card(p, 2).getByTestId('broll-preview')).toHaveCount(1);
    await option(p, 3).focus();
    await expect(previews).toHaveCount(1);
    await expect(card(p, 3).getByTestId('broll-preview')).toHaveCount(1);
    await done(s);
  });

  test('prefers-reduced-motion: no autoplay on hover, an explicit play button instead', async () => {
    const s = await open('?q=ocean', { reducedMotion: true });
    const p = s.page;
    await expect(cards(p)).toHaveCount(8);
    await option(p, 0).hover();
    await p.waitForTimeout(500);
    await expect(p.getByTestId('broll-preview')).toHaveCount(0);
    const play = card(p, 0).getByTestId('broll-play');
    await expect(play).toHaveAccessibleName('Play preview');
    await play.click();
    await expect(card(p, 0).getByTestId('broll-preview')).toHaveCount(1);
    await expect(play).toHaveAccessibleName('Pause preview');
    await play.click();
    await expect(p.getByTestId('broll-preview')).toHaveCount(0);
    await done(s);
  });

  test('Suggest with AI: uses the passage, shows chips, a chip runs the search; errors are shown', async () => {
    const passage = 'We left the city at dawn and drove until the neon turned to forest.';
    const s = await open(`?suggest=${encodeURIComponent(passage)}`);
    const p = s.page;
    const btn = p.getByTestId('broll-suggest');
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(p.getByTestId('broll-chip')).toHaveCount(4);
    expect(calls(s, 'broll:suggest')[0]!.payload).toEqual({ text: passage });
    await p.getByTestId('broll-chip').filter({ hasText: 'neon street rain' }).click();
    await expect(p.getByTestId('broll-query')).toHaveValue('neon street rain');
    await expect(cards(p)).toHaveCount(8);
    expect(calls(s, 'broll:search').pop()!.payload).toMatchObject({ query: 'neon street rain' });

    s.stub.suggest = { error: 'Add your Anthropic API key in Settings -> API Keys' };
    await btn.click();
    await expect(p.getByTestId('broll-suggest-error')).toContainText('Add your Anthropic API key');
    await expect(p.getByTestId('broll-chip')).toHaveCount(0);
    await done(s);
  });

  test('Suggest with AI without a passage works from a described query, and is off for an empty box', async () => {
    const s = await open();
    const p = s.page;
    const btn = p.getByTestId('broll-suggest');
    await expect(btn).toBeDisabled();
    await p.getByTestId('broll-query').fill('a busy street at night');
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(p.getByTestId('broll-chip')).toHaveCount(4);
    expect(calls(s, 'broll:suggest')[0]!.payload).toEqual({ text: 'a busy street at night' });
    await done(s);
  });

  test('multi-select import into a project: sequential, per-clip progress, one failing clip stays for retry', async () => {
    const s = await open('?q=ocean', { stub: { importDelayMs: 300 } });
    const p = s.page;
    await expect(cards(p)).toHaveCount(8);
    s.stub.failImports.add(itemId(s, 1));
    for (const i of [0, 1, 2]) await option(p, i).click();
    await expect(option(p, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(p.getByTestId('broll-count')).toHaveText('3 selected');
    await expect(p.getByTestId('broll-add')).toHaveText('Add 3 clips');

    await p.getByTestId('broll-add').click();
    await expect(p.getByTestId('broll-count')).toHaveText(/Adding 1 of 3/);
    await expect(card(p, 0)).toHaveAttribute('data-state', 'busy');
    await expect(card(p, 0).getByTestId('broll-busy')).toContainText('Downloading');
    await expect(p.getByTestId('broll-add')).toBeDisabled();
    await expect(p.getByTestId('broll-stop')).toBeVisible();
    await expect(card(p, 0)).toHaveAttribute('data-state', 'done');
    await expect(card(p, 1)).toHaveAttribute('data-state', 'busy');
    await expect(card(p, 1)).toHaveAttribute('data-state', 'error');
    await expect(card(p, 1).getByTestId('broll-error')).toContainText('no downloadable HD MP4');
    await expect(card(p, 2)).toHaveAttribute('data-state', 'done');
    await expect(p.getByTestId('broll-count')).toHaveText('1 selected');

    // contract: project target, sequential in selection order, never overlapping
    const imports = calls(s, 'broll:importToProject');
    expect(imports.map((c) => (c.payload as { item: { id: string } }).item.id)).toEqual([
      itemId(s, 0),
      itemId(s, 1),
      itemId(s, 2),
    ]);
    expect(imports.every((c) => (c.payload as { projectId: string }).projectId === 'proj-1')).toBe(
      true,
    );
    expect(imports[1]!.at - imports[0]!.at).toBeGreaterThanOrEqual(280);
    expect(imports[2]!.at - imports[1]!.at).toBeGreaterThanOrEqual(280);
    expect(calls(s, 'broll:importToKit')).toHaveLength(0);

    // onImported fired once per successful clip, with the project asset
    const got = await imported(p);
    expect(got).toHaveLength(2);
    expect(got.map((g) => (g as { asset: { id: string } }).asset.id)).toEqual([
      'asset-1',
      'asset-2',
    ]);
    expect((got[0] as { asset: { kind: string; width: number } }).asset).toMatchObject({
      kind: 'video',
      width: 1080,
    });
    await expect(toast(p, 'Added 2 clips · 1 failed')).toBeVisible();

    // added clips cannot be added twice; the failed one retries
    await option(p, 0).click({ force: true });
    await expect(option(p, 0)).toHaveAttribute('aria-selected', 'false');
    s.stub.failImports.clear();
    await p.getByTestId('broll-add').click();
    await expect(card(p, 1)).toHaveAttribute('data-state', 'done');
    expect(await imported(p)).toHaveLength(3);
    await expect(p.getByTestId('broll-count')).toHaveText('Nothing selected');
    await expect(p.getByTestId('broll-add')).toBeDisabled();
    await done(s);
  });

  test('kit target: imports into the Brand Kit and hands back the brand asset with its credit', async () => {
    const s = await open('?target=kit&q=ocean');
    const p = s.page;
    await expect(p.getByTestId('broll-dialog')).toContainText("Brand Kit's Videos section");
    await expect(cards(p)).toHaveCount(8);
    await option(p, 3).click();
    await p.getByTestId('broll-add').click();
    await expect(card(p, 3)).toHaveAttribute('data-state', 'done');
    const imp = calls(s, 'broll:importToKit');
    expect(imp).toHaveLength(1);
    expect(imp[0]!.payload).toMatchObject({ kitId: 'kit-1', item: { id: itemId(s, 3) } });
    expect(calls(s, 'broll:importToProject')).toHaveLength(0);
    const got = await imported(p);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      brandAsset: {
        kind: 'video',
        kitId: 'kit-1',
        credit: { source: 'pexels', author: 'Dev Pexels' },
      },
    });
    await expect(toast(p, 'Added 1 clip')).toBeVisible();
    await done(s);
  });

  test('closing mid-import stops after the clip in flight', async () => {
    const s = await open('?q=ocean', { stub: { importDelayMs: 400 } });
    const p = s.page;
    await expect(cards(p)).toHaveCount(8);
    for (const i of [0, 1, 2]) await option(p, i).click();
    await p.getByTestId('broll-add').click();
    await expect(card(p, 0)).toHaveAttribute('data-state', 'busy');
    await p.keyboard.press('Escape');
    await expect(dlg(p)).toHaveCount(0);
    await expect(toast(p, 'Added 1 clip')).toBeVisible();
    await expect.poll(async () => (await imported(p)).length).toBe(1);
    expect(calls(s, 'broll:importToProject')).toHaveLength(1);
    await done(s);
  });

  test('keyboard: type + Enter searches, arrows move through the grid, Space selects, Enter adds, Esc closes', async () => {
    const s = await open();
    const p = s.page;
    await expect(p.getByTestId('broll-query')).toBeFocused();
    await p.keyboard.type('ocean');
    await p.keyboard.press('Enter');
    await expect(cards(p)).toHaveCount(8);
    const active = () =>
      p.evaluate(() => document.activeElement?.getAttribute('data-index') ?? null);

    await p.keyboard.press('ArrowDown'); // from the search box into the grid
    expect(await active()).toBe('0');
    await p.keyboard.press('ArrowRight');
    expect(await active()).toBe('1');
    await p.keyboard.press('ArrowLeft');
    expect(await active()).toBe('0');
    await p.keyboard.press('ArrowDown');
    const cols = await p.getByTestId('broll-grid').evaluate((el) => {
      const tops = Array.from(el.querySelectorAll<HTMLElement>('[data-index]')).map(
        (c) => c.getBoundingClientRect().top,
      );
      return tops.filter((t) => Math.abs(t - tops[0]!) < 2).length;
    });
    expect(cols).toBeGreaterThanOrEqual(4);
    expect(await active()).toBe(String(Math.min(cols, 7)));
    await p.keyboard.press('ArrowUp');
    expect(await active()).toBe('0');
    await p.keyboard.press('End');
    expect(await active()).toBe('7');
    await p.keyboard.press('Home');
    expect(await active()).toBe('0');

    // Space selects; Enter adds the selection
    await p.keyboard.press('Space');
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Space');
    await expect(p.getByTestId('broll-count')).toHaveText('2 selected');
    await p.keyboard.press('Space'); // toggles off again
    await expect(p.getByTestId('broll-count')).toHaveText('1 selected');
    await p.keyboard.press('Enter');
    await expect(card(p, 0)).toHaveAttribute('data-state', 'done');
    expect(await imported(p)).toHaveLength(1);

    // with nothing selected, Enter adds the focused clip
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('ArrowRight');
    expect(await active()).toBe('2');
    await p.keyboard.press('Enter');
    await expect(card(p, 2)).toHaveAttribute('data-state', 'done');
    expect(
      calls(s, 'broll:importToProject').map((c) => (c.payload as { item: { id: string } }).item.id),
    ).toEqual([itemId(s, 0), itemId(s, 2)]);

    await p.keyboard.press('Escape');
    await expect(dlg(p)).toHaveCount(0);
    await expect(p.getByTestId('broll-host')).toHaveAttribute('data-open', 'false');
    await done(s);
  });

  test('tabs and orientation are reachable by arrow keys', async () => {
    const s = await open();
    const p = s.page;
    await p.getByTestId('broll-tab-pexels').focus();
    await p.keyboard.press('ArrowRight');
    await expect(p.getByTestId('broll-tab-pixabay')).toHaveAttribute('aria-selected', 'true');
    await p.getByRole('radio', { name: 'Portrait' }).focus();
    await p.keyboard.press('ArrowRight');
    await expect(p.getByRole('radio', { name: 'Landscape' })).toBeChecked();
    await done(s);
  });

  for (const [w, hgt] of [
    [1280, 720],
    [1920, 1080],
    [3440, 1440],
  ] as const) {
    test(`layout at ${w}x${hgt}: dialog fits, grid fills it without sideways scroll`, async () => {
      const s = await open('?q=ocean', { width: w, height: hgt });
      const p = s.page;
      await expect(cards(p)).toHaveCount(8);
      const box = (await dlg(p).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w);
      expect(box.y + box.height).toBeLessThanOrEqual(hgt);
      expect(box.width).toBeLessThanOrEqual(1200);
      const res = p.getByTestId('broll-results');
      expect(await res.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // the footer actions stay on screen
      const add = (await p.getByTestId('broll-add').boundingBox())!;
      expect(add.y + add.height).toBeLessThanOrEqual(hgt);
      const first = (await card(p, 0).boundingBox())!;
      const last = (await card(p, 7).boundingBox())!;
      if (w >= 1280) expect(last.y).toBeGreaterThanOrEqual(first.y); // wraps or stays on the row, never overlaps
      await done(s);
    });
  }

  test('light theme: opens and searches with a clean console', async () => {
    const s = await open('?q=ocean', { theme: 'light' });
    await expect(cards(s.page)).toHaveCount(8);
    await expect(s.page.locator('html')).toHaveAttribute('data-theme', 'light');
    await done(s);
  });
});
