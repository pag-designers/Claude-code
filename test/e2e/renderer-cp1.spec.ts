import { expect, test, type Locator, type Page } from '@playwright/test';
import { findMatches } from '../../renderer/lib/transcript';
import { formatClock } from '../../renderer/lib/format';
import { videoView } from './support/cp1-data';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { makeState } from './support/clipfern-stub';

/**
 * CP1 behaviour tests against the REAL exported renderer, with `window.clipfern` stubbed by a bridge that validates
 * every request, response and pushed event with the real zod contract (test/e2e/support/clipfern-stub.ts).
 *   pnpm build:renderer && npx playwright test test/e2e/renderer-cp1.spec.ts
 * Every session also asserts: zero console errors/warnings, zero external requests, zero HTTP >= 400.
 */
// our own browser/contexts: the runner's auto-trace artifacts would race with manual context.close()
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  test.setTimeout(300_000); // first run generates the media fixtures with ffmpeg
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = (route: string, opts: OpenOptions = {}) => h.open(route, { settle: 400, ...opts });
const YT = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const urlBox = (p: Page) => p.getByRole('textbox', { name: 'YouTube URL' });
const start = (p: Page) => p.getByRole('button', { name: /Start clipping/ });
const stageRow = (p: Page, st: string) =>
  p.locator(`[data-testid="pipeline-progress"] li[data-stage="${st}"]`);
const cards = (p: Page) => p.getByTestId('clip-card');
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

test.describe('Home: URL box, preview, options, start', () => {
  test('validates the URL, previews it via pipeline:probe and shows chapters + CC badge', async () => {
    const s = await open('/', { scenario: 'configured' });
    await expect(start(s.page)).toBeDisabled();
    await urlBox(s.page).fill('https://vimeo.com/12345');
    await urlBox(s.page).blur();
    await expect(s.page.getByText(/not a YouTube link/i)).toBeVisible();
    expect(s.state.calls.filter((c) => c.channel === 'pipeline:probe')).toHaveLength(0); // no probe for invalid input

    await urlBox(s.page).fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s');
    await expect(s.page.getByText('Valid YouTube video link')).toBeVisible();
    const preview = s.page.getByTestId('url-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('preview-title')).toHaveText(
      'Designing for Attention: A 15-Minute Talk',
    );
    await expect(preview).toContainText('Open Design Lab');
    await expect(preview).toContainText('Apr 12, 2025');
    await expect(preview).toContainText('15:12');
    await expect(preview).toContainText('5 chapters');
    await expect(preview.getByTestId('cc-badge')).toHaveAttribute(
      'title',
      /Creative Commons Attribution/,
    );
    await expect(preview.locator('img')).toHaveAttribute('src', /\/__assets\/v5\.jpg$/);
    await expect(start(s.page)).toBeEnabled();
    const probes = s.state.calls.filter((c) => c.channel === 'pipeline:probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]!.payload).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
    });
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('a standard-license video shows no CC badge; an already-imported video is flagged', async () => {
    const s = await open('/', { scenario: 'library' });
    await urlBox(s.page).fill('youtu.be/StdLicense1'); // scheme-less input is accepted
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await expect(s.page.getByTestId('cc-badge')).toHaveCount(0);
    await urlBox(s.page).fill(YT('Ab3dEf9GhIj'));
    const banner = s.page.getByText('This video is already in your library');
    await expect(banner).toBeVisible();
    await s.page.getByRole('link', { name: /^Open/ }).click();
    await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-interview$/);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  for (const [id, expectTitle, expectText, linkHref] of [
    ['BotCheck001', /not a bot/i, /cookies/i, '/settings/ingest/'],
    ['Private0001', /private or members-only/i, /Private video/, '/settings/ingest/'],
    ['AgeLimit001', /age-restricted/i, /confirm your age/i, '/settings/ingest/'],
  ] as const) {
    test(`probe error ${id}: actionable message with the real error text`, async () => {
      const s = await open('/', { scenario: 'configured' });
      await urlBox(s.page).fill(`https://youtu.be/${id}`);
      const err = s.page.getByTestId('probe-error');
      await expect(err).toBeVisible();
      await expect(err).toContainText(expectText);
      await expect(s.page.getByText(expectTitle).first()).toBeVisible();
      await expect(s.page.getByRole('link', { name: 'Open Ingest settings' })).toHaveAttribute(
        'href',
        linkHref,
      );
      await expect(s.page.getByTestId('url-preview')).toHaveCount(0);
      await expect(start(s.page)).toBeDisabled();
      // retry re-issues the probe
      const before = s.state.calls.filter((c) => c.channel === 'pipeline:probe').length;
      await s.page.getByRole('button', { name: 'Retry' }).click();
      await expect
        .poll(() => s.state.calls.filter((c) => c.channel === 'pipeline:probe').length)
        .toBe(before + 1);
      expect(s.problems).toEqual([]);
      await s.close();
    });
  }

  test('live streams are rejected with a friendly message and cannot be started', async () => {
    const s = await open('/', { scenario: 'configured' });
    await urlBox(s.page).fill('https://youtu.be/LiveStream1');
    await expect(s.page.getByText('This is a live stream')).toBeVisible();
    await expect(s.page.getByText(/Live clipping arrives in a later version/)).toBeVisible();
    await expect(start(s.page)).toBeDisabled();
    const t = await tip(
      s.page,
      s.page.locator('span[tabindex="0"]').filter({ has: start(s.page) }),
    );
    await expect(t).toContainText('Live streams cannot be clipped');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('options default from settings, are overridable per run and are sent complete to pipeline:start', async () => {
    const s = await open('/', {
      scenario: 'configured',
      prepare: (st) => {
        st.settings.defaultClipPreset = '60-90';
        st.settings.defaultClipCount = 8;
        st.settings.defaultAspect = '4:5';
        st.settings.maxResolution = 720;
      },
    });
    const checked = (name: string) => s.page.getByRole('radio', { name, exact: true });
    await expect(checked('60–90 s')).toHaveAttribute('aria-checked', 'true');
    await expect(checked('8')).toHaveAttribute('aria-checked', 'true');
    await expect(checked('4:5')).toHaveAttribute('aria-checked', 'true');

    await checked('15–30 s').click();
    await checked('15').click();
    await checked('1:1').click();
    await s.page.getByRole('switch', { name: 'Captions' }).click();
    await s.page
      .getByRole('textbox', { name: 'Steering prompt' })
      .fill('  moments about focus and attention  ');
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await start(s.page).click();
    await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-new-1$/);
    expect(s.state.log.started).toHaveLength(1);
    expect(s.state.log.started[0]).toEqual({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      options: {
        clipPreset: '15-30',
        clipCount: 15,
        minScore: 60,
        aspect: '1:1',
        captions: false,
        hookCard: true,
        prompt: 'moments about focus and attention',
        language: null,
        maxResolution: 720,
      },
    });
    await expect(s.page.getByTestId('video-title')).toHaveText(
      'Designing for Attention: A 15-Minute Talk',
    );
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('custom length validates min/max; "All above score" sends clipCount null + minScore', async () => {
    const s = await open('/', { scenario: 'configured' });
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await s.page.getByRole('radio', { name: 'Custom' }).click();
    await s.page.getByLabel('Min length').fill('40');
    await s.page.getByLabel('Max length').fill('42');
    await expect(
      s.page.getByRole('alert').filter({ hasText: 'at least 5 seconds above min' }),
    ).toBeVisible();
    await expect(start(s.page)).toBeDisabled();
    await s.page.getByLabel('Max length').fill('75');
    await expect(start(s.page)).toBeEnabled();
    await s.page.getByRole('radio', { name: 'All above score' }).click();
    await s.page.getByLabel('Minimum score').first().fill('80');
    await start(s.page).click();
    await expect(s.page).toHaveURL(/id=vid-new-1/);
    expect(s.state.log.started[0]!.options).toMatchObject({
      clipPreset: 'custom',
      minSec: 40,
      maxSec: 75,
      clipCount: null,
      minScore: 80,
    });
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test.describe('Home: Start is disabled with a specific reason', () => {
  const cases: [string, (st: ReturnType<typeof makeState>) => void, RegExp, string][] = [
    [
      'no Anthropic key',
      (st) => delete st.secrets['anthropic.apiKey'],
      /Add your Anthropic API key/,
      '/settings/api-keys/',
    ],
    [
      'no storage',
      (st) => (st.storage = makeState('fresh').storage),
      /Connect cloud storage/,
      '/settings/storage/',
    ],
    [
      'engine still installing',
      (st) =>
        (st.sidecar = {
          ...st.sidecar,
          modelReady: false,
          phase: 'downloading-model',
          message: 'Downloading model (35%)',
        }),
      /transcription engine is still installing/,
      '/settings/compute/',
    ],
    ['hard cap reached', (st) => (st.costSpent = 75), /hard cap \(\$70\)/, '/settings/models/'],
  ];
  for (const [name, prep, message, href] of cases) {
    test(name, async () => {
      const s = await open('/', { scenario: 'configured', prepare: prep });
      await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
      await expect(s.page.getByTestId('setup-blocker')).toContainText(message);
      await expect(start(s.page)).toBeDisabled();
      const t = await tip(
        s.page,
        s.page.locator('span[tabindex="0"]').filter({ has: start(s.page) }),
      );
      await expect(t).toContainText(message);
      await expect(s.page.getByRole('link', { name: 'Fix in Settings' })).toHaveAttribute(
        'href',
        href,
      );
      expect(s.problems).toEqual([]);
      await s.close();
    });
  }

  test('fresh install lists every missing step; "Fix in Settings" leads to the first', async () => {
    const s = await open('/', { scenario: 'fresh' });
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('setup-blocker')).toContainText('Anthropic API key');
    await expect(s.page.getByText(/more steps in the setup checklist below/)).toBeVisible();
    const t = await tip(
      s.page,
      s.page.locator('span[tabindex="0"]').filter({ has: start(s.page) }),
    );
    await expect(t).toContainText('more setup steps');
    await s.page.getByRole('link', { name: 'Fix in Settings' }).click();
    await expect(s.page).toHaveURL(/\/settings\/api-keys\/$/);
    await s.close();
  });

  test('fully configured: no blocker banner, the old "next checkpoint" tooltip is gone', async () => {
    const s = await open('/', { scenario: 'configured' });
    await expect(s.page.getByTestId('setup-blocker')).toHaveCount(0);
    await expect(s.page.getByText(/arrives in the next checkpoint/)).toHaveCount(0);
    await s.close();
  });
});

test.describe('Live pipeline', () => {
  test('stages progress live, clips appear as they are found, run finishes, cost refreshes', async () => {
    const s = await open('/', { scenario: 'configured' });
    await expect(s.page.getByTestId('cost-chip')).toContainText('AI $12.84 / $30');
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await start(s.page).click();
    await expect(s.page).toHaveURL(/id=vid-new-1/);
    const sim = s.sim('vid-new-1');

    // idle: nothing reported yet, 7 stages listed in order
    const labels = [
      'Download',
      'Prepare media',
      'Transcribe',
      'Understand',
      'Find moments',
      'Render clips',
      'Upload & clean up',
    ];
    await expect(s.page.locator('[data-testid="pipeline-progress"] li[data-stage]')).toHaveCount(7);
    const texts = await s.page
      .locator('[data-testid="pipeline-progress"] li[data-stage] p.text-sm')
      .allTextContents();
    expect(texts.map((t) => t.trim())).toEqual(labels);
    await expect(s.page.getByTestId('pipeline-progress')).toHaveAttribute(
      'data-status',
      'ingesting',
    );
    await expect(s.page.getByTestId('clips-waiting')).toBeVisible(); // "looking for moments" skeleton
    await expect(s.page.getByRole('tab', { name: /^Clips/ })).toHaveAttribute(
      'aria-selected',
      'true',
    ); // live default tab

    // download: determinate bar with message + ETA
    await sim.run(1);
    await expect(stageRow(s.page, 'ingest')).toHaveAttribute('data-status', 'running');
    const bar = stageRow(s.page, 'ingest').getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '15');
    await expect(stageRow(s.page, 'ingest')).toContainText(
      'Downloading 1080p · 4.1 MiB/s · 00:41 left',
    );
    await sim.run(1);
    await expect(bar).toHaveAttribute('aria-valuenow', '72');

    // prepare: indeterminate shimmer; download done with a duration
    await sim.run(1);
    await expect(stageRow(s.page, 'ingest')).toHaveAttribute('data-status', 'done');
    await expect(stageRow(s.page, 'prepare').getByRole('progressbar')).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
    await expect(stageRow(s.page, 'prepare')).toContainText(
      'Extracting audio and building the 480p proxy',
    );

    // transcribe → understand
    await sim.run(3);
    await expect(stageRow(s.page, 'transcribe')).toHaveAttribute('data-status', 'done');
    await expect(stageRow(s.page, 'understand')).toHaveAttribute('data-status', 'running');
    await expect(s.page.getByTestId('cost-chip')).toContainText('AI $13.');
    // the run log has the story so far
    await s.page.getByRole('button', { name: /Show run log/ }).click();
    await expect(s.page.getByRole('log', { name: 'Run log' })).toContainText('Downloading 1080p');
    await s.page.getByRole('button', { name: /Hide run log/ }).click();

    // moments: the FIRST clips appear live + "First clip ready" moment + notification toast
    await expect(cards(s.page)).toHaveCount(0);
    await sim.run(1);
    await expect(cards(s.page)).toHaveCount(2);
    await expect(s.page.getByTestId('first-clip')).toContainText('First clip ready');
    await expect(s.page.getByText('First clips are ready').first()).toBeVisible();
    await expect(s.page.getByRole('tab', { name: /^Clips/ })).toContainText('2');
    await expect(s.page.getByTestId('clips-waiting')).toHaveCount(0);
    // stage list folds into the one-line summary once clips exist
    await expect(
      s.page.locator('[data-testid="pipeline-progress"] ol[aria-label="Pipeline stages"]'),
    ).toBeVisible();
    const firstTitle = await cards(s.page).first().locator('h3').innerText();
    expect(firstTitle).toContain('Awareness isn’t enough');

    await sim.run(1);
    await expect(cards(s.page)).toHaveCount(6);
    // render: statuses and per-clip progress
    await sim.run(1);
    await expect(cards(s.page).first()).toContainText(/Rendering 40%|Rendering/);
    await sim.run(1);
    await expect(s.page.locator('[data-clip-id="vid-new-1-c3"]')).toContainText('Rendering 60%');
    await sim.run();
    await expect(s.page.getByTestId('pipeline-progress')).toHaveAttribute('data-status', 'ready');
    await expect(s.page.getByText('Clipping finished').first()).toBeVisible();
    await expect(s.page.getByText('Rendering')).toHaveCount(0);
    await expect(cards(s.page)).toHaveCount(6);
    // thumbnails are real, presigned-style URLs that load
    await expect(cards(s.page).first().locator('img')).toHaveJSProperty('complete', true);
    expect(
      await cards(s.page)
        .first()
        .locator('img')
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    ).toBeGreaterThan(0);
    // cost chip followed the run (understand + moments calls were added by the stub)
    await expect(s.page.getByTestId('cost-chip')).toContainText(/AI \$13\.[3-9]\d \/ \$30/);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Home lists the running video with stage chips, live progress and a working Cancel', async () => {
    const s = await open('/', { scenario: 'library' });
    const row = s.page.getByTestId('running-video').first();
    await expect(row).toContainText('Why nobody finishes online courses');
    await expect(row).toContainText('Find moments');
    await expect(row).toContainText('55%');
    await expect(row.locator('li[data-stage]')).toHaveCount(7);
    await expect(row.locator('li[data-stage="transcribe"]')).toHaveAttribute('data-status', 'done');
    await expect(row.locator('li[data-stage="moments"]')).toHaveAttribute('data-status', 'running');
    // a pipeline:event moves it without any refetch
    const listCalls = () =>
      s.state.calls.filter((c) => ['videos:list', 'videos:get', 'clips:list'].includes(c.channel))
        .length;
    const calls = listCalls();
    await s.emit('pipeline:event', {
      videoId: 'vid-processing',
      stage: 'moments',
      status: 'running',
      progress: 0.8,
      message: 'Ranking window 3 of 3',
      detail: null,
      at: Date.now(),
    });
    await expect(row).toContainText('80%');
    expect(listCalls()).toBe(calls);
    await s.emit('pipeline:event', {
      videoId: 'vid-processing',
      stage: 'render',
      status: 'running',
      progress: null,
      message: null,
      detail: '2 of 6',
      at: Date.now(),
    });
    await expect(row).toContainText('Render clips');
    // failed videos stay visible with a friendly reason and a way to fix them
    await expect(s.page.getByTestId('running-video').nth(1)).toContainText(
      'YouTube wants to confirm you are not a bot',
    );
    await row.getByRole('button', { name: 'Cancel clipping' }).click();
    await expect.poll(() => s.state.log.cancels).toEqual(['vid-processing']);
    // a canceled run leaves "Running jobs" and shows up in "Continue where you left off" as Canceled
    await expect(
      s.page.locator('[data-testid="running-video"][data-video-id="vid-processing"]'),
    ).toHaveCount(0);
    await expect(
      s.page.getByTestId('continue-item').filter({ hasText: 'Why nobody finishes online courses' }),
    ).toContainText('Canceled');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('failure shows the error + recovery, retry resumes at that stage and finishes', async () => {
    const s = await open('/', { scenario: 'configured' });
    await urlBox(s.page).fill('https://youtu.be/FailAtStt01');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await start(s.page).click();
    await expect(s.page).toHaveURL(/id=vid-new-1/);
    await expect(s.page.getByTestId('pipeline-progress')).toBeVisible(); // the page is open while the run happens
    const sim = s.sim('vid-new-1');
    await sim.run();
    await expect(s.page.getByTestId('pipeline-progress')).toHaveAttribute('data-status', 'failed');
    await expect(stageRow(s.page, 'prepare')).toHaveAttribute('data-status', 'done');
    const failed = stageRow(s.page, 'transcribe');
    await expect(failed).toHaveAttribute('data-status', 'failed');
    await expect(failed.getByTestId('stage-error')).toContainText('exit code 137, out of memory');
    await expect(failed).toContainText('The transcription engine stopped');
    await expect(failed.getByRole('link', { name: 'Open Compute settings' })).toHaveAttribute(
      'href',
      '/settings/compute/',
    );
    await expect(s.page.getByText('Stopped at Transcribe')).toBeVisible();
    await expect(s.page.getByRole('button', { name: 'Re-run stage' })).toBeEnabled();

    await failed.getByRole('button', { name: /Retry transcribe/ }).click();
    await expect
      .poll(() => s.state.log.retries)
      .toEqual([{ videoId: 'vid-new-1', stage: 'transcribe' }]);
    await expect(stageRow(s.page, 'transcribe')).toHaveAttribute('data-status', 'running');
    await s.sim('vid-new-1').run();
    await expect(s.page.getByTestId('pipeline-progress')).toHaveAttribute('data-status', 'ready');
    await expect(cards(s.page)).toHaveCount(6);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('bot-check failure at download links to Settings → Ingest', async () => {
    const s = await open('/library/video/?id=vid-failed', { scenario: 'library' });
    const row = stageRow(s.page, 'ingest');
    await expect(row.getByTestId('stage-error')).toContainText(
      'Sign in to confirm you’re not a bot',
    );
    await expect(row).toContainText('YouTube wants to confirm you are not a bot');
    await row.getByRole('link', { name: 'Open Ingest settings' }).click();
    await expect(s.page).toHaveURL(/\/settings\/ingest\/$/);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('cancel stops the run and offers Resume; reduced motion drops the shimmer animation', async () => {
    const s = await open('/', { scenario: 'configured', reducedMotion: true });
    await urlBox(s.page).fill('https://youtu.be/dQw4w9WgXcQ');
    await expect(s.page.getByTestId('url-preview')).toBeVisible();
    await start(s.page).click();
    await expect(s.page).toHaveURL(/id=vid-new-1/);
    const sim = s.sim('vid-new-1');
    await sim.run(3);
    const sweep = stageRow(s.page, 'prepare').locator('[data-slot="progress"] > div');
    const dur = await sweep.evaluate((el) => getComputedStyle(el).animationDuration);
    expect(parseFloat(dur)).toBeLessThan(0.001);
    await s.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => s.state.log.cancels).toEqual(['vid-new-1']);
    await expect(s.page.getByTestId('pipeline-progress')).toHaveAttribute(
      'data-status',
      'canceled',
    );
    await s.page.getByRole('button', { name: /Resume from/ }).click();
    await expect.poll(() => s.state.log.retries.length).toBe(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test.describe('Library', () => {
  test('Videos: grid/list, search, favorite, overflow menu, delete confirm with storage choice', async () => {
    const s = await open('/library/', { scenario: 'library' });
    await expect(s.page.getByTestId('video-count')).toHaveText('4 videos');
    await expect(s.page.getByTestId('video-card')).toHaveCount(4);
    const ready = s.page.locator('[data-testid="video-card"][data-video-id="vid-interview"]');
    await expect(ready).toContainText('9 clips');
    await expect(ready.getByTitle(/Virality score 94/)).toBeVisible();
    await expect(ready.locator('img').first()).toHaveAttribute('src', /__assets\/v1\.jpg/);
    // in-progress card: status chip + stage segments + cancel
    const running = s.page.locator('[data-testid="video-card"][data-video-id="vid-processing"]');
    await expect(running).toContainText('Find moments');
    await expect(running.locator('li[data-stage="moments"]')).toHaveAttribute(
      'data-status',
      'running',
    );
    // failed card: friendly reason
    await expect(s.page.locator('[data-video-id="vid-failed"]')).toContainText(
      'YouTube wants to confirm you are not a bot',
    );

    // list layout is remembered
    await s.page
      .getByRole('radiogroup', { name: 'Video layout' })
      .getByRole('radio', { name: 'List' })
      .click();
    await expect(s.page.getByTestId('video-list')).toBeVisible();
    await s.page.reload();
    await expect(s.page.getByTestId('video-list')).toBeVisible();
    await s.page
      .getByRole('radiogroup', { name: 'Video layout' })
      .getByRole('radio', { name: 'Grid' })
      .click();

    // search
    await s.page.getByRole('textbox', { name: 'Search videos' }).fill('slow founder');
    await expect(s.page.getByTestId('video-card')).toHaveCount(1);
    await s.page.getByRole('textbox', { name: 'Search videos' }).fill('');

    // favorite (optimistic)
    const podcast = s.page.locator('[data-testid="video-card"][data-video-id="vid-podcast"]');
    await podcast.hover();
    await podcast.getByRole('button', { name: /Add .* to favorites/ }).click();
    await expect(podcast.getByRole('button', { name: /Remove .* from favorites/ })).toBeVisible();
    expect(s.state.videos.find((v) => v.id === 'vid-podcast')!.favorite).toBe(true);

    // delete: cancel keeps it; confirm honours the "also delete from storage" checkbox
    await podcast.hover();
    await podcast.getByRole('button', { name: /More actions for/ }).click();
    await s.page.getByRole('menuitem', { name: /Delete/ }).click();
    const dlg = s.page.getByRole('dialog', { name: 'Delete this video?' });
    await expect(dlg).toContainText('5 clips');
    const box = dlg.getByRole('checkbox', { name: 'Also delete from cloud storage' });
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(s.page.getByTestId('video-card')).toHaveCount(4);
    await podcast.hover();
    await podcast.getByRole('button', { name: /More actions for/ }).click();
    await s.page.getByRole('menuitem', { name: /Delete/ }).click();
    await dlg.getByRole('checkbox', { name: 'Also delete from cloud storage' }).click();
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(s.page.getByTestId('video-card')).toHaveCount(3);
    expect(s.state.log.deleted).toEqual([{ id: 'vid-podcast', deleteFromStorage: false }]);
    await expect(s.page.getByRole('tab', { name: /^Clips/ })).toContainText('12'); // its 5 clips went with it
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Videos: empty state guides the user; deep link ?tab= opens the right tab', async () => {
    const s = await open('/library/', { scenario: 'configured' });
    await expect(s.page.getByText('No videos imported yet')).toBeVisible();
    await expect(
      s.page.getByText('Paste a YouTube URL on Home to make your first clips.'),
    ).toBeVisible();
    await s.page.getByRole('link', { name: 'Paste a YouTube URL' }).click();
    await expect(s.page).toHaveURL(/\/$/);
    await s.page.goto(`${h.base}/library/?tab=clips`);
    await expect(s.page.getByRole('tab', { name: /^Clips/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(s.page.getByText('Your clips will land here')).toBeVisible();
    await s.page.getByRole('tab', { name: 'Edited' }).click();
    await expect(s.page.getByText('Nothing edited yet')).toBeVisible();
    await s.page.getByRole('tab', { name: 'Exported' }).click();
    await expect(s.page.getByText('No exports yet')).toBeVisible();
    await s.page.getByRole('tab', { name: 'Favorites' }).click();
    await expect(s.page.getByText('No favorites yet')).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Clips: filters (score slider, duration, video, date, favorites, search) and sorting', async () => {
    const s = await open('/library/?tab=clips', { scenario: 'library', settle: 1000 });
    const count = s.page.getByTestId('clip-count');
    await expect(count).toHaveText('17 clips');
    const titles = async () =>
      (await cards(s.page).locator('h3').allInnerTexts()).map((t) => t.trim());
    // default sort: top score first, unrendered/low last
    const scores = s.state.clips.map((c) => c.score!).sort((a, b) => b - a);
    expect((await titles())[0]).toContain('Awareness isn’t enough');
    expect(scores[0]).toBe(94);

    await s.page.getByLabel('Minimum score').fill('85');
    await expect(s.page.getByTestId('min-score-value')).toHaveText('≥85');
    const above = s.state.clips.filter((c) => (c.score ?? 0) >= 85).length;
    await expect(count).toHaveText(`${above} of 17 clips`);
    await s.page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(count).toHaveText('17 clips');

    // duration bucket
    await s.page.getByRole('combobox', { name: 'Duration' }).click();
    await s.page.getByRole('option', { name: 'Under 30 s' }).click();
    await expect(count).toHaveText(
      `${s.state.clips.filter((c) => c.durationSec < 30).length} of 17 clips`,
    );
    await s.page.getByRole('combobox', { name: 'Duration' }).click();
    await s.page.getByRole('option', { name: '30–60 s' }).click();
    await expect(cards(s.page)).toHaveCount(
      s.state.clips.filter((c) => c.durationSec >= 30 && c.durationSec < 60).length,
    );
    await s.page.getByRole('button', { name: 'Clear filters' }).click();

    // video
    await s.page.getByRole('combobox', { name: 'Video' }).click();
    await s.page.getByRole('option', { name: /Slow Founder/ }).click();
    await expect(count).toHaveText('5 of 17 clips');
    await expect(cards(s.page)).toHaveCount(5);
    await s.page.getByRole('button', { name: 'Clear filters' }).click();

    // date: only clips created today (the podcast clips are 2 days old)
    await s.page.getByRole('combobox', { name: 'Date' }).click();
    await s.page.getByRole('option', { name: 'Today' }).click();
    await expect(count).toHaveText('12 of 17 clips');
    await s.page.getByRole('button', { name: 'Clear filters' }).click();

    // favorites toggle
    await s.page.getByRole('button', { name: 'Favorites', exact: true }).click();
    const favs = s.state.clips.filter((c) => c.favorite).length;
    await expect(cards(s.page)).toHaveCount(favs);
    await s.page.getByRole('button', { name: 'Clear filters' }).click();

    // search + empty result state
    await s.page.getByRole('textbox', { name: 'Search clips' }).fill('collage');
    await expect(cards(s.page).first()).toContainText('412-hour collage');
    await s.page.getByRole('textbox', { name: 'Search clips' }).fill('zzzz-nothing');
    await expect(s.page.getByText('No clips match these filters')).toBeVisible();
    await s.page.getByRole('button', { name: 'Clear filters' }).first().click();

    // sort: newest first puts the live-processing clips (created minutes ago) on top
    await s.page.getByRole('combobox', { name: 'Sort by' }).click();
    await s.page.getByRole('option', { name: 'Sort: Newest' }).click();
    const newest = [...s.state.clips].sort((a, b) => b.createdAt - a.createdAt)[0]!;
    await expect(cards(s.page).first()).toHaveAttribute('data-clip-id', newest.id);
    await s.page.getByRole('combobox', { name: 'Sort by' }).click();
    await s.page.getByRole('option', { name: 'Sort: Longest' }).click();
    const longest = [...s.state.clips].sort((a, b) => b.durationSec - a.durationSec)[0]!;
    await expect(cards(s.page).first()).toHaveAttribute('data-clip-id', longest.id);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Clips: hover-to-preview autoplays the presigned render; list layout; favorites via star', async () => {
    const s = await open('/library/?tab=clips', { scenario: 'library', settle: 1000 });
    const card = cards(s.page).first();
    await expect(card.locator('img')).toHaveAttribute('src', /__assets\/c1\.jpg$/);
    await expect(s.page.getByTestId('clip-preview')).toHaveCount(0);
    await card.getByRole('button', { name: /^Open clip/ }).hover();
    const vid = s.page.getByTestId('clip-preview');
    await expect(vid).toHaveAttribute('src', /__assets\/clip-a\.webm$/);
    await expect
      .poll(() => vid.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused && v.muted))
      .toBe(true);
    await expect
      .poll(() => vid.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0.2);
    await s.page.mouse.move(5, 5);
    await expect(s.page.getByTestId('clip-preview')).toHaveCount(0);
    // only rendered clips preview: a "queued" clip never loads a render
    const queued = s.page.locator('[data-clip-id="vid-processing-c2"]');
    await queued.getByRole('button', { name: /^Open clip/ }).hover();
    await s.page.waitForTimeout(500);
    await expect(s.page.getByTestId('clip-preview')).toHaveCount(0);
    expect(h.assetHits.filter((f) => f.endsWith('.webm')).length).toBeGreaterThan(0);

    // favorite from the card (optimistic) and in the Favorites tab
    await card.hover();
    const star = card.getByRole('button', { name: /favorites/ });
    const id = (await card.getAttribute('data-clip-id'))!;
    const before = s.state.clips.find((c) => c.id === id)!.favorite;
    await star.click();
    await expect.poll(() => s.state.clips.find((c) => c.id === id)!.favorite).toBe(!before);

    await s.page
      .getByRole('radiogroup', { name: 'Layout' })
      .getByRole('radio', { name: 'List' })
      .click();
    await expect(s.page.getByTestId('clip-list')).toBeVisible();
    await expect(s.page.getByTestId('clip-row')).toHaveCount(17);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Clips: multi-select (checkbox, shift range, select all) with bulk download / favorite / delete', async () => {
    const s = await open('/library/?tab=clips', { scenario: 'library', settle: 1000 });
    await expect(s.page.getByTestId('selection-bar')).toHaveCount(0);
    const boxes = s.page.getByRole('checkbox', { name: /^Select (?!all)/ });
    await cards(s.page).nth(0).hover();
    await boxes.nth(0).click();
    const bar = s.page.getByTestId('selection-bar');
    await expect(bar).toContainText('1');
    await expect(bar).toContainText('selected');
    // shift-click extends the range
    await cards(s.page)
      .nth(3)
      .getByRole('button', { name: /^Open clip/ })
      .click({ modifiers: ['Shift'] });
    await expect(bar.getByText('4', { exact: true })).toBeVisible();
    // later-version actions are disabled with the tooltip
    for (const name of ['Send to scheduler', 'Open in editor']) {
      const btn = s.page.getByRole('button', { name });
      await expect(btn).toBeDisabled();
      const t = await tip(s.page, s.page.locator('span[tabindex="0"]').filter({ has: btn }));
      await expect(t).toContainText('Coming in a later version');
      await s.page.mouse.move(5, 5);
    }
    // download
    const ids = (await cards(s.page).evaluateAll((els) =>
      els.slice(0, 4).map((e) => e.getAttribute('data-clip-id')),
    ))!;
    await bar.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => s.state.log.downloads).toEqual([ids]);
    await expect(s.page.getByText(/Saved \d+ clips?/).first()).toBeVisible();
    await expect(s.page.getByText('/home/demo/Videos/Clipfern').first()).toBeVisible();
    // favorite all, then unfavorite all
    await bar.getByRole('button', { name: 'Favorite', exact: true }).click();
    await expect
      .poll(() => ids.every((id) => s.state.clips.find((c) => c.id === id)!.favorite))
      .toBe(true);
    await bar.getByRole('button', { name: 'Unfavorite' }).click();
    await expect
      .poll(() => ids.some((id) => s.state.clips.find((c) => c.id === id)!.favorite))
      .toBe(false);
    // Escape clears; select all via header checkbox
    await s.page.keyboard.press('Escape');
    await expect(s.page.getByTestId('selection-bar')).toHaveCount(0);
    await s.page.getByRole('checkbox', { name: 'Select all clips' }).click();
    await expect(s.page.getByTestId('selection-bar')).toContainText('17');
    await s.page.getByRole('checkbox', { name: 'Select all clips' }).click();
    await expect(s.page.getByTestId('selection-bar')).toHaveCount(0);
    // delete requires confirmation
    await cards(s.page).nth(0).hover();
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await s.page.getByTestId('selection-bar').getByRole('button', { name: 'Delete' }).click();
    const dlg = s.page.getByRole('dialog', { name: 'Delete 2 clips?' });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(cards(s.page)).toHaveCount(17);
    await s.page.getByTestId('selection-bar').getByRole('button', { name: 'Delete' }).click();
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(cards(s.page)).toHaveCount(15);
    expect(s.state.log.deletedClips).toHaveLength(1);
    expect(s.state.log.deletedClips[0]).toHaveLength(2);
    await expect(s.page.getByTestId('selection-bar')).toHaveCount(0);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('Favorites tab shows favorite clips and videos', async () => {
    const s = await open('/library/?tab=favorites', { scenario: 'library', settle: 1000 });
    const favClips = s.state.clips.filter((c) => c.favorite).length;
    await expect(s.page.getByRole('heading', { name: 'Favorite clips' })).toBeVisible();
    await expect(cards(s.page)).toHaveCount(favClips);
    await expect(s.page.getByRole('heading', { name: 'Favorite videos' })).toBeVisible();
    await expect(s.page.getByTestId('video-card')).toHaveCount(1);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('events update the library live: videos:updated adds a card, clips:updated changes a score', async () => {
    const s = await open('/library/', { scenario: 'library' });
    await expect(s.page.getByTestId('video-card')).toHaveCount(4);
    const nv = videoView({
      id: 'vid-live',
      title: 'Brand new upload',
      sourceUrl: YT('LiveEventAA'),
      channel: 'Someone',
      status: 'ingesting',
      stage: 'ingest',
      progress: 0.3,
      thumbnail: `${h.base}/__assets/v6.jpg`,
    });
    await s.emit('videos:updated', nv);
    await expect(s.page.getByTestId('video-card')).toHaveCount(5);
    await expect(s.page.locator('[data-video-id="vid-live"]')).toContainText('Download');
    await s.emit('videos:updated', {
      ...nv,
      status: 'ready',
      stage: null,
      progress: null,
      clipCount: 3,
      topScore: 77,
    });
    await expect(s.page.locator('[data-video-id="vid-live"]')).toContainText('3 clips');
    await s.page.getByRole('tab', { name: /^Clips/ }).click();
    const c = s.state.clips.find((x) => x.id === 'vid-interview-c9')!;
    await expect(
      s.page
        .locator(`[data-clip-id="${c.id}"]`)
        .getByRole('img', { name: new RegExp(`Virality score ${c.score} `) }),
    ).toBeVisible();
    await s.emit('clips:updated', { ...c, score: 66 });
    await expect(
      s.page.locator(`[data-clip-id="${c.id}"]`).getByRole('img', { name: /Virality score 66/ }),
    ).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test.describe('Video detail', () => {
  test('header, overview (summary, tone, participants, 5 takeaways, topics), disabled later tabs', async () => {
    const s = await open('/library/video/?id=vid-interview', { scenario: 'library' });
    await expect(s.page.getByTestId('video-title')).toHaveText(
      'Community Conversations: Autism Awareness & Local Art',
    );
    await expect(s.page.getByTestId('video-header')).toContainText('Riverside Community TV');
    await expect(s.page.getByTestId('video-header')).toContainText('3:00');
    await expect(
      s.page.locator('main').getByRole('link', { name: 'Library' }).first(),
    ).toHaveAttribute('href', '/library/?tab=videos');
    await expect(s.page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(s.page.getByTestId('overview-summary')).toContainText(
      'A warm, practical conversation',
    );
    await expect(s.page.getByText('Warm, reflective')).toBeVisible();
    await expect(s.page.getByText('Pediatric therapist').first()).toBeVisible();
    await expect(s.page.getByTestId('takeaways').locator('li')).toHaveCount(5);
    await expect(s.page.getByText('Collage art', { exact: true }).first()).toBeVisible();
    await expect(s.page.getByText('sensory friendly')).toBeVisible();
    // finished runs fold the pipeline into a summary that expands
    await expect(s.page.getByText('Clipping finished')).toBeVisible();
    await s.page.getByRole('button', { name: 'Details' }).click();
    await expect(stageRow(s.page, 'transcribe')).toContainText('Transcribed 2,986 words');
    // Chat and Subtitles are CP2
    for (const name of ['Chat', 'Subtitles']) {
      const tab = s.page.getByRole('tab', { name });
      await expect(tab).toBeDisabled();
      const t = await tip(s.page, s.page.locator('span[tabindex="0"]').filter({ has: tab }));
      await expect(t).toContainText('Coming in a later version');
      await s.page.mouse.move(5, 5);
    }
    // favorite + re-run stage menu + source link
    await s.page.getByRole('button', { name: /Remove .* from favorites/ }).click();
    await expect
      .poll(() => s.state.videos.find((v) => v.id === 'vid-interview')!.favorite)
      .toBe(false);
    await s.page.getByRole('button', { name: 'Re-run stage' }).click();
    await s.page.getByTestId('rerun-understand').click();
    await expect
      .poll(() => s.state.log.retries)
      .toEqual([{ videoId: 'vid-interview', stage: 'understand' }]);
    await s.page.getByRole('button', { name: 'Watch on YouTube' }).click();
    await expect.poll(() => s.state.log.external).toEqual([YT('Ab3dEf9GhIj')]);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('transcript: speaker labels, click to seek the proxy player, active sentence follows playback, search + copy', async () => {
    const s = await open('/library/video/?id=vid-interview&tab=transcript', {
      scenario: 'library',
      settle: 800,
    });
    const tr = s.state.transcripts['vid-interview']!;
    await expect(s.page.getByTestId('transcript-panel')).toBeVisible();
    await expect(s.page.getByText('Speaker 2').first()).toBeVisible();
    // click a sentence → the proxy seeks there and plays
    const target = tr.sentences[5]!; // "If you've met one autistic child..."
    const row = s.page.getByTestId('transcript-row').filter({ hasText: target.text });
    await row.getByRole('button').click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(target.s - 0.3);
    await expect.poll(() => proxyTime(s.page)).toBeLessThan(target.s + 6);
    await expect(row).toHaveAttribute('data-active', 'true');
    await expect(s.page.getByTestId('player-clock')).toContainText(formatClock(target.s));
    // playback advances: a later sentence becomes active and the earlier one is no longer
    await expect
      .poll(async () => (await s.page.getByTestId('player-chapter').innerText()).length)
      .toBeGreaterThan(0);
    await s.page.evaluate(
      (t) =>
        ((document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement).currentTime =
          t),
      tr.sentences[12]!.s + 0.2,
    );
    await expect(
      s.page.locator('[data-testid="transcript-row"][data-active="true"]'),
    ).toContainText(tr.sentences[12]!.text);
    await s.page.evaluate(() =>
      (document.querySelector('[data-testid="proxy-video"]') as HTMLVideoElement).pause(),
    );

    // search with highlighting + navigation
    const matches = findMatches(tr.sentences, 'collage');
    await s.page.getByRole('textbox', { name: 'Search transcript' }).fill('collage');
    await expect(s.page.getByTestId('match-count')).toContainText(`1 of ${matches.length}`);
    await expect(s.page.getByTestId('transcript-match').first()).toHaveText('collage');
    await s.page.getByRole('button', { name: 'Next match' }).click();
    await expect(s.page.getByTestId('match-count')).toContainText(`2 of ${matches.length}`);
    await s.page.getByRole('textbox', { name: 'Search transcript' }).fill('no-such-phrase-xyz');
    await expect(s.page.getByTestId('match-count')).toHaveText('No matches');
    await s.page.getByRole('textbox', { name: 'Search transcript' }).fill('');

    // copy
    await s.page.getByRole('button', { name: 'Copy transcript' }).click();
    await expect(s.page.getByText('Transcript copied')).toBeVisible();
    const clip = await s.page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(`[${formatClock(tr.sentences[0]!.s)}] Speaker 1:`);
    expect(clip).toContain(tr.sentences[10]!.text);
    expect(clip.split('\n')).toHaveLength(tr.sentences.length);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('transcript of a 12k-word podcast is windowed (few DOM rows), scrollable end to end and searchable', async () => {
    const s = await open('/library/video/?id=vid-podcast&tab=transcript', {
      scenario: 'library',
      settle: 800,
    });
    const tr = s.state.transcripts['vid-podcast']!;
    expect(tr.words.length).toBeGreaterThan(10_000);
    const rows = s.page.getByTestId('transcript-row');
    expect(await rows.count()).toBeLessThan(60);
    const scroller = s.page.getByTestId('transcript-scroller');
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = tr.sentences[tr.sentences.length - 1]!;
    await expect(
      s.page.getByTestId('transcript-row').filter({ hasText: last.text }).first(),
    ).toBeVisible();
    expect(await rows.count()).toBeLessThan(60);
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect(rows.first()).toContainText(tr.sentences[0]!.text);
    // search jumps far down the list
    const q = 'obsess over';
    const m = findMatches(tr.sentences, q);
    expect(m.length).toBeGreaterThan(20);
    await s.page.getByRole('textbox', { name: 'Search transcript' }).fill(q);
    await expect(s.page.getByTestId('match-count')).toContainText(`1 of ${m.length}`);
    await expect(s.page.getByTestId('transcript-match').first()).toBeVisible();
    for (let i = 0; i < 12; i++) await s.page.getByRole('button', { name: 'Next match' }).click();
    await expect(s.page.getByTestId('match-count')).toContainText(`13 of ${m.length}`);
    await expect(s.page.getByTestId('transcript-match').first()).toBeVisible();
    // no proxy for this video: honest player state, and timestamps explain why nothing seeks
    await expect(s.page.getByTestId('player-unavailable')).toContainText(
      'No playback copy for this video',
    );
    await s.page.getByTestId('transcript-row').first().getByRole('button').click();
    await expect(s.page.getByText('No playable proxy yet').first()).toBeVisible();
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('chapters: timeline + list with AI / YouTube badges, click seeks, current chapter follows playback', async () => {
    const s = await open('/library/video/?id=vid-interview&tab=chapters', { scenario: 'library' });
    const a = s.state.analyses['vid-interview']!;
    await expect(s.page.getByTestId('chapter-row')).toHaveCount(a.chapters.length);
    await expect(s.page.getByTestId('chapter-timeline').getByRole('button')).toHaveCount(
      a.chapters.length,
    );
    const rows = s.page.getByTestId('chapter-row');
    await expect(rows.nth(0)).toContainText('YouTube');
    await expect(rows.nth(1)).toContainText('AI');
    await expect(rows.nth(1)).toContainText('The therapist reframes the goal of therapy');
    const ch = a.chapters[3]!;
    await rows.nth(3).click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(ch.start - 0.3);
    await expect(rows.nth(3)).toHaveAttribute('aria-current', 'true');
    await expect(s.page.getByTestId('player-chapter')).toContainText(ch.title);
    // timeline segment seeks too
    await s.page.getByRole('button', { name: /^Chapter 5:/ }).click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(a.chapters[4]!.start - 0.3);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('notes: key points, quotes/numbers/claims with clickable timestamps, action items, copy all', async () => {
    const s = await open('/library/video/?id=vid-interview&tab=notes', { scenario: 'library' });
    const a = s.state.analyses['vid-interview']!;
    await expect(s.page.getByTestId('notes-tab')).toContainText(
      'Awareness is knowing the word; acceptance is changing the room.',
    );
    await expect(s.page.getByTestId('notes-tab')).toContainText(
      'Lower the lights and offer a quiet corner',
    );
    const quote = a.notes.quotes[2]!;
    await s.page
      .getByRole('button', { name: `Play from ${formatClock(quote.at)}` })
      .first()
      .click();
    await expect.poll(() => proxyTime(s.page)).toBeGreaterThan(quote.at - 0.3);
    await s.page.getByRole('button', { name: 'Copy all notes' }).click();
    await expect(s.page.getByText('Notes copied as Markdown')).toBeVisible();
    const md = await s.page.evaluate(() => navigator.clipboard.readText());
    expect(md).toContain('# Community Conversations');
    expect(md).toContain('## Key points');
    expect(md).toContain(`[${formatClock(quote.at)}] ${quote.text}`);
    expect(md).toContain('## Action items');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('analysis tabs explain themselves while the run is still going', async () => {
    const s = await open('/library/video/?id=vid-failed&tab=overview', { scenario: 'library' });
    await expect(s.page.getByText('No overview and takeaways for this video')).toBeVisible();
    await s.page.getByRole('tab', { name: 'Transcript' }).click();
    await expect(s.page.getByText('No transcript for this video')).toBeVisible();
    await s.page.getByRole('tab', { name: 'Notes' }).click();
    await expect(s.page.getByText('No notes for this video')).toBeVisible();
    await expect(s.page.getByTestId('player-unavailable')).toBeVisible();
    await s.close();

    const p = await open('/library/video/?id=missing-id', { scenario: 'library' });
    await expect(p.page.getByText('This video is not in your library')).toBeVisible();
    await expect(p.page.getByRole('link', { name: 'Back to Library' })).toBeVisible();
    await p.close();
    const n = await open('/library/video/', { scenario: 'library' });
    await expect(n.page.getByText('No video selected')).toBeVisible();
    await n.close();
  });

  test('clips tab → clip drawer: breakdown bars with caps, source seek, download, favorite, re-render, delete', async () => {
    const s = await open('/library/video/?id=vid-interview&tab=clips', {
      scenario: 'library',
      settle: 800,
    });
    await expect(cards(s.page)).toHaveCount(9);
    const clip = s.state.clips.find((c) => c.id === 'vid-interview-c1')!;
    await s.page
      .locator(`[data-clip-id="${clip.id}"]`)
      .getByRole('button', { name: /^Open clip/ })
      .click();
    const dlg = s.page.getByTestId('clip-drawer');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('heading', { name: clip.title })).toBeVisible();
    await expect(dlg.getByTestId('drawer-hook')).toContainText(
      'Awareness means people know the word.',
    );
    await expect(dlg.getByTestId('drawer-why')).toContainText('A crisp definition');
    await expect(dlg.getByRole('img', { name: /Virality score 94 out of 100/ })).toBeVisible();
    // five labelled bars with caps 25/25/20/15/15 and the real values
    const b = clip.breakdown!;
    const expected: [string, number, number][] = [
      ['hook', b.hook, 25],
      ['retention', b.retention, 25],
      ['emotion', b.emotion, 20],
      ['clarity', b.clarity, 15],
      ['shareability', b.shareability, 15],
    ];
    for (const [key, v, cap] of expected) {
      const row = dlg.getByTestId(`bd-${key}`);
      await expect(row).toContainText(`${v} / ${cap}`);
      const now = Number(await row.getByRole('progressbar').getAttribute('aria-valuenow'));
      expect(now).toBeCloseTo((v / cap) * 100, 0);
    }
    await expect(dlg.getByTestId('confidence')).toHaveText('92%');
    await expect(dlg.getByTestId('drawer-range')).toHaveText(
      `${formatClock(clip.startSec)} – ${formatClock(clip.endSec)}`,
    );
    // the rendered clip plays from the presigned URL
    const cv = dlg.getByTestId('drawer-clip-video');
    await expect(cv).toHaveAttribute('src', /__assets\/clip-a\.webm$/);
    await expect
      .poll(() => cv.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    // play the source at this moment: the proxy seeks to the clip start
    await dlg.getByRole('button', { name: 'Play source at this moment' }).click();
    const sv = dlg.getByTestId('drawer-source-video');
    await expect(sv).toHaveAttribute('src', /__assets\/proxy\.webm$/);
    await expect
      .poll(() => sv.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(clip.startSec - 0.3);
    await expect
      .poll(() => sv.evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeLessThan(clip.endSec + 1.5);
    // actions
    await dlg.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => s.state.log.downloads).toEqual([['vid-interview-c1']]);
    await dlg.getByRole('button', { name: /Remove .* from favorites/ }).click();
    await expect.poll(() => s.state.clips.find((c) => c.id === clip.id)!.favorite).toBe(false);
    await dlg.getByRole('button', { name: 'Re-render' }).click();
    await expect(dlg.getByTestId('drawer-render-progress')).toBeVisible();
    await expect(dlg.getByTestId('drawer-render-progress')).toBeHidden({ timeout: 8000 });
    expect(s.state.clips.find((c) => c.id === clip.id)!.status).toBe('rendered');
    // next / previous
    await dlg.getByRole('button', { name: 'Next clip' }).click();
    await expect(
      dlg.getByRole('heading', {
        name: s.state.clips.filter((c) => c.videoId === 'vid-interview')[1]!.title,
      }),
    ).toBeVisible();
    // the failed clip explains itself and offers a retry
    await s.page.keyboard.press('Escape');
    await s.page
      .locator('[data-clip-id="vid-interview-c9"]')
      .getByRole('button', { name: /^Open clip/ })
      .click();
    await expect(dlg).toContainText('Rendering failed');
    await expect(dlg.getByRole('button', { name: 'Retry render' })).toBeEnabled();
    await expect(dlg.getByRole('button', { name: 'Download' })).toBeDisabled();
    // delete with confirmation moves to the neighbour
    await dlg.getByRole('button', { name: 'Delete' }).click();
    await s.page
      .getByRole('dialog', { name: 'Delete this clip?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect.poll(() => s.state.log.deletedClips).toEqual([['vid-interview-c9']]);
    await expect(cards(s.page)).toHaveCount(8);
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('a clip drawer for a video without a proxy disables "Play source"', async () => {
    const s = await open('/library/video/?id=vid-podcast&tab=clips', {
      scenario: 'library',
      settle: 800,
    });
    await cards(s.page)
      .first()
      .getByRole('button', { name: /^Open clip/ })
      .click();
    const dlg = s.page.getByTestId('clip-drawer');
    await expect(dlg.getByRole('button', { name: 'Play source at this moment' })).toBeDisabled();
    await expect(dlg.getByRole('radio', { name: 'Source' })).toBeDisabled();
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test.describe('Cost chip, notifications and deep links', () => {
  for (const [spent, level, text] of [
    [12.84, 'ok', 'AI $12.84 / $30'],
    [26, 'warn', 'AI $26.00 / $30'],
    [31.5, 'over-target', 'AI $31.50 / $30'],
    [74, 'hard-cap', 'AI $74.00 / $30'],
  ] as const) {
    test(`cost chip level ${level}`, async () => {
      const s = await open('/library/', {
        scenario: 'library',
        prepare: (st) => (st.costSpent = spent),
      });
      const chip = s.page.getByTestId('cost-chip');
      await expect(chip).toHaveText(text);
      await expect(chip).toHaveAttribute('data-level', level);
      expect(s.problems).toEqual([]);
      await s.close();
    });
  }

  test('chip links to Settings → Models & Budget, whose card refreshes after pipeline events', async () => {
    const s = await open('/', { scenario: 'configured' });
    await s.page.getByTestId('cost-chip').click();
    await expect(s.page).toHaveURL(/\/settings\/models\/$/);
    await expect(s.page.getByText('$12.84').first()).toBeVisible();
    s.state.costSpent = 16.4; // a Claude call happened in main
    await s.emit('pipeline:event', {
      videoId: 'vid-x',
      stage: 'moments',
      status: 'done',
      progress: 1,
      message: 'done',
      detail: null,
      at: Date.now(),
    });
    await expect(s.page.getByText('$16.40').first()).toBeVisible();
    await expect(s.page.getByTestId('cost-chip')).toHaveText('AI $16.40 / $30');
    expect(s.problems).toEqual([]);
    await s.close();
  });

  test('nav:go and notification clicks deep-link to the right video / tab, with or without a trailing slash', async () => {
    const s = await open('/', { scenario: 'library' });
    await s.emit('nav:go', { href: '/library/video?id=vid-interview' });
    await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-interview$/);
    await expect(s.page.getByTestId('video-title')).toContainText('Community Conversations');
    await s.emit('nav:go', { href: '/settings?section=storage' });
    await expect(s.page).toHaveURL(/\/settings\/storage\/$/);

    await s.state.notify!({
      id: 'n-deep',
      kind: 'clips-ready',
      level: 'success',
      title: 'Clips are ready',
      body: '9 clips from “Community Conversations”.',
      href: '/library/video?id=vid-interview&tab=clips',
      createdAt: Date.now(),
      readAt: null,
    });
    await s.page.getByRole('button', { name: /^Notifications, \d+ unread/ }).click();
    await s.page.getByRole('button', { name: /Clips are ready/ }).click();
    await expect(s.page).toHaveURL(/\/library\/video\/\?id=vid-interview&tab=clips$/);
    await expect(s.page.getByRole('tab', { name: /^Clips/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(cards(s.page)).toHaveCount(9);
    // and from the toast's View action
    await s.state.notify!({
      id: 'n-toast',
      kind: 'job',
      level: 'success',
      title: 'Clipping finished',
      body: null,
      href: '/library/video?id=vid-podcast',
      createdAt: Date.now(),
      readAt: null,
    });
    await s.page.getByRole('button', { name: 'View' }).first().click();
    await expect(s.page).toHaveURL(/id=vid-podcast$/);
    expect(s.problems).toEqual([]);
    await s.close();
  });
});

test('layouts hold at 1280 wide and ultrawide (no horizontal overflow)', async () => {
  for (const [w, hh] of [
    [1280, 720],
    [2560, 1200],
  ] as const) {
    for (const route of [
      '/',
      '/library/?tab=clips',
      '/library/video/?id=vid-interview',
      '/library/video/?id=vid-processing',
    ]) {
      const s = await open(route, { scenario: 'library', width: w, height: hh, settle: 800 });
      const overflow = await s.page.evaluate(() => {
        const m = document.querySelector('main')!;
        return m.scrollWidth - m.clientWidth;
      });
      expect(overflow, `${route} @${w}`).toBeLessThanOrEqual(1);
      expect(s.problems).toEqual([]);
      await s.close();
    }
  }
});
