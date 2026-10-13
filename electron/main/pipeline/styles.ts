import {
  DEFAULT_STYLE_ID,
  captionStyleSchema,
  type CaptionStyle,
  type CaptionStyleInput,
} from '@shared/cp2';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { CaptionService } from './contracts';
import { parseJson } from './views';

/**
 * Caption style registry: the 14 built-in presets (from the caption service) plus the user's custom
 * presets (table CaptionStylePreset). Built-ins are read-only; saving a built-in id creates a copy.
 */
export class StyleRegistry {
  private builtin: CaptionStyle[];

  constructor(
    private readonly db: Db,
    captions: Pick<CaptionService, 'builtinStyles'>,
  ) {
    this.builtin = captions.builtinStyles().map((s) => ({ ...s, builtin: true }));
  }

  async list(): Promise<CaptionStyle[]> {
    const rows = await this.db.captionStylePreset.findMany({ orderBy: { createdAt: 'asc' } });
    const custom: CaptionStyle[] = [];
    for (const r of rows) {
      const parsed = captionStyleSchema.safeParse({
        ...parseJson<Record<string, unknown>>(r.spec, {}),
        id: r.id,
        name: r.name,
        builtin: false,
      });
      if (parsed.success) custom.push(parsed.data);
    }
    return [...this.builtin, ...custom];
  }

  /** The style to burn in; unknown ids fall back to the default preset (a deleted custom preset must not break re-renders). */
  async get(id: string | null | undefined): Promise<CaptionStyle> {
    const all = await this.list();
    return (
      all.find((s) => s.id === id) ??
      all.find((s) => s.id === DEFAULT_STYLE_ID) ??
      (all[0] as CaptionStyle)
    );
  }

  async save(input: CaptionStyleInput): Promise<CaptionStyle> {
    const style = captionStyleSchema.parse(input);
    const isBuiltin = this.builtin.some((b) => b.id === style.id);
    const existing = isBuiltin
      ? null
      : await this.db.captionStylePreset.findUnique({ where: { id: style.id } });
    const { id: _id, name, builtin: _b, ...spec } = style;
    void _id;
    void _b;
    if (existing) {
      await this.db.captionStylePreset.update({
        where: { id: style.id },
        data: { name, spec: JSON.stringify(spec) },
      });
      return { ...style, builtin: false };
    }
    const created = await this.db.captionStylePreset.create({
      data: { name, spec: JSON.stringify(spec) },
    });
    return { ...style, id: created.id, builtin: false };
  }

  async delete(id: string): Promise<void> {
    if (this.builtin.some((b) => b.id === id))
      throw new AppError('VALIDATION', 'Built-in presets cannot be deleted. Duplicate one to customise it.');
    await this.db.captionStylePreset.deleteMany({ where: { id } });
    // Clips and videos that used it fall back to the default on their next render.
    await this.db.clip.updateMany({
      where: { captionStyleId: id },
      data: { captionStyleId: DEFAULT_STYLE_ID },
    });
  }
}
