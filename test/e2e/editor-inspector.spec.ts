import { expect, test, type Locator, type Page } from '@playwright/test';
import { sourceSpan } from '../../shared/editor-eval';
import { videoItemSchema } from '../../shared/editor';
import { canRun, createHarness, type Harness } from './support/harness';
import { openInspectorLab, type LabSession } from './support/editor-stub-inspector';
import { LAB_IDS } from './support/inspector-lab/lab-project';

/**
 * Inspector behaviour against the REAL exported renderer: the lab route mounts <Inspector/> over an editor store
 * (the real one when present, else the faithful fake of build-lab.sh) and the contract-validating `window.clipfern`
 * stub. Build the private export first, then:
 *   test/e2e/support/inspector-lab/build-lab.sh <work> <out>
 *   CLIPFERN_E2E_OUT=<out> npx playwright test test/e2e/editor-inspector.spec.ts
 * Every session also asserts zero console errors/warnings, zero external requests, zero HTTP >= 400.
 */
test.use({ trace: 'off', video: 'off', screenshot: 'off', actionTimeout: 10_000 });

let h: Harness;
test.skip(!canRun(), 'needs a Chromium binary and a built export (CLIPFERN_E2E_OUT)');
test.beforeAll(async () => {
  test.setTimeout(300_000);
  h = await createHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const open = (opts = {}) => openInspectorLab(h, opts);
const num = (p: Page, id: string): Locator => p.getByTestId(id).locator('input');
const tab = (p: Page, id: string) => p.getByTestId(`tab-${id}`).click();
const kfToggle = (p: Page, label: string) =>
  p.getByRole('button', { name: new RegExp(`keyframe: ${label}$`) });
type Anim = { v: number; kf: { t: number; v: number; ease: unknown }[] };
const tf = async (s: LabSession, id: string, key: string) =>
  (await s.item<{ transform: Record<string, Anim> }>(id)).transform[key] as Anim;

async function finish(s: LabSession) {
  expect(s.problems, s.problems.join('\n')).toEqual([]);
  await s.close();
}

/** After a gesture: ONE undo restores the whole project to `before` (so the gesture was a single history step). */
async function expectOneStep(s: LabSession, before: string) {
  expect(await s.snapshot()).not.toBe(before);
  await s.undoOnce();
  expect(await s.snapshot()).toBe(before);
  await s.read((st) => st.redo());
}

/** Drags a native range from `from` to `to` (0..1 of its width) in small steps (one gesture). */
async function dragRange(p: Page, loc: Locator, from: number, to: number) {
  const b = (await loc.boundingBox())!;
  const y = b.y + b.height / 2;
  await p.mouse.move(b.x + 8 + (b.width - 16) * from, y);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++)
    await p.mouse.move(b.x + 8 + (b.width - 16) * (from + ((to - from) * i) / 8), y);
  await p.mouse.up();
}

test.describe('empty state: project settings', () => {
  test('canvas aspect / size / fps / background / guides edit the project', async () => {
    const s = await open();
    const p = s.page;
    await expect(p.getByText('Select a clip to edit it')).toBeVisible();
    await p.getByRole('radio', { name: '1:1' }).click();
    expect(await s.read((st) => st.project.canvas)).toMatchObject({
      aspect: '1:1',
      width: 1080,
      height: 1080,
    });
    // size is locked until Custom
    await expect(num(p, 'canvas-width')).toBeDisabled();
    await p.getByRole('radio', { name: 'Custom' }).click();
    await num(p, 'canvas-width').fill('720');
    await num(p, 'canvas-width').press('Enter');
    expect(await s.read((st) => st.project.canvas)).toMatchObject({ aspect: 'custom', width: 720 });
    await p.getByTestId('canvas-fps').click();
    await p.getByRole('option', { name: '60 fps' }).click();
    expect(await s.read((st) => st.project.canvas.fps)).toBe(60);
    await p.getByTestId('safe-area').click();
    await p.getByRole('option', { name: 'TikTok' }).click();
    expect(await s.read((st) => st.safeArea)).toBe('tiktok');
    await p.getByRole('switch', { name: /grid/i }).click();
    expect(await s.read((st) => st.showGrid)).toBe(true);
    const hex = p.getByLabel('Canvas background hex');
    await hex.fill('#112233');
    await hex.blur();
    expect(await s.read((st) => st.project.canvas.background)).toBe('#112233');
    await finish(s);
  });
});

test.describe('number fields and sliders', () => {
  test('arrow keys, shift ×10, alt ×0.1, Enter commits, Esc reverts, clamps', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    const x = num(p, 'field-transform.x');
    await x.click();
    await x.press('ArrowUp');
    expect((await tf(s, 'v1', 'x')).v).toBe(1);
    await x.press('Shift+ArrowUp');
    expect((await tf(s, 'v1', 'x')).v).toBe(11);
    await x.press('Alt+ArrowDown');
    expect((await tf(s, 'v1', 'x')).v).toBe(10.9);
    await x.fill('42.5');
    await x.press('Enter');
    expect((await tf(s, 'v1', 'x')).v).toBe(42.5);
    await expect(x).not.toBeFocused();
    // Esc reverts the typed text without touching the store
    await x.click();
    await x.fill('999');
    await x.press('Escape');
    await expect(x).toHaveValue('42.5');
    expect((await tf(s, 'v1', 'x')).v).toBe(42.5);
    // clamped to the property range, units shown
    const op = num(p, 'field-transform.opacity');
    await op.fill('250');
    await op.press('Enter');
    expect((await tf(s, 'v1', 'opacity')).v).toBe(1);
    await expect(op).toHaveValue('100');
    await op.fill('-5');
    await op.press('Tab');
    expect((await tf(s, 'v1', 'opacity')).v).toBe(0);
    // text that is not a number is ignored
    await op.fill('abc');
    await op.press('Enter');
    expect((await tf(s, 'v1', 'opacity')).v).toBe(0);
    await finish(s);
  });

  test('scrubbing a field and dragging a slider are ONE undo step each', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    const d0 = await s.snapshot();
    const box = (await p.getByTestId('field-transform.x').boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    for (let i = 1; i <= 12; i++)
      await p.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2);
    await p.mouse.up();
    const x = (await tf(s, 'v1', 'x')).v;
    expect(x).toBeGreaterThan(40);
    await expectOneStep(s, d0);
    expect((await s.storeLog('setProp')).length).toBeGreaterThan(5); // many ticks, one step
    // shift scrubs ten times faster
    await p.keyboard.down('Shift');
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
    await p.mouse.up();
    await p.keyboard.up('Shift');
    expect((await tf(s, 'v1', 'x')).v - x).toBeGreaterThan(150);

    const d1 = await s.snapshot();
    await dragRange(p, p.getByTestId('slider-transform.opacity'), 1, 0.3);
    await expectOneStep(s, d1);
    expect((await tf(s, 'v1', 'opacity')).v).toBeCloseTo(0.3, 1);
    // undo restores everything the drag did
    await s.read((st) => st.undo());
    expect((await tf(s, 'v1', 'opacity')).v).toBe(1);
    await finish(s);
  });

  test('multi-selection edits every item in one undo step', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1, LAB_IDS.v2);
    await expect(p.getByTestId('inspector-title')).toHaveText('2 video items');
    const d0 = await s.snapshot();
    await dragRange(p, p.getByTestId('slider-transform.opacity'), 1, 0.4);
    expect((await tf(s, 'v1', 'opacity')).v).toBeCloseTo(0.4, 1);
    expect((await tf(s, 'v2', 'opacity')).v).toBeCloseTo(0.4, 1);
    await expectOneStep(s, d0);
    // differing values show as mixed, keyframes are single-clip only
    await s.select(LAB_IDS.v1);
    const op = num(p, 'field-transform.opacity');
    await op.fill('80');
    await op.press('Enter');
    await s.select(LAB_IDS.v1, LAB_IDS.v2);
    await expect(num(p, 'field-transform.opacity')).toHaveAttribute('placeholder', '—');
    await expect(p.getByRole('button', { name: /keyframe: Opacity/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // mixed types: only shared properties
    await s.select(LAB_IDS.v1, LAB_IDS.t1);
    await expect(p.getByTestId('inspector-subtitle')).toHaveText('Shared properties only');
    await expect(p.getByTestId('field-transform.x')).toBeVisible();
    await finish(s);
  });
});

test.describe('keyframes', () => {
  test('diamond adds / removes at the playhead, edits add keyframes, fields follow the animation', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await s.setPlayhead(2);
    const op = num(p, 'field-transform.opacity');
    await op.fill('50');
    await op.press('Enter');
    expect(await tf(s, 'v1', 'opacity')).toMatchObject({ v: 0.5, kf: [] });
    await kfToggle(p, 'Opacity').click();
    expect((await tf(s, 'v1', 'opacity')).kf).toEqual([{ t: 2, v: 0.5, ease: 'linear' }]);
    await expect(
      p.getByTestId('field-transform.opacity').locator('..').getByTestId('kf-toggle'),
    ).toHaveAttribute('data-state', 'on');
    // editing a keyframed property elsewhere on the clip adds a keyframe
    await s.setPlayhead(6);
    await op.fill('20');
    await op.press('Enter');
    expect((await tf(s, 'v1', 'opacity')).kf.map((k) => [k.t, k.v])).toEqual([
      [2, 0.5],
      [6, 0.2],
    ]);
    // the field shows the animated value at the playhead
    await s.setPlayhead(4);
    await expect(op).toHaveValue('35');
    await expect(
      p.getByTestId('field-transform.opacity').locator('..').getByTestId('kf-toggle'),
    ).toHaveAttribute('data-state', 'animated');
    // diamond between: adds a keyframe holding the CURRENT value, again: removes it
    await kfToggle(p, 'Opacity').click();
    expect((await tf(s, 'v1', 'opacity')).kf.map((k) => [k.t, k.v])).toEqual([
      [2, 0.5],
      [4, 0.35],
      [6, 0.2],
    ]);
    await kfToggle(p, 'Opacity').click();
    expect((await tf(s, 'v1', 'opacity')).kf).toHaveLength(2);
    // outside the clip the diamond is disabled with a reason
    await s.setPlayhead(12);
    await expect(p.getByRole('button', { name: /keyframe: Opacity/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // reset clears the animation in one step
    await s.setPlayhead(4);
    await p.getByRole('button', { name: 'Reset Opacity' }).click();
    expect(await tf(s, 'v1', 'opacity')).toMatchObject({ v: 1, kf: [] });
    await finish(s);
  });

  test('graph: drag a keyframe (one move, one undo step), easing picker, bezier editor', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    for (const [t, v] of [
      [0, '0'],
      [4, '300'],
      [8, '-100'],
    ] as const) {
      await s.setPlayhead(t);
      const x = num(p, 'field-transform.x');
      await x.fill(v);
      await x.press('Enter');
      if (t === 0) await kfToggle(p, 'Position X').click(); // first keyframe via the diamond
    }
    expect((await tf(s, 'v1', 'x')).kf).toHaveLength(3);
    // chips list what is animated; clicking one opens the curve
    await p.getByTestId('kf-chip-transform.x').click();
    const editor = p.getByTestId('selected-keyframe-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('graph-point')).toHaveCount(3);
    expect(await s.read((st) => st.selection.keyframe)).toEqual({
      itemId: 'v1',
      prop: 'transform.x',
      index: 0,
    });

    // drag the middle keyframe
    const pt = editor.getByTestId('graph-point').nth(1);
    const b = (await pt.boundingBox())!;
    const d0 = await s.snapshot();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 25, b.y + b.height / 2 - 20, { steps: 6 });
    await expect(editor.getByTestId('graph-readout')).toBeVisible();
    await p.mouse.up();
    const kf = (await tf(s, 'v1', 'x')).kf;
    expect(kf[1]!.t).toBeGreaterThan(4);
    expect(kf[1]!.v).toBeGreaterThan(300);
    await expectOneStep(s, d0);
    expect(await s.storeLog('moveKeyframe')).toHaveLength(1);
    expect(await s.read((st) => st.selection.keyframe?.index)).toBe(1);

    // the numeric fields move the selected keyframe too
    await num(p, 'kf-time').fill('5');
    await num(p, 'kf-time').press('Enter');
    expect((await tf(s, 'v1', 'x')).kf[1]!.t).toBe(5);

    // easing to the next keyframe
    await editor.getByRole('radio', { name: 'In', exact: true }).click();
    expect((await tf(s, 'v1', 'x')).kf[1]!.ease).toBe('ease-in');
    await editor.getByRole('radio', { name: 'Hold' }).click();
    expect((await tf(s, 'v1', 'x')).kf[1]!.ease).toBe('hold');
    await expect(p.getByTestId('bezier-editor')).toHaveCount(0);
    await editor.getByRole('radio', { name: 'Bezier' }).click();
    await expect(p.getByTestId('bezier-editor')).toBeVisible();
    const e1 = (await tf(s, 'v1', 'x')).kf[1]!.ease as Record<string, number | string>;
    expect(e1.type).toBe('bezier');

    // drag handle 1 of the bezier: ONE ease write for the whole gesture
    const eases0 = (await s.storeLog('setKeyframeEase')).length;
    const d1 = await s.snapshot();
    const hb = (await p.getByTestId('bezier-handle-1').boundingBox())!;
    await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await p.mouse.down();
    await p.mouse.move(hb.x + hb.width / 2 + 30, hb.y + hb.height / 2 - 40, { steps: 8 });
    await p.mouse.up();
    const e2 = (await tf(s, 'v1', 'x')).kf[1]!.ease as Record<string, number | string>;
    expect(e2.type).toBe('bezier');
    expect(e2.x1).not.toBe(e1.x1);
    expect(e2.y1 as number).toBeGreaterThan(e1.y1 as number);
    expect((await s.storeLog('setKeyframeEase')).length).toBe(eases0 + 1);
    await expectOneStep(s, d1);
    // numbers shown match what is stored
    await expect(num(p, 'bezier-x1')).toHaveValue(Number(e2.x1).toFixed(2));
    // presets and numeric entry
    await p.getByTestId('bezier-preset-out-back').click();
    expect((await tf(s, 'v1', 'x')).kf[1]!.ease).toEqual({
      type: 'bezier',
      x1: 0.34,
      y1: 1.56,
      x2: 0.64,
      y2: 1,
    });
    await num(p, 'bezier-y2').fill('0.5');
    await num(p, 'bezier-y2').press('Enter');
    expect(((await tf(s, 'v1', 'x')).kf[1]!.ease as { y2: number }).y2).toBe(0.5);
    // keyboard: arrow on a focused handle
    await p.getByTestId('bezier-handle-2').focus();
    await p.keyboard.press('ArrowRight');
    expect(((await tf(s, 'v1', 'x')).kf[1]!.ease as { x2: number }).x2).toBe(0.65);

    // delete the keyframe, then clear all
    await editor.getByTestId('kf-delete').click();
    expect((await tf(s, 'v1', 'x')).kf).toHaveLength(2);
    await editor.getByTestId('kf-clear').click();
    expect((await tf(s, 'v1', 'x')).kf).toHaveLength(0);
    await finish(s);
  });
});

test.describe('video tabs', () => {
  test('speed: constant, ramp, collapse, reverse, freeze frame', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'speed');
    await p.getByTestId('speed-chip-2').click();
    expect(await s.item('v1')).toMatchObject({ speed: 2, durationSec: 4 });
    await p.getByTestId('speed-chip-1').click();
    expect(await s.item('v1')).toMatchObject({ speed: 1, durationSec: 8 });
    // log slider is one deferred write
    const d0 = await s.snapshot();
    await dragRange(p, p.getByTestId('slider-speed'), 0.5, 0.75);
    await expectOneStep(s, d0);
    expect(((await s.item('v1')) as { speed: number }).speed).toBeGreaterThan(1.5);
    await p.getByTestId('speed-chip-1').click();

    // ramp
    await p.getByRole('radio', { name: 'Speed ramp' }).click();
    const ramp = await s.item<{ speedCurve: { t: number; v: number }[] }>('v1');
    expect(ramp.speedCurve).toHaveLength(2);
    await expect(p.getByTestId('speed-ramp-editor')).toBeVisible();
    await p.getByTestId('ramp-bullet').click();
    const bullet = videoItemSchema.parse(await s.item('v1'));
    expect(bullet.speedCurve).toHaveLength(5);
    expect(sourceSpan(bullet)).toBeCloseTo(8, 1); // presets keep the same footage
    // add a point by double-clicking the graph, delete it again
    const g = (await p.getByTestId('keyframe-graph').boundingBox())!;
    await p.mouse.dblclick(g.x + g.width * 0.2, g.y + g.height * 0.3);
    expect(((await s.item('v1')) as { speedCurve: unknown[] }).speedCurve).toHaveLength(6);
    await p.getByTestId('kf-delete').click();
    expect(((await s.item('v1')) as { speedCurve: unknown[] }).speedCurve).toHaveLength(5);
    // back to constant at the average speed (same footage)
    await p.getByRole('radio', { name: 'Constant' }).click();
    const flat = videoItemSchema.parse(await s.item('v1'));
    expect(flat.speedCurve).toEqual([]);
    expect(sourceSpan(flat)).toBeCloseTo(8, 1);

    await p.getByTestId('reverse').click();
    expect(((await s.item('v1')) as { reverse: boolean }).reverse).toBe(true);
    await expect(p.getByTestId('preserve-pitch')).toBeVisible();

    // freeze frame at the playhead
    await s.setPlayhead(3);
    await p.getByTestId('freeze-frame').click();
    const items = await s.read((st) => st.project.tracks.find((t) => t.id === 'tr_v')!.items);
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.freezeAtSec !== null && i.freezeAtSec !== undefined)).toHaveLength(
      1,
    );
    await finish(s);
  });

  test('audio: volume with dB label, fades, gate, beats and cut-to-beats', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'audio');
    const vol = num(p, 'field-volume');
    await vol.fill('50');
    await vol.press('Enter');
    expect(((await s.item('v1')) as { volume: Anim }).volume.v).toBe(0.5);
    await expect(p.getByText('−6.0 dB')).toBeVisible();
    await num(p, 'field-fadeInSec').fill('0.5');
    await num(p, 'field-fadeInSec').press('Enter');
    expect(((await s.item('v1')) as { fadeInSec: number }).fadeInSec).toBe(0.5);
    await p.getByTestId('noise-gate').click();
    expect(((await s.item('v1')) as { noiseGate: boolean }).noiseGate).toBe(true);
    await expect(p.getByText('Applied on export')).toBeVisible();
    await p.getByTestId('audio-enabled').click();
    expect(((await s.item('v1')) as { audioEnabled: boolean }).audioEnabled).toBe(false);

    // music clip: detect beats
    await s.select(LAB_IDS.m1);
    await expect(p.getByTestId('beats-status')).toHaveText('Beats not detected yet');
    await p.getByTestId('detect-beats').click();
    await expect(p.getByTestId('beats-status')).toHaveText('160 beats · ~120 BPM');
    expect(s.calls('editor:beats')).toEqual([{ projectId: 'lab-project', assetId: 'a_music' }]);
    expect(
      await s.read(
        (st) => (st.project.assets.find((a) => a.id === 'a_music')!.beats as number[]).length,
      ),
    ).toBe(160);
    // snap toggle is the timeline's snap switch
    expect(await s.read((st) => st.snapEnabled)).toBe(true);
    await p.getByTestId('snap-beats').click();
    expect(await s.read((st) => st.snapEnabled)).toBe(false);
    // cut the clip at the next 3 beats after the playhead
    await s.setPlayhead(0);
    await num(p, 'cut-beats-count').fill('3');
    await num(p, 'cut-beats-count').press('Enter');
    await p.getByTestId('cut-to-beats').click();
    const starts = await s.read((st) =>
      st.project.tracks.find((t) => t.id === 'tr_music')!.items.map((i) => i.startSec as number),
    );
    expect(starts).toHaveLength(4);
    expect(starts.slice().sort((a, b) => a - b)).toEqual([0, 0.25, 0.75, 1.25]);
    await finish(s);
  });

  test('beat detection failure shows a recoverable error', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.m1);
    s.editor.failures.set('editor:beats', { message: 'beat tracker crashed', times: 1 });
    await p.getByTestId('detect-beats').click();
    await expect(p.getByTestId('beats-error')).toContainText('beat tracker crashed');
    await p.getByTestId('beats-error').getByRole('button', { name: 'Retry' }).click();
    await expect(p.getByTestId('beats-status')).toContainText('160 beats');
    await expect(p.getByTestId('beats-error')).toHaveCount(0);
    expect(
      s.problems.filter((x) => !/beat tracker crashed|Failed to load resource/.test(x)),
    ).toEqual([]);
    await s.close();
  });

  test('transition: type grid, duration, first clip has none', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v2);
    await p.getByTestId('transition-crossfade').click();
    expect(await s.item('v2')).toMatchObject({
      transitionIn: { type: 'crossfade', durationSec: 0.5 },
      startSec: 7.5,
    });
    await expect(p.getByTestId('transition-crossfade')).toHaveAttribute('aria-checked', 'true');
    for (const t of [
      'dip-black',
      'dip-white',
      'slide-left',
      'slide-right',
      'slide-up',
      'slide-down',
      'zoom',
      'blur',
      'whip-pan',
      'glitch',
    ]) {
      await p.getByTestId(`transition-${t}`).click();
      expect(((await s.item('v2')) as { transitionIn: { type: string } }).transitionIn.type).toBe(
        t,
      );
    }
    const dur = num(p, 'transition-duration');
    await dur.fill('1.2');
    await dur.press('Enter');
    expect(await s.item('v2')).toMatchObject({
      transitionIn: { type: 'glitch', durationSec: 1.2 },
    });
    await dragRange(p, p.getByTestId('transition-duration-slider'), 0.2, 0.5);
    expect(
      ((await s.item('v2')) as { transitionIn: { durationSec: number } }).transitionIn.durationSec,
    ).toBeGreaterThan(1.3);
    await p.getByTestId('transition-cut').click();
    expect(((await s.item('v2')) as { transitionIn: unknown }).transitionIn).toBeNull();
    // the first clip of a track cannot have one
    await s.select(LAB_IDS.v1);
    await expect(p.getByTestId('transition-crossfade')).toBeDisabled();
    await expect(p.getByText(/first clip on its track/)).toBeVisible();
    await finish(s);
  });

  test('colour: sliders, filter presets with live swatches, LUT import, reset', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'colour');
    await dragRange(p, p.getByTestId('slider-color.exposure'), 0.5, 0.8);
    expect((await s.item<{ color: { exposure: Anim } }>('v1')).color.exposure.v).toBeGreaterThan(
      0.2,
    );
    const bg = (id: string) =>
      p
        .getByTestId(`filter-${id}`)
        .locator('span')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundImage);
    const [none, warm, noir] = [await bg('none'), await bg('warm'), await bg('noir')];
    expect(new Set([none, warm, noir]).size).toBe(3);
    await p.getByTestId('filter-warm').click();
    expect((await s.item<{ color: { filter: string } }>('v1')).color.filter).toBe('warm');
    await expect(p.getByTestId('filter-warm')).toHaveAttribute('aria-checked', 'true');
    // swatches are graded on top of the clip's own adjustments: raising exposure changes them
    const warmBefore = await bg('warm');
    await p.getByTestId('slider-color.exposure').focus();
    await p.keyboard.press('End');
    expect(await bg('warm')).not.toBe(warmBefore);
    // LUT import
    await p.getByTestId('lut-import').click();
    await expect(p.getByTestId('lut-select')).toContainText('Teal & Orange.cube');
    expect(s.calls('editor:importAssets')).toEqual([{ projectId: 'lab-project', kinds: ['lut'] }]);
    expect((await s.item<{ color: { lutAssetId: string } }>('v1')).color.lutAssetId).toBe(
      'a_lut_teal',
    );
    await dragRange(p, p.getByTestId('slider-lutAmount'), 1, 0.5);
    expect((await s.item<{ color: { lutAmount: number } }>('v1')).color.lutAmount).toBeCloseTo(
      0.5,
      1,
    );
    // reset
    await p.getByTestId('color-reset').click();
    expect((await s.item<{ color: Record<string, unknown> }>('v1')).color).toMatchObject({
      filter: null,
      lutAssetId: null,
      lutAmount: 1,
      exposure: { v: 0, kf: [] },
    });
    await finish(s);
  });

  test('fit, crop presets, blend mode, fades, mirror, rotate 90°', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await p.getByRole('radio', { name: 'Contain' }).click();
    expect((await s.item<{ fit: string }>('v1')).fit).toBe('contain');
    await p.getByTestId('bg-blur').click();
    expect((await s.item<{ backgroundBlur: boolean }>('v1')).backgroundBlur).toBe(true);
    await p.getByRole('radio', { name: 'Cover' }).click();
    await p.getByTestId('bg-blur').hover(); // disabled again: explains why
    await p.getByTestId('mirror').click();
    expect((await s.item<{ mirror: boolean }>('v1')).mirror).toBe(true);
    await p.getByTestId('rotate-90').click();
    await p.getByTestId('rotate-90').click();
    expect((await tf(s, 'v1', 'rotation')).v).toBe(180);
    await p.getByTestId('blend-mode').click();
    await p.getByRole('option', { name: 'Multiply' }).click();
    expect((await s.item<{ blend: string }>('v1')).blend).toBe('multiply');
    await p.getByTestId('section-crop').getByRole('button', { name: /Crop/ }).click();
    await p.getByTestId('crop-preset-9:16').click();
    const crop = (await s.item<{ crop: Record<string, Anim> }>('v1')).crop;
    expect(crop.h!.v).toBe(1);
    expect(crop.w!.v).toBeCloseTo(0.3164, 3);
    expect(crop.x!.v).toBeCloseTo((1 - crop.w!.v) / 2, 3);
    await finish(s);
  });

  test('reframe: face-track fills crop keyframes, mini-map drag overrides, centre crop, clear, error + retry', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'reframe');
    s.editor.delayMs['editor:reframe'] = 250;
    await p.getByTestId('face-track').click();
    await expect(p.getByTestId('face-track')).toHaveAttribute('aria-busy', 'true');
    await expect(p.getByTestId('reframe-status')).toContainText('face found in 82% of frames');
    expect(s.calls('editor:reframe')).toEqual([
      {
        projectId: 'lab-project',
        assetId: 'a_video',
        startSec: 10,
        endSec: 18,
        aspect: '9:16',
        mode: 'auto',
      },
    ]);
    const crop = (await s.item<{ crop: Record<string, Anim> }>('v1')).crop;
    expect(crop.x!.kf.length).toBeGreaterThanOrEqual(2);
    expect(crop.x!.kf.length).toBeLessThan(33); // 4 keys/s over 8 s, thinned
    expect(crop.x!.kf[0]!.t).toBe(0);
    expect(crop.x!.kf[crop.x!.kf.length - 1]!.t).toBeCloseTo(8, 2);
    expect(crop.w!.kf.every((k) => Math.abs(k.v - 0.3164) < 1e-3)).toBe(true);
    await expect(p.getByTestId('reframe-key').first()).toBeVisible();

    // drag the live rectangle at the playhead: keyframes on x/y, ONE undo step
    await s.setPlayhead(4);
    const before = (await s.item<{ crop: Record<string, Anim> }>('v1')).crop.x!.kf.length;
    const d0 = await s.snapshot();
    const r = (await p.getByTestId('reframe-rect').boundingBox())!;
    await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await p.mouse.down();
    await p.mouse.move(r.x + r.width / 2 + 24, r.y + r.height / 2 + 3, { steps: 8 });
    await p.mouse.up();
    const after = (await s.item<{ crop: Record<string, Anim> }>('v1')).crop.x!;
    expect(after.kf.length).toBeGreaterThanOrEqual(before);
    expect(after.kf.some((k) => Math.abs(k.t - 4) < 0.02)).toBe(true);
    await expectOneStep(s, d0);

    await p.getByTestId('centre-crop').click();
    const centred = (await s.item<{ crop: Record<string, Anim> }>('v1')).crop;
    expect(centred.x!.kf).toEqual([]);
    expect(centred.w!.v).toBeCloseTo(0.3164, 3);
    expect(centred.x!.v).toBeCloseTo(0.3418, 3);
    await p.getByTestId('clear-reframe').click();
    expect((await s.item<{ crop: Record<string, Anim> }>('v1')).crop).toMatchObject({
      x: { v: 0, kf: [] },
      w: { v: 1, kf: [] },
    });

    // failure → message with Retry → success
    s.editor.failures.set('editor:reframe', { message: 'sidecar is not running', times: 1 });
    await p.getByTestId('face-track').click();
    await expect(p.getByTestId('reframe-error')).toContainText('sidecar is not running');
    await p.getByTestId('reframe-error').getByRole('button', { name: 'Retry' }).click();
    await expect(p.getByTestId('reframe-error')).toHaveCount(0);
    await expect(p.getByTestId('reframe-status')).toContainText('face found');
    expect((await s.item<{ crop: Record<string, Anim> }>('v1')).crop.x!.kf.length).toBeGreaterThan(
      1,
    );
    expect(
      s.problems.filter((x) => !/sidecar is not running|Failed to load resource/.test(x)),
    ).toEqual([]);
    await s.close();
  });

  test('reframe through a speed change maps source time back to the clip', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'speed');
    await p.getByTestId('speed-chip-2').click(); // 8 s of picture → 4 s item (source 10..18)
    await tab(p, 'reframe');
    await p.getByTestId('face-track').click();
    await expect(p.getByTestId('reframe-status')).toContainText('face found');
    const crop = (await s.item<{ crop: Record<string, Anim>; durationSec: number }>('v1')).crop;
    expect(crop.x!.kf[crop.x!.kf.length - 1]!.t).toBeCloseTo(4, 2); // local time = source / 2
    await finish(s);
  });
});

test.describe('text, shapes', () => {
  test('text: content, emoji, font, colour, stroke/shadow/box, animation replay, brand chip', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.t1);
    const ta = p.getByTestId('text-content');
    await ta.fill('Line one\nLine two');
    expect((await s.item<{ text: string }>('t1')).text).toBe('Line one\nLine two');
    await p.getByTestId('emoji-button').click();
    await p.getByRole('button', { name: 'Insert 🔥' }).click();
    expect((await s.item<{ text: string }>('t1')).text).toContain('🔥');
    await p.keyboard.press('Escape');
    await p.getByTestId('font-family').click();
    await p.getByRole('option', { name: 'Poppins' }).click();
    expect(
      (await s.item<{ style: { fontFamily: string; weight: number } }>('t1')).style,
    ).toMatchObject({ fontFamily: 'Poppins', weight: 800 });
    await num(p, 'field-style.size').fill('120');
    await num(p, 'field-style.size').press('Enter');
    expect((await s.item<{ style: { size: number } }>('t1')).style.size).toBe(120);
    const hex = p.getByLabel('Colour hex');
    await hex.fill('#FFE94D');
    await hex.blur();
    expect((await s.item<{ style: { color: string } }>('t1')).style.color).toBe('#FFE94D');
    await p.getByRole('radio', { name: 'Right' }).click();
    expect((await s.item<{ style: { align: string } }>('t1')).style.align).toBe('right');
    await dragRange(p, p.getByTestId('slider-style.size'), 0.3, 0.6);

    await tab(p, 'style');
    await p.getByTestId('stroke-enabled').click();
    expect((await s.item<{ style: { stroke: unknown } }>('t1')).style.stroke).toEqual({
      color: '#000000',
      width: 4,
    });
    await num(p, 'field-style.stroke.width').fill('9');
    await num(p, 'field-style.stroke.width').press('Enter');
    await p.getByTestId('shadow-enabled').click();
    await p.getByTestId('box-enabled').click();
    await num(p, 'field-style.box.radius').fill('30');
    await num(p, 'field-style.box.radius').press('Enter');
    const style = (await s.item<{ style: Record<string, Record<string, number>> }>('t1')).style;
    expect(style.stroke!.width).toBe(9);
    expect(style.shadow).toMatchObject({ blur: 8, offsetY: 4 });
    expect(style.box).toMatchObject({ radius: 30, padding: 16 });
    await p.getByTestId('stroke-enabled').click();
    expect((await s.item<{ style: { stroke: unknown } }>('t1')).style.stroke).toBeNull();

    await tab(p, 'motion');
    await p.getByTestId('anim-animIn').click();
    await p.getByRole('option', { name: 'Pop' }).click();
    expect((await s.item<{ animIn: { type: string } }>('t1')).animIn.type).toBe('pop');
    await s.setPlayhead(3);
    await p.getByTestId('replay-animIn').click();
    // the playhead scrubs across the animation (item starts at 1 s) …
    await expect.poll(() => s.read((st) => st.playheadSec), { timeout: 1500 }).toBeLessThan(1.5);
    // … then returns to where it was
    await expect.poll(() => s.read((st) => st.playheadSec), { timeout: 3000 }).toBe(3);

    await tab(p, 'text');
    const chip = p.getByTestId('brand-style-chip');
    await expect(chip).toBeDisabled();
    await chip.locator('..').hover();
    await expect(p.getByRole('tooltip').first()).toContainText('Arrives in checkpoint 4');
    await finish(s);
  });

  test('shape: kind, size, fill, stroke, progress-bar note', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.s1);
    await p.getByTestId('shape-kind').click();
    await p.getByRole('option', { name: 'Progress bar' }).click();
    expect((await s.item<{ shape: string }>('s1')).shape).toBe('progress-bar');
    await expect(p.getByText(/fills left to right/)).toBeVisible();
    await num(p, 'field-width').fill('900');
    await num(p, 'field-width').press('Enter');
    expect((await s.item<{ width: number }>('s1')).width).toBe(900);
    const hex = p.getByLabel('Colour hex');
    await hex.fill('#4ADE80');
    await hex.blur();
    expect((await s.item<{ fill: string }>('s1')).fill).toBe('#4ADE80');
    await p.getByTestId('shape-stroke-enabled').click();
    expect((await s.item<{ stroke: unknown }>('s1')).stroke).toEqual({
      color: '#000000',
      width: 4,
    });
    await tab(p, 'layer');
    await num(p, 'field-transform.rotation').fill('15');
    await num(p, 'field-transform.rotation').press('Enter');
    expect((await tf(s, 's1', 'rotation')).v).toBe(15);
    await finish(s);
  });
});

test.describe('subtitles', () => {
  test('words: inline edit, split on space, delete, colour, split/merge cue, active word', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.c1);
    const words = () =>
      s
        .item<{ words: { w: string; s: number; e: number; color: string | null }[] }>('c1')
        .then((c) => c.words);
    await expect(p.getByTestId('word-row')).toHaveCount(5);
    await p.getByTestId('word-input').first().fill('Hello');
    await p.getByTestId('word-input').first().press('Enter');
    expect((await words())[0]).toMatchObject({ w: 'Hello', s: 0, e: 0.5 });
    await p.getByTestId('word-input').nth(1).fill('back again');
    await p.getByTestId('word-input').nth(1).press('Enter');
    expect((await words()).map((w) => w.w)).toEqual([
      'Hello',
      'back',
      'again',
      'to',
      'the',
      'show',
    ]);
    await p.getByTestId('word-input').nth(2).fill('');
    await p.getByTestId('word-input').nth(2).press('Enter');
    expect((await words()).map((w) => w.w)).toEqual(['Hello', 'back', 'to', 'the', 'show']);
    // per-word colour
    await p.getByLabel('Word 1 highlight: pick colour').click();
    await p.getByRole('button', { name: 'Word 1 highlight: yellow' }).click();
    expect((await words())[0]!.color).toBe('#FFE94D');
    await p.keyboard.press('Escape');
    // active word follows the playhead
    await s.setPlayhead(1.6);
    await expect(p.getByTestId('word-row').nth(1)).toHaveAttribute('data-active', 'true');
    // word timing mode
    await p.getByTestId('word-timing-toggle').click();
    await num(p, 'word-start-1').fill('0.7');
    await num(p, 'word-start-1').press('Enter');
    expect((await words()).slice(0, 2).map((w) => [w.s, w.e])).toEqual([
      [0, 0.7],
      [0.7, 0.9],
    ]);
    // split the caption before word 3
    await p.getByTestId('word-split').nth(2).click();
    const cues = await s.read(
      (st) => st.project.tracks.find((t) => t.id === 'tr_sub')!.items.length,
    );
    expect(cues).toBe(4);
    // merge c2 with c3
    await s.select(LAB_IDS.c2);
    await p.getByTestId('merge-next').click();
    const c2 = await s.item<{ words: unknown[] }>('c2');
    expect(c2.words).toHaveLength(6);
    await finish(s);
  });

  test('style: preset picker, apply to all cues, customise opens the studio; timing + nudge', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.c2);
    await tab(p, 'style');
    await expect(p.getByTestId('sub-style-name')).toHaveText('Clean Pop');
    await p.getByTestId('sub-style-pick').click();
    await p.locator('[data-testid="style-tile"][data-style-id="hormozi-bold"]').click();
    expect((await s.item<{ styleId: string }>('c2')).styleId).toBe('hormozi-bold');
    await expect(p.getByTestId('sub-style-name')).toHaveText('Hormozi Bold');
    await p.getByTestId('apply-all-cues').click();
    for (const id of ['c1', 'c2', 'c3'])
      expect((await s.item<{ styleId: string }>(id)).styleId).toBe('hormozi-bold');
    await p.getByTestId('sub-style-studio').click();
    await expect(p.getByRole('dialog')).toBeVisible();
    await p.keyboard.press('Escape');

    await tab(p, 'timing');
    await num(p, 'cue-start').fill('4.5');
    await num(p, 'cue-start').press('Enter');
    expect(await s.item('c2')).toMatchObject({ startSec: 4.5 });
    await p.getByTestId('nudge-+0.1 s').click();
    expect((await s.item<{ startSec: number }>('c2')).startSec).toBeCloseTo(4.6, 5);
    await finish(s);
  });

  test('re-sync with AI maps source-time words back onto the caption; progress, error and retry', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.c1);
    s.editor.delayMs['editor:resyncSubtitles'] = 400;
    await p.getByTestId('resync').click();
    await expect(p.getByTestId('resync-progress')).toBeVisible();
    await expect(p.getByTestId('resync-done')).toBeVisible();
    // cue 1 sits at timeline 1.0–3.4 over clip v1 (inSec 10): source 11.0–13.4, padded by 0.25 s
    const req = s.calls('editor:resyncSubtitles')[0] as {
      assetId: string;
      srcStartSec: number;
      srcEndSec: number;
    };
    expect(req.assetId).toBe('a_video');
    expect(req.srcStartSec).toBeCloseTo(10.75, 3);
    expect(req.srcEndSec).toBeCloseTo(13.65, 3);
    const c1 = await s.item<{ words: { w: string; s: number; e: number }[] }>('c1');
    expect(c1.words.map((w) => w.w)).toEqual(['Welcome', 'back', 'to', 'the', 'show']); // 'uh' / 'so' padding dropped
    expect(c1.words[0]!.s).toBeCloseTo(0, 2);
    expect(c1.words[4]!.e).toBeCloseTo(2.4, 2);
    expect(c1.words[2]!.s).toBeCloseTo(0.96, 2);

    s.editor.failures.set('editor:resyncSubtitles', {
      message: 'transcription engine is not ready',
      times: 1,
    });
    await p.getByTestId('resync').click();
    await expect(p.getByTestId('resync-error')).toContainText('transcription engine is not ready');
    await p.getByTestId('resync-error').getByRole('button', { name: 'Retry' }).click();
    await expect(p.getByTestId('resync-done')).toBeVisible();
    await expect(p.getByTestId('resync-error')).toHaveCount(0);
    expect(
      s.problems.filter(
        (x) => !/transcription engine is not ready|Failed to load resource/.test(x),
      ),
    ).toEqual([]);
    await s.close();
  });

  test('re-sync accounts for clip speed', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await tab(p, 'speed');
    await p.getByTestId('speed-chip-2').click(); // v1 now 4 s long: timeline 0–4 shows source 10–18
    await s.select(LAB_IDS.c1); // 1.0–3.4 → source 12.0–16.8
    await p.getByTestId('resync').click();
    await expect(p.getByTestId('resync-done')).toBeVisible();
    const req = s.calls('editor:resyncSubtitles')[0] as { srcStartSec: number; srcEndSec: number };
    expect(req.srcStartSec).toBeCloseTo(11.75, 3);
    expect(req.srcEndSec).toBeCloseTo(17.05, 3);
    const c1 = await s.item<{ words: { s: number; e: number }[] }>('c1');
    expect(c1.words[0]!.s).toBeCloseTo(0, 2);
    expect(c1.words[4]!.e).toBeCloseTo(2.4, 2);
    await finish(s);
  });
});

test.describe('tracks', () => {
  test('track panel: gain, mute, speech, ducking', async () => {
    const s = await open();
    const p = s.page;
    await s.selectTrack('tr_music');
    await expect(p.getByText('Select a clip to edit it')).toBeVisible();
    const gain = num(p, 'track-gain');
    await gain.fill('50');
    await gain.press('Enter');
    const track = () => s.read((st) => st.project.tracks.find((t) => t.id === 'tr_music')!);
    expect((await track()).gain).toBe(0.5);
    await expect(p.getByText('−6.0 dB')).toBeVisible();
    await p.getByTestId('track-speech').click();
    expect((await track()).speech).toBe(true);
    await expect(num(p, 'duck-reduction')).toBeDisabled();
    await p.getByTestId('duck-enabled').click();
    expect((await track()).ducking).toMatchObject({ enabled: true, reductionDb: 12 });
    await num(p, 'duck-reduction').fill('18');
    await num(p, 'duck-reduction').press('Enter');
    await num(p, 'duck-attack').fill('0.3');
    await num(p, 'duck-attack').press('Enter');
    await num(p, 'duck-release').fill('1.5');
    await num(p, 'duck-release').press('Enter');
    expect((await track()).ducking).toEqual({
      enabled: true,
      reductionDb: 18,
      attackSec: 0.3,
      releaseSec: 1.5,
    });
    await expect(p.getByText(/Speech = the words of your subtitle track/)).toBeVisible();
    // dragging the gain slider is one write
    const d0 = await s.snapshot();
    await dragRange(p, p.getByTestId('track-gain-slider'), 0.25, 0.75);
    await expectOneStep(s, d0);
    await p.getByTestId('track-muted').click();
    expect((await track()).muted).toBe(true);
    await finish(s);
  });

  test('audio clip: track tab shows the same controls', async () => {
    const s = await open();
    const p = s.page;
    await s.select(LAB_IDS.m1);
    await tab(p, 'track');
    await p.getByTestId('duck-enabled').click();
    expect(
      await s.read((st) => st.project.tracks.find((t) => t.id === 'tr_music')!.ducking.enabled),
    ).toBe(true);
    await finish(s);
  });
});

test.describe('chrome', () => {
  test('keyboard reaches every section header, tabs are a tablist, reduced motion is honoured', async () => {
    const s = await open({ reducedMotion: true });
    const p = s.page;
    await s.select(LAB_IDS.v1);
    await expect(p.getByRole('tablist')).toBeVisible();
    await expect(p.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    await p.getByRole('tab', { name: 'Speed' }).click();
    await expect(p.getByRole('tab', { name: 'Speed' })).toHaveAttribute('aria-selected', 'true');
    // collapse + re-open a section with the keyboard
    const head = p.getByRole('button', { name: 'Speed', exact: true }).first();
    await head.focus();
    await p.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await p.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await finish(s);
  });

  test('light theme renders the same panels without errors', async () => {
    const s = await open({ theme: 'light' });
    await s.select(LAB_IDS.v1);
    await expect(s.page.getByTestId('section-transform')).toBeVisible();
    await tab(s.page, 'colour');
    await expect(s.page.getByTestId('filter-warm')).toBeVisible();
    await finish(s);
  });
});
