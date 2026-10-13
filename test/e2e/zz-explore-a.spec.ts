import path from 'node:path';
import { test } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const SHOTS = '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/shots-cp2a';
let h: Harness;
test.skip(!canRun());
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarness();
});
test.afterAll(async () => h?.close());

test('explore2', async () => {
  test.setTimeout(240_000);
  const grab = async (route: string, name: string, extra?: (s: any) => Promise<void>) => {
    const s = await h.open(route, { scenario: 'library', settle: 1500 });
    if (extra) await extra(s);
    await s.page.screenshot({ path: path.join(SHOTS, `x-${name}.png`), fullPage: false });
    console.log(name, s.problems);
    await s.close();
  };
  await grab('/tools/summary/', 'picker');
  await grab('/tools/summary/?video=vid-interview', 'summary');
  await grab('/tools/transcripts/?video=vid-interview', 'transcripts');
  await grab('/tools/reframe/?video=vid-interview', 'reframe');
  await grab('/tools/hook/?video=vid-interview', 'hook');
  await grab('/tools/find-moments/?video=vid-interview', 'moments');
  await grab('/', 'home');
});
