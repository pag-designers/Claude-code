/** H.264 encoder selection: a candidate is only "available" if it can actually encode a frame. */
import { runFfmpeg } from './ffmpeg';

export type EncoderName = 'libx264' | 'h264_nvenc' | 'h264_videotoolbox';

const CANDIDATES: EncoderName[] = ['h264_nvenc', 'h264_videotoolbox', 'libx264'];

/** Encoder-specific arguments (video only). */
export function encoderArgs(enc: EncoderName, fps: number): string[] {
  const gop = String(Math.max(12, Math.round(fps * 2)));
  switch (enc) {
    case 'h264_nvenc':
      return [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-tune',
        'hq',
        '-rc',
        'vbr',
        '-cq',
        '21',
        '-b:v',
        '0',
        '-maxrate',
        '14M',
        '-bufsize',
        '28M',
        '-profile:v',
        'high',
        '-g',
        gop,
      ];
    case 'h264_videotoolbox':
      return [
        '-c:v',
        'h264_videotoolbox',
        '-b:v',
        '10M',
        '-maxrate',
        '14M',
        '-profile:v',
        'high',
        '-allow_sw',
        '1',
        '-g',
        gop,
      ];
    default:
      return [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-profile:v',
        'high',
        '-g',
        gop,
      ];
  }
}

/** Encodes ONE synthetic frame with the encoder; true when ffmpeg exits 0. */
export async function canEncode(
  ffmpegPath: string,
  enc: EncoderName,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const r = await runFfmpeg(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=640x360:r=30:d=1',
        '-frames:v',
        '1',
        '-pix_fmt',
        'yuv420p',
        ...encoderArgs(enc, 30).slice(0, -2),
        '-f',
        'null',
        '-',
      ],
      { signal, timeoutMs: 20_000 },
    );
    return r.code === 0;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return false;
  }
}

const cache = new Map<string, Promise<EncoderName>>();

/** Cached per ffmpeg binary: nvenc -> videotoolbox -> libx264 (libx264 is the unconditional fallback). */
export function detectEncoder(ffmpegPath: string): Promise<EncoderName> {
  let p = cache.get(ffmpegPath);
  if (!p) {
    p = (async () => {
      for (const enc of CANDIDATES) {
        if (enc === 'libx264') return enc;
        if (await canEncode(ffmpegPath, enc)) return enc;
      }
      return 'libx264' as const;
    })();
    cache.set(ffmpegPath, p);
  }
  return p;
}

export function clearEncoderCache(): void {
  cache.clear();
}
