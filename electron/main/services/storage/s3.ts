import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutOptions, StorageProvider, StoredObject } from './provider';

export interface S3ProviderConfig {
  id: 'r2' | 'b2';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** s3rver / MinIO need path-style addressing. R2 and B2 work with either. */
  forcePathStyle?: boolean;
}

export class S3Provider implements StorageProvider {
  readonly id: 'r2' | 'b2';
  private client: S3Client;
  private bucket: string;

  constructor(cfg: S3ProviderConfig, clientOverride?: S3Client) {
    this.id = cfg.id;
    this.bucket = cfg.bucket;
    const clientCfg: S3ClientConfig = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle ?? cfg.id === 'b2',
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // R2 rejects the SDK's newer default CRC32 checksums on some operations.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.client = clientOverride ?? new S3Client(clientCfg);
  }

  async put(key: string, body: Buffer | Uint8Array | string, opts: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
  }

  async putFile(
    key: string,
    filePath: string,
    opts: PutOptions & { onProgress?: (loaded: number, total: number) => void } = {},
  ): Promise<void> {
    const size = (await fs.promises.stat(filePath)).size;
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: opts.contentType,
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    upload.on('httpUploadProgress', (p) => opts.onProgress?.(p.loaded ?? 0, p.total ?? size));
    await upload.done();
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty body for ${key}`);
    return Buffer.from(bytes);
  }

  async getStream(key: string, range?: { start: number; end?: number }): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async *list(prefix = ''): AsyncIterable<StoredObject> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (!o.Key) continue;
        yield {
          key: o.Key,
          size: Number(o.Size ?? 0),
          lastModified: o.LastModified ?? new Date(0),
        };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  presignGet(key: string, expiresSec = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSec,
    });
  }

  presignPut(key: string, expiresSec = 3600, contentType?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresSec },
    );
  }

  async check(): Promise<{ detail: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (e) {
      throw new Error(explainS3Error(e, this.bucket), { cause: e });
    }
    const probe = `.clipfern/probe-${Date.now()}.txt`;
    try {
      await this.put(probe, 'ok', { contentType: 'text/plain' });
      const back = (await this.get(probe)).toString('utf8');
      if (back !== 'ok') throw new Error('Read-back mismatch');
      await this.delete([probe]);
    } catch (e) {
      throw new Error(
        `Bucket reachable but write/read/delete probe failed: ${explainS3Error(e, this.bucket)}`,
        { cause: e },
      );
    }
    return { detail: `Bucket "${this.bucket}" reachable; write, read and delete verified.` };
  }
}

export function explainS3Error(e: unknown, bucket: string): string {
  const err = e as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    code?: string;
  };
  const status = err.$metadata?.httpStatusCode;
  if (
    status === 403 ||
    err.name === 'AccessDenied' ||
    err.name === 'SignatureDoesNotMatch' ||
    err.name === 'InvalidAccessKeyId'
  )
    return 'Access denied — check the access key id / secret and that the token has Object Read & Write on this bucket.';
  if (status === 404 || err.name === 'NoSuchBucket' || err.name === 'NotFound')
    return `Bucket "${bucket}" was not found — check the bucket name and account id/endpoint.`;
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')
    return `Cannot reach the storage endpoint (${err.code}) — check the account id / endpoint and your network.`;
  return err.message || err.name || 'Unknown storage error';
}

export function toNodeReadable(buf: Buffer): Readable {
  return Readable.from(buf);
}
