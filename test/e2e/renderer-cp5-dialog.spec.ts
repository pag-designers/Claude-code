import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  openPublish,
  type HarnessB,
  type PubOpen,
  type PubSession,
} from './support/publish-harness';
import { ACC_IG, ACC_TT, ACC_YT, FIXED_NOW, HOUR, makeAccount } from './support/publish-stub';
import { seedEditor, seedExports } from './support/editor-stub-panels';

/**
 * CP5 schedule dialog (`SchedulePostDialog`) and the clip picker: accounts, per-platform tabs with prefilled fields and
 * live counters, media validation + Auto-fix, the TikTok unaudited banner, the YouTube made-for-kids declaration,
 * Post now / Pick a time / Smart spacing with an adjustable preview, per-item refusals with the media report.
 * Real exported renderer + the contract-validating bridge stub; browser clock frozen at Wed 14 Oct 2026 10:00.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-dialog.spec.ts
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

const open = (opts: PubOpen = {}, route = '/scheduler/') =>
  openPublish(h, route, { settle: 300, ...opts });
const clean = (s: PubSession) => expect(s.problems).toEqual([]);
const at = (d: number, hh: number, m = 0) => new Date(2026, 9, d, hh, m, 0, 0).getTime();
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });
const dlg = (p: Page) => p.getByTestId('schedule-dialog');

const A = 'The 412-hour collage that starts with texture';
const B = 'Why we turned down our Series A';
const C = '“It took me forty years to trust that”';

const clipId = (s: PubSession, title: string) => s.state.clips.find((c) => c.title === title)!.id;

/** Scheduler page -> "Schedule a post" -> tick clips -> Continue. */
async function schedule(s: PubSession, titles: string[]) {
  await s.page.getByTestId('schedule-new').click();
  await expect(s.page.getByTestId('pick-dialog')).toBeVisible();
  for (const t of titles) await s.page.getByRole('checkbox', { name: `Select ${t}` }).click();
  await s.page.getByTestId('pick-continue').click();
  await expect(dlg(s.page)).toBeVisible();
  // prefill + validation settled
  await expect(dlg(s.page).getByTestId('schedule-problem')).not.toHaveText(
    'Loading the default fields…',
  );
  return dlg(s.page);
}
const tab = (d: Locator, p: 'shorts' | 'reels' | 'tiktok') => d.getByTestId(`schedule-tab-${p}`);
const submit = (d: Locator) => d.getByTestId('schedule-submit');
const kidsNo = (d: Locator) => d.getByTestId('kids-no').check();

/* ------------------------------------------------------------------------------------ picker ----- */

test.describe('clip picker', () => {
  test('lists rendered clips by score, filters by search, selects several, shows existing usage', async () => {
    const s = await open({ seed: true });
    await s.page.getByTestId('schedule-new').click();
    const pick = s.page.getByTestId('pick-dialog');
    await expect(pick).toBeVisible();
    await expect(pick.getByTestId('pick-tab-clips')).toContainText('13');
    await expect(pick.getByRole('checkbox')).toHaveCount(13);
    await expect(pick.getByTestId('pick-count')).toHaveText('Nothing selected');
    await expect(pick.getByTestId('pick-continue')).toBeDisabled();
    // the failed render is not offered
    await expect(pick.getByText('ffmpeg')).toHaveCount(0);
    await pick.getByLabel('Search clips').fill('series a');
    await pick.getByRole('checkbox', { name: `Select ${B}` }).click();
    await expect(pick.getByTestId('pick-count')).toHaveText('1 selected');
    await pick.getByLabel('Search clips').fill('');
    await pick.getByRole('checkbox', { name: `Select ${A}` }).click();
    await expect(pick.getByTestId('pick-count')).toHaveText('2 selected');
    await pick.getByLabel('Search clips').fill('zzzz');
    await expect(pick).toContainText('Nothing matches');
    // seeded posts use the first clip
    await pick.getByLabel('Search clips').fill('Awareness');
    await expect(pick).toContainText('Used in 8 posts');
    await s.page.keyboard.press('Escape');
    await expect(pick).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('exports tab: only finished exports; picking one opens the dialog for that export', async () => {
    const s = await open({
      prepare: (_lib, state) => {
        seedEditor(state);
        seedExports(state);
      },
    });
    await s.page.getByTestId('schedule-new').click();
    await s.page.getByTestId('pick-tab-exports').click();
    const pick = s.page.getByTestId('pick-dialog');
    await expect(pick.getByRole('checkbox')).toHaveCount(2);
    await expect(pick).not.toContainText('Untitled square');
    await pick.getByRole('checkbox', { name: 'Select Founder story, rough cut' }).click();
    await pick.getByTestId('pick-continue').click();
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    await expect(d.getByTestId('schedule-source')).toContainText('Founder story, rough cut');
    await expect(d.getByTestId('schedule-source')).toContainText('Editor export');
    await kidsNo(d);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.source).toEqual({ exportId: 'ex-done' });
    clean(s);
    await s.close();
  });
});

/* -------------------------------------------------------------------------------- single clip ----- */

test.describe('single clip', () => {
  test('accounts preselected, fields prefilled per platform, kids declaration required, then posts:create', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await expect(d.getByTestId('schedule-source')).toContainText(A);
    // every connected account is selected; one tab per platform
    await expect(d.locator('[data-testid="schedule-account"][data-selected]')).toHaveCount(3);
    await expect(d.getByRole('tab')).toHaveText([/YouTube/, /Instagram/, /TikTok/]);
    // prefill from the clip metadata + hashtags
    await expect(d.getByLabel('Title')).toHaveValue(A);
    await expect(d.getByLabel('Description')).toHaveValue(/Highlights from.*#clipfern #shorts/s);
    // the declaration is mandatory: nothing is pre-selected and the dialog says why it cannot continue
    await expect(d.getByTestId('kids-required')).toBeVisible();
    await expect(submit(d)).toBeDisabled();
    await expect(d.getByTestId('schedule-problem')).toContainText('made for kids');
    await expect(tab(d, 'shorts').getByRole('img', { name: 'needs attention' })).toBeVisible();
    await kidsNo(d);
    await expect(d.getByTestId('kids-required')).toHaveCount(0);
    await expect(submit(d)).toBeEnabled();
    await expect(submit(d)).toHaveText(/Schedule 3 posts/);

    // suggested time (prefill) is the default for "Pick a time"
    await expect(d.getByLabel('Publish at')).toHaveValue('2026-10-15T14:00');
    await expect(d.getByTestId('time-zone')).toContainText('Your local time zone');
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(3);
    const items = s.lib.log.created;
    expect(items.map((i) => i.fields.platform).sort()).toEqual(['reels', 'shorts', 'tiktok']);
    for (const i of items) {
      expect(i.source).toEqual({ clipId: clipId(s, A) });
      expect(i.scheduledAt).toBe(at(15, 14, 0));
      expect(i.autoFix).toBe(true);
    }
    expect(new Set(items.map((i) => i.groupId)).size).toBe(1);
    expect(items[0]!.groupId).toBeTruthy();
    expect(items.find((i) => i.fields.platform === 'shorts')!.fields).toMatchObject({
      title: A,
      madeForKids: false,
    });
    await expect(dlg(s.page)).toHaveCount(0);
    const t = toast(s.page, '3 posts scheduled');
    await expect(t).toBeVisible();
    await expect(t.getByRole('button', { name: 'View in Scheduler' })).toBeVisible();
    // the new posts are on the calendar right away
    await expect(
      s.page.locator('[data-testid="day-cell"][data-day="2026-10-15"] [data-testid="post-chip"]'),
    ).toHaveCount(3);
    await expect(s.page.getByTestId('status-upcoming')).toHaveText('3');
    clean(s);
    await s.close();
  });

  test('"Yes, made for kids" is sent as madeForKids true', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await d.getByTestId('kids-yes').check();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.fields).toMatchObject({ platform: 'shorts', madeForKids: true });
    expect(s.lib.log.created[0]!.groupId).toBeNull();
    clean(s);
    await s.close();
  });

  test('Post now sends scheduledAt null; Pick a time rejects the past and offers the suggestion chip', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await kidsNo(d);
    const time = d.getByLabel('Publish at');
    await time.fill('2026-10-10T09:00');
    await expect(d.getByTestId('field-issue').first()).toContainText('future');
    await expect(submit(d)).toBeDisabled();
    await expect(d.getByTestId('schedule-problem')).toContainText('future');
    const chipBtn = d.getByTestId('suggested-time');
    await expect(chipBtn).toContainText('Suggested: Tomorrow 2:00');
    await chipBtn.click();
    await expect(time).toHaveValue('2026-10-15T14:00');
    await expect(chipBtn).toHaveCount(0);
    await time.fill('2026-10-20T19:45');
    await expect(submit(d)).toBeEnabled();

    await d.getByRole('radio', { name: 'Post now' }).click();
    await expect(d.getByTestId('when-now')).toContainText(
      'Publishing starts as soon as you confirm',
    );
    await expect(submit(d)).toHaveText(/Post now/);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.scheduledAt).toBeNull();
    await expect(toast(s.page, 'Posting now')).toBeVisible();
    // main queued it: the calendar shows it today and the status bar counts it
    await expect(s.page.getByTestId('status-upcoming')).toHaveText('1');
    clean(s);
    await s.close();
  });

  test('toast action "View in Scheduler" navigates from another page', async () => {
    const s = await open({ seed: true }, '/library/video/?id=vid-interview&tab=clips');
    await s.page.getByRole('button', { name: `Open clip: ${A}` }).click();
    await s.page.getByTestId('drawer-post').click();
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await kidsNo(d);
    await submit(d).click();
    const t = toast(s.page, 'Post scheduled');
    await t.getByRole('button', { name: 'View in Scheduler' }).click();
    await expect(s.page).toHaveURL(/\/scheduler\/$/);
    clean(s);
    await s.close();
  });

  test('choosing accounts: deselecting removes the platform tab; the choice is remembered', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await expect(d.getByRole('tab')).toHaveText([/YouTube/, /TikTok/]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await expect(d.getByRole('tab')).toHaveText([/YouTube/]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Shorts' }).click();
    await expect(d.getByRole('tab')).toHaveCount(0);
    await expect(submit(d)).toBeDisabled();
    await expect(d.getByTestId('schedule-problem')).toHaveText('Choose at least one account.');
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Shorts' }).click();
    await kidsNo(d);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.accountId).toBe(ACC_YT);
    // next time only YouTube is preselected
    const d2 = await schedule(s, [B]);
    await expect(d2.locator('[data-testid="schedule-account"][data-selected]')).toHaveCount(1);
    await expect(d2.getByRole('tab')).toHaveText([/YouTube/]);
    clean(s);
    await s.close();
  });

  test('two accounts on one platform both get the post', async () => {
    const extra = makeAccount('shorts', {
      id: 'acc-yt-2',
      displayName: 'Second Channel',
      handle: 'second',
    });
    const s = await open({ accounts: [makeAccount('shorts', { id: ACC_YT }), extra] });
    const d = await schedule(s, [A]);
    await expect(d.getByRole('tab')).toHaveText([/YouTube/]);
    await kidsNo(d);
    await expect(submit(d)).toHaveText(/Schedule 2 posts/);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(2);
    expect(s.lib.log.created.map((i) => i.accountId).sort()).toEqual(['acc-yt-2', ACC_YT].sort());
    clean(s);
    await s.close();
  });

  test('accounts that need re-auth cannot be picked; with none connected the dialog guides to Settings', async () => {
    const s = await open({
      prepare: (lib) => {
        const a = lib.accounts.find((x) => x.id === ACC_IG)!;
        a.status = 'needs-reauth';
      },
    });
    const d = await schedule(s, [A]);
    const ig = d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' });
    await expect(ig).toBeDisabled();
    await expect(ig).toContainText('Needs re-auth');
    await expect(d.getByRole('tab')).toHaveText([/YouTube/, /TikTok/]);

    const n = await open({ accounts: [] });
    const nd = await schedule(n, [A]);
    await expect(nd.getByText('Connect an account first')).toBeVisible();
    await expect(nd.getByRole('link', { name: 'Connect an account' })).toHaveAttribute(
      'href',
      '/settings/integrations/',
    );
    await expect(submit(nd)).toBeDisabled();
    clean(s);
    clean(n);
    await s.close();
    await n.close();
  });
});

/* ------------------------------------------------------------------------------ platform fields ----- */

test.describe('platform fields in the dialog', () => {
  test('counters, over-limit blocking, and server-side issues inline', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.fieldIssues = (platform, fields) =>
          platform === 'tiktok' && fields?.platform === 'tiktok' && /banned/.test(fields.title)
            ? [{ field: 'title', message: 'TikTok does not allow this word in captions.' }]
            : [];
      },
    });
    const d = await schedule(s, [A]);
    await kidsNo(d);
    const title = d.getByLabel('Title');
    await expect(d.getByText(`${A.length} / 100`)).toBeVisible();
    await title.fill('x'.repeat(100));
    await expect(d.getByText('100 / 100')).toBeVisible();
    await title.fill('x'.repeat(101));
    await expect(d.locator('[data-state="over"]').first()).toHaveText(/101 \/ 100/);
    await expect(d.getByTestId('field-issue').first()).toContainText('1 chars over the 100 limit');
    await expect(submit(d)).toBeDisabled();
    await title.fill('ok');
    await expect(submit(d)).toBeEnabled();

    await tab(d, 'reels').click();
    const cap = d.getByLabel('Caption');
    await cap.fill('One #a #b #c @friend');
    await expect(d.getByTestId('reels-counters')).toContainText('3 / 30');
    await expect(d.getByTestId('reels-counters')).toContainText('1 / 20');
    await cap.fill(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '));
    await expect(d.getByTestId('reels-counters').locator('[data-state="over"]')).toHaveText(
      /31 \/ 30/,
    );
    await expect(submit(d)).toBeDisabled();
    await cap.fill('Short');
    await tab(d, 'tiktok').click();
    await d.getByLabel('Caption').fill('This is banned');
    await expect(d.getByTestId('field-issue').first()).toContainText('does not allow this word');
    await expect(submit(d)).toBeDisabled();
    await expect(tab(d, 'tiktok').getByRole('img', { name: 'needs attention' })).toBeVisible();
    await d.getByLabel('Caption').fill('Fine caption');
    await expect(submit(d)).toBeEnabled();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(3);
    const f = (p: string) => s.lib.log.created.find((i) => i.fields.platform === p)!.fields;
    expect(f('shorts')).toMatchObject({ title: 'ok' });
    expect(f('reels')).toMatchObject({ caption: 'Short' });
    expect(f('tiktok')).toMatchObject({ title: 'Fine caption' });
    clean(s);
    await s.close();
  });

  test('YouTube tags, visibility and category are sent', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await kidsNo(d);
    await d.getByRole('radio', { name: 'Unlisted' }).click();
    await d.getByLabel('Category').click();
    await s.page.getByRole('option', { name: 'Education' }).click();
    await d.getByLabel('Notify subscribers').click();
    await d.getByLabel('Add a tag').fill('extra');
    await d.getByLabel('Add a tag').press('Enter');
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.fields).toMatchObject({
      visibility: 'unlisted',
      categoryId: '27',
      notifySubscribers: false,
    });
    expect((s.lib.log.created[0]!.fields as { tags: string[] }).tags).toContain('extra');
    clean(s);
    await s.close();
  });
});

/* ---------------------------------------------------------------------------------------- TikTok ----- */

test.describe('TikTok unaudited', () => {
  test('banner, private-only privacy, "Upload to drafts" and the audit link', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Shorts' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await expect(d.getByText('TikTok has not audited this app yet')).toBeVisible();
    const banner = d.getByTestId('tiktok-unaudited');
    await expect(banner).toContainText('private');
    await expect(banner.getByTestId('tiktok-audit-link')).toHaveAttribute(
      'href',
      '/settings/integrations/#tiktok-audit',
    );
    const privacy = d.getByLabel('Who can watch this video');
    await expect(privacy).toContainText('Only me (private)');
    await expect(d.getByText('Locked to private until TikTok approves your app.')).toBeVisible();
    await privacy.click();
    await expect(s.page.getByRole('option', { name: /Everyone · after audit/ })).toHaveAttribute(
      'data-disabled',
      '',
    );
    await s.page.keyboard.press('Escape');

    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.fields).toMatchObject({
      platform: 'tiktok',
      mode: 'direct',
      privacyLevel: 'SELF_ONLY',
    });
    clean(s);
    await s.close();
  });

  test('"Upload to drafts so I publish in the TikTok app" switches to mode draft', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Shorts' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    const btn = d.getByTestId('tiktok-use-drafts');
    await expect(btn).toHaveText(/Upload to drafts so I publish in the TikTok app/);
    await btn.click();
    await expect(btn).toHaveText(/Uploading to drafts/);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByTestId('tiktok-mode-hint')).toContainText('TikTok inbox');
    await expect(d.getByLabel('Who can watch this video')).toHaveCount(0);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.fields).toMatchObject({
      platform: 'tiktok',
      mode: 'draft',
      privacyLevel: 'SELF_ONLY',
    });
    clean(s);
    await s.close();
  });

  test('an audited account has no banner and can post publicly', async () => {
    const s = await open({
      accounts: [makeAccount('tiktok', { id: ACC_TT, info: { audited: true } })],
    });
    const d = await schedule(s, [A]);
    await expect(d.getByTestId('tiktok-unaudited')).toHaveCount(0);
    await d.getByLabel('Who can watch this video').click();
    await s.page.getByRole('option', { name: 'Everyone' }).click();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.fields).toMatchObject({
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      mode: 'direct',
    });
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------ media validation ----- */

test.describe('media report and Auto-fix', () => {
  const issues = {
    fixable: {
      severity: 'error' as const,
      code: 'duration-long' as const,
      message: 'Clip is 3:12; Shorts allow 3:00.',
      fixable: true,
    },
    hard: {
      severity: 'error' as const,
      code: 'aspect' as const,
      message: 'Aspect 16:9 is not supported for Reels.',
      fixable: false,
    },
    warn: {
      severity: 'warning' as const,
      code: 'bitrate' as const,
      message: 'Bitrate is low.',
      fixable: false,
    },
  };

  test('a clean file says so; a fixable error is repaired by Auto-fix (sent as autoFix true) and blocks without it', async () => {
    const s = await open({
      prepare: (lib, state) => {
        const id = state.clips.find((c) => c.title === A)!.id;
        lib.mediaIssues[`c:${id}|shorts`] = [issues.fixable, issues.warn];
      },
    });
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await kidsNo(d);
    const rep = d.getByTestId('media-report');
    await expect(rep).toContainText('Needs a re-encode for YouTube Shorts');
    await expect(rep.locator('[data-severity="error"]')).toContainText('Shorts allow 3:00');
    await expect(rep.locator('[data-severity="error"]')).toContainText('Fixable');
    await expect(rep.locator('[data-severity="warning"]')).toContainText('Bitrate is low');
    await expect(rep.getByTestId('media-facts')).toContainText('0:42 · 1080×1920 · 30 fps');
    await expect(rep.getByTestId('spec-summary')).toContainText(
      'YouTube Shorts accepts: up to 3 min',
    );
    const sw = d.getByRole('switch', { name: 'Auto-fix' });
    await expect(sw).toBeChecked();
    await expect(submit(d)).toBeEnabled();

    await sw.click();
    await expect(rep).toHaveAttribute('data-blocked', 'true');
    await expect(submit(d)).toBeDisabled();
    await expect(d.getByTestId('schedule-problem')).toContainText('does not meet YouTube');
    await sw.click();
    await expect(submit(d)).toBeEnabled();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.autoFix).toBe(true);
    clean(s);
    await s.close();
  });

  test('an error that cannot be fixed blocks even with Auto-fix on, and the clean platforms still read fine', async () => {
    const s = await open({
      prepare: (lib, state) => {
        const id = state.clips.find((c) => c.title === A)!.id;
        lib.mediaIssues[`c:${id}|reels`] = [issues.hard];
      },
    });
    const d = await schedule(s, [A]);
    await kidsNo(d);
    await tab(d, 'reels').click();
    const rep = d.getByTestId('media-report');
    await expect(rep).toHaveAttribute('data-blocked', 'true');
    await expect(rep).toContainText("Doesn't meet Instagram Reels's requirements");
    await expect(rep.locator('[data-severity="error"]')).not.toContainText('Fixable');
    await expect(submit(d)).toBeDisabled();
    await tab(d, 'tiktok').click();
    await expect(d.getByTestId('media-report')).toContainText("Meets TikTok's requirements");
    // dropping Instagram from the selection unblocks the rest
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await expect(submit(d)).toBeEnabled();
    clean(s);
    await s.close();
  });

  test('the Auto-fix default follows Settings → Scheduler', async () => {
    const s = await open({
      prepare: (lib, state) => {
        state.settings.autoFixMedia = false;
        const id = state.clips.find((c) => c.title === A)!.id;
        lib.mediaIssues[`c:${id}|shorts`] = [issues.fixable];
      },
    });
    const d = await schedule(s, [A]);
    await expect(d.getByRole('switch', { name: 'Auto-fix' })).not.toBeChecked();
    await expect(d.getByTestId('media-report')).toHaveAttribute('data-blocked', 'true');
    clean(s);
    await s.close();
  });
});

/* --------------------------------------------------------------------------------------- refusal ----- */

test.describe('refusals', () => {
  test('main refuses one item: reason + media report shown, the others are scheduled, a retry sends only the refused one', async () => {
    let first = true;
    const s = await open({
      prepare: (lib, state) => {
        lib.refuse = (item) => {
          if (first && item.fields.platform === 'reels') {
            first = false;
            return {
              reason: 'Instagram says the video is too long for a Reel.',
              report: {
                platform: 'reels',
                ok: false,
                issues: [
                  {
                    severity: 'error',
                    code: 'duration-long',
                    message: 'Reels can be at most 90 seconds; this clip is 94 s.',
                    fixable: true,
                  },
                ],
                media: {
                  durationSec: 94,
                  width: 1080,
                  height: 1920,
                  fps: 30,
                  sizeBytes: 30_000_000,
                  videoCodec: 'h264',
                  audioCodec: 'aac',
                },
              },
              fieldIssues: [{ field: 'caption', message: 'Caption mentions a banned tag.' }],
            };
          }
          return null;
        };
        void state;
      },
    });
    const d = await schedule(s, [A]);
    await kidsNo(d);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(3);
    // the dialog stays open with the refusal
    const ref = d.getByTestId('refusal');
    await expect(ref).toHaveCount(1);
    await expect(d.getByTestId('schedule-refusals')).toContainText('1 post was not scheduled');
    await expect(d.getByTestId('schedule-refusals')).toContainText(
      '2 other posts are in the queue',
    );
    await expect(ref.getByTestId('refusal-reason')).toHaveText(
      'Instagram says the video is too long for a Reel.',
    );
    await expect(ref).toContainText('Riverside Reels');
    await expect(ref.getByTestId('media-report')).toContainText('Reels can be at most 90 seconds');
    await expect(ref).toContainText('Caption mentions a banned tag.');
    await expect(toast(s.page, '2 posts scheduled')).toContainText('1 could not be scheduled');
    // the two that worked are already on the calendar behind the dialog
    await expect(s.page.getByTestId('status-upcoming')).toHaveText('2');

    // second attempt: only the refused item is sent
    await expect(submit(d)).toHaveText(/Schedule post/);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(4);
    expect(s.lib.log.created[3]!.fields.platform).toBe('reels');
    await expect(dlg(s.page)).toHaveCount(0);
    await expect(s.page.getByTestId('status-upcoming')).toHaveText('3');
    clean(s);
    await s.close();
  });

  test('main-side media refusal (an unfixable file) is explained with the report', async () => {
    const s = await open({
      prepare: (lib, state) => {
        const id = state.clips.find((c) => c.title === A)!.id;
        // the pre-check passes (no issues), but main finds one: simulate drift between check and create
        let n = 0;
        lib.refuse = () =>
          n++ === 0 ? { reason: 'The file changed on disk since it was checked.' } : null;
        void id;
      },
    });
    const d = await schedule(s, [A]);
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
    await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
    await kidsNo(d);
    await submit(d).click();
    await expect(d.getByTestId('refusal-reason')).toHaveText(
      'The file changed on disk since it was checked.',
    );
    clean(s);
    await s.close();
  });

  test('a failed posts:create keeps the dialog open and says why', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.failNext['posts:create'] = { message: 'The scheduler database is locked.', times: 1 };
      },
    });
    const d = await schedule(s, [A]);
    await kidsNo(d);
    await submit(d).click();
    await expect(toast(s.page, 'Could not schedule')).toContainText(
      'The scheduler database is locked.',
    );
    await expect(d).toBeVisible();
    await expect(submit(d)).toBeEnabled();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(3);
    await expect(dlg(s.page)).toHaveCount(0);
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------ smart spacing ----- */

test.describe('smart spacing (several clips)', () => {
  const WINDOWS = [
    { id: 'w1', platform: null, days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '20:00' },
  ];

  test('previews a plan inside the kit windows, grouped per clip; times are adjustable and warned; posts:create uses them', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.windows = WINDOWS;
      },
    });
    const d = await schedule(s, [A, B, C]);
    await expect(d.getByRole('heading', { name: 'Schedule 3 clips' })).toBeVisible();
    await expect(d.getByTestId('schedule-source')).toContainText('3 clips');
    // smart spacing is the default; "Pick a time" is not offered for several clips
    await expect(d.getByRole('radio', { name: 'Smart spacing' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(d.getByRole('radio', { name: 'Pick a time' })).toHaveCount(0);
    const plan = d.getByTestId('smart-plan');
    await expect(plan).toContainText('your Brand Kit posting windows');
    await expect(plan).toContainText('at least 180 min apart and at most 3 a day');
    await expect(d.getByTestId('plan-group')).toHaveCount(3);
    await expect(d.getByTestId('plan-row')).toHaveCount(9);
    // several clips: only the shared settings are shown, titles come from each clip
    await expect(d.getByLabel('Title')).toHaveCount(0);
    await expect(d.getByTestId('bulk-media-summary')).toContainText('All 3 clips meet YouTube');

    // every planned time sits in the 18:00-20:00 window (a few minutes of jitter allowed) and is in the future
    const values = await d
      .locator('[data-testid="plan-row"] input[type="datetime-local"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(values).toHaveLength(9);
    for (const v of values) {
      const ms = new Date(v).getTime();
      const mins = new Date(ms).getHours() * 60 + new Date(ms).getMinutes();
      expect(ms).toBeGreaterThan(FIXED_NOW);
      expect(mins).toBeGreaterThanOrEqual(18 * 60 - 10);
      expect(mins).toBeLessThanOrEqual(20 * 60 + 10);
    }
    // per account the clips land on different days (one 2-hour window, 3 h gap)
    for (const acc of [ACC_YT, ACC_IG, ACC_TT]) {
      const days = await d
        .locator(`[data-testid="plan-row"][data-key$=":${acc}"] input[type="datetime-local"]`)
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value.slice(0, 10)));
      expect(new Set(days).size).toBe(3);
    }

    // adjust one: put clip B / YouTube right next to clip A / YouTube -> warning, still submittable
    const aRow = d.locator(`[data-testid="plan-row"][data-key="0:${ACC_YT}"] input`);
    const bRow = d.locator(`[data-testid="plan-row"][data-key="1:${ACC_YT}"] input`);
    const aVal = await aRow.inputValue();
    await bRow.fill(
      `${aVal.slice(0, 11)}${String(Number(aVal.slice(11, 13)) + 1).padStart(2, '0')}${aVal.slice(13)}`,
    );
    const warn = d.locator(
      `[data-testid="plan-row"][data-key="1:${ACC_YT}"] [data-testid="plan-warning"]`,
    );
    await expect(warn).toContainText('Closer than 180 min');
    await expect(d.locator(`[data-testid="plan-row"][data-key="1:${ACC_YT}"]`)).toContainText(
      'adjusted',
    );
    const adjusted = await bRow.inputValue();
    await bRow.fill('2026-10-30T19:00');
    await expect(warn).toHaveCount(0);

    await kidsNo(d);
    await expect(submit(d)).toHaveText(/Schedule 9 posts/);
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(9);
    const items = s.lib.log.created;
    expect(new Set(items.map((i) => i.groupId)).size).toBe(1);
    expect(items[0]!.groupId).toBeTruthy();
    const ids = [A, B, C].map((t) => clipId(s, t));
    const bYt = items.find(
      (i) => 'clipId' in i.source && i.source.clipId === ids[1] && i.accountId === ACC_YT,
    )!;
    expect(bYt.scheduledAt).toBe(at(30, 19, 0));
    expect(bYt.scheduledAt).not.toBe(new Date(adjusted).getTime());
    // titles come from each clip, shared settings from the dialog
    const titles = items
      .filter((i) => i.fields.platform === 'shorts')
      .map((i) => (i.fields as { title: string }).title)
      .sort();
    expect(titles).toEqual([A, B, C].sort());
    for (const i of items) expect(i.scheduledAt).toBeGreaterThan(FIXED_NOW);
    await expect(toast(s.page, '9 posts scheduled')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('without Brand Kit windows it says it used lunch and evening; the Settings gap and daily cap shape the plan', async () => {
    const s = await open({
      prepare: (_lib, state) => {
        state.settings.schedulerMinGapMinutes = 60;
        state.settings.schedulerMaxPerDay = 2;
      },
      accounts: [makeAccount('shorts', { id: ACC_YT })],
    });
    const d = await schedule(s, [A, B, C, 'Awareness isn’t enough. Acceptance changes the room.']);
    const plan = d.getByTestId('smart-plan');
    await expect(plan).toContainText('lunch and evening');
    await expect(plan).toContainText('at least 60 min apart and at most 2 a day');
    const values = await d
      .locator('[data-testid="plan-row"] input[type="datetime-local"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
    expect(values).toHaveLength(4);
    const perDay = new Map<string, number>();
    for (const v of values) perDay.set(v.slice(0, 10), (perDay.get(v.slice(0, 10)) ?? 0) + 1);
    for (const n of perDay.values()) expect(n).toBeLessThanOrEqual(2);
    for (let i = 1; i < values.length; i++)
      expect(
        new Date(values[i]!).getTime() - new Date(values[i - 1]!).getTime(),
      ).toBeGreaterThanOrEqual(60 * 60_000);
    clean(s);
    await s.close();
  });

  test('"Start no earlier than" moves the whole plan; already queued posts on the account are avoided', async () => {
    const s = await open({
      seed: true,
      prepare: (lib) => {
        lib.windows = WINDOWS;
        // a post already occupies YouTube on the 15th at 19:00
        void lib.addPost({
          id: 'busy',
          accountId: ACC_YT,
          status: 'scheduled',
          scheduledAt: at(15, 19, 0),
          title: 'Busy',
        });
      },
    });
    const d = await schedule(s, [A, B]);
    const rowsYt = d.locator(
      `[data-testid="plan-row"][data-key$=":${ACC_YT}"] input[type="datetime-local"]`,
    );
    const before = await rowsYt.evaluateAll((els) =>
      els.map((e) => new Date((e as HTMLInputElement).value).getTime()),
    );
    for (const t of before) expect(Math.abs(t - at(15, 19, 0))).toBeGreaterThanOrEqual(3 * HOUR);
    await d.getByLabel('Start no earlier than').fill('2026-10-26T00:00');
    const after = await rowsYt.evaluateAll((els) =>
      els.map((e) => new Date((e as HTMLInputElement).value).getTime()),
    );
    for (const t of after) expect(t).toBeGreaterThanOrEqual(at(26, 0));
    clean(s);
    await s.close();
  });

  test('several clips can also be posted right now, and a plan with a time in the past blocks', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.windows = WINDOWS;
      },
    });
    const d = await schedule(s, [A, B]);
    await kidsNo(d);
    const first = d.locator('[data-testid="plan-row"] input[type="datetime-local"]').first();
    await first.fill('2026-10-01T18:00');
    await expect(d.getByTestId('plan-warning').first()).toContainText('in the past');
    await expect(submit(d)).toBeDisabled();
    await d.getByRole('radio', { name: 'Post now' }).click();
    await expect(d.getByTestId('when-now')).toContainText(
      'All 6 posts start publishing right away',
    );
    await expect(submit(d)).toBeEnabled();
    await submit(d).click();
    await expect.poll(() => s.lib.log.created.length).toBe(6);
    for (const i of s.lib.log.created) expect(i.scheduledAt).toBeNull();
    clean(s);
    await s.close();
  });
});

/* -------------------------------------------------------------------------- keyboard + appearance ----- */

test.describe('dialog accessibility', () => {
  test('Escape closes, the title is the dialog name, accounts are checkboxes reachable by keyboard', async () => {
    const s = await open();
    const d = await schedule(s, [A]);
    await expect(s.page.getByRole('dialog', { name: 'Schedule a post' })).toBeVisible();
    const acc = d.getByTestId('schedule-account').first();
    await acc.focus();
    await expect(acc).toHaveAttribute('role', 'checkbox');
    await expect(acc).toHaveAttribute('aria-checked', 'true');
    await s.page.keyboard.press('Space');
    await expect(acc).toHaveAttribute('aria-checked', 'false');
    await s.page.keyboard.press('Escape');
    await expect(dlg(s.page)).toHaveCount(0);
    clean(s);
    await s.close();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} 1280x720: the dialog fits and scrolls inside (no page overflow)`, async () => {
      const s = await open({ theme, width: 1280, height: 720 });
      const d = await schedule(s, [A, B]);
      const box = await d.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(720);
      expect(box!.width).toBeLessThanOrEqual(1280);
      const r = await d
        .getByTestId('schedule-body')
        .evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
      expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
      clean(s);
      await s.close();
    });
  }
});
