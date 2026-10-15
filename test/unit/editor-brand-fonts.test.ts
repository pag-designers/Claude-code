import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIPPED_FACES } from '@main/services/captions/font-metrics';
import { readFaces } from '@main/services/captions/fontmeta';
import { readFaceMetrics } from '../../renderer/lib/editor/compositor/fonts';

const dir = path.resolve(__dirname, '../../electron/main/assets/fonts');
const arrayBuffer = (file: string): ArrayBuffer => {
  const b = fs.readFileSync(path.join(dir, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * Brand fonts are laid out in the preview with metrics read in the renderer. They must be the numbers the exporter's
 * font book uses (libass cell: OS/2 win metrics), or a brand font would sit differently in the preview and the export.
 */
describe('readFaceMetrics = the exporter font book', () => {
  for (const f of SHIPPED_FACES)
    it(`${f.file}: ascent ${f.ascent}, descent ${f.descent}, cap height ${f.capHeight}`, () => {
      const m = readFaceMetrics(arrayBuffer(f.file));
      expect(m).not.toBeNull();
      expect(m!.ascent).toBeCloseTo(f.ascent / 1000, 3);
      expect(m!.descent).toBeCloseTo(f.descent / 1000, 3);
      expect(m!.capHeight).toBeCloseTo(f.capHeight / 1000, 3);
    });
  it('agrees with fontmeta.loadFace on the raw file', () => {
    for (const f of SHIPPED_FACES) {
      const face = readFaces(path.join(dir, f.file))[0];
      const a = readFaceMetrics(arrayBuffer(f.file));
      const b = face?.loadMetrics();
      expect(b).toBeTruthy();
      expect(a!.ascent).toBeCloseTo(b!.ascent, 6);
      expect(a!.descent).toBeCloseTo(b!.descent, 6);
      expect(a!.capHeight).toBeCloseTo(b!.capHeight, 6);
    }
  });
  it('rejects things that are not an sfnt, without throwing', () => {
    expect(readFaceMetrics(new ArrayBuffer(0))).toBeNull();
    expect(
      readFaceMetrics(new TextEncoder().encode('wOF2 not a font at all').buffer as ArrayBuffer),
    ).toBeNull();
    expect(readFaceMetrics(new Uint8Array([0, 1, 0, 0, 0, 99]).buffer as ArrayBuffer)).toBeNull();
  });
});
