import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBrandSpec, type BrandKit, type BrandKitPatch } from '../../shared/brand';
import { KitSaver, applyPatch, mergePatch } from '../../renderer/lib/brand/kit-saver';

const kit = (over: Partial<BrandKit> = {}): BrandKit => ({
  id: 'k1',
  name: 'Acme',
  isDefault: false,
  spec: defaultBrandSpec(),
  rev: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

class Conflict extends Error {
  code = 'CONFLICT';
}

/** An in-memory "main": checks baseRev, applies the patch, bumps rev. */
function server(initial: BrandKit) {
  let stored = initial;
  const calls: { patch: BrandKitPatch; baseRev: number }[] = [];
  const update = vi.fn(async (input: { id: string; patch: BrandKitPatch; baseRev: number }) => {
    calls.push({ patch: input.patch, baseRev: input.baseRev });
    if (input.baseRev !== stored.rev) throw new Conflict('changed elsewhere');
    stored = { ...applyPatch(stored, input.patch), rev: stored.rev + 1 };
    return stored;
  });
  return {
    update,
    calls,
    get stored() {
      return stored;
    },
    elsewhere(patch: BrandKitPatch) {
      stored = { ...applyPatch(stored, patch), rev: stored.rev + 1 };
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('patch helpers', () => {
  it('mergePatch replaces whole spec keys and keeps the newest name', () => {
    const a: BrandKitPatch = { name: 'A', spec: { colors: [], hook: defaultBrandSpec().hook } };
    const b: BrandKitPatch = {
      name: 'B',
      spec: { colors: [{ id: 'c', name: 'x', hex: '#FFFFFF', group: 'g' }] },
    };
    const m = mergePatch(a, b);
    expect(m.name).toBe('B');
    expect(m.spec?.colors).toHaveLength(1);
    expect(m.spec?.hook).toBeDefined();
  });

  it('applyPatch returns the same object for an empty patch', () => {
    const k = kit();
    expect(applyPatch(k, {})).toBe(k);
  });
});

describe('KitSaver', () => {
  it('shows an edit at once and sends it once after the debounce', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 400 });
    saver.edit({ name: 'A' });
    saver.edit({ name: 'Ac' });
    saver.edit({ name: 'Acm' });
    expect(saver.getSnapshot().kit.name).toBe('Acm');
    expect(saver.getSnapshot().status).toBe('dirty');
    expect(srv.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(399);
    expect(srv.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(srv.update).toHaveBeenCalledTimes(1);
    expect(srv.calls[0]).toEqual({ patch: { name: 'Acm' }, baseRev: 1 });
    expect(saver.getSnapshot().status).toBe('saved');
    expect(saver.getSnapshot().kit.rev).toBe(2);
    expect(saver.getSnapshot().savedAt).not.toBeNull();
  });

  it('immediate edits skip the debounce', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update });
    saver.edit({ spec: { introAssetId: 'a1' } }, { immediate: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(srv.update).toHaveBeenCalledTimes(1);
    expect(saver.getSnapshot().kit.spec.introAssetId).toBe('a1');
  });

  it('edits made while a save is in flight are sent next, with the new revision', async () => {
    const srv = server(kit());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vi.fn(async (i: Parameters<typeof srv.update>[0]) => {
      if (slow.mock.calls.length === 1) await gate;
      return srv.update(i);
    });
    const saver = new KitSaver(kit(), { update: slow, debounceMs: 10 });
    saver.edit({ name: 'one' });
    await vi.advanceTimersByTimeAsync(11);
    expect(saver.getSnapshot().status).toBe('saving');
    saver.edit({ spec: { introAssetId: 'x' } }, { immediate: true });
    expect(saver.getSnapshot().kit.name).toBe('one');
    expect(saver.getSnapshot().kit.spec.introAssetId).toBe('x');
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(srv.calls.map((c) => c.baseRev)).toEqual([1, 2]);
    expect(srv.stored.name).toBe('one');
    expect(srv.stored.spec.introAssetId).toBe('x');
    expect(saver.getSnapshot().status).toBe('saved');
  });

  it('a CONFLICT keeps the local edits and stops saving', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 10 });
    srv.elsewhere({ name: 'Theirs' });
    saver.edit({ name: 'Mine' });
    await vi.advanceTimersByTimeAsync(20);
    expect(saver.getSnapshot().status).toBe('conflict');
    expect(saver.getSnapshot().kit.name).toBe('Mine');
    // further edits stay local, nothing is sent
    saver.edit({ name: 'Mine 2' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.update).toHaveBeenCalledTimes(1);
    expect(saver.getSnapshot().kit.name).toBe('Mine 2');
  });

  it('conflict -> keepMine re-bases onto the latest revision and sends every local edit', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 10 });
    srv.elsewhere({ name: 'Theirs' });
    saver.edit({ spec: { introAssetId: 'mine' } });
    await vi.advanceTimersByTimeAsync(20);
    expect(saver.getSnapshot().status).toBe('conflict');
    await saver.keepMine(srv.stored);
    expect(saver.getSnapshot().status).toBe('saved');
    expect(srv.stored.spec.introAssetId).toBe('mine');
    expect(srv.stored.name).toBe('Theirs'); // keys I did not touch keep the other window's value
    expect(srv.calls.at(-1)?.baseRev).toBe(2);
  });

  it('conflict -> reload drops local edits', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 10 });
    srv.elsewhere({ name: 'Theirs' });
    saver.edit({ name: 'Mine' });
    await vi.advanceTimersByTimeAsync(20);
    saver.reload(srv.stored);
    expect(saver.getSnapshot().status).toBe('idle');
    expect(saver.getSnapshot().kit.name).toBe('Theirs');
    expect(saver.hasPending()).toBe(false);
  });

  it('other failures keep the edits and can be retried', async () => {
    let fail = true;
    const srv = server(kit());
    const flaky = vi.fn(async (i: Parameters<typeof srv.update>[0]) => {
      if (fail) throw new Error('disk full');
      return srv.update(i);
    });
    const saver = new KitSaver(kit(), { update: flaky, debounceMs: 10 });
    saver.edit({ name: 'X' });
    await vi.advanceTimersByTimeAsync(20);
    expect(saver.getSnapshot().status).toBe('error');
    expect(saver.getSnapshot().error).toBe('disk full');
    expect(saver.getSnapshot().kit.name).toBe('X');
    fail = false;
    await saver.retry();
    expect(saver.getSnapshot().status).toBe('saved');
    expect(srv.stored.name).toBe('X');
  });

  it('adopt takes a newer server copy only when nothing is pending', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 10 });
    const newer = kit({ rev: 5, name: 'Elsewhere' });
    expect(saver.adopt(newer)).toBe(true);
    expect(saver.getSnapshot().kit.name).toBe('Elsewhere');
    saver.edit({ name: 'Local' });
    expect(saver.adopt(kit({ rev: 9, name: 'Even newer' }))).toBe(false);
    expect(saver.getSnapshot().kit.name).toBe('Local');
    // an older or equal copy never replaces anything
    await vi.advanceTimersByTimeAsync(20);
    expect(saver.adopt(kit({ rev: 1 }))).toBe(false);
  });

  it('adopt notices a changed default flag without a revision change', () => {
    const saver = new KitSaver(kit(), { update: vi.fn() });
    expect(saver.adopt(kit({ isDefault: true }))).toBe(true);
    expect(saver.getSnapshot().kit.isDefault).toBe(true);
  });

  it('dispose flushes pending edits', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 5000 });
    saver.edit({ name: 'Leaving' });
    saver.dispose();
    await vi.advanceTimersByTimeAsync(1);
    expect(srv.stored.name).toBe('Leaving');
  });

  it('notifies subscribers and keeps the snapshot identity stable when nothing changed', async () => {
    const srv = server(kit());
    const saver = new KitSaver(kit(), { update: srv.update, debounceMs: 10 });
    const cb = vi.fn();
    const off = saver.subscribe(cb);
    const first = saver.getSnapshot();
    expect(saver.getSnapshot()).toBe(first);
    saver.edit({ name: 'N' });
    expect(cb).toHaveBeenCalled();
    expect(saver.getSnapshot()).not.toBe(first);
    off();
    cb.mockClear();
    await vi.advanceTimersByTimeAsync(20);
    expect(cb).not.toHaveBeenCalled();
  });
});
