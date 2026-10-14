import {
  DEFAULT_SETTINGS,
  settingsPatchSchema,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/settings';
import type { Db } from '../db/client';
import { logger } from '../logger';

const log = logger.scoped('settings');

/** SQLite failures that are usually momentary (lock contention, a flaky file system call) and worth one more try. */
export function isTransientDbError(e: unknown): boolean {
  const m =
    e instanceof Error ? `${e.message} ${String((e as { code?: unknown }).code ?? '')}` : String(e);
  return /SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR|database is locked|disk I\/O error/i.test(m);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Non-secret settings stored as JSON values in the Setting table (ADR-010). */
export class SettingsService {
  private cache: Settings | null = null;
  private listeners = new Set<(s: Settings) => void>();

  constructor(private readonly db: Db) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const rows = await this.db.setting.findMany();
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value);
      } catch {
        // corrupt row: ignore, default applies
      }
    }
    // Per-field fallback so one bad stored value cannot reset everything.
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const [k, v] of Object.entries(raw)) {
      const probe = settingsSchema.safeParse({ ...merged, [k]: v });
      if (probe.success) merged[k] = v;
    }
    this.cache = settingsSchema.parse(merged);
    return this.cache;
  }

  async set(patch: SettingsPatch): Promise<Settings> {
    const clean = settingsPatchSchema.parse(patch);
    const current = await this.get();
    const next = settingsSchema.parse({ ...current, ...clean });
    // The renderer sends the FULL settings object, so only write the keys whose stored JSON really changed:
    // one changed field is one upsert instead of a ~40-statement transaction.
    const changed = Object.entries(clean).filter(
      ([key, value]) =>
        value !== undefined &&
        JSON.stringify(value) !== JSON.stringify((current as Record<string, unknown>)[key]),
    );
    if (changed.length) await this.write(changed);
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  private async write(entries: [string, unknown][]): Promise<void> {
    const upserts = () =>
      entries.map(([key, value]) =>
        this.db.setting.upsert({
          where: { key },
          create: { key, value: JSON.stringify(value) },
          update: { value: JSON.stringify(value) },
        }),
      );
    for (let attempt = 0; ; attempt++) {
      try {
        if (entries.length === 1) await upserts()[0];
        else await this.db.$transaction(upserts());
        return;
      } catch (e) {
        const keys = entries.map(([k]) => k).join(',');
        log.warn(`settings write failed (attempt ${attempt + 1}, keys: ${keys}): ${String(e)}`);
        if (attempt >= 2 || !isTransientDbError(e)) throw e;
        await sleep(150 * (attempt + 1));
      }
    }
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
