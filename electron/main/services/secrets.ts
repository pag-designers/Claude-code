import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  maskSecret,
  SECRET_ENV_VARS,
  SECRET_KEYS,
  type SecretKey,
  type SecretsBackend,
  type SecretStatus,
} from '@shared/secrets';

/** Encrypts/decrypts opaque strings. Backed by Electron safeStorage in the app (ADR-006). */
export interface Cipher {
  readonly backend: SecretsBackend;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * Fallback for machines with no OS keystore (headless Linux). AES-256-GCM with a random
 * per-install key kept in a 0600 file next to the data. It is obfuscation, not protection from
 * a local attacker, so the UI shows a warning whenever it is active.
 */
export class FileKeyCipher implements Cipher {
  readonly backend = 'insecure-fallback' as const;
  private key: Buffer;

  constructor(keyFile: string) {
    if (fs.existsSync(keyFile)) {
      this.key = fs.readFileSync(keyFile);
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, this.key, { mode: 0o600 });
    }
  }

  encrypt(plain: string): Buffer {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]);
  }

  decrypt(data: Buffer): string {
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const enc = data.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

export class OsKeystoreCipher implements Cipher {
  readonly backend = 'os-keystore' as const;
  constructor(private readonly ss: SafeStorageLike) {}
  encrypt(plain: string): Buffer {
    return this.ss.encryptString(plain);
  }
  decrypt(data: Buffer): string {
    return this.ss.decryptString(data);
  }
}

/** Picks the OS keystore when usable. On Linux, `basic_text` means "no real keyring". */
export function pickCipher(ss: SafeStorageLike | null, fallbackKeyFile: string): Cipher {
  if (ss && ss.isEncryptionAvailable()) {
    const linuxBackend = ss.getSelectedStorageBackend?.();
    if (!(
      process.platform === 'linux' &&
      (linuxBackend === 'basic_text' || linuxBackend === 'unknown')
    )) {
      return new OsKeystoreCipher(ss);
    }
  }
  return new FileKeyCipher(fallbackKeyFile);
}

type Env = Record<string, string | undefined>;

/**
 * Secret store: one encrypted JSON blob in `secrets.bin`. Values never leave this class except
 * through `get()` (main-process callers only) — the renderer gets `status()` (masked) only.
 */
export class SecretStore {
  private data: Partial<Record<SecretKey, string>> = {};

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly env: Env = process.env,
  ) {
    this.load();
  }

  get backend(): SecretsBackend {
    return this.cipher.backend;
  }

  private load(): void {
    try {
      const buf = fs.readFileSync(this.file);
      this.data = JSON.parse(this.cipher.decrypt(buf)) as Partial<Record<SecretKey, string>>;
    } catch {
      this.data = {};
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(this.data)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Main-process only. Stored value wins over `.env`. */
  get(key: SecretKey): string | null {
    const stored = this.data[key];
    if (stored) return stored;
    const fromEnv = this.env[SECRET_ENV_VARS[key]];
    return fromEnv ? fromEnv : null;
  }

  set(key: SecretKey, value: string): void {
    this.data[key] = value.trim();
    this.persist();
  }

  clear(key: SecretKey): void {
    delete this.data[key];
    this.persist();
  }

  status(): Record<SecretKey, SecretStatus> {
    const out = {} as Record<SecretKey, SecretStatus>;
    for (const key of SECRET_KEYS) {
      const stored = this.data[key];
      const envVal = this.env[SECRET_ENV_VARS[key]];
      const value = stored || envVal || null;
      out[key] = {
        set: !!value,
        masked: value ? maskSecret(value) : null,
        source: stored ? 'store' : envVal ? 'env' : null,
      };
    }
    return out;
  }
}
