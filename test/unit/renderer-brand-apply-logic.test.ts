import { describe, expect, it } from 'vitest';
import { invokeContract } from '../../shared/ipc';
import { resolveBrandKitId } from '../../shared/brand';
import type { ClipView } from '../../shared/pipeline';
import {
  DEFAULT_KIT,
  INHERIT,
  NO_KIT,
  appliedHeadline,
  applyIdOfChoice,
  brandKitHref,
  brandState,
  choiceOfClip,
  clipsWord,
  effectiveKit,
  needsRender,
  normalizeChoice,
  planBulkApply,
  sourceNote,
} from '../../renderer/components/brand-apply/logic';
import { buildStartOptions, formFromSettings } from '../../renderer/lib/start-options';
import { DEFAULT_SETTINGS } from '../../shared/settings';

const kits = [{ id: 'k1' }, { id: 'k2' }];
const clip = (id: string, p: Partial<ClipView> = {}): ClipView =>
  ({
    id,
    videoId: 'v1',
    status: 'rendered',
    brandKitId: null,
    brandApplied: null,
    ...p,
  }) as ClipView;

describe('effectiveKit', () => {
  const eff = (
    clipValue: string | null,
    runValue: string | undefined,
    defaultKitId: string | null,
    list = kits,
  ) => effectiveKit({ clipValue, runValue, defaultKitId, kits: list });

  it('agrees with resolveBrandKitId whenever the kit exists', () => {
    const values = [null, 'none', 'default', 'k1', 'k2'] as const;
    for (const c of values)
      for (const r of [undefined, 'none', 'default', 'k1', 'k2'] as const)
        for (const d of [null, 'k1', 'k2'] as const) {
          const expected = resolveBrandKitId(c, r, d);
          expect(eff(c, r, d).kitId).toBe(expected);
        }
  });

  it('reports where the decision came from', () => {
    expect(eff('k2', 'k1', 'k1').source).toBe('clip');
    expect(eff('none', 'k1', 'k1')).toMatchObject({ source: 'clip', kitId: null });
    expect(eff(null, 'k2', 'k1')).toMatchObject({ source: 'run', kitId: 'k2' });
    expect(eff(null, 'none', 'k1')).toMatchObject({ source: 'run', kitId: null });
    expect(eff(null, 'default', 'k1')).toMatchObject({ source: 'default', kitId: 'k1' });
    expect(eff(null, undefined, null)).toMatchObject({ source: 'default', kitId: null });
  });

  it('treats a kit that no longer exists as no kit and says which one', () => {
    expect(eff('gone', 'default', 'k1')).toEqual({
      kitId: null,
      source: 'clip',
      missingId: 'gone',
    });
    expect(eff(null, 'gone', 'k1')).toEqual({ kitId: null, source: 'run', missingId: 'gone' });
    // the default kit id is stale (kit list refreshed first)
    expect(eff(null, 'default', 'zzz')).toMatchObject({ kitId: null, missingId: 'zzz' });
  });
});

describe('choices', () => {
  it('maps the clip override to the select value and back to the brand:apply kitId', () => {
    expect(choiceOfClip(null)).toBe(INHERIT);
    expect(choiceOfClip(undefined)).toBe(INHERIT);
    expect(choiceOfClip('none')).toBe(NO_KIT);
    expect(choiceOfClip('k1')).toBe('k1');
    expect(applyIdOfChoice(INHERIT)).toBeNull();
    expect(applyIdOfChoice(NO_KIT)).toBe('none');
    expect(applyIdOfChoice('k1')).toBe('k1');
  });

  it('normalizeChoice falls back for kits that are gone', () => {
    const specials = [DEFAULT_KIT, NO_KIT];
    expect(normalizeChoice('k1', kits, DEFAULT_KIT, specials)).toBe('k1');
    expect(normalizeChoice('none', kits, DEFAULT_KIT, specials)).toBe('none');
    expect(normalizeChoice('gone', kits, DEFAULT_KIT, specials)).toBe('default');
    expect(normalizeChoice(null, kits, DEFAULT_KIT, specials)).toBe('default');
    expect(normalizeChoice('inherit', kits, NO_KIT, [NO_KIT])).toBe('none');
  });
});

describe('brandState (stale indicator)', () => {
  const st = (
    applied: ClipView['brandApplied'],
    effectiveKitId: string | null,
    effectiveRev?: number,
    status: ClipView['status'] = 'rendered',
  ) => brandState({ status, applied, effectiveKitId, effectiveRev });

  it('covers every combination', () => {
    expect(st(null, null, undefined, 'candidate')).toBe('unrendered');
    expect(st({ kitId: 'k1', rev: 1 }, 'k1', 5, 'candidate')).toBe('unrendered');
    expect(st(null, null)).toBe('plain');
    expect(st(null, 'k1', 2)).toBe('pending');
    expect(st({ kitId: 'k1', rev: 2 }, null)).toBe('remove');
    expect(st({ kitId: 'k1', rev: 2 }, 'k2', 1)).toBe('different');
    expect(st({ kitId: 'k1', rev: 2 }, 'k1', 3)).toBe('stale');
    expect(st({ kitId: 'k1', rev: 3 }, 'k1', 3)).toBe('current');
    // an applied revision ahead of the kit (kit restored from a backup) is not "stale"
    expect(st({ kitId: 'k1', rev: 4 }, 'k1', 3)).toBe('current');
  });

  it('never calls a clip stale while the kit revision is unknown', () => {
    expect(st({ kitId: 'k1', rev: 1 }, 'k1', undefined)).toBe('current');
  });

  it('needsRender is true exactly for the states a re-render changes', () => {
    const all = [
      'unrendered',
      'plain',
      'pending',
      'remove',
      'different',
      'stale',
      'current',
    ] as const;
    expect(all.filter(needsRender)).toEqual(['pending', 'remove', 'different', 'stale']);
  });
});

describe('planBulkApply', () => {
  const base = {
    runValueOf: () => 'default' as string | undefined,
    defaultKitId: 'k1' as string | null,
    kits,
  };

  it('splits clips into render / up to date / busy / not rendered', () => {
    const clips = [
      clip('new'), // rendered without a kit, default kit k1 → needs it
      clip('done', { brandKitId: 'k2', brandApplied: { kitId: 'k2', rev: 4 } }),
      clip('old', { brandKitId: 'k2', brandApplied: { kitId: 'k2', rev: 1 } }),
      clip('busy', { status: 'rendering' }),
      clip('queued', { status: 'queued' }),
      clip('cand', { status: 'candidate' }),
      clip('failed', { status: 'failed' }),
    ];
    const plan = planBulkApply({ ...base, clips, choice: 'k2', chosenRev: 4 });
    expect(plan.render.map((c) => c.id)).toEqual(['new', 'old', 'failed']);
    expect(plan.upToDate.map((c) => c.id)).toEqual(['done']);
    expect(plan.busy.map((c) => c.id)).toEqual(['busy', 'queued']);
    expect(plan.unrendered.map((c) => c.id)).toEqual(['cand']);
  });

  it('does not promise to skip anything when the request goes out by videoId', () => {
    const clips = [clip('done', { brandKitId: 'k2', brandApplied: { kitId: 'k2', rev: 4 } })];
    const plan = planBulkApply({
      ...base,
      clips,
      choice: 'k2',
      chosenRev: 4,
      excludeUpToDate: false,
    });
    expect(plan.render).toHaveLength(1);
    expect(plan.upToDate).toHaveLength(0);
  });

  it('re-renders when the chosen kit revision is not known yet', () => {
    const clips = [clip('done', { brandKitId: 'k2', brandApplied: { kitId: 'k2', rev: 4 } })];
    expect(planBulkApply({ ...base, clips, choice: 'k2', chosenRev: null }).render).toHaveLength(1);
  });

  it('"No brand kit": plain clips are already fine, branded ones lose the kit', () => {
    const clips = [
      clip('plainNone', { brandKitId: 'none' }),
      clip('plainInherit'), // inherits k1 → currently has none applied: a change
      clip('branded', { brandKitId: 'k1', brandApplied: { kitId: 'k1', rev: 1 } }),
    ];
    const plan = planBulkApply({ ...base, clips, choice: NO_KIT });
    expect(plan.upToDate.map((c) => c.id)).toEqual(['plainNone']);
    expect(plan.render.map((c) => c.id)).toEqual(['plainInherit', 'branded']);
  });

  it('"Inherit" uses each video\'s own setting', () => {
    const plan = planBulkApply({
      ...base,
      clips: [
        clip('a', { videoId: 'va', brandKitId: 'k2', brandApplied: { kitId: 'k2', rev: 1 } }),
        clip('b', { videoId: 'vb', brandKitId: 'k2', brandApplied: { kitId: 'k1', rev: 1 } }),
      ],
      runValueOf: (v) => (v === 'va' ? 'none' : 'k1'),
      choice: INHERIT,
    });
    // after inheriting, a → none (rendered with k2: change); b → k1 (already k1 but override changes + rev unknown)
    expect(plan.render.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('wording and links', () => {
  it('pluralises', () => {
    expect(clipsWord(1)).toBe('1 clip');
    expect(clipsWord(6)).toBe('6 clips');
  });
  it('headlines the result toast', () => {
    expect(appliedHeadline({ queued: 6, choice: 'k1', kitName: 'Acme' })).toBe(
      'Re-rendering 6 clips with Acme',
    );
    expect(appliedHeadline({ queued: 1, choice: NO_KIT, kitName: null })).toBe(
      'Removing the Brand Kit from 1 clip',
    );
    expect(appliedHeadline({ queued: 2, choice: INHERIT, kitName: null })).toBe(
      'Re-rendering 2 clips with their video’s Brand Kit',
    );
  });
  it('explains the source of the effective kit', () => {
    expect(sourceNote({ kitId: 'k1', source: 'default', missingId: null })).toBe(
      'Inherited: your default kit.',
    );
    expect(sourceNote({ kitId: null, source: 'clip', missingId: 'gone' })).toMatch(/deleted/);
    expect(sourceNote({ kitId: 'k1', source: 'run', missingId: null })).toMatch(/clipping run/);
  });
  it('links to the Brand Kit page', () => {
    expect(brandKitHref()).toBe('/brand-kit/');
    expect(brandKitHref('k 1')).toBe('/brand-kit/?id=k+1');
  });
});

describe('start form', () => {
  it('defaults to the default kit and puts the choice into the pipeline:start options', () => {
    const form = formFromSettings(DEFAULT_SETTINGS);
    expect(form.brandKitId).toBe('default');
    for (const id of ['default', 'none', 'kit-123']) {
      const options = buildStartOptions({ ...form, brandKitId: id }, 1080);
      expect(options.brandKitId).toBe(id);
      const parsed = invokeContract['pipeline:start'].input.parse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        options,
      });
      expect(parsed.options?.brandKitId).toBe(id);
    }
  });
});

describe('brand:apply payloads', () => {
  it('accepts a kit id, "none" and null (inherit) for clips and for a video', () => {
    const input = invokeContract['brand:apply'].input;
    expect(input.parse({ kitId: 'k1', clipIds: ['c1'] })).toEqual({ kitId: 'k1', clipIds: ['c1'] });
    expect(input.parse({ kitId: 'none', videoId: 'v1' })).toEqual({ kitId: 'none', videoId: 'v1' });
    expect(input.parse({ kitId: null, clipIds: ['c1', 'c2'] }).kitId).toBeNull();
  });
});
