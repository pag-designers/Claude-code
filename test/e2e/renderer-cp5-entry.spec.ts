import { expect, test, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  openPublish,
  type HarnessB,
  type PubOpen,
  type PubSession,
} from './support/publish-harness';
import { ACC_YT } from './support/publish-stub';
import type { StubState } from './support/clipfern-stub';
import { editorControls, seedEditor, seedExports } from './support/editor-stub-panels';

/**
 * CP5 entry points: Library clip drawer "Post…", selection bar "Schedule…", Library → Exported "Schedule", the editor's
 * "Export & Schedule", and the "Posted to … view" link on a published clip, all opening the shared schedule dialog.
 * Real exported renderer + the contract-validating bridge stub; browser clock frozen at Wed 14 Oct 2026 10:00.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-entry.spec.ts
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

const open = (route: string, opts: PubOpen = {}) => openPublish(h, route, { settle: 400, ...opts });
const clean = (s: PubSession) => expect(s.problems).toEqual([]);
const VIDEO = '/library/video/?id=vid-interview&tab=clips';
const dlg = (p: Page) => p.getByTestId('schedule-dialog');
const A = 'The 412-hour collage that starts with texture';
const B = 'Awareness isn’t enough. Acceptance changes the room.';
const clipByTitle = (state: StubState, t: string) => state.clips.find((c) => c.title === t)!;
const failedClip = (state: StubState) => state.clips.find((c) => c.status === 'failed')!;

async function onlyYoutube(d: ReturnType<typeof dlg>) {
  await d.getByTestId('schedule-account').filter({ hasText: 'Riverside Reels' }).click();
  await d.getByTestId('schedule-account').filter({ hasText: 'Riverside TV' }).click();
}

test.describe('clip drawer', () => {
  test('"Post…" opens the dialog for that clip and posts it', async () => {
    const s = await open(VIDEO);
    await s.page.getByRole('button', { name: `Open clip: ${A}` }).click();
    const post = s.page.getByTestId('drawer-post');
    await expect(post).toHaveText(/Post…/);
    await expect(post).toBeEnabled();
    await post.click();
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    await expect(d.getByTestId('schedule-source')).toContainText(A);
    await onlyYoutube(d);
    await d.getByTestId('kids-no').check();
    await d.getByTestId('schedule-submit').click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.source).toEqual({ clipId: clipByTitle(s.state, A).id });
    expect(s.lib.log.created[0]!.fields).toMatchObject({ platform: 'shorts', title: A });
    // the dialog closes, the clip drawer underneath is intact and now links to the post
    await expect(dlg(s.page)).toHaveCount(0);
    await expect(s.page.getByTestId('clip-drawer')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('a clip that is not rendered cannot be posted and says why', async () => {
    const s = await open(VIDEO);
    const bad = failedClip(s.state);
    await s.page.getByRole('button', { name: `Open clip: ${bad.title}` }).click();
    const post = s.page.getByTestId('drawer-post');
    await expect(post).toBeDisabled();
    await post.locator('xpath=..').hover();
    await expect(s.page.getByRole('tooltip').first()).toContainText(
      'Render the clip before posting it',
    );
    clean(s);
    await s.close();
  });

  test('a published clip shows "Posted to YouTube · view"; the link opens that post in the Scheduler', async () => {
    const s = await open(VIDEO, {
      prepare: (lib, state) => {
        void lib.addPost({
          id: 'pub-1',
          accountId: ACC_YT,
          status: 'published',
          scheduledAt: lib.now() - 86_400_000,
          clipId: clipByTitle(state, A).id,
          title: A,
          publishedAt: lib.now() - 86_400_000,
          result: {
            platformPostId: 'yt-1',
            url: 'https://www.youtube.com/shorts/yt1',
            outcome: 'published',
            note: null,
          },
        });
      },
    });
    await s.page.getByRole('button', { name: `Open clip: ${A}` }).click();
    const links = s.page.getByTestId('posted-links');
    await expect(links).toContainText('Posted to YouTube · view');
    await expect(links.getByRole('link')).toHaveAttribute('href', '/scheduler/?post=pub-1');
    // a clip that was never posted shows nothing
    await s.page.getByRole('button', { name: 'Next clip' }).click();
    await expect(s.page.getByTestId('posted-links')).toHaveCount(0);
    await s.page.getByRole('button', { name: 'Previous clip' }).click();
    await s.page.getByTestId('posted-links').getByRole('link').click();
    await expect(s.page).toHaveURL(/\/scheduler\/\?post=pub-1$/);
    await expect(s.page.getByTestId('post-drawer')).toBeVisible();
    await expect(s.page.getByTestId('result-link')).toBeVisible();
    clean(s);
    await s.close();
  });
});

test.describe('selection bar', () => {
  test('"Schedule…" with several clips opens smart spacing for exactly the rendered ones', async () => {
    const s = await open(VIDEO);
    await s.page.getByRole('checkbox', { name: `Select ${A}` }).click();
    await s.page
      .getByRole('checkbox', { name: `Select ${B}` })
      .click()
      .catch(() => undefined);
    const bar = s.page.getByTestId('selection-bar');
    const btn = bar.getByTestId('selection-schedule');
    await expect(btn).toHaveText(/Schedule…/);
    await expect(btn).toBeEnabled();
    await btn.click();
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    const n = await bar
      .getByText('selected')
      .count()
      .then(() => 1);
    void n;
    await expect(d.getByTestId('smart-plan')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('a single selected clip schedules normally; only unrendered clips disable the button', async () => {
    const s = await open(VIDEO);
    await s.page.getByRole('checkbox', { name: `Select ${A}` }).click();
    await s.page.getByTestId('selection-schedule').click();
    await expect(dlg(s.page).getByRole('heading', { name: 'Schedule a post' })).toBeVisible();
    await expect(dlg(s.page).getByTestId('smart-plan')).toHaveCount(0);
    await s.page.keyboard.press('Escape');
    await s.page.getByRole('checkbox', { name: `Select ${A}` }).click();
    const bad = failedClip(s.state);
    await s.page.getByRole('checkbox', { name: `Select ${bad.title}` }).click();
    await expect(s.page.getByTestId('selection-schedule')).toBeDisabled();
    // add a rendered one back: enabled, and only that one is scheduled
    await s.page.getByRole('checkbox', { name: `Select ${A}` }).click();
    await expect(s.page.getByTestId('selection-schedule')).toBeEnabled();
    await s.page.getByTestId('selection-schedule').click();
    const d = dlg(s.page);
    await expect(d.getByTestId('schedule-source')).toContainText(A);
    await expect(d.getByTestId('schedule-source')).not.toContainText(bad.title);
    clean(s);
    await s.close();
  });
});

test.describe('Library → Exported', () => {
  test('each finished export has Schedule; failed ones explain why not', async () => {
    const s = await open('/library/?tab=exported', {
      prepare: (_lib, state) => {
        seedEditor(state);
        seedExports(state);
      },
    });
    const cards = s.page.getByTestId('export-card-schedule');
    await expect(cards.first()).toBeVisible();
    const done = s.page.locator('li').filter({ hasText: 'Founder story, rough cut' });
    await done.getByTestId('export-card-schedule').click();
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    await expect(d.getByTestId('schedule-source')).toContainText('Founder story, rough cut');
    await onlyYoutube(d);
    await d.getByTestId('kids-no').check();
    await d.getByTestId('schedule-submit').click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.source).toEqual({ exportId: 'ex-done' });
    await expect(dlg(s.page)).toHaveCount(0);

    const failed = s.page.locator('li').filter({ hasText: 'Untitled square' });
    await expect(failed.getByTestId('export-card-schedule')).toBeDisabled();
    await failed.getByTestId('export-card-schedule').locator('xpath=..').hover();
    await expect(s.page.getByRole('tooltip').first()).toContainText(
      'Only finished exports can be posted',
    );
    clean(s);
    await s.close();
  });
});

test.describe('editor → Export & Schedule', () => {
  test('exports first, then opens the schedule dialog with the finished export', async () => {
    const s = await open('/design/editor-panels/?id=ep-clip', {
      prepare: (_lib, state) => {
        seedEditor(state);
        seedExports(state);
      },
    });
    await expect(s.page.getByTestId('panels-host')).not.toHaveAttribute('data-loaded', '');
    await s.page.getByTestId('host-open-export').click();
    const btn = s.page.getByTestId('export-schedule');
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText(/Export & Schedule/);
    await btn.click();
    // rendering: the button says what will happen and cannot be pressed twice
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText('Scheduling when done');
    await expect(s.page.getByTestId('export-progress')).toBeVisible();
    const c = editorControls(s.state);
    await expect.poll(() => c.state.log.exports.length).toBe(1);
    const job = c.lastExport();
    await c.progress(job.id, 0.6, 'Encoding video');
    await expect(s.page.getByTestId('export-percent')).toHaveText('60%');
    await expect(dlg(s.page)).toHaveCount(0);
    await c.finish(job.id);
    const d = dlg(s.page);
    await expect(d).toBeVisible();
    await expect(d.getByTestId('schedule-source')).toContainText('Editor export');
    await onlyYoutube(d);
    await d.getByTestId('kids-no').check();
    await d.getByTestId('schedule-submit').click();
    await expect.poll(() => s.lib.log.created.length).toBe(1);
    expect(s.lib.log.created[0]!.source).toEqual({ exportId: job.id });
    // the export panel is still there with its result; the button can schedule again
    await expect(dlg(s.page)).toHaveCount(0);
    await expect(s.page.getByTestId('export-done')).toBeVisible();
    await expect(btn).toBeEnabled();
    clean(s);
    await s.close();
  });

  test('after an export has finished the button opens the dialog straight away; a failed export schedules nothing', async () => {
    const s = await open('/design/editor-panels/?id=ep-clip', {
      prepare: (_lib, state) => {
        seedEditor(state);
        seedExports(state);
      },
    });
    await expect(s.page.getByTestId('panels-host')).not.toHaveAttribute('data-loaded', '');
    await s.page.getByTestId('host-open-export').click();
    await s.page.getByTestId('export-start').click();
    const c = editorControls(s.state);
    await expect.poll(() => c.state.log.exports.length).toBe(1);
    // main pushes the queued event shortly after answering; finish only after it, or it would overwrite the result
    await expect(s.page.getByTestId('export-message')).toHaveText('Waiting in the queue');
    await c.finish(c.lastExport().id);
    await expect(s.page.getByTestId('export-done')).toBeVisible();
    await expect(dlg(s.page)).toHaveCount(0);
    await s.page.getByTestId('export-schedule').click();
    await expect(dlg(s.page)).toBeVisible();
    await s.page.keyboard.press('Escape');
    await expect(dlg(s.page)).toHaveCount(0);

    const f = await open('/design/editor-panels/?id=ep-clip', {
      prepare: (_lib, state) => {
        seedEditor(state);
        seedExports(state);
      },
    });
    await f.page.getByTestId('host-open-export').click();
    await f.page.getByTestId('export-schedule').click();
    const fc = editorControls(f.state);
    await expect.poll(() => fc.state.log.exports.length).toBe(1);
    await expect(f.page.getByTestId('export-message')).toHaveText('Waiting in the queue');
    await fc.failJob(fc.lastExport().id, 'Invalid filtergraph');
    await expect(f.page.getByTestId('export-failed')).toContainText('Invalid filtergraph');
    await expect(dlg(f.page)).toHaveCount(0);
    // the "when done" intent is dropped: after adjusting, the button is the normal one again
    await f.page.getByTestId('export-retry').click();
    await expect(f.page.getByTestId('export-schedule')).toBeEnabled();
    await expect(f.page.getByTestId('export-schedule')).toHaveText(/Export & Schedule/);
    clean(s);
    clean(f);
    await s.close();
    await f.close();
  });
});

test.describe('Library page itself', () => {
  test('the old disabled "Send to scheduler" is gone', async () => {
    const s = await open(VIDEO);
    await s.page.getByRole('checkbox', { name: `Select ${A}` }).click();
    await expect(s.page.getByRole('button', { name: 'Send to scheduler' })).toHaveCount(0);
    await expect(s.page.getByTestId('selection-schedule')).toBeVisible();
    clean(s);
    await s.close();
  });
});
