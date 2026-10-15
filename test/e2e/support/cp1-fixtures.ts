/**
 * TEST-ONLY media for the CP1 stub: real JPEG frames and short H.264 MP4s cut with ffmpeg from a fixture video
 * (CLIPFERN_FIXTURE_VIDEO, or any *.mp4 in test/fixtures), falling back to a synthetic test pattern so the suite is
 * self-contained. Generated once into $CLIPFERN_E2E_ASSETS (default .tmp/cp1-assets) and reused.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '../../..');
export const ASSETS_DIR = process.env.CLIPFERN_E2E_ASSETS ?? path.join(ROOT, '.tmp/cp1-assets');
const MARKER = '.ready-v3';

function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH))
    return process.env.FFMPEG_PATH;
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  try {
    const p = createRequire(__filename)('ffmpeg-static') as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  return 'ffmpeg';
}

function findSource(): string | null {
  const env = process.env.CLIPFERN_FIXTURE_VIDEO;
  if (env && fs.existsSync(env)) return env;
  const dir = path.join(ROOT, 'test/fixtures');
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((n) => /\.(mp4|mov|mkv)$/i.test(n));
    if (f) return path.join(dir, f);
  }
  return null;
}

export const VIDEO_THUMBS = ['v1.jpg', 'v2.jpg', 'v3.jpg', 'v4.jpg', 'v5.jpg', 'v6.jpg'];
export const CLIP_THUMBS = [
  'c1.jpg',
  'c2.jpg',
  'c3.jpg',
  'c4.jpg',
  'c5.jpg',
  'c6.jpg',
  'c7.jpg',
  'c8.jpg',
  'c9.jpg',
];
/** WebM (VP9/Opus): the Chromium bundled with Playwright has no H.264, and the stub only needs *playable* media. */
export const CLIP_RENDERS = ['clip-a.webm', 'clip-b.webm', 'clip-c.webm'];
export const PROXY_FILE = 'proxy.webm';

export function ensureCp1Assets(): { dir: string; real: boolean } {
  const marker = path.join(ASSETS_DIR, MARKER);
  if (fs.existsSync(marker))
    return { dir: ASSETS_DIR, real: fs.readFileSync(marker, 'utf8') === 'real' };
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const ff = findFfmpeg();
  const run = (args: string[]) =>
    execFileSync(ff, ['-y', '-v', 'error', ...args], { stdio: 'pipe' });
  let src = findSource();
  const real = !!src;
  let dur = 170;
  if (!src) {
    src = path.join(ASSETS_DIR, 'source-synthetic.mp4');
    run([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=854x480:rate=30:duration=180',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=44100:duration=180',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      src,
    ]);
  } else {
    const out = execFileSync(findFfmpeg().replace(/ffmpeg$/, 'ffprobe'), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      src,
    ])
      .toString()
      .trim();
    dur = Math.max(30, Math.floor(Number(out)) - 6);
  }
  const at = (i: number, n: number) =>
    String(Math.round(8 + ((dur - 20) * i) / Math.max(n - 1, 1)));
  VIDEO_THUMBS.forEach((f, i) =>
    run([
      '-ss',
      at(i, VIDEO_THUMBS.length),
      '-i',
      src!,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:360:force_original_aspect_ratio=increase,crop=640:360',
      '-q:v',
      '4',
      path.join(ASSETS_DIR, f),
    ]),
  );
  CLIP_THUMBS.forEach((f, i) =>
    run([
      '-ss',
      at(CLIP_THUMBS.length - 1 - i, CLIP_THUMBS.length),
      '-i',
      src!,
      '-frames:v',
      '1',
      '-vf',
      'crop=ih*9/16:ih,scale=360:640',
      '-q:v',
      '4',
      path.join(ASSETS_DIR, f),
    ]),
  );
  const vp9 = [
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '42',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-row-mt',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
  ];
  CLIP_RENDERS.forEach((f, i) =>
    run([
      '-ss',
      String(12 + i * 40),
      '-t',
      '8',
      '-i',
      src!,
      '-vf',
      'crop=ih*9/16:ih,scale=360:640',
      ...vp9,
      path.join(ASSETS_DIR, f),
    ]),
  );
  run([
    '-ss',
    '0',
    '-t',
    String(Math.min(dur + 4, 180)),
    '-i',
    src!,
    '-vf',
    'scale=640:360',
    ...vp9,
    '-g',
    '30',
    path.join(ASSETS_DIR, PROXY_FILE),
  ]);
  fs.writeFileSync(marker, real ? 'real' : 'synthetic');
  return { dir: ASSETS_DIR, real };
}
