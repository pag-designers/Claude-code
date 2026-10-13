import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ToolStatus } from '@shared/domain';

/** Packaged apps run inside app.asar; binaries are unpacked next to it (see electron-builder asarUnpack). */
export function unpackedPath(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function run(
  file: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function ytdlpAssetName(platform = process.platform, arch = process.arch): string {
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export class BinaryService {
  private readonly binDir: string;

  constructor(
    userDataDir: string,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.binDir = path.join(userDataDir, 'bin');
  }

  get ytdlpPath(): string {
    return path.join(this.binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  }

  ffmpegPath(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = require('ffmpeg-static') as string | null;
      return p ? unpackedPath(p) : null;
    } catch {
      return null;
    }
  }

  ffprobePath(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = (require('ffprobe-static') as { path: string }).path;
      return p ? unpackedPath(p) : null;
    } catch {
      return null;
    }
  }

  async checkFfmpeg(): Promise<ToolStatus> {
    const p = this.ffmpegPath();
    if (!p || !fs.existsSync(p)) return fail('ffmpeg', 'Bundled ffmpeg binary not found');
    try {
      const { stdout } = await run(p, ['-version']);
      const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? null;
      return { name: 'ffmpeg', ok: true, version, path: p, error: null, source: 'bundled' };
    } catch (e) {
      return fail('ffmpeg', errMsg(e), p);
    }
  }

  async checkFfprobe(): Promise<ToolStatus> {
    const p = this.ffprobePath();
    if (!p || !fs.existsSync(p)) return fail('ffprobe', 'Bundled ffprobe binary not found');
    try {
      const { stdout } = await run(p, ['-version']);
      const version = /ffprobe version (\S+)/.exec(stdout)?.[1] ?? null;
      return { name: 'ffprobe', ok: true, version, path: p, error: null, source: 'bundled' };
    } catch (e) {
      return fail('ffprobe', errMsg(e), p);
    }
  }

  async checkYtdlp(): Promise<ToolStatus> {
    const p = this.ytdlpPath;
    if (!fs.existsSync(p)) return fail('yt-dlp', 'Not downloaded yet', null, 'downloaded');
    try {
      const { stdout } = await run(p, ['--version']);
      return {
        name: 'yt-dlp',
        ok: true,
        version: stdout.trim(),
        path: p,
        error: null,
        source: 'downloaded',
      };
    } catch (e) {
      return fail('yt-dlp', errMsg(e), p, 'downloaded');
    }
  }

  async checkUv(): Promise<ToolStatus> {
    const candidates = [
      path.join(this.binDir, process.platform === 'win32' ? 'uv.exe' : 'uv'),
      'uv',
    ];
    for (const c of candidates) {
      try {
        const { stdout } = await run(c, ['--version']);
        return {
          name: 'uv',
          ok: true,
          version: stdout.trim().replace(/^uv\s+/, ''),
          path: c,
          error: null,
          source: c === 'uv' ? 'system' : 'downloaded',
        };
      } catch {
        // try next
      }
    }
    return fail(
      'uv',
      'Not installed yet — it is downloaded when the transcription engine is set up',
      null,
      'downloaded',
    );
  }

  async status(): Promise<ToolStatus[]> {
    return Promise.all([
      this.checkFfmpeg(),
      this.checkFfprobe(),
      this.checkYtdlp(),
      this.checkUv(),
    ]);
  }

  /** Downloads the latest yt-dlp release binary (or self-updates an existing one). */
  async updateYtdlp(): Promise<ToolStatus> {
    fs.mkdirSync(this.binDir, { recursive: true });
    const target = this.ytdlpPath;
    if (fs.existsSync(target)) {
      try {
        const { stdout, stderr } = await run(target, ['-U'], 120_000);
        this.log(`yt-dlp -U: ${(stdout + stderr).trim().slice(0, 300)}`);
        const st = await this.checkYtdlp();
        if (st.ok) return st;
      } catch (e) {
        this.log(`yt-dlp -U failed (${errMsg(e)}); re-downloading`);
      }
    }
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAssetName()}`;
    this.log(`downloading yt-dlp from ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
    const tmp = `${target}.download`;
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp, { mode: 0o755 }));
    fs.renameSync(tmp, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    return this.checkYtdlp();
  }

  /** First-run helper: make sure yt-dlp exists. Never throws. */
  async ensureYtdlp(): Promise<ToolStatus> {
    const st = await this.checkYtdlp();
    if (st.ok) return st;
    try {
      return await this.updateYtdlp();
    } catch (e) {
      this.log(`ensureYtdlp failed: ${errMsg(e)}`);
      return fail('yt-dlp', `Could not download yt-dlp: ${errMsg(e)}`, null, 'downloaded');
    }
  }

  /** Lists ffmpeg encoders available in the bundled build (hardware paths are verified in CP1 renders). */
  async listEncoders(): Promise<string[]> {
    const p = this.ffmpegPath();
    if (!p) return [];
    try {
      const { stdout } = await run(p, ['-hide_banner', '-encoders']);
      const wanted = [
        'h264_nvenc',
        'hevc_nvenc',
        'h264_videotoolbox',
        'hevc_videotoolbox',
        'h264_qsv',
        'h264_amf',
        'libx264',
      ];
      return wanted.filter((w) => new RegExp(`\\b${w}\\b`).test(stdout));
    } catch {
      return [];
    }
  }
}

function fail(
  name: string,
  error: string,
  p: string | null = null,
  source: string | null = 'bundled',
): ToolStatus {
  return { name, ok: false, version: null, path: p, error, source };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
