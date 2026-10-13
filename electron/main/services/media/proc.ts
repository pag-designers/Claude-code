import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Small child-process runner shared by the yt-dlp, ffmpeg and analysis modules.
 *
 *  - never leaves orphans: on abort the whole process group is killed (POSIX: `detached` + `kill(-pid)`,
 *    Windows: `taskkill /T /F`), and every live child is also killed when the main process exits;
 *  - never buffers unbounded output: only a bounded stderr tail is kept, stdout is delivered as chunks;
 *  - abort rejects with an `AbortError` (name === 'AbortError') so callers can tell it from failures.
 */

export interface RunProcessOptions {
  signal?: AbortSignal;
  /** Raw stdout chunks as they arrive (Buffer; may split lines/samples anywhere). */
  onStdout?: (chunk: Buffer) => void;
  /** Raw stderr chunks as they arrive. */
  onStderr?: (chunk: Buffer) => void;
  /** How many trailing bytes of stderr to keep for error messages. Default 8 KiB. */
  stderrTailBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export class AbortError extends Error {
  constructor(message = 'Operation canceled') {
    super(message);
    this.name = 'AbortError';
  }
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'DOMException');

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of live) killTree(child, 'SIGKILL');
  });
}

/** Kills a child and (best effort) everything it spawned. */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, sig); // negative pid = the whole process group (we spawn detached)
    }
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

export function runProcess(
  file: string,
  args: readonly string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    installExitHook();
    const tailMax = opts.stderrTailBytes ?? 8 * 1024;
    let tail = Buffer.alloc(0);
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(file, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });
    live.add(child);

    const onAbort = (): void => {
      aborted = true;
      killTree(child, 'SIGTERM');
      // Escalate if the child ignores SIGTERM.
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 2000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      live.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on('data', (c: Buffer) => {
      try {
        opts.onStdout?.(c);
      } catch (e) {
        // A throwing consumer must not leave the child running: abort and surface the error.
        killTree(child, 'SIGKILL');
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      tail = Buffer.concat([tail, c]);
      if (tail.length > tailMax) tail = tail.subarray(tail.length - tailMax);
      try {
        opts.onStderr?.(c);
      } catch {
        // stderr observers are best effort
      }
    });
    child.once('error', (err) => {
      cleanup();
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new Error(
          code === 'ENOENT'
            ? `Executable not found: ${file}`
            : `Could not start ${file}: ${err.message}`,
        ),
      );
    });
    child.once('close', (code, sig) => {
      cleanup();
      if (aborted) reject(new AbortError());
      else resolve({ code, signal: sig, stderrTail: tail.toString('utf8') });
    });
  });
}

/** Number of children currently tracked (used by tests to prove nothing leaks). */
export const liveProcessCount = (): number => live.size;

/** Splits a byte stream into lines on \n, \r\n and bare \r (progress bars use \r). */
export class LineBuffer {
  private rest = '';
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    this.rest += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parts = this.rest.split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? '';
    for (const p of parts) this.onLine(p);
  }
  flush(): void {
    if (this.rest) this.onLine(this.rest);
    this.rest = '';
  }
}
