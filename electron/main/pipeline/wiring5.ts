import path from 'node:path';
import type { AppNotification } from '@shared/domain';
import type { Platform, PostView, SchedulerStatus } from '@shared/publish';
import { logger } from '../logger';
import type { Services } from '../services/context';
import { createInstagramProvider } from '../services/publish-instagram';
import { createPublishMedia } from '../services/publish-media';
import { createTiktokProvider } from '../services/publish-tiktok';
import { createYoutubeProvider } from '../services/publish-youtube';
import { OAuthLoopback } from '../services/publish/oauth';
import { TokenStore } from '../services/publish/token-store';
import type { Cipher } from '../services/secrets';
import type { BrandService } from './brand';
import type { ProviderDeps, PublisherProvider } from './contracts5';
import { PostingService } from './posting';
import { SchedulerService } from './scheduler';

export interface PostingHost {
  cipher: Cipher;
  openExternal(url: string): Promise<void>;
  trayAvailable(): boolean;
  emit: {
    post(p: PostView): void;
    accountsChanged(platform: Platform | null): void;
    scheduler(s: SchedulerStatus): void;
  };
  brand: Pick<BrandService, 'getKit' | 'defaultKitId'>;
  /** Dev/test overrides of the platform hosts (CLIPFERN_* env vars, see .env.example). */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/** Builds the CP5 services: three official-API publishers, media checks, OAuth loopback, tokens, posting + scheduler. */
export function createPosting(svc: Services, host: PostingHost) {
  const env = host.env ?? process.env;
  const log = (m: string) => logger.scoped('posting').info(m);
  const secret = (k: Parameters<Services['secrets']['get']>[0]) => svc.secrets.get(k)?.trim() || null;
  const creds = (id: Parameters<Services['secrets']['get']>[0], sec: Parameters<Services['secrets']['get']>[0]) =>
    () => {
      const clientId = secret(id);
      const clientSecret = secret(sec);
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    };
  const base = (extra: Record<string, string | undefined>): Record<string, string | undefined> => extra;
  const common = { log: (m: string) => logger.scoped('publish').info(m), now: host.now } as const;

  const providers: Record<Platform, PublisherProvider> = {
    shorts: createYoutubeProvider({
      ...common,
      getCredentials: creds('google.clientId', 'google.clientSecret'),
      baseUrls: base({
        oauthBase: env.CLIPFERN_GOOGLE_OAUTH_BASE || undefined,
        apiBase: env.CLIPFERN_YOUTUBE_API_BASE || undefined,
        uploadBase: env.CLIPFERN_YOUTUBE_UPLOAD_BASE || undefined,
      }),
    }),
    reels: createInstagramProvider({
      ...common,
      getCredentials: creds('meta.appId', 'meta.appSecret'),
      baseUrls: base({
        metaOauth: env.CLIPFERN_META_OAUTH_BASE || undefined,
        graph: env.CLIPFERN_GRAPH_BASE || undefined,
      }),
    } satisfies ProviderDeps),
    tiktok: createTiktokProvider({
      ...common,
      getCredentials: creds('tiktok.clientKey', 'tiktok.clientSecret'),
      baseUrls: base({
        tiktokAuth: env.CLIPFERN_TIKTOK_AUTH_BASE || undefined,
        tiktokApi: env.CLIPFERN_TIKTOK_API_BASE || undefined,
      }),
    }),
  };

  const tokens = new TokenStore(path.join(svc.userDataDir, 'tokens.bin'), host.cipher);
  const oauth = new OAuthLoopback({
    port: () => portSnapshot,
    openExternal: host.openExternal,
    log,
  });
  let portSnapshot = 53682;
  void svc.settings.get().then((s) => {
    portSnapshot = s.oauthLoopbackPort;
  });
  svc.settings.onChange((s) => {
    portSnapshot = s.oauthLoopbackPort;
  });

  const media = createPublishMedia({
    ffprobePath: () => {
      const p = svc.binaries.ffprobePath();
      if (!p) throw new Error('ffprobe is not available.');
      return p;
    },
    log,
  });

  const notify = (n: Parameters<Services['notifications']['create']>[0]): Promise<AppNotification> =>
    svc.notifications.create(n);

  const posting = new PostingService({
    db: svc.dbHandle.prisma,
    queue: svc.queue,
    brand: host.brand,
    providers,
    tokens,
    oauth,
    media,
    getSettings: () => svc.settings.get(),
    hasSecret: (k) => !!secret(k),
    getStorage: () => svc.storage.get(),
    cacheDir: path.join(svc.userDataDir, 'cache'),
    ffmpegPath: () => {
      const p = svc.binaries.ffmpegPath();
      if (!p) throw new Error('ffmpeg is not available.');
      return p;
    },
    notify,
    emit: { post: host.emit.post, accountsChanged: host.emit.accountsChanged },
    now: host.now,
    log,
  });
  posting.registerJobs();

  const scheduler = new SchedulerService({
    db: svc.dbHandle.prisma,
    posting,
    getSettings: () => svc.settings.get(),
    notify,
    trayAvailable: host.trayAvailable,
    emitStatus: host.emit.scheduler,
    now: host.now,
    tickMs: env.CLIPFERN_SCHEDULER_TICK_MS ? Number(env.CLIPFERN_SCHEDULER_TICK_MS) : undefined,
    log,
  });

  return { posting, scheduler, oauth, tokens, providers };
}
