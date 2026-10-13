import type { SidecarStatus } from '@shared/domain';
import type { InvokeChannel, InvokeOutput } from '@shared/ipc';
import { detectHardware } from '../services/hardware';
import { logger } from '../logger';
import type { Services } from '../services/context';
import type { Handlers } from './dispatch';

/** Everything the handlers need that is Electron-specific is injected (keeps this file testable). */
export interface HostApi {
  appInfo(): InvokeOutput<'app:info'>;
  openExternal(url: string): Promise<void>;
  exportLogs(text: string): Promise<{ saved: boolean; path: string | null }>;
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
    'settings:set': (patch) => svc.settings.set(patch),

    'secrets:status': () => ({ backend: svc.secrets.backend, keys: svc.secrets.status() }),
    'secrets:set': ({ key, value }) => {
      svc.secrets.set(key, value);
      svc.storageUsage.invalidate();
      return ok;
    },
    'secrets:clear': ({ key }) => {
      svc.secrets.clear(key);
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
