import { describe, expect, it } from 'vitest';
import type { Word } from '../../shared/pipeline';
import { buildAssDocument, resolveStyle } from '../../electron/main/services/captions';
import { GOLDEN_CP1_LANDSCAPE, GOLDEN_CP1_PORTRAIT_KEYWORDS_MASKED } from './captions-golden';

function speak(text: string, start: number, gaps: Record<number, number>): Word[] {
  let t = start;
  return text.split(' ').map((w, i) => {
    const o = { w, s: t, e: t + 0.3 };
    t += 0.3 + (gaps[i] ?? 0.04);
    return o;
  });
}

const words = speak(
  'So here is the thing about money. Nobody teaches you this in school today.',
  12.34,
  { 6: 0.4 },
);

/** The new engine adds a second style for boxes/shadow copies; everything else must match CP1. */
const withoutBgStyle = (ass: string): string =>
  ass
    .split('\n')
    .filter((l) => !l.startsWith('Style: CaptionBg'))
    .join('\n');

describe('Clean Pop regression against the CP1 engine', () => {
  it('reproduces the CP1 ASS for a 1080x1920 clip with keywords and profanity masking', () => {
    const ass = buildAssDocument({
      words,
      startSec: 12,
      endSec: 40,
      width: 1080,
      height: 1920,
      style: resolveStyle('clean-pop'),
      keywords: ['money', 'school'],
      maskProfanity: true,
    });
    expect(withoutBgStyle(ass)).toBe(GOLDEN_CP1_PORTRAIT_KEYWORDS_MASKED);
  });

  it('reproduces the CP1 ASS for a landscape 1920x1080 clip (24-char lines)', () => {
    const ass = buildAssDocument({
      words,
      startSec: 12,
      endSec: 40,
      width: 1920,
      height: 1080,
      style: resolveStyle('clean-pop'),
    });
    expect(withoutBgStyle(ass)).toBe(GOLDEN_CP1_LANDSCAPE);
  });
});
