/**
 * TEST-ONLY media for the playback/preview specs. Playwright's Chromium has no H.264, so everything is VP9/Opus WebM.
 *
 *  clip.webm   6 s, 320×568 @30: a white 40 px square on a dark background whose LEFT EDGE is at x = 45·t (so the frame
 *              shown can be read back from pixels: t = (x − 20)/45 at the square's centre), plus a 1 kHz tone;
 *  tone.wav    8 s mono 440 Hz (music);
 *  pic.png     256×256 test card;
 *  nosound.webm  3 s of the same picture without an audio stream.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '../../..');
const MARKER = '.ready-v2';
export const SQUARE = { size: 40, perSec: 45, srcW: 320, srcH: 568 };
/** Source time represented by a square whose centre is at normalised x (0..1 of the frame width). */
export const timeFromX = (xNorm: number): number =>
  (xNorm * SQUARE.srcW - SQUARE.size / 2) / SQUARE.perSec;
export const xFromTime = (t: number): number => (t * SQUARE.perSec + SQUARE.size / 2) / SQUARE.srcW;

function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH))
    return process.env.FFMPEG_PATH;
  try {
    const p = createRequire(__filename)('ffmpeg-static') as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

export function ensurePlaybackMedia(
  dir = process.env.CLIPFERN_PLAYBACK_MEDIA ?? path.join(ROOT, '.tmp/playback-media'),
): string {
  const marker = path.join(dir, MARKER);
  if (fs.existsSync(marker)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const ff = findFfmpeg();
  const run = (args: string[]) =>
    execFileSync(ff, ['-y', '-v', 'error', ...args], { stdio: 'pipe' });
  const picture = (d: number) => [
    '-f',
    'lavfi',
    '-i',
    `color=c=0x303040:s=320x568:r=30:d=${d}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=40x40:r=30:d=${d}`,
  ];
  const overlay = "[0][1]overlay=x='t*45':y=264:eval=frame,format=yuv420p[v]";
  const vp9 = [
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '500k',
    '-g',
    '10',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-row-mt',
    '1',
  ];
  run([
    ...picture(6),
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000:duration=6',
    '-filter_complex',
    overlay,
    '-map',
    '[v]',
    '-map',
    '2:a',
    ...vp9,
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-shortest',
    path.join(dir, 'clip.webm'),
  ]);
  run([
    ...picture(3),
    '-filter_complex',
    overlay,
    '-map',
    '[v]',
    ...vp9,
    '-an',
    path.join(dir, 'nosound.webm'),
  ]);
  run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=24000:duration=8',
    '-ac',
    '1',
    path.join(dir, 'tone.wav'),
  ]);
  run(['-f', 'lavfi', '-i', 'testsrc2=s=256x256:d=1', '-frames:v', '1', path.join(dir, 'pic.png')]);
  fs.writeFileSync(marker, 'ok');
  return dir;
}
