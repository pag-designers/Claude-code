import { expect, test, type Page } from '@playwright/test';
import {
  canRunB,
  createHarnessB,
  openPublish,
  type HarnessB,
  type PubOpen,
  type PubSession,
} from './support/publish-harness';
import { ACC_IG, ACC_TT, ACC_YT } from './support/publish-stub';

/**
 * CP5 Settings: Integrations (redirect URI + copy, connect flow with waiting/cancel/error, test connection, disconnect,
 * re-connect, TikTok audit checklist, YouTube quota explainer) and the new Scheduler section (tray mode, catch-up
 * window, smart-spacing gap and cap, digest, auto-fix) against the REAL exported renderer with the contract-validating
 * bridge stub; browser clock frozen at Wed 14 Oct 2026 10:00.
 *   CP2B_OUT=<export dir> npx playwright test test/e2e/renderer-cp5-settings.spec.ts
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

const open = (route: string, opts: PubOpen = {}) =>
  openPublish(h, route, { settle: 300, seed: true, ...opts });
const clean = (s: PubSession) => expect(s.problems).toEqual([]);
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });
const INTEGRATIONS = '/settings/integrations/';
const SCHEDULER = '/settings/scheduler/';
const card = (p: Page, id: 'youtube' | 'instagram' | 'tiktok') => p.locator(`#${id}`);
const acct = (p: Page, id: string) =>
  p.locator(`[data-testid="settings-account"][data-account-id="${id}"]`);
const external = (s: PubSession) =>
  s.state.calls
    .filter((c) => c.channel === 'shell:openExternal')
    .map((c) => (c.payload as { url: string }).url);

/* ------------------------------------------------------------------------------------ nav ----- */

test('Settings has a Scheduler section next to Integrations', async () => {
  const s = await open(INTEGRATIONS);
  const nav = s.page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link')).toContainText([
    'General',
    'API Keys',
    'Storage',
    'Models & Budget',
    'Compute',
    'Ingest',
    'Integrations',
    'Scheduler',
  ]);
  await nav.getByRole('link', { name: 'Scheduler' }).click();
  await expect(s.page).toHaveURL(/\/settings\/scheduler\/$/);
  await expect(s.page.getByRole('heading', { name: 'Scheduler', level: 1 })).toBeVisible();
  clean(s);
  await s.close();
});

/* ------------------------------------------------------------------------------ integrations ----- */

test.describe('integrations: redirect URI and accounts', () => {
  test('the exact redirect URI per platform with a copy button; guides and secret inputs are kept', async () => {
    const s = await open(INTEGRATIONS);
    for (const [id, platform, path] of [
      ['youtube', 'shorts', 'youtube'],
      ['instagram', 'reels', 'instagram'],
      ['tiktok', 'tiktok', 'tiktok'],
    ] as const) {
      const c = card(s.page, id);
      const uri = `http://127.0.0.1:53682/oauth/${path}/callback`;
      await expect(c.getByTestId('redirect-uri')).toHaveText(uri);
      await c.getByTestId('redirect-copy').click();
      await expect(c.getByTestId('redirect-copy')).toHaveText(/Copied/);
      expect(await s.page.evaluate(() => navigator.clipboard.readText())).toBe(uri);
      await expect(c.getByText('Step-by-step setup guide')).toBeVisible();
      void platform;
    }
    await expect(card(s.page, 'youtube').getByText('Client ID')).toBeVisible();
    await expect(card(s.page, 'instagram').getByText('App secret')).toBeVisible();
    await expect(card(s.page, 'tiktok').getByText('Client key')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('connected accounts: name, handle, status, scheduled posts that will go there', async () => {
    const s = await open(INTEGRATIONS);
    const yt = acct(s.page, ACC_YT);
    await expect(yt).toContainText('Riverside Shorts');
    await expect(yt).toContainText('@riversideshorts');
    await expect(yt).toContainText('Connected');
    await expect(yt).toContainText('1 scheduled post will go to this account');
    await expect(yt.getByTestId('quota-meter')).toContainText('3,200 of 10,000 units');
    await expect(acct(s.page, ACC_TT)).toContainText('unaudited app');
    await expect(card(s.page, 'youtube').getByText('Connected accounts')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('Test connection: success, platform failure with detail, and a thrown error', async () => {
    const s = await open(INTEGRATIONS, {
      prepare: (lib) => {
        lib.testResult[ACC_IG] = {
          ok: false,
          message: 'Instagram rejected the token (error 190).',
          detail: 'The user changed their password.',
        };
      },
    });
    await acct(s.page, ACC_YT).getByTestId('account-test').click();
    const ok = acct(s.page, ACC_YT).getByTestId('account-test-result');
    await expect(ok).toHaveAttribute('data-ok', 'true');
    await expect(ok).toContainText('Signed in as Riverside Shorts.');
    await acct(s.page, ACC_IG).getByTestId('account-test').click();
    const bad = acct(s.page, ACC_IG).getByTestId('account-test-result');
    await expect(bad).toHaveAttribute('data-ok', 'false');
    await expect(bad).toContainText('Instagram rejected the token (error 190).');
    await expect(bad).toContainText('The user changed their password.');
    s.lib.failNext['accounts:test'] = { message: 'No network.', times: 1 };
    await acct(s.page, ACC_TT).getByTestId('account-test').click();
    await expect(acct(s.page, ACC_TT).getByTestId('account-test-result')).toContainText(
      'No network.',
    );
    // the third call was refused before it reached the log
    expect(s.lib.log.tests).toEqual([ACC_YT, ACC_IG]);
    clean(s);
    await s.close();
  });

  test('Disconnect asks first and says scheduled posts become drafts; confirming turns them into drafts', async () => {
    const s = await open(INTEGRATIONS);
    await acct(s.page, ACC_YT).getByTestId('account-disconnect').click();
    const dlg = s.page.getByRole('dialog', { name: 'Disconnect Riverside Shorts?' });
    await expect(dlg).toContainText('1 scheduled post becomes a draft');
    await expect(dlg).toContainText('revokes access at YouTube');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(s.lib.log.disconnects).toEqual([]);
    await acct(s.page, ACC_YT).getByTestId('account-disconnect').click();
    await s.page
      .getByRole('dialog', { name: 'Disconnect Riverside Shorts?' })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await expect.poll(() => s.lib.log.disconnects).toEqual([ACC_YT]);
    await expect(acct(s.page, ACC_YT)).toHaveCount(0);
    await expect(card(s.page, 'youtube').getByTestId('no-accounts')).toContainText(
      'No YouTube Shorts account connected yet',
    );
    expect(s.lib.post('p-tom-yt').status).toBe('draft');
    await expect(toast(s.page, 'Disconnected Riverside Shorts')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('a failed disconnect is reported and the account stays', async () => {
    const s = await open(INTEGRATIONS, {
      prepare: (lib) => {
        lib.failNext['accounts:disconnect'] = {
          message: 'Could not reach Google to revoke the token.',
          times: 1,
        };
      },
    });
    await acct(s.page, ACC_YT).getByTestId('account-disconnect').click();
    await s.page
      .getByRole('dialog', { name: 'Disconnect Riverside Shorts?' })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await expect(toast(s.page, 'Could not disconnect')).toContainText('Could not reach Google');
    await expect(acct(s.page, ACC_YT)).toBeVisible();
    clean(s);
    await s.close();
  });

  test('needs re-auth: status message and a Reconnect button that restores the account', async () => {
    const s = await open(INTEGRATIONS, {
      prepare: (lib) => {
        const a = lib.accounts.find((x) => x.id === ACC_YT)!;
        a.status = 'needs-reauth';
        a.statusMessage = 'Google revoked the refresh token.';
      },
    });
    const yt = acct(s.page, ACC_YT);
    await expect(yt).toHaveAttribute('data-status', 'needs-reauth');
    await expect(yt.getByTestId('account-status-message')).toHaveText(
      'Google revoked the refresh token.',
    );
    await yt.getByRole('button', { name: 'Reconnect' }).click();
    await expect(yt).toHaveAttribute('data-status', 'connected');
    await expect(yt.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    expect(s.lib.log.connects).toEqual(['shorts']);
    clean(s);
    await s.close();
  });
});

test.describe('integrations: connect flow', () => {
  test('instant connect adds the account; a second one can be added', async () => {
    const s = await open(INTEGRATIONS, { accounts: [], seed: false });
    const c = card(s.page, 'youtube');
    await expect(c.getByTestId('no-accounts')).toBeVisible();
    await c.getByTestId('connect-btn-shorts').click();
    await expect(c.getByTestId('settings-account')).toHaveCount(1);
    await expect(c.getByTestId('connect-btn-shorts')).toHaveText(/Connect another account/);
    await c.getByTestId('connect-btn-shorts').click();
    await expect(c.getByTestId('settings-account')).toHaveCount(2);
    clean(s);
    await s.close();
  });

  test('waits for the browser consent with Cancel; denial is shown in plain words; then it works', async () => {
    const s = await open(INTEGRATIONS, {
      accounts: [],
      seed: false,
      prepare: (lib) => {
        lib.connectMode = 'hold';
      },
    });
    const c = card(s.page, 'tiktok');
    await c.getByTestId('connect-btn-tiktok').click();
    const wait = c.getByRole('status').filter({ hasText: 'Waiting for TikTok' });
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('browser window');
    await expect(c.getByTestId('connect-btn-tiktok')).toHaveCount(0);
    await c.getByTestId('connect-cancel-tiktok').click();
    await expect(c.getByTestId('connect-btn-tiktok')).toBeVisible();
    expect(s.lib.log.cancelConnects).toEqual(['tiktok']);
    await expect(c.getByTestId('connect-error')).toHaveCount(0);

    await c.getByTestId('connect-btn-tiktok').click();
    await s.lib.connectOutcome('tiktok', {
      ok: false,
      message: 'TikTok did not approve the request: access_denied.',
    });
    await expect(c.getByTestId('connect-error')).toHaveText(
      'TikTok did not approve the request: access_denied.',
    );
    await expect(c.getByTestId('connect-tiktok').getByRole('alert')).toContainText(
      'Could not connect TikTok',
    );
    await c.getByTestId('connect-btn-tiktok').click();
    await s.lib.connectOutcome('tiktok', { ok: true });
    await expect(c.getByTestId('settings-account')).toHaveCount(1);
    await expect(c.getByTestId('connect-error')).toHaveCount(0);
    clean(s);
    await s.close();
  });

  test('without saved credentials the button explains and points at the credential fields', async () => {
    const s = await open(INTEGRATIONS, { accounts: [], seed: false, configured: ['reels'] });
    const c = card(s.page, 'youtube');
    await expect(c.getByTestId('no-accounts')).toContainText('Save the credentials above first');
    await expect(c.getByRole('link', { name: 'Add YouTube credentials first' })).toHaveAttribute(
      'href',
      '/settings/integrations/#youtube',
    );
    await expect(card(s.page, 'instagram').getByTestId('connect-btn-reels')).toBeVisible();
    expect(s.lib.log.connects).toEqual([]);
    clean(s);
    await s.close();
  });

  test('a refused connect (stub error) is shown inline', async () => {
    const s = await open(INTEGRATIONS, {
      accounts: [],
      seed: false,
      prepare: (lib) => {
        lib.failNext['accounts:connect'] = {
          message: 'The browser could not be opened.',
          times: 1,
        };
      },
    });
    const c = card(s.page, 'instagram');
    await c.getByTestId('connect-btn-reels').click();
    await expect(c.getByTestId('connect-error')).toHaveText('The browser could not be opened.');
    clean(s);
    await s.close();
  });
});

test.describe('integrations: explainers', () => {
  test('TikTok audit checklist: steps, tick-off progress remembered, links open outside, deep link lands on it', async () => {
    const s = await open(INTEGRATIONS + '#tiktok-audit');
    const list = s.page.getByTestId('tiktok-audit');
    await expect(list).toBeVisible();
    await expect(list).toBeInViewport();
    await expect(list.getByRole('heading', { name: 'TikTok audit checklist' })).toBeVisible();
    await expect(list.getByTestId('audit-check')).toHaveCount(8);
    for (const t of [
      'Fill in the app details',
      'privacy policy and terms of service',
      'Login Kit and Content Posting API',
      'Justify each scope',
      'Register the redirect URI',
      'Record a demo video',
      'Submit the app for review',
      'After approval',
    ])
      await expect(list).toContainText(t);
    await expect(list).toContainText('privacy policy');
    await expect(list).toContainText('free');
    await expect(list.getByTestId('audit-progress')).toHaveText('0% done');
    await list.getByRole('checkbox', { name: 'Fill in the app details' }).click();
    await list.getByRole('checkbox', { name: 'Record a demo video of the whole flow' }).click();
    await expect(list.getByTestId('audit-progress')).toHaveText('25% done');
    await s.page.reload();
    await s.page.getByTestId('tiktok-audit').waitFor();
    await expect(s.page.getByTestId('audit-progress')).toHaveText('25% done');
    await expect(s.page.getByRole('checkbox', { name: 'Fill in the app details' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await s.page
      .getByTestId('tiktok-audit')
      .getByRole('button', { name: /Content Sharing Guidelines/ })
      .click();
    expect(external(s)).toEqual(['https://developers.tiktok.com/doc/content-sharing-guidelines']);
    await expect(s.page.getByTestId('tiktok-audit')).toContainText('Upload to drafts');
    clean(s);
    await s.close();
  });

  test('YouTube quota explainer: 10,000 units, ~1,600 per upload, live meter, how to ask for more', async () => {
    const s = await open(INTEGRATIONS);
    const q = s.page.getByTestId('youtube-quota');
    await expect(q).toContainText('10,000 units a day');
    await expect(q).toContainText('≈ 1,600 units');
    await expect(q).toContainText('roughly 6 Shorts a day');
    await expect(q).toContainText('Midnight Pacific time');
    await expect(q.getByTestId('quota-meter')).toContainText('3,200 of 10,000 units');
    await expect(q).toContainText('Need more than 6 a day? Ask Google, it is free.');
    await expect(q).toContainText('Audit and Quota Extension');
    await expect(q).toContainText('If your Shorts upload as private');
    await q.getByRole('button', { name: /YouTube API docs/ }).click();
    expect(external(s)).toEqual([
      'https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits',
    ]);
    clean(s);
    await s.close();
  });

  test('both explainers render without any account (no meter, still readable)', async () => {
    const s = await open(INTEGRATIONS, { accounts: [], seed: false });
    await expect(s.page.getByTestId('youtube-quota')).toContainText('10,000 units a day');
    await expect(s.page.getByTestId('youtube-quota').getByTestId('quota-meter')).toHaveCount(0);
    await expect(s.page.getByTestId('tiktok-audit')).toBeVisible();
    clean(s);
    await s.close();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} 1280x720: no horizontal overflow on Integrations and Scheduler settings`, async () => {
      const s = await open(INTEGRATIONS, { theme, width: 1280, height: 720 });
      for (const route of [INTEGRATIONS, SCHEDULER]) {
        await s.page.goto(new URL(route, s.page.url()).toString());
        await s.page.getByRole('navigation', { name: 'Settings sections' }).waitFor();
        await s.page.waitForTimeout(300);
        const r = await s.page.evaluate(() => {
          const m = document.querySelector('main')!;
          return { sw: m.scrollWidth, cw: m.clientWidth };
        });
        expect(r.sw, route).toBeLessThanOrEqual(r.cw + 1);
      }
      clean(s);
      await s.close();
    });
  }
});

/* ----------------------------------------------------------------------------- scheduler settings ----- */

test.describe('settings → scheduler', () => {
  test('shows the stored values and writes every change through settings:set', async () => {
    const s = await open(SCHEDULER);
    const p = s.page;
    await expect(p.getByLabel('Keep running in the system tray')).toBeChecked();
    await expect(p.getByTestId('grace')).toContainText('2 hours');
    await expect(p.getByTestId('min-gap')).toContainText('3 hours');
    await expect(p.getByTestId('max-per-day')).toContainText('3 a day');
    await expect(p.getByLabel('Auto-fix media')).toBeChecked();
    await expect(p.getByLabel('Daily digest')).toBeChecked();
    await expect(p.getByTestId('digest-hour')).toContainText('8:00 AM');

    await p.getByLabel('Keep running in the system tray').click();
    await expect.poll(() => s.state.settings.schedulerTrayMode).toBe(false);
    await p.getByTestId('grace').click();
    await p.getByRole('option', { name: '30 minutes' }).click();
    await expect.poll(() => s.state.settings.schedulerGraceMinutes).toBe(30);
    await p.getByTestId('min-gap').click();
    await p.getByRole('option', { name: '1 hour' }).click();
    await expect.poll(() => s.state.settings.schedulerMinGapMinutes).toBe(60);
    await p.getByTestId('max-per-day').click();
    await p.getByRole('option', { name: '6 a day' }).click();
    await expect.poll(() => s.state.settings.schedulerMaxPerDay).toBe(6);
    await p.getByLabel('Auto-fix media').click();
    await expect.poll(() => s.state.settings.autoFixMedia).toBe(false);
    await p.getByTestId('digest-hour').click();
    await p.getByRole('option', { name: '6:00 PM' }).click();
    await expect.poll(() => s.state.settings.digestHour).toBe(18);
    await p.getByLabel('Daily digest').click();
    await expect.poll(() => s.state.settings.digestEnabled).toBe(false);
    await expect(p.getByTestId('digest-hour')).toBeDisabled();

    // each write carries the FULL settings object (a bare patch would reset the other settings)
    const writes = s.state.calls
      .filter((c) => c.channel === 'settings:set')
      .map((c) => c.payload as Record<string, unknown>);
    expect(writes.length).toBe(7);
    for (const w of writes)
      expect(Object.keys(w)).toEqual(
        expect.arrayContaining([
          'theme',
          'schedulerTrayMode',
          'schedulerGraceMinutes',
          'digestHour',
        ]),
      );
    // and the stored values survive a reload
    await p.reload();
    await expect(p.getByLabel('Keep running in the system tray')).not.toBeChecked();
    await expect(p.getByTestId('grace')).toContainText('30 minutes');
    await expect(p.getByTestId('max-per-day')).toContainText('6 a day');
    clean(s);
    await s.close();
  });

  test('a stored value that is not one of the presets is still shown', async () => {
    const s = await open(SCHEDULER, {
      prepare: (_lib, state) => {
        state.settings.schedulerGraceMinutes = 45;
        state.settings.schedulerMaxPerDay = 7;
      },
    });
    await expect(s.page.getByTestId('grace')).toContainText('45 minutes');
    await expect(s.page.getByTestId('max-per-day')).toContainText('7 a day');
    clean(s);
    await s.close();
  });

  test('tray not available: the switch is off and explains why', async () => {
    const s = await open(SCHEDULER, {
      prepare: (lib) => {
        lib.scheduler.trayAvailable = false;
      },
    });
    await expect(s.page.getByLabel('Keep running in the system tray')).toBeDisabled();
    await expect(s.page.getByLabel('Keep running in the system tray')).not.toBeChecked();
    await expect(s.page.getByText('is not available on this system')).toBeVisible();
    clean(s);
    await s.close();
  });

  test('pause / resume and "Send now" digest', async () => {
    const s = await open(SCHEDULER);
    await expect(s.page.getByTestId('settings-scheduler-state')).toContainText('Active');
    await expect(s.page.getByText('Next post: Today 6:00 PM')).toBeVisible();
    await s.page.getByTestId('settings-pause').click();
    await expect(s.page.getByTestId('settings-scheduler-state')).toContainText('Paused');
    await expect(s.page.getByTestId('settings-pause')).toHaveText(/Resume/);
    expect(s.lib.log.paused).toEqual([true]);
    await s.page.getByTestId('digest-now').click();
    await expect(toast(s.page, 'Digest sent')).toBeVisible();
    expect(s.lib.log.digests).toBe(1);
    await s.page.getByTestId('settings-pause').click();
    await expect(s.page.getByTestId('settings-scheduler-state')).toContainText('Active');
    clean(s);
    await s.close();
  });
});
