import { z } from 'zod';

export const notificationLevelSchema = z.enum(['info', 'success', 'warning', 'error']);
export const notificationKindSchema = z.enum([
  'job',
  'clips-ready',
  'render',
  'post',
  'storage',
  'whop',
  'update',
  'system',
]);

export const notificationSchema = z.object({
  id: z.string(),
  kind: notificationKindSchema,
  level: notificationLevelSchema,
  title: z.string(),
  body: z.string().nullable(),
  /** Optional in-app deep link, e.g. "/library". */
  href: z.string().nullable(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const notificationInputSchema = z.object({
  kind: notificationKindSchema,
  level: notificationLevelSchema.default('info'),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).nullish(),
  href: z.string().nullish(),
  /** Also raise an OS-level notification. */
  os: z.boolean().default(false),
});
export type NotificationInput = z.input<typeof notificationInputSchema>;

export const jobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: jobStatusSchema,
  /** 0..1 */
  progress: z.number(),
  stage: z.string().nullable(),
  attempts: z.number(),
  maxAttempts: z.number(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type JobView = z.infer<typeof jobSchema>;

export const storageCategorySchema = z.enum([
  'videos',
  'clips',
  'renders',
  'assets',
  'thumbs',
  'other',
]);
export type StorageCategory = z.infer<typeof storageCategorySchema>;

export const storageUsageSchema = z.object({
  configured: z.boolean(),
  provider: z.enum(['r2', 'b2']),
  usedBytes: z.number(),
  objectCount: z.number(),
  limitBytes: z.number(),
  fraction: z.number(),
  breakdown: z.record(storageCategorySchema, z.number()),
  /** Monthly cost estimate above the free tier (R2 ≈ $0.015/GB-month). */
  projectedMonthlyUsd: z.number(),
  updatedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;

export const validationServiceSchema = z.enum([
  'anthropic',
  'storage',
  'pexels',
  'pixabay',
  'whop',
]);
export type ValidationService = z.infer<typeof validationServiceSchema>;

export const validationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number(),
  detail: z.string().nullable(),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const toolStatusSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  error: z.string().nullable(),
  /** "bundled" | "downloaded" | "system" */
  source: z.string().nullable(),
});
export type ToolStatus = z.infer<typeof toolStatusSchema>;

export const sidecarPhaseSchema = z.enum([
  'idle',
  'locating-uv',
  'downloading-uv',
  'creating-venv',
  'installing-packages',
  'downloading-model',
  'starting',
  'ready',
  'error',
  'stopped',
]);
export type SidecarPhase = z.infer<typeof sidecarPhaseSchema>;

export const sidecarStatusSchema = z.object({
  phase: sidecarPhaseSchema,
  /** 0..1 within the current phase, null when indeterminate. */
  progress: z.number().nullable(),
  message: z.string(),
  installed: z.boolean(),
  modelReady: z.boolean(),
  model: z.string(),
  device: z.string().nullable(),
  port: z.number().nullable(),
  error: z.string().nullable(),
  logTail: z.array(z.string()),
});
export type SidecarStatus = z.infer<typeof sidecarStatusSchema>;

export const hardwareSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number(),
  totalMemGb: z.number(),
  gpu: z.object({
    kind: z.enum(['nvidia', 'apple', 'none']),
    name: z.string().nullable(),
    vramMb: z.number().nullable(),
  }),
  encoders: z.array(z.string()),
});
export type Hardware = z.infer<typeof hardwareSchema>;

export const costSummarySchema = z.object({
  month: z.string(),
  spentUsd: z.number(),
  projectedUsd: z.number(),
  targetUsd: z.number(),
  hardCapUsd: z.number(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedTokens: z.number(),
  level: z.enum(['ok', 'warn', 'over-target', 'hard-cap']),
});
export type CostSummary = z.infer<typeof costSummarySchema>;
