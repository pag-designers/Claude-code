import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BinaryService, describeRunError } from '@main/services/binaries';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A BinaryService whose "yt-dlp" is the given shell script (POSIX only). */
function withScript(script: string): { svc: BinaryService; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-bin-'));
  dirs.push(dir);
  const svc = new BinaryService(dir);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(svc.ytdlpPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { svc, dir };
}

describe.skipIf(process.platform === 'win32')('yt-dlp check', () => {
  it('reports the version of a working binary', async () => {
    const { svc } = withScript('echo 2026.07.01');
    expect(await svc.checkYtdlp()).toMatchObject({ ok: true, version: '2026.07.01' });
  });

  it('says it timed out (not just "Command failed") when the binary does not answer', async () => {
    const { svc } = withScript('sleep 5');
    svc.ytdlpCheckTimeoutMs = 250;
    const st = await svc.checkYtdlp();
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/did not answer within 0\.3 s/);
    expect(st.error).not.toMatch(/^Command failed/);
  });

  it('retries once, so a slow FIRST launch (OS scan) still ends up working', async () => {
    const { svc, dir } = withScript('');
    const marker = path.join(dir, 'seen');
    fs.writeFileSync(
      svc.ytdlpPath,
      `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; sleep 5; fi\necho 2026.07.02\n`,
      { mode: 0o755 },
    );
    svc.ytdlpCheckTimeoutMs = 400;
    expect(await svc.checkYtdlp()).toMatchObject({ ok: true, version: '2026.07.02' });
  });

  it('includes the exit code and the last stderr lines for a real failure', async () => {
    const { svc } = withScript('echo "bad CPU type in executable" >&2; exit 86');
    const st = await svc.checkYtdlp();
    expect(st.ok).toBe(false);
    expect(st.error).toContain('exit code 86');
    expect(st.error).toContain('bad CPU type in executable');
  });

  it('a missing file is "not downloaded", and a non-executable one says permission denied', async () => {
    const { svc } = withScript('echo x');
    fs.chmodSync(svc.ytdlpPath, 0o644);
    expect((await svc.checkYtdlp()).error).toMatch(/not allowed to run/);
    fs.rmSync(svc.ytdlpPath);
    expect((await svc.checkYtdlp()).error).toBe('Not downloaded yet');
  });

  it('checks wait for a running update instead of racing it', async () => {
    const { svc } = withScript('echo 1');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // an update that holds the lock until released
    (svc as unknown as { withYtdlpLock<T>(f: () => Promise<T>): Promise<T> }).withYtdlpLock(async () => {
      order.push('update-start');
      await gate;
      order.push('update-end');
    });
    const check = svc.checkYtdlp().then((r) => {
      order.push('check');
      return r;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['update-start']);
    release();
    expect((await check).ok).toBe(true);
    expect(order).toEqual(['update-start', 'update-end', 'check']);
  });
});

describe('describeRunError', () => {
  it('names a system kill (macOS Gatekeeper) and gives a next step', () => {
    const e = Object.assign(new Error('Command failed: x'), { signal: 'SIGKILL', killed: false });
    expect(describeRunError(e)).toMatch(/stopped by the system \(SIGKILL\)/);
  });
});
