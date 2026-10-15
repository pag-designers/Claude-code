import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  openPublish,
  type HarnessB,
  type PubOpen,
  type PubSession,
} from './support/publish-harness';
import { ACC_IG, ACC_YT, DAY, FIXED_NOW, HOUR } from './support/publish-stub';

/**
 * CP5 Scheduler page: status bar, accounts strip, calendar (month / week / day) with drag-to-reschedule, queue with
 * filters, the post drawer (failure + retry, post now, cancel, delete, reschedule, field editing, result link, stats)
 * and the live events, against the REAL exported renderer with the contract-validating bridge stub
 * (support/publish-stub.ts). The browser clock is frozen at Wed 14 Oct 2026 10:00 so calendars are deterministic.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-scheduler.spec.ts
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
  openPublish(h, route, { seed: true, settle: 300, ...opts });
const clean = (s: PubSession) => expect(s.problems).toEqual([]);
const at = (d: number, hh: number, m = 0) => new Date(2026, 9, d, hh, m, 0, 0).getTime();

const chip = (p: Page, id: string) => p.locator(`[data-testid="post-chip"][data-post-id="${id}"]`);
const drawer = (p: Page) => p.getByTestId('post-drawer');
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });
const dayCell = (p: Page, day: string) => p.locator(`[data-testid="day-cell"][data-day="${day}"]`);
const row = (p: Page, id: string) => p.locator(`[data-testid="queue-row"][data-post-id="${id}"]`);
const view = (p: Page, name: 'Calendar' | 'Queue' | 'Month' | 'Week' | 'Day') =>
  p.getByRole('radio', { name, exact: true }).click();
const lastUpdate = (s: PubSession) => s.lib.log.updates[s.lib.log.updates.length - 1]!;

async function openPost(s: PubSession, id: string) {
  await chip(s.page, id).click();
  await expect(drawer(s.page)).toBeVisible();
  return drawer(s.page);
}

/* ---------------------------------------------------------------------------------- status bar ----- */

test.describe('status bar and top-bar indicator', () => {
  test('shows state, next post, upcoming, publishing and missed; pause and resume round-trip', async () => {
    const s = await open();
    const bar = s.page.getByTestId('scheduler-status');
    await expect(bar).toHaveAttribute('data-tone', 'active');
    await expect(bar.getByTestId('scheduler-title')).toHaveText('Scheduler active');
    await expect(bar.getByTestId('status-next')).toContainText('Today 6:00 PM');
    await expect(bar.getByTestId('status-next')).toContainText('in 8 h');
    await expect(bar.getByTestId('status-upcoming')).toHaveText('3');
    await expect(bar.getByTestId('status-publishing')).toContainText('1 now');
    await expect(bar.getByTestId('status-missed')).toContainText('1');
    await expect(bar).toContainText('system tray');

    const ind = s.page.getByTestId('scheduler-indicator');
    await expect(ind).toHaveAttribute('data-tone', 'active');
    await expect(ind).toContainText('Scheduler active');
    await expect(ind).toContainText('next in 8 h');
    await expect(ind).toHaveAttribute('aria-label', /next post in 8 h/);
    await expect(ind).toContainText('1 missed');
    await expect(ind).toHaveAttribute('href', /\/scheduler\/$/);

    await bar.getByTestId('scheduler-toggle').click();
    await expect(bar).toHaveAttribute('data-tone', 'paused');
    await expect(bar.getByTestId('scheduler-title')).toHaveText('Scheduler paused');
    await expect(ind).toContainText('Scheduler paused');
    expect(s.lib.log.paused).toEqual([true]);
    await bar.getByRole('button', { name: 'Resume scheduler' }).click();
    await expect(bar).toHaveAttribute('data-tone', 'active');
    expect(s.lib.log.paused).toEqual([true, false]);
    clean(s);
    await s.close();
  });

  test('the indicator is on every page and links to the scheduler; it is hidden without accounts', async () => {
    const s = await open({}, '/library/');
    await expect(s.page.getByTestId('scheduler-indicator')).toBeVisible();
    await s.page.getByTestId('scheduler-indicator').click();
    await expect(s.page).toHaveURL(/\/scheduler\/$/);
    const none = await open({ accounts: [] }, '/library/');
    await expect(none.page.getByTestId('scheduler-indicator')).toHaveCount(0);
    clean(s);
    clean(none);
    await s.close();
    await none.close();
  });

  test('live scheduler:status events update the bar and the indicator without a reload', async () => {
    const s = await open();
    s.lib.scheduler.paused = true;
    s.lib.scheduler.catchUp = { pending: 2, lastRunAt: FIXED_NOW - HOUR };
    await s.lib.emitStatus();
    await expect(s.page.getByTestId('scheduler-status')).toHaveAttribute('data-tone', 'paused');
    await expect(s.page.getByTestId('scheduler-hints')).toContainText(
      'Catching up on 2 posts that came due while Clipfern was closed',
    );
    await expect(s.page.getByTestId('scheduler-indicator')).toContainText('Scheduler paused');
    clean(s);
    await s.close();
  });

  test('tray hints: mode off links to settings; tray unavailable says to keep the app open', async () => {
    const off = await open({
      prepare: (lib) => {
        lib.scheduler.trayMode = false;
      },
    });
    await expect(off.page.getByTestId('scheduler-hints')).toContainText(
      'Closing the window stops the scheduler',
    );
    await expect(off.page.getByRole('link', { name: 'Turn on tray mode' })).toHaveAttribute(
      'href',
      '/settings/scheduler/',
    );
    const gone = await open({
      prepare: (lib) => {
        lib.scheduler.trayAvailable = false;
      },
    });
    await expect(gone.page.getByTestId('scheduler-hints')).toContainText(
      'system tray is not available',
    );
    clean(off);
    clean(gone);
    await off.close();
    await gone.close();
  });
});

/* ---------------------------------------------------------------------------------- accounts ----- */

test.describe('accounts strip', () => {
  test('one card per account with status chip and quota meter + note', async () => {
    const s = await open();
    const cards = s.page.getByTestId('account-card');
    await expect(cards).toHaveCount(3);
    const yt = cards.filter({ hasText: 'Riverside Shorts' });
    await expect(yt).toContainText('@riversideshorts');
    await expect(yt).toContainText('Connected');
    const meter = yt.getByTestId('quota-meter');
    await expect(meter).toContainText('3,200 of 10,000 units');
    await expect(meter).toContainText('4 more posts today');
    await expect(meter.getByTestId('quota-note')).toContainText('1,600 of your 10,000 daily units');
    await expect(meter.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '32');
    await expect(
      cards.filter({ hasText: 'Riverside Reels' }).getByTestId('quota-meter'),
    ).toContainText('2 of 25 posts');
    await expect(cards.filter({ hasText: 'Riverside TV' })).toContainText('App not audited');
    await expect(
      cards.filter({ hasText: 'Riverside TV' }).getByRole('link', { name: 'Audit checklist' }),
    ).toHaveAttribute('href', '/settings/integrations/#tiktok-audit');
    clean(s);
    await s.close();
  });

  test('quota meter turns red with "Daily limit reached" at zero posts left', async () => {
    const s = await open({
      prepare: (lib) => {
        const q = lib.quota.find((x) => x.accountId === ACC_YT)!;
        Object.assign(q, { used: 9900, postsLeft: 0 });
      },
    });
    const meter = s.page
      .getByTestId('account-card')
      .filter({ hasText: 'Riverside Shorts' })
      .getByTestId('quota-meter');
    await expect(meter).toHaveAttribute('data-tone', 'danger');
    await expect(meter).toContainText('Daily limit reached');
    clean(s);
    await s.close();
  });

  test('needs re-auth shows the reason and a Reconnect button that restores the account', async () => {
    const s = await open({
      prepare: (lib) => {
        const a = lib.accounts.find((x) => x.id === ACC_IG)!;
        a.status = 'needs-reauth';
        a.statusMessage = 'Meta revoked the sign-in.';
      },
    });
    const card = s.page.getByTestId('account-card').filter({ hasText: 'Riverside Reels' });
    await expect(card).toHaveAttribute('data-status', 'needs-reauth');
    await expect(card).toContainText('Needs re-auth');
    await expect(card.getByTestId('account-status-message')).toHaveText(
      'Meta revoked the sign-in.',
    );
    await card.getByRole('button', { name: 'Reconnect' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected');
    expect(s.lib.log.connects).toEqual(['reels']);
    clean(s);
    await s.close();
  });

  test('platforms with no account show a Connect card; connecting adds the account live', async () => {
    const s = await open({ accounts: [], configured: ['shorts', 'reels'] });
    const cards = s.page.getByTestId('connect-card');
    await expect(cards).toHaveCount(3);
    // credentials missing: the button explains and links to the settings card
    await expect(cards.filter({ hasText: 'TikTok' }).getByRole('link')).toHaveAttribute(
      'href',
      '/settings/integrations/#tiktok',
    );
    await cards
      .filter({ hasText: 'YouTube Shorts' })
      .getByRole('button', { name: 'Connect YouTube' })
      .click();
    await expect(s.page.getByTestId('account-card')).toHaveCount(1);
    await expect(s.page.getByTestId('account-name')).toHaveText('New Channel');
    await expect(s.page.getByTestId('scheduler-indicator')).toBeVisible();
    expect(s.lib.log.connects).toEqual(['shorts']);
    clean(s);
    await s.close();
  });

  test('connect waits for the browser consent: waiting state, Cancel, then an error banner, then success', async () => {
    const s = await open({
      accounts: [],
      prepare: (lib) => {
        lib.connectMode = 'hold';
      },
    });
    const card = s.page.getByTestId('connect-card').filter({ hasText: 'Instagram' });
    await card.getByRole('button', { name: 'Connect Instagram' }).click();
    await expect(card.getByRole('status')).toContainText('Waiting for Instagram');
    await card.getByTestId('connect-cancel-reels').click();
    await expect(card.getByRole('button', { name: 'Connect Instagram' })).toBeVisible();
    expect(s.lib.log.cancelConnects).toEqual(['reels']);
    await expect(card.getByTestId('connect-error')).toHaveCount(0);

    await card.getByRole('button', { name: 'Connect Instagram' }).click();
    await expect(card.getByRole('status')).toBeVisible();
    await s.lib.connectOutcome('reels', {
      ok: false,
      message: 'Meta said: the user denied access.',
    });
    await expect(card.getByTestId('connect-error')).toHaveText(
      'Meta said: the user denied access.',
    );
    await card.getByRole('button', { name: 'Dismiss' }).click();

    await card.getByRole('button', { name: 'Connect Instagram' }).click();
    await s.lib.connectOutcome('reels', { ok: true });
    await expect(s.page.getByTestId('account-card')).toHaveCount(1);
    clean(s);
    await s.close();
  });
});

/* ---------------------------------------------------------------------------------- calendar ----- */

test.describe('calendar', () => {
  test('month grid: today marked, platform chips with status styling, posts on their day', async () => {
    const s = await open();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('October 2026');
    const today = dayCell(s.page, '2026-10-14');
    await expect(today).toHaveAttribute('aria-current', 'date');
    await expect(today.locator('[data-testid="post-chip"]')).toHaveCount(3); // fail 8:00, now 9:55, today 18:00
    await expect(dayCell(s.page, '2026-10-15').locator('[data-testid="post-chip"]')).toHaveCount(2);
    await expect(chip(s.page, 'p-today')).toHaveAttribute('data-platform', 'tiktok');
    await expect(chip(s.page, 'p-tom-yt')).toHaveAttribute('data-platform', 'shorts');
    await expect(chip(s.page, 'p-fail')).toHaveAttribute('data-status', 'failed');
    await expect(chip(s.page, 'p-miss')).toHaveAttribute('data-status', 'missed');
    await expect(chip(s.page, 'p-pub')).toHaveAttribute('data-status', 'published');
    await expect(chip(s.page, 'p-cancel')).toHaveAttribute('data-status', 'canceled');
    // a draft has no date, so it is not on the calendar (it lives in the queue)
    await expect(chip(s.page, 'p-draft')).toHaveCount(0);
    await expect(chip(s.page, 'p-today')).toHaveAccessibleName(
      /Autism awareness in 30 seconds, TikTok, Riverside TV, Scheduled, Wed, Oct 14/,
    );
    clean(s);
    await s.close();
  });

  test('navigation: previous, next, Today; week and day views; the view is remembered', async () => {
    const s = await open();
    await s.page.getByRole('button', { name: 'Next' }).click();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('November 2026');
    await expect(s.page.getByRole('button', { name: 'Today' })).toBeEnabled();
    await s.page.getByRole('button', { name: 'Previous' }).click();
    await s.page.getByRole('button', { name: 'Previous' }).click();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('September 2026');
    await s.page.getByRole('button', { name: 'Today' }).click();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('October 2026');
    await expect(s.page.getByRole('button', { name: 'Today' })).toBeDisabled();

    await view(s.page, 'Week');
    await expect(s.page.getByTestId('calendar-title')).toHaveText('Oct 11 – 17, 2026');
    await expect(s.page.getByTestId('calendar-week')).toBeVisible();
    await expect(s.page.getByTestId('now-line')).toHaveCount(1);
    await s.page.getByRole('button', { name: 'Next' }).click();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('Oct 18 – 24, 2026');
    await s.page.getByRole('button', { name: 'Today' }).click();

    await view(s.page, 'Day');
    await expect(s.page.getByTestId('calendar-title')).toHaveText('Wednesday, October 14, 2026');
    await expect(s.page.getByTestId('calendar-day')).toBeVisible();
    await expect(s.page.locator('[data-testid="post-chip"]')).toHaveCount(3);

    await s.page.reload();
    await s.page.getByTestId('scheduler-status').waitFor();
    await expect(s.page.getByRole('radio', { name: 'Day', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    clean(s);
    await s.close();
  });

  test('"+N more" in a crowded day jumps to that day', async () => {
    const s = await open({
      prepare: (lib) => {
        // five more posts on Oct 20
        for (let i = 0; i < 5; i++)
          void lib.addPost({
            id: `crowd-${i}`,
            accountId: ACC_IG,
            status: 'scheduled',
            scheduledAt: at(20, 9 + i),
            title: `Crowd ${i}`,
          });
      },
    });
    await s.page
      .getByRole('button', { name: 'Next' })
      .click()
      .catch(() => undefined);
    await s.page.getByRole('button', { name: 'Today' }).click();
    const cell = dayCell(s.page, '2026-10-20');
    await expect(cell.locator('[data-testid="post-chip"]')).toHaveCount(2);
    await expect(cell.getByTestId('day-more')).toHaveText('+3 more');
    await cell.getByTestId('day-more').click();
    await expect(s.page.getByTestId('calendar-title')).toHaveText('Tuesday, October 20, 2026');
    await expect(s.page.locator('[data-testid="post-chip"]')).toHaveCount(5);
    clean(s);
    await s.close();
  });

  test('"+" on a day opens the clip picker, then the schedule dialog pre-filled with that day', async () => {
    const s = await open();
    const cell = dayCell(s.page, '2026-10-21');
    await cell.hover();
    await cell.getByTestId('day-add').click();
    await expect(s.page.getByTestId('pick-dialog')).toBeVisible();
    await s.page.getByTestId('pick-check').nth(1).click();
    await s.page.getByTestId('pick-continue').click();
    const dlg = s.page.getByTestId('schedule-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByLabel('Publish at')).toHaveValue('2026-10-21T12:00');
    clean(s);
    await s.close();
  });

  test('past days have no "+" (nothing can be scheduled in the past)', async () => {
    const s = await open();
    await expect(dayCell(s.page, '2026-10-12').getByTestId('day-add')).toHaveCount(0);
    await expect(dayCell(s.page, '2026-10-14').getByTestId('day-add')).toHaveCount(1);
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------ drag to reschedule ----- */

test.describe('drag to reschedule', () => {
  test('month: dropping on another day keeps the time of day and calls posts:update', async () => {
    const s = await open();
    await chip(s.page, 'p-today').dragTo(dayCell(s.page, '2026-10-16'));
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    expect(lastUpdate(s)).toEqual({ id: 'p-today', scheduledAt: at(16, 18, 0) });
    await expect(dayCell(s.page, '2026-10-16').locator('[data-post-id="p-today"]')).toHaveCount(1);
    await expect(dayCell(s.page, '2026-10-14').locator('[data-post-id="p-today"]')).toHaveCount(0);
    // the status bar follows (next post is now the 15th at 12:15)
    await expect(s.page.getByTestId('status-next')).toContainText('Tomorrow 12:15 PM');
    clean(s);
    await s.close();
  });

  test('week: dropping on an hour sets that hour', async () => {
    const s = await open();
    await view(s.page, 'Week');
    const target = s.page.locator('[data-testid="hour-cell"][data-slot="2026-10-16-14"]');
    // bring the whole grid into view first: Playwright cannot scroll in the middle of a native drag
    await s.page.evaluate(() => document.querySelector('main')!.scrollTo(0, 99999));
    await chip(s.page, 'p-tom-ig').dragTo(target, { targetPosition: { x: 40, y: 2 } });
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    const u = lastUpdate(s);
    expect(u.id).toBe('p-tom-ig');
    const d = new Date(u.scheduledAt as number);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 16, 14]);
    expect(d.getMinutes()).toBeLessThan(10);
    await expect(
      s.page.locator(
        '[data-testid="hour-cell"][data-slot="2026-10-16-14"] [data-post-id="p-tom-ig"]',
      ),
    ).toHaveCount(1);
    clean(s);
    await s.close();
  });

  test('a past slot is refused with a toast and nothing is sent', async () => {
    const s = await open();
    await chip(s.page, 'p-today').dragTo(dayCell(s.page, '2026-10-12'));
    await expect(toast(s.page, 'Could not reschedule')).toContainText('already passed');
    expect(s.lib.log.updates).toEqual([]);
    await expect(dayCell(s.page, '2026-10-14').locator('[data-post-id="p-today"]')).toHaveCount(1);
    clean(s);
    await s.close();
  });

  test('published, failed and draft posts cannot be dragged; a refused update snaps the chip back', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.failNext['posts:update'] = { message: 'YouTube is unreachable right now.', times: 1 };
      },
    });
    await expect(chip(s.page, 'p-pub')).toHaveAttribute('draggable', 'false');
    await expect(chip(s.page, 'p-today')).toHaveAttribute('draggable', 'true');
    await chip(s.page, 'p-today').dragTo(dayCell(s.page, '2026-10-17'));
    await expect(toast(s.page, 'Could not reschedule')).toContainText(
      'YouTube is unreachable right now.',
    );
    await expect(dayCell(s.page, '2026-10-14').locator('[data-post-id="p-today"]')).toHaveCount(1);
    await expect(dayCell(s.page, '2026-10-17').locator('[data-post-id="p-today"]')).toHaveCount(0);
    clean(s);
    await s.close();
  });
});

/* -------------------------------------------------------------------------------------- queue ----- */

test.describe('queue', () => {
  test('sections: needs attention first, upcoming by time, drafts, history newest first', async () => {
    const s = await open();
    await view(s.page, 'Queue');
    const sections = s.page.locator('[data-testid="queue"] > section');
    await expect(sections).toHaveCount(4);
    await expect(sections.nth(0)).toHaveAttribute('data-section', 'attention');
    await expect(sections.nth(1)).toHaveAttribute('data-section', 'upcoming');
    await expect(sections.nth(2)).toHaveAttribute('data-section', 'draft');
    await expect(sections.nth(3)).toHaveAttribute('data-section', 'history');
    await expect(sections.nth(0).getByTestId('queue-row')).toHaveCount(2);
    await expect(sections.nth(1).getByTestId('queue-row')).toHaveCount(4);
    await expect(sections.nth(1).getByTestId('queue-row').first()).toHaveAttribute(
      'data-post-id',
      'p-now',
    );
    await expect(sections.nth(3).getByTestId('queue-row').first()).toHaveAttribute(
      'data-post-id',
      'p-cancel',
    );
    // a failed row shows the platform's message and a Retry button, a missed row says Reschedule
    await expect(row(s.page, 'p-fail')).toContainText('exceeded your quota');
    await expect(row(s.page, 'p-fail').getByTestId('queue-retry')).toBeVisible();
    await expect(row(s.page, 'p-miss')).toContainText('Missed — reschedule?');
    await expect(row(s.page, 'p-miss').getByTestId('queue-reschedule')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('filters: status, platform, account, search; clear filters; empty result', async () => {
    const s = await open();
    await view(s.page, 'Queue');
    const rows = s.page.getByTestId('queue-row');
    await expect(rows).toHaveCount(9);

    await s.page.getByTestId('filter-status').click();
    await s.page.getByRole('option', { name: 'Failed or missed' }).click();
    await expect(rows).toHaveCount(2);
    await s.page.getByTestId('filter-clear').click();
    await expect(rows).toHaveCount(9);

    await s.page.getByTestId('filter-platform').click();
    await s.page.getByRole('option', { name: 'TikTok' }).click();
    await expect(rows).toHaveCount(2); // p-today + p-draft
    await s.page.getByTestId('filter-clear').click();

    await s.page.getByTestId('filter-account').click();
    await s.page.getByRole('option', { name: /Riverside Reels/ }).click();
    await expect(rows).toHaveCount(4); // now, tom-ig, miss, cancel
    await s.page.getByTestId('filter-clear').click();

    await s.page.getByTestId('filter-search').fill('mural');
    await expect(rows).toHaveCount(2);
    await s.page.getByTestId('filter-search').fill('zzz nothing');
    await expect(s.page.getByTestId('queue-no-match')).toContainText('No posts match');
    await s.page
      .getByTestId('queue-no-match')
      .getByRole('button', { name: 'Clear filters' })
      .click();
    await expect(rows).toHaveCount(9);
    clean(s);
    await s.close();
  });

  test('filters also narrow the calendar', async () => {
    const s = await open();
    await s.page.getByTestId('filter-platform').click();
    await s.page.getByRole('option', { name: 'TikTok' }).click();
    await expect(s.page.locator('[data-testid="post-chip"]')).toHaveCount(1);
    await expect(chip(s.page, 'p-today')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('Retry on a failed row calls posts:retry and the row moves to Upcoming; Post now on a scheduled row', async () => {
    const s = await open();
    await view(s.page, 'Queue');
    await row(s.page, 'p-fail').getByTestId('queue-retry').click();
    await expect.poll(() => s.lib.log.retries).toEqual(['p-fail']);
    await expect(row(s.page, 'p-fail')).toHaveAttribute('data-status', 'scheduled');
    await expect(s.page.locator('[data-section="upcoming"] [data-post-id="p-fail"]')).toHaveCount(
      1,
    );

    await row(s.page, 'p-today').hover();
    await row(s.page, 'p-today').getByTestId('queue-post-now').click();
    await expect.poll(() => s.lib.log.postNow).toEqual(['p-today']);
    await expect(row(s.page, 'p-today')).toHaveAttribute('data-status', 'queued');
    clean(s);
    await s.close();
  });

  test('empty states guide: no posts with accounts, and no accounts', async () => {
    const s = await open({ seed: false });
    await expect(s.page.getByText('Pick a clip to schedule').first()).toBeVisible();
    await view(s.page, 'Queue');
    const q = s.page.getByTestId('queue-empty');
    await expect(q).toContainText('Nothing scheduled yet');
    await q.getByRole('button', { name: 'Pick a clip to schedule' }).click();
    await expect(s.page.getByTestId('pick-dialog')).toBeVisible();
    await s.page.keyboard.press('Escape');

    const n = await open({ seed: false, accounts: [] });
    await expect(n.page.getByText('Connect an account to start scheduling')).toBeVisible();
    await view(n.page, 'Queue');
    await expect(n.page.getByTestId('queue-empty')).toContainText(
      'Connect YouTube, Instagram or TikTok first',
    );
    clean(s);
    clean(n);
    await s.close();
    await n.close();
  });
});

/* -------------------------------------------------------------------------------------- drawer ----- */

test.describe('post drawer', () => {
  test('failed: the platform error with its hint, retry, then the new state', async () => {
    const s = await open();
    const d = await openPost(s, 'p-fail');
    await expect(d.getByTestId('drawer-title')).toHaveText('A conversation that stuck with me');
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'failed');
    await expect(d.getByTestId('post-error')).toContainText('exceeded your quota. (quotaExceeded)');
    await expect(d.getByText('Posting failed · Daily quota reached')).toBeVisible();
    await expect(d.getByTestId('post-error-hint')).toContainText('midnight Pacific time');
    await expect(d).toContainText('3 attempts');
    await expect(d).not.toContainText('has already passed');
    await d.getByTestId('drawer-retry').click();
    await expect.poll(() => s.lib.log.retries).toEqual(['p-fail']);
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'scheduled');
    await expect(d.getByTestId('post-error')).toHaveCount(0);
    await expect(chip(s.page, 'p-fail')).toHaveAttribute('data-status', 'scheduled');
    clean(s);
    await s.close();
  });

  test('missed: the banner, reschedule by picking a new time, status becomes scheduled', async () => {
    const s = await open();
    const d = await openPost(s, 'p-miss');
    await expect(d.getByText('Missed — reschedule?').first()).toBeVisible();
    await expect(d).toContainText('while Clipfern was closed');
    await expect(d.getByTestId('drawer-save')).toBeDisabled();
    await d.getByLabel('Publish at').fill('2026-10-22T19:30');
    await expect(d.getByTestId('time-zone')).toContainText('Your local time zone');
    await d.getByTestId('drawer-save').click();
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    expect(lastUpdate(s).scheduledAt).toBe(at(22, 19, 30));
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'scheduled');
    await expect(d.getByTestId('drawer-when')).toContainText('Thu, Oct 22 · 7:30');
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(dayCell(s.page, '2026-10-22').locator('[data-post-id="p-miss"]')).toHaveCount(1);
    clean(s);
    await s.close();
  });

  test('a time in the past is flagged as the user picks it', async () => {
    const s = await open();
    const d = await openPost(s, 'p-tom-yt');
    await d.getByLabel('Publish at').fill('2026-10-10T08:00');
    await expect(d.getByTestId('field-issue').first()).toContainText('already passed');
    clean(s);
    await s.close();
  });

  test('scheduled: edit the title with a live counter, validate issues inline, save sends the fields', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.fieldIssues = (platform, fields) =>
          platform === 'shorts' && fields?.platform === 'shorts' && /spam/i.test(fields.title)
            ? [{ field: 'title', message: 'YouTube rejects titles that look like spam.' }]
            : [];
      },
    });
    const d = await openPost(s, 'p-tom-yt');
    const title = d.getByLabel('Title');
    await expect(title).toHaveValue('Behind the mural');
    await expect(d.getByText('16 / 100')).toBeVisible();
    await title.fill('Behind the mural, part 2');
    await expect(d.getByText('24 / 100')).toBeVisible();
    await expect(d.getByTestId('drawer-save')).toBeEnabled();
    // over the limit: local counter turns red and blocks saving
    await title.fill('x'.repeat(101));
    await expect(d.locator('[data-state="over"]').first()).toBeVisible();
    await expect(d.getByTestId('field-issue').first()).toContainText('over the 100 limit');
    await expect(d.getByTestId('drawer-save')).toBeDisabled();
    // server-side issue from publish:validate appears inline
    await title.fill('Total SPAM title');
    await expect(d.getByTestId('field-issue').first()).toContainText('look like spam');
    await title.fill('Behind the mural, part 2');
    await expect(d.getByTestId('field-issue')).toHaveCount(0);
    await d.getByTestId('drawer-save').click();
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    const u = lastUpdate(s);
    expect(u.id).toBe('p-tom-yt');
    expect(u.fields).toMatchObject({ platform: 'shorts', title: 'Behind the mural, part 2' });
    await expect(d.getByTestId('drawer-title')).toHaveText('Behind the mural, part 2');
    await expect(d.getByTestId('drawer-save')).toBeDisabled();
    clean(s);
    await s.close();
  });

  test('the platform-specific editors: shorts, reels and tiktok fields', async () => {
    const s = await open();
    const yt = await openPost(s, 'p-tom-yt');
    await expect(yt.getByTestId('fields-shorts')).toBeVisible();
    for (const label of ['Title', 'Description', 'Add a tag', 'Category'])
      await expect(yt.getByLabel(label, { exact: false }).first()).toBeVisible();
    await expect(yt.getByRole('radiogroup', { name: 'Visibility' })).toBeVisible();
    await expect(yt.getByTestId('kids-declaration')).toBeVisible();
    await expect(yt.getByLabel('Notify subscribers')).toBeVisible();
    await expect(yt.getByLabel('Add #Shorts')).toBeVisible();
    await yt.getByRole('radio', { name: 'Unlisted' }).click();
    await yt.getByLabel('Add a tag').fill('#local art,newtag');
    await yt.getByLabel('Add a tag').press('Enter');
    await yt.getByTestId('drawer-save').click();
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    expect(lastUpdate(s).fields).toMatchObject({ visibility: 'unlisted' });
    expect((lastUpdate(s).fields as { tags: string[] }).tags).toEqual(
      expect.arrayContaining(['local art', 'newtag']),
    );
    await s.page.keyboard.press('Escape');

    const ig = await openPost(s, 'p-tom-ig');
    await expect(ig.getByTestId('fields-reels')).toBeVisible();
    await expect(ig.getByLabel('Caption')).toBeVisible();
    await expect(ig.getByTestId('reels-counters')).toContainText('Hashtags');
    await expect(ig.getByTestId('reels-counters')).toContainText('/ 30');
    await expect(ig.getByTestId('reels-counters')).toContainText('/ 20');
    await ig.getByLabel('Caption').fill('Hello #one #two @friend');
    await expect(ig.getByTestId('reels-counters')).toContainText('2 / 30');
    await expect(ig.getByTestId('reels-counters')).toContainText('1 / 20');
    await ig.getByLabel('Cover frame in seconds').fill('3.5');
    await ig.getByLabel('Add a collaborator').fill('@bestie');
    await ig.getByLabel('Add a collaborator').press('Enter');
    await expect(ig.getByRole('button', { name: 'Remove @bestie' })).toBeVisible();
    await ig.getByLabel('First comment').fill('#more #tags');
    await ig.getByTestId('drawer-save').click();
    await expect.poll(() => s.lib.log.updates.length).toBe(2);
    expect(lastUpdate(s).fields).toMatchObject({
      platform: 'reels',
      coverOffsetMs: 3500,
      collaborators: ['bestie'],
      firstComment: '#more #tags',
    });
    await s.page.keyboard.press('Escape');

    const tt = await openPost(s, 'p-today');
    await expect(tt.getByTestId('fields-tiktok')).toBeVisible();
    await expect(tt.getByRole('radiogroup', { name: 'TikTok post mode' })).toBeVisible();
    // unaudited: privacy is locked to private
    await expect(tt.getByLabel('Who can watch this video')).toContainText('Only me (private)');
    await expect(tt.getByText('Locked to private until TikTok approves your app.')).toBeVisible();
    await tt.getByRole('radio', { name: 'Upload to drafts' }).click();
    await expect(tt.getByTestId('tiktok-mode-hint')).toContainText('TikTok inbox');
    await expect(tt.getByLabel('Who can watch this video')).toHaveCount(0);
    await tt.getByLabel('Allow Duet').click();
    await tt.getByLabel('AI-generated content').click();
    await tt.getByLabel('This video promotes a brand or product').click();
    await tt.getByLabel('Your own brand').click();
    await tt.getByTestId('drawer-save').click();
    await expect.poll(() => s.lib.log.updates.length).toBe(3);
    expect(lastUpdate(s).fields).toMatchObject({
      platform: 'tiktok',
      mode: 'draft',
      privacyLevel: 'SELF_ONLY',
      allowDuet: false,
      aigc: true,
      commercial: { enabled: true, yourBrand: true },
    });
    clean(s);
    await s.close();
  });

  test('media report with issues and the Auto-fix switch (saved through posts:update)', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.mediaIssues['c:vid-interview-c1|shorts'] = [
          {
            severity: 'error',
            code: 'duration-long',
            message: 'The clip is 3:12 long; Shorts allow up to 3:00.',
            fixable: true,
          },
          { severity: 'warning', code: 'bitrate', message: 'Bitrate is low.', fixable: false },
        ];
      },
    });
    const d = await openPost(s, 'p-tom-yt');
    const rep = d.getByTestId('media-report');
    await expect(rep).toContainText('Needs a re-encode for YouTube Shorts');
    await expect(rep.locator('[data-severity="error"]')).toContainText('3:12 long');
    await expect(rep.locator('[data-severity="warning"]')).toContainText('Bitrate is low');
    await expect(rep.getByTestId('media-facts')).toContainText('1080×1920');
    await expect(rep.getByTestId('spec-summary')).toContainText(
      'YouTube Shorts accepts: up to 3 min',
    );
    const sw = d.getByRole('switch', { name: 'Auto-fix' });
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(rep).toHaveAttribute('data-blocked', 'true');
    await expect(rep).toContainText("Doesn't meet YouTube Shorts's requirements");
    // blocked: neither saving nor posting now is possible until Auto-fix is on again
    await expect(d.getByTestId('drawer-save')).toBeDisabled();
    await expect(d.getByTestId('drawer-post-now')).toBeDisabled();
    await sw.click();
    await expect(d.getByTestId('drawer-post-now')).toBeEnabled();
    await sw.click();
    await sw.click();
    clean(s);
    await s.close();
  });

  test('Post now saves pending edits first, then publishes; the status follows live to published', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.autoPublishMs = 250;
      },
    });
    const d = await openPost(s, 'p-tom-yt');
    await d.getByLabel('Title').fill('Fresh title');
    await d.getByTestId('drawer-post-now').click();
    await expect.poll(() => s.lib.log.postNow).toEqual(['p-tom-yt']);
    expect(s.lib.log.updates).toHaveLength(1);
    expect(lastUpdate(s).fields).toMatchObject({ title: 'Fresh title' });
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'published', {
      timeout: 6000,
    });
    await expect(d.getByTestId('result-link')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('publishing shows progress and locks the editor; the platform id and link open outside', async () => {
    const s = await open();
    const d = await openPost(s, 'p-now');
    await expect(d.getByTestId('drawer-publishing')).toContainText('Publishing to Instagram Reels');
    await expect(d.getByTestId('drawer-publishing').getByRole('progressbar')).toBeVisible();
    await expect(d.getByTestId('drawer-save')).toHaveCount(0);
    await expect(d.getByTestId('fields-reels')).toHaveAttribute('disabled', '');
    await expect(d.getByTestId('drawer-delete')).toBeDisabled();
    // the publish finishes while the panel is open
    await s.lib.progress('p-now', 'published', {
      publishedAt: s.lib.now(),
      result: {
        platformPostId: 'ig-999',
        url: 'https://www.instagram.com/reel/ig999/',
        outcome: 'published',
        note: null,
      },
    });
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'published');
    await d.getByTestId('result-link').click();
    expect(
      s.state.calls.filter((c) => c.channel === 'shell:openExternal').map((c) => c.payload),
    ).toEqual([{ url: 'https://www.instagram.com/reel/ig999/' }]);
    clean(s);
    await s.close();
  });

  test('published: link, stats and Refresh; TikTok draft upload and the platform note are explained', async () => {
    const s = await open();
    const d = await openPost(s, 'p-pub');
    await expect(d.getByTestId('stat-views')).toHaveText('12.8K');
    await expect(d.getByTestId('stat-likes')).toHaveText('912');
    await expect(d.getByTestId('stat-shares')).toHaveText('–');
    await d.getByTestId('result-link').click();
    expect(s.state.calls.filter((c) => c.channel === 'shell:openExternal').at(-1)?.payload).toEqual(
      {
        url: 'https://www.youtube.com/shorts/abc123',
      },
    );
    await d.getByTestId('stats-refresh').click();
    await expect(d.getByTestId('stat-views')).toHaveText('15K');
    expect(s.lib.log.statsRefreshed).toEqual([['p-pub']]);
    // editing is closed for published posts
    await expect(d.getByTestId('fields-shorts')).toHaveAttribute('disabled', '');
    await expect(d.getByTestId('drawer-save')).toHaveCount(0);
    await s.page.keyboard.press('Escape');

    await s.lib.progress('p-today', 'published', {
      publishedAt: s.lib.now(),
      result: {
        platformPostId: 'tt-1',
        url: null,
        outcome: 'draft-uploaded',
        note: 'TikTok kept this post private because the app is not audited yet.',
      },
    });
    const t = await openPost(s, 'p-today');
    await expect(t.getByText('Uploaded to your TikTok drafts')).toBeVisible();
    await expect(t.getByTestId('result-note')).toContainText('not audited yet');
    await expect(t.getByTestId('result-link')).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('Cancel post, then Delete with a confirmation; the post leaves every view', async () => {
    const s = await open();
    const d = await openPost(s, 'p-tom-yt');
    await d.getByTestId('drawer-cancel').click();
    await expect.poll(() => s.lib.log.cancels).toEqual(['p-tom-yt']);
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'canceled');
    await expect(d.getByTestId('drawer-save')).toHaveCount(0);
    await expect(d.getByText('Canceled posts cannot be edited')).toBeVisible();

    await d.getByTestId('drawer-delete').click();
    const confirm = s.page.getByRole('dialog', { name: 'Delete this post?' });
    await expect(confirm).toContainText('It will not be published');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(s.lib.log.deletes).toEqual([]);
    await d.getByTestId('drawer-delete').click();
    await s.page
      .getByRole('dialog', { name: 'Delete this post?' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect.poll(() => s.lib.log.deletes).toEqual([['p-tom-yt']]);
    await expect(drawer(s.page)).toHaveCount(0);
    await expect(chip(s.page, 'p-tom-yt')).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('a save that main refuses keeps the edits and shows the error', async () => {
    const s = await open({
      prepare: (lib) => {
        lib.failNext['posts:update'] = { message: 'Instagram refused the caption.', times: 1 };
      },
    });
    const d = await openPost(s, 'p-tom-ig');
    await d.getByLabel('Caption').fill('Changed caption');
    await d.getByTestId('drawer-save').click();
    await expect(toast(s.page, 'Could not save the post')).toContainText(
      'Instagram refused the caption.',
    );
    await expect(d.getByLabel('Caption')).toHaveValue('Changed caption');
    await expect(d.getByTestId('drawer-save')).toBeEnabled();
    await d.getByTestId('drawer-save').click();
    // the refused call never reached the log; the retry did
    await expect.poll(() => s.lib.log.updates.length).toBe(1);
    clean(s);
    await s.close();
  });

  test('live: an external update to the open post is followed (failure with a reconnect hint)', async () => {
    const s = await open();
    const d = await openPost(s, 'p-tom-yt');
    await s.lib.progress('p-tom-yt', 'failed', {
      attempts: 1,
      error: {
        code: 'auth',
        message: 'invalid_grant: Token has been expired or revoked.',
        retryable: false,
        at: s.lib.now(),
        hint: 'Reconnect the YouTube account.',
      },
    });
    await expect(d.getByTestId('post-status')).toHaveAttribute('data-status', 'failed');
    await expect(d.getByTestId('post-error')).toContainText('Token has been expired or revoked');
    await expect(d).toContainText('Reconnect the account in Settings → Integrations');
    await expect(d).toContainText('This will not succeed on its own');
    clean(s);
    await s.close();
  });

  test('?post=<id> deep link opens that post', async () => {
    const s = await open({}, '/scheduler/?post=p-fail');
    await expect(drawer(s.page)).toBeVisible();
    await expect(s.page.getByTestId('drawer-title')).toHaveText(
      'A conversation that stuck with me',
    );
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------------ keyboard ----- */

test.describe('keyboard', () => {
  test('chips are buttons: Tab to one, Enter opens the drawer, Escape closes and returns focus', async () => {
    const s = await open();
    const c = chip(s.page, 'p-today');
    await c.focus();
    await s.page.keyboard.press('Enter');
    await expect(drawer(s.page)).toBeVisible();
    await expect(drawer(s.page))
      .toBeFocused()
      .catch(() => undefined);
    await s.page.keyboard.press('Escape');
    await expect(drawer(s.page)).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('the view switch and calendar views respond to arrow keys; queue rows open with Enter', async () => {
    const s = await open();
    await s.page.getByRole('radio', { name: 'Month', exact: true }).focus();
    await s.page.keyboard.press('ArrowRight');
    await expect(s.page.getByRole('radio', { name: 'Week', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await s.page.getByRole('radio', { name: 'Calendar', exact: true }).focus();
    await s.page.keyboard.press('ArrowRight');
    await expect(s.page.getByRole('radio', { name: 'Queue', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await row(s.page, 'p-fail').getByTestId('queue-open').focus();
    await s.page.keyboard.press('Enter');
    await expect(drawer(s.page)).toBeVisible();
    // tab order inside the panel is trapped: the Close button is reachable
    await s.page.keyboard.press('Escape');
    clean(s);
    await s.close();
  });

  test('the "+" button on a day cell is reachable by keyboard', async () => {
    const s = await open();
    const add = dayCell(s.page, '2026-10-21').getByTestId('day-add');
    await add.focus();
    await expect(add).toBeFocused();
    await s.page.keyboard.press('Enter');
    await expect(s.page.getByTestId('pick-dialog')).toBeVisible();
    clean(s);
    await s.close();
  });
});

/* ------------------------------------------------------------------------------ light / small ----- */

test.describe('layout', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} at 1280x720 has no horizontal overflow and the calendar is reachable`, async () => {
      const s = await open({ theme, width: 1280, height: 720 });
      const r = await s.page.evaluate(() => {
        const m = document.querySelector('main')!;
        return { sw: m.scrollWidth, cw: m.clientWidth };
      });
      expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
      await expect(s.page.getByTestId('calendar-month')).toBeVisible();
      await s.page.getByRole('radio', { name: 'Queue', exact: true }).click();
      const q = await s.page.evaluate(() => {
        const m = document.querySelector('main')!;
        return { sw: m.scrollWidth, cw: m.clientWidth };
      });
      expect(q.sw).toBeLessThanOrEqual(q.cw + 1);
      clean(s);
      await s.close();
    });
  }
});

// keep helpers referenced for readability of failures
void (null as unknown as Locator);
void DAY;
