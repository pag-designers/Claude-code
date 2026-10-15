import fs from 'node:fs';
import path from 'node:path';
import type { OAuthTokens } from '../../pipeline/contracts5';
import type { Cipher } from '../secrets';

/**
 * OAuth tokens per connected account, encrypted with the same cipher as the secret store (OS keystore via
 * safeStorage, ADR-006) in one blob `tokens.bin`. Main-process only: the renderer never sees a token, only the
 * account row (name, status).
 */
export class TokenStore {
  private data: Record<string, OAuthTokens> = {};

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(this.cipher.decrypt(fs.readFileSync(this.file))) as unknown;
      this.data = parsed && typeof parsed === 'object' ? (parsed as Record<string, OAuthTokens>) : {};
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

  get(accountId: string): OAuthTokens | null {
    return this.data[accountId] ?? null;
  }

  set(accountId: string, tokens: OAuthTokens): void {
    this.data[accountId] = tokens;
    this.persist();
  }

  delete(accountId: string): void {
    if (!(accountId in this.data)) return;
    delete this.data[accountId];
    this.persist();
  }

  has(accountId: string): boolean {
    return accountId in this.data;
  }
}
