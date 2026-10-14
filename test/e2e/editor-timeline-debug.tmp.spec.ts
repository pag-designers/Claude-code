import path from 'node:path';
import { test } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openEditor, laneXY } from './support/editor-timeline-harness';

let h: Harness;
test.skip(!canRun(), 'needs chromium + build');
test.beforeAll(async () => { h = await createHarness(); });
test.afterAll(async () => { await h?.close(); });

test('debug trim', async () => {
  test.setTimeout(120_000);
  const s = await openEditor(h, (r, o) => h.open(r, o));
  const p = s.page;
  const end = await laneXY(p, 'tr_text', 4.0);
  console.log('end', JSON.stringify(end));
  const el = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x - 3, y) as HTMLElement; return e ? e.outerHTML.slice(0, 200) : null; }, [end.x, end.y] as const);
  console.log('element at handle:', el);
  console.log('children', await p.evaluate(() => Array.from(document.querySelector('[data-item-id=hook][role=option]')!.children).map((c) => c.className + '|' + JSON.stringify((c as HTMLElement).getBoundingClientRect()))));
  console.log('item rect', JSON.stringify(await p.locator('[data-item-id=hook][role=option]').boundingBox()));
  await p.mouse.move(end.x - 3, end.y);
  await p.mouse.down();
  await p.mouse.move(end.x + 60, end.y, { steps: 6 });
  console.log('ghost count', await p.getByTestId('trim-ghost').count());
  console.log('ui', await p.evaluate(() => document.querySelector('[data-testid=timeline]')?.outerHTML.length));
  await p.screenshot({ path: path.join(process.env.SHOTS ?? '/tmp', 'dbg.png') });
  await p.mouse.up();
  console.log('PROBLEMS', JSON.stringify(s.problems.filter((x) => !/GL Driver/.test(x)), null, 1));
  await s.close();
});
