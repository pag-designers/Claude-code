import fs from 'node:fs';
import path from 'node:path';
import type { UrlInfo } from '@shared/pipeline';
import { IngestError, type IngestService, type OnProgress } from '../../pipeline/contracts';
import { AbortError, LineBuffer, runProcess } from './proc';

/**
 * yt-dlp wrapper (BRIEF §4.1). Everything that can be decided without a process is a pure, exported
 * function (argument building, progress parsing, error classification, info mapping) so it can be
 * unit-tested against recorded yt-dlp output.
 *
 * Failure model (verified against real YouTube from a datacenter IP): YouTube intermittently answers
 * "Sign in to confirm you're not a bot". We therefore run a client chain
 *   1. yt-dlp defaults,
 *   2. `player_client=android_vr` (format `18/b`: 360p progressive - quality is limited, and the progress
 *      message says so),
 * and only then throw `IngestError('bot-check')` with an actionable message. Transient network errors are
 * retried 3x with backoff inside every step of the chain.
 */

export interface JsRuntime {
  /** Absolute path of a Node-compatible binary (or deno/bun/quickjs). */
  path: string;
  /** yt-dlp runtime id. Default 'node'. */
  name?: 'node' | 'deno' | 'bun' | 'quickjs';
  /** Set when `path` is the Electron executable: it only behaves like node with ELECTRON_RUN_AS_NODE=1. */
  electronAsNode?: boolean;
}

export interface IngestDeps {
  ytdlpPath: () => string;
  ffmpegPath: () => string;
  log: (m: string) => void;
  /**
   * yt-dlp needs a JavaScript runtime to solve YouTube's player challenges (it only auto-detects deno).
   * Without one it still works through some clients but formats may be missing. Optional.
   */
  jsRuntime?: () => JsRuntime | null;
  /** Backoff between network retries. Default [1500, 4000, 9000] (3 retries). Tests pass [0,0,0]. */
  retryDelaysMs?: number[];
  /** Test seam: replaces the real process runner. */
  run?: RunYtdlp;
}

/** Error carrying whatever metadata could still be read when downloads are blocked by the bot check. */
export class BotCheckIngestError extends IngestError {
  constructor(
    message: string,
    public readonly partialInfo: UrlInfo | null,
  ) {
    super(message, 'bot-check');
    this.name = 'BotCheckIngestError';
  }
}

export interface RunYtdlpResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface RunYtdlpOpts {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  /** Keep stdout in the result (probe needs the JSON). */
  captureStdout?: boolean;
  /** Overall wall-clock limit; hitting it is reported as a network error. */
  timeoutMs?: number;
}
export type RunYtdlp = (
  ytdlp: string,
  args: string[],
  opts: RunYtdlpOpts,
) => Promise<RunYtdlpResult>;

/* ------------------------------------------------ constants ------------------------------------------------ */

export const BOT_CHECK_MESSAGE =
  "YouTube asked to verify you're not a bot. In Settings → Ingest choose 'Cookies from browser' and sign in to YouTube in that browser, then retry.";
export const BOT_CHECK_WITH_COOKIES_MESSAGE =
  "YouTube still asked to verify you're not a bot even with your browser's cookies. Open youtube.com in that browser, make sure you are signed in (solve any prompt it shows), then retry.";
export const LIVE_MESSAGE =
  "This is a live stream or a premiere that hasn't started. Live clipping arrives in a later version - paste the link again once the stream has ended.";
export const LIMITED_QUALITY_NOTE =
  'Reduced quality (360p): YouTube is restricting this connection';
const PROBE_TIMEOUT_MS = 90_000;
const ALLOWED_BROWSERS = new Set([
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
]);

/* --------------------------------------------- client chain ------------------------------------------------ */

export interface Attempt {
  id: 'default' | 'android_vr';
  extractorArgs: string | null;
  /** Overrides the format selection (limited-quality fallback). */
  format: string | null;
  limited: boolean;
}

export const ATTEMPTS: readonly Attempt[] = [
  { id: 'default', extractorArgs: null, format: null, limited: false },
  {
    id: 'android_vr',
    extractorArgs: 'youtube:player_client=android_vr',
    format: '18/b',
    limited: true,
  },
];

/* --------------------------------------------- argument building ------------------------------------------- */

/** `--cookies-from-browser` value, validated so it can never be parsed as another option. */
export function normalizeBrowser(value: string | undefined | null): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  // BROWSER[+KEYRING][:PROFILE][::CONTAINER]
  const m = /^([a-z]+)(\+[a-z0-9]+)?(:[^\s:][^:]*)?(::[^\s:][^:]*)?$/i.exec(v);
  if (!m?.[1] || !ALLOWED_BROWSERS.has(m[1].toLowerCase())) {
    throw new IngestError(
      `Unsupported browser "${v.slice(0, 40)}" for cookies. Use one of: ${[...ALLOWED_BROWSERS].join(', ')}.`,
      'other',
    );
  }
  return `${m[1].toLowerCase()}${m[2] ?? ''}${m[3] ?? ''}${m[4] ?? ''}`;
}

export function assertHttpUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new IngestError(
      "That doesn't look like a video link. Paste a full https:// URL.",
      'unavailable',
    );
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new IngestError('Only http(s) video links are supported.', 'unavailable');
  }
  return u.toString();
}

interface CommonArgOpts {
  cookiesFromBrowser?: string | null;
  extractorArgs?: string | null;
  jsRuntime?: JsRuntime | null;
}

function commonArgs(o: CommonArgOpts): string[] {
  const a = [
    '--ignore-config',
    '--no-warnings',
    '--no-color',
    '--no-playlist',
    '--socket-timeout',
    '30',
    '--retries',
    '3',
    '--extractor-retries',
    '2',
  ];
  if (o.extractorArgs) a.push('--extractor-args', o.extractorArgs);
  const browser = normalizeBrowser(o.cookiesFromBrowser);
  if (browser) a.push(`--cookies-from-browser=${browser}`);
  if (o.jsRuntime) a.push('--js-runtimes', `${o.jsRuntime.name ?? 'node'}:${o.jsRuntime.path}`);
  return a;
}

export function buildProbeArgs(
  url: string,
  o: CommonArgOpts & { metadataOnly?: boolean },
): string[] {
  const a = [...commonArgs(o), '--dump-single-json', '--skip-download'];
  // Last-resort mode when every client is bot-checked: return the metadata YouTube still serves
  // (title, channel, thumbnail, description, license) with an empty format list.
  if (o.metadataOnly) a.push('--ignore-no-formats-error');
  a.push('--', url);
  return a;
}

/** Format selection: best streams, preferring H.264/AAC at or below `maxResolution` (short side). */
export function formatArgs(maxResolution: number, attempt: Attempt): string[] {
  if (attempt.format) return ['-f', attempt.format];
  return [
    '-f',
    'bv*+ba/b',
    // `res:N` ranks formats above N lower; using the sort (not a [height<=N] filter) also keeps
    // portrait videos (height > width) working.
    '-S',
    `res:${Math.round(maxResolution)},vcodec:h264,fps,acodec:aac`,
  ];
}

export const PROGRESS_PREFIX = 'CFP|';
export const POSTPROC_PREFIX = 'CFPP|';
export const FILE_PREFIX = 'CFPF|';

export const PLAN_PREFIX = 'CFPI|';

const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s';
/**
 * Printed once, before the first byte: which streams were selected and how big they announce to be.
 * (`info.requested_formats` is NOT visible from the progress template, only from `before_dl` prints.)
 */
const PLAN_TEMPLATE =
  `before_dl:${PLAN_PREFIX}%(requested_formats.0.format_id)s|%(requested_formats.1.format_id)s|` +
  '%(requested_formats.0.filesize,requested_formats.0.filesize_approx)s|' +
  '%(requested_formats.1.filesize,requested_formats.1.filesize_approx)s';
const POSTPROC_TEMPLATE = `postprocess:${POSTPROC_PREFIX}%(progress.status)s|%(progress.postprocessor)s`;

export function buildDownloadArgs(
  url: string,
  outDir: string,
  o: CommonArgOpts & { maxResolution: number; attempt: Attempt; ffmpegPath: string },
): string[] {
  return [
    ...commonArgs({ ...o, extractorArgs: o.attempt.extractorArgs ?? o.extractorArgs }),
    ...formatArgs(o.maxResolution, o.attempt),
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    o.ffmpegPath,
    '--continue',
    '--no-mtime',
    '--no-overwrites',
    '--concurrent-fragments',
    '4',
    '--throttled-rate',
    '100K',
    // Live streams would record forever; they are rejected up front.
    '--match-filter',
    '!is_live',
    '-o',
    path.join(outDir, '%(id)s.%(ext)s').replace(/%(?!\()/g, '%%'),
    '--no-simulate',
    '--progress',
    '--newline',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--progress-template',
    POSTPROC_TEMPLATE,
    '--print',
    PLAN_TEMPLATE,
    '--print',
    `after_move:${FILE_PREFIX}%(filepath)s`,
    '--',
    url,
  ];
}

/* -------------------------------------------------- info mapping ---------------------------------------- */

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** yt-dlp `upload_date` "20240131" -> "2024-01-31". */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^(\d{4})(\d{2})(\d{2})$/.exec(s) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function mapInfo(raw: unknown): UrlInfo {
  if (!raw || typeof raw !== 'object') {
    throw new IngestError('yt-dlp returned no video information.', 'other');
  }
  const j = raw as Json;
  if (j._type === 'playlist') {
    throw new IngestError(
      'That link is a playlist or channel. Paste the link of a single video.',
      'unavailable',
    );
  }
  const id = str(j.id);
  if (!id) throw new IngestError('yt-dlp returned no video id.', 'other');
  const status = str(j.live_status);
  const isLive = j.is_live === true || status === 'is_live' || status === 'is_upcoming';

  let thumbnail = str(j.thumbnail);
  if (!thumbnail && Array.isArray(j.thumbnails)) {
    const last = [...(j.thumbnails as Json[])].reverse().find((t) => str(t?.url));
    thumbnail = last ? str(last.url) : null;
  }

  const chapters: UrlInfo['chapters'] = [];
  if (Array.isArray(j.chapters)) {
    for (const c of j.chapters as Json[]) {
      const start = num(c?.start_time);
      const end = num(c?.end_time);
      const title = str(c?.title);
      if (start !== null && end !== null && end > start) {
        chapters.push({ title: title ?? `Chapter ${chapters.length + 1}`, start, end });
      }
    }
  }

  return {
    id,
    title: str(j.title) ?? str(j.fulltitle) ?? `Video ${id}`,
    channel: str(j.channel) ?? str(j.uploader) ?? null,
    durationSec: num(j.duration),
    thumbnail,
    description: str(j.description),
    isLive,
    chapters,
    uploadDate: isoDate(j.upload_date) ?? isoDate(j.release_date),
    license: str(j.license),
  };
}

/* ------------------------------------------------- progress ------------------------------------------------ */

export interface DownloadProgressRecord {
  status: string;
  downloaded: number | null;
  total: number | null;
  totalEstimate: number | null;
  speed: number | null;
  eta: number | null;
  /** format_id of the stream this record belongs to. */
  formatId: string | null;
}

/** Selected streams (video first, then audio) announced before the download starts. */
export interface DownloadPlan {
  format0: string | null;
  format1: string | null;
  size0: number | null;
  size1: number | null;
}

const tok = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' || t === 'NA' || t === 'None' || t === 'N/A' ? null : t;
};
const ntok = (v: string | undefined): number | null => {
  const t = tok(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export type ParsedLine =
  | { kind: 'progress'; rec: DownloadProgressRecord }
  | { kind: 'plan'; plan: DownloadPlan }
  | { kind: 'postprocess'; status: string; name: string | null }
  | { kind: 'file'; path: string }
  | null;

export function parseYtdlpLine(line: string): ParsedLine {
  if (line.startsWith(PROGRESS_PREFIX)) {
    const p = line.slice(PROGRESS_PREFIX.length).split('|');
    if (p.length < 7) return null;
    return {
      kind: 'progress',
      rec: {
        status: tok(p[0]) ?? 'downloading',
        downloaded: ntok(p[1]),
        total: ntok(p[2]),
        totalEstimate: ntok(p[3]),
        speed: ntok(p[4]),
        eta: ntok(p[5]),
        formatId: tok(p[6]),
      },
    };
  }
  if (line.startsWith(PLAN_PREFIX)) {
    const p = line.slice(PLAN_PREFIX.length).split('|');
    return {
      kind: 'plan',
      plan: { format0: tok(p[0]), format1: tok(p[1]), size0: ntok(p[2]), size1: ntok(p[3]) },
    };
  }
  if (line.startsWith(POSTPROC_PREFIX)) {
    const p = line.slice(POSTPROC_PREFIX.length).split('|');
    return { kind: 'postprocess', status: tok(p[0]) ?? '', name: tok(p[1]) };
  }
  if (line.startsWith(FILE_PREFIX)) {
    const f = line.slice(FILE_PREFIX.length).trim();
    return f ? { kind: 'file', path: f } : null;
  }
  return null;
}

export function formatSpeed(bytesPerSec: number): string {
  const mib = bytesPerSec / 1_048_576;
  if (mib >= 1) return `${mib.toFixed(1)} MiB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KiB/s`;
}

export function formatEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Folds yt-dlp's per-stream progress (video first, then audio) into one monotonic 0..1 fraction.
 * Weights come from the formats' announced sizes (`setPlan`); when unknown video counts 90 % and audio
 * 10 %. Speed/ETA are for the whole job: ETA = remaining bytes / current speed, with the remaining
 * bytes extrapolated from the bytes done so far (yt-dlp reports no ETA at all for fragmented streams).
 */
export class ProgressAggregator {
  private best = 0;
  private plan: DownloadPlan = { format0: null, format1: null, size0: null, size1: null };
  private finishedBytes = 0;
  private currentStream = 0;
  private lastDownloaded = 0;

  constructor(private readonly prefix = '') {}

  setPlan(plan: DownloadPlan): void {
    this.plan = plan;
  }

  update(rec: DownloadProgressRecord): { fraction: number; message: string } {
    const { format1, size0, size1 } = this.plan;
    const twoStreams = format1 !== null;
    const idx = twoStreams && rec.formatId !== null && rec.formatId === format1 ? 1 : 0;
    if (idx !== this.currentStream) {
      this.finishedBytes += this.lastDownloaded;
      this.currentStream = idx;
    }
    this.lastDownloaded = rec.downloaded ?? this.lastDownloaded;

    const total = rec.total ?? rec.totalEstimate;
    let own = 0;
    if (rec.status === 'finished') own = 1;
    else if (total && total > 0 && rec.downloaded !== null)
      own = Math.min(1, rec.downloaded / total);

    let w0 = 1;
    if (twoStreams) w0 = size0 && size1 && size0 > 0 && size1 > 0 ? size0 / (size0 + size1) : 0.9;
    const raw = idx === 0 ? w0 * own : w0 + (1 - w0) * own;
    // Never go backwards (estimates grow), and leave headroom for merging.
    this.best = Math.max(this.best, Math.min(0.985, raw));

    const parts: string[] = [];
    if (rec.speed !== null && rec.speed > 0) parts.push(formatSpeed(rec.speed));
    const doneBytes = this.finishedBytes + this.lastDownloaded;
    let etaSec: number | null = null;
    if (rec.eta !== null && (!twoStreams || idx === 1)) {
      etaSec = rec.eta; // yt-dlp's own estimate is smoother when it covers the whole job
    } else if (rec.speed && rec.speed > 0 && this.best > 0.01 && doneBytes > 0) {
      etaSec = ((doneBytes / this.best) * (1 - this.best)) / rec.speed;
    }
    if (etaSec !== null && Number.isFinite(etaSec)) parts.push(`${formatEta(etaSec)} left`);
    const message = parts.length ? parts.join(' · ') : 'Downloading';
    return { fraction: this.best, message: this.prefix ? `${this.prefix} · ${message}` : message };
  }
}

/* ------------------------------------------------ error classification ------------------------------------ */

// eslint-disable-next-line no-control-regex -- stripping ANSI colour escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;

/** First `ERROR:` line of yt-dlp output, cleaned for display. Never returns stack traces. */
export function extractErrorLine(stderr: string): string | null {
  const lines = stderr.replace(ANSI, '').split(/\r?\n/);
  const err = [...lines].reverse().find((l) => /^ERROR:/.test(l.trim()));
  if (!err) return null;
  return err
    .trim()
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[\w:-]+\]\s+[^\s:]+:\s+/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim()
    .slice(0, 300);
}

export interface Classified {
  kind: IngestError['kind'];
  message: string;
}

export function classifyYtdlpError(stderr: string, ctx: { cookies?: boolean } = {}): Classified {
  const text = stderr.replace(ANSI, '');
  const err = extractErrorLine(text);
  const hay = `${err ?? ''}\n${text}`;
  const has = (re: RegExp): boolean => re.test(hay);

  if (has(/confirm you.?re not a bot|not a bot/i)) {
    return {
      kind: 'bot-check',
      message: ctx.cookies ? BOT_CHECK_WITH_COOKIES_MESSAGE : BOT_CHECK_MESSAGE,
    };
  }
  if (has(/confirm your age|age[- ]restricted|inappropriate for some users|age verification/i)) {
    return {
      kind: 'age-restricted',
      message:
        "This video is age-restricted. In Settings → Ingest choose 'Cookies from browser' (signed in to a YouTube account that may watch it), then retry.",
    };
  }
  if (
    has(
      /private video|this video is private|members-only|join this channel|sign in if you.?ve been granted access/i,
    )
  ) {
    return {
      kind: 'private',
      message:
        "This video is private or members-only, so it can't be downloaded. If your account has access, choose 'Cookies from browser' in Settings → Ingest and sign in to YouTube in that browser.",
    };
  }
  if (
    has(
      /live event will begin|premieres in|this live event|is upcoming|will begin in|is_live|currently live/i,
    )
  ) {
    return {
      kind: 'live',
      message: LIVE_MESSAGE,
    };
  }
  const cookieDb =
    /could not find (\w+) cookies database|failed to decrypt|could not copy .*cookie|cookies? database is locked/i.exec(
      hay,
    );
  if (cookieDb) {
    return {
      kind: 'other',
      message:
        "Couldn't read cookies from your browser. Make sure the browser chosen in Settings → Ingest is installed and has been opened at least once (close Chrome/Edge completely if it is running), or pick another browser.",
    };
  }
  if (has(/no space left on device|disk quota exceeded/i)) {
    return {
      kind: 'other',
      message: 'There is not enough free disk space to download this video.',
    };
  }
  if (
    has(
      /n challenge|nsig extraction|only images are available|no supported javascript runtime|signature solving failed/i,
    )
  ) {
    return {
      kind: 'other',
      message:
        "yt-dlp could not solve YouTube's player challenge. Update yt-dlp (Settings → Diagnostics) and make sure a JavaScript runtime is available, then retry.",
    };
  }
  if (
    has(
      /video unavailable|this video is (?:not available|unavailable|no longer available)|has been removed|account associated with this video has been terminated|not available in your country|blocked it in your country|blocked .* on copyright|unsupported url|is not a valid url|incomplete youtube id|http error 404|does not exist|copyright claim/i,
    )
  ) {
    return {
      kind: 'unavailable',
      message:
        'This video is unavailable (removed, blocked in your region, or the link is wrong). Check the link and try again.',
    };
  }
  if (
    has(
      /timed out|timeout|connection (?:reset|refused|aborted|error)|temporary failure in name resolution|name or service not known|network is unreachable|getaddrinfo failed|nodename nor servname|unable to download (?:webpage|video data|json|api|m3u8|mpd)|urlopen error|ssl(?:error)?:|eof occurred|remotedisconnected|incompleteread|transporterror|http error 5\d\d|http error 429|too many requests|failed to resolve|read error|unable to connect|proxyerror/i,
    )
  ) {
    return {
      kind: 'network',
      message: `Network problem while contacting the video site${err ? ` (${err.slice(0, 120)})` : ''}. Check your connection and retry.`,
    };
  }
  if (/traceback \(most recent call last\)/i.test(text)) {
    return {
      kind: 'other',
      message: 'yt-dlp crashed unexpectedly. Update yt-dlp (Settings → Diagnostics) and retry.',
    };
  }
  if (has(/ffmpeg|ffprobe/i) && has(/not found|no such file|not installed/i)) {
    return {
      kind: 'other',
      message: 'ffmpeg could not be started, so the video could not be merged. Reinstall Clipfern.',
    };
  }
  if (err) return { kind: 'other', message: `yt-dlp could not download this video: ${err}` };
  const lastLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[debug]'))
    .pop();
  return {
    kind: 'other',
    message: `yt-dlp failed${lastLine ? `: ${lastLine.slice(0, 200)}` : ' without an error message'}.`,
  };
}

/* ------------------------------------------------- default runner ------------------------------------------ */

export const runYtdlpProcess: RunYtdlp = async (ytdlp, args, opts) => {
  const stdoutParts: string[] = [];
  let stdoutBytes = 0;
  const stderrParts: string[] = [];
  const lines = new LineBuffer((l) => {
    if (l) opts.onStdoutLine?.(l);
  });
  const timeout = opts.timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = timeout
    ? setTimeout(() => {
        timedOut = true;
        timeout.abort();
      }, opts.timeoutMs)
    : null;
  const onParentAbort = (): void => timeout?.abort();
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  const signal = timeout ? timeout.signal : opts.signal;
  try {
    const res = await runProcess(ytdlp, args, {
      signal,
      env: opts.env,
      onStdout: (c) => {
        if (opts.captureStdout) {
          stdoutBytes += c.length;
          if (stdoutBytes <= 64 * 1024 * 1024) stdoutParts.push(c.toString('utf8'));
        }
        if (opts.onStdoutLine) lines.push(c);
      },
      onStderr: (c) => {
        if (stderrParts.length < 2000) stderrParts.push(c.toString('utf8'));
      },
    });
    lines.flush();
    return { code: res.code, stdout: stdoutParts.join(''), stderr: stderrParts.join('') };
  } catch (e) {
    if (timedOut && !opts.signal?.aborted) {
      return { code: null, stdout: '', stderr: 'ERROR: timed out waiting for yt-dlp to respond' };
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
};

/* ---------------------------------------------------- service ---------------------------------------------- */

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortError());
      },
      { once: true },
    );
  });

export function createIngestService(deps: IngestDeps): IngestService {
  const run = deps.run ?? runYtdlpProcess;
  const delays = deps.retryDelaysMs ?? [1500, 4000, 9000];

  const envFor = (): NodeJS.ProcessEnv => {
    const js = deps.jsRuntime?.() ?? null;
    return {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      ...(js?.electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
  };

  /** Runs `fn`, retrying transient network failures up to delays.length times. */
  async function withNetworkRetry<T>(
    label: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const retriable = e instanceof IngestError && e.kind === 'network';
        if (!retriable || attempt >= delays.length) throw e;
        deps.log(`[ingest] ${label}: network error, retry ${attempt + 1}/${delays.length}`);
        await defaultSleep(delays[attempt] ?? 0, signal);
      }
    }
  }

  /** Walks the client chain; moves on only for bot-check. */
  async function throughChain<T>(
    label: string,
    cookies: boolean,
    signal: AbortSignal | undefined,
    step: (attempt: Attempt, index: number) => Promise<T>,
  ): Promise<T> {
    let last: IngestError | null = null;
    for (let i = 0; i < ATTEMPTS.length; i++) {
      const attempt = ATTEMPTS[i];
      if (!attempt) continue;
      try {
        return await withNetworkRetry(`${label}/${attempt.id}`, signal, () => step(attempt, i));
      } catch (e) {
        if (e instanceof IngestError && e.kind === 'bot-check') {
          last = e;
          deps.log(`[ingest] ${label}: bot check with client "${attempt.id}"`);
          continue;
        }
        throw e;
      }
    }
    throw (
      last ??
      new IngestError(cookies ? BOT_CHECK_WITH_COOKIES_MESSAGE : BOT_CHECK_MESSAGE, 'bot-check')
    );
  }

  async function probeOnce(
    url: string,
    attempt: Attempt,
    cookies: string | undefined,
    signal: AbortSignal | undefined,
    metadataOnly = false,
  ): Promise<UrlInfo> {
    const args = buildProbeArgs(url, {
      cookiesFromBrowser: cookies,
      extractorArgs: attempt.extractorArgs,
      jsRuntime: deps.jsRuntime?.() ?? null,
      metadataOnly,
    });
    const res = await run(deps.ytdlpPath(), args, {
      signal,
      env: envFor(),
      captureStdout: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (res.code !== 0) {
      deps.log(
        `[ingest] probe failed (${attempt.id}): ${extractErrorLine(res.stderr) ?? 'no error line'}`,
      );
      const c = classifyYtdlpError(res.stderr, { cookies: Boolean(cookies) });
      throw new IngestError(c.message, c.kind);
    }
    const start = res.stdout.indexOf('{');
    let json: unknown;
    try {
      json = JSON.parse(start >= 0 ? res.stdout.slice(start) : res.stdout);
    } catch {
      throw new IngestError(
        'yt-dlp returned unreadable video information. Update yt-dlp and retry.',
        'other',
      );
    }
    return mapInfo(json);
  }

  async function probe(
    rawUrl: string,
    opts: { cookiesFromBrowser?: string; signal?: AbortSignal; onProgress?: OnProgress } = {},
  ): Promise<UrlInfo> {
    const url = assertHttpUrl(rawUrl);
    normalizeBrowser(opts.cookiesFromBrowser); // validate early
    try {
      return await throughChain('probe', Boolean(opts.cookiesFromBrowser), opts.signal, (attempt) =>
        probeOnce(url, attempt, opts.cookiesFromBrowser, opts.signal),
      );
    } catch (e) {
      if (e instanceof IngestError && e.kind === 'bot-check') {
        // The video exists (that is the only case YouTube bot-checks). Salvage the public metadata so
        // the caller can still show title/thumbnail next to the actionable message.
        const partial = await probeOnce(
          url,
          ATTEMPTS[0] as Attempt,
          opts.cookiesFromBrowser,
          opts.signal,
          true,
        ).catch((): UrlInfo | null => null);
        throw new BotCheckIngestError(e.message, partial);
      }
      throw e;
    }
  }

  async function download(
    rawUrl: string,
    outDir: string,
    opts: {
      maxResolution: number;
      cookiesFromBrowser?: string;
      signal?: AbortSignal;
      onProgress?: OnProgress;
    },
  ): Promise<{ filePath: string }> {
    const url = assertHttpUrl(rawUrl);
    normalizeBrowser(opts.cookiesFromBrowser);
    await fs.promises.mkdir(outDir, { recursive: true });
    const startedAt = Date.now();
    opts.onProgress?.(0, 'Starting download');

    const filePath = await throughChain(
      'download',
      Boolean(opts.cookiesFromBrowser),
      opts.signal,
      async (attempt, index) => {
        if (attempt.limited) {
          deps.log('[ingest] falling back to the android_vr client (360p)');
          opts.onProgress?.(null, `${LIMITED_QUALITY_NOTE} - trying a limited-quality download`);
        }
        const agg = new ProgressAggregator(attempt.limited ? 'Reduced quality (360p)' : '');
        let produced: string | null = null;
        const args = buildDownloadArgs(url, outDir, {
          maxResolution: opts.maxResolution,
          attempt,
          ffmpegPath: deps.ffmpegPath(),
          cookiesFromBrowser: opts.cookiesFromBrowser,
          jsRuntime: deps.jsRuntime?.() ?? null,
        });
        const res = await run(deps.ytdlpPath(), args, {
          signal: opts.signal,
          env: envFor(),
          onStdoutLine: (line) => {
            const p = parseYtdlpLine(line);
            if (!p) return;
            if (p.kind === 'file') produced = p.path;
            else if (p.kind === 'plan') agg.setPlan(p.plan);
            else if (p.kind === 'progress') {
              const u = agg.update(p.rec);
              opts.onProgress?.(u.fraction, u.message);
            } else if (p.kind === 'postprocess' && p.status === 'started') {
              opts.onProgress?.(0.99, 'Merging audio and video');
            }
          },
        });
        if (res.code !== 0) {
          deps.log(
            `[ingest] download failed (${attempt.id}#${index}): ${extractErrorLine(res.stderr) ?? 'no error line'}`,
          );
          const c = classifyYtdlpError(res.stderr, { cookies: Boolean(opts.cookiesFromBrowser) });
          throw new IngestError(c.message, c.kind);
        }
        const found = produced ?? (await newestMedia(outDir, startedAt));
        if (!found || !(await isNonEmptyFile(found))) {
          // yt-dlp exits 0 without a file when --match-filter skipped the video: that means "is live".
          const info = await probeOnce(url, attempt, opts.cookiesFromBrowser, opts.signal).catch(
            (): UrlInfo | null => null,
          );
          if (info?.isLive) throw new IngestError(LIVE_MESSAGE, 'live');
          throw new IngestError(
            'The download finished but no video file was produced. Please retry.',
            'other',
          );
        }
        return found;
      },
    );

    opts.onProgress?.(1, 'Download complete');
    return { filePath };
  }

  return { probe, download };
}

async function isNonEmptyFile(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Fallback when yt-dlp did not print the final path: newest finished media file written since `since`. */
async function newestMedia(dir: string, since: number): Promise<string | null> {
  let best: { p: string; t: number } | null = null;
  for (const name of await fs.promises.readdir(dir)) {
    if (/\.(part|ytdl|temp|tmp)$/i.test(name) || /\.f\d+\.\w+$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.stat(p);
      if (st.isFile() && st.mtimeMs >= since - 1000 && (!best || st.mtimeMs > best.t)) {
        best = { p, t: st.mtimeMs };
      }
    } catch {
      // vanished
    }
  }
  return best?.p ?? null;
}
