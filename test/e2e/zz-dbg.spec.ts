import { test } from '@playwright/test';
import { createHarness, doc, makeProject, textItem, track, videoItem, MEDIA_FILES } from './support/playback-harness';
test('dbg', async () => {
  test.setTimeout(120000);
  const h = await createHarness();
  const s = await h.open({ bridge: { previewUrls: MEDIA_FILES as never } });
  const project = makeProject({ tracks: [track('video', [videoItem()], { speech: true }), track('overlay', [textItem({ id: 'title' })])] });
  await s.page.evaluate((d) => (window as any).__t.load(d), doc(project));
  await s.page.evaluate(() => (window as any).__t.store.getState().setPlayhead(1));
  await s.page.waitForTimeout(1500);
  await s.page.screenshot({ path: '/tmp/claude-0/-home-user-Claude-code/389612c4-f895-58c2-a3c2-02cb884e9ba1/scratchpad/editor-playback-work/dbg1.png' });
  const info = await s.page.evaluate(() => {
    const eng = (window as any).__t.getEngine();
    return { px: eng.debugReadPixels() ? [eng.debugReadPixels().width, eng.debugReadPixels().height] : null };
  });
  const hit = await s.page.evaluate(() => {
    const eng = (window as any).__t.getEngine();
    const c = eng.compositor;
    const out: any = {};
    const px = eng.debugReadPixels();
    for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.5], [0.6, 0.5], [0.5, 0.45], [0.15, 0.9]]) out[`${fx},${fy}`] = c.hitTest(1, fx * px.width, fy * px.height);
    out.handles = c.handlesFor(1, 'title');
    return out;
  });
  console.log(JSON.stringify(info), JSON.stringify(hit), s.problems);
  await h.close();
});
