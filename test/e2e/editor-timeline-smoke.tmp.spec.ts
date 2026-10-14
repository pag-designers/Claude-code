import path from 'node:path';
import { test } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openEditor } from './support/editor-timeline-harness';

let h: Harness;
test.skip(!canRun(), 'needs chromium + build');
test.beforeAll(async () => { h = await createHarness(); });
test.afterAll(async () => { await h?.close(); });

test('smoke', async () => {
  test.setTimeout(120_000);
  const s = await openEditor(h, (r, o) => h.open(r, o));
  await s.page.waitForTimeout(1500);
  await s.page.screenshot({ path: path.join(process.env.SHOTS ?? '/tmp', 'smoke.png') });
  console.log('PROBLEMS', JSON.stringify(s.problems, null, 1));
  await s.close();
});
