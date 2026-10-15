import type { Settings } from '@shared/settings';
import type { SecretStore } from '../secrets';
import type { StorageProvider } from './provider';
import { S3Provider } from './s3';

export type ProviderResolution =
  { ok: true; provider: StorageProvider } | { ok: false; reason: string };

/** Builds the active StorageProvider from non-secret settings + secrets, or explains what's missing. */
export function resolveStorageProvider(
  settings: Settings,
  secrets: SecretStore,
): ProviderResolution {
  // Dev/test only: point at an S3-compatible emulator (e.g. s3rver). Never needed in production.
  const override = process.env.CLIPFERN_S3_ENDPOINT_OVERRIDE;
  if (override) {
    const accessKeyId = secrets.get('r2.accessKeyId') ?? 'S3RVER';
    const secretAccessKey = secrets.get('r2.secretAccessKey') ?? 'S3RVER';
    const bucket = settings.r2Bucket.trim() || settings.b2Bucket.trim();
    if (!bucket)
      return { ok: false, reason: 'Storage override is set but no bucket name is configured.' };
    return {
      ok: true,
      provider: new S3Provider({
        id: 'r2',
        endpoint: override,
        region: 'us-east-1',
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: true,
      }),
    };
  }
  if (settings.storageProvider === 'r2') {
    const accessKeyId = secrets.get('r2.accessKeyId');
    const secretAccessKey = secrets.get('r2.secretAccessKey');
    const missing = [
      !settings.r2AccountId && 'Account ID',
      !settings.r2Bucket && 'Bucket',
      !accessKeyId && 'Access Key ID',
      !secretAccessKey && 'Secret Access Key',
    ].filter(Boolean);
    if (missing.length || !accessKeyId || !secretAccessKey)
      return { ok: false, reason: `Cloudflare R2 is missing: ${missing.join(', ')}` };
    return {
      ok: true,
      provider: new S3Provider({
        id: 'r2',
        endpoint: `https://${settings.r2AccountId.trim()}.r2.cloudflarestorage.com`,
        region: 'auto',
        bucket: settings.r2Bucket.trim(),
        accessKeyId,
        secretAccessKey,
      }),
    };
  }
  const keyId = secrets.get('b2.keyId');
  const appKey = secrets.get('b2.applicationKey');
  const missing = [
    !settings.b2Endpoint && 'Endpoint',
    !settings.b2Bucket && 'Bucket',
    !keyId && 'Key ID',
    !appKey && 'Application Key',
  ].filter(Boolean);
  if (missing.length || !keyId || !appKey)
    return { ok: false, reason: `Backblaze B2 is missing: ${missing.join(', ')}` };
  const endpoint = /^https?:\/\//.test(settings.b2Endpoint)
    ? settings.b2Endpoint
    : `https://${settings.b2Endpoint}`;
  const region = settings.b2Region || /s3\.([^.]+)\./.exec(endpoint)?.[1] || 'us-west-004';
  return {
    ok: true,
    provider: new S3Provider({
      id: 'b2',
      endpoint,
      region,
      bucket: settings.b2Bucket.trim(),
      accessKeyId: keyId,
      secretAccessKey: appKey,
    }),
  };
}
