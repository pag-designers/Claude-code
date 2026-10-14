import { expect, test, type Locator, type Page } from '@playwright/test';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { editorState } from './support/editor-stub-panels';
import { bigProject } from './support/editor-stub';
import {
  itemBox,
  laneXY,
  openEditor,
  type EditorSession,
} from './support/editor-timeline-harness';

/**
 * CP3 editor SHELL + TIMELINE behaviour against the REAL exported renderer. `window.clipfern` is the contract-validating
 * stub (every request / response / pushed event is checked against shared/ipc.ts); the editor store is the real one.
 *   CLIPFERN_E2E_OUT=<private snapshot of the static export> xvfb-run -a npx playwright test test/e2e/editor-timeline.spec.ts
 * Every session also asserts: zero console errors/warnings (except Chromium's software-GL "GPU stall" notices from the
 * preview compositor), zero external requests, zero HTTP >= 400.
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built renderer/out');
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = (route: string, opts: OpenOptions = {}) => h.open(route, { settle: 0, ...opts });
const edit = (id = 'tl-demo', opts: Parameters<typeof openEditor>[3] = {}) => openEditor(h, open, id, opts);

/** Console noise that is not ours: the preview's software-GL readback warning in headless Chromium. */
const realProblems = (s: { problems: string[] }) => s.problems.filter((p) => !/GL Driver Message|GPU stall/.test(p));

const tracksOf = (page: Page) => page.getByTestId('track-row');
const ids = (page: Page) => tracksOf(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.trackId));
const item = (page: Page, id: string) => page.locator(`[data-testid="timeline"] [data-item-id="${id}"][role="option"]`);

/** Real mouse drag of a clip body (never its trim handles). `release: false` keeps the button down. */
async function dragBy(page: Page, id: string, dxPx: number, dyPx = 0, opts: { release?: boolean; steps?: number; hold?: number } = {}) {
  const b = await itemBox(page, id);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = opts.steps ?? 8;
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dxPx * i) / steps, y + (dyPx * i) / steps);
  if (opts.hold) await page.waitForTimeout(opts.hold);
  if (opts.release !== false) await page.mouse.up();
  return { x: x + dxPx, y: y + dyPx };
}

/** Drops a media-bin asset payload (the same JSON the bin writes) at a client point. */
async function dropAsset(page: Page, assetId: string, x: number, y: number, mime = 'application/x-clipfern-asset', payload?: string) {
  await page.evaluate(
    ([a, px, py, m, p]) => {
      const target = document.elementFromPoint(px as number, py as number) ?? document.body;
      const dt = new DataTransfer();
      dt.setData(m as string, (p as string) || JSON.stringify({ assetId: a }));
      const fire = (type: string) =>
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: px as number, clientY: py as number, dataTransfer: dt }));
      fire('dragenter');
      fire('dragover');
      fire('drop');
    },
    [assetId, x, y, mime, payload ?? ''] as const,
  );
}

const frame = (fps = 30) => 1 / fps;
const near = (a: number, b: number, eps = 1 / 30 + 1e-6) => Math.abs(a - b) <= eps;

/* ============================================================================================ */

test.describe('open, layout, save state', () => {
  test('opens a project: tracks in z-order, items, top bar, save chip, back to the Library', async () => {
    const s = await edit();
    const p = s.page;
    // display order: visual tracks top-most = highest z (reverse array order), then audio / sfx in order
    expect(await ids(p)).toEqual(['tr_text', 'tr_sub', 'tr_image', 'tr_overlay', 'tr_video', 'tr_music', 'tr_sfx']);
    await expect(p.getByTestId('project-name')).toHaveValue('Morning habits — rough cut');
    await expect(p.getByTestId('save-state')).toContainText(/^Saved/);
    await expect(p.getByTestId('timecode')).toHaveText('00:00:00');
    await expect(p.getByTestId('timecode-total')).toHaveText('/ 00:42:00');
    // every item type is drawn
    for (const id of ['v1', 'v2', 'pip', 'logo', 'bar', 'cue_0', 'hook', 'music', 'sfx1']) await expect(item(p, id)).toBeVisible();
    expect(await item(p, 'cue_0').getAttribute('data-type')).toBe('subtitle');
    // fit-to-view on open: the whole project is visible
    const st = await s.store();
    expect(st.scrollSec).toBe(0);
    expect(st.pxPerSec * 42).toBeLessThanOrEqual(1300);
    expect(st.pxPerSec * 42).toBeGreaterThan(900);
    // the three docks the other engineers own are mounted in the layout
    await expect(p.getByTestId('media-bin')).toBeVisible();
    await expect(p.getByTestId('dock-right')).toBeVisible();
    await expect(p.getByTestId('transport-bar')).toBeVisible();
    // back goes to the Library's Edited tab
    await p.getByTestId('back-to-library').click();
    await expect(p).toHaveURL(/\/library\/\?tab=edited/);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('an unknown project id shows a recoverable error; no id shows the project picker', async () => {
    const s = await edit('does-not-exist', { expect: 'error' });
    await expect(s.page.getByTestId('editor-error')).toContainText('no longer exists');
    expect(realProblems(s).filter((p) => !/404|NOT_FOUND|no longer exists/i.test(p))).toEqual([]);
    await s.close();
    const t = await open('/editor/', { scenario: 'library', prepare: (st) => void import('./support/editor-stub').then((m) => m.seedTimeline(st, { big: false })) });
    await expect(t.page.getByTestId('project-picker')).toBeVisible();
    await expect(t.page.getByRole('link', { name: /Morning habits/ })).toBeVisible();
    await t.close();
  });

  test('resizable panes persist their sizes (drag + keyboard) across a reload', async () => {
    const s = await edit();
    const p = s.page;
    const tl = p.getByTestId('dock-timeline');
    const before = (await tl.boundingBox())!.height;
    const sep = p.getByRole('separator', { name: 'Resize timeline' });
    const sb = (await sep.boundingBox())!;
    await p.mouse.move(sb.x + sb.width / 2 + 200, sb.y + 1);
    await p.mouse.down();
    await p.mouse.move(sb.x + 200, sb.y - 80, { steps: 6 });
    await p.mouse.up();
    const grown = (await tl.boundingBox())!.height;
    expect(grown).toBeGreaterThan(before + 60);
    // keyboard: arrow up grows by 16 px, Shift 64 px
    await sep.focus();
    await p.keyboard.press('ArrowUp');
    expect(Math.round((await tl.boundingBox())!.height - grown)).toBe(16);
    // left dock
    const left = p.getByRole('separator', { name: 'Resize media bin' });
    await left.focus();
    const w0 = (await p.getByTestId('dock-left').boundingBox())!.width;
    await p.keyboard.press('Shift+ArrowRight');
    expect(Math.round((await p.getByTestId('dock-left').boundingBox())!.width - w0)).toBe(64);
    const saved = await p.evaluate(() => localStorage.getItem('clipfern.editor.layout.v1'));
    expect(JSON.parse(saved!).left).toBeGreaterThan(300);
    // reload: sizes come back
    const h1 = (await tl.boundingBox())!.height;
    await p.reload();
    await p.getByTestId('editor-workspace').waitFor();
    expect(Math.abs((await p.getByTestId('dock-timeline').boundingBox())!.height - h1)).toBeLessThan(2);
    // double-click resets to the automatic size
    await p.getByRole('separator', { name: 'Resize timeline' }).dblclick();
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('clipfern.editor.layout.v1')!).timeline)).toBeNull();
    // a hidden dock stays hidden
    await p.getByRole('button', { name: 'Toggle inspector' }).click();
    await expect(p.getByTestId('dock-right')).toHaveCount(0);
    await s.close();
  });
});

test.describe('assets: drag from the media bin', () => {
  test('dropping an asset on a track adds it at the (snapped) drop time and selects it', async () => {
    const s = await edit('tl-empty');
    const p = s.page;
    expect((await s.store()).project.tracks.flatMap((t) => t.items)).toHaveLength(0);
    const { x, y } = await laneXY(p, 'tr_video', 6.04);
    await dropAsset(p, 'as_interview', x, y);
    const st = await s.store();
    const video = st.project.tracks.find((t) => t.id === 'tr_video')!;
    expect(video.items).toHaveLength(1);
    expect(video.items[0]!.type).toBe('video');
    expect(near(video.items[0]!.startSec, 6.04, 1 / 30)).toBe(true);
    expect(st.selection.itemIds).toEqual([video.items[0]!.id]);
    expect(st.undoLabel).toBe('Add clip');
    await expect(p.getByTestId('timeline').locator('[data-type="video"]')).toHaveCount(1);
    // an audio asset dropped on the music track
    const m = await laneXY(p, 'tr_music', 2);
    await dropAsset(p, 'as_music', m.x, m.y);
    expect((await s.store()).project.tracks.find((t) => t.id === 'tr_music')!.items).toHaveLength(1);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('shows the drop line while hovering, the "new track" slot below the last track, and creates the track', async () => {
    const s = await edit('tl-empty');
    const p = s.page;
    const { x, y } = await laneXY(p, 'tr_video', 3);
    await p.evaluate(
      ([px, py]) => {
        const target = document.elementFromPoint(px as number, py as number)!;
        const dt = new DataTransfer();
        dt.setData('application/x-clipfern-asset', JSON.stringify({ assetId: 'as_broll' }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: px as number, clientY: py as number, dataTransfer: dt }));
      },
      [x, y] as const,
    );
    await expect(p.getByTestId('drop-line')).toBeVisible();
    await expect(p.locator('[data-testid="track-row"][data-track-id="tr_video"] [data-drop="true"]')).toHaveCount(1);
    // below the last track
    const last = (await p.locator('[data-testid="track-row"]').last().boundingBox())!;
    const by = last.y + last.height + 20;
    await p.evaluate(
      ([px, py]) => {
        const target = document.elementFromPoint(px as number, py as number)!;
        const dt = new DataTransfer();
        dt.setData('application/x-clipfern-asset', JSON.stringify({ assetId: 'as_broll' }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: px as number, clientY: py as number, dataTransfer: dt }));
      },
      [x, by] as const,
    );
    await expect(p.getByTestId('drop-new-track')).toBeVisible();
    const beforeIds = (await s.store()).project.tracks.map((t) => t.id);
    await dropAsset(p, 'as_broll', x, by);
    const st = await s.store();
    expect(st.project.tracks).toHaveLength(beforeIds.length + 1);
    const created = st.project.tracks.find((t) => !beforeIds.includes(t.id))!;
    expect(created.kind).toBe('overlay'); // a video asset dropped in the empty zone becomes an overlay track
    expect(created.items).toHaveLength(1);
    await expect(p.getByTestId('drop-new-track')).toHaveCount(0);
    await s.close();
  });

  test('a locked track refuses the drop with a message; OS files point to the media bin; junk payloads are ignored', async () => {
    const s = await edit('tl-empty');
    const p = s.page;
    await s.act('updateTrack', 'tr_video', { locked: true });
    const { x, y } = await laneXY(p, 'tr_video', 3);
    await dropAsset(p, 'as_interview', x, y);
    await expect(p.getByText('Video is locked.')).toBeVisible();
    expect((await s.store()).project.tracks.find((t) => t.id === 'tr_video')!.items).toHaveLength(0);
    // a dropped file (no asset payload)
    await p.evaluate(
      ([px, py]) => {
        const target = document.elementFromPoint(px as number, py as number)!;
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: px as number, clientY: py as number, dataTransfer: dt }));
      },
      [x, y] as const,
    );
    await expect(p.getByText(/Import files with the Media bin/)).toBeVisible();
    // an unknown asset id
    await s.act('updateTrack', 'tr_video', { locked: false });
    await dropAsset(p, 'nope', x, y);
    await expect(p.getByText('That media is not part of this project.')).toBeVisible();
    expect((await s.store()).project.tracks.flatMap((t) => t.items)).toHaveLength(0);
    // an unrelated payload type does nothing at all
    await dropAsset(p, 'x', x, y, 'text/plain', 'hello');
    expect((await s.store()).project.tracks.flatMap((t) => t.items)).toHaveLength(0);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('a transition tile dropped between two clips applies to the later clip', async () => {
    const s = await edit();
    const p = s.page;
    expect((await s.item('v4'))!).toMatchObject({ transitionIn: null });
    // right half of v3 -> joins v3 with v4 (the later clip)
    const b = await itemBox(p, 'v3');
    await dropAsset(p, '', b.x + b.width * 0.8, b.y + b.height / 2, 'application/x-clipfern-transition', JSON.stringify({ type: 'dip-black' }));
    const v4 = (await s.item('v4')) as { transitionIn: { type: string; durationSec: number } | null; startSec: number };
    expect(v4.transitionIn?.type).toBe('dip-black');
    expect(v4.transitionIn!.durationSec).toBeGreaterThan(0.04);
    expect((await s.store()).undoLabel).toBe('Set transition');
    await expect(p.locator('[data-transition="v4"]')).toBeVisible();
    // not over a clip: a hint, no change
    const e = await laneXY(p, 'tr_text', 20);
    await dropAsset(p, '', e.x, e.y, 'application/x-clipfern-transition', JSON.stringify({ type: 'zoom' }));
    await expect(p.getByText(/needs two neighbouring clips/)).toBeVisible();
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });
});

test.describe('move / trim / split / delete', () => {
  test('moving a clip snaps to a neighbouring edge, shows the guide, and commits ONE undo step on release', async () => {
    const s = await edit();
    const p = s.page;
    await s.act('setPlayhead', 1);
    const px = (await s.store()).pxPerSec;
    // v4 starts at 33; v3 ends at 32. Drag it left by 1.12 s: the raw start (31.88) is within 8 px of 32.
    await dragBy(p, 'v4', -1.12 * px, 0, { release: false });
    const guide = p.getByTestId('snap-guide');
    await expect(guide).toBeVisible();
    expect(Number(await guide.getAttribute('data-t'))).toBeCloseTo(32, 5);
    expect(await guide.getAttribute('data-kind')).toBe('item');
    const ghost = p.getByTestId('move-ghost').first();
    await expect(ghost).toHaveAttribute('data-valid', 'true');
    // nothing changed yet (the drag is a preview)
    expect((await s.item('v4'))!.startSec).toBe(33);
    expect((await s.store()).canUndo).toBe(false);
    await p.mouse.up();
    await expect(guide).toHaveCount(0);
    const st = await s.store();
    expect((await s.item('v4'))!.startSec).toBeCloseTo(32, 5);
    expect(st.undoLabel).toBe('Move');
    // one step: a single undo restores it
    await s.act('undo');
    expect((await s.item('v4'))!.startSec).toBe(33);
    expect((await s.store()).canUndo).toBe(false);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('Ctrl while dragging bypasses snapping; the toolbar switch turns it off for good', async () => {
    const s = await edit();
    const p = s.page;
    const px = (await s.store()).pxPerSec;
    await p.keyboard.down('Control');
    await dragBy(p, 'v4', -1.12 * px);
    await p.keyboard.up('Control');
    const start = (await s.item('v4'))!.startSec;
    expect(start).toBeGreaterThan(31.8);
    expect(start).toBeLessThan(32);
    await s.act('undo');
    await p.getByRole('button', { name: 'Snapping' }).click();
    expect((await s.store()).snapEnabled).toBe(false);
    await dragBy(p, 'v4', -1.12 * px, 0, { release: false });
    await expect(p.getByTestId('snap-guide')).toHaveCount(0);
    await p.mouse.up();
    expect((await s.item('v4'))!.startSec).toBeLessThan(32);
    await s.close();
  });

  test('an overlapping drop is shown as invalid and changes nothing', async () => {
    const s = await edit();
    const p = s.page;
    const px = (await s.store()).pxPerSec;
    await dragBy(p, 'v4', -3 * px, 0, { release: false });
    await expect(p.getByTestId('move-ghost').first()).toHaveAttribute('data-valid', 'false');
    await p.mouse.up();
    expect((await s.item('v4'))!.startSec).toBe(33);
    expect((await s.store()).canUndo).toBe(false);
    // wrong track kind: a caption cannot be dropped on the video track
    const to = await laneXY(p, 'tr_video', 36);
    const b = await itemBox(p, 'cue_20');
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y, { steps: 8 });
    await expect(p.getByTestId('move-ghost').first()).toHaveAttribute('data-valid', 'false');
    await p.keyboard.press('Escape'); // Esc cancels the gesture
    await p.mouse.up();
    await expect(p.getByTestId('move-ghost')).toHaveCount(0);
    expect((await s.store()).canUndo).toBe(false);
    await s.close();
  });

  test('a clip can be dragged to another compatible track', async () => {
    const s = await edit();
    const p = s.page;
    const pxs = (await s.store()).pxPerSec;
    // overlay "pip2" (22–27) -> the video track after its last clip (v4 ends at 42), i.e. +21 s
    const b = await itemBox(p, 'pip2');
    const to = await laneXY(p, 'tr_video', 22 + 21.5 + 2.5);
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y, { steps: 10 });
    await expect(p.getByTestId('move-ghost').first()).toHaveAttribute('data-valid', 'true');
    await p.mouse.up();
    const st = await s.store();
    expect(st.project.tracks.find((t) => t.id === 'tr_video')!.items.map((i) => i.id)).toContain('pip2');
    expect(st.project.tracks.find((t) => t.id === 'tr_overlay')!.items.map((i) => i.id)).not.toContain('pip2');
    expect(pxs).toBeGreaterThan(0);
    await s.close();
  });

  test('trim: dragging the end handle changes the duration; snaps to the playhead; Esc cancels', async () => {
    const s = await edit();
    const p = s.page;
    await s.act('setPlayhead', 6);
    // hook: 0.5–4.0, text track
    const end = await laneXY(p, 'tr_text', 4.0);
    await p.mouse.move(end.x - 3, end.y);
    await p.mouse.down();
    const target = await laneXY(p, 'tr_text', 6.1);
    await p.mouse.move(target.x, end.y, { steps: 8 });
    await expect(p.getByTestId('trim-ghost')).toBeVisible();
    await expect(p.getByTestId('snap-guide')).toHaveAttribute('data-kind', 'playhead');
    expect((await s.item('hook'))!.durationSec).toBe(3.5); // preview only
    await p.mouse.up();
    const hook = (await s.item('hook'))!;
    expect(hook.startSec).toBe(0.5);
    expect(hook.startSec + hook.durationSec).toBeCloseTo(6, 5);
    expect((await s.store()).undoLabel).toBe('Trim end');
    await s.act('undo');
    // Esc during a trim drag cancels it
    await p.mouse.move(end.x - 3, end.y);
    await p.mouse.down();
    await p.mouse.move(end.x + 90, end.y, { steps: 5 });
    await p.keyboard.press('Escape');
    await p.mouse.up();
    expect((await s.item('hook'))!.durationSec).toBe(3.5);
    await s.close();
  });

  test('trim start keeps the content in place; media cannot be extended past its source', async () => {
    const s = await edit();
    const p = s.page;
    await p.getByRole('button', { name: 'Snapping' }).click(); // exact numbers
    // v3: 20–32, inSec 20, speed 1.5. Dragging the start 2 s to the right: start 22, inSec 23
    const start = await laneXY(p, 'tr_video', 20);
    const to = await laneXY(p, 'tr_video', 22);
    await p.mouse.move(start.x + 3, start.y);
    await p.mouse.down();
    await p.mouse.move(to.x + 3, start.y, { steps: 6 });
    await p.mouse.up();
    const v3 = (await s.item('v3')) as { startSec: number; durationSec: number; inSec: number };
    expect(near(v3.startSec, 22, 0.05)).toBe(true);
    expect(near(v3.inSec, 20 + (v3.startSec - 20) * 1.5, 0.05)).toBe(true);
    expect(near(v3.startSec + v3.durationSec, 32, 0.05)).toBe(true);
    // v4 (33–42, inSec 60) of a 120 s asset: trying to extend it 100 s to the right clamps at the asset's end only when
    // the source runs out; here the source allows 120-60 = 60 s so it grows until its limit
    const e = await laneXY(p, 'tr_video', 42);
    await p.mouse.move(e.x - 3, e.y);
    await p.mouse.down();
    await p.mouse.move(e.x + 400, e.y, { steps: 6 });
    await p.mouse.up();
    const v4 = (await s.item('v4'))!;
    expect(v4.startSec + v4.durationSec).toBeGreaterThan(42);
    expect(v4.startSec + v4.durationSec).toBeLessThanOrEqual(33 + 60 + 1e-6);
    await s.close();
  });

  test('ripple trim shifts everything after the edit; toggling ripple works from the transport bar and R', async () => {
    const s = await edit();
    const p = s.page;
    await p.getByRole('button', { name: 'Snapping' }).click();
    await p.getByRole('button', { name: 'Ripple edit' }).click();
    expect((await s.store()).rippleEnabled).toBe(true);
    const cue1 = (await s.item('cue_1'))!.startSec;
    const cue9 = (await s.item('cue_9'))!.startSec;
    const end = await laneXY(p, 'tr_sub', 0.4 + 1.55);
    const to = await laneXY(p, 'tr_sub', 0.4 + 1.55 - 0.5);
    await p.mouse.move(end.x - 3, end.y);
    await p.mouse.down();
    await p.mouse.move(to.x - 3, end.y, { steps: 6 });
    await expect(p.getByTestId('timeline').locator('text=Ripple').first()).toHaveCount(0); // label lives in the floating tag
    await p.mouse.up();
    const cue0 = (await s.item('cue_0'))!;
    expect(near(cue0.durationSec, 1.05, 0.05)).toBe(true);
    expect(near((await s.item('cue_1'))!.startSec, cue1 - 0.5, 0.06)).toBe(true);
    expect(near((await s.item('cue_9'))!.startSec, cue9 - 0.5, 0.06)).toBe(true);
    // R toggles it back off
    await p.keyboard.press('r');
    expect((await s.store()).rippleEnabled).toBe(false);
    await s.close();
  });

  test('S splits the selection at the playhead; the razor tool splits where you click; Delete / Ripple delete / Delete gaps', async () => {
    const s = await edit();
    const p = s.page;
    // S at the playhead
    await s.act('setPlayhead', 5);
    await item(p, 'v1').click();
    await p.keyboard.press('s');
    let video = (await s.store()).project.tracks.find((t) => t.id === 'tr_video')!;
    expect(video.items.filter((i) => i.startSec < 12).length).toBe(2);
    expect(video.items[0]!.durationSec).toBeCloseTo(5, 5);
    expect((await s.store()).undoLabel).toBe('Split');
    // razor: C toggles the tool, a click cuts the clip under the pointer
    await p.keyboard.press('c');
    await expect(p.getByTestId('timeline')).toHaveAttribute('data-tool', 'razor');
    const at = await laneXY(p, 'tr_video', 25);
    await p.mouse.move(at.x, at.y);
    await expect(p.getByTestId('razor-line')).toBeVisible();
    await p.mouse.click(at.x, at.y);
    video = (await s.store()).project.tracks.find((t) => t.id === 'tr_video')!;
    expect(video.items.some((i) => near(i.startSec, 25, 0.04))).toBe(true);
    await p.keyboard.press('v');
    await expect(p.getByTestId('timeline')).toHaveAttribute('data-tool', 'select');
    // Delete removes the selection
    await item(p, 'cue_3').click();
    const n = (await s.store()).project.tracks.find((t) => t.id === 'tr_sub')!.items.length;
    await p.keyboard.press('Delete');
    expect((await s.store()).project.tracks.find((t) => t.id === 'tr_sub')!.items).toHaveLength(n - 1);
    expect(await item(p, 'cue_3').count()).toBe(0);
    // Delete gaps on the selected track closes the 1 s hole before v4 (it starts at 33, v3 ends at 32)
    await p.getByRole('group', { name: /Video track header/ }).click({ position: { x: 90, y: 8 } });
    expect((await s.store()).selection.trackId).toBe('tr_video');
    await p.getByRole('button', { name: 'Delete gaps' }).click();
    expect((await s.item('v4'))!.startSec).toBeLessThan(33);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('undo / redo from the buttons and the keyboard, with their labels', async () => {
    const s = await edit();
    const p = s.page;
    await expect(p.getByTestId('undo')).toBeDisabled();
    await s.act('setPlayhead', 5);
    await item(p, 'v1').click();
    await p.keyboard.press('s');
    await expect(p.getByTestId('undo')).toBeEnabled();
    await expect(p.getByTestId('undo')).toHaveAccessibleName('Undo Split');
    await p.getByTestId('undo').click();
    expect((await s.store()).project.tracks.find((t) => t.id === 'tr_video')!.items.filter((i) => i.startSec < 12)).toHaveLength(1);
    await expect(p.getByTestId('redo')).toHaveAccessibleName('Redo Split');
    await p.keyboard.press('Control+Shift+Z');
    expect((await s.store()).project.tracks.find((t) => t.id === 'tr_video')!.items.filter((i) => i.startSec < 12)).toHaveLength(2);
    await p.keyboard.press('Control+z');
    expect((await s.store()).canRedo).toBe(true);
    // hover shows the label in a tooltip
    await p.getByTestId('redo').hover();
    await expect(p.getByRole('tooltip').first()).toContainText('Redo Split');
    await s.close();
  });
});

test.describe('selection', () => {
  test('click, shift / ctrl toggle, marquee, select all, click empty space clears', async () => {
    const s = await edit();
    const p = s.page;
    await item(p, 'v1').click();
    expect((await s.store()).selection.itemIds).toEqual(['v1']);
    await item(p, 'v3').click({ modifiers: ['Shift'] });
    expect(new Set((await s.store()).selection.itemIds)).toEqual(new Set(['v1', 'v3']));
    await item(p, 'v1').click({ modifiers: ['Control'] });
    expect((await s.store()).selection.itemIds).toEqual(['v3']);
    // marquee across the subtitle + image tracks
    const a = await laneXY(p, 'tr_sub', 0.05, 0.1);
    const row = await laneXY(p, 'tr_image', 7, 0.9);
    await p.mouse.move(a.x - 20, a.y);
    await p.mouse.down();
    await p.mouse.move(row.x, row.y, { steps: 8 });
    await expect(p.getByTestId('marquee')).toBeVisible();
    await p.mouse.up();
    const sel = new Set((await s.store()).selection.itemIds);
    expect(sel.has('cue_0')).toBe(true);
    expect(sel.has('cue_3')).toBe(true);
    expect(sel.has('logo')).toBe(true);
    expect(sel.has('v1')).toBe(false);
    expect(sel.has('cue_8')).toBe(false); // starts after 7 s
    await expect(p.getByTestId('marquee')).toHaveCount(0);
    // Ctrl+A selects everything, a click on empty lane space clears
    await p.keyboard.press('Control+a');
    expect((await s.store()).selection.itemIds.length).toBeGreaterThan(30);
    const empty = await laneXY(p, 'tr_text', 20);
    await p.mouse.click(empty.x, empty.y);
    expect((await s.store()).selection.itemIds).toEqual([]);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('groups show a stripe and a link icon; locked tracks are hatched and refuse edits', async () => {
    const s = await edit();
    const p = s.page;
    await item(p, 'cue_0').click();
    await item(p, 'cue_1').click({ modifiers: ['Shift'] });
    await p.keyboard.press('Control+g');
    await expect(item(p, 'cue_0').locator('[style*="--tl-group"]')).toHaveCount(1);
    await expect(item(p, 'cue_1').locator('[style*="--tl-group"]')).toHaveCount(1);
    // selecting one selects the group
    await p.mouse.click(5, 5);
    await item(p, 'cue_0').click();
    expect(new Set((await s.store()).selection.itemIds)).toEqual(new Set(['cue_0', 'cue_1']));
    // lock the track through its header: hatched, tooltip-labelled, and a drag is invalid
    await p.getByRole('button', { name: 'Lock Subtitles' }).click();
    await expect(p.locator('[data-testid="track-row"][data-track-id="tr_sub"] [data-locked="true"]').first()).toBeVisible();
    await expect(p.getByRole('button', { name: 'Lock Subtitles' })).toHaveAttribute('aria-pressed', 'true');
    const px = (await s.store()).pxPerSec;
    const before = (await s.item('cue_5'))!.startSec;
    await dragBy(p, 'cue_5', 2 * px);
    expect((await s.item('cue_5'))!.startSec).toBe(before);
    await s.close();
  });

  test('double-click edits a caption inline; Enter commits one undoable edit, Esc cancels', async () => {
    const s = await edit();
    const p = s.page;
    await item(p, 'cue_2').dblclick();
    const input = p.getByRole('textbox', { name: 'Caption text' });
    await expect(input).toBeFocused();
    await input.fill('Hello brand new words');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    expect(await item(p, 'cue_2').innerText()).not.toContain('Hello');
    await item(p, 'cue_2').dblclick();
    await p.getByRole('textbox', { name: 'Caption text' }).fill('Hello brand new words');
    await p.keyboard.press('Enter');
    await expect(item(p, 'cue_2')).toContainText('Hello brand new words');
    const cue = (await s.item('cue_2')) as { words: { w: string }[] };
    expect(cue.words.map((w) => w.w).join(' ')).toBe('Hello brand new words');
    expect((await s.store()).undoLabel).toBe('Edit caption');
    await s.close();
  });
});

/* ---- helper used by later groups ----------------------------------------------------------- */
export type { EditorSession, Locator };
export { editorState, bigProject, frame };
