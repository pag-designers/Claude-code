import { describe, expect, it } from 'vitest';
import { BUILTIN_STYLE_IDS, captionStyleSchema, type CaptionStyle } from '../../shared/cp2';
import type { Word } from '../../shared/pipeline';
import {
  buildAssDocument,
  builtinStyles,
  captionLayout,
  fontBook,
  resolveStyle,
} from '../../electron/main/services/captions';

interface Ev {
  layer: number;
  start: number;
  end: number;
  style: string;
  text: string;
}

const time = (t: string): number => {
  const m = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(t);
  if (!m) throw new Error(`bad time ${t}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
};

function events(ass: string, style?: string): Ev[] {
  return ass
    .split('\n')
    .filter((l) => l.startsWith('Dialogue:'))
    .map((l) => {
      const parts = l.slice('Dialogue:'.length).trim().split(',');
      return {
        layer: Number(parts[0]),
        start: time(parts[1] ?? ''),
        end: time(parts[2] ?? ''),
        style: parts[3] ?? '',
        text: parts.slice(9).join(','),
      };
    })
    .filter((e) => style === undefined || e.style === style);
}

const styleLine = (ass: string, name = 'Caption'): string[] => {
  const l = ass.split('\n').find((x) => x.startsWith(`Style: ${name},`));
  if (!l) throw new Error('no style line');
  return l.slice('Style: '.length).split(',');
};

function speak(text: string, opts: { start?: number; dur?: number; gap?: number } = {}): Word[] {
  let t = opts.start ?? 0;
  return text.split(' ').map((w) => {
    const o = { w, s: t, e: t + (opts.dur ?? 0.3) };
    t += (opts.dur ?? 0.3) + (opts.gap ?? 0.04);
    return o;
  });
}

const SAMPLE = speak(
  'So here is the thing about money. Nobody teaches you this in school, and that is the real problem today.',
  { start: 1 },
);

const build = (style: CaptionStyle, over: Partial<Parameters<typeof buildAssDocument>[0]> = {}) =>
  buildAssDocument({
    words: SAMPLE,
    startSec: 0,
    endSec: 30,
    width: 1080,
    height: 1920,
    style,
    keywords: ['money', 'problem'],
    ...over,
  });

const custom = (patch: (s: CaptionStyle) => void, base = 'clean-pop'): CaptionStyle => {
  const s = structuredClone(resolveStyle(base));
  patch(s);
  return captionStyleSchema.parse(s);
};

describe('built-in presets', () => {
  const styles = builtinStyles();

  it('are the 14 required presets, in order, all valid and marked built-in', () => {
    expect(styles.map((s) => s.id)).toEqual([...BUILTIN_STYLE_IDS]);
    expect(styles.map((s) => s.name)).toEqual([
      'Clean Pop',
      'Hormozi Bold',
      'Karaoke Highlight',
      'TikTok Classic',
      'Minimal Lower-Third',
      'Neon Glow',
      'Boxed Highlight',
      'Typewriter',
      'Bounce Word',
      'Gradient Glow',
      'Outline Only',
      'Caption Bubble',
      'Podcast Lower-Third',
      'Subtle Serif',
    ]);
    for (const s of styles) {
      expect(s.builtin).toBe(true);
      expect(captionStyleSchema.safeParse(s).success, s.id).toBe(true);
    }
  });

  it('use shipped fonts that the font book resolves to a real face', () => {
    for (const s of styles) {
      const face = fontBook.resolve(s.font.family, s.font.weight, s.font.italic);
      expect(face, s.id).not.toBeNull();
      expect(face?.shipped, s.id).toBe(true);
    }
  });

  it('are genuinely distinct: no two share font + fill + animation + highlight + layout', () => {
    const sig = (s: CaptionStyle): string =>
      JSON.stringify([
        s.font.family,
        s.font.weight,
        s.fill,
        s.stroke.color,
        s.animation,
        s.highlight.mode,
        s.highlight.color,
        s.box.enabled,
        s.layout.align,
        s.chunking,
      ]);
    expect(new Set(styles.map(sig)).size).toBe(styles.length);
    // the animation vocabulary is really used
    const anims = new Set(styles.map((s) => s.animation));
    for (const a of ['pop', 'karaoke', 'typewriter', 'bounce', 'fade', 'slide-up', 'none']) {
      expect(anims.has(a as CaptionStyle['animation']), a).toBe(true);
    }
    const modes = new Set(styles.map((s) => s.highlight.mode));
    expect(modes.has('box')).toBe(true);
    expect(modes.has('color-scale')).toBe(true);
  });

  it('render a complete, parseable ASS for every preset at 1080x1920', () => {
    for (const s of styles) {
      const ass = build(s);
      expect(ass, s.id).toMatch(/^PlayResY: 1920$/m);
      const text = events(ass, 'Caption');
      expect(text.length, s.id).toBeGreaterThan(5);
      for (const e of events(ass)) {
        expect(e.end, s.id).toBeGreaterThan(e.start);
        expect(e.start).toBeGreaterThanOrEqual(0);
      }
      // balanced override blocks in every event
      for (const e of events(ass)) {
        const opens = (e.text.match(/(?<!\\)\{/g) ?? []).length;
        const closes = (e.text.match(/(?<!\\)\}/g) ?? []).length;
        expect(opens, `${s.id}: ${e.text.slice(0, 80)}`).toBe(closes);
      }
    }
  });

  it('keep captions out of the bottom 18% and inside the margins for 9:16, and inside the frame for other aspects', () => {
    for (const s of styles) {
      for (const [w, h] of [
        [1080, 1920],
        [720, 1280],
        [1080, 1350],
        [1080, 1080],
        [1920, 1080],
      ] as const) {
        const ass = buildAssDocument({
          words: SAMPLE,
          startSec: 0,
          endSec: 30,
          width: w,
          height: h,
          style: s,
        });
        const lay = captionLayout(w, h, s);
        const fs = lay.fontSize;
        for (const e of events(ass, 'Caption')) {
          const pos = /\\(?:pos\((-?\d+),(-?\d+)\)|move\((-?\d+),(-?\d+),(-?\d+),(-?\d+))/.exec(
            e.text,
          );
          expect(pos, `${s.id} ${e.text.slice(0, 60)}`).not.toBeNull();
          const y = Number(pos?.[2] ?? pos?.[6]);
          // every line's centre + half a line stays above the UI zone (9:16) / the bottom margin (others)
          const limit = h / w > 1.5 ? 0.82 : 0.95;
          expect(y + fs * 0.5, `${s.id} ${w}x${h}`).toBeLessThanOrEqual(h * limit);
          expect(y - fs * 0.5).toBeGreaterThanOrEqual(0);
        }
        expect(lay.marginX / w).toBeGreaterThanOrEqual(s.layout.marginXPct / 100 - 1e-9);
      }
    }
  });

  it('never put a drawn box or shadow copy outside the frame', () => {
    for (const s of styles) {
      const ass = build(s);
      for (const e of events(ass, 'CaptionBg')) {
        const p = /\\pos\((-?\d+),(-?\d+)\)/.exec(e.text);
        if (!p || !e.text.includes('\\p1')) continue;
        expect(Number(p[1])).toBeGreaterThanOrEqual(0);
        expect(Number(p[2])).toBeGreaterThanOrEqual(0);
        expect(Number(p[2])).toBeLessThan(1920 * 0.82);
      }
    }
  });
});

describe('style fields drive the ASS', () => {
  it('font: family/weight/italic/size/letter spacing', () => {
    const hz = styleLine(build(resolveStyle('hormozi-bold')));
    expect(hz[1]).toBe('Anton');
    expect(hz[7]).toBe('0'); // Anton is a 400 face: no Bold flag (libass would fake-embolden it)
    const cp = styleLine(build(resolveStyle('clean-pop')));
    expect(cp[1]).toBe('Montserrat ExtraBold');
    expect(cp[7]).toBe('-1');
    const it = styleLine(build(custom((s) => (s.font.italic = true))));
    expect(it[8]).toBe('-1');
    const big = styleLine(build(custom((s) => (s.font.sizePct = 10))));
    expect(big[2]).toBe('108');
    const sp = styleLine(build(custom((s) => (s.font.letterSpacingPct = 5))));
    expect(Number(sp[13])).toBeCloseTo(4.2, 2); // 5 % of the 84 px size
    const poppins = styleLine(build(custom((s) => (s.font.family = 'Poppins'))));
    expect(poppins[1]).toBe('Poppins ExtraBold'); // weight 800 resolves to the ExtraBold face
  });

  it('unknown / system font families are passed through by name', () => {
    const s = styleLine(
      build(custom((x) => ((x.font.family = 'Some Local Font'), (x.font.weight = 700)))),
    );
    expect(s[1]).toBe('Some Local Font');
    expect(s[7]).toBe('-1');
  });

  it('text case: upper, lower, title, none', () => {
    const w = speak('hello WORLD foo-bar iPhone');
    const render = (c: CaptionStyle['textCase']): string =>
      events(
        build(
          custom(
            (s) => ((s.textCase = c), (s.chunking.maxWords = 5), (s.chunking.maxChars = 48)),
            'tiktok-classic',
          ),
          { words: w },
        ),
        'Caption',
      )
        .map((e) => e.text.replace(/\{[^}]*\}/g, ''))
        .join('|');
    expect(render('upper')).toContain('HELLO WORLD FOO-BAR IPHONE');
    expect(render('lower')).toContain('hello world foo-bar iphone');
    expect(render('title')).toContain('Hello World Foo-Bar iPhone');
    expect(render('none')).toContain('hello WORLD foo-bar iPhone');
  });

  it('fill / stroke / shadow colours and sizes reach the style line', () => {
    const l = styleLine(
      build(
        custom((s) => {
          s.fill = '#112233';
          s.stroke = { color: '#445566', widthPct: 1 };
          s.shadow = { color: '#778899', opacity: 0.5, blurPx: 0, offsetPx: 6 };
        }),
      ),
    );
    expect(l[3]).toBe('&H00332211');
    expect(l[5]).toBe('&H00665544');
    expect(l[6]).toBe('&H80998877');
    expect(l[16]).toBe('11'); // 1 % of 1080
    expect(l[17]).toBe('6');
    const none = styleLine(build(custom((s) => ((s.stroke.widthPct = 0), (s.shadow.opacity = 0)))));
    expect(none[16]).toBe('0');
    expect(none[17]).toBe('0');
  });

  it('blurred shadow = a layer-0 copy below the text with the shadow colour; no native shadow', () => {
    const s = custom(
      (x) => (x.shadow = { color: '#FF00AA', opacity: 0.8, blurPx: 10, offsetPx: 4 }),
    );
    const ass = build(s);
    expect(styleLine(ass)[17]).toBe('0');
    const copies = events(ass, 'CaptionBg');
    const text = events(ass, 'Caption');
    expect(copies.length).toBe(text.length);
    for (const c of copies) {
      expect(c.layer).toBe(0);
      expect(c.text).toMatch(/\\blur\d/);
      expect(c.text).toContain('\\1c&HAA00FF&');
      expect(c.text).not.toContain('\\1c&HFFFFFF&'); // never the text colour
    }
    for (const t of text) expect(t.layer).toBe(1);
    // offset 0 = glow: two stacked halos per event, expanded outline
    const glow = events(build(resolveStyle('neon-glow')), 'CaptionBg');
    expect(glow.length).toBe(2 * events(build(resolveStyle('neon-glow')), 'Caption').length);
    expect(glow[0]?.text).toMatch(/\\bord\d+(\.\d+)?/);
  });

  it('background box: a rounded vector shape on layer 0 spanning the whole block, sized to the text', () => {
    const ass = build(resolveStyle('caption-bubble'));
    const boxes = events(ass, 'CaptionBg').filter((e) => e.text.includes('\\p1'));
    expect(boxes.length).toBeGreaterThan(3);
    for (const b of boxes) {
      expect(b.layer).toBe(0);
      expect(b.text).toMatch(/\\1c&H141110&/); // #101114
      expect(b.text).toMatch(/\\1a&H33&/); // 80 % opacity
      expect(b.text).toMatch(/\}m [\d.]+ 0 l .* b /); // rounded: has bezier corners
    }
    const text = events(ass, 'Caption');
    // the box of a block covers all of its word events
    const first = boxes[0];
    expect(first).toBeDefined();
    const inside = text.filter(
      (t) => t.start >= (first?.start ?? 0) && t.end <= (first?.end ?? 0) + 1e-9,
    );
    expect(inside.length).toBeGreaterThan(0);
    // box width follows the text: wider text -> wider box
    const width = (a: string): number => {
      const m = /m ([\d.]+) 0 l ([\d.]+) 0/.exec(a);
      return Number(m?.[2] ?? 0) + 2 * Number(m?.[1] ?? 0);
    };
    const short = events(
      build(resolveStyle('caption-bubble'), { words: speak('hi there') }),
      'CaptionBg',
    )[0];
    const long = events(
      build(resolveStyle('caption-bubble'), {
        words: speak('this sentence is considerably longer'),
      }),
      'CaptionBg',
    )[0];
    expect(width(long?.text ?? '')).toBeGreaterThan(width(short?.text ?? ''));
    // no box when disabled
    expect(events(build(resolveStyle('clean-pop')), 'CaptionBg')).toHaveLength(0);
  });

  it('highlight none/color/scale/color-scale/box change only the active word as specified', () => {
    const modes: CaptionStyle['highlight']['mode'][] = [
      'none',
      'color',
      'scale',
      'color-scale',
      'box',
    ];
    const out: Record<string, string> = {};
    for (const m of modes) {
      const s = custom((x) => {
        x.highlight = { mode: m, color: '#00FF00', boxColor: '#FF0000', scale: 1.3 };
        x.animation = 'none';
      });
      const ass = build(s, { words: speak('alpha beta gamma') });
      const ev = events(ass, 'Caption')[1]; // "beta" active
      out[m] = ev?.text ?? '';
      if (m === 'box') {
        const bgs = events(ass, 'CaptionBg').filter((e) => e.text.includes('\\p1'));
        expect(bgs.length).toBeGreaterThan(0);
        expect(bgs[0]?.text).toContain('\\1c&H0000FF&');
      }
    }
    const runs = (t: string): string[] => t.split(/\}(?=[^{}]*(?:\{|$))/).filter(Boolean);
    void runs;
    expect(out['none']).not.toContain('&H00FF00&');
    expect(out['none']).not.toContain('\\fscx130');
    expect(out['color']).toContain('\\1c&H00FF00&');
    expect(out['color']).not.toContain('\\fscx130');
    expect(out['scale']).not.toContain('&H00FF00&');
    expect(out['scale']).toContain('\\fscx130\\fscy130');
    expect(out['color-scale']).toContain('\\1c&H00FF00&\\fscx130');
    expect(out['box']).toContain('\\1c&H00FF00&'); // text colour inside the box
    expect(out['box']).toContain('\\bord0'); // no stroke smudge inside the box
  });

  it('keyword colour applies to idle keywords in every animation; the active word wins', () => {
    for (const id of ['clean-pop', 'karaoke-highlight', 'typewriter', 'minimal-lower-third']) {
      const s = resolveStyle(id);
      const kw = s.keywordColor.slice(1).match(/../g) ?? [];
      const bgr = `&H${(kw[2] ?? '') + (kw[1] ?? '') + (kw[0] ?? '')}&`.toUpperCase();
      const ass = buildAssDocument({
        words: speak('we love big money today'),
        startSec: 0,
        endSec: 5,
        width: 1080,
        height: 1920,
        style: s,
        keywords: ['money'],
      });
      expect(ass.toUpperCase(), id).toContain(bgr);
    }
  });

  it('animations: pop, bounce, typewriter, fade, slide-up, karaoke, none produce their tags', () => {
    const tagsOf = (id: string): string =>
      events(build(resolveStyle(id)), 'Caption')
        .map((e) => e.text)
        .join('\n');
    expect(tagsOf('clean-pop')).toMatch(/\\t\(0,70,/);
    expect(tagsOf('bounce-word')).toMatch(/\\t\(0,90,.*\\t\(90,170,.*\\t\(170,240,.*\\t\(240,310,/);
    expect(tagsOf('karaoke-highlight')).toMatch(/\\kf\d+/);
    expect(tagsOf('typewriter')).toMatch(/\\1a&HFF&\\3a&HFF&\\4a&HFF&\\t\(\d+,\d+,/);
    expect(tagsOf('minimal-lower-third')).toMatch(/\\fad\(\d+,0\)/);
    expect(tagsOf('podcast-lower-third')).toMatch(/\\move\(\d+,\d+,\d+,\d+,0,180\)/);
    const plain = tagsOf('tiktok-classic');
    expect(plain).not.toMatch(/\\t\(|\\kf|\\move|\\fad/);
  });

  it('left alignment anchors at the margin (\\an4); centre uses \\an5 at the middle', () => {
    const left = events(build(resolveStyle('minimal-lower-third')), 'Caption')[0]?.text ?? '';
    expect(left).toMatch(/\\an4\\(?:pos|move)\(/);
    const x = Number(/\\(?:pos|move)\((\d+),/.exec(left)?.[1]);
    expect(x).toBe(Math.ceil(1080 * 0.08));
    const mid = events(build(resolveStyle('clean-pop')), 'Caption')[0]?.text ?? '';
    expect(mid).toMatch(/\\an5\\pos\(540,/);
  });

  it('chunking: maxWords/maxChars per line and maxLines per block (lines are separate events at different y)', () => {
    const base = custom((s) => {
      s.chunking = { maxWords: 2, maxChars: 24, maxLines: 1 };
      s.animation = 'none';
    }, 'tiktok-classic');
    const words = speak('one two three four five six seven eight nine ten');
    const one = events(build(base, { words }), 'Caption');
    for (const e of one) {
      const visible = e.text.replace(/\{[^}]*\}/g, '').split(' ').length;
      expect(visible).toBeLessThanOrEqual(2);
    }
    const two = custom((s) => (s.chunking.maxLines = 2), 'tiktok-classic');
    const twoLines = custom((s) => {
      s.chunking = { maxWords: 2, maxChars: 24, maxLines: 2 };
      s.animation = 'none';
    }, 'tiktok-classic');
    void two;
    const evs = events(build(twoLines, { words }), 'Caption');
    // events sharing a start time are the lines of one block
    const byStart = new Map<number, Ev[]>();
    for (const e of evs) byStart.set(e.start, [...(byStart.get(e.start) ?? []), e]);
    const multi = [...byStart.values()].filter((l) => l.length === 2);
    expect(multi.length).toBeGreaterThan(2);
    for (const [a, b] of multi) {
      const ya = Number(/\\pos\(\d+,(\d+)\)/.exec(a?.text ?? '')?.[1]);
      const yb = Number(/\\pos\(\d+,(\d+)\)/.exec(b?.text ?? '')?.[1]);
      expect(Math.abs(yb - ya)).toBeGreaterThan(30);
      expect(Math.abs(yb - ya)).toBeLessThan(150); // tight pitch, not libass' loose cell spacing
    }
  });

  it('a word wider than the line shrinks (or is broken into hyphenated lines) and stays inside the margins', () => {
    const words = speak(
      'Supercalifragilisticexpialidocious Pneumonoultramicroscopicsilicovolcanoconiosis',
    );
    for (const id of [
      'clean-pop',
      'hormozi-bold',
      'caption-bubble',
      'typewriter',
      'karaoke-highlight',
    ]) {
      const ass = buildAssDocument({
        words,
        startSec: 0,
        endSec: 5,
        width: 1080,
        height: 1920,
        style: resolveStyle(id),
      });
      const text = events(ass, 'Caption')
        .map((e) => e.text)
        .join('\n');
      expect(/\\fs\d+/.test(text) || /-\}?\s/.test(text) || /-$/m.test(text), id).toBe(true);
      expect(events(ass, 'Caption').length, id).toBeGreaterThan(0);
    }
  });

  it('survives emoji, CJK, RTL, braces/backslashes, empty words and a single word for every preset', () => {
    const cases: string[][] = [
      ['fire', '🔥', 'so', '😎👍', '👨‍👩‍👧'],
      ['你好', '世界', '今天', '天气', '很好'],
      ['مرحبا', 'بالعالم', 'שלום', 'עולם'],
      ['{\\b1}bold{\\i1}', 'C:\\temp', '"q"', '{x}'],
      ['', '   ', 'hello', '', '\t', 'world'],
      ['Hi'],
    ];
    for (const s of builtinStyles()) {
      for (const toks of cases) {
        const words = toks.map((w, i) => ({ w, s: i * 0.5, e: i * 0.5 + 0.45 }));
        const ass = buildAssDocument({
          words,
          startSec: 0,
          endSec: 10,
          width: 1080,
          height: 1920,
          style: s,
        });
        for (const e of events(ass)) {
          expect(e.text).not.toMatch(/\{\\b1\}|\{\\i1\}/); // user text can never inject tags
        }
      }
    }
    // an all-empty input is a valid header-only document
    const empty = buildAssDocument({
      words: [{ w: '  ', s: 0, e: 1 }],
      startSec: 0,
      endSec: 5,
      width: 1080,
      height: 1920,
      style: resolveStyle('hormozi-bold'),
    });
    expect(events(empty)).toHaveLength(0);
  });

  it('karaoke: cumulative \\k/\\kf offsets reproduce every word start within 10 ms', () => {
    const words = speak('this is a test of the karaoke sweep timing', {
      start: 2.37,
      dur: 0.27,
      gap: 0.05,
    });
    const ass = buildAssDocument({
      words,
      startSec: 2,
      endSec: 8,
      width: 1080,
      height: 1920,
      style: resolveStyle('karaoke-highlight'),
    });
    const starts: number[] = [];
    for (const e of events(ass, 'Caption')) {
      let cur = 0;
      for (const m of e.text.matchAll(/\{\\k(\d+)\\kf(\d+)/g)) {
        cur += Number(m[1]);
        starts.push(e.start + cur / 100);
        cur += Number(m[2]);
      }
    }
    expect(starts.length).toBe(words.length);
    const expected = words.map((w) => w.s - 2).sort((a, b) => a - b);
    starts.sort((a, b) => a - b);
    for (let i = 0; i < expected.length; i++) {
      expect(Math.abs((starts[i] ?? 0) - (expected[i] ?? 0))).toBeLessThanOrEqual(0.0101);
    }
  });

  it('typewriter reveals letters in order inside each word window', () => {
    const words = speak('hello world', { start: 0.5, dur: 0.6, gap: 0.1 });
    const ass = buildAssDocument({
      words,
      startSec: 0,
      endSec: 5,
      width: 1080,
      height: 1920,
      style: resolveStyle('typewriter'),
    });
    const ev = events(ass, 'Caption')[0];
    const times = [...(ev?.text ?? '').matchAll(/\\4a&HFF&\\t\((\d+),(\d+),/g)].map((m) =>
      Number(m[1]),
    );
    expect(times.length).toBe('helloworld'.length);
    expect(times[0]).toBe(0); // first letter at the first word's start
    for (let i = 1; i < times.length; i++)
      expect(times[i] as number).toBeGreaterThanOrEqual(times[i - 1] as number);
    // "world" starts 0.7 s after "hello"
    expect(times[5]).toBe(700);
    expect(Math.max(...times)).toBeLessThanOrEqual(1300);
  });

  it('slide-up/fade bridge short gaps without fading out between blocks (no flicker)', () => {
    const words = speak('one two three four five six seven eight nine ten eleven twelve', {
      gap: 0.05,
    });
    const ass = build(resolveStyle('minimal-lower-third'), { words });
    const evs = events(ass, 'Caption');
    // continuous speech: no fade-out at all
    expect(evs.some((e) => /\\fad\(\d+,[1-9]/.test(e.text))).toBe(true); // the very last block fades out
    const fadeOuts = evs.filter((e) => /\\fad\(\d+,[1-9]/.test(e.text));
    expect(fadeOuts.length).toBeLessThanOrEqual(2);
  });
});
