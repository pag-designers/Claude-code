import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { SettingsService, isTransientDbError } from '../../electron/main/services/settings';

/** A Db double that records upserts and can fail a number of times first. */
function fakeDb(failures: { times: number; message: string } = { times: 0, message: '' }) {
  const upserts: string[] = [];
  const state = { ...failures };
  const db = {
    setting: {
      findMany: async () => [],
      upsert: (a: { where: { key: string } }) => {
        if (state.times > 0) {
          state.times -= 1;
          return Promise.reject(new Error(state.message));
        }
        upserts.push(a.where.key);
        return Promise.resolve(a);
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { db: db as never, upserts };
}

describe('SettingsService.set writes', () => {
  it('writes only the keys that changed even when the renderer sends the full object', async () => {
    const { db, upserts } = fakeDb();
    const svc = new SettingsService(db);
    await svc.set({ ...DEFAULT_SETTINGS, r2AccountId: 'abc123' });
    expect(upserts).toEqual(['r2AccountId']);
    upserts.length = 0;
    await svc.set({ ...DEFAULT_SETTINGS, r2AccountId: 'abc123' }); // unchanged → nothing to write
    expect(upserts).toEqual([]);
    expect((await svc.get()).r2AccountId).toBe('abc123');
  });

  it('retries a transient SQLite failure and then succeeds', async () => {
    const { db, upserts } = fakeDb({ times: 2, message: 'disk I/O error' });
    const svc = new SettingsService(db);
    await svc.set({ ...DEFAULT_SETTINGS, r2Bucket: 'b' });
    expect(upserts).toEqual(['r2Bucket']);
  });

  it('gives up after repeated failures and does not change the cached settings', async () => {
    const { db } = fakeDb({ times: 10, message: 'SQLITE_IOERR: disk I/O error' });
    const svc = new SettingsService(db);
    await expect(svc.set({ ...DEFAULT_SETTINGS, r2Bucket: 'b' })).rejects.toThrow(/disk I\/O/);
    expect((await svc.get()).r2Bucket).toBe(DEFAULT_SETTINGS.r2Bucket);
  });

  it('does not retry errors that are not transient', async () => {
    const spy = vi.fn();
    const { db } = fakeDb({ times: 1, message: 'constraint failed' });
    const svc = new SettingsService(db);
    svc.onChange(spy);
    await expect(svc.set({ ...DEFAULT_SETTINGS, r2Bucket: 'b' })).rejects.toThrow(/constraint/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('classifies transient errors', () => {
    expect(isTransientDbError(new Error('disk I/O error'))).toBe(true);
    expect(isTransientDbError(new Error('database is locked'))).toBe(true);
    expect(isTransientDbError(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});
