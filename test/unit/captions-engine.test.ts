import { describe, expect, it } from 'vitest';
import type { Word } from '../../shared/pipeline';
import {
  appendHookToAss,
  assTime,
  buildAssDocument,
  buildCues,
  buildHookEvent,
  buildSrt,
  buildVtt,
  captionLayout,
  chunkWords,
  createCaptionService,
  escapeAssText,
  isProfane,
  maskWord,
  resolveStyle,
  wrapHook,
} from '../../electron/main/services/captions';

interface Ev {
  start: number;
  end: number;
  style: string;
  text: string;
  layer: number;
}

const parseTime = (t: string): number => {
  const m = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(t);
  if (!m) throw new Error(`bad time ${t}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
};

function events(ass: string): Ev[] {
  return ass
    .split('\n')
    .filter((l) => l.startsWith('Dialogue:'))
    .map((l) => {
      const body = l.slice('Dialogue:'.length).trim();
      // Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text (text may contain commas)
      const parts = body.split(',');
      const text = parts.slice(9).join(',');
      return {
        layer: Number(parts[0]),
        start: parseTime(parts[1] ?? ''),
        end: parseTime(parts[2] ?? ''),
        style: parts[3] ?? '',
        text,
      };
    });
}

/** Strips override blocks, returns the visible text with `\{`/`\}` unescaped. */
const visible = (text: string): string =>
  text
    .replace(/\{\\[^{}]*?(?:\([^)]*\)[^{}]*?)*\}/g, '')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/\\N/g, '\n');

/** The word rendered with the pop colour in an event (Clean Pop active = #FFD60A -> &H0AD6FF&). */
const ACTIVE = '\\1c&H0AD6FF&';
const activeWord = (text: string): string | null => {
  const m = /\{[^{}]*\\1c&H0AD6FF&[^{}]*(?:\([^)]*\)[^{}]*)*\}([^{]*?)(?= \{|$)/.exec(text);
  return m?.[1] ?? null;
};

/** Words at 0.3 s each with the given gaps (seconds) after each word. */
function speak(
  text: string,
  opts: { start?: number; dur?: number; gap?: number; gaps?: Record<number, number> } = {},
): Word[] {
  const out: Word[] = [];
  let t = opts.start ?? 0;
  const toks = text.split(' ');
  toks.forEach((w, i) => {
    const d = opts.dur ?? 0.3;
    out.push({ w, s: t, e: t + d });
    t += d + (opts.gaps?.[i] ?? opts.gap ?? 0.04);
  });
  return out;
}

const build = (
  words: Word[],
  extra: Partial<Parameters<typeof buildAssDocument>[0]> = {},
): string =>
  buildAssDocument({
    words,
    startSec: 0,
    endSec: 60,
    width: 1080,
    height: 1920,
    style: resolveStyle('clean-pop'),
    ...extra,
  });

/* Ported from the CP1 suite (clipcraft-captions.test.ts): Clean Pop must keep behaving exactly as before. */
describe('ASS structure and layout', () => {
  const ass = build(speak('Hello there my friend. Welcome to the show today.'));

  it('has PlayRes equal to the output size and the Caption style', () => {
    expect(ass).toMatch(/^PlayResX: 1080$/m);
    expect(ass).toMatch(/^PlayResY: 1920$/m);
    expect(ass).toMatch(/^Style: Caption,Montserrat ExtraBold,84,/m);
    expect(ass).toMatch(/^ScaledBorderAndShadow: yes$/m);
    expect(ass).toMatch(/^Format: Layer, Start, End, Style/m);
  });

  it('positions text in the safe area: 62-70% of the height, margins >= 6%, clear of the bottom 18%', () => {
    for (const [w, h] of [
      [1080, 1920],
      [1080, 1350],
      [1080, 1080],
      [1920, 1080],
    ] as const) {
      const lay = captionLayout(w, h, resolveStyle('clean-pop'));
      if (h / w > 1.5) {
        expect(lay.cy / h).toBeGreaterThanOrEqual(0.62);
        expect(lay.cy / h).toBeLessThanOrEqual(0.7);
      }
      expect((lay.cy + 0.6 * lay.fontSize) / h).toBeLessThan(0.82); // text block bottom above the platform-UI zone
      expect(lay.marginX / w).toBeGreaterThanOrEqual(0.06 - 1e-9);
    }
    const ev = events(ass)[0]!;
    const m = /\\pos\((\d+),(\d+)\)/.exec(ev.text)!;
    expect(Number(m[1])).toBe(540);
    expect(Number(m[2])).toBe(Math.round(1920 * 0.69));
    expect(ass).toMatch(/Style: Caption,[^\n]*,5,65,65,0,1$/m); // margins 6% of 1080 = 65
  });

  it('returns a valid header-only document for no words', () => {
    const empty = build([]);
    expect(events(empty)).toHaveLength(0);
    expect(empty).toContain('[Events]');
  });

  it('scales the layout with the output size', () => {
    const small = captionLayout(540, 960, resolveStyle('clean-pop'));
    const big = captionLayout(1080, 1920, resolveStyle('clean-pop'));
    expect(big.fontSize).toBe(84);
    expect(small.fontSize).toBe(42);
    expect(big.maxChars).toBe(small.maxChars);
    expect(big.maxChars).toBeGreaterThanOrEqual(13);
    expect(big.maxChars).toBeLessThanOrEqual(15);
  });
});

describe('caption timing', () => {
  const words = speak('So here is the thing about money. Nobody teaches you this in school.', {
    start: 12.34,
    gaps: { 6: 0.4 },
  });
  const ass = build(words, { startSec: 12, endSec: 40 });
  const evs = events(ass);

  it('starts every word event at the word start (relative to the clip) within ASS resolution', () => {
    const starts = new Set(evs.map((e) => e.start));
    let maxErr = 0;
    for (const w of words) {
      const rel = w.s - 12;
      const hit = [...starts].reduce(
        (best, s) => (Math.abs(s - rel) < Math.abs(best - rel) ? s : best),
        Infinity,
      );
      maxErr = Math.max(maxErr, Math.abs(hit - rel));
    }
    expect(maxErr).toBeLessThanOrEqual(0.005 + 1e-9);
    expect(evs[0]?.start).toBeCloseTo(0.34, 2);
  });

  it('shows exactly one active word per event and it is the word spoken at the event start', () => {
    for (const e of evs) {
      const act = activeWord(e.text);
      expect(act, e.text).not.toBeNull();
      const abs = e.start + 12;
      const spoken = words.reduce((b, w) => (Math.abs(w.s - abs) < Math.abs(b.s - abs) ? w : b));
      expect(act?.replace(/[^A-Za-z']/g, '').toLowerCase()).toBe(
        spoken?.w.replace(/[^A-Za-z']/g, '').toLowerCase(),
      );
      expect(e.text.split(ACTIVE).length - 1).toBe(1);
    }
  });

  it('has no flicker gaps: events inside a line abut; gaps < 250 ms are bridged, longer ones are not', () => {
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1]!;
      const cur = evs[i]!;
      const wordPrevEnd = words.find((w) => Math.abs(w.s - 12 - prev.start) < 0.006)!.e - 12;
      const gapToNext = cur.start - wordPrevEnd;
      if (gapToNext < 0.25) expect(cur.start - prev.end, `${i}`).toBeCloseTo(0, 5);
      else expect(prev.end).toBeLessThanOrEqual(wordPrevEnd + 0.006);
    }
    // the planted 0.4 s pause after "money." (word index 6) must produce a real gap
    const gaps = evs.slice(1).map((e, i) => e.start - evs[i]!.end);
    expect(Math.max(...gaps)).toBeGreaterThan(0.35);
  });

  it('events never overlap and never exceed the clip', () => {
    for (let i = 1; i < evs.length; i++)
      expect(evs[i]!.start).toBeGreaterThanOrEqual(evs[i - 1]!.end - 1e-9);
    for (const e of evs) {
      expect(e.start).toBeGreaterThanOrEqual(0);
      expect(e.end).toBeLessThanOrEqual(28 + 1e-9);
      expect(e.end).toBeGreaterThan(e.start);
    }
  });

  it('only includes words inside the clip and clamps words that straddle its edges', () => {
    const w: Word[] = [
      { w: 'before', s: 1, e: 1.5 },
      { w: 'edge', s: 1.9, e: 2.4 }, // straddles the start (2.0)
      { w: 'inside', s: 2.5, e: 3.0 },
      { w: 'tail', s: 3.8, e: 4.4 }, // straddles the end (4.0)
      { w: 'after', s: 5, e: 5.5 },
    ];
    const e = events(build(w, { startSec: 2, endSec: 4 }));
    const text = e.map((x) => visible(x.text)).join(' ');
    expect(text).not.toMatch(/BEFORE|AFTER/);
    expect(text).toMatch(/EDGE/);
    expect(e[0]?.start).toBe(0);
    expect(Math.max(...e.map((x) => x.end))).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('survives overlapping/zero-length ASR words', () => {
    const w: Word[] = [
      { w: 'one', s: 0, e: 0.5 },
      { w: 'two', s: 0.4, e: 0.9 }, // overlaps
      { w: 'three', s: 0.9, e: 0.9 }, // zero length
      { w: 'four', s: 1.2, e: 1.6 },
    ];
    const e = events(build(w));
    for (let i = 1; i < e.length; i++)
      expect(e[i]!.start).toBeGreaterThanOrEqual(e[i - 1]!.end - 1e-9);
    expect(e.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps start times of words that follow a zero-length ASR word (tiny-model output)', () => {
    const w: Word[] = [
      { w: 'you', s: 1.0, e: 1.3 },
      { w: 'known', s: 1.5, e: 1.5 }, // zero length, next word starts at the same instant
      { w: 'as', s: 1.5, e: 1.9 },
      { w: 'perhaps', s: 1.9, e: 2.4 },
      { w: 'solo', s: 3.0, e: 3.0 }, // isolated zero-length word gets a short visible life
      { w: 'show.', s: 3.5, e: 4.0 },
    ];
    const e = events(build(w));
    const starts = e.map((x) => x.start);
    expect(starts).toContain(1.5);
    expect(starts).toContain(1.9);
    expect(e.find((x) => x.start === 1.5)!.end).toBeCloseTo(1.9, 5);
    const solo = e.find((x) => x.start === 3);
    expect(solo).toBeDefined();
    expect(solo!.end - solo!.start).toBeGreaterThanOrEqual(0.1);
    // the zero-length word is still displayed (inside its neighbours' lines) but is never the active one
    expect(e.some((x) => /KNOWN/.test(visible(x.text)))).toBe(true);
    expect(e.some((x) => activeWord(x.text) === 'KNOWN')).toBe(false);
  });

  it('assTime formats centiseconds', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(61.234)).toBe('0:01:01.23');
    expect(assTime(3725.999)).toBe('1:02:06.00');
    expect(assTime(-3)).toBe('0:00:00.00');
  });
});

describe('line breaking', () => {
  it('uses 1-3 words per line within the character budget', () => {
    const text =
      'Entrepreneurship is fundamentally misunderstood because organizations overcomplicate everything about extraordinary opportunities and responsibilities';
    const evs = events(build(speak(text)));
    for (const e of evs) {
      const line = visible(e.text);
      const n = line.split(' ').length;
      expect(n).toBeLessThanOrEqual(3);
      expect(line.length <= 14 || n === 1).toBe(true);
    }
  });

  it('never splits a short phrase awkwardly: no line ends on a function word, phrases break at punctuation', () => {
    const words = speak(
      'I think that the best way to learn is to build a thing of your own. Then you can share it with the world, and people will love it.',
    );
    const norm = words.map((w) => ({
      text: w.w,
      s: w.s,
      e: w.e,
      norm: w.w.toLowerCase().replace(/[^a-z']/g, ''),
    }));
    const chunks = chunkWords(norm, { maxWords: 3, maxChars: 14 });
    const weak = new Set([
      'a',
      'an',
      'the',
      'to',
      'of',
      'in',
      'on',
      'at',
      'for',
      'with',
      'and',
      'but',
      'or',
      'my',
      'your',
      'is',
    ]);
    let weakEnds = 0;
    chunks.forEach((c, i) => {
      expect(c.length).toBeGreaterThanOrEqual(1);
      expect(c.length).toBeLessThanOrEqual(3);
      const last = c[c.length - 1]!;
      const isLastOfPhrase = /[.,?!]$/.test(last.text) || i === chunks.length - 1;
      if (!isLastOfPhrase && weak.has(last.norm)) weakEnds++;
      // a chunk never crosses a sentence end
      c.slice(0, -1).forEach((w) => expect(w.text).not.toMatch(/[.?!]$/));
    });
    expect(weakEnds).toBeLessThanOrEqual(1);
    // orphan single-word chunks are rare unless forced by the phrase
    expect(chunks.filter((c) => c.length === 1).length).toBeLessThanOrEqual(3);
  });

  it('breaks at pauses >= 250 ms even without punctuation', () => {
    const words = speak('this is one thought and this is another', { gaps: { 3: 0.5 } });
    const evs = events(build(words));
    const joined = evs.map((e) => visible(e.text));
    expect(joined.some((l) => l.includes('THOUGHT') && l.includes('AND'))).toBe(false);
  });

  it('shrinks the font for a single word wider than the line budget', () => {
    const ass = build(speak('Supercalifragilisticexpialidocious'));
    expect(ass).toMatch(/\\fs\d+/);
  });
});

describe('text handling', () => {
  it('escapes braces and backslashes so they cannot open override blocks or break lines', () => {
    expect(escapeAssText('a {b} c')).toBe('a \\{b\\} c');
    expect(escapeAssText('path\\to\\file')).toBe('pathtofile');
    expect(escapeAssText('line1\nline2\t3')).toBe('line1 line2 3');
    const ass = build(speak('use {\\b1}bold{\\i1} and C:\\temp now'));
    const text = events(ass)
      .map((e) => visible(e.text))
      .join(' ');
    expect(text).toContain('{B1}');
    expect(text).not.toContain('\\');
    // every raw "{" in the event text starts one of OUR tag blocks (starts with a backslash tag)
    for (const e of events(ass)) {
      const raw = e.text.replace(/\\\{/g, '').replace(/\\\}/g, '');
      expect(raw.match(/\{(?!\\(?:an|1c))/g)).toBeNull();
    }
  });

  it('passes emoji through unchanged (not case-folded or dropped)', () => {
    const e = events(build(speak('this is fire 🔥 and so cool 😎👍')));
    const text = e.map((x) => visible(x.text)).join(' ');
    expect(text).toContain('🔥');
    expect(text).toContain('😎👍');
  });

  it('masks profanity when asked (first letter kept, punctuation kept) and leaves clean words alone', () => {
    expect(isProfane('fucking')).toBe(true);
    expect(isProfane('Shit,')).toBe(true);
    expect(isProfane('class')).toBe(false); // contains "ass"
    expect(isProfane('Scunthorpe')).toBe(false);
    expect(isProfane('assessment')).toBe(false);
    expect(maskWord('fucking,')).toBe('f******,');
    expect(maskWord('"Shit"')).toBe('"S***"');
    const words = speak('this is some fucking shit, honestly');
    const masked = events(build(words, { maskProfanity: true }))
      .map((e) => visible(e.text))
      .join(' ');
    expect(masked).toContain('F******');
    expect(masked).toContain('S***,');
    expect(masked).not.toMatch(/FUCK|SHIT/);
    const plain = events(build(words))
      .map((e) => visible(e.text))
      .join(' ');
    expect(plain).toMatch(/FUCKING/);
  });

  it('applies uppercase (Clean Pop) and highlights LLM keywords in the accent colour', () => {
    const words = speak('we love big data and it wins');
    const ass = build(words, { keywords: ['data', 'big data'] });
    const evs = events(ass);
    expect(evs.map((e) => visible(e.text)).join(' ')).toMatch(/BIG DATA/);
    const KW = '\\1c&HA1E035&'; // #35E0A1 as &HBBGGRR&
    // while another word is active, the idle keyword "DATA" keeps the accent colour
    const idleKeyword = evs.find((e) =>
      new RegExp(`${KW.replace(/\\/g, '\\\\')}[^{}]*\\}DATA`).test(e.text),
    );
    expect(idleKeyword).toBeDefined();
    expect(activeWord(idleKeyword!.text)).not.toBe('DATA');
    // the active word always uses the pop colour (even a keyword), non-keyword idle words stay white
    expect(evs.some((e) => activeWord(e.text) === 'DATA')).toBe(true);
    expect(evs.some((e) => e.text.includes('\\1c&HFFFFFF&'))).toBe(true);
    // keywords make the pop a little bigger
    expect(evs.find((e) => activeWord(e.text) === 'DATA')!.text).toMatch(/fscx122/);
  });

  it('includes the pop bounce transform on the active word', () => {
    const e = events(build(speak('hello world')))[0]!;
    expect(e.text).toMatch(
      /\\fscx82\\fscy82\\t\(0,70,\\fscx116\\fscy116\)\\t\(70,150,\\fscx100\\fscy100\)/,
    );
  });
});

describe('SRT / VTT', () => {
  const words = speak(
    'This is the first sentence of the clip. And here is a second, much longer sentence that must be split into cues.',
    { start: 10, gaps: { 7: 0.6 } },
  );

  it('builds phrase-level cues of at most 42 characters, relative to the clip start', () => {
    const cues = buildCues(words, 10, 40);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (const c of cues) {
      expect(c.text.length).toBeLessThanOrEqual(42);
      expect(c.end).toBeGreaterThan(c.start);
    }
    expect(cues[0]?.start).toBeCloseTo(0, 5);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
  });

  it('formats SRT with comma milliseconds and VTT with a header and dots', () => {
    const srt = buildSrt(words, 10, 40);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt).toMatch(/\n2\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n/);
    const vtt = buildVtt(words, 10, 40);
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> ')).toBe(true);
    expect(vtt).not.toMatch(/\d,\d{3} -->/);
  });

  it('escapes WebVTT specials', () => {
    const vtt = buildVtt(
      [
        { w: 'a<b', s: 0, e: 0.5 },
        { w: '-->', s: 0.5, e: 1 },
        { w: 'x&y', s: 1, e: 1.5 },
      ],
      0,
      5,
    );
    expect(vtt).toContain('a&lt;b --&gt; x&amp;y');
  });
});

describe('hook title card', () => {
  it('produces a Hook style + event ~18% from the top with fade/scale, for 1.2-4 s', () => {
    const h = buildHookEvent('Nobody tells you this about money', 2.5, 1080, 1920);
    expect(h.style).toMatch(/^Style: Hook,Montserrat ExtraBold,\d+,/);
    expect(h.event).toMatch(/^Dialogue: 3,0:00:00\.00,0:00:02\.50,Hook,/);
    const pos = /\\pos\((\d+),(\d+)\)/.exec(h.event)!;
    expect(Number(pos[1])).toBe(540);
    expect(Number(pos[2])).toBe(Math.round(1920 * 0.18));
    expect(h.event).toMatch(/\\fad\(\d+,\d+\)/);
    expect(h.event).toMatch(/\\t\(0,260,\\fscx100\\fscy100\)/);
    expect(buildHookEvent('x', 10, 1080, 1920).event).toMatch(/0:00:04\.00/);
    expect(buildHookEvent('x', 0.1, 1080, 1920).event).toMatch(/0:00:01\.20/);
  });

  it('wraps into at most 3 lines and escapes braces/backslashes', () => {
    const lines = wrapHook(
      'The one thing every beginner investor gets wrong about compounding interest',
      18,
    );
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join(' ')).toBe(
      'The one thing every beginner investor gets wrong about compounding interest',
    );
    const h = buildHookEvent('Use {this} \\ trick', 3, 1080, 1920);
    expect(h.event).toContain('\\{this\\}');
    expect(h.event).not.toMatch(/\\ trick|\\\\/);
  });

  it('appends to an existing document (and is idempotent), or creates one', () => {
    const base = build(speak('hello there my friend'));
    const once = appendHookToAss(base, { text: 'Big hook', durationSec: 2.5 }, 1080, 1920);
    const twice = appendHookToAss(once, { text: 'Big hook', durationSec: 2.5 }, 1080, 1920);
    expect(twice).toBe(once);
    expect(once.match(/^Style: Hook,/gm)).toHaveLength(1);
    expect(once.match(/,Hook,,/g)).toHaveLength(1);
    expect(once.indexOf('Style: Hook,')).toBeLessThan(once.indexOf('[Events]'));
    expect(events(once).filter((e) => e.style === 'Caption').length).toBeGreaterThan(0);
    const fresh = appendHookToAss(null, { text: 'Only hook', durationSec: 2 }, 1080, 1920);
    expect(fresh).toMatch(/^PlayResY: 1920$/m);
    expect(events(fresh)).toHaveLength(1);
  });
});

describe('createCaptionService', () => {
  it('implements the contract', () => {
    const svc = createCaptionService();
    const w = speak('hello world again today');
    const style = resolveStyle('clean-pop');
    expect(
      svc.buildAss({ words: w, startSec: 0, endSec: 10, width: 1080, height: 1920, style }),
    ).toContain('[Events]');
    expect(svc.buildSrt(w, 0, 10)).toContain('-->');
    expect(svc.buildVtt(w, 0, 10)).toContain('WEBVTT');
    expect(svc.builtinStyles()).toHaveLength(14);
    expect(svc.builtinStyles()[0]?.id).toBe('clean-pop');
    // callers get copies: mutating one must not change the presets
    const first = svc.builtinStyles()[0];
    if (first) first.fill = '#123456';
    expect(svc.builtinStyles()[0]?.fill).toBe('#FFFFFF');
  });
});
