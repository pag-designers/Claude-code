/**
 * FILE_UPLOAD chunk planning and reading.
 * Rules (media transfer guide, https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide, 2026-10-15):
 *  - chunk 5..64 MB, sequential; the FINAL chunk may be larger (up to 128 MB) to absorb the remainder;
 *  - total_chunk_count = floor(video_size / chunk_size) (min 1, max 1000); files < 5 MB go up whole;
 *  - max video size 4 GB; PUT with Content-Range `bytes FIRST-LAST/TOTAL`; 206 = more expected, 201 = done.
 * The guide does not say whether "MB" is 10^6 or 2^20: the default 10 000 000 bytes is inside both readings
 * (>= 5 * 2^20 and <= 64 * 10^6).
 */
import fs from 'node:fs/promises';

export const DEFAULT_CHUNK_BYTES = 10_000_000;
export const MAX_VIDEO_BYTES = 4 * 1024 ** 3;
export const MAX_CHUNKS = 1000;

export interface ChunkPlan {
  videoSize: number;
  chunkSize: number;
  totalChunkCount: number;
  /** Inclusive byte ranges, in upload order. */
  ranges: { start: number; end: number }[];
}

export function planChunks(videoSize: number, preferred = DEFAULT_CHUNK_BYTES): ChunkPlan {
  if (!Number.isInteger(videoSize) || videoSize <= 0) throw new RangeError('empty video');
  let chunkSize = preferred;
  let count: number;
  if (videoSize < preferred) {
    chunkSize = videoSize;
    count = 1;
  } else {
    count = Math.floor(videoSize / preferred);
    if (count > MAX_CHUNKS) {
      chunkSize = Math.ceil(videoSize / MAX_CHUNKS);
      count = Math.floor(videoSize / chunkSize);
    }
  }
  const ranges: ChunkPlan['ranges'] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    ranges.push({ start, end: i === count - 1 ? videoSize - 1 : start + chunkSize - 1 });
  }
  return { videoSize, chunkSize, totalChunkCount: count, ranges };
}

export async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const len = end - start + 1;
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, len - off, start + off);
      if (bytesRead === 0) throw new Error('video file is shorter than expected');
      off += bytesRead;
    }
    return buf;
  } finally {
    await fh.close();
  }
}

/** `bytes 0-1234/5678` -> bytes the server holds so far (1235) or null. */
export function receivedFromContentRange(header: string | null): number | null {
  if (!header) return null;
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(header);
  if (!m) return null;
  return Number(m[2]) + 1;
}
