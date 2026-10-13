import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import type { AppNotification, SidecarStatus } from '@shared/domain';
import type { EventChannel, EventPayload } from '@shared/ipc';
import { buildHandlers } from './ipc/handlers';
import { registerHandlers } from './ipc/register';
import { logger } from './logger';
import { createServices, JOB_KINDS, type Services } from './services/context';
import { pickCipher } from './services/secrets';
import { SidecarManager } from './services/sidecar';
import { createPipeline } from './pipeline/wiring';

const APP_NAME = 'Clipfern';
const APP_HOST = 'clipfern';
const DEV_URL = process.env.CLIPFERN_DEV_URL; // set by scripts/dev.mjs

// A custom userData dir lets e2e tests (and the user) isolate app data.
if (process.env.CLIPFERN_USER_DATA) app.setPath('userData', process.env.CLIPFERN_USER_DATA);
app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let sidecar: SidecarManager | null = null;
const log = logger.scoped('main');

function send<E extends EventChannel>(event: E, payload: EventPayload<E>): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(event, payload);
  }
}

const rendererRoot = () => path.join(app.getAppPath(), 'renderer', 'out');

/** Maps app://clipfern/<path> onto the static export, with traversal protection. */
function registerAppProtocol(): void {
  const root = rendererRoot();
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) && file !== root)
      return new Response('Forbidden', { status: 403 });
    if (!path.extname(file) && fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      const withIndex = path.join(root, rel, 'index.html');
      if (fs.existsSync(withIndex)) file = withIndex;
      else return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function installSecurity(): void {
  const s3Override = process.env.CLIPFERN_S3_ENDPOINT_OVERRIDE; // dev/test emulator only
  const extraMedia = s3Override ? ` ${new URL(s3Override).origin}` : '';
  const connect = DEV_URL ? "'self' https: http://localhost:* ws://localhost:*" : "'self' https:";
  const script = DEV_URL ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
  const csp = [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https:${extraMedia}`,
    `media-src 'self' blob: https:${extraMedia}`,
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith(`app://${APP_HOST}`);
}

function createWindow(initialDark: boolean): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    backgroundColor: initialDark ? '#09090e' : '#f6f6fa',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 12 } }
      : {
          titleBarOverlay: {
            color: initialDark ? '#09090e' : '#f6f6fa',
            symbolColor: initialDark ? '#e7e9ee' : '#1a1c22',
            height: 36,
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = url.startsWith(`app://${APP_HOST}`) || (DEV_URL && url.startsWith(DEV_URL));
    if (!allowed) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  void win.loadURL(DEV_URL ?? `app://${APP_HOST}/`);
  return win;
}

function osNotify(n: AppNotification): void {
  if (!Notification.isSupported()) return;
  const notif = new Notification({
    title: n.title,
    body: n.body ?? undefined,
    silent: n.level === 'info',
  });
  notif.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (n.href) send('nav:go', { href: n.href });
  });
  notif.show();
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  logger.attachFile(path.join(userData, 'logs', 'main.log'));
  log.info(
    `${APP_NAME} ${app.getVersion()} starting (electron ${process.versions.electron}, userData=${userData})`,
  );

  const cipher = pickCipher(safeStorage, path.join(userData, 'secrets.key'));
  if (cipher.backend === 'insecure-fallback')
    log.warn('No OS keystore available; using insecure file-key fallback for secrets');

  services = await createServices({
    userDataDir: userData,
    dbPath: path.join(userData, 'clipfern.db'),
    cipher,
    emit: {
      notification: (n) => send('notifications:new', n),
      job: (j) => send('jobs:updated', j),
      storage: (u) => send('storage:updated', u),
      settings: (s) => send('settings:changed', s),
      osNotify,
      pipeline: (e) => send('pipeline:event', e),
      video: (v) => send('videos:updated', v),
      clip: (c) => send('clips:updated', c),
    },
  });
  const svc = services;

  const settings = await svc.settings.get();
  nativeTheme.themeSource = settings.theme;
  svc.settings.onChange((s) => {
    nativeTheme.themeSource = s.theme;
  });

  let currentSettings = settings;
  svc.settings.onChange((s) => {
    currentSettings = s;
  });

  sidecar = new SidecarManager({
    userDataDir: userData,
    sidecarSrcDir: app.isPackaged
      ? path.join(process.resourcesPath, 'sidecar')
      : path.join(app.getAppPath(), 'sidecar'),
    getModel: () => process.env.CLIPFERN_WHISPER_MODEL ?? currentSettings.whisperModel,
    getDevicePref: () => currentSettings.computeDevice,
    log: (line) => logger.scoped('sidecar').info(line),
    onStatus: (s: SidecarStatus) => send('sidecar:progress', s),
  });
  const pipeline = createPipeline(svc, sidecar, {
    emit: {
      pipeline: (e) => send('pipeline:event', e),
      video: (v) => send('videos:updated', v),
      clip: (c) => send('clips:updated', c),
    },
    chooseDirectory: async () => {
      const res = await dialog.showOpenDialog({
        title: 'Choose a folder for the clips',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('downloads'),
      });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    fontsDir: () => {
      const candidates = [
        path.join(process.resourcesPath ?? '', 'fonts'),
        path.join(app.getAppPath(), 'electron', 'main', 'assets', 'fonts'),
      ];
      return candidates.find((c) => fs.existsSync(c)) ?? null;
    },
  });
  pipeline.orchestrator.registerJobs();

  registerHandlers(
    buildHandlers(svc, {
      pipeline: pipeline.orchestrator,
      library: pipeline.library,
      probeUrl: pipeline.probeUrl,
      appInfo: () => ({
        name: APP_NAME,
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '',
        node: process.versions.node,
        chrome: process.versions.chrome ?? '',
        userData,
        isPackaged: app.isPackaged,
      }),
      openExternal: (url) => shell.openExternal(url),
      exportLogs: async (text) => {
        const res = await dialog.showSaveDialog({
          title: 'Export Clipfern logs',
          defaultPath: path.join(app.getPath('downloads'), `clipfern-logs-${Date.now()}.txt`),
          filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
        });
        if (res.canceled || !res.filePath) return { saved: false, path: null };
        fs.writeFileSync(res.filePath, text);
        return { saved: true, path: res.filePath };
      },
      sidecar: {
        status: () => sidecar!.getStatus(),
        setup: () => sidecar!.setup(),
        start: () => sidecar!.start(),
        stop: () => sidecar!.stop(),
      },
    }),
    isTrustedSender,
  );

  const { recovered } = await svc.queue.start();
  await pipeline.orchestrator.reconcileOnStart();
  if (recovered) log.info(`re-queued ${recovered} job(s) interrupted by the last shutdown`);
  // Real background work through the durable queue: make sure yt-dlp exists; read bucket usage.
  await svc.queue.enqueue({ kind: JOB_KINDS.ensureYtdlp, priority: 5 });
  await svc.queue.enqueue({ kind: JOB_KINDS.refreshStorage });

  registerAppProtocol();
  installSecurity();
  mainWindow = createWindow(nativeTheme.shouldUseDarkColors);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (e) {
      log.error(
        `fatal during bootstrap: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      dialog.showErrorBox(
        `${APP_NAME} failed to start`,
        e instanceof Error ? e.message : String(e),
      );
      app.exit(1);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && services)
      mainWindow = createWindow(nativeTheme.shouldUseDarkColors);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    void (async () => {
      try {
        await sidecar?.stop();
        await services?.queue.stop();
        await services?.dbHandle.close();
      } catch (err) {
        log.error(`shutdown error: ${String(err)}`);
      } finally {
        logger.close();
        app.exit(0);
      }
    })();
  });
}
