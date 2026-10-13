import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import { createCaptionService, fontBook, measureText } from '../../electron/main/services/captions';
import { readFaces } from '../../electron/main/services/captions/fontmeta';
import { SHIPPED_FACES } from '../../electron/main/services/captions/font-metrics';

const FONTS = path.resolve(__dirname, '../../electron/main/assets/fonts');
const ffmpeg = ffmpegPath as unknown as string;

describe('shipped fonts', () => {
  const files = fs.readdirSync(FONTS).filter((f) => f.endsWith('.ttf'));

  it('ship with an OFL licence text per family and stay small (< 3 MB in total)', () => {
    const total = files.reduce((n, f) => n + fs.statSync(path.join(FONTS, f)).size, 0);
    expect(total).toBeLessThan(3 * 1024 * 1024);
    for (const name of ['anton', 'bebasneue', 'poppins', 'dmserifdisplay', 'ibmplexmono']) {
      const txt = fs.readFileSync(path.join(FONTS, `OFL-${name}.txt`), 'utf8');
      expect(txt).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
    expect(fs.readFileSync(path.join(FONTS, 'OFL.txt'), 'utf8')).toContain('Montserrat');
  });

  it('the generated metrics table matches the font files (names, weights, advances)', () => {
    const fromFiles = files.flatMap((f) =>
      readFaces(path.join(FONTS, f)).map((p) => ({ f, p, m: p.loadMetrics() })),
    );
    expect(fromFiles.length).toBe(SHIPPED_FACES.length);
    for (const row of SHIPPED_FACES) {
      const hit = fromFiles.find((x) => x.f === row.file);
      expect(hit, row.file).toBeDefined();
      expect(hit?.p.names.family).toBe(row.assName);
      expect(hit?.p.names.weight).toBe(row.weight);
      const m = hit?.m;
      expect(m).not.toBeNull();
      expect(Math.round((m?.ascent ?? 0) * 1000)).toBe(row.ascent);
      expect(Math.round((m?.descent ?? 0) * 1000)).toBe(row.descent);
      for (let i = 0; i < 95; i++) {
        const a = m?.advance(0x20 + i);
        expect(a === null || a === undefined ? -1 : Math.round(a * 1000)).toBe(row.ascii[i]);
      }
    }
  });

  it('resolve picks the nearest weight of a family and reports the name libass matches', () => {
    expect(fontBook.resolve('Poppins', 800, false)?.assName).toBe('Poppins ExtraBold');
    expect(fontBook.resolve('Poppins', 600, false)?.assName).toBe('Poppins SemiBold');
    expect(fontBook.resolve('poppins', 700, false)?.weight).toBe(700);
    expect(fontBook.resolve('Poppins', 900, false)?.weight).toBe(800);
    expect(fontBook.resolve('Montserrat ExtraBold', 400, false)?.assName).toBe(
      'Montserrat ExtraBold',
    );
    expect(fontBook.resolve('No Such Family 123', 400, false)).toBeNull();
  });

  it('fonts() lists the shipped families with their weights', () => {
    const svc = createCaptionService();
    const list = svc.fonts(FONTS);
    const byFamily = new Map(list.map((f) => [f.family, f.weights]));
    expect(byFamily.get('Poppins')).toEqual([600, 700, 800]);
    expect(byFamily.get('Anton')).toEqual([400]);
    for (const fam of ['Montserrat', 'Bebas Neue', 'DM Serif Display', 'IBM Plex Mono']) {
      expect(byFamily.has(fam), fam).toBe(true);
    }
    // sorted, no duplicates
    const names = list.map((f) => f.family);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('ignores garbage / unsupported files in fontsDir without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-fonts-'));
    try {
      fs.copyFileSync(path.join(FONTS, 'Anton-Regular.ttf'), path.join(dir, 'MyAnton.ttf'));
      fs.writeFileSync(path.join(dir, 'broken.ttf'), 'not a font');
      fs.writeFileSync(path.join(dir, 'font.woff2'), 'wOF2....');
      // identical to a shipped face -> deduplicated; garbage ignored
      expect(fontBook.addDir(dir)).toHaveLength(0);
      expect(createCaptionService().fonts(dir).length).toBeGreaterThan(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('text measurement agrees with libass', () => {
  it('widths are within 2 % (+8 px) of the rendered ink width for every shipped face', () => {
    const texts = ['Hamburgefonstiv Rag', 'HAMBURGEFONSTIV RAG'];
    const faces = fontBook.known().filter((f) => f.shipped);
    const size = 90;
    const styles: string[] = [];
    const evs: string[] = [];
    const rows: { face: string; text: string; row: number }[] = [];
    let row = 0;
    for (const f of faces) {
      for (const t of texts) {
        styles.push(
          `Style: S${row},${f.assName},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${f.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
        );
        evs.push(
          `Dialogue: 0,0:00:00.00,0:00:05.00,S${row},,0,0,0,,{\\pos(20,${10 + row * 130})}${t}`,
        );
        rows.push({ face: f.assName, text: t, row });
        row++;
      }
    }
    const W = 1400;
    const H = row * 130 + 20;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipfern-meas-'));
    try {
      const header =
        `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n` +
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
      fs.writeFileSync(
        path.join(dir, 'm.ass'),
        `${header}${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${evs.join('\n')}\n`,
      );
      const raw = execFileSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=black:s=${W}x${H}:d=1`,
          '-vf',
          `ass=${path.join(dir, 'm.ass')}:fontsdir=${FONTS},format=gray`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ],
        { maxBuffer: W * H * 2 },
      );
      for (const r of rows) {
        const face = faces.find((f) => f.assName === r.face);
        let min = W;
        let max = 0;
        for (let y = r.row * 130; y < r.row * 130 + 130; y++) {
          for (let x = 0; x < W; x++) {
            if ((raw[y * W + x] ?? 0) > 100) {
              min = Math.min(min, x);
              max = Math.max(max, x);
            }
          }
        }
        const ink = max - min + 1;
        const predicted = measureText(face ?? null, r.text, size);
        expect(
          Math.abs(predicted - ink),
          `${r.face} "${r.text}" ink ${ink} vs predicted ${predicted}`,
        ).toBeLessThanOrEqual(predicted * 0.02 + 8);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
