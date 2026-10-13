/**
 * Opt-in integration test of POST /frames/score through the real Python sidecar. Needs a prepared sidecar
 * environment (venv + MediaPipe face model):
 *
 *   CLIPFERN_E2E_SIDECAR_USERDATA=<userData with sidecar-venv + models + uv> \
 *   [CLIPFERN_FACE_VIDEO=<mp4 with a face>] pnpm exec vitest run test/unit/thumbnails-sidecar.test.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidecarManager, SidecarHttpError } from '../../electron/main/services/sidecar';
import { createThumbnailService } from '../../electron/main/services/thumbnails';

const USERDATA = process.env.CLIPFERN_E2E_SIDECAR_USERDATA;
const FACE_VIDEO = process.env.CLIPFERN_FACE_VIDEO;
const FFMPEG = path.resolve(__dirname, '../../node_modules/ffmpeg-static/ffmpeg');

describe.skipIf(!USERDATA || !fs.existsSync(FFMPEG))('/frames/score (real sidecar)', () => {
  let dir = '';
  let sidecar: SidecarManager;
  const ff = (args: string[]) =>
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });

  beforeAll(async () => {
    http.globalAgent = new http.Agent({ keepAlive: false }); // Node's 5 s idle timeout vs a cold model load
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-frames-'));
    sidecar = new SidecarManager({
      userDataDir: USERDATA as string,
      sidecarSrcDir: path.resolve(__dirname, '../../sidecar'),
      getModel: () => 'tiny',
      getDevicePref: () => 'auto',
      log: () => {},
      onStatus: () => {},
    });
    await sidecar.start();
  }, 180_000);
  afterAll(async () => {
    await sidecar?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scores sharpness / brightness / contrast, batches, and returns one entry per file in order', async () => {
    const flat = path.join(dir, 'flat.jpg');
    const busy = path.join(dir, 'busy.jpg');
    const dark = path.join(dir, 'dark.jpg');
    ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360', '-frames:v', '1', flat]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', '-ss', '1', busy]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x050505:s=320x180', '-frames:v', '1', dark]);
    const res = await sidecar.scoreFrames([flat, busy, dark]);
    expect(res.map((r) => r.file)).toEqual([flat, busy, dark]);
    expect(res[1]!.sharpness).toBeGreaterThan(res[0]!.sharpness + 50);
    expect(res[0]!.brightness).toBeCloseTo(0.5, 1);
    expect(res[2]!.brightness).toBeLessThan(0.1);
    expect(res[0]!.faces).toEqual([]);
    expect([res[2]!.width, res[2]!.height]).toEqual([320, 180]);
  }, 60_000);

  it('8 frames in about a second once warm; errors are clear (404 missing file, 422 unreadable)', async () => {
    const files: string[] = [];
    for (let i = 0; i < 8; i++) {
      const f = path.join(dir, `t${i}.jpg`);
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280', '-frames:v', '1', '-ss', String(i * 0.3), f]);
      files.push(f);
    }
    await sidecar.scoreFrames(files.slice(0, 1)); // warm
    const t0 = Date.now();
    const res = await sidecar.scoreFrames(files);
    const ms = Date.now() - t0;
    expect(res).toHaveLength(8);
    expect(ms).toBeLessThan(5000);
    await expect(sidecar.scoreFrames([path.join(dir, 'nope.jpg')])).rejects.toMatchObject({
      status: 404,
    });
    const junk = path.join(dir, 'junk.jpg');
    fs.writeFileSync(junk, 'not an image');
    await expect(sidecar.scoreFrames([junk])).rejects.toBeInstanceOf(SidecarHttpError);
  }, 120_000);

  it.skipIf(!FACE_VIDEO)(
    'finds faces and the thumbnail service picks the sharp, framed one',
    async () => {
      const svc = createThumbnailService();
      const frames = await svc.sample({
        ffmpegPath: FFMPEG,
        clipPath: FACE_VIDEO as string,
        durationSec: 20,
        hookSeconds: 0,
        count: 6,
        outDir: path.join(dir, 'cand'),
      });
      const scored = await svc.score(frames, (files, signal) =>
        sidecar.scoreFrames(files, { signal }),
      );
      expect(scored.some((s) => s.face > 0.5)).toBe(true);
      expect(scored.every((s) => s.total >= 0 && s.total <= 1)).toBe(true);
    },
    120_000,
  );
});
