import { Readable } from 'node:stream';
import fs from 'node:fs';
import type { PutOptions, StorageProvider, StoredObject } from './provider';

/** In-memory StorageProvider used by unit tests and as a reference implementation. */
export class MemoryStorageProvider implements StorageProvider {
  readonly id = 'memory' as const;
  readonly objects = new Map<string, { body: Buffer; contentType?: string; lastModified: Date }>();

  async put(key: string, body: Buffer | Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    this.objects.set(key, {
      body: Buffer.from(body as Uint8Array),
      contentType: opts.contentType,
      lastModified: new Date(),
    });
  }

  async putFile(key: string, filePath: string, opts: PutOptions = {}): Promise<void> {
    await this.put(key, await fs.promises.readFile(filePath), opts);
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return o.body;
  }

  async getStream(key: string, range?: { start: number; end?: number }): Promise<Readable> {
    const b = await this.get(key);
    return Readable.from(range ? b.subarray(range.start, (range.end ?? b.length - 1) + 1) : b);
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
  }

  async *list(prefix = ''): AsyncIterable<StoredObject> {
    for (const [key, o] of [...this.objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(prefix)) yield { key, size: o.body.length, lastModified: o.lastModified };
    }
  }

  async presignGet(key: string, expiresSec = 3600): Promise<string> {
    return `memory://${key}?expires=${expiresSec}`;
  }

  async presignPut(key: string, expiresSec = 3600): Promise<string> {
    return `memory://${key}?put&expires=${expiresSec}`;
  }

  async check(): Promise<{ detail: string }> {
    return { detail: 'memory provider' };
  }
}
