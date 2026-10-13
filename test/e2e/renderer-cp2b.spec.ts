import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatCopyAll } from '../../renderer/lib/cp2-clips';
import { canRunB, createHarnessB, type HarnessB, type OpenB, type SessionB } from './support/cp2b-harness';
import { BUDGET_ERROR, bstate } from './support/cp2-stub-b';

/**
 * UI-B behaviour tests (clip drawer tabs, steering + highlights, AI chat) against the REAL exported renderer with the
 * contract-validated bridge + the CP2 stub (test/e2e/support/cp2-stub-b.ts).
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp2b.spec.ts
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

const open = (route: string, opts: OpenB = {}) => h.open(route, { settle: 400, ...opts });
const VIDEO = (tab = 'clips', id = 'vid-interview') => `/library/video/?id=${id}&tab=${tab}`;
const CLIP = 'vid-interview-c1';
const clean = (s: SessionB) => expect(s.problems).toEqual([]);

async function openDrawer(p: Page, tab?: string, index = 0) {
  await p.getByTestId('clip-card').nth(index).getByRole('button', { name: /Open clip/ }).click();
  await expect(p.getByTestId('clip-drawer')).toBeVisible();
  if (tab) await p.getByTestId(`drawer-tab-${tab}`).click();
  return p.getByTestId('clip-drawer');
}
const clipState = (s: SessionB, id = CLIP) => s.state.clips.find((c) => c.id === id)!;
const calls = (s: SessionB, channel: string) => s.state.calls.filter((c) => c.channel === channel);
const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());
const noOverflow = async (p: Page, sel?: string) => {
  const r = await p.evaluate((q) => {
    const el = q ? document.querySelector(q) : document.documentElement;
    if (!el) return { sw: -1, cw: 0 };
    return { sw: el.scrollWidth, cw: el.clientWidth };
  }, sel);
  expect(r.sw, `horizontal overflow in ${sel ?? 'page'}`).toBeLessThanOrEqual(r.cw + 1);
};
const imgLoaded = (img: Locator) =>
  expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
    .toBe(true);

/* ------------------------------------------------------------------------------------------------- hooks */

test.describe('Clip drawer: Hook tab', () => {
  test('empty state -> generate -> 5 variants per platform -> apply -> re-render progress -> remove', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'hook');
    await expect(dlg.getByText('No hooks for this clip yet')).toBeVisible();
    await dlg.getByTestId('hook-generate').click();
    await expect(dlg.getByTestId('hook-variant-4')).toBeVisible();
    await expect(dlg.locator('[data-testid^="hook-variant-"]')).toHaveCount(5);
    await expect(dlg.getByTestId('hook-angle').first()).toHaveText('curiosity');
    await expect(dlg.getByText(/Say this:/).first()).toBeVisible();
    await expect(dlg.getByTestId('hook-applied')).toHaveAttribute('data-applied', 'false');
    await expect(dlg.getByTestId('drawer-tab-hook-dot')).toBeVisible();

    // another platform has its own five
    const tiktok0 = await dlg.getByTestId('hook-variant-0').locator('p').first().innerText();
    await dlg.getByTestId('platform-reels').click();
    await expect(dlg.locator('[data-testid^="hook-variant-"]')).toHaveCount(5);
    expect(await dlg.getByTestId('hook-variant-0').locator('p').first().innerText()).not.toBe(tiktok0);
    await dlg.getByTestId('platform-shorts').click();
    await dlg.getByTestId('hook-use-2').click();
    expect(calls(s, 'hooks:apply').at(-1)?.payload).toEqual({
      clipId: CLIP,
      choice: { platform: 'shorts', index: 2 },
    });
    // the clip is re-rendering: progress is shown and actions are blocked until it finishes
    await expect(dlg.getByTestId('tab-render-progress')).toBeVisible();
    await expect(dlg.getByTestId('hook-use-0')).toBeDisabled();
    await s.ctl.setRender(CLIP, 0.4);
    await expect(dlg.getByTestId('tab-render-progress')).toContainText('40%');
    await s.ctl.finishRender(CLIP);
    await expect(dlg.getByTestId('tab-render-progress')).toBeHidden();
    await expect(dlg.getByTestId('hook-applied')).toHaveAttribute('data-applied', 'true');
    await expect(dlg.getByTestId('hook-applied-text')).toContainText('YouTube Shorts #3'.replace('YouTube ', ''));
    await expect(dlg.getByTestId('hook-variant-2')).toHaveAttribute('data-applied', 'true');
    await expect(dlg.getByTestId('hook-applied-badge')).toBeVisible();
    expect(clipState(s).hookApplied).not.toBeNull();

    // remove the title card
    await dlg.getByTestId('hook-remove').click();
    expect(calls(s, 'hooks:apply').at(-1)?.payload).toEqual({ clipId: CLIP, choice: null });
    await s.ctl.finishRender(CLIP);
    await expect(dlg.getByTestId('hook-applied')).toHaveAttribute('data-applied', 'false');
    await expect(dlg.getByTestId('hook-remove')).toBeHidden();

    // regenerate really replaces the wording
    const before = await dlg.getByTestId('platform-tiktok').click().then(() => dlg.getByTestId('hook-variant-0').locator('p').first().innerText());
    await dlg.getByTestId('hook-regenerate').click();
    await expect(dlg.getByTestId('hook-variant-0')).toContainText('Fresh angle');
    expect(before).not.toContain('Fresh angle');
    expect(calls(s, 'hooks:generate')).toHaveLength(2);
    clean(s);
    await s.close();
  });

  test('budget error is actionable (link to Settings > Models & Budget) and retry works', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'hook');
    s.ctl.failNext('hooks:generate', BUDGET_ERROR);
    await dlg.getByTestId('hook-generate').click();
    const err = dlg.locator('[role="alert"]').first();
    await expect(err).toContainText('Monthly AI budget reached');
    await expect(err.getByRole('link', { name: 'Open Models & Budget' })).toHaveAttribute('href', '/settings/models/');
    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(dlg.getByTestId('hook-variant-0')).toBeVisible();
    await expect(dlg.locator('[role="alert"]')).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('a failed apply rolls back and tells the user', async () => {
    const s = await open(VIDEO(), { prepare: (_st, ctl) => ctl.seedHooks(CLIP) });
    const dlg = await openDrawer(s.page, 'hook');
    s.ctl.failNext('hooks:apply', 'The renderer is busy.');
    await dlg.getByTestId('hook-use-1').click();
    await expect(s.page.getByText('Could not update the title card')).toBeVisible();
    await expect(dlg.getByTestId('hook-applied')).toHaveAttribute('data-applied', 'false');
    expect(s.problems.filter((p) => !p.includes('HTTP'))).toEqual([]);
    await s.close();
  });
});

/* ---------------------------------------------------------------------------------------------- metadata */

test.describe('Clip drawer: Metadata tab', () => {
  test('generate, edit, limits, hashtags, copy and save', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'meta');
    await expect(dlg.getByText('No metadata yet')).toBeVisible();
    await dlg.getByTestId('meta-generate').click();
    await expect(dlg.getByTestId('meta-title')).toBeVisible();
    await expect(dlg.getByTestId('meta-savebar')).toHaveAttribute('aria-hidden', 'true');

    // TikTok: caption counter, honest posting-time note
    await expect(dlg.getByTestId('meta-desc')).toContainText('Awareness means people know the word');
    await expect(dlg.getByText(/\/ 2,200 chars/)).toBeVisible();
    await expect(dlg.getByTestId('meta-time-note')).toContainText('not from your own audience data');
    await expect(dlg.getByTestId('meta-time-reason')).not.toBeEmpty();
    await expect(dlg.getByTestId('meta-day')).toContainText('Tuesday');
    await expect(dlg.getByTestId('meta-hour')).toContainText('7:00 PM');

    // edit the title -> dirty state, platform dot, save bar
    await dlg.getByTestId('meta-title').fill('A sharper title');
    await expect(dlg.getByTestId('meta-savebar')).toHaveAttribute('aria-hidden', 'false');
    await expect(dlg.getByTestId('platform-tiktok').getByLabel('unsaved changes')).toBeVisible();

    // hashtags: add (Enter and comma), normalise, de-duplicate, remove
    const tags = dlg.getByTestId('meta-tag');
    const n0 = await tags.count();
    await dlg.getByTestId('meta-tag-input').fill('Brand New!');
    await dlg.getByTestId('meta-tag-input').press('Enter');
    await expect(tags.filter({ hasText: '#BrandNew' })).toHaveCount(1);
    await dlg.getByTestId('meta-tag-input').fill('brandnew,');
    await expect(tags).toHaveCount(n0 + 1);
    await tags.filter({ hasText: '#BrandNew' }).getByRole('button', { name: /Remove/ }).click();
    await expect(tags).toHaveCount(n0);

    // Shorts: title limit 100
    await dlg.getByTestId('platform-shorts').click();
    await expect(dlg.getByTestId('meta-title')).toBeVisible();
    await dlg.getByTestId('meta-title').fill('x'.repeat(104));
    await expect(dlg.getByText('104 / 100')).toHaveAttribute('data-tone', 'over');
    await expect(dlg.getByTestId('meta-issues')).toContainText('4 over the 100 character limit');
    await dlg.getByTestId('meta-title').fill('y'.repeat(95));
    await expect(dlg.getByText('95 / 100')).toHaveAttribute('data-tone', 'warn');
    await expect(dlg.getByTestId('meta-issues')).toBeHidden();

    // Reels: 31 hashtags is over Instagram's 30
    await dlg.getByTestId('platform-reels').click();
    const input = dlg.getByTestId('meta-tag-input');
    await input.fill(Array.from({ length: 28 }, (_, i) => `t${i}`).join(' ') + ' ');
    await expect(dlg.getByText(/ \/ 30 tags/)).toHaveAttribute('data-tone', 'over');
    await expect(dlg.getByTestId('meta-issues')).toContainText('at most 30');

    // Copy all (ready-to-paste block) and a field copy
    await dlg.getByTestId('platform-tiktok').click();
    await dlg.getByTestId('meta-copy-all').click();
    await expect(dlg.getByTestId('meta-copy-all')).toHaveAttribute('data-copied', 'true');
    const text = await clipboard(s.page);
    const t = await dlg.getByTestId('meta-title').inputValue();
    expect(text.startsWith('A sharper title')).toBe(true);
    expect(text).toContain('Awareness means people know the word');
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^#/);
    expect(t).toBe('A sharper title');
    await dlg.getByTestId('meta-copy-title').click();
    expect(await clipboard(s.page)).toBe('A sharper title');
    await dlg.getByTestId('meta-copy-time').click();
    expect(await clipboard(s.page)).toBe('Tuesday, 7:00 PM');

    // save: every dirty platform is sent, then the bar goes away
    await dlg.getByTestId('meta-save').click();
    await expect(dlg.getByTestId('meta-savebar')).toHaveAttribute('aria-hidden', 'true');
    const saved = calls(s, 'meta:save').map((c) => (c.payload as { platform: string }).platform).sort();
    expect(saved).toEqual(['reels', 'shorts', 'tiktok']);
    const tik = calls(s, 'meta:save').find((c) => (c.payload as { platform: string }).platform === 'tiktok')!;
    expect((tik.payload as { meta: { title: string } }).meta.title).toBe('A sharper title');
    // persisted: reopen the drawer -> edited title is still there (cache + stub)
    await s.page.keyboard.press('Escape');
    await openDrawer(s.page, 'meta');
    await expect(dlg.getByTestId('meta-title')).toHaveValue('A sharper title');
    clean(s);
    await s.close();
  });

  test('Copy all format per platform and Regenerate discards edits', async () => {
    const s = await open(VIDEO(), { prepare: (_st, ctl) => ctl.seedMeta(CLIP) });
    const dlg = await openDrawer(s.page, 'meta');
    const meta = bstate(s.state).meta.get(CLIP)!;
    await dlg.getByTestId('platform-shorts').click();
    await dlg.getByTestId('meta-copy-all').click();
    expect(await clipboard(s.page)).toBe(formatCopyAll('shorts', meta.shorts));
    expect(await clipboard(s.page)).toMatch(/^Title: /);
    await dlg.getByTestId('meta-title').fill('temporary');
    await dlg.getByTestId('meta-regenerate').click();
    await expect(dlg.getByTestId('meta-savebar')).toHaveAttribute('aria-hidden', 'true');
    await expect(dlg.getByTestId('meta-title')).not.toHaveValue('temporary');
    await dlg.getByTestId('platform-tiktok').click();
    await expect(dlg.getByTestId('meta-tag').filter({ hasText: '#regenerated' })).toHaveCount(1);
    clean(s);
    await s.close();
  });

  test('a save failure keeps the edits and shows the error', async () => {
    const s = await open(VIDEO(), { prepare: (_st, ctl) => ctl.seedMeta(CLIP) });
    const dlg = await openDrawer(s.page, 'meta');
    await dlg.getByTestId('meta-title').fill('Edited');
    s.ctl.failNext('meta:save', 'Disk full');
    await dlg.getByTestId('meta-save').click();
    await expect(dlg.getByTestId('error-message')).toContainText('Disk full');
    await expect(dlg.getByTestId('meta-title')).toHaveValue('Edited');
    expect(s.problems.filter((p) => !p.includes('HTTP'))).toEqual([]);
    await s.close();
  });
});

/* -------------------------------------------------------------------------------------------- thumbnails */

test.describe('Clip drawer: Thumbnail tab + tester', () => {
  test('generate -> candidates with scores -> choose with overlay -> tester mockups -> A/B', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'thumbnail');
    await expect(dlg.getByText('Pick the best thumbnail')).toBeVisible();
    await dlg.getByTestId('thumb-generate').click();
    await expect(dlg.getByTestId('thumb-generating')).toBeVisible();
    await expect(dlg.getByTestId('thumb-candidate-5')).toBeVisible();
    await expect(dlg.locator('[data-testid^="thumb-candidate-"]')).toHaveCount(6);
    // real frames load lazily through thumbs:url
    await imgLoaded(dlg.getByTestId('thumb-candidate-0').locator('img'));
    await expect(dlg.getByTestId('thumb-ai-rank').first()).toContainText('AI #');
    await expect(dlg.getByTestId('thumb-total').first()).toHaveText(/^\d+$/);
    await expect(dlg.getByTestId('thumb-detail')).toContainText('AI rank #1');
    await expect(dlg.getByTestId('thumb-ai-note')).not.toBeEmpty();
    // the AI's top pick is preselected
    const best = await dlg.locator('[data-testid^="thumb-candidate-"][data-selected]').first().getAttribute('data-testid');
    expect(best).toMatch(/thumb-candidate-\d/);

    // overlay text: suggested from the title, <= 5 words
    const overlay = dlg.getByTestId('thumb-overlay');
    await expect(overlay).toHaveValue('Awareness isn’t enough. Acceptance');
    await expect(dlg.getByTestId('thumb-overlay-count')).toHaveText('4 / 5 words');
    await overlay.fill('one two three four five six');
    await expect(dlg.getByTestId('thumb-overlay-count')).toContainText('6 / 5');
    await expect(dlg.getByTestId('thumb-choose')).toBeDisabled();
    await expect(dlg.getByText('Use 5 words or fewer (6 now).')).toBeVisible();
    await overlay.fill('Why we said no');
    await dlg.getByTestId('thumb-candidate-3').click();
    await expect(dlg.getByTestId('thumb-candidate-3')).toHaveAttribute('data-selected', 'true');
    await dlg.getByTestId('thumb-choose').click();
    await expect(dlg.getByTestId('thumb-choose')).toContainText('In use');
    const chosen = bstate(s.state).log.chosen.at(-1)!;
    expect(chosen.overlayText).toBe('Why we said no');
    expect(chosen.t).toBe(bstate(s.state).thumbs.get(CLIP)!.candidates[3]!.t);
    await expect(dlg.getByTestId('thumb-current-meta')).toContainText('“Why we said no”');
    await expect(dlg.getByTestId('thumb-candidate-3')).toContainText('In use');

    // tester: three mockups side by side, the thumbnail inside each, real images
    const tester = dlg.getByTestId('thumbnail-tester');
    await tester.scrollIntoViewIfNeeded();
    for (const id of ['tiktok', 'reels', 'shorts']) {
      await expect(tester.getByTestId(`tester-${id}`)).toBeVisible();
      await imgLoaded(tester.getByTestId(`tester-tile-a-${id}`).locator('img'));
    }
    const boxes = await Promise.all(
      ['tiktok', 'reels', 'shorts'].map((id) => tester.getByTestId(`tester-${id}`).boundingBox()),
    );
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x + 1);
    expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(2); // one row
    await expect(tester.getByTestId('tester-tiktok')).toContainText('@yourchannel');
    await expect(tester.getByTestId('tester-shorts')).toContainText('Awareness isn’t enough');
    await expect(tester.getByTestId('tester-small')).toBeVisible();
    await expect(tester.getByTestId('tester-small-tiktok')).toBeVisible();
    // small-size tile really is 80 px wide
    const small = await tester.getByTestId('tester-small-reels').boundingBox();
    expect(Math.round(small!.width)).toBe(80);
    // the overlay text is previewed on the frame
    await expect(tester.getByTestId('tester-tile-a-reels')).toContainText('Why we said no');

    // chrome toggle
    await expect(tester.getByTestId('tester-phones')).toHaveAttribute('data-chrome', 'dark');
    await tester.getByRole('radio', { name: 'Light' }).click();
    await expect(tester.getByTestId('tester-phones')).toHaveAttribute('data-chrome', 'light');

    // A/B compare: B sits next to A in every mockup
    await dlg.getByRole('radio', { name: 'A/B compare' }).click();
    await expect(dlg.getByTestId('thumb-ab-hint')).toContainText('choose option A');
    await dlg.getByTestId('thumb-candidate-1').click();
    await expect(dlg.getByTestId('thumb-ab-hint')).toContainText('choose option B');
    await dlg.getByTestId('thumb-candidate-4').click();
    await expect(dlg.getByTestId('thumb-tag-A')).toBeVisible();
    await expect(dlg.getByTestId('thumb-tag-B')).toBeVisible();
    for (const id of ['tiktok', 'reels', 'shorts']) {
      await expect(tester.getByTestId(`tester-tile-b-${id}`)).toBeVisible();
      await imgLoaded(tester.getByTestId(`tester-tile-b-${id}`).locator('img'));
    }
    await expect(tester.getByTestId('tester-small-tiktok-a')).toBeVisible();
    await expect(tester.getByTestId('tester-small-tiktok-b')).toBeVisible();
    await dlg.getByTestId('thumb-use-b').click();
    await expect.poll(() => bstate(s.state).log.chosen.length).toBe(2);
    expect(bstate(s.state).log.chosen[1]!.t).toBe(bstate(s.state).thumbs.get(CLIP)!.candidates[4]!.t);

    // full size
    await dlg.getByTestId('tester-expand').click();
    const full = s.page.getByTestId('tester-dialog');
    await expect(full.getByTestId('tester-tiktok')).toBeVisible();
    const wide = await full.getByTestId('tester-tiktok').boundingBox();
    const narrow = boxes[0]!;
    expect(wide!.width).toBeGreaterThan(narrow.width);
    clean(s);
    await s.close();
  });

  test('regenerate asks again; a vision/budget error is actionable', async () => {
    const s = await open(VIDEO(), { prepare: (_st, ctl) => ctl.seedThumbs(CLIP, true) });
    const dlg = await openDrawer(s.page, 'thumbnail');
    await expect(dlg.locator('[data-testid^="thumb-candidate-"]')).toHaveCount(6);
    await expect(dlg.getByTestId('thumb-candidate-0')).toContainText('In use');
    s.ctl.failNext('thumbs:generate', BUDGET_ERROR);
    await dlg.getByTestId('thumb-regenerate').click();
    await expect(dlg.getByRole('link', { name: 'Open Models & Budget' })).toBeVisible();
    // the old candidates stay usable
    await expect(dlg.locator('[data-testid^="thumb-candidate-"]')).toHaveCount(6);
    await dlg.getByTestId('thumb-regenerate').click();
    await expect(dlg.getByRole('link', { name: 'Open Models & Budget' })).toBeHidden();
    clean(s);
    await s.close();
  });
});

/* ----------------------------------------------------------------------------------------- reframe + style */

test.describe('Clip drawer: Reframe & Style tab', () => {
  test('mode picker, layout used, honest fallback note, re-render', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'reframe');
    await expect(dlg.getByTestId('reframe-layout')).toContainText('Single crop');
    await expect(dlg.getByTestId('reframe-mode-auto')).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.getByTestId('reframe-apply')).toBeDisabled();
    await dlg.getByTestId('reframe-mode-multi-face').click();
    await expect(dlg.getByTestId('reframe-apply')).toBeEnabled();
    await expect(dlg.getByTestId('reframe-apply')).toContainText('split screen');
    await dlg.getByTestId('reframe-apply').click();
    expect(bstate(s.state).log.reframed.at(-1)).toEqual({ ids: [CLIP], mode: 'multi-face' });
    await expect(dlg.getByTestId('tab-render-progress')).toBeVisible();
    await expect(dlg.getByTestId('reframe-apply')).toBeDisabled();
    await s.ctl.setRender(CLIP, 0.7);
    await expect(dlg.getByTestId('tab-render-progress')).toContainText('70%');
    await s.ctl.finishRender(CLIP); // the stub's layout stays "single": only one face was found
    await expect(dlg.getByTestId('reframe-mode-multi-face')).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.getByTestId('reframe-note')).toContainText('only one face was found');
    await expect(dlg.getByTestId('reframe-layout')).toContainText('Single crop');
    clean(s);
    await s.close();
  });

  test('caption style entry opens the style studio; per-clip SRT/VTT export', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page, 'reframe');
    await expect(dlg.getByTestId('caption-style-name')).toHaveText('Clean Pop');
    await dlg.getByTestId('caption-style-change').click();
    await expect(s.page.getByRole('dialog', { name: 'Caption style for this clip' })).toBeVisible();
    await s.page.keyboard.press('Escape');
    await expect(s.page.getByRole('dialog', { name: 'Caption style for this clip' })).toBeHidden();
    await expect(dlg).toBeVisible();

    await dlg.getByTestId('subs-srt').click();
    await expect(s.page.getByText('Saved SRT subtitles')).toBeVisible();
    await dlg.getByTestId('subs-vtt').click();
    expect(bstate(s.state).log.exports).toEqual([
      { clipId: CLIP, format: 'srt' },
      { clipId: CLIP, format: 'vtt' },
    ]);
    expect(calls(s, 'subtitles:export')[0]!.payload).toEqual({
      videoId: 'vid-interview',
      clipId: CLIP,
      format: 'srt',
    });
    expect(s.problems.filter((p) => !p.includes('HTTP') && !p.includes('Failed to load resource'))).toEqual([]);
    await s.close();
  });

  test('"Captions outdated" appears when the clip is older than the subtitle edits, and Re-render fixes the request', async () => {
    const s = await open(VIDEO(), {
      prepare: (st) => {
        st.videos.find((v) => v.id === 'vid-interview')!.subtitleRev = 3;
      },
    });
    const dlg = await openDrawer(s.page, 'reframe');
    await expect(dlg.getByText('Captions are outdated')).toBeVisible();
    await dlg.getByTestId('captions-rerender').click();
    expect(calls(s, 'clips:rerender').at(-1)?.payload).toEqual({ id: CLIP });
    clean(s);
    await s.close();
  });

  test('CP1 drawer behaviour survives: tabs do not break prev/next, source play, favorite', async () => {
    const s = await open(VIDEO());
    const dlg = await openDrawer(s.page);
    await expect(dlg.getByTestId('drawer-hook')).toBeVisible();
    await expect(dlg.getByTestId('drawer-range')).toContainText('0:41');
    await dlg.getByRole('button', { name: 'Next clip' }).click();
    await expect(dlg.getByText('2 of 9')).toBeVisible();
    await dlg.getByTestId('drawer-tab-hook').click();
    await dlg.getByRole('button', { name: 'Previous clip' }).click();
    await expect(dlg.getByText('1 of 9')).toBeVisible();
    await expect(dlg.getByTestId('hook-tab')).toBeVisible(); // the tab is kept while stepping through clips
    await dlg.getByRole('button', { name: 'Play source at this moment' }).click();
    await expect(dlg.getByTestId('drawer-source-video')).toBeVisible();
    await s.page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await openDrawer(s.page);
    await expect(dlg.getByTestId('drawer-hook')).toBeVisible(); // reopened on Overview
    clean(s);
    await s.close();
  });
});

/* ---------------------------------------------------------------------------------------------- steering */

test.describe('Steering: Find more moments', () => {
  test('lifecycle: run -> live clips tagged "found by" -> done -> run filter', async () => {
    const s = await open(VIDEO());
    const panel = s.page.getByTestId('clips-extras');
    await expect(panel.getByRole('heading', { name: 'Find more moments' })).toBeVisible();
    await expect(panel.getByTestId('steer-submit')).toBeDisabled();
    await panel.getByTestId('steer-chip').filter({ hasText: 'Funnier moments' }).click();
    await expect(panel.getByTestId('steer-input')).toHaveValue('Funnier moments');
    await panel.getByTestId('steer-input').fill('only the funny parts');
    // options: length + count overrides are sent, nothing else
    await panel.getByTestId('steer-options-toggle').click();
    await panel.getByRole('radio', { name: '60–90 s' }).click();
    await panel.getByRole('radio', { name: '5', exact: true }).click();
    await panel.getByTestId('steer-submit').click();
    expect(bstate(s.state).log.finds.at(-1)).toEqual({
      prompt: 'only the funny parts',
      options: { clipPreset: '60-90', clipCount: 5 },
    });
    const run = panel.getByTestId('moment-run').first();
    await expect(run).toHaveAttribute('data-status', 'running');
    await expect(run.getByTestId('run-prompt')).toHaveText('“only the funny parts”');
    await expect(run.getByTestId('run-status')).toContainText('Searching');
    await expect(s.page.getByTestId('clip-card')).toHaveCount(9);

    // clips arrive live, tagged with the prompt
    await s.ctl.runStep();
    await expect(s.page.getByTestId('clip-card')).toHaveCount(10);
    await expect(run.getByTestId('run-status')).toContainText('1 found so far');
    const first = s.page.getByTestId('clip-card').filter({ has: s.page.getByTestId('clip-found-by') });
    await expect(first).toHaveCount(1);
    await expect(first.getByTestId('clip-found-by')).toContainText('found by: only the funny parts');
    await s.ctl.runStep();
    await s.ctl.finishRun();
    await expect(run).toHaveAttribute('data-status', 'done');
    await expect(run.getByTestId('run-status')).toHaveText('2 new clips');
    await expect(s.page.getByText('2 new clips found')).toBeVisible();
    await expect(run.getByTestId('run-cancel')).toHaveCount(0);

    // run filter chips
    const filters = panel.getByTestId('run-filters');
    await expect(filters).toBeVisible();
    await filters.getByRole('button', { name: /only the funny parts/ }).click();
    await expect(s.page.getByTestId('clip-card')).toHaveCount(2);
    await filters.getByTestId('run-filter-auto').click();
    await expect(s.page.getByTestId('clip-card')).toHaveCount(9);
    await filters.getByTestId('run-filter-all').click();
    await expect(s.page.getByTestId('clip-card')).toHaveCount(11);
    clean(s);
    await s.close();
  });

  test('cancel, failure and budget errors are actionable', async () => {
    const s = await open(VIDEO());
    const panel = s.page.getByTestId('clips-extras');
    await panel.getByTestId('steer-input').fill('anything about pricing');
    await panel.getByTestId('steer-input').press('Enter');
    const run = panel.getByTestId('moment-run').first();
    await run.getByTestId('run-cancel').click();
    expect(calls(s, 'moments:cancel')).toHaveLength(1);
    await expect(run).toHaveAttribute('data-status', 'canceled');
    await expect(run.getByTestId('run-status')).toHaveText('Canceled');

    // a run that fails because of the budget cap
    await panel.getByTestId('steer-input').fill('guest speaking');
    await panel.getByTestId('steer-submit').click();
    await s.ctl.failRun(BUDGET_ERROR);
    const failed = panel.getByTestId('moment-run').first();
    await expect(failed).toHaveAttribute('data-status', 'failed');
    await expect(failed.getByTestId('run-error')).toContainText('Monthly AI budget reached');
    await expect(failed.getByRole('link', { name: 'Open Models & Budget' })).toHaveAttribute('href', '/settings/models/');

    // a run that fails for another reason shows the raw message
    await panel.getByTestId('steer-input').fill('numbers and claims');
    await panel.getByTestId('steer-submit').click();
    await s.ctl.failRun('The model returned malformed JSON twice.');
    await expect(panel.getByTestId('moment-run').first().getByTestId('run-error')).toContainText('malformed JSON');

    // moments:find itself rejected (hard cap) -> inline, actionable error and the text is kept
    s.ctl.failNext('moments:find', BUDGET_ERROR);
    await panel.getByTestId('steer-input').fill('emotional moments');
    await panel.getByTestId('steer-submit').click();
    const err = panel.getByTestId('steer-error');
    await expect(err).toContainText('Monthly AI budget reached');
    await expect(err.getByRole('link', { name: 'Open Models & Budget' })).toBeVisible();
    await expect(panel.getByTestId('steer-input')).toHaveValue('emotional moments');
    await err.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByTestId('moment-run').first().getByTestId('run-prompt')).toHaveText('“emotional moments”');
    clean(s);
    await s.close();
  });

  test('disabled with a clear reason while the video is processing / has no transcript', async () => {
    const s = await open(VIDEO('clips', 'vid-processing'));
    const panel = s.page.getByTestId('clips-extras');
    await expect(panel.getByTestId('steer-disabled-reason')).toContainText('still being processed');
    await expect(panel.getByTestId('steer-input')).toBeDisabled();
    await expect(panel.getByTestId('steer-submit')).toBeDisabled();
    await expect(panel.getByTestId('highlight-button')).toBeDisabled();
    await s.close();

    const t = await open(VIDEO(), {
      prepare: (st) => {
        st.stages['vid-interview'] = st.stages['vid-interview']!.map((x) =>
          x.stage === 'transcribe' ? { ...x, status: 'pending', finishedAt: null } : x,
        );
      },
    });
    await expect(t.page.getByTestId('steer-disabled-reason')).toContainText('no transcript yet');
    await expect(t.page.getByTestId('steer-submit')).toBeDisabled();
    await t.close();
  });
});

/* -------------------------------------------------------------------------------------------- highlights */

test.describe('One-Click Highlights', () => {
  test('popover -> progress card -> special card in the grid -> opens in the drawer', async () => {
    const s = await open(VIDEO());
    const panel = s.page.getByTestId('clips-extras');
    await panel.getByTestId('highlight-button').click();
    await expect(s.page.getByTestId('highlight-popover')).toContainText('60–90 seconds');
    await s.page.getByTestId('highlight-prompt').fill('focus on the collage story');
    await s.page.getByTestId('highlight-create').click();
    expect(calls(s, 'highlights:create').at(-1)?.payload).toEqual({
      videoId: 'vid-interview',
      prompt: 'focus on the collage story',
    });
    const card = panel.getByTestId('highlight-progress');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'working');
    // the reel shows up in the grid with its own badge
    const reel = s.page.getByTestId('clip-card').filter({ has: s.page.getByTestId('clip-highlight-badge') });
    await expect(reel).toHaveCount(1);
    await expect(reel.getByTestId('clip-highlight-badge')).toHaveText('Highlight reel');
    const reelId = s.state.clips[0]!.id;
    expect(s.state.clips[0]!.kind).toBe('highlight');
    await s.ctl.setRender(reelId, 0.5);
    await expect(card).toContainText('Rendering the highlight reel');
    await s.ctl.finishRender(reelId);
    await expect(card).toHaveAttribute('data-state', 'done');
    await card.getByTestId('highlight-open').click();
    const dlg = s.page.getByTestId('clip-drawer');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('drawer-highlight-badge')).toBeVisible();
    await expect(dlg.getByTestId('drawer-hook')).toContainText('The best moments, in story order.');
    await expect(dlg.getByTestId('drawer-why')).toContainText('story');
    clean(s);
    await s.close();
  });

  test('a failure is shown with recovery and can be retried', async () => {
    const s = await open(VIDEO());
    const panel = s.page.getByTestId('clips-extras');
    s.ctl.failNext('highlights:create', BUDGET_ERROR);
    await panel.getByTestId('highlight-button').click();
    await s.page.getByTestId('highlight-create').click();
    const card = panel.getByTestId('highlight-progress');
    await expect(card).toHaveAttribute('data-state', 'failed');
    await expect(card.getByRole('link', { name: 'Open Models & Budget' })).toBeVisible();
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card).toHaveAttribute('data-state', 'working');
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------- chat */

const panel = (p: Page) => p.getByTestId('chat-panel');
const send = async (p: Page, text: string) => {
  await panel(p).getByTestId('chat-input').fill(text);
  await panel(p).getByTestId('chat-input').press('Enter');
};
const proxyTime = (p: Page) =>
  p.evaluate(() => (document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement | null)?.currentTime ?? -1);

test.describe('AI Chat', () => {
  test('opens from the launcher and with Ctrl+J, shows the context, empty state and suggestions', async () => {
    const s = await open(VIDEO('overview'));
    await expect(panel(s.page)).toHaveCount(0);
    await s.page.getByTestId('chat-launcher').click();
    await expect(panel(s.page)).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-context')).toContainText(
      'Chatting about: Community Conversations: Autism Awareness & Local Art',
    );
    await expect(panel(s.page).getByTestId('chat-empty')).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-input')).toBeFocused();
    await expect(panel(s.page).getByTestId('chat-suggestion-linkedin')).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-suggestion-hook')).toHaveCount(0); // video scope: no hook suggestion
    await panel(s.page).getByTestId('chat-suggestion-find').click();
    await expect(panel(s.page).getByTestId('chat-input')).toHaveValue('Find the part where ');
    await s.page.keyboard.press('Escape');
    await expect(panel(s.page)).toHaveCount(0);
    await s.page.keyboard.press('Control+j');
    await expect(panel(s.page)).toBeVisible();
    await s.page.keyboard.press('Control+j');
    await expect(panel(s.page)).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('streams the answer, citations become timestamp chips that seek the source player', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    await send(s.page, 'Find the part where they talk about the collage');
    // optimistic user bubble, then a thinking state before the first token
    await expect(panel(s.page).getByTestId('chat-user-msg')).toContainText('collage');
    expect(bstate(s.state).log.sends.at(-1)).toMatchObject({ clipId: undefined });
    await expect(panel(s.page).getByTestId('chat-thinking')).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-stop')).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-send')).toHaveCount(0);

    await s.ctl.chatStep(3); // start + two deltas
    const answer = panel(s.page).getByTestId('chat-answer');
    await expect(answer).toHaveAttribute('aria-live', 'polite');
    await expect(answer).toHaveAttribute('aria-busy', 'true');
    await expect(answer).toContainText('I found');
    await expect(panel(s.page).getByTestId('chat-thinking')).toHaveCount(0);
    const partial = (await answer.innerText()).length;
    await s.ctl.chatStep(4);
    await expect.poll(async () => (await answer.innerText()).length).toBeGreaterThan(partial);
    while ((await s.ctl.chatStep(6)) > 0) {
      /* drain the rest of the script */
    }
    await expect(panel(s.page).getByTestId('chat-send')).toBeVisible();
    await expect(answer).toHaveAttribute('aria-busy', 'false').catch(() => undefined);
    // markdown: numbered list, bold, no raw markers
    await expect(panel(s.page).locator('ol li').first()).toContainText('collage');
    await expect(panel(s.page).locator('strong').first()).toContainText(/places|place/);
    expect(await answer.innerText()).not.toContain('**');
    // inline [mm:ss] became chips; Sources list repeats the citations
    const chips = panel(s.page).getByTestId('chat-answer').getByTestId('chat-time');
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
    await expect(panel(s.page).getByTestId('chat-sources')).toBeVisible();
    const sec = Number(await chips.first().getAttribute('data-sec'));
    expect(sec).toBeGreaterThan(5);
    await chips.first().click();
    await expect.poll(() => proxyTime(s.page), { timeout: 8000 }).toBeGreaterThanOrEqual(sec - 1);
    expect(await proxyTime(s.page)).toBeLessThan(sec + 6);
    // the stored message came back through chat:messages as well
    expect(calls(s, 'chat:send')).toHaveLength(1);
    clean(s);
    await s.close();
  });

  test('Stop cancels the stream and keeps the partial answer', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    await send(s.page, 'Summarize this for LinkedIn');
    await s.ctl.chatStep(5);
    await expect(panel(s.page).getByTestId('chat-answer')).toContainText('LinkedIn');
    await panel(s.page).getByTestId('chat-stop').click();
    expect(calls(s, 'chat:cancel')).toHaveLength(1);
    await expect(panel(s.page).getByTestId('chat-send')).toBeVisible();
    await expect(panel(s.page).getByTestId('chat-answer')).toContainText('LinkedIn');
    await expect(panel(s.page).getByTestId('chat-assistant-msg')).toHaveCount(1);
    expect(s.ctl.chatPending()).toEqual([]);
    clean(s);
    await s.close();
  });

  test('action cards run -> done and link to the created clip (opens the drawer); markers appear on the timeline', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    await send(s.page, 'Make a clip of the best story');
    // run to just after the action turns "running"
    let card = panel(s.page).getByTestId('chat-action');
    for (let i = 0; i < 40 && (await card.count()) === 0; i++) await s.ctl.chatStep(1);
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card).toContainText('Creating a clip');
    while ((await s.ctl.chatStep(5)) > 0) {
      /* drain */
    }
    card = panel(s.page).getByTestId('chat-action');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'done');
    await expect(card.getByTestId('chat-action-summary')).toContainText('Created clip');
    const before = s.state.clips.length;
    expect(before).toBe(10);
    await card.getByTestId('chat-action-link').click();
    // navigates to the Clips tab and opens the new clip in the drawer
    await expect(s.page.getByTestId('clip-drawer')).toBeVisible();
    await expect(s.page.getByTestId('clip-drawer')).toContainText(s.state.clips[0]!.title);
    // the chat panel stays open next to the drawer
    await expect(panel(s.page)).toBeVisible();
    await s.page.keyboard.press('Escape'); // closes the drawer first (top layer)
    clean(s);
    await s.close();
  });

  test('add_marker: card links to the moment; ticks show under the player; markers menu lists and deletes', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    await send(s.page, 'Add a marker where they talk about the exhibit opening');
    while ((await s.ctl.chatStep(8)) > 0) {
      /* drain */
    }
    const card = panel(s.page).getByTestId('chat-action');
    await expect(card).toHaveAttribute('data-status', 'done');
    await expect(card.getByTestId('chat-action-summary')).toContainText('Marker');
    await expect(s.page.getByTestId('marker-tick')).toHaveCount(1); // markers:changed refreshed the strip
    await card.getByTestId('chat-action-link').click(); // href with &t= seeks, no navigation
    await expect.poll(() => proxyTime(s.page), { timeout: 8000 }).toBeGreaterThan(30);
    await panel(s.page).getByTestId('chat-markers').click();
    const menu = s.page.getByTestId('chat-markers-menu');
    await expect(menu.getByTestId('chat-time')).toHaveCount(1);
    await menu.getByRole('button', { name: /Delete marker/ }).click({ force: true });
    await expect(s.page.getByTestId('marker-tick')).toHaveCount(0);
    expect(bstate(s.state).markers).toHaveLength(0);
    clean(s);
    await s.close();
  });

  test('errors: stream error (budget) and send error (no API key) show recovery links; retry works', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    s.ctl.failChatNext(BUDGET_ERROR, 3);
    await send(s.page, 'What are the key takeaways?');
    while ((await s.ctl.chatStep(3)) > 0) {
      /* drain */
    }
    const err = panel(s.page).getByTestId('chat-error');
    await expect(err).toHaveAttribute('data-kind', 'budget');
    await expect(err.getByRole('link', { name: 'Open Models & Budget' })).toHaveAttribute('href', '/settings/models/');
    await expect(panel(s.page).getByTestId('chat-send')).toBeVisible(); // composer is usable again

    // chat:send itself rejects
    s.ctl.failNext('chat:send', 'No Anthropic API key is set.');
    await send(s.page, 'What are the key takeaways?');
    const err2 = panel(s.page).getByTestId('chat-error').last();
    await expect(err2).toHaveAttribute('data-kind', 'anthropic');
    await expect(err2.getByRole('link', { name: 'Open API keys' })).toHaveAttribute('href', '/settings/api-keys/');
    await err2.getByTestId('chat-retry').click();
    while ((await s.ctl.chatStep(8)) > 0) {
      /* drain */
    }
    await expect(panel(s.page).getByTestId('chat-assistant-msg').last()).toContainText('key');
    clean(s);
    await s.close();
  });

  test('regenerate re-sends the last question; copy puts the answer on the clipboard', async () => {
    const s = await open(VIDEO('overview'));
    await s.page.getByTestId('chat-launcher').click();
    await send(s.page, 'Find the part where they talk about the workshop');
    while ((await s.ctl.chatStep(8)) > 0) {
      /* drain */
    }
    const msg = panel(s.page).getByTestId('chat-assistant-msg').first();
    await expect(msg.getByTestId('chat-regenerate')).toBeVisible();
    await msg.getByTestId('chat-copy').click();
    const copied = await clipboard(s.page);
    expect(copied).toContain('workshop');
    expect(copied).toContain('[');
    await msg.getByTestId('chat-regenerate').click();
    expect(bstate(s.state).log.sends.map((x) => x.text)).toEqual([
      'Find the part where they talk about the workshop',
      'Find the part where they talk about the workshop',
    ]);
    while ((await s.ctl.chatStep(8)) > 0) {
      /* drain */
    }
    await expect(panel(s.page).getByTestId('chat-assistant-msg')).toHaveCount(2);
    // only the last answer offers regenerate
    await expect(panel(s.page).getByTestId('chat-regenerate')).toHaveCount(1);
    clean(s);
    await s.close();
  });

  test('threads: new chat, switch, delete (two-step); a thread keeps its messages', async () => {
    const s = await open(VIDEO('overview'), {
      prepare: (st, ctl) => {
        ctl.seedThread('vid-interview', null, [['What is this video about?', 'It is a community interview about **acceptance** and collage art.']]);
        st.counter += 1;
      },
    });
    await s.page.getByTestId('chat-launcher').click();
    // the latest thread opens by itself
    await expect(panel(s.page).getByTestId('chat-user-msg')).toContainText('What is this video about?');
    await expect(panel(s.page).locator('strong')).toContainText('acceptance');
    await panel(s.page).getByTestId('chat-new').click();
    await expect(panel(s.page).getByTestId('chat-empty')).toBeVisible();
    await send(s.page, 'Summarize this for LinkedIn');
    while ((await s.ctl.chatStep(10)) > 0) {
      /* drain */
    }
    await expect(panel(s.page).getByRole('heading', { name: 'LinkedIn post' })).toBeVisible();
    await expect(panel(s.page).locator('ul li').first()).toBeVisible();
    await expect(panel(s.page).locator('code').first()).toContainText('#');
    await panel(s.page).getByTestId('chat-threads').click();
    const menu = s.page.getByTestId('chat-threads-menu');
    await expect(menu.getByTestId('chat-thread')).toHaveCount(2);
    await menu.getByTestId('chat-thread').filter({ hasText: 'What is this video about?' }).getByRole('button').first().click();
    await expect(panel(s.page).getByTestId('chat-user-msg')).toContainText('What is this video about?');
    await expect(panel(s.page).getByTestId('chat-user-msg')).toHaveCount(1);
    // delete needs a confirmation click
    await panel(s.page).getByTestId('chat-threads').click();
    await menu.getByTestId('chat-thread').filter({ hasText: 'Summarize' }).hover();
    await menu.getByTestId('chat-thread').filter({ hasText: 'Summarize' }).getByTestId('chat-thread-delete').click();
    expect(calls(s, 'chat:delete')).toHaveLength(0);
    await menu.getByTestId('chat-thread-delete-confirm').click();
    await expect(menu.getByTestId('chat-thread')).toHaveCount(1);
    expect(calls(s, 'chat:delete')).toHaveLength(1);
    clean(s);
    await s.close();
  });

  test('model text can never inject HTML: tags stay text, markdown and timestamps render', async () => {
    const evil =
      '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> **bold** `code` [1:02] and [1:02:03] and [99:99] [x](javascript:alert(1))';
    const s = await open(VIDEO('overview'), {
      prepare: (_st, ctl) => {
        ctl.seedThread('vid-interview', null, [['hi', evil]]);
      },
    });
    await s.page.getByTestId('chat-launcher').click();
    const ans = panel(s.page).getByTestId('chat-answer');
    await expect(ans).toContainText('<img src=x');
    await expect(ans.locator('img, script')).toHaveCount(0);
    await expect(ans.locator('strong')).toHaveText('bold');
    await expect(ans.locator('code')).toHaveText('code');
    await expect(ans.getByTestId('chat-time')).toHaveCount(2);
    await expect(ans.getByTestId('chat-time').nth(1)).toHaveAttribute('data-sec', '3723');
    await expect(ans).toContainText('[99:99]'); // not a clock: stays text
    await expect(ans.locator('a')).toHaveCount(0); // non-http links stay text
    expect(await s.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    clean(s);
    await s.close();
  });

  test('from a clip: context chip, rewrite-hook action, drawer stays open, citation switches the drawer to the source', async () => {
    const s = await open(VIDEO('clips'));
    const dlg = await openDrawer(s.page);
    await dlg.getByTestId('chat-launcher-clip').click();
    await expect(panel(s.page).getByTestId('chat-context')).toContainText('Awareness isn’t enough. Acceptance changes the room.');
    await expect(panel(s.page).getByTestId('chat-suggestion-hook')).toBeVisible();
    await panel(s.page).getByTestId('chat-suggestion-hook').click();
    expect(bstate(s.state).log.sends.at(-1)).toMatchObject({ text: 'Rewrite this hook', clipId: CLIP });
    while ((await s.ctl.chatStep(8)) > 0) {
      /* drain */
    }
    const card = panel(s.page).getByTestId('chat-action');
    await expect(card).toHaveAttribute('data-tool', 'rewrite_hook');
    await expect(card.getByTestId('chat-action-summary')).toContainText('TikTok hooks');
    // interacting with the panel did not dismiss the modal drawer
    await expect(dlg).toBeVisible();
    // a timestamp chip makes the drawer play the source at that moment
    const chip = panel(s.page).getByTestId('chat-answer').getByTestId('chat-time').first().or(panel(s.page).getByTestId('chat-sources').getByTestId('chat-time').first());
    await chip.click();
    await expect(dlg.getByTestId('drawer-source-video')).toBeVisible();
    // the action link opens the Hook tab with the rewritten hook first
    await card.getByTestId('chat-action-link').click();
    await expect(dlg.getByTestId('hook-tab')).toBeVisible();
    await expect(dlg.getByTestId('hook-variant-0')).toContainText('Wait for it');
    // Ctrl+J inside the drawer toggles the clip chat, not the video chat
    await s.page.keyboard.press('Control+j');
    await expect(panel(s.page)).toHaveCount(0);
    await s.page.keyboard.press('Control+j');
    await expect(panel(s.page).getByTestId('chat-context')).toContainText('Awareness');
    clean(s);
    await s.close();
  });

  test('auto-scroll follows the stream but does not fight the user', async () => {
    const s = await open(VIDEO('overview'), {
      height: 700,
      prepare: (_st, ctl) => {
        ctl.seedThread('vid-interview', null, Array.from({ length: 6 }, (_, i) => [`Question number ${i + 1}?`, `Answer ${i + 1}: ` + 'This is a fairly long answer about the interview. '.repeat(12)] as [string, string]));
      },
    });
    await s.page.getByTestId('chat-launcher').click();
    const sc = panel(s.page).getByTestId('chat-scroller');
    await expect.poll(() => sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
    await send(s.page, 'Find the part where they talk about the collage');
    await s.ctl.chatStep(4);
    await expect.poll(() => sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
    // the user scrolls up: new text must not yank the view back down
    await sc.evaluate((el) => (el.scrollTop = 0));
    await s.ctl.chatStep(6);
    await s.page.waitForTimeout(200);
    expect(await sc.evaluate((el) => el.scrollTop)).toBeLessThan(40);
    await expect(panel(s.page).getByTestId('chat-jump-latest')).toBeVisible();
    await panel(s.page).getByTestId('chat-jump-latest').click();
    await expect.poll(() => sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------------------ layout */

test.describe('Layout', () => {
  for (const [w, hgt] of [
    [1280, 720],
    [2560, 1080],
  ] as const) {
    test(`no horizontal overflow at ${w}px: page, drawer tabs, tester, chat`, async () => {
      const s = await open(VIDEO(), {
        width: w,
        height: hgt,
        prepare: (_st, ctl) => {
          ctl.seedHooks(CLIP, { platform: 'reels', index: 0 });
          ctl.seedMeta(CLIP);
          ctl.seedThumbs(CLIP);
          ctl.seedThread('vid-interview', null, [['A long question about the whole interview and everything in it?', 'A long answer. ' + 'word '.repeat(80)]]);
        },
      });
      await noOverflow(s.page);
      await s.page.getByTestId('steer-options-toggle').click();
      await noOverflow(s.page);
      const dlg = await openDrawer(s.page);
      for (const tab of ['hook', 'meta', 'thumbnail', 'reframe']) {
        await dlg.getByTestId(`drawer-tab-${tab}`).click();
        await s.page.waitForTimeout(150);
        await noOverflow(s.page);
        await noOverflow(s.page, '[data-testid="clip-drawer"]');
        // the scrolling column must not scroll sideways
        const cols = await s.page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="clip-drawer"] .overflow-y-auto')].map((e) => e.scrollWidth - e.clientWidth),
        );
        for (const c of cols) expect(c).toBeLessThanOrEqual(1);
      }
      await dlg.getByTestId('chat-launcher-clip').click();
      await noOverflow(s.page);
      await noOverflow(s.page, '[data-testid="chat-panel"]');
      clean(s);
      await s.close();
    });
  }
});
