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
  pipelineOptionsPatchSchema,
  pipelineStageSchema,
  stageStateSchema,
  transcriptSchema,
  urlInfoSchema,
  videoAnalysisSchema,
  videoViewSchema,
} from './pipeline';
import {
  captionStyleSchema,
  chatEventSchema,
  chatMessageSchema,
  chatThreadSchema,
  clipHooksSchema,
  clipMetaSchema,
  clipThumbnailsSchema,
  cueSchema,
  markerSchema,
  momentRunSchema,
  platformMetaSchema,
  platformSchema,
  reframeModeSchema,
  subtitleEditsSchema,
} from './cp2';
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
    z.object({ url: z.string().min(1), options: pipelineOptionsPatchSchema.optional() }),
    z.object({ videoId: z.string() }),
  ),
  'pipeline:cancel': ch(z.object({ videoId: z.string() }), ok),
  'pipeline:retryStage': ch(z.object({ videoId: z.string(), stage: pipelineStageSchema }), ok),

  'videos:list': ch(
    z.object({
      favorite: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(200),
    }),
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
  'videos:delete': ch(
    z.object({ id: z.string(), deleteFromStorage: z.boolean().default(true) }),
    ok,
  ),
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

  /* ---- CP2: captions, subtitles, steering, highlights, hooks, metadata, thumbnails, chat ---- */
  'captions:styles': ch(none, z.object({ styles: z.array(captionStyleSchema) })),
  'captions:fonts': ch(
    none,
    z.object({ fonts: z.array(z.object({ family: z.string(), weights: z.array(z.number()) })) }),
  ),
  /** Creates a custom preset (unknown id or a built-in id => new id) or updates one. Returns the saved style. */
  'captions:saveStyle': ch(z.object({ style: captionStyleSchema }), captionStyleSchema),
  'captions:deleteStyle': ch(z.object({ id: z.string() }), ok),
  /** REAL libass render of the style on a sample frame (debounced by the caller). */
  'captions:preview': ch(
    z.object({
      style: captionStyleSchema,
      /** Sample caption text (default: a pangram-like line). */
      text: z.string().max(120).optional(),
      /** Use a frame from this clip as background (falls back to a neutral gradient). */
      clipId: z.string().optional(),
      aspect: z.enum(['9:16', '1:1', '4:5', '16:9']).default('9:16'),
      /** Which word of `text` is the active (spoken) one. */
      activeWord: z.number().int().min(0).max(30).default(1),
    }),
    z.object({ dataUrl: z.string(), width: z.number(), height: z.number() }),
  ),
  /** Re-render clips with another style and/or reframe mode. */
  'clips:restyle': ch(
    z.object({
      ids: z.array(z.string()).min(1),
      styleId: z.string().optional(),
      reframeMode: reframeModeSchema.optional(),
    }),
    ok,
  ),
  'videos:setCaptionStyle': ch(z.object({ id: z.string(), styleId: z.string() }), ok),

  'subtitles:get': ch(
    z.object({ videoId: z.string() }),
    z.object({
      cues: z.array(cueSchema),
      edits: subtitleEditsSchema,
      language: z.string(),
      /** Number of rendered clips built from an older subtitle revision. */
      outdatedClips: z.number(),
    }),
  ),
  'subtitles:save': ch(
    z.object({ videoId: z.string(), edits: subtitleEditsSchema }),
    z.object({ cues: z.array(cueSchema), edits: subtitleEditsSchema, outdatedClips: z.number() }),
  ),
  /** Save dialog → writes SRT/VTT for the whole video or one clip. */
  'subtitles:export': ch(
    z.object({
      videoId: z.string(),
      clipId: z.string().optional(),
      format: z.enum(['srt', 'vtt']),
    }),
    z.object({ saved: z.boolean(), path: z.string().nullable() }),
  ),

  /** User-steered re-run of moment finding on an already-transcribed video (BRIEF §4.5). */
  'moments:find': ch(
    z.object({
      videoId: z.string(),
      prompt: z.string().min(2).max(500),
      options: pipelineOptionsPatchSchema.optional(),
    }),
    z.object({ runId: z.string() }),
  ),
  'moments:runs': ch(
    z.object({ videoId: z.string() }),
    z.object({ items: z.array(momentRunSchema) }),
  ),
  'moments:cancel': ch(z.object({ runId: z.string() }), ok),

  /** One-Click Highlights (BRIEF §4.6): LLM-ordered reel of the best micro-moments. */
  'highlights:create': ch(
    z.object({ videoId: z.string(), prompt: z.string().max(300).optional() }),
    z.object({ clipId: z.string() }),
  ),

  'hooks:get': ch(z.object({ clipId: z.string() }), clipHooksSchema.nullable()),
  'hooks:generate': ch(z.object({ clipId: z.string() }), clipHooksSchema),
  /** Burn a variant in as the title card (platform+index) or remove the card (null). Re-renders. */
  'hooks:apply': ch(
    z.object({
      clipId: z.string(),
      choice: z
        .object({ platform: platformSchema, index: z.number().int().min(0).max(9) })
        .nullable(),
    }),
    ok,
  ),

  'meta:get': ch(z.object({ clipId: z.string() }), clipMetaSchema.nullable()),
  'meta:generate': ch(z.object({ clipId: z.string() }), clipMetaSchema),
  'meta:save': ch(
    z.object({ clipId: z.string(), platform: platformSchema, meta: platformMetaSchema }),
    ok,
  ),

  'thumbs:get': ch(z.object({ clipId: z.string() }), clipThumbnailsSchema.nullable()),
  /** Samples frames, scores them (sharpness/face/composition), asks the vision model to rank the best. */
  'thumbs:generate': ch(z.object({ clipId: z.string() }), clipThumbnailsSchema),
  /** Pick a candidate (t) and optional overlay text → rebuilds thumb.jpg. */
  'thumbs:choose': ch(
    z.object({ clipId: z.string(), t: z.number(), overlayText: z.string().max(60).nullable() }),
    ok,
  ),
  'thumbs:url': ch(
    z.object({ clipId: z.string(), index: z.number().int().min(0) }),
    z.object({ url: z.string().nullable() }),
  ),

  'clips:reframe': ch(z.object({ ids: z.array(z.string()).min(1), mode: reframeModeSchema }), ok),

  'chat:threads': ch(
    z.object({ videoId: z.string(), clipId: z.string().optional() }),
    z.object({ items: z.array(chatThreadSchema) }),
  ),
  'chat:messages': ch(
    z.object({ threadId: z.string() }),
    z.object({ items: z.array(chatMessageSchema) }),
  ),
  /** Streams the answer through the `chat:event` event; resolves as soon as the user message is stored. */
  'chat:send': ch(
    z.object({
      videoId: z.string(),
      clipId: z.string().optional(),
      threadId: z.string().optional(),
      text: z.string().min(1).max(4000),
    }),
    z.object({ threadId: z.string(), messageId: z.string() }),
  ),
  'chat:cancel': ch(z.object({ threadId: z.string() }), ok),
  'chat:delete': ch(z.object({ threadId: z.string() }), ok),

  'markers:list': ch(z.object({ videoId: z.string() }), z.object({ items: z.array(markerSchema) })),
  'markers:add': ch(
    z.object({ videoId: z.string(), atSec: z.number().min(0), label: z.string().min(1).max(120) }),
    markerSchema,
  ),
  'markers:delete': ch(z.object({ id: z.string() }), ok),

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
  'chat:event': chatEventSchema,
  'moments:run': momentRunSchema,
  'markers:changed': z.object({ videoId: z.string() }),
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
