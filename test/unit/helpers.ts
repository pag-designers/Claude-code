import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServices, type Emitters, type Services } from '@main/services/context';
import { FileKeyCipher } from '@main/services/secrets';

export function tmpDir(prefix = 'clipfern-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const noopEmit: Emitters = {
  notification: () => {},
  job: () => {},
  storage: () => {},
  settings: () => {},
  osNotify: () => {},
};

export async function makeServices(
  over: { env?: Record<string, string | undefined>; emit?: Partial<Emitters> } = {},
): Promise<{ svc: Services; dir: string; cleanup: () => Promise<void> }> {
  const dir = tmpDir();
  const svc = await createServices({
    userDataDir: dir,
    dbPath: path.join(dir, 'test.db'),
    cipher: new FileKeyCipher(path.join(dir, 'k')),
    emit: { ...noopEmit, ...over.emit },
    env: over.env ?? {},
  });
  return {
    svc,
    dir,
    cleanup: async () => {
      await svc.queue.stop();
      await svc.dbHandle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
