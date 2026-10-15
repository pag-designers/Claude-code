import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTEMPTS,
  BOT_CHECK_MESSAGE,
  BOT_CHECK_WITH_COOKIES_MESSAGE,
  BotCheckIngestError,
  LIMITED_QUALITY_NOTE,
  LIVE_MESSAGE,
  ProgressAggregator,
  assertHttpUrl,
  buildDownloadArgs,
  buildProbeArgs,
  classifyYtdlpError,
  createIngestService,
  extractErrorLine,
  formatArgs,
  formatEta,
  formatSpeed,
  isoDate,
  mapInfo,
  normalizeBrowser,
  parseYtdlpLine,
  type RunYtdlp,
  type RunYtdlpResult,
} from '../../electron/main/services/media/ytdlp';
import { IngestError } from '../../electron/main/pipeline/contracts';
import { urlInfoSchema } from '../../shared/pipeline';
import { isAbortError, AbortError } from '../../electron/main/services/media/proc';

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

/* Recorded from real yt-dlp 2026.08.19 runs (YouTube from a datacenter IP). */
const STDERR_BOT =
  'ERROR: [youtube] WBNcpzv8rD4: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies\n';
const STDERR_UNAVAILABLE = 'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable\n';
const STDERR_404 =
  'ERROR: [generic] notvideo: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)\n';
const STDERR_REFUSED =
  "ERROR: [generic] x: Unable to download webpage: HTTPConnection(host='127.0.0.1', port=1): Failed to establish a new connection: [Errno 111] Connection refused (caused by TransportError(\"HTTPConnection(host='127.0.0.1', port=1): Failed to establish a new connection: [Errno 111] Connection refused\"))\n";
const STDERR_PROXY =
  "ERROR: [generic] x: Unable to download webpage: ('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway')) (caused by ProxyError(\"('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))\")); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U\n";
const STDERR_COOKIES =
  'ERROR: could not find chrome cookies database in "/root/.config/google-chrome"\n';
/* Standard yt-dlp YouTube messages (youtube extractor source). */
const STDERR_PRIVATE =
  "ERROR: [youtube] abcdefghijk: Private video. Sign in if you've been granted access to this video\n";
const STDERR_AGE =
  'ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users.\n';
const STDERR_LIVE = 'ERROR: [youtube] abcdefghijk: This live event will begin in 2 hours.\n';
const STDERR_PREMIERE = 'ERROR: [youtube] abcdefghijk: Premieres in 3 days\n';
const STDERR_MEMBERS =
  'ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content like this video, and other exclusive perks.\n';
const STDERR_TRACEBACK =
  'Traceback (most recent call last):\n  File "yt_dlp/__main__.py", line 1, in <module>\nKeyError: boom\n';

/* ------------------------------------------------ arguments ------------------------------------------------ */

describe('argument building', () => {
  it('probe args use the documented flags and end with `-- url`', () => {
    const a = buildProbeArgs('https://youtu.be/x', {});
    for (const f of ['--dump-single-json', '--no-playlist', '--no-warnings', '--ignore-config']) {
      expect(a).toContain(f);
    }
    expect(a.slice(-2)).toEqual(['--', 'https://youtu.be/x']);
    expect(a).not.toContain('--ignore-no-formats-error');
    expect(buildProbeArgs('u', { metadataOnly: true })).toContain('--ignore-no-formats-error');
  });

  it('adds extractor args, cookies and a JS runtime only when asked', () => {
    const a = buildProbeArgs('u', {
      extractorArgs: 'youtube:player_client=android_vr',
      cookiesFromBrowser: 'firefox',
      jsRuntime: { path: '/usr/bin/node' },
    });
    expect(a).toContain('--cookies-from-browser=firefox');
    expect(a).toContain('youtube:player_client=android_vr');
    expect(a.join(' ')).toContain('--js-runtimes node:/usr/bin/node');
    expect(buildProbeArgs('u', {}).join(' ')).not.toMatch(/cookies|js-runtimes|extractor-args/);
  });

  it('validates the cookies browser so it can never smuggle options', () => {
    expect(normalizeBrowser('Chrome')).toBe('chrome');
    expect(normalizeBrowser('firefox:default-release')).toBe('firefox:default-release');
    expect(normalizeBrowser('chrome+gnomekeyring:Profile 1')).toBe('chrome+gnomekeyring:Profile 1');
    expect(normalizeBrowser('')).toBeNull();
    expect(normalizeBrowser(undefined)).toBeNull();
    for (const bad of ['netscape', '--exec=evil', 'chrome --no-check-certificates', '-f best']) {
      expect(() => normalizeBrowser(bad)).toThrow(IngestError);
    }
    // even a hostile profile name stays inside a single `--cookies-from-browser=...` argument
    const a = buildProbeArgs('u', { cookiesFromBrowser: 'chrome:--exec=evil' });
    expect(a.filter((x) => x.startsWith('--cookies-from-browser='))).toHaveLength(1);
    expect(a).not.toContain('--exec=evil');
  });

  it('download args: best video <= maxResolution + audio merged to mp4, resumable, progress templates', () => {
    const a = buildDownloadArgs('https://youtu.be/x', '/tmp/out', {
      maxResolution: 1080,
      attempt: ATTEMPTS[0]!,
      ffmpegPath: '/opt/ffmpeg',
    });
    const j = a.join(' ');
    expect(j).toContain('-f bv*+ba/b');
    expect(j).toContain('-S res:1080,vcodec:h264,fps,acodec:aac');
    expect(j).toContain('--merge-output-format mp4');
    expect(j).toContain('--ffmpeg-location /opt/ffmpeg');
    expect(a).toContain('--continue');
    expect(a).toContain('--newline');
    expect(j).toContain('--match-filter !is_live');
    expect(j).toContain('--progress-template download:CFP|');
    expect(j).toContain('before_dl:CFPI|');
    expect(j).toContain('after_move:CFPF|%(filepath)s');
    expect(a).not.toContain('--no-part');
    expect(a.slice(-2)).toEqual(['--', 'https://youtu.be/x']);
    expect(a[a.indexOf('-o') + 1]).toBe(path.join('/tmp/out', '%(id)s.%(ext)s'));
  });

  it('escapes % in the output directory so yt-dlp does not treat it as a template', () => {
    const a = buildDownloadArgs('u', '/tmp/100% real', {
      maxResolution: 720,
      attempt: ATTEMPTS[0]!,
      ffmpegPath: 'ffmpeg',
    });
    expect(a[a.indexOf('-o') + 1]).toBe(path.join('/tmp/100%% real', '%(id)s.%(ext)s'));
  });

  it('the android_vr attempt forces the 360p progressive format', () => {
    const attempt = ATTEMPTS[1]!;
    expect(attempt.limited).toBe(true);
    expect(formatArgs(1080, attempt)).toEqual(['-f', '18/b']);
    const a = buildDownloadArgs('u', '/o', { maxResolution: 1080, attempt, ffmpegPath: 'f' });
    expect(a.join(' ')).toContain('youtube:player_client=android_vr');
  });

  it('rejects non-http urls before spawning anything', () => {
    expect(() => assertHttpUrl('not a url')).toThrow(IngestError);
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/http/);
    expect(assertHttpUrl(' https://youtu.be/abc ')).toBe('https://youtu.be/abc');
  });
});

/* ------------------------------------------------ info mapping --------------------------------------------- */

describe('mapInfo', () => {
  it('maps a full yt-dlp info dict', () => {
    const info = mapInfo(fixture('ytdlp-info-full.json'));
    expect(() => urlInfoSchema.parse(info)).not.toThrow();
    expect(info).toMatchObject({
      id: 'dQw4w9WgXcQ',
      channel: 'Rick Astley',
      durationSec: 213,
      isLive: false,
      thumbnail: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
    });
    expect(info.uploadDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(info.title).toContain('Never Gonna Give You Up');
  });

  it('maps the metadata-only dict YouTube serves when formats are blocked (license, no duration)', () => {
    const info = mapInfo(fixture('ytdlp-info-metadata-only.json'));
    expect(info.license).toBe('Creative Commons Attribution license (reuse allowed)');
    expect(info.durationSec).toBeNull();
    expect(info.channel).toBe('saifu.');
    expect(info.uploadDate).toBe('2026-05-04');
    expect(info.chapters).toEqual([]);
  });

  it('maps chapters, drops invalid ones, falls back to thumbnails[] and uploader', () => {
    const info = mapInfo({
      id: 'abc',
      title: 'T',
      uploader: 'Up',
      duration: 100,
      thumbnails: [{ url: 'https://a/1.jpg' }, { url: 'https://a/2.jpg' }],
      chapters: [
        { title: 'Intro', start_time: 0, end_time: 30 },
        { title: 'Bad', start_time: 30, end_time: 30 },
        { start_time: 30, end_time: 100 },
      ],
    });
    expect(info.channel).toBe('Up');
    expect(info.thumbnail).toBe('https://a/2.jpg');
    expect(info.chapters).toEqual([
      { title: 'Intro', start: 0, end: 30 },
      { title: 'Chapter 2', start: 30, end: 100 },
    ]);
  });

  it('flags live and upcoming streams', () => {
    expect(mapInfo({ id: 'a', title: 't', is_live: true }).isLive).toBe(true);
    expect(mapInfo({ id: 'a', title: 't', live_status: 'is_upcoming' }).isLive).toBe(true);
    expect(mapInfo({ id: 'a', title: 't', live_status: 'was_live' }).isLive).toBe(false);
  });

  it('rejects playlists and garbage with a helpful IngestError', () => {
    expect(() => mapInfo({ _type: 'playlist', id: 'PL1', entries: [] })).toThrow(/single video/);
    expect(() => mapInfo(null)).toThrow(IngestError);
    expect(() => mapInfo({ title: 'no id' })).toThrow(IngestError);
  });

  it('isoDate converts yt-dlp dates', () => {
    expect(isoDate('20240131')).toBe('2024-01-31');
    expect(isoDate('2024-01-31')).toBeNull();
    expect(isoDate(undefined)).toBeNull();
  });
});

/* ------------------------------------------------ progress -------------------------------------------------- */

describe('progress parsing', () => {
  it('parses recorded progress / plan / postprocess / file lines', () => {
    // recorded from a real two-stream (video+audio) download
    const line = 'CFP|downloading|10007644|NA|23280572.142857146|23708599.328147355|NA|137';
    expect(parseYtdlpLine(line)).toEqual({
      kind: 'progress',
      rec: {
        status: 'downloading',
        downloaded: 10007644,
        total: null,
        totalEstimate: 23280572.142857146,
        speed: 23708599.328147355,
        eta: null,
        formatId: '137',
      },
    });
    expect(parseYtdlpLine('CFPI|137|140|9051890|3328598')).toEqual({
      kind: 'plan',
      plan: { format0: '137', format1: '140', size0: 9051890, size1: 3328598 },
    });
    expect(parseYtdlpLine('CFPI|18|NA|NA|NA')).toEqual({
      kind: 'plan',
      plan: { format0: '18', format1: null, size0: null, size1: null },
    });
    expect(parseYtdlpLine('CFPP|started|Merger')).toEqual({
      kind: 'postprocess',
      status: 'started',
      name: 'Merger',
    });
    expect(parseYtdlpLine('CFPF|/tmp/out/abc.mp4')).toEqual({
      kind: 'file',
      path: '/tmp/out/abc.mp4',
    });
    expect(parseYtdlpLine('[download] Destination: x.mp4')).toBeNull();
    expect(parseYtdlpLine('CFP|too|short')).toBeNull();
  });

  it('formats speed and ETA like the UI shows them', () => {
    expect(formatSpeed(3.2 * 1_048_576)).toBe('3.2 MiB/s');
    expect(formatSpeed(512 * 1024)).toBe('512 KiB/s');
    expect(formatSpeed(10)).toBe('1 KiB/s');
    expect(formatEta(41)).toBe('00:41');
    expect(formatEta(125)).toBe('02:05');
    expect(formatEta(3725)).toBe('1:02:05');
    expect(formatEta(-4)).toBe('00:00');
  });

  it('a single progressive stream reports "3.2 MiB/s · 00:41 left" and the real fraction', () => {
    const agg = new ProgressAggregator();
    agg.setPlan({ format0: '18', format1: null, size0: null, size1: null });
    const r = agg.update({
      status: 'downloading',
      downloaded: 25_000_000,
      total: 100_000_000,
      totalEstimate: null,
      speed: 3.2 * 1_048_576,
      eta: 41,
      formatId: '18',
    });
    expect(r.fraction).toBeCloseTo(0.25, 5);
    expect(r.message).toBe('3.2 MiB/s · 00:41 left');
  });

  it('aggregates video + audio into one monotonic fraction weighted by announced sizes', () => {
    const agg = new ProgressAggregator();
    agg.setPlan({ format0: '137', format1: '140', size0: 90_000_000, size1: 10_000_000 });
    const fr: number[] = [];
    const video = (d: number, est = 90_000_000) =>
      agg.update({
        status: 'downloading',
        downloaded: d,
        total: null,
        totalEstimate: est,
        speed: 5_000_000,
        eta: null,
        formatId: '137',
      });
    const audio = (d: number) =>
      agg.update({
        status: 'downloading',
        downloaded: d,
        total: 10_000_000,
        totalEstimate: null,
        speed: 1_000_000,
        eta: 3,
        formatId: '140',
      });
    fr.push(video(9_000_000).fraction); // 10 % of video => 9 % overall
    fr.push(video(45_000_000, 100_000_000).fraction); // estimate grew: raw would drop, must not
    fr.push(video(90_000_000).fraction);
    fr.push(
      agg.update({
        status: 'finished',
        downloaded: 90_000_000,
        total: 90_000_000,
        totalEstimate: null,
        speed: null,
        eta: null,
        formatId: '137',
      }).fraction,
    );
    fr.push(audio(5_000_000).fraction);
    const last = audio(10_000_000);
    fr.push(last.fraction);
    expect(fr[0]).toBeCloseTo(0.09, 2);
    for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThanOrEqual(fr[i - 1]!);
    expect(fr[3]).toBeCloseTo(0.9, 2);
    expect(fr[4]).toBeCloseTo(0.95, 2);
    expect(last.fraction).toBeLessThanOrEqual(0.985); // headroom for the merge step
    expect(last.message).toMatch(/^\d/);
  });

  it('without announced sizes video counts 90 % and the ETA is extrapolated from bytes done', () => {
    const agg = new ProgressAggregator();
    agg.setPlan({ format0: 'a', format1: 'b', size0: null, size1: null });
    const r = agg.update({
      status: 'downloading',
      downloaded: 4_500_000,
      total: 9_000_000,
      totalEstimate: null,
      speed: 1_000_000,
      eta: null,
      formatId: 'a',
    });
    expect(r.fraction).toBeCloseTo(0.45, 2);
    // 4.5 MB done = 45 % => 5.5 MB left at 1 MB/s => 5.5 s
    expect(r.message).toBe('977 KiB/s · 00:06 left');
  });

  it('prefixes the limited-quality note', () => {
    const agg = new ProgressAggregator('Reduced quality (360p)');
    const r = agg.update({
      status: 'downloading',
      downloaded: 1,
      total: 10,
      totalEstimate: null,
      speed: 2_097_152,
      eta: 5,
      formatId: '18',
    });
    expect(r.message).toBe('Reduced quality (360p) · 2.0 MiB/s · 00:05 left');
  });
});

/* ------------------------------------------- error classification ------------------------------------------- */

describe('error classification', () => {
  const cases: [string, string, IngestError['kind']][] = [
    ['bot check (recorded)', STDERR_BOT, 'bot-check'],
    [
      '403 on media url (recorded)',
      'ERROR: unable to download video data: HTTP Error 403: Forbidden\n',
      'bot-check',
    ],
    ['unavailable (recorded)', STDERR_UNAVAILABLE, 'unavailable'],
    ['404 (recorded)', STDERR_404, 'unavailable'],
    ['connection refused (recorded)', STDERR_REFUSED, 'network'],
    ['proxy 502 (recorded)', STDERR_PROXY, 'network'],
    ['private', STDERR_PRIVATE, 'private'],
    ['members only', STDERR_MEMBERS, 'private'],
    ['age gate', STDERR_AGE, 'age-restricted'],
    ['live event', STDERR_LIVE, 'live'],
    ['premiere', STDERR_PREMIERE, 'live'],
    ['cookies db', STDERR_COOKIES, 'other'],
    ['traceback', STDERR_TRACEBACK, 'other'],
    [
      'read timeout',
      'ERROR: unable to download video data: The read operation timed out\n',
      'network',
    ],
    [
      'http 503',
      'ERROR: [youtube] x: Unable to download webpage: HTTP Error 503: Service Unavailable\n',
      'network',
    ],
    ['disk full', 'ERROR: unable to write data: [Errno 28] No space left on device\n', 'other'],
    [
      'n challenge',
      'ERROR: [youtube] x: Only images are available for download. n challenge solving failed\n',
      'other',
    ],
  ];
  it.each(cases)('%s -> %s', (_label, stderr, kind) => {
    expect(classifyYtdlpError(stderr).kind).toBe(kind);
  });

  it('gives actionable, stack-trace-free messages', () => {
    expect(classifyYtdlpError(STDERR_BOT).message).toBe(BOT_CHECK_MESSAGE);
    expect(BOT_CHECK_MESSAGE).toContain("In Settings → Ingest choose 'Cookies from browser'");
    expect(classifyYtdlpError(STDERR_BOT, { cookies: true }).message).toBe(
      BOT_CHECK_WITH_COOKIES_MESSAGE,
    );
    expect(classifyYtdlpError(STDERR_AGE).message).toMatch(/Cookies from browser/);
    expect(classifyYtdlpError(STDERR_LIVE).message).toBe(LIVE_MESSAGE);
    expect(classifyYtdlpError(STDERR_COOKIES).message).toMatch(
      /Couldn't read cookies from your browser/,
    );
    for (const [, stderr] of cases) {
      const m = classifyYtdlpError(stderr).message;
      expect(m).not.toMatch(/Traceback|File ".*line \d+|KeyError/);
      expect(m).not.toMatch(/https?:\/\//); // urls are stripped from yt-dlp's own text
    }
  });

  it('extractErrorLine strips prefixes, urls and colours', () => {
    expect(extractErrorLine(STDERR_UNAVAILABLE)).toBe('This video is unavailable');
    expect(
      extractErrorLine(
        '\u001b[0;31mERROR:\u001b[0m [youtube] abcdefghijk: Boom  see https://x.y/z for more.',
      ),
    ).toBe('Boom see for more.');
    expect(extractErrorLine('nothing here')).toBeNull();
  });

  it('unknown failures still produce a sane message', () => {
    expect(classifyYtdlpError('ERROR: [vimeo] 1: Something odd happened\n')).toEqual({
      kind: 'other',
      message: 'yt-dlp could not download this video: Something odd happened',
    });
    expect(classifyYtdlpError('').message).toMatch(/without an error message/);
  });
});

/* -------------------------------------- service logic with a scripted runner --------------------------------- */

type Step = RunYtdlpResult | Error | ((args: string[]) => RunYtdlpResult | Promise<RunYtdlpResult>);
function scripted(steps: Step[], onLines?: string[][]) {
  const calls: string[][] = [];
  let i = 0;
  const run: RunYtdlp = async (_bin, args, opts) => {
    calls.push(args);
    const step = steps[Math.min(i, steps.length - 1)];
    const lines = onLines?.[i];
    i++;
    for (const l of lines ?? []) opts.onStdoutLine?.(l);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(args) : (step as RunYtdlpResult);
  };
  return { run, calls };
}
const ok = (stdout = ''): RunYtdlpResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): RunYtdlpResult => ({ code: 1, stdout: '', stderr });
const infoJson = JSON.stringify(fixture('ytdlp-info-full.json'));

function service(
  steps: Step[],
  onLines?: string[][],
  extra: Partial<Parameters<typeof createIngestService>[0]> = {},
) {
  const logs: string[] = [];
  const s = scripted(steps, onLines);
  const svc = createIngestService({
    ytdlpPath: () => '/bin/yt-dlp',
    ffmpegPath: () => '/bin/ffmpeg',
    log: (m) => logs.push(m),
    retryDelaysMs: [0, 0, 0],
    run: s.run,
    ...extra,
  });
  return { svc, calls: s.calls, logs };
}

describe('probe()', () => {
  it('returns the mapped UrlInfo on the first try', async () => {
    const { svc, calls } = service([ok(infoJson)]);
    const info = await svc.probe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(info.id).toBe('dQw4w9WgXcQ');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the android_vr client when the default client is bot-checked', async () => {
    const { svc, calls } = service([fail(STDERR_BOT), ok(infoJson)]);
    const info = await svc.probe('https://youtu.be/dQw4w9WgXcQ');
    expect(info.id).toBe('dQw4w9WgXcQ');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(' ')).not.toContain('android_vr');
    expect(calls[1]!.join(' ')).toContain('player_client=android_vr');
  });

  it('throws the actionable bot-check error (with salvaged metadata) when every client is blocked', async () => {
    const meta = JSON.stringify(fixture('ytdlp-info-metadata-only.json'));
    const { svc, calls } = service([fail(STDERR_BOT), fail(STDERR_BOT), ok(meta)]);
    const err = await svc.probe('https://youtu.be/WBNcpzv8rD4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotCheckIngestError);
    const e = err as BotCheckIngestError;
    expect(e.kind).toBe('bot-check');
    expect(e.message).toBe(BOT_CHECK_MESSAGE);
    expect(e.partialInfo?.title).toContain('Startup');
    expect(e.partialInfo?.license).toMatch(/Creative Commons/);
    expect(calls[2]!).toContain('--ignore-no-formats-error');
  });

  it('still throws bot-check when even the metadata-only call fails', async () => {
    const { svc } = service([fail(STDERR_BOT)]);
    const e = (await svc
      .probe('https://youtu.be/x')
      .catch((x: unknown) => x)) as BotCheckIngestError;
    expect(e.kind).toBe('bot-check');
    expect(e.partialInfo).toBeNull();
  });

  it('mentions the cookies when they were already supplied', async () => {
    const { svc } = service([fail(STDERR_BOT)]);
    const e = (await svc
      .probe('https://youtu.be/x', { cookiesFromBrowser: 'chrome' })
      .catch((x: unknown) => x)) as IngestError;
    expect(e.message).toBe(BOT_CHECK_WITH_COOKIES_MESSAGE);
  });

  it('retries transient network errors 3x and then succeeds', async () => {
    const { svc, calls, logs } = service([
      fail(STDERR_PROXY),
      fail(STDERR_REFUSED),
      fail(STDERR_PROXY),
      ok(infoJson),
    ]);
    await expect(svc.probe('https://youtu.be/x')).resolves.toMatchObject({ id: 'dQw4w9WgXcQ' });
    expect(calls).toHaveLength(4);
    expect(logs.filter((l) => /retry \d\/3/.test(l))).toHaveLength(3);
  });

  it('gives up after 3 retries with a network error', async () => {
    const { svc, calls } = service([fail(STDERR_PROXY)]);
    const e = (await svc.probe('https://youtu.be/x').catch((x: unknown) => x)) as IngestError;
    expect(e.kind).toBe('network');
    expect(calls).toHaveLength(4);
  });

  it('does not retry permanent errors', async () => {
    for (const [stderr, kind] of [
      [STDERR_UNAVAILABLE, 'unavailable'],
      [STDERR_PRIVATE, 'private'],
      [STDERR_AGE, 'age-restricted'],
    ] as const) {
      const { svc, calls } = service([fail(stderr)]);
      const e = (await svc.probe('https://youtu.be/x').catch((x: unknown) => x)) as IngestError;
      expect(e.kind).toBe(kind);
      expect(calls).toHaveLength(1);
    }
  });

  it('reports live streams through UrlInfo.isLive', async () => {
    const live = JSON.stringify({ id: 'l1', title: 'Live', is_live: true, live_status: 'is_live' });
    const { svc } = service([ok(live)]);
    expect((await svc.probe('https://youtu.be/l1')).isLive).toBe(true);
  });

  it('rejects bad input without spawning and survives noisy / invalid stdout', async () => {
    const { svc, calls } = service([ok('WARNING: noise\n' + infoJson)]);
    await expect(svc.probe('nonsense')).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      svc.probe('https://youtu.be/x', { cookiesFromBrowser: 'netscape' }),
    ).rejects.toBeInstanceOf(IngestError);
    expect(calls).toHaveLength(0);
    await expect(svc.probe('https://youtu.be/x')).resolves.toMatchObject({ id: 'dQw4w9WgXcQ' });
    const bad = service([ok('<html>not json')]);
    await expect(bad.svc.probe('https://youtu.be/x')).rejects.toMatchObject({ kind: 'other' });
  });

  it('propagates cancellation untouched', async () => {
    const { svc } = service([new AbortError()]);
    await expect(svc.probe('https://youtu.be/x')).rejects.toSatisfy(isAbortError);
  });
});

describe('download()', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-dl-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const progressLines = [
    'CFPI|137|140|9000000|1000000',
    'CFP|downloading|900000|NA|9000000|2000000|NA|137',
    'CFP|downloading|4500000|NA|9000000|3000000|NA|137',
    'CFP|finished|9000000|9000000|NA|NA|NA|137',
    'CFP|downloading|500000|1000000|NA|1000000|1|140',
    'CFPP|started|Merger',
  ];

  it('streams real progress, then returns the file path yt-dlp reports', async () => {
    const out = path.join(dir, 'ok');
    const file = path.join(out, 'vid.mp4');
    const { svc, calls } = service(
      [
        async () => {
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(file, 'x');
          return ok();
        },
      ],
      [[...progressLines, `CFPF|${file}`]],
    );
    const seen: [number | null, string | undefined][] = [];
    const res = await svc.download('https://youtu.be/x', out, {
      maxResolution: 720,
      onProgress: (f, m) => seen.push([f, m]),
    });
    expect(res.filePath).toBe(file);
    expect(calls[0]!.join(' ')).toContain('res:720');
    const fractions = seen.map((s) => s[0]).filter((f): f is number => f !== null);
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(seen.some(([, m]) => m === 'Merging audio and video')).toBe(true);
    expect(seen.some(([, m]) => /MiB\/s · \d\d:\d\d left/.test(m ?? ''))).toBe(true);
  });

  it('on bot-check switches to android_vr (format 18/b) and says that quality is limited', async () => {
    const out = path.join(dir, 'limited');
    const file = path.join(out, 'vid.mp4');
    const { svc, calls } = service(
      [
        fail(STDERR_BOT),
        async () => {
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(file, 'x');
          return ok();
        },
      ],
      [[], ['CFPI|18|NA|NA|NA', 'CFP|downloading|1000|10000|NA|2097152|5|18', `CFPF|${file}`]],
    );
    const msgs: string[] = [];
    const res = await svc.download('https://youtu.be/x', out, {
      maxResolution: 1080,
      onProgress: (_f, m) => {
        if (m) msgs.push(m);
      },
    });
    expect(res.filePath).toBe(file);
    expect(calls[1]!.join(' ')).toContain('-f 18/b');
    expect(msgs.some((m) => m.includes(LIMITED_QUALITY_NOTE))).toBe(true);
    expect(msgs).toContain('Reduced quality (360p) · 2.0 MiB/s · 00:05 left');
  });

  it('throws the actionable bot-check error when both clients are blocked', async () => {
    const { svc, calls } = service([fail(STDERR_BOT)]);
    const e = (await svc
      .download('https://youtu.be/x', path.join(dir, 'blocked'), { maxResolution: 1080 })
      .catch((x: unknown) => x)) as IngestError;
    expect(e.kind).toBe('bot-check');
    expect(e.message).toBe(BOT_CHECK_MESSAGE);
    expect(calls).toHaveLength(2);
  });

  it('classifies other failures and retries network errors', async () => {
    const out = path.join(dir, 'net');
    const file = path.join(out, 'v.mp4');
    const { svc, calls } = service(
      [
        fail(STDERR_REFUSED),
        async () => {
          fs.mkdirSync(out, { recursive: true });
          fs.writeFileSync(file, 'x');
          return { code: 0, stdout: '', stderr: '' };
        },
      ],
      [[], [`CFPF|${file}`]],
    );
    await expect(svc.download('https://youtu.be/x', out, { maxResolution: 1080 })).resolves.toEqual(
      { filePath: file },
    );
    expect(calls).toHaveLength(2);
    const priv = service([fail(STDERR_PRIVATE)]);
    await expect(
      priv.svc.download('https://youtu.be/x', path.join(dir, 'p'), { maxResolution: 1080 }),
    ).rejects.toMatchObject({ kind: 'private' });
  });

  it('rejects live streams: yt-dlp skips them (exit 0, no file) and the probe says live', async () => {
    const live = JSON.stringify({ id: 'l1', title: 'Live', is_live: true });
    const { svc } = service([ok(), ok(live)]);
    const e = (await svc
      .download('https://youtu.be/l1', path.join(dir, 'live'), { maxResolution: 1080 })
      .catch((x: unknown) => x)) as IngestError;
    expect(e.kind).toBe('live');
    expect(e.message).toBe(LIVE_MESSAGE);
  });

  it('a silent success without a file is an error, not a made-up path', async () => {
    const { svc } = service([ok(), ok(infoJson)]);
    await expect(
      svc.download('https://youtu.be/x', path.join(dir, 'nofile'), { maxResolution: 1080 }),
    ).rejects.toMatchObject({ kind: 'other', message: expect.stringMatching(/no video file/) });
  });

  it('falls back to the newest finished media file when no CFPF line was printed', async () => {
    const out = path.join(dir, 'scan');
    const file = path.join(out, 'abc.mp4');
    const { svc } = service([
      async () => {
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'abc.f137.mp4.part'), 'p');
        fs.writeFileSync(file, 'x');
        return ok();
      },
    ]);
    await expect(svc.download('https://youtu.be/x', out, { maxResolution: 1080 })).resolves.toEqual(
      { filePath: file },
    );
  });

  it('propagates cancellation', async () => {
    const { svc } = service([new AbortError()]);
    await expect(
      svc.download('https://youtu.be/x', path.join(dir, 'abort'), { maxResolution: 1080 }),
    ).rejects.toSatisfy(isAbortError);
  });
});

/* --------------------------- integration: real yt-dlp against a local DASH stream ---------------------------- */

const YTDLP_BIN = process.env.CLIPFERN_YTDLP_BIN;
const FFMPEG = (createRequire(import.meta.url)('ffmpeg-static') as string | null) ?? '';

describe.skipIf(!YTDLP_BIN || !FFMPEG)(
  'real yt-dlp on a local DASH stream (set CLIPFERN_YTDLP_BIN)',
  () => {
    let dir = '';
    let server: http.Server;
    let url = '';

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-dash-'));
      const dash = path.join(dir, 'dash');
      fs.mkdirSync(dash);
      const r = spawnSync(
        FFMPEG,
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=640x360:rate=25:duration=12',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=12',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-g',
          '50',
          '-keyint_min',
          '50',
          '-sc_threshold',
          '0',
          '-c:a',
          'aac',
          '-f',
          'dash',
          '-seg_duration',
          '2',
          '-use_template',
          '1',
          '-use_timeline',
          '1',
          '-adaptation_sets',
          'id=0,streams=v id=1,streams=a',
          path.join(dash, 'manifest.mpd'),
        ],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
      server = http.createServer((req, res) => {
        const f = path.join(dash, path.basename(req.url ?? ''));
        if (!fs.existsSync(f)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.end(fs.readFileSync(f));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manifest.mpd`;
    }, 60_000);
    afterAll(() => {
      server?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const mk = () =>
      createIngestService({
        ytdlpPath: () => YTDLP_BIN ?? '',
        ffmpegPath: () => FFMPEG,
        log: () => undefined,
      });

    it('downloads separate video+audio streams, merges to mp4 and reports progress', async () => {
      const out = path.join(dir, 'out');
      const seen: number[] = [];
      const res = await mk().download(url, out, {
        maxResolution: 720,
        onProgress: (f) => {
          if (f !== null) seen.push(f);
        },
      });
      expect(res.filePath.endsWith('.mp4')).toBe(true);
      expect(fs.statSync(res.filePath).size).toBeGreaterThan(10_000);
      const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', res.filePath], { encoding: 'utf8' });
      expect(probe.stderr).toMatch(/Video: h264/);
      expect(probe.stderr).toMatch(/Audio: aac/);
      expect(seen.at(-1)).toBe(1);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(seen.some((f) => f > 0.05 && f < 0.95)).toBe(true);
    }, 60_000);

    it('cancels mid-download and leaves no yt-dlp process behind', async () => {
      const out = path.join(dir, 'out-abort');
      const ac = new AbortController();
      const p = mk().download(url, out, {
        maxResolution: 720,
        signal: ac.signal,
        onProgress: () => undefined,
      });
      setTimeout(() => ac.abort(), 700);
      await expect(p).rejects.toSatisfy(isAbortError);
      if (process.platform !== 'win32') {
        await new Promise((r) => setTimeout(r, 300));
        const ps = spawnSync('pgrep', ['-f', path.join(dir, 'out-abort')], { encoding: 'utf8' });
        expect(ps.stdout.trim()).toBe('');
      }
    }, 30_000);

    it('probe reads the stream metadata', async () => {
      const info = await mk().probe(url);
      expect(info.isLive).toBe(false);
      expect(info.id).toBe('manifest');
    }, 30_000);
  },
);
