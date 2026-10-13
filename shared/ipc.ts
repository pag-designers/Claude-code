import { z } from 'zod';
import {
  costSummarySchema,
  hardwareSchema,
  jobSchema,
  notificationSchema,
  sidecarStatusSchema,
  storageUsageSchema,
  toolStatusSchema,
  validationResultSchema,
  validationServiceSchema,
} from './domain';
import {
  clipViewSchema,
  pipelineEventSchema,
  pipelineOptionsSchema,
  pipelineStageSchema,
  stageStateSchema,
  transcriptSchema,
  urlInfoSchema,
  videoAnalysisSchema,
  videoViewSchema,
} from './pipeline';
import { secretKeySchema, secretsBackendSchema, secretStatusSchema } from './secrets';
import { settingsPatchSchema, settingsSchema } from './settings';

/**
 * Single source of truth for the renderer <-> main boundary (ADR-009).
 * Add a channel HERE first; main registers a handler, preload whitelists it automatically.
 */
const ch = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });

const none = z.undefined();
const ok = z.object({ ok: z.literal(true) });

export const invokeContract = {
  'app:info': ch(
    none,
    z.object({
      name: z.string(),
      version: z.string(),
      platform: z.string(),
      arch: z.string(),
      electron: z.string(),
      node: z.string(),
      chrome: z.string(),
      userData: z.string(),
      isPackaged: z.boolean(),
    }),
  ),
  'settings:get': ch(none, settingsSchema),
  'settings:set': ch(settingsPatchSchema, settingsSchema),

  'secrets:status': ch(
    none,
    z.object({
      backend: secretsBackendSchema,
      keys: z.record(secretKeySchema, secretStatusSchema),
    }),
  ),
  'secrets:set': ch(z.object({ key: secretKeySchema, value: z.string().min(1).max(8192) }), ok),
  'secrets:clear': ch(z.object({ key: secretKeySchema }), ok),

  'validate:run': ch(z.object({ service: validationServiceSchema }), validationResultSchema),

  'storage:usage': ch(z.object({ refresh: z.boolean().default(false) }), storageUsageSchema),

  'notifications:list': ch(
    z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    z.object({ items: z.array(notificationSchema), unread: z.number() }),
  ),
  'notifications:markRead': ch(z.object({ ids: z.array(z.string()).min(1) }), ok),
  'notifications:markAllRead': ch(none, ok),
  'notifications:clear': ch(none, ok),

  'jobs:list': ch(
    z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    z.object({ items: z.array(jobSchema) }),
  ),
  'jobs:cancel': ch(z.object({ id: z.string() }), ok),
  'jobs:retry': ch(z.object({ id: z.string() }), ok),

  'binaries:status': ch(none, z.object({ tools: z.array(toolStatusSchema) })),
  'binaries:updateYtdlp': ch(none, toolStatusSchema),

  'sidecar:status': ch(none, sidecarStatusSchema),
  'sidecar:setup': ch(none, sidecarStatusSchema),
  'sidecar:start': ch(none, sidecarStatusSchema),
  'sidecar:stop': ch(none, sidecarStatusSchema),

  'system:hardware': ch(none, hardwareSchema),
  'cost:summary': ch(none, costSummarySchema),

  /* ---- CP1: pipeline, videos, clips ---- */
  'pipeline:probe': ch(z.object({ url: z.string().min(1) }), urlInfoSchema),
  'pipeline:start': ch(
    z.object({ url: z.string().min(1), options: pipelineOptionsSchema.partial().optional() }),
    z.object({ videoId: z.string() }),
  ),
  'pipeline:cancel': ch(z.object({ videoId: z.string() }), ok),
  'pipeline:retryStage': ch(z.object({ videoId: z.string(), stage: pipelineStageSchema }), ok),

  'videos:list': ch(
    z.object({ favorite: z.boolean().optional(), limit: z.number().int().min(1).max(500).default(200) }),
    z.object({ items: z.array(videoViewSchema) }),
  ),
  'videos:get': ch(
    z.object({ id: z.string() }),
    z.object({
      video: videoViewSchema,
      analysis: videoAnalysisSchema.nullable(),
      stages: z.array(stageStateSchema),
    }),
  ),
  'videos:transcript': ch(z.object({ id: z.string() }), transcriptSchema.nullable()),
  'videos:favorite': ch(z.object({ id: z.string(), value: z.boolean() }), ok),
  'videos:delete': ch(z.object({ id: z.string(), deleteFromStorage: z.boolean().default(true) }), ok),
  /** Presigned playback URL for the 480p proxy (null when none exists yet). */
  'videos:proxyUrl': ch(z.object({ id: z.string() }), z.object({ url: z.string().nullable() })),

  'clips:list': ch(
    z.object({
      videoId: z.string().optional(),
      favorite: z.boolean().optional(),
      minScore: z.number().min(0).max(100).optional(),
      limit: z.number().int().min(1).max(1000).default(500),
    }),
    z.object({ items: z.array(clipViewSchema) }),
  ),
  'clips:favorite': ch(z.object({ ids: z.array(z.string()).min(1), value: z.boolean() }), ok),
  'clips:delete': ch(z.object({ ids: z.array(z.string()).min(1) }), ok),
  'clips:rerender': ch(z.object({ id: z.string() }), ok),
  /** Presigned URL (R2/B2) for in-app playback / thumbnail. */
  'clips:mediaUrl': ch(
    z.object({ id: z.string(), kind: z.enum(['render', 'thumb']) }),
    z.object({ url: z.string().nullable() }),
  ),
  /** Opens a folder picker, downloads the rendered MP4s (+ SRT) there. */
  'clips:download': ch(
    z.object({ ids: z.array(z.string()).min(1), withCaptions: z.boolean().default(false) }),
    z.object({ saved: z.number(), dir: z.string().nullable(), canceled: z.boolean() }),
  ),

  'shell:openExternal': ch(z.object({ url: z.string().url() }), ok),
  'diagnostics:exportLogs': ch(none, z.object({ saved: z.boolean(), path: z.string().nullable() })),
} as const;

export type InvokeChannel = keyof typeof invokeContract;
export type InvokeInput<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['input']>;
export type InvokeOutput<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['output']>;

/** Push events main -> renderer. */
export const eventContract = {
  'notifications:new': notificationSchema,
  'jobs:updated': jobSchema,
  'sidecar:progress': sidecarStatusSchema,
  'storage:updated': storageUsageSchema,
  'settings:changed': settingsSchema,
  'pipeline:event': pipelineEventSchema,
  'videos:updated': videoViewSchema,
  'clips:updated': clipViewSchema,
  /** Main asks the renderer to navigate (tray menu, OS notification click). */
  'nav:go': z.object({ href: z.string() }),
} as const;

export type EventChannel = keyof typeof eventContract;
export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;

export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(eventContract) as EventChannel[];

/** Serialised error shape crossing the bridge (never a raw stack, never secrets). */
export const ipcErrorSchema = z.object({
  code: z.enum(['VALIDATION', 'NOT_FOUND', 'UNAVAILABLE', 'FAILED', 'UNKNOWN_CHANNEL']),
  message: z.string(),
});
export type IpcError = z.infer<typeof ipcErrorSchema>;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** The API exposed on `window.clipfern` by the preload script. */
export interface ClipfernApi {
  invoke<C extends InvokeChannel>(channel: C, payload?: InvokeInput<C>): Promise<InvokeOutput<C>>;
  on<E extends EventChannel>(event: E, cb: (payload: EventPayload<E>) => void): () => void;
  readonly platform: string;
}

/**
 * `contextBridge` clones thrown errors down to `{name, message}`, so a custom class or `.code`
 * would be lost on the way to the renderer. The preload therefore encodes the code in the message
 * (`[[CODE]] text`) and the renderer decodes it back into an `IpcCallError`.
 */
const ERROR_CODES = ipcErrorSchema.shape.code.options;
export function encodeIpcError(code: IpcError['code'], message: string): string {
  return `[[${code}]] ${message}`;
}
export function decodeIpcError(e: unknown): IpcCallError {
  if (e instanceof IpcCallError) return e;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error';
  const m = /\[\[([A-Z_]+)\]\]\s*([\s\S]*)$/.exec(raw);
  const code = m?.[1] as IpcError['code'] | undefined;
  if (code && (ERROR_CODES as readonly string[]).includes(code))
    return new IpcCallError(code, m?.[2] || 'Request failed');
  const message = raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(Error|IpcCallError):\s*/, '');
  return new IpcCallError('FAILED', message || 'Request failed');
}

export class IpcCallError extends Error {
  constructor(
    public readonly code: IpcError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'IpcCallError';
  }
}
