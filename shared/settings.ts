import { z } from 'zod';

export const themeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

/** Non-secret settings (ADR-010). All fields have defaults so a fresh install is valid. */
export const settingsSchema = z.object({
  theme: themeSchema.default('system'),
  sidebarCollapsed: z.boolean().default(false),

  // Models
  modelSmart: z.string().min(1).default('claude-sonnet-4-5'),
  modelFast: z.string().min(1).default('claude-haiku-4-5'),

  // Budget guardrail (USD / month)
  budgetTargetUsd: z.number().positive().default(30),
  budgetHardCapUsd: z.number().positive().default(70),

  // Compute
  computeDevice: z.enum(['auto', 'gpu', 'cpu']).default('auto'),
  whisperModel: z
    .enum(['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'])
    .default('large-v3-turbo'),
  concurrency: z.number().int().min(1).max(8).default(2),

  // Storage (non-secret half; keys are in the secret store)
  storageProvider: z.enum(['r2', 'b2']).default('r2'),
  r2AccountId: z.string().default(''),
  r2Bucket: z.string().default(''),
  r2PublicDomain: z.string().default(''),
  b2Endpoint: z.string().default(''),
  b2Region: z.string().default(''),
  b2Bucket: z.string().default(''),
  cacheCapGb: z.number().min(1).max(500).default(20),
  keepSourceAs: z.enum(['proxy480', 'full', 'none']).default('proxy480'),
  storageFreeTierGb: z.number().positive().default(10),

  // Ingest defaults
  maxResolution: z
    .union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)])
    .default(1080),
  cookiesFromBrowser: z
    .enum(['none', 'chrome', 'firefox', 'edge', 'safari', 'brave'])
    .default('none'),

  // Clipping defaults (used from CP1)
  defaultClipPreset: z.enum(['15-30', '30-60', '60-90', 'custom']).default('30-60'),
  defaultClipCount: z.number().int().min(1).max(50).default(10),
  defaultAspect: z.enum(['9:16', '1:1', '4:5', '16:9']).default('9:16'),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/**
 * Patch = every field optional WITHOUT its default. (`settingsSchema.partial()` would re-apply the
 * zod defaults to omitted keys, so a one-key patch would silently reset all other settings.)
 */
const patchShape = Object.fromEntries(
  Object.entries(settingsSchema.shape).map(([key, field]) => [
    key,
    (field as z.ZodDefault<z.ZodType>).removeDefault().optional(),
  ]),
) as { [K in keyof Settings]: z.ZodOptional<z.ZodType<Settings[K]>> };

export const settingsPatchSchema = z.object(patchShape).strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
