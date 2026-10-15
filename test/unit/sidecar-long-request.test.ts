import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SidecarManager } from '@main/services/sidecar';

/**
 * Regression (found by the real CP1 e2e): Node's default http agent has a 5 s idle-socket timeout, so
 * a /transcribe that computed for longer than 5 s died with "Sidecar request timed out". The client
 * must tolerate a silent server for as long as it takes.
 */
describe('sidecar HTTP client', () => {
  it('waits for a response that takes longer than the default 5 s socket timeout', async () => {
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ segments: [], language: 'en' }));
      }, 6000);
      void req;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const mgr = new SidecarManager({
        userDataDir: '/tmp/unused',
        sidecarSrcDir: '/tmp/unused',
        getModel: () => 'tiny',
        getDevicePref: () => 'cpu',
        log: () => {},
        onStatus: () => {},
      });
      // Point the (private) connection details at our slow server.
      Object.assign(mgr as unknown as Record<string, unknown>, { port: (server.address() as AddressInfo).port, token: 't'.repeat(32) });
      const res = await (mgr as unknown as { request(m: string, p: string, b: unknown): Promise<{ language: string }> }).request('POST', '/transcribe', {});
      expect(res.language).toBe('en');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 20_000);
});
