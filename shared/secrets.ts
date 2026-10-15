import { z } from 'zod';

/** Every secret the app can hold. Secrets live ONLY in the main process (see ADR-006). */
export const SECRET_KEYS = [
  'anthropic.apiKey',
  'r2.accessKeyId',
  'r2.secretAccessKey',
  'b2.keyId',
  'b2.applicationKey',
  'whop.apiKey',
  'pexels.apiKey',
  'pixabay.apiKey',
  'google.clientId',
  'google.clientSecret',
  'meta.appId',
  'meta.appSecret',
  'tiktok.clientKey',
  'tiktok.clientSecret',
] as const;

export const secretKeySchema = z.enum(SECRET_KEYS);
export type SecretKey = z.infer<typeof secretKeySchema>;

/** `.env` variable that supplies a default for each secret (dev convenience, shown as "from .env"). */
export const SECRET_ENV_VARS: Record<SecretKey, string> = {
  'anthropic.apiKey': 'ANTHROPIC_API_KEY',
  'r2.accessKeyId': 'R2_ACCESS_KEY_ID',
  'r2.secretAccessKey': 'R2_SECRET_ACCESS_KEY',
  'b2.keyId': 'B2_KEY_ID',
  'b2.applicationKey': 'B2_APPLICATION_KEY',
  'whop.apiKey': 'WHOP_API_KEY',
  'pexels.apiKey': 'PEXELS_API_KEY',
  'pixabay.apiKey': 'PIXABAY_API_KEY',
  'google.clientId': 'GOOGLE_OAUTH_CLIENT_ID',
  'google.clientSecret': 'GOOGLE_OAUTH_CLIENT_SECRET',
  'meta.appId': 'META_APP_ID',
  'meta.appSecret': 'META_APP_SECRET',
  'tiktok.clientKey': 'TIKTOK_CLIENT_KEY',
  'tiktok.clientSecret': 'TIKTOK_CLIENT_SECRET',
};

export const secretStatusSchema = z.object({
  set: z.boolean(),
  /** Masked preview (e.g. "••••a1b2"); computed in main, the secret itself never crosses IPC. */
  masked: z.string().nullable(),
  source: z.enum(['store', 'env']).nullable(),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

export const secretsBackendSchema = z.enum(['os-keystore', 'insecure-fallback']);
export type SecretsBackend = z.infer<typeof secretsBackendSchema>;

export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}
