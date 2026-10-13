/**
 * Text heuristics for moment scoring: hook strength of the first seconds, self-containment,
 * questions and numbers. English lexicons; other languages simply score near-neutral.
 */
import { stripPunct } from './words';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export { clamp01 };

/** Words that make an opening feel like a filler / mid-thought rather than a hook. */
const FILLER_OPENERS = new Set([
  'um',
  'uh',
  'uhm',
  'umm',
  'er',
  'erm',
  'ah',
  'hmm',
  'yeah',
  'yep',
  'okay',
  'ok',
  'right',
  'well',
  'like',
  'anyway',
  'anyways',
  'alright',
]);
const FILLER_BIGRAMS = new Set([
  'so yeah',
  'and then',
  'and so',
  'but yeah',
  'yeah so',
  'okay so',
  'ok so',
  'so um',
  'so uh',
  'i mean',
  'you know',
  'kind of',
  'sort of',
  'and uh',
  'and um',
]);
/** A clip must not start by continuing a thought. */
const DANGLING_CONJ = new Set([
  'and',
  'but',
  'so',
  'because',
  'or',
  'which',
  'then',
  'also',
  'plus',
  'cause',
  'cuz',
  'nor',
  'although',
  'though',
  'whereas',
]);
/** Pronouns that need an antecedent the viewer has not seen. */
const DANGLING_PRONOUN = new Set([
  'he',
  'she',
  'they',
  'them',
  'it',
  'its',
  'his',
  'her',
  'their',
  'those',
  'these',
  'him',
]);
const WEAK_END_WORDS = new Set([
  'and',
  'but',
  'so',
  'or',
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'because',
  'that',
  'which',
  'is',
  'was',
  'are',
  'my',
  'your',
  'our',
  'their',
]);

const QUESTION_STARTERS = new Set([
  'why',
  'how',
  'what',
  'who',
  'when',
  'where',
  'which',
  'do',
  'does',
  'did',
  'is',
  'are',
  'can',
  'could',
  'would',
  'should',
  'will',
  'have',
  'has',
  'ever',
]);

const BOLD_TERMS = new Set([
  'never',
  'always',
  'nobody',
  'everyone',
  'everybody',
  'no one',
  'worst',
  'best',
  'biggest',
  'secret',
  'truth',
  'mistake',
  'mistakes',
  'wrong',
  'crazy',
  'insane',
  'shocking',
  'actually',
  'honestly',
  'stop',
  'lie',
  'lies',
  'fail',
  'failed',
  'dangerous',
  'impossible',
  'only',
  'real',
  'reason',
  'problem',
  'changed',
  'unbelievable',
  'nothing',
  'everything',
  'free',
  'million',
  'billion',
  'must',
  "don't",
  'dont',
  "can't",
  'cant',
  "won't",
  'wont',
  'hate',
  'love',
  'afraid',
  'scary',
  'warning',
]);
const CONTRAST_TERMS = new Set(['but', 'however', 'instead', 'yet', 'versus', 'vs', 'than', 'rather']);
const DIRECT_ADDRESS = new Set(['you', 'your', "you're", "you've", 'yours', 'i', "i'm", "i've", 'my', "i'll"]);
const NUMBER_WORDS = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'hundred',
  'thousand',
  'million',
  'billion',
  'percent',
  'first',
  'second',
  'third',
  'half',
  'double',
  'triple',
]);
const STORY_OPENERS: RegExp[] = [
  /^(so )?(one|that) (day|time|night|morning)\b/,
  /^(i|we) (remember|was|were|used to|had|got|went|met|found|lost|started|tried|woke)\b/,
  /^(when|back when) (i|we|he|she|they) (was|were|first|started|got)\b/,
  /^(last|a few|three|two|five|ten) (year|years|month|months|week|weeks|summer|winter|night)\b/,
  /^(let me|i('ll| will)) (tell|show|explain)\b/,
  /^here('s| is) (the thing|what|why|how|a)\b/,
  /^(imagine|picture this|listen|look|think about)\b/,
  /^(there was|there once)\b/,
  /^the (first|biggest|worst|best|only|most) /,
  /^(you|we) (won't|wouldn't|will not|would not) believe\b/,
];

export const tokensOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .map(stripPunct)
    .filter((t) => t.length > 0);

export function hasNumberText(tokens: string[], raw: string): boolean {
  if (/\d/.test(raw)) return true;
  return tokens.some((t) => NUMBER_WORDS.has(t));
}

export interface HookFeatures {
  score: number;
  isQuestion: boolean;
  hasNumber: boolean;
}

/**
 * Hook strength (0..1) of the first ~3 seconds. `openText` is the transcript text spoken in the first
 * 3 s; `firstSentence` the clip's first sentence (for the question test).
 */
export function hookStrength(openText: string, firstSentence: string, openWordCount: number): HookFeatures {
  const tokens = tokensOf(openText);
  const lower = tokens.join(' ');
  const first = tokens[0] ?? '';
  const bigram = `${first} ${tokens[1] ?? ''}`.trim();
  let score = 0.22;

  const sentTokens = tokensOf(firstSentence);
  const isQuestion =
    /\?/.test(openText) ||
    (/\?\s*$/.test(firstSentence.trim()) && QUESTION_STARTERS.has(sentTokens[0] ?? ''));
  if (isQuestion) score += 0.26;

  const hasNum = hasNumberText(tokens, openText);
  if (hasNum) score += 0.12;

  let bold = 0;
  for (const t of tokens) if (BOLD_TERMS.has(t)) bold++;
  if (/\bno one\b/.test(lower)) bold++;
  score += Math.min(2, bold) * 0.08;

  // contrast must be in the middle of the open (a leading "but" is dangling, not a hook)
  if (tokens.slice(1).some((t) => CONTRAST_TERMS.has(t))) score += 0.07;

  if (tokens.some((t) => DIRECT_ADDRESS.has(t))) score += 0.08;

  const head = tokens.slice(0, 7).join(' ');
  if (STORY_OPENERS.some((re) => re.test(head))) score += 0.16;

  // imperative / second-person command as a first word is a classic pattern interrupt
  if (['stop', 'don\'t', 'dont', 'never', 'listen', 'watch', 'imagine', 'look'].includes(first)) score += 0.06;

  // penalties
  if (FILLER_OPENERS.has(first) || FILLER_BIGRAMS.has(bigram)) score -= 0.3;
  if (DANGLING_CONJ.has(first)) score -= 0.22;
  if (DANGLING_PRONOUN.has(first)) score -= 0.15;
  const fillerCount = tokens.filter((t) => ['um', 'uh', 'uhm', 'umm', 'er', 'erm'].includes(t)).length;
  score -= Math.min(0.2, fillerCount * 0.08);
  if (openWordCount < 3) score -= 0.15; // dead air at the start

  return { score: clamp01(score), isQuestion, hasNumber: hasNum };
}

export interface SelfContainmentInput {
  firstTokens: string[];
  lastWord: string;
  lastSentence: string;
  firstSentence: string;
  sentenceCount: number;
  /** Words after the opening question (to judge whether it is answered). */
  wordsAfterFirstSentence: number;
  speakerChanges: number;
  startsAtSentenceStart: boolean;
  endsAtSentenceEnd: boolean;
}

/** 0..1: does the clip stand on its own? */
export function selfContainment(i: SelfContainmentInput): number {
  let sc = 0.7;
  const first = i.firstTokens[0] ?? '';
  const second = i.firstTokens[1] ?? '';
  if (!i.startsAtSentenceStart) sc -= 0.25;
  if (DANGLING_CONJ.has(first) || (first === 'and' && second === 'then')) sc -= 0.35;
  else if (FILLER_OPENERS.has(first)) sc -= 0.12;
  if (DANGLING_PRONOUN.has(first)) sc -= 0.18;
  else if (first === 'that' || first === 'this') sc -= 0.06;

  const end = i.lastSentence.trim();
  if (!i.endsAtSentenceEnd || !/[.?!…]["')\]]*$/.test(end)) sc -= 0.25;
  const lastTok = stripPunct(i.lastWord);
  if (WEAK_END_WORDS.has(lastTok) && !/[.?!]$/.test(end)) sc -= 0.2;

  const opensWithQuestion = /\?\s*$/.test(i.firstSentence.trim());
  if (opensWithQuestion) {
    if (i.sentenceCount >= 2 && i.wordsAfterFirstSentence >= 8) sc += 0.2; // question gets an answer
    else sc -= 0.3;
  }
  if (/\?\s*$/.test(end) && i.sentenceCount >= 2 && !opensWithQuestion) sc -= 0.25; // ends on an open question
  if (/\?\s*$/.test(end) && i.sentenceCount === 1) sc -= 0.2;

  sc -= Math.min(0.2, 0.05 * Math.max(0, i.speakerChanges - 1));
  // a complete thought with several sentences is more likely to be a full story
  if (i.sentenceCount >= 3) sc += 0.08;
  return clamp01(sc);
}

export const sentenceHasQuestion = (text: string): boolean => /\?/.test(text);
