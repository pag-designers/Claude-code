/**
 * Python sidecar lifecycle (ADR-008): locate/download `uv`, create the venv, install the pinned
 * requirements, self-check, download model weights, then run FastAPI/uvicorn on 127.0.0.1 with a
 * random port and a per-run bearer token. Node built-ins only.
 *
 * Pure helpers (progress-line parsing, uv asset selection, port allocation, status store, ...)
 * are exported for unit tests; `SidecarManager` is the stateful part.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { SidecarPhase, SidecarStatus } from '@shared/domain';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Pinned astral-sh/uv release used when `uv` is not already installed. */
export const UV_VERSION = '0.11.32';
export const PYTHON_VERSION = '3.11';
export const LOG_TAIL_SIZE = 200;
export const MAX_RESTARTS = 5;
const HEALTH_TIMEOUT_MS = 180_000;
const STABLE_UPTIME_MS = 60_000;
const INSTALL_STATE_FILE = '.clipfern-install.json';
const COMPLETE_MARKER = '.clipfern-complete';
const FACE_MODEL_FILENAME = 'blaze_face_short_range.tflite';

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export interface UvAsset {
  /** Rust target triple used in the release asset name. */
  triple: string;
  archive: 'zip' | 'tar.gz';
  /** e.g. `uv-x86_64-unknown-linux-gnu.tar.gz` */
  fileName: string;
  /** Executable name inside the archive and on disk. */
  binName: 'uv' | 'uv.exe';
}

/** Pick the uv standalone release asset for a platform/arch (Node `process.platform`/`arch`). */
export function selectUvAsset(platform: string, arch: string): UvAsset {
  let triple: string;
  switch (`${platform}-${arch}`) {
    case 'darwin-arm64':
      triple = 'aarch64-apple-darwin';
      break;
    case 'darwin-x64':
      triple = 'x86_64-apple-darwin';
      break;
    case 'linux-x64':
      triple = 'x86_64-unknown-linux-gnu';
      break;
    case 'linux-arm64':
      triple = 'aarch64-unknown-linux-gnu';
      break;
    case 'win32-x64':
      triple = 'x86_64-pc-windows-msvc';
      break;
    case 'win32-arm64':
      triple = 'aarch64-pc-windows-msvc';
      break;
    case 'win32-ia32':
      triple = 'i686-pc-windows-msvc';
      break;
    default:
      throw new Error(`No uv build is available for ${platform}/${arch}`);
  }
  const windows = platform === 'win32';
  const archive = windows ? 'zip' : 'tar.gz';
  return {
    triple,
    archive,
    fileName: `uv-${triple}.${archive}`,
    binName: windows ? 'uv.exe' : 'uv',
  };
}

export function uvDownloadUrl(version: string, asset: UvAsset): string {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${asset.fileName}`;
}

/** Parse the `<hex>  <filename>` text of a release `.sha256` file. */
export function parseSha256File(text: string): string | null {
  const m = /^([0-9a-fA-F]{64})\b/.exec(text.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

export type SidecarLineEvent =
  | { kind: 'progress'; phase: string; progress: number | null; message: string }
  | { kind: 'log'; message: string }
  | { kind: 'result'; data: Record<string, unknown> }
  | { kind: 'error'; message: string };

/**
 * Parse one stdout line of a bootstrap script (JSON-lines protocol, see
 * `sidecar/bootstrap/_emit.py`). Returns null for anything that is not a protocol line.
 */
export function parseProgressLine(line: string): SidecarLineEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const message = typeof rec.message === 'string' ? rec.message : '';
  switch (rec.type) {
    case 'progress': {
      const raw = rec.progress;
      const progress =
        typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null;
      return {
        kind: 'progress',
        phase: typeof rec.phase === 'string' ? rec.phase : '',
        progress,
        message,
      };
    }
    case 'log':
      return { kind: 'log', message };
    case 'result': {
      const { type: _type, ...data } = rec;
      return { kind: 'result', data };
    }
    case 'error':
      return { kind: 'error', message: message || 'Unknown error' };
    default:
      return null;
  }
}

/** Ask the OS for a free loopback TCP port. */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Exponential backoff: 1 s, 2 s, 4 s ... capped at 30 s. `attempt` is 1-based. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Splits a byte stream into lines across chunk boundaries (handles \n, \r\n and bare \r). */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r\n|\n|\r/);
    this.buf = parts.pop() ?? '';
    return parts;
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/** Replace every occurrence of a secret in a log line. */
export function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('***');
  }
  return out;
}

/**
 * Derives a 0..1 progress estimate from `uv pip install` output (it has no machine-readable
 * progress). Feed every line; `fraction()` is null until uv has resolved the dependency set.
 */
export class UvInstallProgress {
  private resolved = false;
  private total = 0;
  private done = 0;
  private finished = false;

  push(line: string): void {
    const l = line.trim();
    if (/^Resolved \d+ packages?/.test(l)) this.resolved = true;
    else if (/^Downloading \S+/.test(l)) this.total += 1;
    else if (/^Downloaded \S+/.test(l)) this.done += 1;
    else if (/^(Installed|Audited) \d+ packages?/.test(l)) this.finished = true;
  }

  fraction(): number | null {
    if (this.finished) return 1;
    if (!this.resolved) return null;
    // Downloads dominate the wall time; reserve the tail for unpacking/installing.
    return 0.05 + 0.9 * (this.total > 0 ? Math.min(1, this.done / this.total) : 0);
  }
}

export function initialStatus(model: string): SidecarStatus {
  return {
    phase: 'idle',
    progress: null,
    message: 'Sidecar not started',
    installed: false,
    modelReady: false,
    model,
    device: null,
    port: null,
    error: null,
    logTail: [],
  };
}

/**
 * Holds the SidecarStatus, keeps the log ring buffer and notifies on every visible change.
 * `onStatus` always receives a fresh copy, never the internal object.
 */
export class StatusStore {
  private status: SidecarStatus;
  constructor(
    model: string,
    private readonly onStatus: (s: SidecarStatus) => void,
    private readonly tailSize = LOG_TAIL_SIZE,
  ) {
    this.status = initialStatus(model);
  }

  get(): SidecarStatus {
    return { ...this.status, logTail: [...this.status.logTail] };
  }

  /** Merge a patch; progress is clamped to 0..1; leaving the `error` phase clears the error. */
  set(patch: Partial<Omit<SidecarStatus, 'logTail'>>): void {
    const next: SidecarStatus = { ...this.status, ...patch };
    if (next.progress !== null) next.progress = Math.min(1, Math.max(0, next.progress));
    if (patch.phase !== undefined && patch.phase !== 'error' && patch.error === undefined) {
      next.error = null;
    }
    if (patch.phase !== undefined && patch.phase !== 'ready' && patch.port === undefined) {
      next.port = null;
    }
    const changed = (Object.keys(next) as (keyof SidecarStatus)[]).some(
      (k) => k !== 'logTail' && next[k] !== this.status[k],
    );
    if (!changed) return;
    this.status = next;
    this.emit();
  }

  /** Append to the log ring buffer (emits so the UI log view stays live). */
  pushLog(line: string): void {
    const tail = this.status.logTail;
    tail.push(line);
    if (tail.length > this.tailSize) tail.splice(0, tail.length - this.tailSize);
    this.emit();
  }

  private emit(): void {
    this.onStatus(this.get());
  }
}

// ---------------------------------------------------------------------------------------------
// Wire types of the sidecar HTTP API (snake_case, exactly as FastAPI serialises them)
// ---------------------------------------------------------------------------------------------

export interface SidecarHealth {
  ok: boolean;
  version: string;
  python: string;
  platform: string;
  /** Hardware accelerator present. */
  device: 'cuda' | 'cpu' | 'mps';
  /** Device faster-whisper actually runs on. */
  whisper_device: 'cuda' | 'cpu';
  compute_type: string;
  device_note: string | null;
  default_model: string;
  model_loaded: boolean;
  loaded_models: string[];
  model_downloaded: boolean;
  face_model_downloaded: boolean;
  versions: Record<string, string | null>;
}

export interface TranscribeRequest {
  audio_path: string;
  model?: string;
  /** ISO language code; omit to auto-detect. */
  language?: string;
  vad_filter?: boolean;
  beam_size?: number;
  initial_prompt?: string;
  condition_on_previous_text?: boolean;
}
export interface TranscribeWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}
export interface TranscribeSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  words: TranscribeWord[];
}
export interface TranscribeResult {
  model: string;
  device: string;
  compute_type: string;
  language: string;
  language_probability: number;
  duration: number;
  duration_after_vad: number;
  elapsed_s: number;
  segments: TranscribeSegment[];
}

export interface ScenesRequest {
  video_path: string;
  detector?: 'content' | 'adaptive';
  threshold?: number;
  min_scene_len_s?: number;
}
export interface ScenesResult {
  duration: number;
  fps: number;
  detector: string;
  /** Seconds at which a new shot starts (excludes 0). */
  cuts: number[];
  scenes: { start: number; end: number }[];
  elapsed_s: number;
}

export interface FacesRequest {
  video_path: string;
  fps?: number;
  start?: number;
  end?: number;
  min_confidence?: number;
  max_frames?: number;
}
export interface FaceBox {
  /** Normalised 0..1 relative to the source frame, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  keypoints: [number, number][];
}
export interface FacesResult {
  width: number;
  height: number;
  source_fps: number;
  sample_fps: number;
  frames_sampled: number;
  frames_with_faces: number;
  frames: { t: number; faces: FaceBox[] }[];
  elapsed_s: number;
}

export class SidecarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Sidecar HTTP ${status}: ${detail}`);
    this.name = 'SidecarHttpError';
  }
}

// ---------------------------------------------------------------------------------------------
// SidecarManager
// ---------------------------------------------------------------------------------------------

export interface SidecarManagerOptions {
  /** Electron `app.getPath('userData')`. */
  userDataDir: string;
  /** Directory containing `clipfern_sidecar/`, `bootstrap/` and `requirements*.txt`. */
  sidecarSrcDir: string;
  getModel: () => string;
  getDevicePref: () => 'auto' | 'gpu' | 'cpu';
  log: (line: string) => void;
  onStatus: (s: SidecarStatus) => void;
  /** Override for tests / Electron `net.fetch`. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Extra environment for every child process (merged over `process.env`). */
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  code: number | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
}

interface InstallState {
  requirementsSha: string;
  cuda: boolean;
  pythonVersion: string;
  selfcheckOk: boolean;
  installedAt: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export class SidecarManager {
  private readonly store: StatusStore;
  private readonly doFetch: typeof fetch;
  private readonly secrets: string[] = [];

  private setupPromise: Promise<void> | null = null;
  private setupAbort: AbortController | null = null;
  private startPromise: Promise<void> | null = null;

  private child: ChildProcess | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private booting = false;
  private stopping = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthySince = 0;
  private lastHealth: SidecarHealth | null = null;

  constructor(private readonly opts: SidecarManagerOptions) {
    this.store = new StatusStore(opts.getModel(), opts.onStatus);
    this.doFetch = opts.fetch ?? fetch;
    this.refreshInstalledFlags();
  }

  // -- paths ------------------------------------------------------------------------------

  private get binDir(): string {
    return path.join(this.opts.userDataDir, 'bin');
  }
  private get venvDir(): string {
    return path.join(this.opts.userDataDir, 'sidecar-venv');
  }
  private get modelsDir(): string {
    return path.join(this.opts.userDataDir, 'models');
  }
  private get venvPython(): string {
    return process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python');
  }
  private get stateFile(): string {
    return path.join(this.venvDir, INSTALL_STATE_FILE);
  }
  private get requirementsFile(): string {
    return path.join(this.opts.sidecarSrcDir, 'requirements.txt');
  }
  private get cudaRequirementsFile(): string {
    return path.join(this.opts.sidecarSrcDir, 'requirements-cuda.txt');
  }

  // -- public API -------------------------------------------------------------------------

  getStatus(): SidecarStatus {
    this.refreshInstalledFlags();
    return this.store.get();
  }

  /** Install everything the sidecar needs. Idempotent: finished phases are skipped. */
  setup(): Promise<void> {
    this.setupPromise ??= this.runSetup().finally(() => {
      this.setupPromise = null;
      this.setupAbort = null;
    });
    return this.setupPromise;
  }

  /** Ensure setup, spawn uvicorn and wait until /health answers. Resolves when ready. */
  start(): Promise<void> {
    this.startPromise ??= this.runStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.setupAbort?.abort();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    try {
      if (child) await this.killChild(child);
    } finally {
      this.child = null;
      this.port = null;
      this.token = null;
      this.lastHealth = null;
      this.stopping = false;
      this.restartCount = 0;
      this.store.set({ phase: 'stopped', progress: null, message: 'Sidecar stopped', port: null });
    }
  }

  health(): Promise<SidecarHealth> {
    return this.request<SidecarHealth>('GET', '/health', undefined, { timeoutMs: 5000 });
  }

  async transcribe(
    req: TranscribeRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TranscribeResult> {
    await this.whenReady();
    return this.request<TranscribeResult>('POST', '/transcribe', req, opts);
  }

  async scenes(req: ScenesRequest, opts: { signal?: AbortSignal } = {}): Promise<ScenesResult> {
    await this.whenReady();
    return this.request<ScenesResult>('POST', '/scenes', req, opts);
  }

  async faces(req: FacesRequest, opts: { signal?: AbortSignal } = {}): Promise<FacesResult> {
    await this.whenReady();
    return this.request<FacesResult>('POST', '/faces', req, opts);
  }

  // -- logging / status helpers -----------------------------------------------------------

  private log(line: string): void {
    const clean = redact(line, this.secrets);
    this.store.pushLog(clean);
    try {
      this.opts.log(clean);
    } catch {
      // a failing logger must never break the pipeline
    }
  }

  private fail(err: unknown, prefix: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`[sidecar] ${prefix}: ${message}`);
    this.store.set({
      phase: 'error',
      progress: null,
      message: `${prefix}: ${message}`,
      error: message,
    });
    return err instanceof Error ? err : new Error(message);
  }

  private refreshInstalledFlags(): void {
    const model = this.opts.getModel();
    this.store.set({
      model,
      installed: this.readInstallState()?.selfcheckOk === true && this.requirementsMatch(),
      modelReady: this.whisperModelReady(model) && this.faceModelReady(),
    });
  }

  private requirementsMatch(): boolean {
    try {
      const state = this.readInstallState();
      if (!state) return false;
      return (
        state.requirementsSha === sha256(readFileSync(this.requirementsFile)) &&
        existsSync(this.venvPython)
      );
    } catch {
      return false;
    }
  }

  private readInstallState(): InstallState | null {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as InstallState;
    } catch {
      return null;
    }
  }

  private whisperModelReady(model: string): boolean {
    const dir = path.join(this.modelsDir, 'whisper', model.replace(/\//g, '__'));
    return existsSync(path.join(dir, COMPLETE_MARKER)) && existsSync(path.join(dir, 'model.bin'));
  }

  private faceModelReady(): boolean {
    const dir = path.join(this.modelsDir, 'mediapipe');
    return (
      existsSync(path.join(dir, FACE_MODEL_FILENAME)) &&
      existsSync(path.join(dir, FACE_MODEL_FILENAME + COMPLETE_MARKER))
    );
  }

  // -- process helpers --------------------------------------------------------------------

  private baseEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.opts.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    };
  }

  private uvEnv(): NodeJS.ProcessEnv {
    return {
      ...this.baseEnv(),
      UV_CACHE_DIR: path.join(this.opts.userDataDir, 'uv', 'cache'),
      UV_PYTHON_INSTALL_DIR: path.join(this.opts.userDataDir, 'uv', 'python'),
      UV_NO_PROGRESS: '1',
      UV_SYSTEM_CERTS: '1',
      NO_COLOR: '1',
    };
  }

  /**
   * Run a command to completion, streaming stdout/stderr lines. Protocol lines (JSON) are
   * handed to `onEvent`; everything else goes to the log.
   */
  private runProcess(
    cmd: string,
    args: string[],
    opts: {
      tag: string;
      env: NodeJS.ProcessEnv;
      cwd?: string;
      onEvent?: (e: SidecarLineEvent) => void;
      onPlainLine?: (line: string) => void;
    },
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const signal = this.setupAbort?.signal;
      if (signal?.aborted) {
        reject(new Error('Setup cancelled'));
        return;
      }
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let lastError: string | null = null;
      let result: Record<string, unknown> | null = null;
      const handleLine = (line: string): void => {
        if (line.trim() === '') return;
        const ev = parseProgressLine(line);
        if (ev) {
          if (ev.kind === 'error') lastError = ev.message;
          if (ev.kind === 'result') result = ev.data;
          if (ev.kind === 'log' || ev.kind === 'error') this.log(`[${opts.tag}] ${ev.message}`);
          opts.onEvent?.(ev);
        } else {
          this.log(`[${opts.tag}] ${line}`);
          opts.onPlainLine?.(line);
        }
      };
      const out = new LineSplitter();
      const err = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => out.push(c).forEach(handleLine));
      child.stderr.on('data', (c: string) => err.push(c).forEach(handleLine));
      const onAbort = (): void => {
        child.kill();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.once('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        out.flush().forEach(handleLine);
        err.flush().forEach(handleLine);
        if (signal?.aborted) reject(new Error('Setup cancelled'));
        else resolve({ code, lastError, result });
      });
    });
  }

  private execOnce(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, windowsHide: true, env: this.baseEnv() },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || error.message}`));
          else resolve(stdout);
        },
      );
    });
  }

  // -- setup ------------------------------------------------------------------------------

  private async runSetup(): Promise<void> {
    this.setupAbort = new AbortController();
    try {
      for (const rel of [
        'requirements.txt',
        'clipfern_sidecar',
        path.join('bootstrap', 'selfcheck.py'),
      ]) {
        if (!existsSync(path.join(this.opts.sidecarSrcDir, rel))) {
          throw new Error(
            `Sidecar sources are incomplete: ${rel} not found in ${this.opts.sidecarSrcDir}`,
          );
        }
      }
      await mkdir(this.opts.userDataDir, { recursive: true });

      // 1. uv
      this.store.set({ phase: 'locating-uv', progress: null, message: 'Looking for uv' });
      let uv = await this.locateUv();
      if (!uv) uv = await this.downloadUv();
      this.log(`[setup] using uv at ${uv}`);

      // 2. venv
      this.store.set({
        phase: 'creating-venv',
        progress: null,
        message: 'Creating Python environment',
      });
      await this.ensureVenv(uv);

      // 3. packages + selfcheck
      this.store.set({
        phase: 'installing-packages',
        progress: null,
        message: 'Installing Python packages',
      });
      await this.ensurePackages(uv);

      // 4. models
      await this.ensureModels();

      this.store.set({
        phase: 'idle',
        progress: null,
        message: 'Sidecar installed and ready to start',
        installed: true,
        modelReady: true,
      });
    } catch (err) {
      throw this.fail(err, 'Sidecar setup failed');
    }
  }

  private async locateUv(): Promise<string | null> {
    const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const candidates: string[] = [];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, exe));
    }
    candidates.push(path.join(this.binDir, exe));
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isFile()) continue;
        const out = await this.execOnce(candidate, ['--version'], 10_000);
        this.log(`[setup] found ${out.trim()} (${candidate})`);
        return candidate;
      } catch {
        // not there / not runnable: try the next candidate
      }
    }
    return null;
  }

  private async downloadUv(): Promise<string> {
    const asset = selectUvAsset(process.platform, process.arch);
    const url = uvDownloadUrl(UV_VERSION, asset);
    this.store.set({
      phase: 'downloading-uv',
      progress: 0,
      message: `Downloading uv ${UV_VERSION}`,
    });
    await mkdir(this.binDir, { recursive: true });
    const work = await mkdtemp(path.join(this.binDir, 'dl-'));
    try {
      const archivePath = path.join(work, asset.fileName);
      await this.downloadFile(url, archivePath, (done, total) => {
        this.store.set({
          progress: total ? done / total : null,
          message: `Downloading uv ${UV_VERSION}${total ? `: ${mb(done)} / ${mb(total)}` : ''}`,
        });
      });

      // Integrity: GitHub publishes `<asset>.sha256` next to every uv release asset.
      const expected = parseSha256File(await this.fetchText(`${url}.sha256`));
      if (!expected) throw new Error('Could not read the uv release checksum');
      const actual = sha256(await readFile(archivePath));
      if (actual !== expected) throw new Error('uv download failed its SHA-256 check');

      this.store.set({ progress: null, message: 'Extracting uv' });
      const extractDir = path.join(work, 'x');
      await mkdir(extractDir);
      await this.extractArchive(archivePath, extractDir, asset);
      const found = await findFile(extractDir, asset.binName);
      if (!found) throw new Error(`${asset.binName} not found in the downloaded archive`);
      const dest = path.join(this.binDir, asset.binName);
      await copyFile(found, dest);
      if (process.platform !== 'win32') await chmod(dest, 0o755);
      const version = (await this.execOnce(dest, ['--version'])).trim();
      this.log(`[setup] installed ${version} to ${dest}`);
      return dest;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async extractArchive(archive: string, dest: string, asset: UvAsset): Promise<void> {
    if (asset.archive === 'zip') {
      const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
      await this.execOnce(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(dest)} -Force`,
        ],
        120_000,
      );
    } else {
      await this.execOnce('tar', ['-xzf', archive, '-C', dest], 120_000);
    }
  }

  private async fetchText(url: string): Promise<string> {
    const res = await this.fetchWithRetry(url);
    return res.text();
  }

  private async fetchWithRetry(url: string, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await this.doFetch(url, {
          redirect: 'follow',
          signal: this.setupAbort?.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        return res;
      } catch (err) {
        lastErr = err;
        if (this.setupAbort?.signal.aborted || i === attempts) break;
        await sleep(500 * i);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async downloadFile(
    url: string,
    dest: string,
    onProgress: (done: number, total: number | null) => void,
  ): Promise<void> {
    const res = await this.fetchWithRetry(url);
    if (!res.body) throw new Error('Empty download response');
    const total = Number(res.headers.get('content-length')) || null;
    const out = createWriteStream(dest);
    let done = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        done += chunk.byteLength;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
        onProgress(done, total);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
  }

  private async ensureVenv(uv: string): Promise<void> {
    if (existsSync(this.venvPython)) {
      this.log('[setup] virtualenv already exists');
      return;
    }
    const args = ['venv', '--python', PYTHON_VERSION, '--color', 'never', this.venvDir];
    if (existsSync(this.venvDir)) args.splice(1, 0, '--clear');
    const res = await this.runProcess(uv, args, {
      tag: 'uv',
      env: this.uvEnv(),
      onPlainLine: (l) => this.store.set({ message: l.slice(0, 200) }),
    });
    if (res.code !== 0 || !existsSync(this.venvPython)) {
      throw new Error(`uv venv failed (exit ${res.code})`);
    }
  }

  private async detectNvidia(): Promise<boolean> {
    if (process.platform !== 'linux' && process.platform !== 'win32') return false;
    try {
      const out = await this.execOnce('nvidia-smi', ['-L'], 8000);
      return /GPU \d+/.test(out);
    } catch {
      return false;
    }
  }

  private async ensurePackages(uv: string): Promise<void> {
    const reqBuf = await readFile(this.requirementsFile);
    const reqSha = sha256(reqBuf);
    const pref = this.opts.getDevicePref();
    const wantCuda = pref !== 'cpu' && (await this.detectNvidia());
    const state = this.readInstallState();

    let needInstall =
      !state || state.requirementsSha !== reqSha || (wantCuda && !state.cuda) || !state.selfcheckOk;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (needInstall) {
        const args = [
          'pip',
          'install',
          '--python',
          this.venvPython,
          '--color',
          'never',
          '-r',
          this.requirementsFile,
        ];
        if (wantCuda) args.push('-r', this.cudaRequirementsFile);
        this.store.set({
          phase: 'installing-packages',
          progress: null,
          message: wantCuda
            ? 'Installing Python packages (with NVIDIA CUDA libraries)'
            : 'Installing Python packages',
        });
        const uvProgress = new UvInstallProgress();
        const res = await this.runProcess(uv, args, {
          tag: 'uv',
          env: this.uvEnv(),
          onPlainLine: (l) => {
            uvProgress.push(l);
            const text = l.trim();
            if (/^(Resolved|Downloading|Downloaded|Prepared|Installed)\b/.test(text)) {
              this.store.set({ progress: uvProgress.fraction(), message: text.slice(0, 200) });
            }
          },
        });
        if (res.code !== 0) throw new Error(`uv pip install failed (exit ${res.code})`);
        await this.writeInstallState({
          requirementsSha: reqSha,
          cuda: wantCuda,
          pythonVersion: PYTHON_VERSION,
          selfcheckOk: false,
          installedAt: new Date().toISOString(),
        });
      } else {
        this.log('[setup] packages already installed; verifying');
      }

      const check = await this.runSelfcheck();
      if (check.ok) {
        const cur = this.readInstallState();
        if (cur) await this.writeInstallState({ ...cur, selfcheckOk: true });
        this.store.set({ installed: true });
        return;
      }
      if (attempt === 2 || needInstall) {
        // A fresh install that still fails is not something a second pass fixes.
        throw new Error(`Python self-check failed: ${check.message}`);
      }
      this.log(`[setup] self-check failed on an existing install (${check.message}); reinstalling`);
      needInstall = true;
    }
  }

  private async runSelfcheck(): Promise<{ ok: boolean; message: string }> {
    this.store.set({
      phase: 'installing-packages',
      progress: 0,
      message: 'Verifying Python packages',
    });
    const res = await this.runProcess(
      this.venvPython,
      [path.join(this.opts.sidecarSrcDir, 'bootstrap', 'selfcheck.py')],
      {
        tag: 'selfcheck',
        env: { ...this.baseEnv(), PYTHONPATH: this.opts.sidecarSrcDir },
        cwd: this.opts.sidecarSrcDir,
        onEvent: (e) => {
          if (e.kind === 'progress') this.store.set({ progress: e.progress, message: e.message });
        },
      },
    );
    if (res.code === 0 && res.result?.ok === true) {
      const versions = res.result.versions as Record<string, string | null> | undefined;
      this.log(`[setup] self-check ok: ${JSON.stringify(versions ?? {})}`);
      return { ok: true, message: 'ok' };
    }
    return { ok: false, message: res.lastError ?? `exit code ${res.code}` };
  }

  private async writeInstallState(state: InstallState): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  private async ensureModels(): Promise<void> {
    const model = this.opts.getModel();
    this.store.set({
      phase: 'downloading-model',
      progress: 0,
      message: `Preparing speech model '${model}'`,
      model,
    });
    await mkdir(this.modelsDir, { recursive: true });
    const env = { ...this.baseEnv(), PYTHONPATH: this.opts.sidecarSrcDir };
    const scripts: { file: string; args: string[]; from: number; to: number; what: string }[] = [
      {
        file: 'download_model.py',
        args: [model, '--models-dir', this.modelsDir],
        from: 0,
        to: 0.98,
        what: `speech model '${model}'`,
      },
      {
        file: 'download_face_model.py',
        args: ['--models-dir', this.modelsDir],
        from: 0.98,
        to: 1,
        what: 'face detector',
      },
    ];
    for (const s of scripts) {
      const res = await this.runProcess(
        this.venvPython,
        [path.join(this.opts.sidecarSrcDir, 'bootstrap', s.file), ...s.args],
        {
          tag: 'models',
          env,
          cwd: this.opts.sidecarSrcDir,
          onEvent: (e) => {
            if (e.kind !== 'progress') return;
            const p = e.progress === null ? null : s.from + e.progress * (s.to - s.from);
            this.store.set({ phase: 'downloading-model', progress: p, message: e.message });
          },
        },
      );
      if (res.code !== 0) {
        throw new Error(`Downloading ${s.what} failed: ${res.lastError ?? `exit ${res.code}`}`);
      }
    }
    this.store.set({ modelReady: true });
  }

  // -- start / stop -----------------------------------------------------------------------

  private async runStart(): Promise<void> {
    if (this.child && this.store.get().phase === 'ready') return;
    this.stopping = false;
    this.refreshInstalledFlags();
    const s = this.store.get();
    if (!s.installed || !s.modelReady) await this.setup();
    this.restartCount = 0;
    try {
      await this.launch();
    } catch (err) {
      await this.killChild(this.child).catch(() => undefined);
      throw this.fail(err, 'Sidecar failed to start');
    }
  }

  /** Spawn uvicorn and resolve once /health answers. */
  private async launch(): Promise<void> {
    this.booting = true;
    try {
      const token = randomBytes(24).toString('hex');
      this.secrets.push(token);
      const port = await findFreePort();
      this.token = token;
      this.port = port;
      this.store.set({
        phase: 'starting',
        progress: null,
        message: 'Starting sidecar',
        port: null,
      });

      const child = spawn(
        this.venvPython,
        ['-m', 'clipfern_sidecar', '--port', String(port), '--exit-on-stdin-eof'],
        {
          cwd: this.opts.sidecarSrcDir,
          env: {
            ...this.baseEnv(),
            PYTHONPATH: this.opts.sidecarSrcDir,
            SIDECAR_TOKEN: token,
            CLIPFERN_MODELS_DIR: this.modelsDir,
            CLIPFERN_WHISPER_MODEL: this.opts.getModel(),
            CLIPFERN_DEVICE: this.opts.getDevicePref(),
          },
          // stdin stays open: when this process dies the pipe closes and the sidecar exits.
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      this.child = child;
      const pump = (stream: NodeJS.ReadableStream | null): void => {
        if (!stream) return;
        const split = new LineSplitter();
        stream.setEncoding('utf8');
        stream.on('data', (c: string) =>
          split.push(c).forEach((l) => l.trim() && this.log(`[sidecar] ${l}`)),
        );
        stream.on('end', () =>
          split.flush().forEach((l) => l.trim() && this.log(`[sidecar] ${l}`)),
        );
      };
      pump(child.stdout);
      pump(child.stderr);
      child.stdin?.on('error', () => undefined);
      child.once('error', (e) => this.log(`[sidecar] spawn error: ${e.message}`));
      child.once('exit', (code, sig) => this.onChildExit(child, code, sig));

      const health = await this.waitHealthy(child);
      this.lastHealth = health;
      this.healthySince = Date.now();
      this.store.set({
        phase: 'ready',
        progress: null,
        message: `Sidecar ready (${health.whisper_device}, ${health.compute_type})`,
        device: health.device,
        port,
        error: null,
      });
      this.log(
        `[sidecar] ready on 127.0.0.1:${port} device=${health.device} whisper=${health.whisper_device}/${health.compute_type}`,
      );
    } finally {
      this.booting = false;
    }
  }

  private async waitHealthy(child: ChildProcess): Promise<SidecarHealth> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Sidecar exited during start-up (code ${child.exitCode ?? child.signalCode}). ` +
            'See the log for details.',
        );
      }
      try {
        return await this.health();
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await sleep(250);
    }
    throw new Error(
      `Sidecar did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s: ${lastErr}`,
    );
  }

  private onChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.child) return;
    this.child = null;
    this.port = null;
    this.lastHealth = null;
    this.log(`[sidecar] process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    if (this.stopping || this.booting) return; // stop() / launch() own the follow-up
    const uptime = this.healthySince ? Date.now() - this.healthySince : 0;
    if (uptime >= STABLE_UPTIME_MS) this.restartCount = 0;
    this.scheduleRestart(`exited unexpectedly (code ${code ?? signal ?? 'unknown'})`);
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping) return;
    this.restartCount += 1;
    if (this.restartCount > MAX_RESTARTS) {
      this.fail(
        new Error(`Sidecar ${reason}; giving up after ${MAX_RESTARTS} restarts`),
        'Sidecar crashed',
      );
      return;
    }
    const delay = backoffMs(this.restartCount);
    this.store.set({
      phase: 'starting',
      progress: null,
      message: `Sidecar ${reason}; restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartCount}/${MAX_RESTARTS})`,
      port: null,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.launch().catch((err: unknown) => {
        void this.killChild(this.child).catch(() => undefined);
        this.scheduleRestart(
          `failed to restart (${err instanceof Error ? err.message : String(err)})`,
        );
      });
    }, delay);
  }

  private killChild(child: ChildProcess | null): Promise<void> {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin?.end(); // sidecar's stdin watchdog exits cleanly...
      child.kill('SIGTERM'); // ...and SIGTERM covers a wedged interpreter (TerminateProcess on Windows)
    });
  }

  // -- HTTP client ------------------------------------------------------------------------

  private async whenReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const phase: SidecarPhase = this.store.get().phase;
      if (phase === 'ready' && this.port !== null) return;
      if (phase === 'error')
        throw new Error(this.store.get().error ?? 'Sidecar is in an error state');
      if (phase !== 'starting' || Date.now() > deadline) {
        throw new Error('Sidecar is not running. Start it first.');
      }
      await sleep(200);
    }
  }

  private request<T>(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const port = this.port;
    const token = this.token;
    if (port === null || token === null) {
      return Promise.reject(new Error('Sidecar is not running'));
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method,
          // No socket timeout by default: a CPU transcription of an hour of audio is slow.
          timeout: opts.timeoutMs,
          signal: opts.signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.byteLength }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            let json: unknown;
            try {
              json = text ? JSON.parse(text) : undefined;
            } catch {
              json = undefined;
            }
            if (status >= 200 && status < 300) {
              resolve(json as T);
              return;
            }
            reject(
              new SidecarHttpError(
                status,
                extractDetail(json) ?? (text.slice(0, 300) || 'no body'),
              ),
            );
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Sidecar request timed out: ${urlPath}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

function extractDetail(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const detail = (json as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (detail !== undefined) return JSON.stringify(detail).slice(0, 500);
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    }
  }
  return null;
}
