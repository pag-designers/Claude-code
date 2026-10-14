import type { SidecarStatus } from '@shared/domain';
import type { InvokeChannel, InvokeOutput } from '@shared/ipc';
import { detectHardware } from '../services/hardware';
import { logger } from '../logger';
import type { Services } from '../services/context';
import type { LibraryService } from '../pipeline/library';
import type { ChatService } from '../pipeline/chat';
import type { Cp2Service } from '../pipeline/cp2';
import type { StyleRegistry } from '../pipeline/styles';
import type { EditorService } from '../pipeline/editor';
import type { BrandService } from '../pipeline/brand';
import type { BrollHub } from '../pipeline/broll';
import type { CaptionService } from '../pipeline/contracts';
import type { PipelineOrchestrator } from '../pipeline/orchestrator';
import type { UrlInfo } from '@shared/pipeline';
import type { Handlers } from './dispatch';

/** Everything the handlers need that is Electron-specific is injected (keeps this file testable). */
export interface HostApi {
  appInfo(): InvokeOutput<'app:info'>;
  openExternal(url: string): Promise<void>;
  exportLogs(text: string): Promise<{ saved: boolean; path: string | null }>;
  pipeline: PipelineOrchestrator;
  library: LibraryService;
  cp2: Cp2Service;
  chat: ChatService;
  editor: EditorService;
  brand: BrandService;
  broll: BrollHub;
  styles: StyleRegistry;
  captions: Pick<CaptionService, 'fonts'>;
  fontsDir(): string | null;
  probeUrl(url: string): Promise<UrlInfo>;
  sidecar: {
    status(): SidecarStatus;
    setup(): Promise<unknown>;
    start(): Promise<unknown>;
    stop(): Promise<unknown>;
  };
}

export function buildHandlers(svc: Services, host: HostApi): Handlers {
  const ok = { ok: true as const };
  const handlers: Handlers = {
    'app:info': () => host.appInfo(),
    'settings:get': () => svc.settings.get(),
    'settings:set': async (patch) => {
      const next = await svc.settings.set(patch);
      await svc.storage.refresh(); // so a Start right after saving sees the new provider
      return next;
    },

    'secrets:status': () => ({ backend: svc.secrets.backend, keys: svc.secrets.status() }),
    'secrets:set': async ({ key, value }) => {
      svc.secrets.set(key, value);
      await svc.storage.refresh();
      svc.storageUsage.invalidate();
      return ok;
    },
    'secrets:clear': async ({ key }) => {
      svc.secrets.clear(key);
      await svc.storage.refresh();
      svc.storageUsage.invalidate();
      return ok;
    },

    'validate:run': ({ service }) => svc.validators.run(service),
    'storage:usage': ({ refresh }) => svc.storageUsage.get(refresh),

    'notifications:list': ({ limit }) => svc.notifications.list(limit),
    'notifications:markRead': async ({ ids }) => {
      await svc.notifications.markRead(ids);
      return ok;
    },
    'notifications:markAllRead': async () => {
      await svc.notifications.markAllRead();
      return ok;
    },
    'notifications:clear': async () => {
      await svc.notifications.clear();
      return ok;
    },

    'jobs:list': async ({ limit }) => ({ items: await svc.queue.list(limit) }),
    'jobs:cancel': async ({ id }) => {
      await svc.queue.cancel(id);
      return ok;
    },
    'jobs:retry': async ({ id }) => {
      await svc.queue.retry(id);
      return ok;
    },

    'binaries:status': async () => ({ tools: await svc.binaries.status() }),
    'binaries:updateYtdlp': () => svc.binaries.updateYtdlp(),

    'sidecar:status': () => host.sidecar.status(),
    'sidecar:setup': () => {
      void host.sidecar.setup().catch((e) => logger.scoped('sidecar').error(String(e)));
      return host.sidecar.status();
    },
    'sidecar:start': async () => {
      void host.sidecar.start().catch((e) => logger.scoped('sidecar').error(String(e)));
      return host.sidecar.status();
    },
    'sidecar:stop': async () => {
      await host.sidecar.stop();
      return host.sidecar.status();
    },

    'system:hardware': async () => detectHardware(await svc.binaries.listEncoders()),
    'cost:summary': () => svc.cost.summary(),

    'pipeline:probe': ({ url }) => host.probeUrl(url),
    'pipeline:start': ({ url, options }) => host.pipeline.start(url, options),
    'pipeline:cancel': async ({ videoId }) => {
      await host.pipeline.cancel(videoId);
      return ok;
    },
    'pipeline:retryStage': async ({ videoId, stage }) => {
      await host.pipeline.retryStage(videoId, stage);
      return ok;
    },

    'videos:list': async ({ favorite, limit }) => ({
      items: await host.library.listVideos({ favorite, limit }),
    }),
    'videos:get': ({ id }) => host.library.getVideo(id),
    'videos:transcript': ({ id }) => host.library.transcript(id),
    'videos:favorite': async ({ id, value }) => {
      await host.library.setVideoFavorite(id, value);
      return ok;
    },
    'videos:delete': async ({ id, deleteFromStorage }) => {
      await host.library.deleteVideo(id, deleteFromStorage);
      return ok;
    },
    'videos:proxyUrl': async ({ id }) => ({ url: await host.library.proxyUrl(id) }),

    'clips:list': async ({ videoId, favorite, minScore, limit }) => ({
      items: await host.library.listClips({ videoId, favorite, minScore, limit }),
    }),
    'clips:favorite': async ({ ids, value }) => {
      await host.library.favoriteClips(ids, value);
      return ok;
    },
    'clips:delete': async ({ ids }) => {
      await host.library.deleteClips(ids);
      return ok;
    },
    'clips:rerender': async ({ id }) => {
      await host.pipeline.rerenderClip(id);
      return ok;
    },
    'clips:mediaUrl': async ({ id, kind }) => ({ url: await host.library.mediaUrl(id, kind) }),
    'clips:download': ({ ids, withCaptions }) => host.library.download(ids, withCaptions),

    /* ---- CP2 ---- */
    'captions:styles': async () => ({ styles: await host.styles.list() }),
    'captions:fonts': () => ({ fonts: host.captions.fonts(host.fontsDir()) }),
    'captions:saveStyle': ({ style }) => host.styles.save(style),
    'captions:deleteStyle': async ({ id }) => {
      await host.styles.delete(id);
      return ok;
    },
    'captions:preview': (a) => host.cp2.previewStyle(a),
    'clips:restyle': async ({ ids, styleId, reframeMode }) => {
      await host.cp2.restyle(ids, { styleId, reframeMode });
      return ok;
    },
    'clips:reframe': async ({ ids, mode }) => {
      await host.cp2.restyle(ids, { reframeMode: mode });
      return ok;
    },
    'videos:setCaptionStyle': async ({ id, styleId }) => {
      await host.cp2.setVideoCaptionStyle(id, styleId);
      return ok;
    },

    'subtitles:get': ({ videoId }) => host.cp2.subtitlesGet(videoId),
    'subtitles:save': ({ videoId, edits }) => host.cp2.subtitlesSave(videoId, edits),
    'subtitles:export': (a) => host.cp2.subtitlesExport(a),

    'moments:find': ({ videoId, prompt, options }) =>
      host.pipeline.startMomentsRun(videoId, prompt, options),
    'moments:runs': async ({ videoId }) => ({ items: await host.pipeline.listRuns(videoId) }),
    'moments:cancel': async ({ runId }) => {
      await host.pipeline.cancelRun(runId);
      return ok;
    },
    'highlights:create': ({ videoId, prompt }) => host.cp2.createHighlights(videoId, prompt),

    'hooks:get': ({ clipId }) => host.cp2.hooksGet(clipId),
    'hooks:generate': ({ clipId }) => host.cp2.hooksGenerate(clipId),
    'hooks:apply': async ({ clipId, choice }) => {
      await host.cp2.hooksApply(clipId, choice);
      return ok;
    },
    'meta:get': ({ clipId }) => host.cp2.metaGet(clipId),
    'meta:generate': ({ clipId }) => host.cp2.metaGenerate(clipId),
    'meta:save': async ({ clipId, platform, meta }) => {
      await host.cp2.metaSave(clipId, platform, meta);
      return ok;
    },
    'thumbs:get': ({ clipId }) => host.cp2.thumbsGet(clipId),
    'thumbs:generate': ({ clipId }) => host.cp2.thumbsGenerate(clipId),
    'thumbs:choose': async ({ clipId, t, overlayText }) => {
      await host.cp2.thumbsChoose(clipId, t, overlayText);
      return ok;
    },
    'thumbs:url': async ({ clipId, index }) => ({ url: await host.cp2.thumbUrl(clipId, index) }),

    'chat:threads': async ({ videoId, clipId }) => ({
      items: await host.chat.threads(videoId, clipId),
    }),
    'chat:messages': async ({ threadId }) => ({ items: await host.chat.messages(threadId) }),
    'chat:send': (a) => host.chat.send(a),
    'chat:cancel': async ({ threadId }) => {
      host.chat.cancel(threadId);
      return ok;
    },
    'chat:delete': async ({ threadId }) => {
      await host.chat.delete(threadId);
      return ok;
    },

    'markers:list': async ({ videoId }) => ({ items: await host.cp2.listMarkers(videoId) }),
    'markers:add': ({ videoId, atSec, label }) => host.cp2.addMarker(videoId, atSec, label),
    'markers:delete': async ({ id }) => {
      await host.cp2.deleteMarker(id);
      return ok;
    },

    /* ---- CP3: editor ---- */
    'editor:list': async () => ({ items: await host.editor.list() }),
    'editor:create': ({ name, from, brandKitId }) => host.editor.create(name, from, brandKitId),
    'editor:get': ({ id }) => host.editor.get(id),
    'editor:save': ({ id, project, baseRev }) => host.editor.save(id, project, baseRev),
    'editor:rename': async ({ id, name }) => {
      await host.editor.rename(id, name);
      return ok;
    },
    'editor:duplicate': ({ id }) => host.editor.duplicate(id),
    'editor:delete': async ({ id }) => {
      await host.editor.delete(id);
      return ok;
    },
    'editor:versions': async ({ id }) => ({ items: await host.editor.versions(id) }),
    'editor:saveVersion': ({ id, label }) => host.editor.saveVersion(id, label),
    'editor:restoreVersion': ({ id, versionId }) => host.editor.restoreVersion(id, versionId),
    'editor:previewUrl': ({ projectId, assetId }) => host.editor.previewUrl(projectId, assetId),
    'editor:importAssets': ({ projectId, kinds }) => host.editor.importAssets(projectId, kinds),
    'editor:waveform': ({ projectId, assetId }) => host.editor.waveform(projectId, assetId),
    'editor:beats': async ({ projectId, assetId }) => ({
      beats: await host.editor.beats(projectId, assetId),
    }),
    'editor:thumbStrip': (a) => host.editor.thumbStrip(a),
    'editor:reframe': (a) => host.editor.reframeAsset(a),
    'editor:resyncSubtitles': ({ projectId, assetId, srcStartSec, srcEndSec }) =>
      host.editor.resyncSubtitles(projectId, assetId, srcStartSec, srcEndSec),
    'editor:export': ({ projectId, settings }) => host.editor.startExport(projectId, settings),
    'editor:exportCancel': async ({ id }) => {
      await host.editor.cancelExport(id);
      return ok;
    },
    'exports:list': async ({ limit }) => ({ items: await host.editor.listExports(limit) }),
    'exports:url': async ({ id, kind }) => ({ url: await host.editor.exportUrl(id, kind) }),
    'exports:delete': async ({ ids }) => {
      await host.editor.deleteExports(ids);
      return ok;
    },
    'exports:download': ({ ids }) => host.editor.downloadExports(ids),

    /* ---- CP4: brand kits ---- */
    'brand:list': async () => ({ items: await host.brand.listKits() }),
    'brand:get': ({ id }) => host.brand.get(id),
    'brand:create': ({ name, copyFrom }) => host.brand.create(name, copyFrom),
    'brand:update': ({ id, patch, baseRev }) => host.brand.update(id, patch, baseRev),
    'brand:duplicate': ({ id }) => host.brand.duplicate(id),
    'brand:delete': async ({ id }) => {
      await host.brand.remove(id);
      return ok;
    },
    'brand:setDefault': async ({ id }) => {
      await host.brand.setDefault(id);
      return ok;
    },
    'brand:browse': ({ kitId, kind }) => host.brand.browse(kitId, kind),
    'brand:addFiles': ({ kitId, kind, paths }) => host.brand.addFiles(kitId, kind, paths),
    'brand:renameAsset': async ({ id, name }) => {
      await host.brand.renameAsset(id, name);
      return ok;
    },
    'brand:deleteAssets': ({ ids }) => host.brand.deleteAssets(ids),
    'brand:extractColors': async ({ assetId, count }) => ({
      colors: await host.brand.extractColors(assetId, count),
    }),
    'brand:fonts': () => host.brand.fontList(),
    'brand:styles': async ({ kitId }) => ({ styles: await host.brand.styles(kitId) }),
    'brand:saveStyle': ({ kitId, style }) => host.brand.saveStyle(kitId, style),
    'brand:apply': ({ kitId, clipIds, videoId }) => host.brand.apply({ kitId, clipIds, videoId }),
    'brand:defaultKit': async () => ({ id: await host.brand.defaultKitId() }),

    /* ---- CP4: stock B-roll ---- */
    'broll:status': () => host.broll.status(),
    'broll:search': (a) => host.broll.search(a),
    'broll:importToProject': ({ projectId, item }) => host.broll.importToProject(projectId, item),
    'broll:importToKit': ({ kitId, item }) => host.broll.importToKit(kitId, item),
    'broll:suggest': async ({ text }) => ({ queries: await host.broll.suggest(text) }),

    'shell:openExternal': async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
      await host.openExternal(url);
      return ok;
    },
    'diagnostics:exportLogs': () => host.exportLogs(logger.dump()),
  };
  // Compile-time guard: every contract channel has a handler.
  const _all: Record<InvokeChannel, unknown> = handlers;
  void _all;
  return handlers;
}
