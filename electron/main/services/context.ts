import path from 'node:path';
import type { AppNotification, JobView, StorageUsage } from '@shared/domain';
import type { ClipView, PipelineEvent, VideoView } from '@shared/pipeline';
import type { Settings } from '@shared/settings';
import { openDatabase, type DbHandle } from '../db/client';
import { logger } from '../logger';
import { BinaryService } from './binaries';
import { CostTracker } from './cost';
import { NotificationService } from './notifications';
import { JobQueue } from './queue';
import { SecretStore, type Cipher } from './secrets';
import { SettingsService } from './settings';
import { resolveStorageProvider } from './storage/factory';
import type { StorageProvider } from './storage/provider';
import { StorageUsageService } from './storage/usage';
import { Validators } from './validators';

export interface Emitters {
  notification(n: AppNotification): void;
  job(j: JobView): void;
  storage(u: StorageUsage): void;
  settings(s: Settings): void;
  osNotify(n: AppNotification): void;
  pipeline(e: PipelineEvent): void;
  video(v: VideoView): void;
  clip(c: ClipView): void;
}

export interface Services {
  dbHandle: DbHandle;
  settings: SettingsService;
  secrets: SecretStore;
  notifications: NotificationService;
  queue: JobQueue;
  cost: CostTracker;
  storageUsage: StorageUsageService;
  binaries: BinaryService;
  validators: Validators;
  userDataDir: string;
  /** Synchronously readable active storage provider (null = not configured). Call refresh() after settings/secret changes. */
  storage: { get(): StorageProvider | null; refresh(): Promise<void> };
  /** Settings snapshots for modules that need a synchronous read. */
  currentWhisperModel(): string;
  currentCookies(): string | undefined;
}

export const JOB_KINDS = {
  refreshStorage: 'storage.refresh-usage',
  ensureYtdlp: 'binaries.ensure-ytdlp',
} as const;

/**
 * Builds every non-Electron service from plain inputs so the same wiring is used by the app and
 * by tests (pass a memory-backed path / fake cipher / noop emitters).
 */
export async function createServices(opts: {
  userDataDir: string;
  dbPath: string;
  cipher: Cipher;
  emit: Emitters;
  env?: Record<string, string | undefined>;
}): Promise<Services> {
  const log = logger.scoped('services');
  const dbHandle = await openDatabase(opts.dbPath);
  const db = dbHandle.prisma;

  const settings = new SettingsService(db);
  settings.onChange((s) => opts.emit.settings(s));
  const secrets = new SecretStore(
    path.join(opts.userDataDir, 'secrets.bin'),
    opts.cipher,
    opts.env ?? process.env,
  );

  const notifications = new NotificationService(db, {
    onCreated: opts.emit.notification,
    osNotify: opts.emit.osNotify,
  });

  // Self-healing (ADR-022): a database I/O fault reopens the connection, at most once per 10 s; if it keeps coming
  // back the file itself is the problem and the log says so once.
  let lastHeal = 0;
  let healStreak = 0;
  const heal = async (e: unknown): Promise<void> => {
    const now = Date.now();
    if (now - lastHeal < 10_000) return;
    healStreak = now - lastHeal < 120_000 ? healStreak + 1 : 1;
    lastHeal = now;
    log.warn(`database fault (${String(e)}); reopening the connection (#${healStreak})`);
    await dbHandle.reconnect();
    if (healStreak === 3)
      log.error(
        'The database keeps failing after reconnecting: the file may be damaged, on a volume that does not support SQLite locking (network / cloud-synced folder), or open in another Clipfern process. Quit every Clipfern instance (also the one in the menu bar) and, as a last resort, move clipfern.db* out of the app data folder (your clips stay in storage).',
      );
  };
  settings.onFault = heal;

  const queue = new JobQueue(db, {
    onFault: heal,
    // One pipeline job + two renders must be able to run together regardless of a low saved value.
    concurrency: () => Math.max(currentConcurrency, 3),
    onUpdate: opts.emit.job,
    log: (m) => logger.scoped('queue').warn(m),
  });
  let currentConcurrency = (await settings.get()).concurrency;
  settings.onChange((s) => {
    currentConcurrency = s.concurrency;
    queue.kick();
  });

  const cost = new CostTracker(db, async () => {
    const s = await settings.get();
    return { targetUsd: s.budgetTargetUsd, hardCapUsd: s.budgetHardCapUsd };
  });

  let snapshot = await settings.get();
  settings.onChange((s) => {
    snapshot = s;
  });

  const storageUsage = new StorageUsageService({
    db,
    notifications,
    onUpdate: opts.emit.storage,
    resolve: async () => {
      const s = await settings.get();
      const r = resolveStorageProvider(s, secrets);
      return r.ok
        ? { ok: true, provider: r.provider, freeTierGb: s.storageFreeTierGb }
        : {
            ok: false,
            reason: r.reason,
            providerId: s.storageProvider,
            freeTierGb: s.storageFreeTierGb,
          };
    },
  });
  // Any change to storage-related settings or keys invalidates cached usage.
  settings.onChange(() => storageUsage.invalidate());

  const binaries = new BinaryService(opts.userDataDir, (m) => logger.scoped('binaries').info(m));
  const validators = new Validators({ secrets, getSettings: () => settings.get() });

  let activeStorage: StorageProvider | null = null;
  const storage = {
    get: () => activeStorage,
    refresh: async () => {
      const r = resolveStorageProvider(await settings.get(), secrets);
      activeStorage = r.ok ? r.provider : null;
    },
  };
  await storage.refresh();
  settings.onChange(() => void storage.refresh());

  queue.register(JOB_KINDS.refreshStorage, async (ctx) => {
    await ctx.progress(0.1, 'Reading bucket');
    const u = await storageUsage.get(true);
    if (u.error && u.configured) throw new Error(u.error);
    return { usedBytes: u.usedBytes };
  });

  queue.register(
    JOB_KINDS.ensureYtdlp,
    async (ctx) => {
      await ctx.progress(0.1, 'Checking yt-dlp');
      const before = await binaries.checkYtdlp();
      if (before.ok) return { version: before.version, downloaded: false };
      await ctx.progress(0.3, 'Downloading yt-dlp');
      const st = await binaries.updateYtdlp();
      if (!st.ok) throw new Error(st.error ?? 'yt-dlp download failed');
      await notifications.create({
        kind: 'update',
        level: 'success',
        title: 'yt-dlp installed',
        body: `Version ${st.version}`,
      });
      return { version: st.version, downloaded: true };
    },
    { concurrency: 1, maxAttempts: 4 },
  );

  log.info('services ready');
  return {
    dbHandle,
    settings,
    secrets,
    notifications,
    queue,
    cost,
    storageUsage,
    binaries,
    validators,
    userDataDir: opts.userDataDir,
    storage,
    currentWhisperModel: () => snapshot.whisperModel,
    currentCookies: () =>
      snapshot.cookiesFromBrowser === 'none' ? undefined : snapshot.cookiesFromBrowser,
  };
}
