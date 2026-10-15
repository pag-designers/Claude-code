import { describe, expect, it } from 'vitest';
import { SHIPPED_FACES } from '@main/services/captions/font-metrics';
import { builtinStyles } from '@main/services/captions/styles';
import fs from 'node:fs';
import path from 'node:path';
import {
  EDITOR_FONTS,
  libassFontSize,
  resolveEditorFace,
} from '../../renderer/lib/editor/compositor/fonts';
import {
  builtinCaptionStyles,
  resolveCaptionStyle,
} from '../../renderer/lib/editor/compositor/caption-presets';

const exportDir = path.resolve(__dirname, '../../electron/main/assets/fonts');
const previewDir = path.resolve(__dirname, '../../renderer/public/fonts/editor');

describe('editor fonts = exporter fonts', () => {
  it('EDITOR_FONTS lists exactly the shipped faces with the exporter metrics', () => {
    const flat = EDITOR_FONTS.flatMap((f) => f.faces.map((fc) => ({ family: f.family, ...fc })));
    expect(flat).toHaveLength(SHIPPED_FACES.length);
    for (const s of SHIPPED_FACES) {
      const e = flat.find((x) => x.file === s.file);
      expect(e, s.file).toBeDefined();
      expect(e).toMatchObject({ family: s.family, assName: s.assName, weight: s.weight });
      expect(e!.ascent).toBeCloseTo(s.ascent / 1000, 9);
      expect(e!.descent).toBeCloseTo(s.descent / 1000, 9);
      expect(e!.capHeight).toBeCloseTo(s.capHeight / 1000, 9);
    }
  });
  it('the preview copies are byte-identical to the exporter files (and ship their OFL texts)', () => {
    for (const f of fs.readdirSync(exportDir)) {
      const a = fs.readFileSync(path.join(exportDir, f));
      const b = fs.readFileSync(path.join(previewDir, f));
      expect(Buffer.compare(a, b), f).toBe(0);
    }
  });
  it('weights snap to the nearest shipped face (family match is case-insensitive, libass names work)', () => {
    expect(resolveEditorFace('poppins', 600)!.file).toBe('Poppins-SemiBold.ttf');
    expect(resolveEditorFace('Poppins', 750)!.weight).toBe(700); // nearest wins; ties → lighter (listed first)
    expect(resolveEditorFace('Poppins', 900)!.weight).toBe(800);
    expect(resolveEditorFace('Montserrat', 400)!.weight).toBe(800);
    expect(resolveEditorFace('Poppins ExtraBold', 400)!.weight).toBe(800);
    expect(resolveEditorFace('Comic Sans', 400)).toBeNull();
    expect(libassFontSize(100, resolveEditorFace('Anton', 400))).toBeCloseTo(173.3, 5);
  });
});

describe('caption presets copy', () => {
  it('equals electron/main/services/captions/styles.ts', () => {
    expect(builtinCaptionStyles()).toEqual(builtinStyles());
  });
  it('resolution order: override, custom, built-in, Clean Pop', () => {
    const custom = { ...builtinStyles()[1]!, id: 'mine', builtin: false };
    expect(resolveCaptionStyle('mine', null, [custom])).toBe(custom);
    expect(resolveCaptionStyle('hormozi-bold', null).id).toBe('hormozi-bold');
    expect(resolveCaptionStyle('nope', null).id).toBe('clean-pop');
    expect(resolveCaptionStyle('clean-pop', custom)).toBe(custom);
  });
});
