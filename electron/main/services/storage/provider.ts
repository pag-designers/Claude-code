import type { Readable } from 'node:stream';

/** Swappable object storage (BRIEF §3, ADR-007). Keys are POSIX-style paths, e.g. `videos/<id>/proxy.mp4`. */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface PutOptions {
  contentType?: string;
}

export interface StorageProvider {
  readonly id: 'r2' | 'b2' | 'memory';
  put(key: string, body: Buffer | Uint8Array | string, opts?: PutOptions): Promise<void>;
  /** Streams a local file with multipart upload so multi-GB sources work. */
  putFile(
    key: string,
    filePath: string,
    opts?: PutOptions & { onProgress?: (loaded: number, total: number) => void },
  ): Promise<void>;
  get(key: string): Promise<Buffer>;
  getStream(key: string, range?: { start: number; end?: number }): Promise<Readable>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix?: string): AsyncIterable<StoredObject>;
  presignGet(key: string, expiresSec?: number): Promise<string>;
  presignPut(key: string, expiresSec?: number, contentType?: string): Promise<string>;
  /** Throws a descriptive Error when credentials / bucket / endpoint are wrong. */
  check(): Promise<{ detail: string }>;
}

export const STORAGE_CATEGORY_PREFIXES = [
  'videos',
  'clips',
  'renders',
  'assets',
  'thumbs',
] as const;

export function categoryOf(
  key: string,
): 'videos' | 'clips' | 'renders' | 'assets' | 'thumbs' | 'other' {
  const first = key.split('/')[0] ?? '';
  return (STORAGE_CATEGORY_PREFIXES as readonly string[]).includes(first)
    ? (first as (typeof STORAGE_CATEGORY_PREFIXES)[number])
    : 'other';
}
