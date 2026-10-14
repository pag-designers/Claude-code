import { test } from '@playwright/test';
import { canRun, createHarness, type Harness } from './support/harness';
import { openEditor, laneXY, itemBox } from './support/editor-timeline-harness';

let h: Harness;
test.skip(!canRun(), 'needs chromium + build');
test.beforeAll(async () => { h = await createHarness(); });
test.afterAll(async () => { await h?.close(); });

const frames = (p: import('@playwright/test').Page, hideCentre: boolean) => p.evaluate(async (hide) => {
  if (hide) (document.querySelector('[data-testid=centre]') as HTMLElement).style.display = 'none';
  const scroller = document.querySelector('[data-testid="timeline-scroller"]') as HTMLElement;
  const st = window.__clipfernEditorStore!.getState() as unknown as { setZoom(px: number, a?: number): void };
  st.setZoom(100, 0);
  await new Promise((r) => setTimeout(r, 300));
  const f: number[] = []; let last = performance.now(); let n = 0;
  await new Promise<void>((res) => { const tick = (now: number) => { f.push(now - last); last = now; n++; scroller.scrollLeft = (n / 120) * 60000; if (n >= 120) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const s = f.slice(5).sort((a, b) => a - b);
  return { median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}, hideCentre);

test('perf split', async () => {
  test.setTimeout(180_000);
  for (const id of ['tl-demo', 'tl-big']) {
    const s = await openEditor(h, (r, o) => h.open(r, o), id);
    console.log(id, 'with preview', JSON.stringify(await frames(s.page, false)));
    console.log(id, 'preview hidden', JSON.stringify(await frames(s.page, true)));
    await s.close();
  }
});

test('debug a11y + paste', async () => {
  test.setTimeout(120_000);
  const s = await openEditor(h, (r, o) => h.open(r, o), 'tl-plain');
  const p = s.page;
  await p.keyboard.press('Tab');
  await p.locator('[data-item-id=v1][role=option]').focus();
  await p.keyboard.press('ArrowRight');
  await p.locator('[data-item-id=v1][role=option]').click();
  console.log('active', await p.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.itemId + ' fv=' + document.activeElement?.matches(':focus-visible')));
  const t0 = (await s.store()).playheadSec;
  await p.keyboard.press('ArrowRight');
  console.log('playhead', t0, (await s.store()).playheadSec, (await s.store()).selection.itemIds);
  // paste
  await p.locator('[data-item-id=hook][role=option]').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Copy' }).click();
  console.log('clip', JSON.stringify(((await s.store()) as any).clipboard)?.slice(0, 120));
  await s.act('setPlayhead', 15);
  const lane = await laneXY(p, 'tr_text', 20);
  await p.mouse.click(lane.x, lane.y, { button: 'right' });
  await p.getByRole('menuitem', { name: 'Paste' }).click();
  const st = await s.store();
  console.log('text items', st.project.tracks.find((t) => t.id === 'tr_text')!.items.map((i) => i.id + '@' + i.startSec), st.undoLabel, st.selection);
  await s.close();
});
