import path from 'node:path';
import type { SidecarManager } from '../services/sidecar';
import type { Services } from '../services/context';
import { createAnalysisService } from '../services/analysis';
import { createCaptionService } from '../services/captions';
import { createLlmService } from '../services/llm';
import { createMediaService } from '../services/media/ffmpeg';
import { createIngestService } from '../services/media/ytdlp';
import { createMomentService } from '../services/moments';
import { createReframeService, facesFromSidecar } from '../services/reframe';
import { createRenderService, extractThumbnail } from '../services/render';
import { logger } from '../logger';
import { LibraryService } from './library';
import { PipelineOrchestrator } from './orchestrator';

export interface PipelineHost {
  emit: ConstructorParameters<typeof PipelineOrchestrator>[0]['emit'];
  chooseDirectory(): Promise<string | null>;
  /** Directory with fonts for libass (null = system fonts). */
  fontsDir(): string | null;
}

/** Builds every CP1 service from the main services + host (Electron-specific bits injected). */
export function createPipeline(svc: Services, sidecar: SidecarManager, host: PipelineHost) {
  const log = (m: string) => logger.scoped('pipeline').info(m);
  const ffmpegPath = () => {
    const p = svc.binaries.ffmpegPath();
    if (!p) throw new Error('ffmpeg is not available.');
    return p;
  };
  const ffprobePath = () => {
    const p = svc.binaries.ffprobePath();
    if (!p) throw new Error('ffprobe is not available.');
    return p;
  };
  const ytdlpPath = () => svc.binaries.ytdlpPath;

  // yt-dlp needs a JS runtime for YouTube; Electron's own binary can act as Node (ELECTRON_RUN_AS_NODE).
  const ingest = createIngestService({
    ytdlpPath,
    ffmpegPath,
    log,
    jsRuntime: () => ({ path: process.execPath, name: 'node', electronAsNode: true }),
  });
  const media = createMediaService({ ffmpegPath, ffprobePath, log });
  const llm = createLlmService({
    getApiKey: () => svc.secrets.get('anthropic.apiKey'),
    getSettings: () => svc.settings.get(),
    cost: svc.cost,
    // Dev/test only (stub server). NOT the SDK's ANTHROPIC_BASE_URL: that one is often set by other tools.
    baseUrl: process.env.CLIPFERN_ANTHROPIC_BASE_URL || undefined,
    log: (m) => logger.scoped('llm').info(m),
    onBudget: (level) => {
      if (level === 'hard-cap') return; // surfaced as a pipeline failure notification
      void svc.notifications.create({
        kind: 'system',
        level: 'warning',
        title: level === 'warn' ? 'AI spend at 80% of your monthly target' : 'AI spend passed your monthly target',
        body: 'Clipfern will use the cheaper model for low-value tasks and find fewer candidates. Adjust the budget in Settings → Models & Budget.',
        href: '/settings/models/',
        os: level !== 'warn',
      });
    },
  });

  const orchestrator = new PipelineOrchestrator({
    db: svc.dbHandle.prisma,
    queue: svc.queue,
    settings: svc.settings,
    notifications: svc.notifications,
    ingest,
    media,
    analysis: createAnalysisService(),
    llm,
    moments: createMomentService(),
    reframe: createReframeService(),
    captions: createCaptionService(),
    render: createRenderService(),
    sidecar,
    toFaceSamples: (wire) => facesFromSidecar(wire as Parameters<typeof facesFromSidecar>[0]),
    thumbnail: extractThumbnail,
    cacheDir: path.join(svc.userDataDir, 'cache'),
    ffmpegPath,
    fontsDir: host.fontsDir,
    getStorage: () => svc.storage.get(),
    invalidateStorage: () => svc.storageUsage.invalidate(),
    whisperModel: () => process.env.CLIPFERN_WHISPER_MODEL || svc.currentWhisperModel(),
    cookiesFromBrowser: () => svc.currentCookies(),
    emit: host.emit,
    log,
    async checkReady() {
      if (!llm.isConfigured()) return 'Add your Anthropic API key in Settings → API Keys.';
      await svc.storage.refresh();
      if (!svc.storage.get()) return 'Connect object storage first: add your Cloudflare R2 (or Backblaze B2) details in Settings → Storage.';
      const [ff, yt] = await Promise.all([svc.binaries.checkFfmpeg(), svc.binaries.checkYtdlp()]);
      if (!ff.ok) return `ffmpeg is not working: ${ff.error ?? 'unknown error'}`;
      if (!yt.ok) return 'yt-dlp is still being downloaded. Try again in a moment (Settings → Diagnostics shows its status).';
      const st = sidecar.getStatus();
      if (!st.installed || !st.modelReady) return 'Install the transcription engine first: Settings → Compute → Install.';
      return null;
    },
  });

  const library = new LibraryService({
    db: svc.dbHandle.prisma,
    orchestrator,
    getStorage: () => svc.storage.get(),
    invalidateStorage: () => svc.storageUsage.invalidate(),
    cacheDir: path.join(svc.userDataDir, 'cache'),
    chooseDirectory: host.chooseDirectory,
    log,
  });

  return {
    orchestrator,
    library,
    probeUrl: (url: string) =>
      ingest.probe(url, { cookiesFromBrowser: svc.currentCookies() }),
  };
}
