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
    await expect(s.page.getByText(new RegExp(`^${total.toLocaleString('en-US')} captions`))).toBeVisible();
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
    await expect.poll(() => s.state.videos.find((v) => v.id === 'vid-interview')!.subtitleRev).toBe(1);
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
    await expect(row(s.page, /^\s*\d+:\d\d\.\d\s*\d+\.\ds\s*Joining me\s*$/)).toBeVisible();
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
    await expect(row(s.page, /^\s*\d+:\d\d\.\d\s*\d+\.\ds\s*are a\s*$/)).toBeVisible();
    await expect.poll(() => saves(s).length).toBe(2);

    // merge "Joining me" with the next cue
    const joining = row(s.page, /Joining me\s*$/);
    await joining.getByRole('button', { name: 'Merge with next' }).click();
    await expect(row(s.page, /Joining me are a\s*$/)).toBeVisible();
    await expect.poll(() => saves(s).length).toBe(3);
    expect(saves(s)[2]!.edits.merges.length).toBeGreaterThan(0);

    // undo walks back through merge and both splits
    await s.page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(s.page, /Joining me\s*$/)).toBeVisible();
    await s.page.keyboard.press('Control+z');
    await s.page.keyboard.press('Control+z');
    await expect(rows(s.page).filter({ hasText: /Joining me/ })).toHaveCount(1);
    await expect(row(s.page, 'Joining me are a pediatric therapist who')).toBeVisible();
    await expect(s.page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await expect(s.page.getByRole('button', { name: 'Redo' })).toBeEnabled();
    // redo re-applies the first split
    await s.page.keyboard.press('Control+Shift+z');
    await expect(row(s.page, /Joining me\s*$/)).toBeVisible();
    // undo/redo are saved too
    await expect.poll(() => saves(s).length).toBeGreaterThanOrEqual(5);
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
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
    await expect(row(s.page, 'I’m so glad you’re here.').getByTestId('cue-time')).toHaveText('0:30.5');
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
    // pause, then seek into a later cue: the highlight moves with the playhead
    await s.page.evaluate(() =>
      (document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement).pause(),
    );
    await s.page.evaluate(() => {
      (document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement).currentTime = 30.2;
    });
    await expect
      .poll(async () => (await s.page.locator('[data-testid="cue-row"][data-active]').first().innerText()).length)
      .toBeGreaterThan(0);
    const active = await s.page.locator('[data-testid="cue-row"][data-active]').first().getByTestId('cue-time').innerText();
    expect(Number(active.split(':')[1])).toBeLessThanOrEqual(30.2);
    expect(Number(active.split(':')[1])).toBeGreaterThan(24);
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
    const toast = s.page.locator('[data-sonner-toast]').filter({ hasText: 'Subtitles were not saved' });
    await expect(toast).toContainText('Storage is unreachable (ECONNRESET).');
    await expect(row(s.page, 'Welcome back everyone,')).toBeVisible(); // the edit is still on screen
    await toast.getByRole('button', { name: 'Retry' }).click();
    await expect(saveState(s.page)).toHaveAttribute('data-status', 'saved');
    expect(saves(s)).toHaveLength(2);
    // "to Community Conversations," became "everyone,": the first word takes the text, the rest are hidden
    expect(saves(s)[1]!.edits.words).toEqual({
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
    await ta.fill('Hello and welcome back to Community Conversations,');
    await ta.press('Enter');
    await s.page.getByRole('tab', { name: 'Overview' }).click(); // leave before the debounce fires
    await expect.poll(() => saves(s).length).toBe(1);
    await s.page.getByRole('tab', { name: 'Subtitles' }).click();
    await expect(rows(s.page).first().getByTestId('cue-text')).toHaveText(
      'Hello and welcome back to Community Conversations,',
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
    await expect(s.page.locator('[data-sonner-toast]').filter({ hasText: 'Re-rendering 8 clips' })).toBeVisible();
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
    await expect(s.page.locator('[data-sonner-toast]').filter({ hasText: 'Exported SRT' })).toBeVisible();
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
    const t = await tip(s.page, row(s.page, 'Welcome back').getByRole('button', { name: 'Merge with next' }));
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
    expect(s.problems.filter((p) => !/subtitle store is locked|Failed to load resource|500/.test(p))).toEqual([]);
    await s.close();
  });
});

// keep imports used even when specs are trimmed while debugging
void CP2_CLIP_DEFAULTS;
