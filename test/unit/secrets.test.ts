import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileKeyCipher, pickCipher, SecretStore } from '@main/services/secrets';
import { redact } from '@main/logger';
import { maskSecret } from '@shared/secrets';
import { tmpDir } from './helpers';

describe('SecretStore', () => {
  it('encrypts at rest and never stores plaintext', () => {
    const dir = tmpDir();
    const store = new SecretStore(
      path.join(dir, 's.bin'),
      new FileKeyCipher(path.join(dir, 'k')),
      {},
    );
    store.set('anthropic.apiKey', 'sk-ant-api03-SUPERSECRETVALUE1234');
    const raw = fs.readFileSync(path.join(dir, 's.bin'));
    expect(raw.toString('utf8')).not.toContain('SUPERSECRETVALUE');
    // survives restart
    const again = new SecretStore(
      path.join(dir, 's.bin'),
      new FileKeyCipher(path.join(dir, 'k')),
      {},
    );
    expect(again.get('anthropic.apiKey')).toBe('sk-ant-api03-SUPERSECRETVALUE1234');
  });

  it('status() exposes only a masked preview and the source', () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 's.bin'), new FileKeyCipher(path.join(dir, 'k')), {
      PEXELS_API_KEY: 'envpexelskey9999',
    });
    store.set('whop.apiKey', 'whop_abcdef123456');
    const st = store.status();
    expect(st['whop.apiKey']).toEqual({ set: true, masked: '••••3456', source: 'store' });
    expect(st['pexels.apiKey']).toEqual({ set: true, masked: '••••9999', source: 'env' });
    expect(st['pixabay.apiKey']).toEqual({ set: false, masked: null, source: null });
    expect(JSON.stringify(st)).not.toContain('abcdef');
  });

  it('stored value wins over .env, clear() falls back to .env', () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 's.bin'), new FileKeyCipher(path.join(dir, 'k')), {
      WHOP_API_KEY: 'fromenv',
    });
    expect(store.get('whop.apiKey')).toBe('fromenv');
    store.set('whop.apiKey', 'stored');
    expect(store.get('whop.apiKey')).toBe('stored');
    store.clear('whop.apiKey');
    expect(store.get('whop.apiKey')).toBe('fromenv');
  });

  it('recovers (empty) from a corrupt file instead of crashing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 's.bin'), 'garbage');
    const store = new SecretStore(
      path.join(dir, 's.bin'),
      new FileKeyCipher(path.join(dir, 'k')),
      {},
    );
    expect(store.get('whop.apiKey')).toBeNull();
  });

  it('pickCipher falls back when no OS keystore is available', () => {
    const dir = tmpDir();
    const c = pickCipher(
      {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      path.join(dir, 'k'),
    );
    expect(c.backend).toBe('insecure-fallback');
    const os = pickCipher(
      {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s),
        decryptString: (b) => b.toString(),
        getSelectedStorageBackend: () => 'gnome_libsecret',
      },
      path.join(dir, 'k2'),
    );
    expect(os.backend).toBe('os-keystore');
  });

  it('masks and redacts', () => {
    expect(maskSecret('abcdefgh')).toBe('••••efgh');
    expect(maskSecret('ab')).toBe('••••');
    expect(redact('key=sk-ant-api03-abcdefghijklmnop failed')).not.toContain('abcdefghijklmnop');
    expect(redact('Authorization: Bearer abcdef1234567890xyz')).toContain('[redacted]');
  });
});
