import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openInspectorLab, type LabSession } from './support/editor-stub-inspector';
import { LAB_IDS } from './support/inspector-lab/lab-project';

/**
 * Screenshots of every Inspector panel, dark + light (for design review). Writes PNGs to INSPECTOR_SHOTS (skipped when
 * unset):  INSPECTOR_SHOTS=<dir> CLIPFERN_E2E_OUT=<lab export> npx playwright test test/e2e/editor-inspector-shots.spec.ts
 */
const DIR = process.env.INSPECTOR_SHOTS;
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });
test.skip(!canRun() || !DIR, 'needs a lab export and INSPECTOR_SHOTS');

let h: Harness;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarness();
  if (DIR) fs.mkdirSync(DIR, { recursive: true });
});
test.afterAll(async () => {
  await h?.close();
});

const tab = (p: Page, id: string) => p.getByTestId(`tab-${id}`).click();

async function shot(s: LabSession, name: string, theme: string) {
  await s.page.waitForTimeout(350);
  await s.page
    .getByTestId('inspector')
    .screenshot({ path: path.join(DIR!, `${name}-${theme}.png`) });
}

async function keyframe(s: LabSession, id: string, prop: string, kfs: [number, number][]) {
  await s.select(id);
  for (const [t, v] of kfs) {
    await s.setPlayhead(t);
    await s.read(
      (st, a) =>
        (st as unknown as { setProp: (...x: unknown[]) => void }).setProp(a.id, a.prop, a.v, {
          forceKeyframe: true,
        }),
      { id, prop, v },
    );
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`inspector panels (${theme})`, async () => {
    const s = await openInspectorLab(h, { theme, height: 1500, width: 900 });
    const p = s.page;
    await shot(s, '01-empty', theme);

    await keyframe(s, 'v1', 'transform.opacity', [
      [0, 1],
      [3, 0.55],
      [7, 0.9],
    ]);
    await s.setPlayhead(3);
    await shot(s, '02-video', theme);
    await p.getByTestId('kf-chip-transform.opacity').click();
    await s.read((st) =>
      (st as unknown as { selectKeyframe: (k: unknown) => void }).selectKeyframe({
        itemId: 'v1',
        prop: 'transform.opacity',
        index: 1,
      }),
    );
    await p.getByRole('radio', { name: 'Bezier' }).click();
    await shot(s, '03-keyframe-bezier', theme);
    await s.read((st) =>
      (st as unknown as { selectKeyframe: (k: unknown) => void }).selectKeyframe(null),
    );

    await tab(p, 'speed');
    await p.getByRole('radio', { name: 'Speed ramp' }).click();
    await p.getByTestId('ramp-bullet').click();
    await shot(s, '04-speed-ramp', theme);

    await tab(p, 'audio');
    await shot(s, '05-audio', theme);
    await tab(p, 'colour');
    await p.getByTestId('filter-warm').click();
    await shot(s, '06-colour', theme);
    await tab(p, 'reframe');
    await p.getByTestId('face-track').click();
    await p
      .getByTestId('reframe-status')
      .getByText(/face found/)
      .waitFor();
    await s.setPlayhead(3.1);
    await shot(s, '07-reframe', theme);

    await s.select(LAB_IDS.v2);
    await tab(p, 'video');
    await p.getByTestId('transition-whip-pan').click();
    await shot(s, '08-video-v2-transition', theme);

    await s.select(LAB_IDS.t1);
    await shot(s, '09-text', theme);
    await tab(p, 'style');
    await p.getByTestId('stroke-enabled').click();
    await p.getByTestId('shadow-enabled').click();
    await shot(s, '10-text-style', theme);
    await tab(p, 'motion');
    await p.getByTestId('anim-animIn').click();
    await p.getByRole('option', { name: 'Bounce' }).click();
    await shot(s, '11-text-motion', theme);

    await s.select(LAB_IDS.c1);
    await s.setPlayhead(1.6);
    await p.getByLabel('Word 2 highlight: pick colour').click();
    await p.getByRole('button', { name: 'Word 2 highlight: orange' }).click();
    await p.keyboard.press('Escape');
    await shot(s, '12-subtitle-words', theme);
    await tab(p, 'style');
    await p.waitForTimeout(1500); // libass preview
    await shot(s, '13-subtitle-style', theme);
    await tab(p, 'timing');
    await shot(s, '14-subtitle-timing', theme);

    await s.select(LAB_IDS.m1);
    await p.getByTestId('detect-beats').click();
    await p.getByTestId('beats-status').getByText(/BPM/).waitFor();
    await shot(s, '15-audio-clip', theme);
    await s.select(LAB_IDS.s1);
    await shot(s, '16-shape', theme);
    await s.read((st) =>
      (st as unknown as { selectTrack: (id: string) => void }).selectTrack('tr_music'),
    );
    await p.getByTestId('duck-enabled').click();
    await shot(s, '17-track', theme);
    await s.close();
  });
}
