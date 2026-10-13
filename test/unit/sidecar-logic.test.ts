import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  LOG_TAIL_SIZE,
  StatusStore,
  UV_VERSION,
  backoffMs,
  findFreePort,
  parseProgressLine,
  parseSha256File,
  redact,
  selectUvAsset,
  uvDownloadUrl,
} from '../../electron/main/services/sidecar';
import { sidecarStatusSchema, type SidecarStatus } from '../../shared/domain';
import net from 'node:net';

describe('parseProgressLine', () => {
  it('parses a progress line', () => {
    const line =
      '{"type":"progress","phase":"downloading-model","progress":0.42,"message":"Downloading tiny"}';
    expect(parseProgressLine(line)).toEqual({
      kind: 'progress',
      phase: 'downloading-model',
      progress: 0.42,
      message: 'Downloading tiny',
    });
  });

  it('clamps progress to 0..1 and maps non-numbers to null (indeterminate)', () => {
    expect(
      parseProgressLine('{"type":"progress","phase":"p","progress":7,"message":""}'),
    ).toMatchObject({
      progress: 1,
    });
    expect(
      parseProgressLine('{"type":"progress","phase":"p","progress":-3,"message":""}'),
    ).toMatchObject({
      progress: 0,
    });
    expect(
      parseProgressLine('{"type":"progress","phase":"p","progress":null,"message":"x"}'),
    ).toMatchObject({
      progress: null,
    });
    expect(parseProgressLine('{"type":"progress","phase":"p","message":"x"}')).toMatchObject({
      progress: null,
    });
  });

  it('parses result, error and log lines', () => {
    expect(parseProgressLine('{"type":"result","ok":true,"path":"/m"}')).toEqual({
      kind: 'result',
      data: { ok: true, path: '/m' },
    });
    expect(parseProgressLine('{"type":"error","message":"boom"}')).toEqual({
      kind: 'error',
      message: 'boom',
    });
    expect(parseProgressLine('{"type":"log","message":"hi"}')).toEqual({
      kind: 'log',
      message: 'hi',
    });
  });

  it('returns null for non-protocol lines', () => {
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('Resolved 60 packages in 1.2s')).toBeNull();
    expect(parseProgressLine('{not json')).toBeNull();
    expect(parseProgressLine('[1,2,3]')).toBeNull();
    expect(parseProgressLine('{"type":"mystery"}')).toBeNull();
    expect(parseProgressLine('{"no":"type"}')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseProgressLine('  {"type":"log","message":"a"}  \r')).toEqual({
      kind: 'log',
      message: 'a',
    });
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunk boundaries and handles \\r\\n and \\r', () => {
    const s = new LineSplitter();
    expect(s.push('abc')).toEqual([]);
    expect(s.push('def\nghi\r\njk')).toEqual(['abcdef', 'ghi']);
    expect(s.push('l\r')).toEqual(['jkl']);
    expect(s.flush()).toEqual([]);
    s.push('tail');
    expect(s.flush()).toEqual(['tail']);
  });
});

describe('findFreePort', () => {
  it('returns a bindable loopback port and distinct ports are usable concurrently', async () => {
    const [a, b] = await Promise.all([findFreePort(), findFreePort()]);
    for (const port of [a, b]) {
      expect(port).toBeGreaterThan(1023);
      expect(port).toBeLessThan(65536);
    }
    // The port must really be free: we can bind it.
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(a, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });
});

describe('selectUvAsset', () => {
  it.each([
    ['darwin', 'arm64', 'uv-aarch64-apple-darwin.tar.gz', 'uv'],
    ['darwin', 'x64', 'uv-x86_64-apple-darwin.tar.gz', 'uv'],
    ['linux', 'x64', 'uv-x86_64-unknown-linux-gnu.tar.gz', 'uv'],
    ['linux', 'arm64', 'uv-aarch64-unknown-linux-gnu.tar.gz', 'uv'],
    ['win32', 'x64', 'uv-x86_64-pc-windows-msvc.zip', 'uv.exe'],
    ['win32', 'arm64', 'uv-aarch64-pc-windows-msvc.zip', 'uv.exe'],
  ])('%s/%s -> %s', (platform, arch, fileName, binName) => {
    const asset = selectUvAsset(platform, arch);
    expect(asset.fileName).toBe(fileName);
    expect(asset.binName).toBe(binName);
    expect(asset.archive).toBe(platform === 'win32' ? 'zip' : 'tar.gz');
  });

  it('throws for unsupported platforms', () => {
    expect(() => selectUvAsset('freebsd', 'x64')).toThrow(/No uv build/);
    expect(() => selectUvAsset('linux', 'riscv64')).toThrow(/No uv build/);
  });

  it('builds the pinned GitHub release URL', () => {
    const url = uvDownloadUrl(UV_VERSION, selectUvAsset('linux', 'x64'));
    expect(url).toBe(
      `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
    );
    expect(UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('parseSha256File', () => {
  const hex = 'a'.repeat(64);
  it('reads `<hex>  <name>` lines', () => {
    expect(parseSha256File(`${hex.toUpperCase()}  uv-x86_64-unknown-linux-gnu.tar.gz\n`)).toBe(hex);
  });
  it('rejects garbage', () => {
    expect(parseSha256File('<html>nope</html>')).toBeNull();
    expect(parseSha256File('abc')).toBeNull();
  });
});

describe('backoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(backoffMs(6)).toBe(30_000);
    expect(backoffMs(50)).toBe(30_000);
    expect(backoffMs(0)).toBe(1000);
  });
});

describe('redact', () => {
  it('removes secrets everywhere in a line and ignores too-short ones', () => {
    const token = 'deadbeefdeadbeefdeadbeef';
    expect(redact(`Authorization: Bearer ${token} / ${token}`, [token])).toBe(
      'Authorization: Bearer *** / ***',
    );
    expect(redact('abc', ['abc'])).toBe('abc');
  });
});

describe('StatusStore', () => {
  function make(): { store: StatusStore; seen: SidecarStatus[] } {
    const seen: SidecarStatus[] = [];
    return { store: new StatusStore('tiny', (s) => seen.push(s)), seen };
  }

  it('starts idle and always satisfies the shared schema', () => {
    const { store } = make();
    expect(store.get().phase).toBe('idle');
    expect(store.get().model).toBe('tiny');
    expect(sidecarStatusSchema.safeParse(store.get()).success).toBe(true);
  });

  it('walks the setup/start phases and keeps every snapshot schema-valid', () => {
    const { store, seen } = make();
    const phases = [
      'locating-uv',
      'downloading-uv',
      'creating-venv',
      'installing-packages',
      'downloading-model',
      'starting',
      'ready',
    ] as const;
    for (const phase of phases) store.set({ phase, progress: 0.5, message: phase });
    expect(seen.map((s) => s.phase)).toEqual([...phases]);
    for (const s of seen) expect(sidecarStatusSchema.safeParse(s).success).toBe(true);
  });

  it('clamps progress to 0..1', () => {
    const { store } = make();
    store.set({ progress: 3 });
    expect(store.get().progress).toBe(1);
    store.set({ progress: -1 });
    expect(store.get().progress).toBe(0);
    store.set({ progress: null });
    expect(store.get().progress).toBeNull();
  });

  it('does not emit when nothing changed', () => {
    const { store, seen } = make();
    store.set({ message: 'a' });
    store.set({ message: 'a' });
    expect(seen).toHaveLength(1);
  });

  it('clears the error when leaving the error phase, and the port when leaving ready', () => {
    const { store } = make();
    store.set({ phase: 'error', error: 'boom', message: 'failed' });
    expect(store.get().error).toBe('boom');
    store.set({ phase: 'starting' });
    expect(store.get().error).toBeNull();

    store.set({ phase: 'ready', port: 4242 });
    expect(store.get().port).toBe(4242);
    store.set({ phase: 'stopped' });
    expect(store.get().port).toBeNull();
  });

  it('keeps only the last 200 log lines and emits copies, never internal state', () => {
    const { store, seen } = make();
    for (let i = 0; i < LOG_TAIL_SIZE + 25; i++) store.pushLog(`line ${i}`);
    const tail = store.get().logTail;
    expect(tail).toHaveLength(LOG_TAIL_SIZE);
    expect(tail[0]).toBe('line 25');
    expect(tail.at(-1)).toBe(`line ${LOG_TAIL_SIZE + 24}`);
    const snapshot = seen[0];
    expect(snapshot?.logTail).toEqual(['line 0']); // earlier snapshot is not mutated later
    tail.push('mutation');
    expect(store.get().logTail).toHaveLength(LOG_TAIL_SIZE);
  });
});
