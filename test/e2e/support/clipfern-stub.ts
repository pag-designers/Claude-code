/**
 * TEST-ONLY stand-in for the Electron preload bridge (`window.clipfern`).
 * It lives in Node and is reached from the page through `page.exposeFunction`, which lets us run EVERY
 * request payload and EVERY response through the real zod contract in shared/ipc.ts. If the renderer
 * sends something the contract rejects, or this stub returns data the contract would reject, the call throws,
 * so the stub cannot drift from the contract.
 */
import type { Page } from '@playwright/test';
import {
  eventContract,
  invokeContract,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
} from '../../../shared/ipc';
import {
  costSummary,
  emptyCp1State,
  handleCp1,
  installRunFixtures,
  seedLibrary,
  type Cp1State,
  type Sim,
} from './cp1-sim';
import { handleCp2a } from './cp2-stub-a';
import { stubB } from './cp2-stub-b';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import { SECRET_KEYS, maskSecret, type SecretKey } from '../../../shared/secrets';
import type { AppNotification, JobView, SidecarStatus, StorageUsage } from '../../../shared/domain';

/** fresh = nothing set up; configured = every prerequisite met, empty library; library = configured + seeded videos/clips. */
export type Scenario = 'fresh' | 'configured' | 'library';

const GB = 1e9;
const now = Date.now();

function sidecar(partial: Partial<SidecarStatus>): SidecarStatus {
  return {
    phase: 'idle',
    progress: null,
    message: '',
    installed: false,
    modelReady: false,
    model: 'large-v3-turbo',
    device: null,
    port: null,
    error: null,
    logTail: [],
    ...partial,
  };
}

function storageUsage(configured: boolean): StorageUsage {
  if (!configured) {
    return {
      configured: false,
      provider: 'r2',
      usedBytes: 0,
      objectCount: 0,
      limitBytes: 10 * GB,
      fraction: 0,
      breakdown: { videos: 0, clips: 0, renders: 0, assets: 0, thumbs: 0, other: 0 },
      projectedMonthlyUsd: 0,
      updatedAt: null,
      error: null,
    };
  }
  const breakdown = {
    videos: 2.1 * GB,
    clips: 1.05 * GB,
    renders: 0.42 * GB,
    assets: 0.08 * GB,
    thumbs: 0.03 * GB,
    other: 0.01 * GB,
  };
  const used = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    configured: true,
    provider: 'r2',
    usedBytes: used,
    objectCount: 842,
    limitBytes: 10 * GB,
    fraction: used / (10 * GB),
    breakdown,
    projectedMonthlyUsd: 0,
    updatedAt: now - 4 * 60_000,
    error: null,
  };
}

const notification = (
  n: Partial<AppNotification> & Pick<AppNotification, 'id' | 'title'>,
): AppNotification => ({
  kind: 'system',
  level: 'info',
  body: null,
  href: null,
  createdAt: now,
  readAt: null,
  ...n,
});

export interface StubState extends Cp1State {
  settings: Settings;
  secrets: Partial<Record<SecretKey, { value: string; source: 'store' | 'env' }>>;
  notifications: AppNotification[];
  jobs: JobView[];
  storage: StorageUsage;
  sidecar: SidecarStatus;
  platform: string;
  calls: { channel: string; payload: unknown }[];
}

export function makeState(
  scenario: Scenario,
  platform = 'linux',
  opts: { assetBase?: string } = {},
): StubState {
  const configured = scenario !== 'fresh';
  const state: StubState = {
    ...emptyCp1State(opts.assetBase ?? ''),
    platform,
    settings: { ...DEFAULT_SETTINGS },
    secrets: configured
      ? {
          'anthropic.apiKey': { value: 'sk-ant-api03-demo-key-7f3a', source: 'store' },
          'r2.accessKeyId': { value: 'AKIA-demo-1a2b', source: 'store' },
          'r2.secretAccessKey': { value: 'demo-secret-9c8d', source: 'store' },
          'pexels.apiKey': { value: 'pexels-demo-4d5e', source: 'env' },
        }
      : {},
    notifications: configured
      ? [
          notification({
            id: 'n1',
            title: 'Storage at 82% of the free tier',
            body: 'Free up space or raise the cap to keep uploading.',
            level: 'warning',
            kind: 'storage',
            href: '/settings/storage/',
            createdAt: now - 12 * 60_000,
          }),
          notification({
            id: 'n2',
            title: 'Transcription engine is ready',
            body: 'Whisper large-v3-turbo is installed and running on CPU.',
            level: 'success',
            kind: 'system',
            href: '/settings/compute/',
            createdAt: now - 3 * 3600_000,
          }),
          notification({
            id: 'n3',
            title: 'yt-dlp updated',
            body: null,
            level: 'info',
            kind: 'update',
            createdAt: now - 26 * 3600_000,
            readAt: now - 25 * 3600_000,
          }),
        ]
      : [],
    jobs: configured
      ? [
          {
            id: 'j1',
            kind: 'pipeline.transcribe',
            status: 'running',
            progress: 0.42,
            stage: 'transcribing',
            attempts: 1,
            maxAttempts: 3,
            error: null,
            createdAt: now - 4 * 60_000,
            updatedAt: now - 5_000,
            startedAt: now - 3 * 60_000,
            finishedAt: null,
          },
          {
            id: 'j2',
            kind: 'storage.refresh',
            status: 'queued',
            progress: 0,
            stage: null,
            attempts: 0,
            maxAttempts: 3,
            error: null,
            createdAt: now - 60_000,
            updatedAt: now - 60_000,
            startedAt: null,
            finishedAt: null,
          },
        ]
      : [],
    storage: storageUsage(configured),
    sidecar: configured
      ? sidecar({
          phase: 'ready',
          installed: true,
          modelReady: true,
          device: 'cpu',
          port: 51234,
          message: 'Engine running',
          logTail: [
            'INFO uvicorn started on 127.0.0.1:51234',
            'INFO model large-v3-turbo loaded (cpu, int8)',
          ],
        })
      : sidecar({ phase: 'idle' }),
    calls: [],
  };
  installRunFixtures(state);
  if (scenario === 'library') seedLibrary(state);
  if (configured && scenario !== 'library') state.costSpent = 12.84;
  return state;
}

export function secretsStatus(state: StubState) {
  const keys = Object.fromEntries(
    SECRET_KEYS.map((k) => {
      const s = state.secrets[k];
      return [
        k,
        s
          ? { set: true, masked: maskSecret(s.value), source: s.source }
          : { set: false, masked: null, source: null },
      ];
    }),
  );
  return { backend: 'os-keystore' as const, keys };
}

/** Computes the response for a channel. Pure with respect to the contract: caller validates in/out. */
async function handle(
  state: StubState,
  channel: InvokeChannel,
  payload: unknown,
): Promise<unknown> {
  const cp1 = await handleCp1(state, channel, payload);
  if (cp1) return cp1.value;
  const cp2a = await handleCp2a(state, channel, payload); // UI-A: captions + subtitles
  if (cp2a) return cp2a.value;
  const cp2b = await stubB.handle(state, channel, payload); // UI-B: hooks, metadata, thumbnails, steering, chat, markers
  if (cp2b) return cp2b.value;
  switch (channel) {
    case 'app:info':
      return {
        name: 'Clipfern',
        version: '0.1.0',
        platform: state.platform,
        arch: 'x64',
        electron: '44.7.0',
        node: '22.22.0',
        chrome: '142.0.7444.0',
        userData: '/home/demo/.config/Clipfern',
        isPackaged: false,
      };
    case 'settings:get':
      return state.settings;
    case 'settings:set':
      state.settings = { ...state.settings, ...(payload as Partial<Settings>) };
      return state.settings;
    case 'secrets:status':
      return secretsStatus(state);
    case 'secrets:set': {
      const p = payload as { key: SecretKey; value: string };
      state.secrets[p.key] = { value: p.value, source: 'store' };
      return { ok: true };
    }
    case 'secrets:clear': {
      delete state.secrets[(payload as { key: SecretKey }).key];
      return { ok: true };
    }
    case 'validate:run': {
      const service = (payload as { service: string }).service;
      const key = (
        {
          anthropic: 'anthropic.apiKey',
          pexels: 'pexels.apiKey',
          pixabay: 'pixabay.apiKey',
          whop: 'whop.apiKey',
          storage: 'r2.accessKeyId',
        } as Record<string, SecretKey>
      )[service]!;
      const ok = !!state.secrets[key];
      return {
        ok,
        message: ok ? `${service} responded` : `No ${service} credentials saved`,
        latencyMs: ok ? 184 : 3,
        detail: null,
      };
    }
    case 'storage:usage':
      return state.storage;
    case 'notifications:list':
      return {
        items: state.notifications,
        unread: state.notifications.filter((n) => n.readAt === null).length,
      };
    case 'notifications:markRead': {
      const ids = (payload as { ids: string[] }).ids;
      state.notifications = state.notifications.map((n) =>
        ids.includes(n.id) ? { ...n, readAt: Date.now() } : n,
      );
      return { ok: true };
    }
    case 'notifications:markAllRead':
      state.notifications = state.notifications.map((n) => ({
        ...n,
        readAt: n.readAt ?? Date.now(),
      }));
      return { ok: true };
    case 'notifications:clear':
      state.notifications = [];
      return { ok: true };
    case 'jobs:list':
      return { items: state.jobs };
    case 'jobs:cancel':
    case 'jobs:retry':
      return { ok: true };
    case 'binaries:status':
      return {
        tools: [
          {
            name: 'ffmpeg',
            ok: true,
            version: '6.1.1',
            path: '/usr/bin/ffmpeg',
            error: null,
            source: 'bundled',
          },
          {
            name: 'ffprobe',
            ok: true,
            version: '6.1.1',
            path: '/usr/bin/ffprobe',
            error: null,
            source: 'bundled',
          },
          {
            name: 'yt-dlp',
            ok: state.sidecar.installed,
            version: state.sidecar.installed ? '2026.09.30' : null,
            path: state.sidecar.installed ? '/home/demo/.config/Clipfern/bin/yt-dlp' : null,
            error: state.sidecar.installed ? null : 'Not downloaded yet',
            source: state.sidecar.installed ? 'downloaded' : null,
          },
          {
            name: 'uv',
            ok: state.sidecar.installed,
            version: state.sidecar.installed ? '0.9.4' : null,
            path: null,
            error: state.sidecar.installed ? null : 'Not found',
            source: null,
          },
          {
            name: 'python',
            ok: state.sidecar.installed,
            version: state.sidecar.installed ? '3.11.12' : null,
            path: null,
            error: state.sidecar.installed ? null : 'Engine not installed',
            source: null,
          },
        ],
      };
    case 'binaries:updateYtdlp':
      return {
        name: 'yt-dlp',
        ok: true,
        version: '2026.10.01',
        path: '/home/demo/.config/Clipfern/bin/yt-dlp',
        error: null,
        source: 'downloaded',
      };
    case 'sidecar:status':
    case 'sidecar:setup':
    case 'sidecar:start':
    case 'sidecar:stop':
      return state.sidecar;
    case 'system:hardware':
      return {
        platform: state.platform,
        arch: 'x64',
        cpuModel: 'AMD Ryzen 7 5800X 8-Core Processor',
        cpuCores: 16,
        totalMemGb: 31.9,
        gpu: { kind: 'nvidia', name: 'NVIDIA GeForce RTX 3070', vramMb: 8192 },
        encoders: ['h264_nvenc', 'libx264'],
      };
    case 'cost:summary':
      return costSummary(
        state,
        state.settings.budgetTargetUsd,
        state.settings.budgetHardCapUsd,
        !!state.secrets['anthropic.apiKey'],
      );
    case 'shell:openExternal':
      return { ok: true };
    case 'diagnostics:exportLogs':
      return { saved: true, path: '/home/demo/Downloads/clipfern-logs.zip' };
  }
}

/** Installs the validated bridge into a page. Returns helpers for tests to push events and inspect calls. */
export async function installClipfernStub(page: Page, state: StubState) {
  await page.exposeFunction('__clipfernInvoke', async (channel: string, payload: unknown) => {
    if (!(channel in invokeContract)) throw new Error(`Unknown channel: ${channel}`);
    const c = channel as InvokeChannel;
    const spec = invokeContract[c];
    const input = spec.input.parse(payload); // renderer -> main payload must satisfy the contract
    state.calls.push({ channel, payload: input });
    const out = await handle(state, c, input);
    return spec.output.parse(out); // main -> renderer response must satisfy the contract
  });
  await page.addInitScript((platform: string) => {
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    (window as unknown as Record<string, unknown>).clipfern = {
      platform,
      invoke: (channel: string, payload?: unknown) =>
        (
          window as unknown as { __clipfernInvoke: (c: string, p: unknown) => Promise<unknown> }
        ).__clipfernInvoke(channel, payload),
      on: (event: string, cb: (p: unknown) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return () => listeners.get(event)?.delete(cb);
      },
    };
    (window as unknown as Record<string, unknown>).__emit = (event: string, payload: unknown) =>
      listeners.get(event)?.forEach((cb) => cb(payload));
  }, state.platform);

  const emit = async <E extends EventChannel>(event: E, payload: EventPayload<E>) => {
    const parsed = eventContract[event].parse(payload); // main -> renderer events are contract-checked too
    await page.evaluate(
      ([e, p]) =>
        (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(e as string, p),
      [event, parsed] as const,
    );
  };
  state.emit = async (event, payload) => {
    try {
      await emit(event, payload);
    } catch (e) {
      // the page may be closed while a timer-driven run is still going; contract violations must still surface
      if (e instanceof Error && /Target (page|closed)|Execution context|closed/i.test(e.message))
        return;
      throw e;
    }
  };
  state.notify = async (n) => {
    state.notifications.unshift(n);
    await state.emit?.('notifications:new', n);
  };

  return {
    emit,
    state,
    /** Scripted pipeline run for a video started through `pipeline:start`. */
    sim(videoId: string): Sim {
      const s = state.sims[videoId];
      if (!s) throw new Error(`No scripted run for ${videoId}; was pipeline:start called?`);
      return s;
    },
  };
}

export const stubNotification = notification;
