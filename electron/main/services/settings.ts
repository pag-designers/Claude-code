import {
  DEFAULT_SETTINGS,
  settingsPatchSchema,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/settings';
import type { Db } from '../db/client';

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
    await this.db.$transaction(
      Object.entries(clean)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) =>
          this.db.setting.upsert({
            where: { key },
            create: { key, value: JSON.stringify(value) },
            update: { value: JSON.stringify(value) },
          }),
        ),
    );
    this.cache = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
