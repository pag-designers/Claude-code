import { describe, expect, it } from 'vitest';
import { AppError, dispatch } from '@main/ipc/dispatch';
import { buildHandlers } from '@main/ipc/handlers';
import { EVENT_CHANNELS, INVOKE_CHANNELS, invokeContract } from '@shared/ipc';
import { makeServices } from './helpers';

const host = {
  appInfo: () => ({
    name: 'Clipfern',
    version: '0.0.0',
    platform: 'linux',
    arch: 'x64',
    electron: '1',
    node: '22',
    chrome: '1',
    userData: '/x',
    isPackaged: false,
  }),
  openExternal: async () => {},
  exportLogs: async () => ({ saved: false, path: null }),
  sidecar: {
    status: () => {
      throw new Error('unused');
    },
    setup: async () => {},
    start: async () => {},
    stop: async () => {},
  },
};

describe('IPC contract', () => {
  it('has a handler for every channel and nothing extra', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      const handlers = buildHandlers(svc, host as never);
      expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
    } finally {
      await cleanup();
    }
  });

  it('channel names are namespaced and unique', () => {
    for (const c of [...INVOKE_CHANNELS, ...EVENT_CHANNELS])
      expect(c).toMatch(/^[a-z]+:[A-Za-z]+$/);
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
  });

  it('rejects invalid input before the handler runs', async () => {
    let called = false;
    const res = await dispatch('secrets:set', { key: 'not.a.key', value: 'x' }, (() => {
      called = true;
      return { ok: true as const };
    }) as never);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VALIDATION');
  });

  it('rejects a handler output that violates the contract', async () => {
    const res = await dispatch('secrets:clear', { key: 'whop.apiKey' }, (() => ({
      ok: false,
    })) as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FAILED');
  });

  it('serialises thrown errors without stack traces', async () => {
    const res = await dispatch('settings:get', undefined, (() => {
      throw new AppError('UNAVAILABLE', 'nope');
    }) as never);
    expect(res).toEqual({ ok: false, error: { code: 'UNAVAILABLE', message: 'nope' } });
  });

  it('applies defaults declared in input schemas', () => {
    const parsed = invokeContract['notifications:list'].input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it('end-to-end: settings:set round-trips through dispatch and persists', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      const h = buildHandlers(svc, host as never);
      const set = await dispatch(
        'settings:set',
        { theme: 'light', concurrency: 3 },
        h['settings:set'] as never,
      );
      expect(set.ok && set.data.theme).toBe('light');
      const bad = await dispatch('settings:set', { concurrency: 99 }, h['settings:set'] as never);
      expect(bad.ok).toBe(false);
      const got = await dispatch('settings:get', undefined, h['settings:get'] as never);
      expect(got.ok && got.data.concurrency).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it('blocks non-http(s) URLs in shell:openExternal', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      const h = buildHandlers(svc, host as never);
      const res = await dispatch(
        'shell:openExternal',
        { url: 'file:///etc/passwd' },
        h['shell:openExternal'] as never,
      );
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('error transport across contextBridge', () => {
  it('round-trips the error code through the message encoding', async () => {
    const { encodeIpcError, decodeIpcError } = await import('@shared/ipc');
    const err = decodeIpcError(
      new Error(
        `Error invoking remote method 'x': Error: ${encodeIpcError('VALIDATION', 'bad payload')}`,
      ),
    );
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('bad payload');
    expect(decodeIpcError(new Error('plain failure')).code).toBe('FAILED');
    expect(decodeIpcError('[[NOPE]] x').code).toBe('FAILED');
  });
});
