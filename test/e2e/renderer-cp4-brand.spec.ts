import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  canRun,
  createHarness,
  type Harness,
  type OpenOptions,
  type Session,
} from './support/harness';
import { brandControls, brand, dropFiles, openBrand, type SeedOptions } from './support/brand-stub';
import { BRAND_FORMATS, watermarkRect, type BrandKitSpec } from '../../shared/brand';

/**
 * CP4 Brand Kit page against the REAL exported renderer with the contract-validating `window.clipfern` stub
 * (test/e2e/support/brand-stub.ts parses every request and response with the real zod schemas from shared/ipc.ts).
 *
 *   test/e2e/support/brand-build.sh <work-dir> <out-dir>      # a PRIVATE snapshot of the static export
 *   CLIPFERN_E2E_OUT=<out-dir> npx playwright test test/e2e/renderer-cp4-brand.spec.ts
 *
 * Every session asserts: zero console errors/warnings, zero external requests, zero HTTP >= 400.
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

/** The sidebar's Editor link prefetches /editor/, whose CSS Chrome then reports as "preloaded but not used" elsewhere. */
const PRELOAD_NOISE = /was preloaded using link preload but not used within a few seconds/;
const problems = (s: Session) => s.problems.filter((p) => !PRELOAD_NOISE.test(p));

const open = (opts: OpenOptions & { seed?: SeedOptions } = {}, route?: string) =>
  openBrand(h, opts, route);
const sec = (p: Page, id: string) => p.getByTestId(`section-${id}`);
const kitId = (s: Session) => brandControls(s.state).kit().id;
const specOf = (s: Session, id = kitId(s)): BrandKitSpec => brandControls(s.state).kit(id).spec;
const toast = (p: Page, text: string | RegExp) =>
  p.locator('[data-sonner-toast]').filter({ hasText: text });
const lastUpdate = (s: Session) => brand(s.state).log.updates.at(-1)!;
const updates = (s: Session) => brand(s.state).log.updates;
/** Waits until the page reports "Saved" (all edits are on the server). */
const saved = (p: Page) =>
  expect(p.getByTestId('save-chip')).toHaveAttribute('data-status', /saved|idle/);
const imgsLoaded = (l: Locator) =>
  l.evaluateAll((els) =>
    els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0),
  );

/** An h2 whose name is the section title, optionally followed by the item-count badge. */
const sectionHeading = (p: Page, title: string) =>
  p.getByRole('heading', { level: 2, name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\d+)?$`) });

const SECTION_TITLES = [
  'Logos / Watermarks',
  'Images',
  'Videos',
  'Audio',
  'Fonts',
  'Colors',
  'Subtitle Styles',
  'Text Styles',
  'Hook card',
  'Watermark',
  'Intro / Outro',
  'Music bed',
  'Defaults',
];

/* ======================================================================================== page */

test.describe('Page', () => {
  test('renders the kit, every section, the nav and the default star with no console problems', async () => {
    const s = await open();
    const p = s.page;
    await expect(p.getByRole('heading', { name: 'Brand Kit', level: 1 })).toBeVisible();
    for (const t of SECTION_TITLES) await expect(sectionHeading(p, t)).toBeAttached();
    await expect(p.getByTestId('kit-card')).toHaveCount(2);
    await expect(p.getByLabel('Kit name')).toHaveValue('Acme Podcast');
    await expect(p.getByTestId('default-badge')).toBeVisible();
    await expect(p.getByRole('navigation', { name: 'Brand kits' })).toBeVisible();
    const nav = p.getByRole('navigation', { name: 'Brand Kit sections' });
    await expect(nav.getByRole('button')).toHaveCount(13);
    await expect(nav.getByRole('button', { name: /^Logos/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('side navigation scrolls to a section and follows the scroll', async () => {
    const s = await open();
    const p = s.page;
    const nav = p.getByRole('navigation', { name: 'Brand Kit sections' });
    await nav.getByRole('button', { name: /^Watermark/ }).click();
    await expect(nav.getByRole('button', { name: /^Watermark/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect.poll(async () => (await sec(p, 'watermark').boundingBox())!.y).toBeLessThan(260);
    await p.evaluate(() => document.getElementById('main')?.scrollTo({ top: 0 }));
    await expect(nav.getByRole('button', { name: /^Logos/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('shows skeletons while loading and a retry banner when the list fails', async () => {
    const s = await open({
      prepare: (st) => {
        brand(st).readDelayMs = 1200;
        brand(st).failures.set('brand:list', { message: 'Disk unavailable', times: 2 }); // the query client retries once
      },
      settle: 0,
    });
    const p = s.page;
    await expect(p.getByLabel('Loading brand kits')).toBeVisible();
    await expect(
      p.getByRole('alert').filter({ hasText: 'Could not load your brand kits' }),
    ).toBeVisible({
      timeout: 8000,
    });
    await expect(p.getByText('Disk unavailable')).toBeVisible();
    await p.getByRole('button', { name: 'Try again' }).click();
    await expect(p.getByTestId('kit-card')).toHaveCount(2, { timeout: 8000 });
    await s.close();
  });

  test('an unreadable kit shows an error with a retry', async () => {
    const s = await open({
      prepare: (st) => {
        brand(st).failures.set('brand:get', { message: 'Kit file is damaged', times: 2 });
      },
    });
    const p = s.page;
    await expect(p.getByText('Could not open this brand kit')).toBeVisible();
    await expect(p.getByText('Kit file is damaged')).toBeVisible();
    await p.getByRole('button', { name: 'Try again' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Acme Podcast');
    await s.close();
  });

  test('works in light mode, with reduced motion, at 1280 px without horizontal scroll', async () => {
    for (const opts of [
      { theme: 'light' as const, width: 1280, height: 720 },
      { theme: 'dark' as const, reducedMotion: true, width: 1280, height: 720 },
    ]) {
      const s = await open(opts);
      await expect(s.page.getByTestId('section-defaults')).toBeAttached();
      const overflow = await s.page.evaluate(() => {
        const main = document.getElementById('main')!;
        return {
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          main: main.scrollWidth - main.clientWidth,
        };
      });
      expect(overflow.doc).toBeLessThanOrEqual(0);
      expect(overflow.main).toBeLessThanOrEqual(0);
      expect(problems(s)).toEqual([]);
      await s.close();
    }
  });
});

/* =================================================================================== kit management */

test.describe('Kits', () => {
  test('empty state invites the first kit, creating one opens it as the default', async () => {
    const s = await open({ seed: { kits: 'empty' } });
    const p = s.page;
    await expect(p.getByText('Create your first Brand Kit')).toBeVisible();
    await p.getByRole('button', { name: 'Create Brand Kit' }).click();
    const dlg = p.getByTestId('new-kit-dialog');
    await expect(dlg.getByLabel('Name')).toHaveValue('My brand');
    await dlg.getByLabel('Name').fill('First Kit');
    await dlg.getByRole('button', { name: 'Create kit' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('First Kit');
    await expect(p.getByTestId('default-badge')).toBeVisible();
    expect(brand(s.state).log.created).toEqual([{ name: 'First Kit', copyFrom: undefined }]);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('new kit can be a copy of another kit', async () => {
    const s = await open();
    const p = s.page;
    await p.getByRole('button', { name: 'New brand kit' }).first().click();
    const dlg = p.getByTestId('new-kit-dialog');
    await dlg.getByLabel('Name').fill('Campaign B');
    await dlg.getByRole('combobox', { name: 'Start from' }).click();
    await p.getByRole('option', { name: 'Copy of Acme Podcast' }).click();
    await dlg.getByRole('button', { name: 'Create kit' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Campaign B');
    await expect(p.getByTestId('swatch')).toHaveCount(5); // copied colors
    expect(brand(s.state).log.created[0]).toMatchObject({ name: 'Campaign B', copyFrom: kitId(s) });
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('a failed create keeps the dialog open with the reason', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).failNext('brand:create', 'A kit with that name already exists.');
    await p.getByRole('button', { name: 'New brand kit' }).first().click();
    const dlg = p.getByTestId('new-kit-dialog');
    await dlg.getByLabel('Name').fill('Acme Podcast');
    await dlg.getByRole('button', { name: 'Create kit' }).click();
    await expect(dlg.getByRole('alert')).toContainText('already exists');
    await dlg.getByLabel('Name').fill('Another');
    await dlg.getByRole('button', { name: 'Create kit' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Another');
    await s.close();
  });

  test('inline rename saves once after typing stops, with the base revision', async () => {
    const s = await open();
    const p = s.page;
    const before = updates(s).length;
    const name = p.getByLabel('Kit name');
    await name.click();
    await name.press('Control+A');
    await name.pressSequentially('Acme Studio', { delay: 30 });
    await expect(p.getByTestId('save-chip')).toHaveAttribute('data-status', /dirty|saving|saved/);
    await saved(p);
    expect(updates(s).length - before).toBe(1);
    expect(lastUpdate(s)).toMatchObject({ patch: { name: 'Acme Studio' }, baseRev: 1 });
    await expect(p.getByRole('button', { name: 'Acme Studio (default kit)' })).toBeVisible(); // the card follows
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('a name cannot be emptied: the field snaps back on blur', async () => {
    const s = await open();
    const p = s.page;
    const name = p.getByLabel('Kit name');
    await name.press('Control+A');
    await name.press('Backspace');
    await expect(name).toHaveValue('');
    await p.getByRole('heading', { name: 'Brand Kit', level: 1 }).click();
    await expect(name).toHaveValue('Acme Podcast');
    expect(updates(s)).toHaveLength(0);
    await s.close();
  });

  test('duplicate selects the copy', async () => {
    const s = await open();
    const p = s.page;
    await p.getByRole('button', { name: 'Duplicate' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Acme Podcast copy');
    await expect(p.getByTestId('kit-card')).toHaveCount(3);
    await expect(p.getByTestId('default-badge')).toHaveCount(0); // the copy is not the default
    await expect(sec(p, 'logos').getByTestId('asset-card')).toHaveCount(3);
    await s.close();
  });

  test('the star marks a kit as default and the badge follows', async () => {
    const s = await open();
    const p = s.page;
    const other = p.getByRole('button', { name: 'Make Side Hustle Shorts the default kit' });
    await other.click();
    await expect(
      p.getByRole('button', { name: 'Side Hustle Shorts is the default kit' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      p.getByRole('button', { name: 'Make Acme Podcast the default kit' }),
    ).toBeVisible();
    expect(brand(s.state).log.defaults).toHaveLength(1);
    expect(brand(s.state).defaultId).not.toBe(kitId(s));
    // selecting that kit shows the Default badge
    await p.getByRole('button', { name: 'Side Hustle Shorts (default kit)' }).click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    await expect(p.getByTestId('default-badge')).toBeVisible();
    // and the header button of a non-default kit does the same
    await p.getByRole('button', { name: /^Acme Podcast/ }).click();
    await p.getByRole('button', { name: 'Make default' }).click();
    await expect(p.getByTestId('default-badge')).toBeVisible();
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('deleting asks for confirmation, warns about the fallback and removes the kit', async () => {
    const s = await open();
    const p = s.page;
    await p.getByRole('button', { name: 'Delete', exact: true }).click();
    const dlg = p.getByRole('dialog');
    await expect(dlg).toContainText('Delete “Acme Podcast”?');
    await expect(dlg).toContainText('fall back to no branding');
    await expect(dlg).toContainText('default kit');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(brand(s.state).log.deleted).toHaveLength(0);
    await p.getByRole('button', { name: 'Delete', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Delete kit' }).click();
    await expect(p.getByTestId('kit-card')).toHaveCount(1);
    await expect(p.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    await expect(p.getByTestId('default-badge')).toBeVisible(); // the default moved to the remaining kit
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('kit cards are keyboard operable and the choice is remembered; ?kit= deep-links', async () => {
    const s = await open();
    const p = s.page;
    const card = p.getByRole('button', { name: 'Side Hustle Shorts', exact: false }).first();
    await card.focus();
    await p.keyboard.press('Enter');
    await expect(p.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    const remembered = await p.evaluate(() => localStorage.getItem('clipfern.brandKit'));
    expect(remembered).toBeTruthy();
    await p.reload();
    await p.waitForLoadState('networkidle');
    await expect(p.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    await s.close();

    const second = [...brand(s.state).kits.keys()][1]!;
    const t = await open({}, `/brand-kit/?kit=${second}`);
    await expect(t.page.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    await t.close();
  });
});

/* ===================================================================================== upload panels */

test.describe('Upload panels', () => {
  test('say "Drop a file here, or browse." with the supported formats under it', async () => {
    const s = await open({ seed: { kits: 'bare' } });
    const p = s.page;
    const sections = {
      logo: 'logos',
      image: 'images',
      video: 'videos',
      audio: 'audio',
      font: 'fonts',
    } as const;
    for (const [kind, id] of Object.entries(sections) as [keyof typeof sections, string][]) {
      const panel = p.getByTestId(`upload-${kind}`);
      await expect(panel).toBeVisible();
      await expect(panel).toHaveText(
        new RegExp(
          `Drop a file here, or browse\\.\\s*Supported: ${BRAND_FORMATS[kind].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
      await expect(panel.getByRole('button', { name: /^Browse/ })).toHaveText('browse');
      await expect(sec(p, id).getByRole('group', { name: /upload$/ })).toBeVisible();
    }
    await expect(p.getByTestId('upload-font')).toHaveText(
      'Drop a file here, or browse. Supported: TTF, OTF, WOFF, WOFF2',
    );
    await s.close();
  });

  test('dropping files resolves their paths with pathForFile and shows progress, then the new cards', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).state.stageDelayMs = 400;
    const panel = p.getByTestId('upload-logo');
    const drop = dropFiles(s, panel, [
      { name: 'new-logo.png', path: '/Users/me/Desktop/new-logo.png' },
      { name: 'second.svg', path: '/Users/me/Desktop/second.svg' },
    ]);
    const rows = sec(p, 'logos').getByTestId('upload-row-working');
    await expect(rows.first()).toBeVisible();
    await expect(sec(p, 'logos').getByRole('progressbar').first()).toHaveAttribute(
      'aria-valuenow',
      /\d+/,
      { timeout: 5000 },
    );
    await expect(sec(p, 'logos')).toContainText(/Reading file|Uploading|Making preview/);
    await drop;
    await expect(sec(p, 'logos').getByTestId('asset-card')).toHaveCount(5, { timeout: 15_000 });
    await expect(sec(p, 'logos').getByTestId('upload-row-working')).toHaveCount(0);
    expect(brand(s.state).log.added).toEqual([
      {
        kitId: kitId(s),
        kind: 'logo',
        paths: ['/Users/me/Desktop/new-logo.png', '/Users/me/Desktop/second.svg'],
      },
    ]);
    await expect(toast(p, 'Added 2 logos')).toBeVisible();
    await expect(sec(p, 'logos')).toContainText('new-logo.png');
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('the panel reacts to a file being dragged over it', async () => {
    const s = await open();
    const p = s.page;
    const panel = p.getByTestId('upload-image');
    await panel.dispatchEvent('dragenter', {
      dataTransfer: await p.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.png'));
        return dt;
      }),
    });
    await expect(panel).toHaveAttribute('data-over', 'true');
    await expect(panel).toContainText('Drop to add images');
    await panel.dispatchEvent('dragleave', {
      dataTransfer: await p.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.png'));
        return dt;
      }),
    });
    await expect(panel).not.toHaveAttribute('data-over', 'true');
    await s.close();
  });

  test('wrong file types are rejected up front with a clear, dismissible message (nothing is sent)', async () => {
    const s = await open();
    const p = s.page;
    await dropFiles(s, p.getByTestId('upload-logo'), [
      { name: 'notes.txt' },
      { name: 'song.mp3' },
      { name: 'huge.png', size: 99 * 2 ** 20 },
    ]);
    const errors = sec(p, 'logos').getByTestId('upload-row-error');
    await expect(errors).toHaveCount(3);
    await expect(errors.nth(0)).toContainText('notes.txt');
    await expect(errors.nth(0)).toContainText('.TXT is not supported here. Use PNG, SVG, WEBP.');
    await expect(errors.nth(1)).toContainText('belongs in Audio');
    await expect(errors.nth(2)).toContainText('Too large (99 MB)');
    expect(brand(s.state).log.added).toHaveLength(0);
    await errors
      .nth(0)
      .getByRole('button', { name: /Dismiss error for notes.txt/ })
      .click();
    await expect(errors).toHaveCount(2);
    // recovery: "Choose another file" opens the file dialog
    await errors.first().getByRole('button', { name: 'Choose another file' }).click();
    await expect.poll(() => brand(s.state).log.browsed.length).toBe(1);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('an error reported by main for one file does not hide the files that worked', async () => {
    const s = await open();
    const p = s.page;
    await dropFiles(s, p.getByTestId('upload-image'), [
      { name: 'fine.png' },
      { name: 'broken.png' },
    ]);
    await expect(sec(p, 'images').getByTestId('asset-card')).toHaveCount(3);
    const err = sec(p, 'images').getByTestId('upload-row-error');
    await expect(err).toHaveCount(1);
    await expect(err).toContainText('broken.png');
    await expect(err).toContainText('could not read this file');
    await expect(toast(p, 'Added 1 image')).toBeVisible();
    await err.getByRole('button', { name: /Dismiss/ }).click();
    await expect(err).toHaveCount(0);
    await s.close();
  });

  test('a failing call (main unavailable) shows an error row per file', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).failNext('brand:addFiles', 'Storage is not configured.');
    await dropFiles(s, p.getByTestId('upload-video'), [{ name: 'intro.mp4' }]);
    await expect(sec(p, 'videos').getByTestId('upload-row-error')).toContainText(
      'Storage is not configured.',
    );
    await s.close();
  });

  test('"browse" opens the native dialog through brand:browse; picking files adds them, cancelling does nothing', async () => {
    const s = await open();
    const p = s.page;
    const c = brandControls(s.state);
    await sec(p, 'audio').getByRole('button', { name: 'Browse for audio files' }).click();
    await expect.poll(() => brand(s.state).log.browsed.length).toBe(1);
    await expect(sec(p, 'audio').getByTestId('asset-card')).toHaveCount(2);
    c.queueBrowse([{ name: 'riser.wav' }, { name: 'bed2.mp3' }]);
    await sec(p, 'audio').getByRole('button', { name: 'Browse for audio files' }).click();
    await expect(sec(p, 'audio').getByTestId('asset-card')).toHaveCount(4);
    expect(brand(s.state).log.browsed.map((b) => b.kind)).toEqual(['audio', 'audio']);
    await expect(toast(p, 'Added 2 audio files')).toBeVisible();
    await s.close();
  });

  test('"browse" is reachable and operable with the keyboard', async () => {
    const s = await open();
    const p = s.page;
    const b = sec(p, 'fonts').getByRole('button', { name: 'Browse for fonts' });
    await b.focus();
    await expect(b).toBeFocused();
    await p.keyboard.press('Enter');
    await expect.poll(() => brand(s.state).log.browsed.length).toBe(1);
    await s.close();
  });
});

/* ======================================================================================== assets */

test.describe('Assets', () => {
  test('logo cards show thumbnails, size info and the watermark badge', async () => {
    const s = await open();
    const p = s.page;
    const cards = sec(p, 'logos').getByTestId('asset-card');
    await expect(cards).toHaveCount(3);
    await expect.poll(() => imgsLoaded(cards.locator('img'))).toBe(true);
    await expect(cards.first()).toContainText('acme-mark.svg');
    await expect(cards.first()).toContainText('512×512');
    await expect(cards.first()).toContainText('Watermark');
    await s.close();
  });

  test('rename in place with Enter, cancel with Escape', async () => {
    const s = await open();
    const p = s.page;
    const card = sec(p, 'images').getByTestId('asset-card').first();
    await card.hover();
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Rename' }).click();
    const input = card.getByRole('textbox', { name: /Rename/ });
    await input.fill('cta-sticker.png');
    await input.press('Enter');
    await expect(card).toContainText('cta-sticker.png');
    expect(brand(s.state).log.renamed).toEqual([
      { id: expect.any(String), name: 'cta-sticker.png' },
    ]);
    await card.hover();
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Rename' }).click();
    await card.getByRole('textbox', { name: /Rename/ }).fill('zzz');
    await card.getByRole('textbox', { name: /Rename/ }).press('Escape');
    await expect(card).toContainText('cta-sticker.png');
    expect(brand(s.state).log.renamed).toHaveLength(1);
    await s.close();
  });

  test('deleting the watermark logo says what it clears and clears it', async () => {
    const s = await open();
    const p = s.page;
    const mark = sec(p, 'logos').getByTestId('asset-card').filter({ hasText: 'acme-mark.svg' });
    await mark.hover();
    await mark.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: /Delete/ }).click();
    const dlg = p.getByRole('dialog');
    await expect(dlg).toContainText('Delete “acme-mark.svg”?');
    await expect(dlg.getByTestId('clears-list')).toContainText('Watermark');
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(sec(p, 'logos').getByTestId('asset-card')).toHaveCount(2);
    await expect(toast(p, 'Also cleared: watermark')).toBeVisible();
    expect(specOf(s).watermark.assetId).toBeNull();
    // the watermark section no longer has a chosen logo; the placeholder box shows instead
    await expect(
      sec(p, 'watermark').getByRole('radio', { name: 'No watermark logo' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('deleting an unused asset has no warning; Cancel keeps it', async () => {
    const s = await open();
    const p = s.page;
    const card = sec(p, 'logos').getByTestId('asset-card').filter({ hasText: 'acme-mono.png' });
    await card.hover();
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: /Delete/ }).click();
    await expect(p.getByTestId('clears-list')).toHaveCount(0);
    await p.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(sec(p, 'logos').getByTestId('asset-card')).toHaveCount(3);
    expect(brand(s.state).log.deletedAssets).toHaveLength(0);
    await s.close();
  });

  test('select several (shift-click range) and delete them together', async () => {
    const s = await open();
    const p = s.page;
    const grid = sec(p, 'logos');
    await grid.getByRole('checkbox', { name: 'Select acme-wordmark.svg' }).click({ force: true });
    await grid
      .getByRole('checkbox', { name: 'Select acme-mono.png' })
      .click({ force: true, modifiers: ['Shift'] });
    await expect(grid.getByRole('toolbar', { name: /Selected logos/ })).toContainText('2 selected');
    await grid.getByRole('button', { name: 'Delete', exact: true }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(grid.getByTestId('asset-card')).toHaveCount(1);
    expect(brand(s.state).log.deletedAssets[0]).toHaveLength(2);
    await expect(toast(p, 'Deleted 2 logos')).toBeVisible();
    await s.close();
  });

  test('long lists are virtualised: only visible rows are mounted, scrolling reveals the rest', async () => {
    const s = await open({ seed: { manyImages: 160 } });
    const p = s.page;
    const grid = sec(p, 'images').getByTestId('virtual-grid');
    await expect(grid).toBeVisible();
    expect(Number(await grid.getAttribute('data-total'))).toBe(162);
    const rendered = Number(await grid.getAttribute('data-rendered'));
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(60);
    await expect(grid.getByTestId('asset-card').first()).toContainText('subscribe-sticker.png');
    await expect(grid.getByText('bulk-160.png')).toHaveCount(0);
    await grid.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(grid.getByText('bulk-160.png')).toBeVisible();
    await expect(grid.getByText('subscribe-sticker.png')).toHaveCount(0);
    expect(Number(await grid.getAttribute('data-rendered'))).toBeLessThan(60);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('audio: play the normalised preview, only one plays at a time, LUFS is shown', async () => {
    const s = await open();
    const p = s.page;
    const cards = sec(p, 'audio').getByTestId('asset-card');
    await expect(cards.first()).toContainText('-17.6 LUFS');
    await expect(cards.nth(1)).toContainText('-22.1 LUFS');
    await cards.first().getByRole('button', { name: 'Play lofi-bed.mp3' }).click();
    await expect(cards.first().getByRole('button', { name: 'Pause lofi-bed.mp3' })).toBeVisible();
    await cards.nth(1).getByRole('button', { name: 'Play whoosh.wav' }).click();
    await expect(cards.nth(1).getByRole('button', { name: 'Pause whoosh.wav' })).toBeVisible();
    await expect(cards.first().getByRole('button', { name: 'Play lofi-bed.mp3' })).toBeVisible();
    await cards.nth(1).getByRole('button', { name: 'Pause whoosh.wav' }).click();
    await expect(cards.nth(1).getByRole('button', { name: 'Play whoosh.wav' })).toBeVisible();
    // seek bar is a labelled slider
    await expect(cards.first().getByRole('slider', { name: 'Seek lofi-bed.mp3' })).toBeVisible();
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('fonts: registered for the page, previewed in their own face with editable sample text', async () => {
    const s = await open();
    const p = s.page;
    const fonts = sec(p, 'fonts');
    await expect(fonts.getByTestId('asset-card')).toHaveCount(2);
    await expect(fonts.getByTestId('asset-card').first()).toContainText('Acme Display · Bold 700');
    await expect(fonts.getByTestId('asset-card').nth(1)).toContainText('Regular 400');
    await expect
      .poll(() => p.evaluate(() => document.fonts.check('700 20px "Acme Display"')))
      .toBe(true);
    await expect
      .poll(() => p.evaluate(() => document.fonts.check('400 20px "Acme Serif"')))
      .toBe(true);
    const sample = fonts.getByLabel('Preview text');
    await sample.fill('Hello brand');
    await expect(fonts.getByTestId('font-sample').first()).toHaveText('Hello brand');
    const css = await fonts
      .getByTestId('font-sample')
      .first()
      .evaluate((e) => {
        const c = getComputedStyle(e);
        return { family: c.fontFamily, weight: c.fontWeight };
      });
    expect(css.family).toContain('Acme Display');
    expect(css.weight).toBe('700');
    await s.close();
  });

  test('videos: poster, duration, stock credit link; hover previews; "Find stock footage" opens the dialog without errors', async () => {
    const s = await open();
    const p = s.page;
    const cards = sec(p, 'videos').getByTestId('asset-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('0:03');
    await expect(cards.first()).toContainText('Intro');
    await expect(cards.nth(1)).toContainText('Pexels · Jane Doe');
    await cards
      .nth(1)
      .getByRole('button', { name: /Pexels/ })
      .click();
    expect(s.state.log.external).toBeDefined();
    await cards.first().hover();
    await expect(cards.first().locator('video')).toHaveAttribute('src', /clip-a\.webm/);
    await p.getByRole('heading', { name: 'Videos', level: 2 }).hover();
    await expect(cards.first().locator('video')).toHaveCount(0);
    await sec(p, 'videos').getByRole('button', { name: 'Find stock footage' }).click();
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('"Use as …" actions on cards set the watermark, intro, outro and music bed', async () => {
    const s = await open();
    const p = s.page;
    const wm = sec(p, 'logos').getByTestId('asset-card').filter({ hasText: 'acme-wordmark.svg' });
    await wm.hover();
    await wm.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Use as watermark' }).click();
    await expect(wm).toContainText('Watermark');
    await expect(toast(p, 'Watermark set')).toBeVisible();
    const vid = sec(p, 'videos').getByTestId('asset-card').nth(1);
    await vid.hover();
    await vid.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Use as outro' }).click();
    await expect(vid).toContainText('Outro');
    const aud = sec(p, 'audio').getByTestId('asset-card').nth(1);
    await aud.hover();
    await aud.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Use as music bed' }).click();
    await expect(aud).toContainText('Music bed');
    await saved(p);
    const sp = specOf(s);
    expect(sp.watermark.assetId).toBe(await wm.getAttribute('data-asset-id'));
    expect(sp.outroAssetId).toBe(await vid.getAttribute('data-asset-id'));
    expect(sp.musicBed.assetId).toBe(await aud.getAttribute('data-asset-id'));
    await s.close();
  });
});

/* ======================================================================================== colors */

test.describe('Colors', () => {
  test('swatches are grouped, named and show their hex', async () => {
    const s = await open();
    const p = s.page;
    const groups = sec(p, 'colors').getByTestId('color-group');
    await expect(groups).toHaveCount(3);
    await expect(groups.first()).toContainText('Primary');
    await expect(groups.first().getByTestId('swatch')).toHaveCount(2);
    await expect(groups.first()).toContainText('Acme Violet');
    await expect(groups.first()).toContainText('#6A4BF2');
    await s.close();
  });

  test('add a color with a name, hex and group', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'colors').getByRole('button', { name: 'Add colors' }).click();
    const pop = p.getByRole('dialog', { name: 'Add colors' });
    await pop.getByLabel('Name').fill('Sky');
    await pop.getByLabel('Color', { exact: true }).fill('3ea6ff');
    await pop.getByLabel('Palette group').fill('Accent');
    await pop.getByRole('button', { name: 'Add color' }).click();
    await saved(p);
    const added = specOf(s).colors.at(-1)!;
    expect(added).toMatchObject({ name: 'Sky', hex: '#3EA6FF', group: 'Accent' });
    await expect(
      sec(p, 'colors')
        .getByTestId('color-group')
        .filter({ hasText: 'Accent' })
        .getByTestId('swatch'),
    ).toHaveCount(2);
    await s.close();
  });

  test('paste several hex codes at once', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'colors').getByRole('button', { name: 'Add colors' }).click();
    const pop = p.getByRole('dialog', { name: 'Add colors' });
    await pop.getByLabel('Or paste several').fill('#ff0000, #00ff00 0000ff');
    await expect(pop).toContainText('3 colors found');
    await pop.getByRole('button', { name: 'Add 3 colors' }).click();
    await saved(p);
    expect(
      specOf(s)
        .colors.map((c) => c.hex)
        .slice(-3),
    ).toEqual(['#FF0000', '#00FF00', '#0000FF']);
    await s.close();
  });

  test('edit a swatch (name, hex, group) and remove it', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'colors')
      .getByRole('button', { name: /Sunbeam #FFE94D, edit/ })
      .click();
    const pop = p.locator('[role=dialog][aria-label^="Edit "]'); // its name follows the swatch name
    await pop.getByLabel('Name').fill('Sun');
    await pop.getByLabel('Color', { exact: true }).fill('#FFD60A');
    await saved(p);
    expect(specOf(s).colors.find((c) => c.id === 'c2')).toMatchObject({
      name: 'Sun',
      hex: '#FFD60A',
    });
    await pop.getByRole('button', { name: 'Remove' }).click();
    await saved(p);
    expect(specOf(s).colors.find((c) => c.id === 'c2')).toBeUndefined();
    await expect(sec(p, 'colors').getByTestId('swatch')).toHaveCount(4);
    await s.close();
  });

  test('extract from logo proposes swatches, existing colors are flagged, accepted ones join the palette', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'colors').getByRole('button', { name: 'Extract from logo' }).click();
    const panel = p.getByTestId('extract-panel');
    await expect(panel).toContainText('Colors found in “acme-mark.svg”');
    const boxes = panel.getByRole('checkbox');
    await expect(boxes).toHaveCount(5);
    await expect(
      panel.getByRole('checkbox', { name: /#6A4BF2 \(already in your palette\)/ }),
    ).toBeDisabled();
    await expect(panel.getByRole('checkbox', { name: '#FF5FB0' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(
      panel.getByRole('checkbox', { name: '#2EE6D6 (already in your palette)' }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('checkbox', { name: '#101114 (already in your palette)' }),
    ).toBeDisabled();
    await panel.getByRole('checkbox', { name: '#FFFFFF' }).click(); // untick white
    await panel.getByLabel('Add to group').fill('From logo');
    await panel.getByRole('button', { name: /Add 1 color$/ }).click();
    await saved(p);
    const added = specOf(s).colors.filter((c) => c.group === 'From logo');
    expect(added.map((c) => c.hex)).toEqual(['#FF5FB0']);
    expect(added[0]!.name).toMatch(/pink|red|violet/i);
    expect(brand(s.state).log.extracted[0]).toMatchObject({ count: 6 });
    await expect(panel).toHaveCount(0);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('extraction failures offer a retry; the asset menu starts an extraction too', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).failNext('brand:extractColors', 'This file has no pixels to read.');
    await sec(p, 'colors').getByRole('button', { name: 'Extract from logo' }).click();
    const panel = p.getByTestId('extract-panel');
    await expect(panel).toContainText('Could not read colors');
    await expect(panel).toContainText('no pixels');
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByRole('checkbox')).toHaveCount(5);
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel).toHaveCount(0);
    const card = sec(p, 'logos').getByTestId('asset-card').filter({ hasText: 'acme-mark.svg' });
    await card.hover();
    await card.getByRole('button', { name: /^Actions for/ }).click();
    await p.getByRole('menuitem', { name: 'Extract colors' }).click();
    await expect(p.getByTestId('extract-panel')).toContainText('acme-mark.svg');
    await s.close();
  });
});

/* ================================================================================== subtitle styles */

test.describe('Subtitle styles', () => {
  test('lists the kit styles with a real preview and marks the default with a star', async () => {
    const s = await open();
    const p = s.page;
    const card = sec(p, 'subtitle-styles').getByTestId('kit-style-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Acme Punch');
    await card.scrollIntoViewIfNeeded(); // thumbnails render lazily once they scroll into view
    await expect(card.getByTestId('style-thumb')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await expect(card.getByRole('img')).toBeVisible();
    await card
      .getByRole('button', { name: 'Use Acme Punch as the default subtitle style' })
      .click();
    await expect(
      card.getByRole('button', { name: 'Acme Punch is the default subtitle style' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toContainText('Default');
    await saved(p);
    expect(specOf(s).defaults.captionStyleId).toBe('kit-style-1');
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('"Add subtitle styles": pick a built-in preset, tune it in the Style Studio editor, save through brand:saveStyle', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'subtitle-styles').getByRole('button', { name: 'Add subtitle styles' }).click();
    const dlg = p.getByTestId('kit-style-dialog');
    await expect(dlg.getByTestId('preset-tile')).toHaveCount(14);
    await expect(dlg.getByTestId('preset-tile').first()).toContainText('Clean Pop');
    await dlg.getByRole('button', { name: 'Start from Neon Glow' }).click();
    // the SAME editor + live libass preview as the Caption Style Studio
    await expect(dlg.getByTestId('style-editor')).toBeVisible();
    await expect(dlg.getByTestId('style-preview-img')).toBeVisible({ timeout: 20_000 });
    const name = dlg.getByLabel('Style name');
    await expect(name).toHaveValue('Neon Glow');
    await name.fill('Acme Neon');
    await dlg.getByRole('button', { name: 'Add style' }).click();
    await expect(sec(p, 'subtitle-styles').getByTestId('kit-style-card')).toHaveCount(2);
    const saved1 = brand(s.state).log.savedStyles.at(-1)!;
    expect(saved1.kitId).toBe(kitId(s));
    expect(saved1.style).toMatchObject({ name: 'Acme Neon', builtin: false });
    await expect(toast(p, 'Added “Acme Neon”')).toBeVisible();
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('"Save and use as default" also stores the style as the kit default', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'subtitle-styles').getByRole('button', { name: 'Add subtitle styles' }).click();
    const dlg = p.getByTestId('kit-style-dialog');
    await dlg.getByRole('button', { name: 'Start from Boxed Highlight' }).click();
    await dlg.getByRole('button', { name: 'Save and use as default' }).click();
    await expect(sec(p, 'subtitle-styles').getByTestId('kit-style-card')).toHaveCount(2);
    await saved(p);
    const newest = brand(s.state).log.savedStyles.at(-1)!.style;
    const id = [...brand(s.state).styleKit.keys()].at(-1)!;
    expect(newest.name).toBe('Boxed Highlight');
    expect(specOf(s).defaults.captionStyleId).toBe(id);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('edit an existing style (Save is only enabled after a change), duplicate and delete it', async () => {
    const s = await open();
    const p = s.page;
    const card = sec(p, 'subtitle-styles').getByTestId('kit-style-card');
    await card.getByRole('button', { name: 'Edit Acme Punch' }).click();
    const dlg = p.getByTestId('kit-style-dialog');
    const save = dlg.getByTestId('kit-style-save');
    await expect(save).toBeDisabled();
    await dlg.getByLabel('Style name').fill('Acme Punch v2');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(card).toContainText('Acme Punch v2');
    expect(brand(s.state).log.savedStyles.at(-1)!.style.id).toBe('kit-style-1'); // updated in place

    await card.getByRole('button', { name: 'More actions for Acme Punch v2' }).click();
    await p.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(sec(p, 'subtitle-styles').getByTestId('kit-style-card')).toHaveCount(2);

    const first = sec(p, 'subtitle-styles').getByTestId('kit-style-card').first();
    await first.getByRole('button', { name: /More actions for/ }).click();
    await p.getByRole('menuitem', { name: /Delete/ }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Delete style' }).click();
    await expect(sec(p, 'subtitle-styles').getByTestId('kit-style-card')).toHaveCount(1);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('the dialog can go back to the presets and closes without saving', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'subtitle-styles').getByRole('button', { name: 'Add subtitle styles' }).click();
    const dlg = p.getByTestId('kit-style-dialog');
    await dlg.getByRole('button', { name: 'Start from Typewriter' }).click();
    await expect(dlg.getByLabel('Style name')).toHaveValue('Typewriter');
    await dlg.getByRole('button', { name: 'Back to presets' }).click();
    await expect(dlg.getByTestId('preset-tile')).toHaveCount(14);
    await p.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(brand(s.state).log.savedStyles).toHaveLength(0);
    await s.close();
  });

  test('a save error stays in the dialog with the reason', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).failNext('brand:saveStyle', 'Storage is full.');
    await sec(p, 'subtitle-styles').getByRole('button', { name: 'Add subtitle styles' }).click();
    const dlg = p.getByTestId('kit-style-dialog');
    await dlg.getByRole('button', { name: 'Start from Clean Pop' }).click();
    await dlg.getByRole('button', { name: 'Add style' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Storage is full.');
    await dlg.getByRole('button', { name: 'Add style' }).click();
    await expect(dlg).toHaveCount(0);
    await s.close();
  });
});

/* ====================================================================================== text styles */

test.describe('Text styles', () => {
  test('cards preview the style; "Add text styles" starts from a preset, edits live and saves into the kit', async () => {
    const s = await open();
    const p = s.page;
    const cards = sec(p, 'text-styles').getByTestId('text-style-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().getByTestId('text-style-sample')).toContainText(
      'Nobody tells you this about editing',
    );
    await sec(p, 'text-styles').getByRole('button', { name: 'Add text styles' }).click();
    const dlg = p.getByTestId('text-style-dialog');
    await expect(dlg.getByTestId('text-preset')).toHaveCount(9);
    await dlg.getByRole('radio', { name: 'Call to action' }).click();
    await expect(dlg.getByTestId('text-preset')).toHaveCount(2);
    await dlg.getByRole('button', { name: 'Start from Follow Pill' }).click();
    await dlg.getByLabel('Name', { exact: true }).fill('Acme Follow');
    await dlg.getByLabel('Size value').fill('64');
    await dlg.getByLabel('Size value').press('Enter');
    const sample = dlg.getByTestId('text-style-sample');
    await expect.poll(() => sample.evaluate((e) => getComputedStyle(e).fontSize)).not.toBe('0px');
    await dlg.getByRole('combobox', { name: 'Animation in' }).click();
    await p.getByRole('option', { name: 'Bounce' }).click();
    await dlg.getByRole('switch', { name: 'Outline' }).click();
    await dlg.getByTestId('text-style-save').click();
    await expect(cards).toHaveCount(3);
    await saved(p);
    const st = specOf(s).textStyles.at(-1)!;
    expect(st).toMatchObject({ name: 'Acme Follow', kind: 'cta' });
    expect(st.style.size).toBe(64);
    expect(st.style.stroke).not.toBeNull();
    expect(st.animIn.type).toBe('bounce');
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('the editor preview follows font, color, box and format changes', async () => {
    const s = await open();
    const p = s.page;
    await sec(p, 'text-styles').getByRole('button', { name: 'Edit Name Plate' }).click();
    const dlg = p.getByTestId('text-style-dialog');
    const sample = dlg.getByTestId('text-style-sample');
    await expect
      .poll(() => sample.evaluate((e) => getComputedStyle(e).fontFamily))
      .toContain('Poppins');
    await dlg.getByRole('combobox', { name: 'Font family' }).click();
    await p.getByRole('option', { name: /Acme Display/ }).click();
    await expect
      .poll(() => sample.evaluate((e) => getComputedStyle(e).fontFamily))
      .toContain('Acme Display');
    await dlg.getByLabel('Text color picker').evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, '#ff0000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect
      .poll(() => sample.evaluate((e) => getComputedStyle(e).color))
      .toBe('rgb(255, 0, 0)');
    await dlg.getByRole('switch', { name: 'Background box' }).click(); // off
    await expect
      .poll(() => sample.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe('rgba(0, 0, 0, 0)');
    await dlg.getByRole('radio', { name: '16:9' }).click();
    await expect(dlg.getByTestId('text-style-preview')).toHaveCSS('aspect-ratio', '16 / 9');
    await dlg.getByRole('button', { name: 'Replay animation' }).click();
    await s.close();
  });

  test('hook-kind styles can be the default hook text style; duplicate and delete', async () => {
    const s = await open();
    const p = s.page;
    const hook = sec(p, 'text-styles').getByTestId('text-style-card').first();
    await hook
      .getByRole('button', { name: 'Use Hook Card as the default hook text style' })
      .click();
    await expect(
      hook.getByRole('button', { name: 'Hook Card is the default hook text style' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await saved(p);
    expect(specOf(s).defaults.hookTextStyleId).toBe('ts1');
    // defaults section shows it
    await expect(
      sec(p, 'defaults').getByRole('combobox', { name: 'Default hook text style' }),
    ).toContainText('Hook Card');
    await hook.getByRole('button', { name: 'More actions for Hook Card' }).click();
    await p.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(sec(p, 'text-styles').getByTestId('text-style-card')).toHaveCount(3);
    await hook.getByRole('button', { name: 'More actions for Hook Card' }).click();
    await p.getByRole('menuitem', { name: /Delete/ }).click();
    await expect(p.getByRole('dialog')).toContainText('default hook text style');
    await p.getByRole('dialog').getByRole('button', { name: 'Delete style' }).click();
    await saved(p);
    expect(specOf(s).textStyles.find((t) => t.id === 'ts1')).toBeUndefined();
    expect(specOf(s).defaults.hookTextStyleId).toBeNull();
    await s.close();
  });
});

/* ========================================================================================= hook */

test.describe('Hook card', () => {
  test('edits update the live card and the kit', async () => {
    const s = await open();
    const p = s.page;
    const hook = sec(p, 'hook');
    const card = hook.getByTestId('hook-card');
    await expect(card).toContainText('Nobody tells you this about editing');
    await expect
      .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe('rgb(255, 255, 255)');
    await hook.getByRole('radio', { name: 'UPPERCASE' }).click();
    await expect(card).toHaveText('NOBODY TELLS YOU THIS ABOUT EDITING');
    await hook.getByLabel('Card color picker').evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, '#6a4bf2');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect
      .poll(() => card.evaluate((e) => getComputedStyle(e).backgroundColor))
      .toBe('rgb(106, 75, 242)');
    await hook.getByLabel('Vertical position value').fill('60');
    await hook.getByLabel('Vertical position value').press('Enter');
    await expect
      .poll(async () => {
        const f = (await hook.getByTestId('hook-preview').boundingBox())!;
        const c = (await card.boundingBox())!;
        return Math.round(((c.y + c.height / 2 - f.y) / f.height) * 100);
      })
      .toBe(60);
    await hook.getByRole('combobox', { name: 'Hook font' }).click();
    await p.getByRole('option', { name: /Anton/ }).click();
    await saved(p);
    expect(specOf(s).hook).toMatchObject({
      textCase: 'upper',
      cardColor: '#6A4BF2',
      yPct: 60,
      fontFamily: 'Anton',
    });
    await expect(hook.getByRole('button', { name: 'Reset to default' })).toBeEnabled();
    await hook.getByRole('button', { name: 'Reset to default' }).click();
    await saved(p);
    expect(specOf(s).hook).toMatchObject({
      fontFamily: 'Montserrat',
      cardColor: '#FFFFFF',
      yPct: 18,
      textCase: 'none',
    });
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('brand colors are offered as swatches', async () => {
    const s = await open();
    const p = s.page;
    const hook = sec(p, 'hook');
    await hook.getByRole('button', { name: 'Text color: Acme Violet' }).click();
    await saved(p);
    expect(specOf(s).hook.textColor).toBe('#6A4BF2');
    await expect(hook.getByRole('button', { name: 'Text color: Acme Violet' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await s.close();
  });
});

/* ===================================================================================== watermark */

test.describe('Watermark', () => {
  /** The preview's logo box as measured in the DOM, as % of the frame, vs watermarkRect for the same numbers. */
  async function geometry(p: Page) {
    const frame = (await p.getByTestId('watermark-preview').boundingBox())!;
    const box = (await p.getByTestId('watermark-box').boundingBox())!;
    const [cw, ch] = (
      (await p.getByTestId('watermark-preview').getAttribute('data-canvas')) as string
    )
      .split('x')
      .map(Number) as [number, number];
    return {
      canvas: { width: cw, height: ch },
      // DOM -> canvas px
      x: ((box.x - frame.x) / frame.width) * cw,
      y: ((box.y - frame.y) / frame.height) * ch,
      w: (box.width / frame.width) * cw,
      h: (box.height / frame.height) * ch,
      rect: (await p.getByTestId('watermark-box').getAttribute('data-rect'))!
        .split(',')
        .map(Number) as [number, number, number, number],
    };
  }
  const near = (a: number, b: number, tol = 3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

  test('preview geometry equals watermarkRect for every position, size, margin, safe area and aspect', async () => {
    const s = await open();
    const p = s.page;
    const wm = sec(p, 'watermark');
    const logoAspect = 1; // acme-mark.svg is 512x512
    const positions = [
      ['Top left', 'top-left'],
      ['Top right', 'top-right'],
      ['Bottom left', 'bottom-left'],
      ['Bottom right', 'bottom-right'],
      ['Center', 'center'],
    ] as const;
    for (const [label, pos] of positions) {
      await wm.getByRole('radio', { name: label }).click();
      await expect(wm.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
      const g = await geometry(p);
      const want = watermarkRect(
        g.canvas,
        { position: pos, sizePct: 16, marginPct: 4, safeArea: 'all' },
        logoAspect,
      );
      expect(g.rect).toEqual([want.x, want.y, want.w, want.h]);
      await expect
        .poll(async () => Math.abs((await geometry(p)).x - want.x))
        .toBeLessThanOrEqual(3);
      const g2 = await geometry(p);
      near(g2.y, want.y);
      near(g2.w, want.w);
      near(g2.h, want.h);
    }
    // sliders / numbers
    await wm.getByRole('radio', { name: 'Bottom right' }).click();
    await wm.getByLabel('Size value').fill('30');
    await wm.getByLabel('Size value').press('Enter');
    await wm.getByLabel('Margin value').fill('9');
    await wm.getByLabel('Margin value').press('Enter');
    for (const safe of [
      'None (margin only)',
      'TikTok',
      'Instagram Reels',
      'YouTube Shorts',
      'All platforms (TikTok, Reels, Shorts)',
    ]) {
      await wm.getByRole('combobox', { name: 'Safe area' }).click();
      await p.getByRole('option', { name: safe }).click();
      const id = {
        'None (margin only)': 'none',
        TikTok: 'tiktok',
        'Instagram Reels': 'reels',
        'YouTube Shorts': 'shorts',
        'All platforms (TikTok, Reels, Shorts)': 'all',
      }[safe] as 'none';
      const g = await geometry(p);
      const want = watermarkRect(
        g.canvas,
        { position: 'bottom-right', sizePct: 30, marginPct: 9, safeArea: id },
        logoAspect,
      );
      expect(g.rect).toEqual([want.x, want.y, want.w, want.h]);
      await expect
        .poll(async () => Math.abs((await geometry(p)).y - want.y))
        .toBeLessThanOrEqual(3);
    }
    // other aspect ratios use their own canvas
    for (const [aspect, dims] of [
      ['4:5', [1080, 1350]],
      ['1:1', [1080, 1080]],
      ['16:9', [1920, 1080]],
    ] as const) {
      await wm.getByRole('radio', { name: aspect }).click();
      const g = await geometry(p);
      expect([g.canvas.width, g.canvas.height]).toEqual(dims);
      const want = watermarkRect(
        g.canvas,
        { position: 'bottom-right', sizePct: 30, marginPct: 9, safeArea: 'all' },
        logoAspect,
      );
      expect(g.rect).toEqual([want.x, want.y, want.w, want.h]);
      await expect
        .poll(async () => Math.abs((await geometry(p)).x - want.x))
        .toBeLessThanOrEqual(3);
    }
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('the wordmark logo uses its own aspect ratio', async () => {
    const s = await open();
    const p = s.page;
    const wm = sec(p, 'watermark');
    await wm.getByRole('radio', { name: 'acme-wordmark.svg' }).click(); // 640x200
    const g = await geometry(p);
    const want = watermarkRect(
      g.canvas,
      { position: 'top-right', sizePct: 16, marginPct: 4, safeArea: 'all' },
      640 / 200,
    );
    expect(g.rect).toEqual([want.x, want.y, want.w, want.h]);
    expect(g.rect[2] / g.rect[3]).toBeCloseTo(3.2, 1);
    await saved(p);
    expect(specOf(s).watermark.assetId).toBeTruthy();
    await s.close();
  });

  test('edits are saved, the safe-area overlay is shown for vertical frames only', async () => {
    const s = await open();
    const p = s.page;
    const wm = sec(p, 'watermark');
    await expect(wm.getByTestId('safe-overlay')).toBeVisible();
    await wm.getByRole('radio', { name: 'Off' }).click();
    await expect(wm.getByTestId('safe-overlay')).toHaveCount(0);
    await wm.getByRole('radio', { name: '16:9' }).click();
    await expect(wm.getByText('Platform interface only covers vertical video')).toBeVisible();
    await wm.getByRole('radio', { name: 'Bottom left' }).click();
    await wm.getByLabel('Opacity value').fill('40');
    await wm.getByLabel('Opacity value').press('Enter');
    await expect(wm.getByTestId('watermark-box')).toHaveCSS('opacity', '0.4');
    await saved(p);
    expect(specOf(s).watermark).toMatchObject({ position: 'bottom-left', opacity: 0.4 });
    await wm.getByRole('switch', { name: 'Add the watermark to new clips' }).click();
    await saved(p);
    expect(specOf(s).defaults.watermarkOn).toBe(false);
    await s.close();
  });

  test('position radios are arrow-key navigable and "None" clears the logo with a placeholder box', async () => {
    const s = await open();
    const p = s.page;
    const wm = sec(p, 'watermark');
    await wm.getByRole('radio', { name: 'Top right' }).focus();
    await p.keyboard.press('ArrowRight');
    await expect(wm.getByRole('radio', { name: 'Center' })).toBeFocused();
    await expect(wm.getByRole('radio', { name: 'Center' })).toHaveAttribute('aria-checked', 'true');
    await wm.getByRole('radio', { name: 'No watermark logo' }).click();
    await expect(wm.getByTestId('watermark-box').locator('img')).toHaveCount(0);
    await saved(p);
    expect(specOf(s).watermark.assetId).toBeNull();
    await s.close();
  });

  test('without any logo the section guides to the upload', async () => {
    const s = await open({ seed: { kits: 'bare' } });
    const p = s.page;
    const wm = sec(p, 'watermark');
    await expect(wm).toContainText('No logo to choose yet.');
    await wm.getByRole('button', { name: 'Add one in Logos / Watermarks' }).click();
    await expect.poll(async () => (await sec(p, 'logos').boundingBox())!.y).toBeLessThan(260);
    await s.close();
  });
});

/* ==================================================================== intro / outro / music bed */

test.describe('Intro, outro and music bed', () => {
  test('pick an outro, play the intro preview, toggle by default', async () => {
    const s = await open();
    const p = s.page;
    const io = sec(p, 'intro-outro');
    await expect(io.getByTestId('slot-intro')).toContainText('Adds 3.2 s before the clip.');
    await expect(io.getByTestId('slot-outro')).toContainText('No outro chosen');
    await expect(io.getByTestId('slot-outro').getByRole('switch')).toBeDisabled();
    await io.getByRole('button', { name: /Outro video: none/ }).click();
    await p.getByRole('option', { name: /city-timelapse.mp4/ }).click();
    await expect(io.getByTestId('slot-outro')).toContainText('Adds 12.4 s after the clip.');
    await io.getByTestId('slot-outro').getByRole('switch').click();
    await io.getByRole('button', { name: 'Play intro preview' }).click();
    await expect(
      io
        .getByRole('application', { name: 'Intro preview' })
        .or(io.locator('video[aria-label="Intro preview"]')),
    ).toBeVisible();
    await io.getByTestId('slot-intro').getByRole('switch').click(); // off
    await saved(p);
    const sp = specOf(s);
    expect(sp.outroAssetId).toBeTruthy();
    expect(sp.defaults.outroOn).toBe(true);
    expect(sp.defaults.introOn).toBe(false);
    await s.close();
  });

  test('"None" in the picker clears the slot', async () => {
    const s = await open();
    const p = s.page;
    const io = sec(p, 'intro-outro');
    await io.getByRole('button', { name: /Intro video: intro-sting.mp4/ }).click();
    await p.getByRole('option', { name: 'None' }).click();
    await expect(io.getByTestId('slot-intro')).toContainText('No intro chosen');
    await saved(p);
    expect(specOf(s).introAssetId).toBeNull();
    await s.close();
  });

  test('music bed: track, level, ducking, fades and the level curve', async () => {
    const s = await open();
    const p = s.page;
    const m = sec(p, 'music');
    await expect(m.getByTestId('bed-curve').getByRole('img')).toHaveAttribute(
      'aria-label',
      /fade in 0\.8 seconds, ducks 12 dB under speech, fade out 1\.5 seconds/,
    );
    await m.getByLabel('Level value').fill('-24');
    await m.getByLabel('Level value').press('Enter');
    await m.getByLabel('Ducking amount value').fill('18');
    await m.getByLabel('Ducking amount value').press('Enter');
    await m.getByLabel('Fade in value').fill('2');
    await m.getByLabel('Fade in value').press('Enter');
    await expect(m.getByTestId('bed-curve').getByRole('img')).toHaveAttribute(
      'aria-label',
      /fade in 2 seconds, ducks 18 dB/,
    );
    await m.getByRole('switch', { name: 'Duck under speech' }).click();
    await expect(m.getByRole('slider', { name: 'Ducking amount' })).toBeDisabled();
    await expect(m.getByTestId('bed-curve').getByRole('img')).toHaveAttribute(
      'aria-label',
      /no ducking/,
    );
    await m.getByRole('button', { name: /Music bed track: lofi-bed.mp3/ }).click();
    await p.getByRole('option', { name: /whoosh.wav/ }).click();
    await m.getByRole('switch', { name: 'Add the music bed to new clips' }).click();
    await saved(p);
    const bed = specOf(s).musicBed;
    expect(bed).toMatchObject({ gainDb: -24, duckAmountDb: 18, fadeInSec: 2, duckEnabled: false });
    expect(bed.assetId).toBeTruthy();
    expect(specOf(s).defaults.musicOn).toBe(true);
    // the player auditions the normalised preview
    await m.getByRole('button', { name: 'Play whoosh.wav' }).click();
    await expect(m.getByRole('button', { name: 'Pause whoosh.wav' })).toBeVisible();
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('without video or audio the pickers point to the upload', async () => {
    const s = await open({ seed: { kits: 'bare' } });
    const p = s.page;
    await expect(sec(p, 'intro-outro').getByText('No videos in this kit yet.')).toHaveCount(2);
    await expect(sec(p, 'music').getByText('No audio files in this kit yet.')).toBeVisible();
    await sec(p, 'music').getByRole('button', { name: 'Add one in Audio' }).click();
    await expect.poll(async () => (await sec(p, 'audio').boundingBox())!.y).toBeLessThan(260);
    await s.close();
  });
});

/* ===================================================================================== defaults */

test.describe('Defaults', () => {
  test('aspect, caption preset, platforms and switches save', async () => {
    const s = await open();
    const p = s.page;
    const d = sec(p, 'defaults');
    await d.getByRole('radio', { name: '1:1 Square' }).click();
    await d.getByRole('combobox', { name: 'Default caption preset' }).click();
    await expect(p.getByRole('option', { name: 'Acme Punch (this kit)' })).toBeVisible();
    await p.getByRole('option', { name: 'Hormozi Bold' }).click();
    await d.getByRole('button', { name: 'Instagram Reels' }).click();
    await d.getByRole('button', { name: 'TikTok' }).click();
    await d.getByRole('switch', { name: 'Outro on by default' }).click();
    await d.getByRole('switch', { name: 'Watermark on by default' }).click();
    await saved(p);
    const sp = specOf(s).defaults;
    expect(sp).toMatchObject({
      aspect: '1:1',
      captionStyleId: 'hormozi-bold',
      outroOn: true,
      watermarkOn: false,
    });
    expect(sp.platforms).toEqual(['reels', 'shorts']);
    // the last platform cannot be switched off
    await d.getByRole('button', { name: 'Instagram Reels' }).click();
    await d.getByRole('button', { name: 'YouTube Shorts' }).click();
    await expect(d.getByRole('button', { name: 'YouTube Shorts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // the watermark preview follows the default aspect only on first load; the switches elsewhere stay in sync
    await expect(
      sec(p, 'watermark').getByRole('switch', { name: 'Add the watermark to new clips' }),
    ).not.toBeChecked();
    await s.close();
  });

  test('hashtag sets: create, name, add tags by typing and pasting, remove, delete', async () => {
    const s = await open();
    const p = s.page;
    const d = sec(p, 'defaults');
    await expect(d.getByTestId('hashtag-set')).toHaveCount(1);
    await d.getByRole('button', { name: 'Add hashtag set' }).click();
    const set = d.getByTestId('hashtag-set').nth(1);
    await set.getByLabel('Hashtag set name').fill('Shorts');
    const add = set.getByLabel('Add tags to Shorts');
    await add.fill('#growth');
    await add.press('Enter');
    await add.pressSequentially('Viral!,', { delay: 10 });
    await add.focus();
    await p.evaluate(() => navigator.clipboard.writeText('#a #b, growth, c'));
    await p.keyboard.press('Control+V');
    await expect(
      set.getByRole('list', { name: 'Tags in Shorts' }).getByRole('listitem'),
    ).toHaveCount(5); // growth, Viral, a, b, c (duplicate skipped)
    await set.getByRole('button', { name: 'Remove #a' }).click();
    await saved(p);
    const sets = specOf(s).defaults.hashtagSets;
    expect(sets[1]).toMatchObject({ name: 'Shorts', tags: ['growth', 'Viral', 'b', 'c'] });
    await set.getByRole('button', { name: 'Delete hashtag set Shorts' }).click();
    await expect(d.getByTestId('hashtag-set')).toHaveCount(1);
    await saved(p);
    expect(specOf(s).defaults.hashtagSets).toHaveLength(1);
    await s.close();
  });

  test('posting windows: add, platform, days, times; an invalid window is explained and not saved', async () => {
    const s = await open();
    const p = s.page;
    const d = sec(p, 'defaults');
    await expect(d.getByTestId('posting-window')).toHaveCount(1);
    await expect(d.getByTestId('posting-window').first()).toContainText('Mon–Fri, 09:00–12:00');
    await d.getByRole('button', { name: 'Add window' }).click();
    const w = d.getByTestId('posting-window').nth(1);
    await w.getByRole('combobox', { name: 'Window platform' }).click();
    await p.getByRole('option', { name: 'TikTok' }).click();
    await w.getByRole('button', { name: 'Saturday' }).click();
    await w.getByLabel('Window start').fill('18:00');
    await w.getByLabel('Window end').fill('21:30');
    await saved(p);
    expect(specOf(s).defaults.postingWindows[1]).toMatchObject({
      platform: 'tiktok',
      start: '18:00',
      end: '21:30',
    });
    expect(specOf(s).defaults.postingWindows[1]!.days).toContain(6);
    const before = updates(s).length;
    await w.getByLabel('Window end').fill('17:00');
    await expect(w.getByRole('alert')).toContainText('must end after it starts');
    await p.waitForTimeout(900);
    expect(updates(s).length).toBe(before); // nothing invalid was sent
    expect(specOf(s).defaults.postingWindows[1]!.end).toBe('21:30');
    await w.getByLabel('Window end').fill('22:00');
    await expect(w.getByRole('alert')).toHaveCount(0);
    await saved(p);
    expect(specOf(s).defaults.postingWindows[1]!.end).toBe('22:00');
    // every day deselected is refused
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
      await d.getByTestId('posting-window').first().getByRole('button', { name: day }).click();
    await expect(d.getByTestId('posting-window').first().getByRole('alert')).toContainText(
      'at least one day',
    );
    await w.getByRole('button', { name: 'Delete posting window' }).click();
    await expect(d.getByTestId('posting-window')).toHaveCount(1);
    expect(problems(s)).toEqual([]);
    await s.close();
  });
});

/* ======================================================================================== saving */

test.describe('Saving', () => {
  test('slider drags are debounced into few updates and the chip walks dirty -> saving -> saved', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).state.updateDelayMs = 500;
    const before = updates(s).length;
    const slider = sec(p, 'hook').getByRole('slider', { name: 'Vertical position' });
    for (const v of [20, 25, 30, 35, 40, 45]) {
      await slider.fill(String(v));
      await p.waitForTimeout(40);
    }
    await expect(p.getByTestId('save-chip')).toHaveAttribute('data-status', 'dirty');
    await expect(p.getByTestId('save-chip')).toHaveText('Unsaved changes');
    await expect(p.getByTestId('save-chip')).toHaveAttribute('data-status', 'saving', {
      timeout: 3000,
    });
    await expect(p.getByTestId('save-chip')).toHaveText('Saving…');
    await expect(p.getByTestId('save-chip')).toHaveAttribute('data-status', 'saved', {
      timeout: 5000,
    });
    await expect(p.getByTestId('save-chip')).toHaveText('Saved');
    expect(updates(s).length - before).toBe(1);
    expect(specOf(s).hook.yPct).toBe(45);
    // top-level keys are replaced whole: only `hook` was sent
    expect(Object.keys((lastUpdate(s).patch as { spec: object }).spec)).toEqual(['hook']);
    await s.close();
  });

  test('a failed save keeps the edit, explains and recovers with "Try again"', async () => {
    const s = await open();
    const p = s.page;
    brandControls(s.state).failNext('brand:update', 'The database is locked.');
    await sec(p, 'hook').getByRole('radio', { name: 'lowercase' }).click();
    const banner = p.getByTestId('save-error-banner');
    await expect(banner).toContainText('Your latest changes are not saved yet', { timeout: 5000 });
    await expect(banner).toContainText('The database is locked.');
    await expect(p.getByTestId('save-chip')).toHaveText('Couldn’t save');
    await expect(sec(p, 'hook').getByTestId('hook-card')).toHaveText(
      'nobody tells you this about editing',
    );
    await banner.getByRole('button', { name: 'Try again' }).click();
    await saved(p);
    await expect(banner).toHaveCount(0);
    expect(specOf(s).hook.textCase).toBe('lower');
    await s.close();
  });

  test('CONFLICT: "changed elsewhere" banner; Reload drops my edits and shows the other version', async () => {
    const s = await open();
    const p = s.page;
    const c = brandControls(s.state);
    c.saveElsewhere(kitId(s), { hook: { ...specOf(s).hook, yPct: 70 } }, 'Renamed elsewhere');
    await sec(p, 'hook').getByRole('radio', { name: 'UPPERCASE' }).click();
    const banner = p.getByTestId('conflict-banner');
    await expect(banner).toContainText('This kit changed somewhere else', { timeout: 6000 });
    await expect(p.getByTestId('save-chip')).toHaveText('Not saved');
    // my edit is still on screen
    await expect(sec(p, 'hook').getByTestId('hook-card')).toHaveText(
      'NOBODY TELLS YOU THIS ABOUT EDITING',
    );
    // further edits do not hit the server while the conflict stands
    const n = updates(s).length;
    await sec(p, 'hook').getByRole('radio', { name: 'lowercase' }).click();
    await p.waitForTimeout(900);
    expect(updates(s).length).toBe(n);
    await banner.getByTestId('conflict-reload').click();
    await expect(banner).toHaveCount(0);
    await expect(p.getByLabel('Kit name')).toHaveValue('Renamed elsewhere');
    await expect(sec(p, 'hook').getByTestId('hook-card')).toHaveText(
      'Nobody tells you this about editing',
    );
    expect(specOf(s).hook.textCase).toBe('none');
    // and saving works again
    await sec(p, 'hook').getByRole('radio', { name: 'UPPERCASE' }).click();
    await saved(p);
    expect(specOf(s).hook.textCase).toBe('upper');
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('CONFLICT: "Keep my changes" re-bases and overwrites only what I touched', async () => {
    const s = await open();
    const p = s.page;
    const c = brandControls(s.state);
    c.saveElsewhere(kitId(s), { hook: { ...specOf(s).hook, yPct: 70 } }, 'Renamed elsewhere');
    await sec(p, 'hook').getByRole('radio', { name: 'UPPERCASE' }).click();
    await p.getByTestId('conflict-banner').getByTestId('conflict-keep').click();
    await expect(p.getByTestId('conflict-banner')).toHaveCount(0);
    await saved(p);
    const k = brandControls(s.state).kit();
    expect(k.spec.hook.textCase).toBe('upper');
    expect(k.name).toBe('Renamed elsewhere');
    expect(lastUpdate(s).baseRev).toBe(k.rev - 1);
    await s.close();
  });

  test('another window saving while nothing is pending refreshes the page quietly', async () => {
    const s = await open();
    const p = s.page;
    const c = brandControls(s.state);
    await c.saveElsewhereAndNotify(
      kitId(s),
      { hook: { ...specOf(s).hook, textCase: 'upper' } },
      'Acme (edited elsewhere)',
    );
    await expect(p.getByLabel('Kit name')).toHaveValue('Acme (edited elsewhere)');
    await expect(sec(p, 'hook').getByTestId('hook-card')).toHaveText(
      'NOBODY TELLS YOU THIS ABOUT EDITING',
    );
    await expect(p.getByTestId('conflict-banner')).toHaveCount(0);
    // an edit now uses the fresh revision, so it does not conflict
    await sec(p, 'hook').getByRole('radio', { name: 'lowercase' }).click();
    await saved(p);
    expect(specOf(s).hook.textCase).toBe('lower');
    await s.close();
  });

  test('switching kits sends pending edits first', async () => {
    const s = await open();
    const p = s.page;
    const id = kitId(s);
    await sec(p, 'hook').getByRole('radio', { name: 'UPPERCASE' }).click();
    await p
      .getByRole('button', { name: /^Side Hustle Shorts/ })
      .first()
      .click();
    await expect(p.getByLabel('Kit name')).toHaveValue('Side Hustle Shorts');
    await expect.poll(() => specOf(s, id).hook.textCase).toBe('upper');
    await s.close();
  });
});

/* ===================================================================================== a11y bits */

test.describe('Accessibility', () => {
  test('controls have roles and names: switches, sliders, radio groups, labelled regions', async () => {
    const s = await open();
    const p = s.page;
    for (const t of SECTION_TITLES)
      await expect(p.getByRole('region', { name: t, exact: true })).toBeAttached();
    await expect(p.getByRole('radiogroup', { name: 'Watermark position' })).toBeAttached();
    await expect(p.getByRole('radiogroup', { name: 'Default aspect ratio' })).toBeAttached();
    await expect(p.getByRole('slider', { name: 'Size' })).toBeAttached();
    await expect(p.getByRole('switch', { name: 'Duck under speech' })).toBeAttached();
    await expect(p.getByRole('switch', { name: 'Intro on by default' })).toBeAttached();
    await expect(p.getByRole('group', { name: 'Target platforms' })).toBeAttached();
    // every button and input on the page has an accessible name
    const unnamed = await p.evaluate(() => {
      const out: string[] = [];
      const main = document.getElementById('main')!;
      for (const el of main.querySelectorAll(
        'button, input, select, [role=button], [role=switch], [role=radio], [role=checkbox], [role=combobox]',
      )) {
        const e = el as HTMLElement;
        const name =
          e.getAttribute('aria-label') ||
          e.getAttribute('aria-labelledby') ||
          (e as HTMLInputElement).labels?.[0]?.textContent ||
          e.textContent?.trim() ||
          e.getAttribute('title');
        if (!name) out.push(e.outerHTML.slice(0, 120));
      }
      return out;
    });
    expect(unnamed).toEqual([]);
    expect(problems(s)).toEqual([]);
    await s.close();
  });

  test('focus rings are visible on keyboard focus and tab order reaches the first section', async () => {
    const s = await open();
    const p = s.page;
    await p
      .getByRole('button', { name: /^Acme Podcast/ })
      .first()
      .focus();
    await p.keyboard.press('Tab');
    const outline = await p.evaluate(
      () =>
        getComputedStyle(document.activeElement as Element).outlineStyle +
        '|' +
        getComputedStyle(document.activeElement as Element).boxShadow,
    );
    expect(outline).not.toBe('none|none');
    await s.close();
  });
});
