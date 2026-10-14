import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServices, type Emitters, type Services } from '@main/services/context';
import { FileKeyCipher } from '@main/services/secrets';
import { captionStyleSchema, type CaptionStyle } from '@shared/cp2';

export function tmpDir(prefix = 'clipfern-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const noopEmit: Emitters = {
  notification: () => {},
  job: () => {},
  storage: () => {},
  settings: () => {},
  osNotify: () => {},
  pipeline: () => {},
  video: () => {},
  clip: () => {},
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

/** A complete valid caption preset for tests that need one. */
export const FAKE_STYLE: CaptionStyle = captionStyleSchema.parse({
  id: 'clean-pop',
  name: 'Clean Pop',
  builtin: true,
  font: { family: 'Montserrat ExtraBold' },
  fill: '#FFFFFF',
  stroke: { color: '#000000' },
  shadow: { color: '#000000' },
  box: { color: '#000000' },
  highlight: { color: '#FFD60A', boxColor: '#FFD60A' },
  keywordColor: '#FFD60A',
  layout: {},
  chunking: {},
});
