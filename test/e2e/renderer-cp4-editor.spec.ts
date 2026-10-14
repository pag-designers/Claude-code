import { expect, test, type Page } from '@playwright/test';
import { canRun, createHarness, type Harness, type OpenOptions } from './support/harness';
import { openEditor, type EditorSession } from './support/editor-timeline-harness';
import { editorBrand, seedEditorBrand, type SeedBrandOptions } from './support/editor-brand-stub';
import type { Item, Project, TextItem } from '../../shared/editor';

/**
 * CP4 Brand Kit INSIDE the editor, against the REAL exported renderer: the top bar's "Apply Brand Kit", the Brand Kit
 * sections of the media bin (videos, images, audio, text styles, stock footage + Suggest B-roll), the inspector's
 * brand style chip / font picker / palette swatches, and brand fonts on the preview canvas.
 *   CLIPFERN_E2E_OUT=<private snapshot of the static export> xvfb-run -a npx playwright test test/e2e/renderer-cp4-editor.spec.ts
 * `window.clipfern` is the contract-validating stub (editor-brand-stub.ts); the editor store is the real one. Every
 * session asserts zero console errors/warnings (but Chromium's software-GL notices), zero external requests, zero HTTP >= 400.
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
const edit = (id = 'br-1', seed: SeedBrandOptions = {}, opts: OpenOptions = {}) =>
  openEditor(h, open, id, {
    seed: false,
    prepareState: (st) => void seedEditorBrand(st, seed),
    ...opts,
  });

const realProblems = (s: { problems: string[] }) =>
  s.problems.filter((p) => !/GL Driver Message|GPU stall/.test(p));

const proj = async (s: EditorSession): Promise<Project> => (await s.store()).project;
const find = (p: Project, id: string): Item | undefined =>
  p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
const need = (p: Project, id: string): Item => {
  const it = find(p, id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};
const trackOf = (p: Project, id: string) => p.tracks.find((t) => t.id === id);
const binTab = (p: Page, t: string) => p.getByTestId(`bin-tab-${t}`).click();
const toastText = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });

/** Opens the Apply Brand Kit dialog. */
async function openApply(s: EditorSession) {
  await s.page.getByTestId('open-apply-brand').click();
  const dlg = s.page.getByTestId('apply-brand-dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}
/** Waits for a kit to be loaded in the dialog (the parts list shows). */
const ready = (s: EditorSession) => s.page.getByTestId('apply-part-intro').waitFor();

const ALL_PARTS = ['watermark', 'intro', 'outro', 'subtitles', 'hook', 'music'] as const;

/* ============================================================================================ */

test.describe('Apply Brand Kit (top bar)', () => {
  test('defaults, preview, one undoable edit, idempotent re-apply', async () => {
    const s = await edit();
    const p = s.page;
    const before = await proj(s);
    expect(before.brandKitId).toBeNull();
    const dlg = await openApply(s);
    await ready(s);
    // the default kit is preselected and the kit's switches decide the ticks
    await expect(dlg.getByTestId('apply-brand-kit')).toContainText('Acme');
    for (const part of ALL_PARTS)
      await expect(dlg.getByTestId(`apply-check-${part}`)).toHaveAttribute('aria-checked', 'true');
    // the preview says what each part will do
    await expect(dlg.getByTestId('apply-line-intro')).toContainText(
      'Intro 4.0 s added at the start',
    );
    await expect(dlg.getByTestId('apply-line-outro')).toContainText(
      'Outro 3.0 s added after the last clip',
    );
    await expect(dlg.getByTestId('apply-line-watermark')).toContainText('top right');
    await expect(dlg.getByTestId('apply-line-subtitles')).toContainText('5 caption lines');
    await expect(dlg.getByTestId('apply-line-hook')).toContainText(
      '1 hook text restyled with "Big hook"',
    );
    await expect(dlg.getByTestId('apply-line-music')).toContainText('looped 2×');
    await expect(dlg.getByTestId('apply-brand-length')).toContainText('0:19 → 0:26');
    // nothing happened yet
    expect((await s.store()).canUndo).toBe(false);

    await dlg.getByTestId('apply-brand-go').click();
    await expect(dlg).toBeHidden();
    await expect(toastText(p, 'Applied Acme')).toBeVisible();

    const st = await s.store();
    const after = st.project;
    expect(st.undoLabel).toBe('Apply Brand Kit “Acme”');
    expect(after.brandKitId).toBe('kit_acme');
    // intro first on the main track, everything (all tracks, markers) 4 s later
    const main = trackOf(after, 'tr_video')!;
    expect(main.items.map((i) => i.id)).toEqual(['brand_intro', 'v1', 'v2', 'brand_outro']);
    expect(need(after, 'brand_intro')).toMatchObject({
      startSec: 0,
      durationSec: 4,
      assetId: 'ba_a_intro',
    });
    for (const id of ['v1', 'v2', 'hook', 'title', 'cue_0', 'cue_4', 'user_music'])
      expect(need(after, id).startSec).toBeCloseTo(need(before, id).startSec + 4, 6);
    expect(after.markers.map((m) => m.atSec)).toEqual([8, 16]);
    // crossfade overlap kept
    const v1 = need(after, 'v1');
    expect(v1.startSec + v1.durationSec - need(after, 'v2').startSec).toBeCloseTo(0.5, 6);
    // outro after the last visual item (19.5 + 4 = 23.5)
    expect(need(after, 'brand_outro')).toMatchObject({ startSec: 23.5, durationSec: 3 });
    // watermark over the programme only, on its own overlay track
    expect(trackOf(after, 'tr_brand_wm')).toMatchObject({
      kind: 'overlay',
      name: 'Brand watermark',
    });
    expect(need(after, 'brand_wm')).toMatchObject({
      startSec: 4,
      durationSec: 19.5,
      assetId: 'ba_a_logo',
      fit: 'native',
    });
    // music bed on its own track, ducking from the kit; video tracks marked as speech
    const music = trackOf(after, 'tr_brand_music')!;
    expect(music.ducking).toMatchObject({ enabled: true, reductionDb: 12 });
    expect(music.items).toHaveLength(2);
    expect(trackOf(after, 'tr_video')!.speech).toBe(true);
    // captions + hook
    for (const i of trackOf(after, 'tr_sub')!.items)
      expect(i).toMatchObject({ styleId: 'hormozi-bold', styleOverride: null });
    const hook = need(after, 'hook') as TextItem;
    expect(hook.style.fontFamily).toBe('Acme Display');
    expect(hook.styleRef).toBe('brand:kit_acme:hk1');
    expect(hook.transform.y.v).toBe(Math.round((0.22 - 0.5) * 1920));
    // the timeline shows the new pieces
    await expect(
      p.locator('[data-testid="timeline"] [data-item-id="brand_intro"][role="option"]'),
    ).toBeVisible();
    // brand assets are in the media bin
    expect(after.assets.map((a) => a.id)).toEqual(
      expect.arrayContaining(['ba_a_intro', 'ba_a_outro', 'ba_a_logo', 'ba_a_music']),
    );

    // re-applying the same kit changes nothing and records no history entry
    const again = await openApply(s);
    await ready(s);
    await expect(again.getByTestId('apply-brand-length')).toHaveText('Already applied');
    await again.getByTestId('apply-brand-go').click();
    await expect(toastText(p, 'Nothing to change')).toBeVisible();
    expect(JSON.stringify(await proj(s))).toBe(JSON.stringify(after));

    // ONE undo step takes it all back; redo applies it all again
    await p.getByTestId('undo').click();
    const undone = await s.store();
    expect(JSON.stringify(undone.project)).toBe(JSON.stringify(before));
    expect(undone.canUndo).toBe(false);
    await p.getByTestId('redo').click();
    expect(JSON.stringify(await proj(s))).toBe(JSON.stringify(after));
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('another kit replaces the first one; parts the kit lacks are disabled with a reason', async () => {
    const s = await edit();
    const p = s.page;
    const original = await proj(s);
    let dlg = await openApply(s);
    await ready(s);
    await dlg.getByTestId('apply-brand-go').click();
    await expect(dlg).toBeHidden();
    const acme = await proj(s);

    dlg = await openApply(s);
    await ready(s);
    // a manual change of the ticks…
    await dlg.getByTestId('apply-check-subtitles').click();
    await expect(dlg.getByTestId('apply-check-subtitles')).toHaveAttribute('aria-checked', 'false');
    // …is reset by choosing another kit (the new kit's own defaults apply)
    await dlg.getByTestId('apply-brand-kit').click();
    await p.getByRole('option', { name: /Neon/ }).click();
    // Neon has no outro: unticked + disabled, with its reason
    const outro = dlg.getByTestId('apply-check-outro');
    await expect(outro).toBeDisabled();
    await expect(dlg.getByTestId('apply-part-outro')).toContainText('no outro');
    await expect(dlg.getByTestId('apply-part-outro')).toHaveAttribute('data-state', 'unavailable');
    // ticks reset to Neon's defaults
    for (const part of ['watermark', 'intro', 'subtitles', 'hook', 'music'] as const)
      await expect(dlg.getByTestId(`apply-check-${part}`)).toHaveAttribute('aria-checked', 'true');
    await expect(dlg.getByText(/branded with another kit/)).toBeVisible();
    await dlg.getByTestId('apply-brand-go').click();
    await expect(dlg).toBeHidden();

    const neon = await proj(s);
    expect(neon.brandKitId).toBe('kit_neon');
    expect(need(neon, 'brand_intro')).toMatchObject({ durationSec: 2.5, assetId: 'ba_b_intro' });
    // everything re-rippled from the ORIGINAL positions (2.5 s, not 4 + 2.5)
    expect(need(neon, 'v1').startSec).toBeCloseTo(2.5, 6);
    expect(neon.markers.map((m) => m.atSec)).toEqual([6.5, 14.5]);
    expect(need(neon, 'brand_wm')).toMatchObject({ assetId: 'ba_b_logo', startSec: 2.5 });
    expect(trackOf(neon, 'tr_brand_music')!.items[0]).toMatchObject({ assetId: 'ba_b_music' });
    expect(trackOf(neon, 'tr_brand_music')!.ducking.enabled).toBe(false);
    for (const i of trackOf(neon, 'tr_sub')!.items)
      expect(i).toMatchObject({ styleId: 'clean-pop' });
    expect((need(neon, 'hook') as TextItem).style.fontFamily).toBe('Poppins');
    // the first kit's intro / logo / music files are gone from the project's media; kit B's are in
    const ids = neon.assets.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['ba_b_intro', 'ba_b_logo', 'ba_b_music']));
    for (const gone of ['ba_a_intro', 'ba_a_logo', 'ba_a_music']) expect(ids).not.toContain(gone);

    // undo → kit A exactly; undo again → the original
    await p.getByTestId('undo').click();
    expect(JSON.stringify(await proj(s))).toBe(JSON.stringify(acme));
    await p.getByTestId('undo').click();
    expect(JSON.stringify(await proj(s))).toBe(JSON.stringify(original));
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('part toggles; a part that cannot apply is reported and skipped (no captions in the project)', async () => {
    const s = await edit('br-bare');
    const p = s.page;
    const dlg = await openApply(s);
    await ready(s);
    // no captions: the preview already says so
    await expect(dlg.getByTestId('apply-part-subtitles')).toHaveAttribute('data-state', 'skipped');
    await expect(dlg.getByTestId('apply-line-subtitles')).toContainText('no captions');
    // untick watermark and music
    await dlg.getByTestId('apply-check-watermark').click();
    await dlg.getByTestId('apply-check-music').click();
    await expect(dlg.getByTestId('apply-check-watermark')).toHaveAttribute('aria-checked', 'false');
    await dlg.getByTestId('apply-brand-go').click();
    await expect(dlg).toBeHidden();
    await expect(toastText(p, 'Skipped: caption style')).toBeVisible();
    const after = await proj(s);
    expect(trackOf(after, 'tr_brand_wm')).toBeUndefined();
    expect(trackOf(after, 'tr_brand_music')).toBeUndefined();
    expect(find(after, 'brand_intro')).toBeDefined();
    expect(find(after, 'brand_outro')).toBeDefined();
    expect((find(after, 'hook') as TextItem).styleRef).toBe('brand:kit_acme:hk1');
    await s.close();
  });

  test('widescreen project: sizes follow the canvas short side, watermark follows the canvas', async () => {
    const s = await edit('br-wide');
    const dlg = await openApply(s);
    await ready(s);
    await dlg.getByTestId('apply-brand-go').click();
    await expect(dlg).toBeHidden();
    const after = await proj(s);
    const hook = need(after, 'hook') as TextItem;
    expect(hook.style.size).toBe(110); // short side 1080 → unit 1
    expect(hook.style.maxWidth).toBe(Math.round((900 * 1920) / 1080));
    const wm = need(after, 'brand_wm') as Item & {
      type: 'image';
      transform: { x: { v: number }; scale: { v: number } };
    };
    expect(400 * wm.transform.scale.v).toBeCloseTo(Math.round((1920 * 20) / 100), 0);
    await s.close();
  });

  test('without a Brand Kit the dialog explains and links to the Brand Kit page', async () => {
    const s = await edit('br-1', { kits: 'none' });
    const dlg = await openApply(s);
    await expect(dlg.getByTestId('apply-brand-empty')).toBeVisible();
    await expect(dlg.getByRole('link', { name: 'Open Brand Kit' })).toHaveAttribute(
      'href',
      '/brand-kit/',
    );
    await expect(dlg.getByTestId('apply-brand-go')).toBeDisabled();
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });
});

/* ============================================================================================ */

test.describe('media bin: Brand Kit videos, images, audio', () => {
  test('Media tab: the kit videos with roles; click adds the clip; dragging carries the project asset', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'media');
    const section = p.getByTestId('bin-brandkit-videos');
    await expect(section).toHaveAttribute('data-state', 'ready');
    const tiles = section.getByTestId('bin-brand-video');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.filter({ hasText: 'Acme intro' })).toContainText('intro');
    await expect(tiles.filter({ hasText: 'Acme outro' })).toContainText('outro');
    await expect(tiles.filter({ hasText: 'Office B-roll' })).toContainText('0:08');
    // thumbnails are real pictures
    await expect
      .poll(() =>
        section
          .locator('img')
          .evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);

    const broll = tiles.filter({ hasText: 'Office B-roll' });
    await broll.hover();
    await broll.getByTestId('bin-brand-video-add').click();
    const after = await proj(s);
    const asset = after.assets.find((a) => a.id === 'ba_a_broll');
    expect(asset).toMatchObject({
      kind: 'video',
      durationSec: 8,
      source: { kind: 'upload', key: 'brand/kit_acme/a_broll.mp4' },
    });
    const placed = after.tracks
      .flatMap((t) => t.items)
      .filter((i) => 'assetId' in i && i.assetId === 'ba_a_broll');
    expect(placed).toHaveLength(1);
    await expect(toastText(p, 'Office B-roll added')).toBeVisible();

    // drag: the payload names the project asset (created a tick later, so the drop can add it)
    const intro = tiles.filter({ hasText: 'Acme intro' });
    const payload = await intro.locator('[draggable="true"]').evaluate((el) => {
      const dt = new DataTransfer();
      el.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      return dt.getData('application/x-clipfern-asset');
    });
    expect(JSON.parse(payload)).toEqual({ assetId: 'ba_a_intro' });
    await expect
      .poll(async () => (await proj(s)).assets.some((a) => a.id === 'ba_a_intro'))
      .toBe(true);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('the kit picker switches the section to another kit', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'media');
    const section = p.getByTestId('bin-brandkit-videos');
    await expect(section.getByTestId('bin-brand-video')).toHaveCount(3);
    await section.getByTestId('brand-kit-select').click();
    await p.getByRole('option', { name: /Neon/ }).click();
    await expect(section.getByTestId('bin-brand-video')).toHaveCount(1);
    await expect(section.getByTestId('bin-brand-video')).toContainText('Neon intro');
    // the choice is shared by the other tabs
    await binTab(p, 'stickers');
    await expect(p.getByTestId('bin-brandkit-images').getByTestId('bin-brand-image')).toHaveCount(
      1,
    );
    await expect(p.getByTestId('bin-brandkit-images')).toContainText('Neon mark');
    await s.close();
  });

  test('Stickers tab: Brand Kit images (logos included) are added sticker-sized at the playhead', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'stickers');
    const section = p.getByTestId('bin-brandkit-images');
    await expect(section.getByTestId('bin-brand-image')).toHaveCount(2);
    await expect(
      section.getByTestId('bin-brand-image').filter({ hasText: 'Acme logo' }),
    ).toContainText('Watermark');
    await expect
      .poll(() =>
        section
          .locator('img')
          .evaluateAll((els) => els.every((e) => (e as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);
    // the old "arrives in checkpoint 4" placeholder is gone
    await expect(p.getByText('Arrives in checkpoint 4')).toHaveCount(0);

    await s.act('setPlayhead', 5);
    await section.getByTestId('bin-brand-image').filter({ hasText: 'Subscribe sticker' }).click();
    const after = await proj(s);
    const items = after.tracks.flatMap((t) => t.items).filter((i) => i.type === 'image');
    expect(items).toHaveLength(1);
    const img = items[0] as Item & { type: 'image'; transform: { scale: { v: number } } };
    expect(img).toMatchObject({
      assetId: 'ba_a_sticker',
      startSec: 5,
      durationSec: 4,
      fit: 'native',
    });
    expect(img.transform.scale.v).toBeCloseTo((1080 * 0.42) / 600, 4);
    expect(after.assets.find((a) => a.id === 'ba_a_sticker')).toMatchObject({
      kind: 'image',
      width: 600,
      height: 600,
    });
    expect((await s.store()).selection.itemIds).toEqual([img.id]);
    // adding it again reuses the asset
    await section.getByTestId('bin-brand-image').filter({ hasText: 'Subscribe sticker' }).click();
    expect((await proj(s)).assets.filter((a) => a.id === 'ba_a_sticker')).toHaveLength(1);
    await s.close();
  });

  test('Audio tab: audition the normalised copy; "Add as music with ducking" is one undo step', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'audio');
    // the explanation stays, the "later checkpoint" sentence is replaced
    await expect(p.getByText(/no in-app music search/)).toBeVisible();
    await expect(p.getByText(/coming in a later checkpoint/)).toHaveCount(0);
    await expect(p.getByText(/Pixabay has no official music API/)).toHaveCount(0); // tooltip text only on hover
    const rows = p.getByTestId('bin-brandkit-audio').getByTestId('bin-brand-audio');
    await expect(rows).toHaveCount(2);
    const music = rows.filter({ hasText: 'Sunny bed' });
    await expect(music).toContainText('-16 LUFS');
    await expect(music).toContainText('Music bed');
    const play = music.getByTestId('bin-brand-audition');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    // starting another one stops the first
    await rows.filter({ hasText: 'Whoosh' }).getByTestId('bin-brand-audition').click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await rows.filter({ hasText: 'Whoosh' }).getByTestId('bin-brand-audition').click();

    const before = await proj(s);
    await music.getByTestId('bin-brand-music-bed').click();
    const st = await s.store();
    expect(st.undoLabel).toBe('Add brand music');
    const bed = trackOf(st.project, 'tr_brand_music')!;
    // 19.5 s programme, 10 s file → two pieces
    expect(bed.items.map((i) => [i.startSec, i.durationSec])).toEqual([
      [0, 10],
      [10, 9.5],
    ]);
    expect(bed.ducking).toMatchObject({ enabled: true, reductionDb: 12 });
    expect(st.project.brandKitId).toBeNull(); // only the bed came from the kit
    await expect(toastText(p, 'Music bed added')).toBeVisible();
    await p.getByTestId('undo').click();
    expect(JSON.stringify(await proj(s))).toBe(JSON.stringify(before));

    // "+" drops the clip at the playhead without touching ducking
    await s.act('setPlayhead', 3);
    await music.getByTestId('bin-brand-audio-add').click();
    const placed = (await proj(s)).tracks
      .flatMap((t) => t.items)
      .filter((i) => 'assetId' in i && i.assetId === 'ba_a_music');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.startSec).toBeGreaterThanOrEqual(0);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('every Brand Kit section explains an empty kit / no kit and links to the Brand Kit page', async () => {
    const s = await edit('br-1', { kits: 'none' });
    const p = s.page;
    for (const [tab, id] of [
      ['media', 'bin-brandkit-videos'],
      ['stickers', 'bin-brandkit-images'],
      ['audio', 'bin-brandkit-audio'],
      ['text', 'bin-brandkit-text'],
    ] as const) {
      await binTab(p, tab);
      const sec = p.getByTestId(id);
      await expect(sec).toHaveAttribute('data-state', 'no-kit');
      await expect(sec).toContainText('No Brand Kit yet');
      await expect(sec.getByTestId('brand-manage-link')).toHaveAttribute('href', '/brand-kit/');
    }
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });
});

/* ============================================================================================ */

test.describe('text: kit styles, font picker, palette, canvas fonts', () => {
  test('Text tab lists the kit styles; a click makes a text layer in that look (hook layers are named "Hook")', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'text');
    const tiles = p.getByTestId('bin-brandkit-text').getByTestId('bin-brand-text');
    await expect(tiles).toHaveCount(4);
    await s.act('setPlayhead', 7);
    await tiles.filter({ hasText: 'Big hook' }).click();
    const st = await s.store();
    const id = st.selection.itemIds[0]!;
    const hook = need(st.project, id) as TextItem;
    expect(hook).toMatchObject({
      name: 'Hook',
      startSec: 7,
      durationSec: 3,
      styleRef: 'brand:kit_acme:hk1',
    });
    expect(hook.style).toMatchObject({ fontFamily: 'Acme Display', size: 110, color: '#FFE94D' });
    expect(hook.animIn).toEqual({ type: 'pop', durationSec: 0.4 });
    expect(hook.transform.y.v).toBe(Math.round((0.22 - 0.5) * 1920));
    await tiles.filter({ hasText: 'Name tag' }).click();
    const lt = need(await proj(s), (await s.store()).selection.itemIds[0]!) as TextItem;
    expect(lt.name).toBe('Name tag');
    expect(lt.text).toBe('Name Surname\nRole or topic');
    expect(lt.style.box).toMatchObject({ color: '#2F6BFF', padding: 24 });
    await s.close();
  });

  test('inspector brand chip: names the kit style, restyles the selection in one undo step', async () => {
    const s = await edit();
    const p = s.page;
    await s.act('select', ['title']);
    const chip = p.getByTestId('brand-style-chip');
    await expect(chip).toHaveText('Brand Kit style');
    await chip.click();
    const pop = p.getByTestId('brand-style-popover');
    await expect(pop.getByTestId('brand-style-option')).toHaveCount(4);
    const keep = need(await proj(s), 'title') as TextItem;
    const depth = (await s.store()).undoLabel;
    await pop.getByTestId('brand-style-option').filter({ hasText: 'Bold title' }).click();
    const t = need(await proj(s), 'title') as TextItem;
    expect(t.text).toBe(keep.text);
    expect(t.startSec).toBe(keep.startSec);
    expect(t.style).toMatchObject({ fontFamily: 'Poppins', weight: 800, size: 96 });
    expect(t.animIn.type).toBe('slide');
    expect(t.styleRef).toBe('brand:kit_acme:ttl1');
    expect((await s.store()).undoLabel).toBe('Apply “Bold title”');
    await expect(chip).toHaveText('Bold title');
    // restyle two layers at once
    await s.act('select', ['title', 'hook']);
    await chip.click();
    await p.getByTestId('brand-style-option').filter({ hasText: 'Follow pill' }).click();
    const both = await proj(s);
    for (const id of ['title', 'hook'])
      expect((need(both, id) as TextItem).styleRef).toBe('brand:kit_acme:cta1');
    await p.getByTestId('undo').click();
    await p.getByTestId('undo').click();
    expect((need(await proj(s), 'title') as TextItem).style).toEqual(keep.style);
    expect((await s.store()).undoLabel).toBe(depth);
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });

  test('font picker: Brand Kit fonts above the shipped ones, each drawn in its own face', async () => {
    const s = await edit();
    const p = s.page;
    await s.act('select', ['title']);
    const trigger = p.getByTestId('font-family');
    await trigger.click();
    const list = p.getByRole('listbox');
    await expect(list.getByText('Brand Kit fonts')).toBeVisible();
    await expect(list.getByText('Clipfern fonts')).toBeVisible();
    const names = await list
      .getByRole('option')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names[0]).toBe('Acme Display');
    expect(names).toEqual(expect.arrayContaining(['Anton', 'Montserrat', 'Poppins']));
    // live preview: the option is styled with its own family
    await expect(list.getByRole('option', { name: 'Acme Display' })).toHaveCSS(
      'font-family',
      /Acme Display/,
    );
    // the brand face is really loaded in the page
    expect(await p.evaluate(() => document.fonts.check('16px "Acme Display"'))).toBe(true);
    await list.getByRole('option', { name: 'Acme Display' }).click();
    const t = need(await proj(s), 'title') as TextItem;
    expect(t.style.fontFamily).toBe('Acme Display');
    expect(t.style.weight).toBe(400); // snapped to the weight the uploaded font has
    await expect(trigger).toHaveText('Acme Display');
    await s.close();
  });

  test('colour popover shows the kit palette; a swatch sets the colour', async () => {
    const s = await edit();
    const p = s.page;
    await s.act('select', ['title']);
    await p.getByRole('button', { name: 'Colour: pick colour' }).click();
    const sw = p.getByTestId('brand-swatches');
    await expect(sw).toBeVisible();
    await expect(sw).toContainText('Acme palette');
    await expect(sw.getByTestId('brand-swatch')).toHaveCount(3);
    await expect(sw.getByTestId('brand-swatch-group')).toHaveText(['Primary', 'Accent']);
    await sw.getByRole('button', { name: 'Colour: Brand Sunrise' }).click();
    expect((need(await proj(s), 'title') as TextItem).style.color).toBe('#FFB020');
    await expect(sw.getByRole('button', { name: 'Colour: Brand Sunrise' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await s.close();
  });

  test('brand fonts render on the preview canvas exactly like the same face does when shipped', async () => {
    const s = await edit('br-bare');
    const p = s.page;
    // a big headline, nothing else near it; the kit font IS the shipped Anton file under another family name
    await s.act('select', []);
    await binTab(p, 'text');
    await p.getByTestId('bin-text-preset').first().click();
    const id = (await s.store()).selection.itemIds[0]!;
    await s.act('updateItem', id, {
      text: 'HELLO FONTS',
      style: { size: 200, fontFamily: 'Anton', weight: 400 },
    });
    await s.act('setPlayhead', id ? need(await proj(s), id).startSec + 0.5 : 0);
    const canvas = p.getByTestId('preview-canvas');
    const grab = async () => {
      let last = await canvas.screenshot();
      for (let i = 0; i < 20; i++) {
        await p.waitForTimeout(150);
        const next = await canvas.screenshot();
        if (next.equals(last)) return next;
        last = next;
      }
      return last;
    };
    const anton = await grab();
    await s.act('updateItem', id, { style: { fontFamily: 'Acme Display' } });
    const acme = await grab();
    await s.act('updateItem', id, { style: { fontFamily: 'Definitely Not Installed' } });
    const fallback = await grab();
    await s.act('updateItem', id, { style: { fontFamily: 'Anton' } });
    const antonAgain = await grab();
    expect(antonAgain.equals(anton)).toBe(true);
    expect(acme.equals(anton)).toBe(true); // brand font drawn with the real glyphs, same pixels
    expect(fallback.equals(anton)).toBe(false); // …and the check is not vacuous
    expect(realProblems(s)).toEqual([]);
    await s.close();
  });
});

/* ============================================================================================ */

test.describe('stock footage and Suggest B-roll', () => {
  test('Search stock footage opens the dialog for this project and imports into Project media', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'media');
    await p.getByTestId('bin-stock-open').click();
    const dlg = p.getByTestId('broll-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('broll-query').fill('coffee');
    await dlg.getByTestId('broll-query').press('Enter');
    await expect(dlg.getByTestId('broll-card').first()).toBeVisible();
    await dlg.getByTestId('broll-option').first().click();
    await dlg.getByTestId('broll-add').click();
    await expect
      .poll(async () => (await proj(s)).assets.some((a) => a.id === 'asset-1'))
      .toBe(true);
    const searches = editorBrand(s.state).broll.calls.filter((c) => c.channel === 'broll:search');
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[0]!.payload).toMatchObject({ query: 'coffee' });
    const imports = editorBrand(s.state).broll.calls.filter(
      (c) => c.channel === 'broll:importToProject',
    );
    expect(imports[0]!.payload).toMatchObject({ projectId: 'br-1' });
    const asset = (await proj(s)).assets.find((a) => a.id === 'asset-1')!;
    expect(asset.kind).toBe('video');
    await expect(toastText(p, 'Stock clip added to project media')).toBeVisible();
    await s.close();
  });

  test('Suggest B-roll: needs a selection with words; sends the selected transcript; opens the dialog on the first idea', async () => {
    const s = await edit();
    const p = s.page;
    await binTab(p, 'media');
    const btn = p.getByTestId('bin-stock-suggest');
    await expect(btn).toBeDisabled();
    // a caption line
    await s.act('select', ['cue_1']);
    await expect(btn).toBeEnabled();
    await btn.click();
    const dlg = p.getByTestId('broll-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('broll-query')).toHaveValue('city skyline at night');
    const suggests = () =>
      editorBrand(s.state)
        .broll.calls.filter((c) => c.channel === 'broll:suggest')
        .map((c) => c.payload);
    expect(suggests()).toEqual([{ text: 'small habits compound quickly' }]);
    await expect(p.getByTestId('bin-stock-ideas').locator('li')).toHaveCount(4);
    await p.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    // a video clip: the captions under it
    await s.act('select', ['v2']);
    await btn.click();
    await expect(dlg).toBeVisible();
    expect(suggests()[1]).toEqual({
      text: 'small habits compound quickly small habits compound quickly',
    });
    await p.keyboard.press('Escape');
    // another idea chip re-opens the dialog on that query
    await p
      .getByTestId('bin-stock-ideas')
      .getByRole('button', { name: 'neon street rain' })
      .click();
    await expect(dlg.getByTestId('broll-query')).toHaveValue('neon street rain');
    await s.close();
  });

  test('Suggest B-roll failures are explained, not swallowed', async () => {
    const s = await edit('br-1', {
      broll: { suggest: { error: 'Claude is not available right now.' } },
    });
    const p = s.page;
    await binTab(p, 'media');
    await s.act('select', ['cue_0']);
    await p.getByTestId('bin-stock-suggest').click();
    await expect(toastText(p, 'Suggest B-roll failed')).toContainText('not available');
    await expect(p.getByTestId('broll-dialog')).toHaveCount(0);
    await s.close();
  });
});
