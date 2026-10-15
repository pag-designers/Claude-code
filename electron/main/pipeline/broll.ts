import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { Asset } from '@shared/editor';
import type { BrandAssetView, BrollItem } from '@shared/brand';
import { AppError } from '../ipc/dispatch';
import type { BrandService } from './brand';
import type { BrollService } from './contracts4';
import type { LlmServiceV2 } from './contracts2';
import type { EditorService } from './editor';

/** Stock clips are short; this only stops a wrong URL from filling the disk. */
const MAX_DOWNLOAD_BYTES = 600 * 2 ** 20;

export interface BrollHubDeps {
  broll: BrollService;
  brand: Pick<BrandService, 'addDownloadedVideo'>;
  editor: Pick<EditorService, 'importLocalVideo'>;
  llm: Pick<LlmServiceV2, 'suggestBroll'> & { isConfigured(): boolean };
  cacheDir: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  log: (m: string) => void;
}

/** Stock B-roll flow (BRIEF §11 CP4): search the official APIs, download a clip, add it to a project or a Brand Kit. */
export class BrollHub {
  constructor(private readonly d: BrollHubDeps) {}

  status() {
    return this.d.broll.status();
  }

  search(args: Parameters<BrollService['search']>[0]) {
    return this.d.broll.search(args);
  }

  async suggest(text: string): Promise<string[]> {
    if (!this.d.llm.isConfigured())
      throw new AppError('UNAVAILABLE', 'Add your Anthropic API key in Settings → API Keys.');
    return this.d.llm.suggestBroll({ text });
  }

  /** Downloads the provider's rendition into the cache; the caller owns (and removes) the file. */
  private async download(item: BrollItem): Promise<{
    file: string;
    credit: { source: string; author: string | null; url: string | null };
  }> {
    const dl = await this.d.broll.resolveDownload(item);
    const dir = path.join(this.d.cacheDir, 'broll');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${item.provider}-${randomBytes(5).toString('hex')}.${dl.ext}`);
    const res = await (this.d.fetch ?? fetch)(dl.url);
    if (!res.ok || !res.body)
      throw new AppError('FAILED', `${item.provider} could not deliver the clip (HTTP ${res.status}).`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_DOWNLOAD_BYTES)
      throw new AppError('FAILED', 'That clip is too large to import.');
    let seen = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_DOWNLOAD_BYTES) body.destroy(new Error('That clip is too large to import.'));
    });
    try {
      await streamPipeline(body, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw new AppError('FAILED', `The download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { file, credit: dl.credit };
  }

  private nameOf(item: BrollItem): string {
    const base = item.title.trim() || `${item.provider} clip`;
    return `${base} (${item.provider})`.slice(0, 120);
  }

  async importToProject(projectId: string, item: BrollItem): Promise<{ asset: Asset }> {
    const { file } = await this.download(item);
    try {
      return { asset: await this.d.editor.importLocalVideo(projectId, file, this.nameOf(item)) };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async importToKit(kitId: string, item: BrollItem): Promise<{ asset: BrandAssetView }> {
    const { file, credit } = await this.download(item);
    try {
      return {
        asset: await this.d.brand.addDownloadedVideo(kitId, {
          file,
          name: this.nameOf(item),
          credit,
        }),
      };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}
