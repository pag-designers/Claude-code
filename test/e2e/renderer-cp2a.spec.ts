import { expect, test, type Locator, type Page } from '@playwright/test';
import { CP2_CLIP_DEFAULTS } from './support/cp1-data';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { controls, cp2a, deriveCues } from './support/cp2-stub-a';

/**
 * CP2 (UI-A) behaviour tests against the REAL exported renderer: Subtitles tab, Caption Style Studio, Tools hub and
 * standalone tool routes, Home's new options. `window.clipfern` is the contract-validating stub (every request,
 * response and pushed event is checked against shared/ipc.ts); caption previews are REAL libass renders.
 *   CLIPFERN_E2E_OUT=<snapshot of renderer/out> npx playwright test test/e2e/renderer-cp2a.spec.ts
 * Every session also asserts: zero console errors/warnings, zero external requests, zero HTTP >= 400.
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  test.setTimeout(300_000); // first run renders the caption previews and media fixtures
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = (route: string, opts: OpenOptions = {}) => h.open(route, { settle: 400, ...opts });
const VIDEO = '/library/video/?id=vid-interview';
const SUBS = `${VIDEO}&tab=subtitles`;
const rows = (p: Page) => p.getByTestId('cue-row');
/** The row whose caption text is exactly `text`. */
const rowIs = (p: Page, text: string) =>
  rows(p)
    .filter({
      has: p.locator('[data-testid="cue-text"]', {
        hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }),
    })
    .first();
const row = (p: Page, text: string | RegExp) => rows(p).filter({ hasText: text }).first();
const saveState = (p: Page) => p.getByTestId('save-state');
const saves = (s: { state: Parameters<typeof cp2a>[0] }) => cp2a(s.state).log.saves;
const proxyTime = (p: Page) =>
  p.evaluate(
    () =>
      (document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement | null)
        ?.currentTime ?? -1,
  );
const tip = async (p: Page, target: Locator) => {
  await target.hover();
  return p.getByRole('tooltip').first();
};

/** Opens a cue for editing and returns its textarea. */
async function edit(p: Page, r: Locator): Promise<Locator> {
  await r.getByTestId('cue-text').click();
  const ta = p.getByTestId('cue-input');
  await expect(ta).toBeFocused();
  return ta;
}

test.describe('Subtitles tab', () => {
  test('lists the cues with times and a language badge; the tab replaces the disabled placeholder', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    await expect(s.page.getByRole('tab', { name: 'Subtitles' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(s.page.getByRole('tab', { name: 'Subtitles' })).toBeEnabled();
    await expect(s.page.getByTestId('cue-language')).toHaveText('EN');
    const first = rows(s.page).first();
    await expect(first).toContainText('Welcome back to Community Conversations,');
    await expect(first.getByTestId('cue-time')).toHaveText(/^0:0\d\.\d$/);
    // same cues as the (real) chunker returns
    const cues = deriveCues(s.state.transcripts['vid-interview']!, {
      rev: 0,
      words: {},
      breaks: [],
      merges: [],
    });
    await expect(s.page.getByText(`${cues.length} captions`)).toBeVisible();
    expect(s.state.calls.filter((c) => c.channel === 'subtitles:get')).toHaveLength(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('a 4,000-cue podcast stays virtualised and scrolls', async () => {
    const s = await open('/library/video/?id=vid-podcast&tab=subtitles', { scenario: 'library' });
    const total = deriveCues(s.state.transcripts['vid-podcast']!, {
      rev: 0,
      words: {},
      breaks: [],
      merges: [],
    }).length;
    expect(total).toBeGreaterThan(1500);
    await expect(
      s.page.getByText(new RegExp(`^${total.toLocaleString('en-US')} captions`)),
    ).toBeVisible();
    const dom = await rows(s.page).count();
    expect(dom).toBeGreaterThan(5);
    expect(dom).toBeLessThan(60);
    const scroller = s.page.getByTestId('cue-scroller');
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.5));
    await expect.poll(async () => (await rows(s.page).count()) < 60).toBe(true);
    const mid = await rows(s.page).first().getByTestId('cue-time').innerText();
    expect(mid).not.toMatch(/^0:0/);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('inline edit: click, type, Enter commits; Esc cancels; saving shows Saving… then Saved', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    cp2a(s.state).saveDelayMs = 500;
    const target = row(s.page, 'Welcome back');
    // Esc cancels
    let ta = await edit(s.page, target);
    await ta.fill('this will be discarded');
    await ta.press('Escape');
    await expect(s.page.getByTestId('cue-input')).toHaveCount(0);
    await expect(target).toContainText('Welcome back to Community Conversations,');
    await expect(saveState(s.page)).toHaveCount(0);
    expect(saves(s)).toHaveLength(0);

    // Enter commits
    ta = await edit(s.page, target);
    await ta.fill('Welcome back to Community Chats,');
    await ta.press('Enter');
    await expect(s.page.getByTestId('cue-input')).toHaveCount(0);
    await expect(row(s.page, 'Community Chats')).toBeVisible();
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'dirty');
    await expect(saveState(s.page)).toContainText('Unsaved changes');
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saving');
    await expect(saveState(s.page)).toContainText('Saving…');
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    await expect(saveState(s.page)).toContainText('Saved');
    expect(saves(s)).toHaveLength(1);
    // word index 4 ("Conversations,") replaced by "Chats,"; the real contract schema validated the payload
    expect(saves(s)[0]!.edits.words).toEqual({ '4': { text: 'Chats,' } });
    expect(saves(s)[0]!.edits.rev).toBe(0);
    // the video's revision moved, so the next save sends rev 1
    await expect
      .poll(() => s.state.videos.find((v) => v.id === 'vid-interview')!.subtitleRev)
      .toBe(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('removing words hides them; blur commits; edits are debounced into one save', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const r = row(s.page, 'April is Autism Awareness Month');
    const ta = await edit(s.page, r);
    await ta.fill('April is Awareness Month, and today');
    await s.page.getByRole('textbox', { name: 'Search subtitles' }).click(); // blur commits
    await expect(row(s.page, 'April is Awareness Month')).toBeVisible();
    // a second quick edit lands in the same save
    const r2 = row(s.page, 'we’re talking about what awareness');
    const ta2 = await edit(s.page, r2);
    await ta2.fill('we’re talking about what awareness');
    await ta2.press('Enter');
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    expect(saves(s)).toHaveLength(1);
    expect(saves(s)[0]!.edits.words).toEqual({ '12': { hidden: true } }); // "Autism"
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('split at the caret (button and Alt+Enter), merge with next, undo and redo', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const countOf = async () =>
      Number((await s.page.getByText(/^\d+ captions/).innerText()).match(/^(\d+) captions/)![1]);
    const before = await countOf();
    const r = row(s.page, 'Joining me are a pediatric therapist who');
    let ta = await edit(s.page, r);
    // caret after "Joining me" (10 characters)
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 10));
    await r.getByRole('button', { name: 'Split at caret' }).click();
    await expect(rowIs(s.page, 'Joining me')).toBeVisible();
    await expect(row(s.page, 'are a pediatric therapist who')).toBeVisible();
    await expect(s.page.getByTestId('cue-input')).toHaveCount(0);
    await expect.poll(() => saves(s).length).toBe(1);
    expect(saves(s)[0]!.edits.breaks).toHaveLength(1);
    expect(saves(s)[0]!.edits.merges).toEqual([]);
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    // server answered with real cue ids (no temporary negative ids left)
    expect(await countOf()).toBe(before + 1);

    // Alt+Enter splits too: put the caret after "are a"
    ta = await edit(s.page, row(s.page, 'are a pediatric therapist who'));
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
    await ta.press('Alt+Enter');
    await expect(rowIs(s.page, 'are a')).toBeVisible();
    await expect.poll(() => saves(s).length).toBe(2);

    // merge "Joining me" with the next cue
    const joining = rowIs(s.page, 'Joining me');
    await joining.getByRole('button', { name: 'Merge with next' }).click();
    await expect(rowIs(s.page, 'Joining me are a')).toBeVisible();
    await expect.poll(() => saves(s).length).toBe(3);
    expect(saves(s)[2]!.edits.merges.length).toBeGreaterThan(0);

    // undo walks back through merge and both splits
    await s.page.getByRole('button', { name: 'Undo' }).click();
    await expect(rowIs(s.page, 'Joining me')).toBeVisible();
    await s.page.keyboard.press('Control+z');
    await s.page.keyboard.press('Control+z');
    await expect(rows(s.page).filter({ hasText: /Joining me/ })).toHaveCount(1);
    await expect(rowIs(s.page, 'Joining me are a pediatric therapist who')).toBeVisible();
    await expect(s.page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(s.page.getByRole('button', { name: 'Redo' })).toBeEnabled();
    // redo re-applies the first split
    await s.page.keyboard.press('Control+Shift+z');
    await expect(rowIs(s.page, 'Joining me')).toBeVisible();
    // undo/redo are saved too (the three undos and the redo happened inside one debounce window: one save)
    await expect.poll(() => saves(s).length).toBe(4);
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    expect(saves(s)[3]!.edits.breaks).toHaveLength(1); // the state after the redo: only the first split
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Ctrl/⌘ Z inside a text field edits the text, not the cue list', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const r = row(s.page, 'Welcome back');
    const ta = await edit(s.page, r);
    await ta.fill('typed');
    await s.page.keyboard.press('Control+z');
    await expect(ta).toBeFocused();
    await ta.press('Escape');
    await expect(s.page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('nudge ±0.1 s and numeric retime (with validation) change timing and are saved as word shifts', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const r = row(s.page, 'I’m so glad you’re here.');
    const start = await r.getByTestId('cue-time').innerText();
    const t0 = Number(start.split(':')[1]);
    await r.getByRole('button', { name: 'Nudge 0.1 seconds later' }).click();
    await r.getByRole('button', { name: 'Nudge 0.1 seconds later' }).click();
    await expect(r.getByTestId('cue-time')).toHaveText(
      new RegExp(`^0:${(Math.round((t0 + 0.2) * 10) / 10).toFixed(1).padStart(4, '0')}$`),
    );
    await r.getByRole('button', { name: 'Nudge 0.1 seconds earlier' }).click();
    await expect.poll(() => saves(s).length).toBeGreaterThanOrEqual(1);
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    const shifts = Object.values(saves(s).at(-1)!.edits.words).map((w) => w.shift);
    expect(shifts.length).toBeGreaterThan(0);
    expect(new Set(shifts)).toEqual(new Set([0.1]));

    // numeric retime
    await r.getByTestId('cue-time').click();
    const pop = s.page.getByTestId('retime-popover');
    const input = pop.getByLabel('Start time');
    await expect(input).toHaveValue(/^0:0\d\.\d$/);
    await input.fill('abc');
    await expect(pop).toContainText('Use seconds or m:ss.s');
    await expect(pop.getByRole('button', { name: 'Retime' })).toBeDisabled();
    await input.fill('0:30.5');
    await pop.getByRole('button', { name: 'Retime' }).click();
    await expect(row(s.page, 'I’m so glad you’re here.').getByTestId('cue-time')).toHaveText(
      '0:30.5',
    );
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('delete a caption (undoable) removes its words from the captions', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const before = await s.page.getByText(/\d+ captions/).innerText();
    const r = row(s.page, 'I’m so glad you’re here.');
    await r.getByRole('button', { name: 'Delete caption' }).click();
    await expect(row(s.page, 'I’m so glad')).toHaveCount(0);
    await expect.poll(() => saves(s).length).toBe(1);
    expect(Object.values(saves(s)[0]!.edits.words).every((w) => w.hidden === true)).toBe(true);
    expect(await s.page.getByText(/\d+ captions/).innerText()).not.toBe(before);
    await s.page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(s.page, 'I’m so glad')).toBeVisible();
    await expect.poll(() => saves(s).length).toBe(2);
    expect(saves(s)[1]!.edits.words).toEqual({});
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('search highlights matches, steps through them and jumps there', async () => {
    const s = await open('/library/video/?id=vid-podcast&tab=subtitles', { scenario: 'library' });
    const box = s.page.getByRole('textbox', { name: 'Search subtitles' });
    await box.fill('runway');
    const count = s.page.getByTestId('cue-match-count');
    await expect(count).toHaveText(/^1 of \d+$/);
    await expect(s.page.getByTestId('cue-match').first()).toHaveText(/runway/i);
    const first = await rows(s.page).first().getByTestId('cue-time').innerText();
    await box.press('Enter');
    await expect(count).toHaveText(/^2 of \d+$/);
    await s.page.getByRole('button', { name: 'Next match' }).click();
    await expect(count).toHaveText(/^3 of \d+$/);
    await s.page.getByRole('button', { name: 'Previous match' }).click();
    await expect(count).toHaveText(/^2 of \d+$/);
    await expect(s.page.getByTestId('cue-match').first()).toBeVisible();
    expect(first).toMatch(/^\d+:\d\d/);
    await box.fill('zzzzqqqq');
    await expect(count).toHaveText('No matches');
    await s.page.getByRole('button', { name: 'Clear search' }).click();
    await expect(count).toHaveCount(0);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('clicking play on a cue seeks the proxy player; the active cue follows playback', async () => {
    const s = await open(SUBS, { scenario: 'library', settle: 900 });
    const r = row(s.page, 'has worked with local families for twenty');
    const startText = await r.getByTestId('cue-time').innerText();
    const start = Number(startText.split(':')[1]);
    await r.getByRole('button', { name: /^Play from/ }).click();
    await expect.poll(() => proxyTime(s.page), { timeout: 8000 }).toBeGreaterThan(start - 0.3);
    await expect(rows(s.page).and(s.page.locator('[data-active]')).first()).toBeVisible({
      timeout: 8000,
    });
    // the highlight moves on while the video keeps playing (cues are ~2 s long)
    const activeStart = async () => {
      const t = await s.page
        .locator('[data-testid="cue-row"][data-active]')
        .first()
        .getByTestId('cue-time')
        .innerText({ timeout: 1000 })
        .catch(() => null);
      return t === null ? -1 : Number(t.split(':')[1]);
    };
    await expect.poll(activeStart).toBeGreaterThan(0);
    const first = await activeStart();
    await expect.poll(activeStart, { timeout: 9000 }).not.toBe(first);
    const t = await proxyTime(s.page);
    const now = await activeStart();
    expect(now).toBeGreaterThan(first);
    expect(now).toBeLessThanOrEqual(t + 0.5); // the active cue has started
    expect(now).toBeGreaterThan(t - 6);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('a failed save shows the error with Retry (toast and inline); retry saves; nothing is lost', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    controls(s.state).failNext('subtitles:save', 'Storage is unreachable (ECONNRESET).');
    const ta = await edit(s.page, row(s.page, 'Welcome back'));
    await ta.fill('Welcome back everyone,');
    await ta.press('Enter');
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'error');
    await expect(saveState(s.page)).toContainText('Not saved');
    const toast = s.page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Subtitles were not saved' });
    await expect(toast).toContainText('Storage is unreachable (ECONNRESET).');
    await expect(row(s.page, 'Welcome back everyone,')).toBeVisible(); // the edit is still on screen
    await toast.getByRole('button', { name: 'Retry' }).click();
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    // the failed attempt was rejected before it was recorded, the retry carried the same edit
    expect(saves(s)).toHaveLength(1);
    // "to Community Conversations," became "everyone,": the first word takes the text, the rest are hidden
    expect(saves(s)[0]!.edits.words).toEqual({
      '2': { text: 'everyone,' },
      '3': { hidden: true },
      '4': { hidden: true },
    });
    // problems: the failed IPC call is an expected console-free rejection
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('edits made in the tab are flushed when the tab is left and visible again on return', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const ta = await edit(s.page, row(s.page, 'Welcome back'));
    await ta.fill('Welcome back to Community Chats,');
    await ta.press('Enter');
    await s.page.getByRole('tab', { name: 'Overview' }).click(); // leave before the debounce fires
    await expect.poll(() => saves(s).length).toBe(1);
    await s.page.getByRole('tab', { name: 'Subtitles' }).click();
    // (the server re-chunks after a save, so the first cue may now hold a few more words)
    await expect(rows(s.page).first().getByTestId('cue-text')).toContainText(
      'Welcome back to Community Chats,',
    );
    // the cache was updated: reopening did not show the first fetch
    expect(s.state.calls.filter((c) => c.channel === 'subtitles:get')).toHaveLength(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('banner: N rendered clips use older captions; Re-render calls clips:restyle with the stale clips and the video style', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    await expect(s.page.getByText(/rendered clips? uses? older captions/)).toHaveCount(0); // hidden at 0
    const ta = await edit(s.page, row(s.page, 'Welcome back'));
    await ta.fill('Welcome back everyone,');
    await ta.press('Enter');
    const banner = s.page.getByRole('alert').filter({ hasText: 'older captions' });
    await expect(banner).toBeVisible();
    // 8 rendered clips (1 of the 9 failed)
    await expect(banner).toContainText('8 rendered clips use older captions');
    await banner.getByRole('button', { name: /Re-render 8 clips/ }).click();
    await expect.poll(() => cp2a(s.state).log.restyles.length).toBe(1);
    const call = cp2a(s.state).log.restyles[0]!;
    expect(call.styleId).toBe('clean-pop');
    expect(call.ids).toHaveLength(8);
    expect(call.ids.every((id) => id.startsWith('vid-interview-c'))).toBe(true);
    await expect(banner).toHaveCount(0);
    await expect(
      s.page.locator('[data-sonner-toast]').filter({ hasText: 'Re-rendering 8 clips' }),
    ).toBeVisible();
    // once they are re-rendered with the new revision the banner stays gone after another edit-free save
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('export menu saves SRT and VTT for the whole video (after flushing pending edits)', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const ta = await edit(s.page, row(s.page, 'Welcome back'));
    await ta.fill('Welcome back, friends,');
    await ta.press('Enter');
    await s.page.getByTestId('export-menu').click();
    await s.page.getByRole('menuitem', { name: /SubRip/ }).click();
    await expect.poll(() => cp2a(s.state).log.exports.length).toBe(1);
    // the pending edit was saved BEFORE the export ran
    expect(saves(s)).toHaveLength(1);
    expect(cp2a(s.state).log.exports[0]).toMatchObject({ videoId: 'vid-interview', format: 'srt' });
    await expect(
      s.page.locator('[data-sonner-toast]').filter({ hasText: 'Exported SRT' }),
    ).toBeVisible();
    await s.page.getByTestId('export-menu').click();
    await s.page.getByRole('menuitem', { name: /WebVTT/ }).click();
    await expect.poll(() => cp2a(s.state).log.exports.length).toBe(2);
    expect(cp2a(s.state).log.exports[1]!.format).toBe('vtt');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('keyboard: rows are reachable, Enter on the text button edits, Tab moves to the actions', async () => {
    const s = await open(SUBS, { scenario: 'library' });
    const text = row(s.page, 'Welcome back').getByTestId('cue-text');
    await text.focus();
    await s.page.keyboard.press('Enter');
    await expect(s.page.getByTestId('cue-input')).toBeFocused();
    await s.page.keyboard.press('Escape');
    await expect(text).toBeVisible();
    const t = await tip(
      s.page,
      row(s.page, 'Welcome back').getByRole('button', { name: 'Merge with next' }),
    );
    await expect(t).toContainText('Merge with the next caption');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('states: no transcript yet, load error with retry', async () => {
    let s = await open('/library/video/?id=vid-failed&tab=subtitles', { scenario: 'library' });
    await expect(s.page.getByText('No transcript for this video')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();

    s = await open('/library/video/?id=vid-interview', {
      scenario: 'library',
      prepare: (st) => controls(st).failNext('subtitles:get', 'The subtitle store is locked.', 2),
    });
    await s.page.getByRole('tab', { name: 'Subtitles' }).click();
    await expect(s.page.getByText('Could not load the subtitles')).toBeVisible();
    await expect(s.page.getByText('The subtitle store is locked.')).toBeVisible();
    await s.page.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(s.page).first()).toBeVisible();
    // first failure was retried by TanStack (retry: 1), the manual retry succeeded
    expect(
      s.problems.filter((p) => !/subtitle store is locked|Failed to load resource|500/.test(p)),
    ).toEqual([]);
    await s.close();
  });
});

/* ================================================================================================================== */

const studio = (p: Page) => p.getByTestId('style-studio');
const tile = (p: Page, id: string) =>
  studio(p).locator(`[data-testid="style-tile"][data-style-id="${id}"]`);
const previews = (s: { state: Parameters<typeof cp2a>[0] }) => cp2a(s.state).log.previews;
const sizeBox = (p: Page) => studio(p).getByLabel('Size', { exact: true }).first();
const nameBox = (p: Page) => studio(p).getByRole('textbox', { name: 'Style name' });
const settled = (p: Page, ms = 450) => p.waitForTimeout(ms); // > the 250 ms preview debounce
/** The newest request for the style being edited (tile requests of other presets arrive lazily and are ignored). */
const lastPreview = (s: { state: Parameters<typeof cp2a>[0] }, id = 'clean-pop') =>
  previews(s)
    .filter((r) => r.style.id === id)
    .at(-1)!;

async function openStudio(s: Awaited<ReturnType<typeof open>>) {
  await s.page.getByTestId('caption-style-button').first().click();
  await expect(studio(s.page)).toBeVisible();
  await expect(tile(s.page, 'clean-pop')).toBeVisible();
}

test.describe('Caption Style Studio', () => {
  test('gallery shows the 14 built-ins; thumbnails are real libass renders, fetched lazily, two at a time', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    const release = controls(s.state).holdPreviews();
    await openStudio(s);
    await expect(studio(s.page).getByTestId('style-tile')).toHaveCount(14);
    await expect(studio(s.page).getByText('Built-in · 14')).toBeVisible();
    await expect(studio(s.page).getByText('My styles · 0')).toBeVisible();
    // skeletons while the renders are held
    await expect(tile(s.page, 'clean-pop').getByTestId('style-thumb')).toHaveAttribute(
      'data-state',
      'loading',
    );
    // only what is on screen was requested (not all 14 + the editor preview)
    const requestedBefore = new Set(previews(s).map((r) => r.style.id));
    expect(requestedBefore.size).toBeLessThan(14);
    expect(cp2a(s.state).maxPreviewsInFlight).toBeLessThanOrEqual(3); // 2 tiles + the live preview
    release();
    await expect(tile(s.page, 'clean-pop').getByTestId('style-thumb')).toHaveAttribute(
      'data-state',
      'ready',
    );
    const src = await tile(s.page, 'clean-pop').locator('img').getAttribute('src');
    expect(src).toMatch(/^data:image\/png;base64,/);
    // scrolling reveals and fetches the rest
    await s.page.getByTestId('studio-gallery').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(tile(s.page, 'subtle-serif').getByTestId('style-thumb')).toHaveAttribute(
      'data-state',
      'ready',
    );
    const all = new Set(previews(s).map((r) => r.style.id));
    expect(all.size).toBe(14);
    expect(cp2a(s.state).maxPreviewsInFlight).toBeLessThanOrEqual(3);
    // the clip frame is the background when the studio opens from a video that has clips
    expect(previews(s)[0]!.clipId).toBe('vid-interview-c1');
    // the current style is marked
    await expect(tile(s.page, 'clean-pop').getByText('Currently used')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('selecting a preset loads it into the editor and requests a preview of exactly that style', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await tile(s.page, 'hormozi-bold').click();
    await expect(tile(s.page, 'hormozi-bold')).toHaveAttribute('aria-pressed', 'true');
    await expect(nameBox(s.page)).toHaveValue('Hormozi Bold');
    await expect(studio(s.page).getByTestId('font-family')).toHaveText('Anton');
    await expect(studio(s.page).getByTestId('studio-selected')).toContainText('Built-in');
    await expect.poll(() => previews(s).some((r) => r.style.id === 'hormozi-bold')).toBe(true);
    expect(lastPreview(s, 'hormozi-bold').style.font.family).toBe('Anton');
    await expect(studio(s.page).getByTestId('style-preview-img')).toBeVisible();
    // the editor shows every field group
    for (const g of [
      'Typography',
      'Colours',
      'Active word',
      'Shadow',
      'Background box',
      'Position',
      'Line breaking',
    ])
      await expect(studio(s.page).getByRole('region', { name: g })).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('editing fields updates the live preview request (debounced) with the edited style', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await settled(s.page, 900);
    const before = previews(s).length;
    // three quick edits inside one debounce window -> ONE new request
    await sizeBox(s.page).fill('9');
    await sizeBox(s.page).fill('9.5');
    await sizeBox(s.page).fill('10');
    await settled(s.page);
    await expect.poll(() => previews(s).length).toBe(before + 1);
    expect(lastPreview(s).style.font.sizePct).toBe(10);
    await expect(studio(s.page).getByTestId('studio-selected')).toContainText('Unsaved changes');

    // colour: hex field, swatch, native picker value
    const fill = studio(s.page).getByLabel('Text fill', { exact: true });
    await fill.fill('#ff0000');
    await settled(s.page);
    expect(lastPreview(s).style.fill).toBe('#FF0000');
    await studio(s.page).getByRole('button', { name: 'Text fill: green' }).click();
    await settled(s.page);
    expect(lastPreview(s).style.fill).toBe('#4ADE80');
    await expect(studio(s.page).getByRole('button', { name: 'Text fill: green' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // case, animation, highlight mode, box toggle (reveals its colour/opacity/padding fields)
    await studio(s.page).getByRole('radio', { name: 'lower' }).click();
    await settled(s.page);
    expect(lastPreview(s).style.textCase).toBe('lower');
    await studio(s.page).getByLabel('Animation').click();
    await s.page.getByRole('option', { name: 'Bounce' }).click();
    await settled(s.page);
    expect(lastPreview(s).style.animation).toBe('bounce');
    await studio(s.page).getByLabel('Emphasis').click();
    await s.page.getByRole('option', { name: 'Box behind word' }).click();
    await expect(studio(s.page).getByText('Highlight box')).toBeVisible();
    await expect(studio(s.page).getByText('Highlight colour')).toHaveCount(0);
    await expect(studio(s.page).getByLabel('Box colour', { exact: true })).toHaveCount(0);
    await studio(s.page).getByRole('switch', { name: 'Box behind the text' }).click();
    await expect(studio(s.page).getByLabel('Box colour', { exact: true })).toBeVisible();
    await settled(s.page);
    expect(lastPreview(s).style.box.enabled).toBe(true);
    expect(lastPreview(s).style.highlight.mode).toBe('box');

    // position slider (native range: keyboard), chunking
    const y = studio(s.page).getByRole('slider', { name: 'Vertical position slider' });
    await y.focus();
    await y.press('ArrowRight');
    await y.press('ArrowRight');
    await settled(s.page);
    expect(lastPreview(s).style.layout.yPct).toBe(71);
    await studio(s.page).getByLabel('Words per caption', { exact: true }).fill('2');
    await settled(s.page);
    expect(lastPreview(s).style.chunking.maxWords).toBe(2);

    // font family + weight come from captions:fonts
    await studio(s.page).getByTestId('font-family').click();
    await s.page.getByRole('option', { name: 'Poppins' }).click();
    await studio(s.page).getByLabel('Weight', { exact: true }).click();
    await s.page.getByRole('option', { name: /Bold · 700/ }).click();
    await settled(s.page);
    expect(lastPreview(s).style.font).toMatchObject({ family: 'Poppins', weight: 700 });
    expect(s.state.calls.filter((c) => c.channel === 'captions:fonts')).toHaveLength(1);

    // every request carried a complete, valid style (the stub parsed it with the real schema)
    expect(
      previews(s)
        .filter((r) => r.style.id === 'clean-pop')
        .every((r) => r.style.name === 'Clean Pop'),
    ).toBe(true);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('preview: previous image stays (dimmed, "Updating") while the next renders; errors offer Retry; sample controls', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    const pv = studio(s.page).getByTestId('style-preview');
    await expect(pv.locator('[data-state="ready"]')).toBeVisible();
    const img = studio(s.page).getByTestId('style-preview-img');
    const first = await img.getAttribute('src');

    const release = controls(s.state).holdPreviews();
    await sizeBox(s.page).fill('11');
    await expect(pv.locator('[data-state="loading"]')).toBeVisible();
    await expect(pv.getByText('Updating')).toBeVisible();
    await expect(img).toBeVisible(); // the previous image is still there
    expect(await img.getAttribute('src')).toBe(first);
    await expect(img).toHaveClass(/opacity-55/);
    release();
    await expect(pv.locator('[data-state="ready"]')).toBeVisible();
    expect(await img.getAttribute('src')).not.toBe(first);
    await expect(img).not.toHaveClass(/opacity-55/);

    // error state with retry
    controls(s.state).failNext(
      'captions:preview',
      'ffmpeg exited with code 1 (libass: font not found).',
    );
    await sizeBox(s.page).fill('8');
    await expect(pv.getByRole('alert')).toContainText('Could not render the preview');
    await expect(pv.getByRole('alert')).toContainText('libass: font not found');
    const n = previews(s).length;
    await pv.getByRole('button', { name: 'Retry' }).click();
    await expect(pv.locator('[data-state="ready"]')).toBeVisible();
    expect(previews(s).length).toBe(n + 1);
    expect(lastPreview(s).style.font.sizePct).toBe(8);

    // active word index + sample text + safe-area guide
    await pv.getByRole('radio', { name: '3', exact: true }).click();
    await settled(s.page);
    expect(lastPreview(s).activeWord).toBe(2);
    await pv.getByRole('radio', { name: 'Long' }).click();
    await settled(s.page);
    expect(lastPreview(s).text).toMatch(/^Nobody told me/);
    await expect(pv.getByTestId('safe-guide')).toHaveCount(0);
    await pv.getByRole('switch', { name: 'Safe area guide' }).click();
    await expect(pv.getByTestId('safe-guide')).toBeVisible();
    expect(s.problems.filter((p) => !/captions:preview|libass|ffmpeg/.test(p))).toEqual([]);
    await s.close();
  });

  test('validation: out-of-range numbers and bad hex show inline errors, stop the preview and block saving', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await settled(s.page, 900);
    const n = previews(s).length;
    await sizeBox(s.page).fill('99');
    const err = studio(s.page).getByRole('alert').filter({ hasText: 'Must be between 2 and 14.' });
    await expect(err).toBeVisible();
    await expect(sizeBox(s.page)).toHaveAttribute('aria-invalid', 'true');
    await expect(
      studio(s.page).getByText('Fix the highlighted fields to refresh the preview.'),
    ).toBeVisible();
    await expect(studio(s.page).getByTestId('studio-apply')).toBeDisabled();
    await expect(
      studio(s.page).getByRole('button', { name: 'Save as custom copy' }),
    ).toBeDisabled();
    await settled(s.page);
    expect(previews(s).length).toBe(n); // nothing was requested for the invalid draft
    await sizeBox(s.page).fill('');
    await expect(
      studio(s.page).getByRole('alert').filter({ hasText: 'Enter a number.' }),
    ).toBeVisible();

    await sizeBox(s.page).fill('7.8');
    await expect(err).toHaveCount(0);
    await studio(s.page).getByLabel('Text fill', { exact: true }).fill('#12');
    await expect(
      studio(s.page).getByText('Use a 6-digit hex colour such as #FFD60A.'),
    ).toBeVisible();
    await expect(studio(s.page).getByTestId('studio-apply')).toBeDisabled();
    await studio(s.page).getByLabel('Text fill', { exact: true }).fill('#FFFFFF');
    await expect(studio(s.page).getByTestId('studio-apply')).toBeEnabled();

    await nameBox(s.page).fill('');
    await expect(studio(s.page).getByText('Name the style (1–40 characters).')).toBeVisible();
    await expect(studio(s.page).getByTestId('studio-apply')).toBeDisabled();
    await studio(s.page).getByRole('button', { name: 'Reset' }).click();
    await expect(nameBox(s.page)).toHaveValue('Clean Pop');
    await expect(studio(s.page).getByTestId('studio-apply')).toBeEnabled();
    // non-integer where only whole numbers are valid
    await studio(s.page).getByLabel('Words per caption', { exact: true }).fill('2.5');
    await expect(studio(s.page).getByText('Whole numbers only.')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('built-ins are read-only: save as custom copy, edit + Save, duplicate, delete with confirmation', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await expect(studio(s.page).getByRole('button', { name: 'Delete' })).toHaveCount(0); // built-ins cannot be deleted
    await expect(studio(s.page).getByRole('button', { name: 'Duplicate' })).toBeVisible();
    await sizeBox(s.page).fill('9');
    await expect(studio(s.page).getByRole('button', { name: 'Save as custom copy' })).toBeVisible();
    await expect(studio(s.page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0); // no overwrite of a built-in
    await studio(s.page).getByRole('button', { name: 'Save as custom copy' }).click();
    const custom = tile(s.page, 'custom-1');
    await expect(custom).toBeVisible();
    await expect(studio(s.page).getByText('My styles · 1')).toBeVisible();
    await expect(custom).toHaveAttribute('aria-pressed', 'true');
    await expect(nameBox(s.page)).toHaveValue('Clean Pop copy');
    await expect(studio(s.page).getByTestId('studio-selected')).toContainText('Custom');
    expect(cp2a(s.state).log.savedStyles).toHaveLength(1);
    expect(cp2a(s.state).log.savedStyles[0]).toMatchObject({
      builtin: false,
      font: { sizePct: 9 },
    });
    // clean-pop itself is untouched
    expect(cp2a(s.state).styles.find((x) => x.id === 'clean-pop')!.font.sizePct).toBe(7.8);

    // edit the custom style: Save updates it in place (same id), no new tile
    await nameBox(s.page).fill('My punchy style');
    await sizeBox(s.page).fill('12');
    await studio(s.page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(studio(s.page).getByText('My styles · 1')).toBeVisible();
    await expect(tile(s.page, 'custom-1')).toContainText('My punchy style');
    expect(cp2a(s.state).log.savedStyles.at(-1)).toMatchObject({
      id: 'custom-1',
      name: 'My punchy style',
    });
    expect(cp2a(s.state).styles.find((x) => x.id === 'custom-1')!.font.sizePct).toBe(12);
    await expect(studio(s.page).getByTestId('studio-selected')).not.toContainText('Unsaved');

    // Duplicate
    await studio(s.page).getByRole('button', { name: 'Duplicate' }).click();
    await expect(studio(s.page).getByText('My styles · 2')).toBeVisible();
    await expect(nameBox(s.page)).toHaveValue('My punchy style copy');

    // Delete asks first; Cancel keeps it
    await studio(s.page).getByRole('button', { name: 'Delete' }).click();
    const dlg = s.page.getByRole('dialog').filter({ hasText: 'Delete “My punchy style copy”?' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(studio(s.page).getByText('My styles · 2')).toBeVisible();
    await studio(s.page).getByRole('button', { name: 'Delete' }).click();
    await s.page
      .getByRole('dialog')
      .filter({ hasText: 'Delete “My punchy style copy”?' })
      .getByRole('button', { name: 'Delete style' })
      .click();
    await expect(studio(s.page).getByText('My styles · 1')).toBeVisible();
    expect(cp2a(s.state).log.deletedStyles).toEqual(['custom-2']);
    await expect(tile(s.page, 'clean-pop')).toHaveAttribute('aria-pressed', 'true'); // selection fell back
    await expect(
      s.page.locator('[data-sonner-toast]').filter({ hasText: 'Deleted “My punchy style copy”' }),
    ).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('switching styles with unsaved edits asks first (Discard / keep editing)', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await sizeBox(s.page).fill('10');
    await tile(s.page, 'neon-glow').click();
    const dlg = s.page.getByRole('dialog').filter({ hasText: 'Discard unsaved changes?' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(tile(s.page, 'clean-pop')).toHaveAttribute('aria-pressed', 'true');
    await expect(sizeBox(s.page)).toHaveValue('10');
    await tile(s.page, 'neon-glow').click();
    await s.page
      .getByRole('dialog')
      .filter({ hasText: 'Discard unsaved changes?' })
      .getByRole('button', { name: 'Discard changes' })
      .click();
    await expect(tile(s.page, 'neon-glow')).toHaveAttribute('aria-pressed', 'true');
    await expect(nameBox(s.page)).toHaveValue('Neon Glow');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('apply from a video: stores the style, then confirms re-rendering every clip (clips:restyle)', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await expect(s.page.getByTestId('caption-style-button').first()).toContainText('Clean Pop');
    await openStudio(s);
    await tile(s.page, 'neon-glow').click();
    await studio(s.page).getByTestId('studio-apply').click();
    await expect
      .poll(() => cp2a(s.state).log.styleSelections)
      .toEqual([{ id: 'vid-interview', styleId: 'neon-glow' }]);
    const dlg = s.page.getByTestId('apply-all-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Apply “Neon Glow” to existing clips?');
    await expect(dlg).toContainText('Re-rendering 9 clips');
    // the header button already shows the new style
    await expect(s.page.getByTestId('caption-style-button').first()).toContainText('Neon Glow');
    expect(cp2a(s.state).log.restyles).toHaveLength(0); // nothing re-rendered before the confirmation
    await dlg.getByRole('button', { name: 'Re-render 9 clips' }).click();
    await expect.poll(() => cp2a(s.state).log.restyles.length).toBe(1);
    const call = cp2a(s.state).log.restyles[0]!;
    expect(call.styleId).toBe('neon-glow');
    expect([...call.ids].sort()).toEqual(
      s.state.clips
        .filter((c) => c.videoId === 'vid-interview')
        .map((c) => c.id)
        .sort(),
    );
    await expect(dlg).toHaveCount(0);
    // the clips show as queued immediately
    await s.page.getByRole('tab', { name: /^Clips/ }).click();
    await expect(s.page.getByText('Re-rendering 9 clips').first()).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('apply "only new clips" keeps existing renders; applying an edited draft saves a copy first', async () => {
    const s = await open(VIDEO, { scenario: 'library' });
    await openStudio(s);
    await tile(s.page, 'boxed-highlight').click();
    await sizeBox(s.page).fill('9');
    await expect(studio(s.page).getByTestId('studio-apply')).toHaveText('Save copy & apply');
    await studio(s.page).getByTestId('studio-apply').click();
    await expect.poll(() => cp2a(s.state).log.savedStyles.length).toBe(1);
    await expect
      .poll(() => cp2a(s.state).log.styleSelections)
      .toEqual([{ id: 'vid-interview', styleId: 'custom-1' }]);
    const dlg = s.page.getByTestId('apply-all-dialog');
    await expect(dlg).toContainText('Apply “Boxed Highlight copy” to existing clips?');
    await dlg.getByRole('button', { name: 'Only new clips' }).click();
    await expect(dlg).toHaveCount(0);
    expect(cp2a(s.state).log.restyles).toHaveLength(0);
    await expect(s.page.getByTestId('caption-style-button').first()).toContainText(
      'Boxed Highlight copy',
    );
    // a video without rendered clips just stores the choice
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('a video with no clips only stores the style (no re-render question)', async () => {
    const s = await open('/library/video/?id=vid-failed', { scenario: 'library' });
    await openStudio(s);
    expect(previews(s)[0]!.clipId).toBeUndefined(); // no clip to take a background frame from
    await tile(s.page, 'typewriter').click();
    await studio(s.page).getByTestId('studio-apply').click();
    await expect.poll(() => cp2a(s.state).log.styleSelections.length).toBe(1);
    await expect(s.page.getByTestId('apply-all-dialog')).toHaveCount(0);
    await expect(
      s.page.locator('[data-sonner-toast]').filter({ hasText: 'Caption style updated' }),
    ).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('gallery errors are recoverable; studio is keyboard-operable and closes with Escape', async () => {
    const s = await open(VIDEO, {
      scenario: 'library',
      prepare: (st) =>
        controls(st).failNext('captions:styles', 'The style store could not be read.', 50),
    });
    await s.page.getByTestId('caption-style-button').first().click();
    await expect(studio(s.page).getByText('Could not load caption styles')).toBeVisible();
    await expect(studio(s.page).getByText('The style store could not be read.')).toBeVisible();
    cp2a(s.state).failures.delete('captions:styles'); // the store recovers
    await studio(s.page).getByRole('button', { name: 'Try again' }).click();
    await expect(tile(s.page, 'clean-pop')).toBeVisible();
    // keyboard: tiles are buttons
    await tile(s.page, 'karaoke-highlight').focus();
    await s.page.keyboard.press('Enter');
    await expect(tile(s.page, 'karaoke-highlight')).toHaveAttribute('aria-pressed', 'true');
    await s.page.keyboard.press('Escape');
    await expect(studio(s.page)).toHaveCount(0);
    expect(
      s.problems.filter((p) => !/style store could not be read|Failed to load resource/.test(p)),
    ).toEqual([]);
    await s.close();
  });
});

/* ================================================================================================================== */

test.describe('Home: caption style + reframe options', () => {
  const urlBox = (p: Page) => p.getByRole('textbox', { name: 'YouTube URL' });
  const start = (p: Page) => p.getByRole('button', { name: /Start clipping/ });

  test('defaults (Clean Pop, Auto), the studio picks a style, both are sent in pipeline:start options', async () => {
    const s = await open('/', { scenario: 'configured' });
    const styleBtn = s.page.getByTestId('home-caption-style');
    await expect(styleBtn).toContainText('Clean Pop');
    await expect(s.page.getByTestId('home-reframe')).toContainText('Auto');
    // mini thumbnail is a real render
    await expect(styleBtn.getByTestId('style-thumb')).toHaveAttribute('data-state', 'ready');
    await styleBtn.click();
    await expect(studio(s.page).getByText('Caption style for new clips')).toBeVisible();
    expect(previews(s)[0]!.clipId).toBeUndefined();
    await tile(s.page, 'hormozi-bold').click();
    await studio(s.page).getByTestId('studio-apply').click();
    await expect(studio(s.page)).toHaveCount(0);
    await expect(styleBtn).toContainText('Hormozi Bold');
    // nothing is saved to any video yet
    expect(cp2a(s.state).log.styleSelections).toHaveLength(0);

    await s.page.getByTestId('home-reframe').click();
    const names = await s.page.getByRole('option').allInnerTexts();
    expect(names).toEqual([
      'Auto',
      'Follow one face',
      'Split screen (two people)',
      'Screen + face',
      'Centre crop',
    ]);
    await s.page.getByRole('option', { name: 'Split screen (two people)' }).click();
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await start(s.page).click();
    await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-new-1$/);
    expect(s.state.log.started[0]!.options).toMatchObject({
      mode: 'clips',
      captionStyleId: 'hormozi-bold',
      reframeMode: 'multi-face',
    });
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('with captions switched off the style option is disabled and explains why', async () => {
    const s = await open('/', { scenario: 'configured' });
    await s.page.getByRole('switch', { name: 'Captions' }).click();
    await expect(s.page.getByTestId('home-caption-style')).toBeDisabled();
    const t = await tip(
      s.page,
      s.page
        .locator('span[tabindex="0"]')
        .filter({ has: s.page.getByTestId('home-caption-style') }),
    );
    await expect(t).toContainText('Captions are switched off');
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

/* ================================================================================================================== */

const TOOL_ROUTES = [
  ['find-moments', 'Find Moments'],
  ['highlights', 'One-Click Highlights'],
  ['summary', 'Video Summary'],
  ['transcripts', 'Video Transcripts'],
  ['subtitles', 'AI Subtitles'],
  ['reframe', 'AI Reframe'],
  ['thumbnail', 'AI Thumbnail'],
  ['hook', 'AI Hook'],
] as const;
const TOOL_BODY: Record<string, string> = {
  'find-moments': 'find-moments-tool',
  highlights: 'highlights-tool',
  summary: 'summary-tool',
  transcripts: 'transcripts-tool',
  subtitles: 'subtitles-tool',
  reframe: 'reframe-tool',
  thumbnail: 'thumbnail-tool',
  hook: 'hook-tool',
};
const cards = (p: Page) => p.getByTestId('tool-card');
const card = (p: Page, id: string) => p.locator(`[data-testid="tool-card"][data-tool="${id}"]`);

test.describe('Tools hub', () => {
  test('lists every tool from the brief; available ones link to their route, the rest are disabled with a reason', async () => {
    const s = await open('/tools/', { scenario: 'library' });
    await expect(cards(s.page)).toHaveCount(15);
    const names = await cards(s.page).locator('p.font-display').allInnerTexts();
    expect(names.sort()).toEqual(
      [
        'AI Clipping',
        'Find Moments',
        'One-Click Highlights',
        'Video Editor',
        'Video Summary',
        'Video Transcripts',
        'AI Subtitles',
        'AI Reframe',
        'AI Thumbnail',
        'AI Hook',
        'B-roll',
        'Live Clipping',
        'Game Clipping',
        'Speech Enhancer',
        'AI Video Generator',
      ].sort(),
    );
    const hrefs: Record<string, string> = {
      'ai-clipping': '/',
      'find-moments': '/tools/find-moments/',
      highlights: '/tools/highlights/',
      summary: '/tools/summary/',
      transcripts: '/tools/transcripts/',
      subtitles: '/tools/subtitles/',
      reframe: '/tools/reframe/',
      thumbnail: '/tools/thumbnail/',
      hook: '/tools/hook/',
    };
    for (const [id, href] of Object.entries(hrefs)) {
      await expect(card(s.page, id)).toHaveAttribute('data-available', 'true');
      await expect(card(s.page, id).getByRole('link')).toHaveAttribute('href', href);
    }
    for (const id of [
      'editor',
      'broll',
      'live-clipping',
      'game-clipping',
      'speech-enhancer',
      'video-generator',
    ]) {
      const c = card(s.page, id);
      await expect(c).toHaveAttribute('data-available', 'false');
      await expect(c.getByRole('link')).toHaveCount(0);
      await expect(c.locator('[aria-disabled="true"]')).toBeVisible();
      const t = await tip(s.page, c.locator('span[tabindex="0"]'));
      await expect(t).toContainText('Coming in a later version');
      await s.page.mouse.move(0, 0);
    }
    // grouped sections, LATER group at the end
    await expect(s.page.getByRole('region', { name: 'Later' })).toContainText('Game Clipping');
    // clicking a card navigates
    await card(s.page, 'subtitles').getByRole('link').click();
    await expect(s.page).toHaveURL(/\/tools\/subtitles\/$/);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('AI Clipping opens Home; the command palette lists every tool and opens the available ones', async () => {
    const s = await open('/tools/', { scenario: 'library' });
    await card(s.page, 'ai-clipping').getByRole('link').click();
    await expect(s.page).toHaveURL(/\/$/);
    await s.page.keyboard.press('Control+k');
    const palette = s.page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    for (const [, name] of TOOL_ROUTES)
      await expect(
        palette.getByRole('option', { name: new RegExp(`^${name}`) }).first(),
      ).toBeVisible();
    for (const name of [
      'Video Editor',
      'B-roll',
      'Live Clipping',
      'Game Clipping',
      'Speech Enhancer',
      'AI Video Generator',
    ])
      await expect(
        palette.getByRole('option', { name: new RegExp(`^${name}`) }).first(),
      ).toHaveAttribute('aria-disabled', 'true');
    await s.page.keyboard.type('summ');
    await s.page.keyboard.press('Enter');
    await expect(s.page).toHaveURL(/\/tools\/summary\/$/);
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test.describe('Standalone tool routes', () => {
  for (const [id, title] of TOOL_ROUTES) {
    test(`${title}: breadcrumb, video picker, choosing a video, deep link, last choice remembered`, async () => {
      const s = await open(`/tools/${id}/`, { scenario: 'library' });
      await expect(s.page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
        `Tools${title}`,
      );
      await expect(s.page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(s.page.locator('#page-title')).toHaveText(title); // top bar: "Tools › <tool>"
      const picker = s.page.getByTestId('video-picker');
      await expect(picker).toBeVisible();
      await expect(s.page.getByTestId('picker-video')).toHaveCount(4);
      const needsClips = ['reframe', 'thumbnail', 'hook'].includes(id);
      await expect(s.page.getByTestId('analyse-new')).toHaveCount(needsClips ? 0 : 1);
      // search filters the library
      await s.page.getByRole('textbox', { name: 'Search your videos' }).fill('podcast');
      await expect(s.page.getByTestId('picker-video')).toHaveCount(1);
      await s.page.getByRole('textbox', { name: 'Search your videos' }).fill('zzz');
      await expect(s.page.getByText('No videos match')).toBeVisible();
      await s.page.getByRole('button', { name: 'Clear search' }).first().click();
      // choose
      await s.page.locator('[data-video-id="vid-interview"]').click();
      await expect(s.page).toHaveURL(new RegExp(`/tools/${id}/\\?video=vid-interview`));
      await expect(s.page.getByTestId(TOOL_BODY[id]!)).toBeVisible();
      await expect(s.page.getByTestId('tool-source-title')).toHaveText(
        'Community Conversations: Autism Awareness & Local Art',
      );
      expect(await s.page.evaluate(() => localStorage.getItem('clipfern.tools.lastVideo'))).toBe(
        'vid-interview',
      );
      // change video -> picker again, with the last choice marked and listed first
      await s.page.getByTestId('change-video').click();
      await expect(s.page.getByTestId('video-picker')).toBeVisible();
      await expect(s.page.getByTestId('picker-video').first()).toHaveAttribute(
        'data-video-id',
        'vid-interview',
      );
      await expect(s.page.getByTestId('last-used')).toBeVisible();
      expect(s.problems).toEqual([]);
      await s.close();

      // a fresh session on the deep link goes straight to the tool
      const d = await open(`/tools/${id}/?video=vid-podcast`, { scenario: 'library' });
      await expect(d.page.getByTestId(TOOL_BODY[id]!)).toBeVisible();
      await expect(d.page.getByTestId('tool-source-title')).toContainText(
        'The Slow Founder Podcast',
      );
      expect(d.problems).toEqual([]);
      await d.close();
    });
  }

  test("?clip=<id> alone is enough: the clip's video is opened and the clip preselected", async () => {
    const s = await open('/tools/hook/?clip=vid-interview-c3', { scenario: 'library' });
    await expect(s.page.getByTestId('tool-source-title')).toContainText('Community Conversations');
    await expect(
      s.page.locator('[data-testid="clip-pick"][data-clip-id="vid-interview-c3"]'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(s.page.getByRole('region', { name: 'Hook variants' })).toContainText(
      'It took me forty years',
    );
    // choosing another clip updates the link
    await s.page.locator('[data-testid="clip-pick"][data-clip-id="vid-interview-c1"]').click();
    await expect(s.page).toHaveURL(/clip=vid-interview-c1/);
    await expect(s.page.getByRole('region', { name: 'Hook variants' })).toContainText(
      'Awareness isn’t enough',
    );
    // unknown clip: honest message + the picker
    const u = await open('/tools/hook/?clip=nope', { scenario: 'library' });
    await expect(u.page.getByText('That clip is not in your library')).toBeVisible();
    await expect(u.page.getByTestId('video-picker')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
    await u.close();
  });

  test('unknown video id and an empty library are handled', async () => {
    let s = await open('/tools/summary/?video=missing', { scenario: 'library' });
    await expect(s.page.getByText('This video is not in your library')).toBeVisible();
    await s.page.getByRole('button', { name: 'Choose a video' }).click();
    await expect(s.page.getByTestId('video-picker')).toBeVisible();
    await s.close();
    s = await open('/tools/reframe/', { scenario: 'configured' });
    await expect(s.page.getByText('Your library is empty')).toBeVisible();
    await expect(s.page.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Video Summary: overview / chapters / notes, Copy as Markdown, Download .md', async () => {
    const s = await open('/tools/summary/?video=vid-interview', { scenario: 'library' });
    await expect(s.page.getByTestId('overview-summary')).toContainText(
      'A warm, practical conversation',
    );
    await s.page.getByRole('radio', { name: 'Chapters' }).click();
    await expect(s.page.getByTestId('chapter-row')).toHaveCount(6);
    await s.page.getByRole('radio', { name: 'Notes' }).click();
    await expect(s.page.getByTestId('notes-tab')).toBeVisible();
    await s.page.getByRole('button', { name: 'Copy as Markdown' }).click();
    const md = await s.page.evaluate(() => navigator.clipboard.readText());
    expect(md).toContain('# Community Conversations: Autism Awareness & Local Art');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Key takeaways');
    expect(md).toContain('## Chapters');
    expect(md).toMatch(/- \*\*0:00 Welcome and introductions\*\*: /);
    expect(md).toContain('## Quotes');
    expect(md).toContain('## Action items');
    expect(md).toContain('## Topics');
    expect(md).toContain('Source: https://www.youtube.com/watch?v=Ab3dEf9GhIj');
    await expect(
      s.page.locator('[data-sonner-toast]').filter({ hasText: 'Summary copied as Markdown' }),
    ).toBeVisible();
    const [dl] = await Promise.all([
      s.page.waitForEvent('download'),
      s.page.getByRole('button', { name: 'Download .md' }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe(
      'community-conversations-autism-awareness-local-art-summary.md',
    );
    const path = await dl.path();
    const body = (await import('node:fs')).readFileSync(path, 'utf8');
    expect(body).toBe(md);
    // timestamps seek the shared player
    await s.page.getByRole('radio', { name: 'Chapters' }).click();
    await s.page.getByTestId('chapter-row').nth(2).click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(40);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Video Summary on a video without analysis shows the honest waiting state and disables the exports', async () => {
    const s = await open('/tools/summary/?video=vid-failed', { scenario: 'library' });
    await expect(s.page.getByRole('button', { name: 'Copy as Markdown' })).toBeDisabled();
    await expect(s.page.getByRole('button', { name: 'Download .md' })).toBeDisabled();
    await expect(s.page.getByTestId('pipeline-progress')).toBeVisible(); // failure + retry live on the tool page too
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Video Transcripts: searchable transcript; copy; download TXT / SRT / VTT', async () => {
    const s = await open('/tools/transcripts/?video=vid-interview', { scenario: 'library' });
    await s.page.getByRole('textbox', { name: 'Search transcript' }).fill('collage');
    await expect(s.page.getByTestId('match-count')).toHaveText(/^1 of \d+$/);
    await s.page.getByRole('button', { name: 'Copy transcript' }).click();
    const txt = await s.page.evaluate(() => navigator.clipboard.readText());
    expect(txt).toContain('Welcome back to Community Conversations');
    await s.page.getByTestId('transcript-download').click();
    const [dl] = await Promise.all([
      s.page.waitForEvent('download'),
      s.page.getByRole('menuitem', { name: /Plain text/ }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe(
      'community-conversations-autism-awareness-local-art-transcript.txt',
    );
    const body = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
    expect(body).toMatch(/^\[0:01\] Speaker 1: Welcome back to Community Conversations/);
    expect(body.split('\n')).toHaveLength(s.state.transcripts['vid-interview']!.sentences.length);
    await expect(s.page.getByRole('menu')).toHaveCount(0);
    await s.page.getByTestId('transcript-download').click();
    await s.page.getByRole('menuitem', { name: /SubRip/ }).click();
    await expect(s.page.getByRole('menu')).toHaveCount(0);
    await s.page.getByTestId('transcript-download').click();
    await s.page.getByRole('menuitem', { name: /WebVTT/ }).click();
    await expect.poll(() => cp2a(s.state).log.exports.map((e) => e.format)).toEqual(['srt', 'vtt']);
    await s.page.getByTestId('transcript-row').nth(2).click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(2);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('AI Subtitles: the subtitle editor with the style studio entry, on any library video', async () => {
    const s = await open('/tools/subtitles/?video=vid-interview', { scenario: 'library' });
    await expect(rows(s.page).first()).toBeVisible();
    const ta = await edit(s.page, row(s.page, 'Welcome back'));
    await ta.fill('Welcome back to Community Chats,');
    await ta.press('Enter');
    await expect.poll(() => saves(s).length).toBe(1);
    await openStudio(s);
    await tile(s.page, 'subtle-serif').click();
    await studio(s.page).getByTestId('studio-apply').click();
    await expect
      .poll(() => cp2a(s.state).log.styleSelections)
      .toEqual([{ id: 'vid-interview', styleId: 'subtle-serif' }]);
    await s.page
      .getByTestId('apply-all-dialog')
      .getByRole('button', { name: /Re-render 9 clips/ })
      .click();
    await expect.poll(() => cp2a(s.state).log.restyles.length).toBe(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('AI Reframe: per-clip mode, shows the layout used, re-frames one clip or all (with confirmation)', async () => {
    const s = await open('/tools/reframe/?video=vid-interview', { scenario: 'library' });
    const cardsList = s.page.getByTestId('reframe-card');
    await expect(cardsList).toHaveCount(9);
    const c1 = s.page.locator('[data-testid="reframe-card"][data-clip-id="vid-interview-c1"]');
    await expect(c1.getByTestId('reframe-layout')).toContainText('Layout: Single panel');
    await expect(c1.getByTestId('reframe-layout')).toContainText('Mode: Auto');
    await expect(c1.getByTestId('reframe-apply')).toBeDisabled(); // nothing changed yet
    await expect(c1.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await c1.getByRole('radio', { name: 'Split screen (two people)' }).click();
    await expect(c1.getByText('Two people stacked, top and bottom')).toBeVisible();
    await c1.getByTestId('reframe-apply').click();
    await expect
      .poll(() => cp2a(s.state).log.reframes)
      .toEqual([{ ids: ['vid-interview-c1'], mode: 'multi-face' }]);
    await expect(c1.getByText('Queued')).toBeVisible();
    // the render lands: layout badge updates from the pushed clip
    const clip = s.state.clips.find((c) => c.id === 'vid-interview-c1')!;
    Object.assign(clip, {
      status: 'rendered',
      renderProgress: null,
      hasRender: true,
      layout: 'split',
    });
    await s.emit('clips:updated', { ...clip });
    await expect(c1.getByTestId('reframe-layout')).toContainText('Layout: Split screen');
    await expect(c1.getByTestId('reframe-layout')).toContainText('Mode: Split screen (two people)');

    // all clips
    await s.page.getByTestId('reframe-all').click();
    const dlg = s.page.getByTestId('reframe-confirm');
    await expect(dlg).toContainText('Re-frame 9 clips?');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(cp2a(s.state).log.reframes).toHaveLength(1);
    await expect(dlg).toHaveCount(0);
    await s.page.getByRole('radio', { name: 'Centre crop' }).first().click();
    await s.page.getByTestId('reframe-all').click();
    await s.page
      .getByTestId('reframe-confirm')
      .getByRole('button', { name: 'Re-frame 9 clips' })
      .click();
    await expect.poll(() => cp2a(s.state).log.reframes.length).toBe(2);
    expect(cp2a(s.state).log.reframes[1]!.mode).toBe('center');
    expect(cp2a(s.state).log.reframes[1]!.ids).toHaveLength(9);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('clip tools on a video without clips explain it and point to Find Moments', async () => {
    const s = await open('/tools/reframe/?video=vid-processing', {
      scenario: 'library',
      prepare: (st) => {
        const v = st.videos.find((x) => x.id === 'vid-processing')!;
        Object.assign(v, { status: 'ready', stage: null, progress: null, clipCount: 0 });
        st.clips = st.clips.filter((c) => c.videoId !== 'vid-processing');
      },
    });
    await expect(s.page.getByText('This video has no clips yet')).toBeVisible();
    await s.page.getByRole('link', { name: 'Find moments' }).click();
    await expect(s.page).toHaveURL(/\/tools\/find-moments\/\?video=vid-processing/);
    await expect(s.page.getByTestId('clips-extras')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('AI Hook / AI Thumbnail host the clip tabs; Find Moments / Highlights host the steering panel', async () => {
    let s = await open('/tools/thumbnail/?video=vid-interview', { scenario: 'library' });
    await expect(s.page.getByTestId('clip-pick')).toHaveCount(9);
    await expect(s.page.getByRole('region', { name: 'Thumbnail options' })).toBeVisible();
    await expect(s.page).toHaveURL(/clip=vid-interview-c1/); // the best clip is preselected
    await s.close();
    s = await open('/tools/find-moments/?video=vid-interview', { scenario: 'library' });
    await expect(s.page.getByTestId('clips-extras')).toBeVisible();
    await expect(s.page.getByTestId('clip-card').first()).toBeVisible();
    await s.close();
    s = await open('/tools/highlights/?video=vid-interview', { scenario: 'library' });
    await expect(s.page.getByTestId('clips-extras')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Analyse a new video: paste a URL, start in analysis mode, watch live progress, then use the result', async () => {
    const s = await open('/tools/summary/', { scenario: 'configured' });
    const box = s.page.getByRole('textbox', { name: 'YouTube URL to analyse' });
    const go = s.page.getByRole('button', { name: 'Analyse', exact: true });
    await expect(go).toBeDisabled();
    await box.fill('https://vimeo.com/123');
    await box.blur();
    await expect(s.page.getByText(/not a YouTube link/i)).toBeVisible();
    await box.fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await expect(s.page.getByTestId('preview-title')).toHaveText(
      'Designing for Attention: A 15-Minute Talk',
    );
    await expect(go).toBeEnabled();
    await go.click();
    await expect(s.page).toHaveURL(/\/tools\/summary\/\?video=vid-new-1$/);
    // analysis mode and nothing else is sent: transcript + summary only
    expect(s.state.log.started).toEqual([
      { url: 'https://youtu.be/dQw4w9WgXcQ', options: { mode: 'analysis' } },
    ]);
    const progress = s.page.getByTestId('pipeline-progress');
    await expect(progress).toBeVisible();
    await s.sim('vid-new-1').run(2);
    await expect(progress).toContainText('Prepare media');
    // the summary tool waits honestly until the analysis exists
    await expect(s.page.getByRole('button', { name: 'Copy as Markdown' })).toBeDisabled();
    await s.sim('vid-new-1').run(5);
    await expect(s.page.getByTestId('overview-summary')).toContainText(
      'A warm, practical conversation',
    );
    await expect(s.page.getByRole('button', { name: 'Copy as Markdown' })).toBeEnabled();
    await s.sim('vid-new-1').run();
    await expect(s.page.getByTestId('tool-source')).toContainText('Ready');
    // no clips were made, and moments/render were skipped
    expect(s.state.clips.filter((c) => c.videoId === 'vid-new-1')).toHaveLength(0);
    expect(s.state.sims['vid-new-1']!.remaining()).toBe(0);
    // the same video in a clip tool: no clips yet -> pointer to Find Moments
    await s.page.goto(new URL('/tools/reframe/?video=vid-new-1', s.page.url()).toString());
    await expect(s.page.getByText('This video has no clips yet')).toBeVisible();
    await expect(s.page.getByText(/analysed without clips/)).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Analyse a new video is blocked with the first unmet setup step on a fresh install', async () => {
    const s = await open('/tools/transcripts/', { scenario: 'fresh' });
    await s.page
      .getByRole('textbox', { name: 'YouTube URL to analyse' })
      .fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await expect(s.page.getByRole('button', { name: 'Analyse', exact: true })).toBeDisabled();
    await expect(s.page.getByText('Finish setup to analyse a video')).toBeVisible();
    await expect(s.page.getByRole('link', { name: 'Add key' })).toHaveAttribute(
      'href',
      '/settings/api-keys/',
    );
    expect(s.state.log.started).toHaveLength(0);
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

/* ================================================================================================================== */

test.describe('Layout: no horizontal overflow, nothing leaves the viewport', () => {
  const overflow = (p: Page) =>
    p.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: (() => {
        const m = document.getElementById('main');
        return m ? m.scrollWidth - m.clientWidth : 0;
      })(),
    }));
  for (const width of [1280, 2560]) {
    test(`at ${width}px: hub, pickers, tools, subtitles, studio, Home`, async () => {
      const routes = [
        '/tools/',
        '/tools/summary/',
        '/tools/summary/?video=vid-interview',
        '/tools/transcripts/?video=vid-interview',
        '/tools/subtitles/?video=vid-interview',
        '/tools/reframe/?video=vid-interview',
        '/tools/hook/?video=vid-interview',
        `${SUBS}`,
        '/',
      ];
      for (const r of routes) {
        const s = await open(r, { scenario: 'library', width, height: 900 });
        const o = await overflow(s.page);
        expect(o, `${r} @${width}`).toEqual({ doc: 0, main: 0 });
        expect(s.problems, r).toEqual([]);
        await s.close();
      }
      const s = await open(SUBS, { scenario: 'library', width, height: 800 });
      await openStudio(s);
      await expect(studio(s.page).getByTestId('style-preview-img')).toBeVisible();
      const box = (await studio(s.page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(800);
      expect((await overflow(s.page)).doc).toBe(0);
      expect(s.problems).toEqual([]);
      await s.close();
    });
  }
});

// keep imports used even when specs are trimmed while debugging
void CP2_CLIP_DEFAULTS;
