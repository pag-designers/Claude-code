/**
 * TEST-ONLY realistic fixture content for the CP1 renderer stub: a short interview transcript with word-level timings,
 * its AI analysis, scored clips, and a long (12k word) podcast transcript for windowing/perf checks.
 * Everything is shaped by the REAL shared zod types and validated by the stub through the contract.
 */
import { totalScore } from '../../../shared/pipeline';
import type {
  ClipView,
  Sentence,
  ScoreBreakdown,
  StageState,
  Transcript,
  VideoAnalysis,
  VideoView,
  Word,
} from '../../../shared/pipeline';
import { pipelineOptionsSchema, PIPELINE_STAGES } from '../../../shared/pipeline';

/* -------------------------------------------------- transcript --------------------------------------------------- */

interface Line {
  speaker: string;
  text: string;
}

const H = 'Speaker 1';
const T = 'Speaker 2';
const A = 'Speaker 3';

/** 48 sentences of a community-news style interview (about 3 minutes once timed). Index = sentence id. */
export const INTERVIEW: Line[] = [
  { speaker: H, text: 'Welcome back to Community Conversations, I’m so glad you’re here.' },
  {
    speaker: H,
    text: 'April is Autism Awareness Month, and today we’re talking about what awareness actually looks like in a small town.',
  },
  {
    speaker: H,
    text: 'Joining me are a pediatric therapist who has worked with local families for twenty years, and an artist whose latest exhibit opens this weekend.',
  },
  { speaker: T, text: 'Thanks for having me.' },
  {
    speaker: T,
    text: 'The first thing I tell parents is that there’s no single way to be autistic.',
  },
  { speaker: T, text: 'If you’ve met one autistic child, you’ve met one autistic child.' },
  { speaker: T, text: 'So the goal of therapy is never to make a kid act typical.' },
  {
    speaker: T,
    text: 'It’s to help them communicate what they need in a way the world can understand.',
  },
  { speaker: H, text: 'That’s a powerful way to frame it.' },
  { speaker: H, text: 'What’s the biggest misunderstanding you still hear?' },
  { speaker: T, text: 'That awareness is enough.' },
  { speaker: T, text: 'Awareness means people know the word.' },
  { speaker: T, text: 'Acceptance means they change something in the room.' },
  { speaker: T, text: 'Lower the lights, give a quiet corner, let a kid stim without staring.' },
  {
    speaker: T,
    text: 'Those tiny changes decide whether a family comes back to the library, the park, the restaurant.',
  },
  { speaker: T, text: 'I’ve seen one patient server turn a family’s whole year around.' },
  { speaker: H, text: 'Let’s bring in our other guest.' },
  {
    speaker: H,
    text: 'You’ve spent four hundred hours on a single collage, which honestly blows my mind.',
  },
  { speaker: A, text: 'Four hundred and twelve, if we’re counting.' },
  {
    speaker: A,
    text: 'Each portrait is made from thousands of tiny paper scraps: magazine pages, old maps, receipts.',
  },
  { speaker: A, text: 'People ask why I don’t just paint it.' },
  {
    speaker: A,
    text: 'Because every scrap already has a story, and the piece is about stories being layered on top of each other.',
  },
  {
    speaker: A,
    text: 'My nephew is autistic, and he taught me to look at texture before I look at a face.',
  },
  { speaker: A, text: 'Now I build the texture first and the face appears last.' },
  { speaker: H, text: 'So the process changed how you see the final image.' },
  { speaker: A, text: 'Completely.' },
  { speaker: A, text: 'I used to start with an outline and fill it in.' },
  {
    speaker: A,
    text: 'Now I lay down color, let it be messy, and wait for the picture to tell me what it is.',
  },
  { speaker: A, text: 'It took me forty years to trust that, and one ten-year-old to teach me.' },
  { speaker: T, text: 'That’s exactly what we try to do in sessions.' },
  { speaker: T, text: 'Follow the child’s lead, and the structure shows up on its own.' },
  {
    speaker: T,
    text: 'There’s research behind it, but honestly, the proof is the first time a nonverbal kid hands you a drawing and says, this is my sister.',
  },
  { speaker: H, text: 'Okay, I have goosebumps.' },
  { speaker: H, text: 'For families watching at home, what’s one thing they can do this week?' },
  { speaker: T, text: 'Ask the family what they need before you offer help.' },
  { speaker: T, text: 'Not what you think they need.' },
  { speaker: T, text: 'What they say they need.' },
  {
    speaker: T,
    text: 'Most of the time it’s something small, like a quiet hour, a ride, or just being invited.',
  },
  { speaker: A, text: 'And invite the kids to make something.' },
  {
    speaker: A,
    text: 'Our workshop on Saturday is free, every material is sensory friendly, and nobody has to talk.',
  },
  { speaker: A, text: 'You can just sit and tear paper.' },
  { speaker: H, text: 'I love that.' },
  { speaker: H, text: 'Where can people find the exhibit?' },
  {
    speaker: A,
    text: 'The community arts center on Main Street, opening Friday at six, running through the end of the month.',
  },
  { speaker: A, text: 'Come early, the first fifty visitors get a small collage kit.' },
  { speaker: H, text: 'Wonderful.' },
  { speaker: H, text: 'Thank you both for being so generous with your time and your stories.' },
  {
    speaker: H,
    text: 'If this conversation meant something to you, share it with a neighbor, and we’ll see you next week.',
  },
];

/** Deterministic pseudo-random in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Times a script: each word gets a duration from its length, sentences are separated by a short pause, then everything
 * is scaled so the last word ends at `durationSec - tail`. Output satisfies transcriptSchema (word index ranges inclusive).
 */
export function buildTranscript(
  lines: Line[],
  durationSec: number,
  opts: { model?: string; lead?: number; tail?: number; seed?: number } = {},
): Transcript {
  const rnd = lcg(opts.seed ?? 7);
  const lead = opts.lead ?? 1.2;
  const tail = opts.tail ?? 2.5;
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  let t = 0;
  lines.forEach((line, id) => {
    const toks = line.text.split(/\s+/).filter(Boolean);
    const wordStart = words.length;
    const sStart = t;
    toks.forEach((w) => {
      const d = 0.16 + Math.min(w.length, 12) * 0.028 + rnd() * 0.05;
      words.push({ w, s: t, e: t + d, p: Math.round((0.9 + rnd() * 0.09) * 100) / 100 });
      t += d + 0.015;
    });
    sentences.push({
      id,
      s: sStart,
      e: t - 0.015,
      text: line.text,
      speaker: line.speaker,
      wordStart,
      wordEnd: words.length - 1,
    });
    t +=
      0.28 + rnd() * 0.35 + (lines[id + 1] && lines[id + 1]!.speaker !== line.speaker ? 0.35 : 0);
  });
  const scale = (durationSec - tail - lead) / Math.max(t, 1);
  const f = (x: number) => Math.round((lead + x * scale) * 1000) / 1000;
  for (const w of words) {
    w.s = f(w.s);
    w.e = f(w.e);
  }
  for (const s of sentences) {
    s.s = f(s.s);
    s.e = f(s.e);
  }
  return {
    language: 'en',
    languageProbability: 0.99,
    durationSec,
    model: opts.model ?? 'large-v3-turbo',
    words,
    sentences,
  };
}

/* Long-form generator: ~12k words of plausible podcast talk, deterministic. */
const OPENERS = [
  'Honestly,',
  'The thing is,',
  'I think',
  'What surprised me was that',
  'Look,',
  'And you know what?',
  'To be fair,',
  'Here’s what nobody tells you:',
  'My take is that',
  'Right, so',
];
const SUBJECTS = [
  'most founders',
  'the early customers',
  'our first hire',
  'a small team',
  'the roadmap',
  'pricing',
  'the board',
  'our runway',
  'a good product',
  'the market',
  'support tickets',
  'the onboarding flow',
];
const VERBS = [
  'underestimate',
  'quietly drive',
  'rarely admit',
  'always come back to',
  'forget about',
  'get wrong about',
  'depend on',
  'learn from',
  'push back on',
  'obsess over',
];
const OBJECTS = [
  'how slowly trust builds',
  'the boring work that compounds',
  'what customers actually pay for',
  'the first ten conversations',
  'saying no early',
  'a calm week of shipping',
  'the price of speed',
  'the small decisions nobody sees',
  'one honest metric',
  'a long, patient bet',
];
const TAILS = [
  'and that changes everything.',
  'which is harder than it sounds.',
  'and it took us two years to see it.',
  'so we wrote it on the wall.',
  'but we kept doing it anyway.',
  'and I’d do it again.',
  'because the alternative was worse.',
  'and nobody clapped for it.',
];

export function buildLongLines(targetWords: number): Line[] {
  const rnd = lcg(42);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const lines: Line[] = [];
  let count = 0;
  let speaker = 0;
  while (count < targetWords) {
    const text = `${pick(OPENERS)} ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)}, ${pick(TAILS)}`;
    count += text.split(' ').length;
    if (rnd() < 0.22) speaker = (speaker + 1) % 2;
    lines.push({ speaker: speaker === 0 ? 'Speaker 1' : 'Speaker 2', text });
  }
  return lines;
}

/* ---------------------------------------------------- analysis --------------------------------------------------- */

const at = (tr: Transcript, sentenceIdx: number): number =>
  Math.round((tr.sentences[sentenceIdx]?.s ?? 0) * 10) / 10;

export function interviewAnalysis(tr: Transcript): VideoAnalysis {
  const dur = tr.durationSec;
  const cut = (f: number) => Math.round(dur * f);
  return {
    overview: {
      summary:
        'A warm, practical conversation from a local news program about what Autism Awareness Month should mean in a small town. A pediatric therapist argues that awareness is not enough and acceptance means changing the room; a collage artist explains how his nephew changed the way he builds portraits; and the host closes with concrete things families and neighbors can do this week.',
      tone: 'Warm, reflective',
      participants: ['Host', 'Pediatric therapist', 'Collage artist'],
      takeaways: [
        'Awareness means people know the word; acceptance means they change something in the room.',
        'Therapy is not about acting typical but about communicating needs in a way others can understand.',
        'Tiny environmental changes decide whether a family comes back to public places.',
        'Following a child’s lead, in therapy and in art, lets structure appear on its own.',
        'Ask families what they say they need before offering help, and invite the kids to make something.',
      ],
    },
    chapters: [
      {
        title: 'Welcome and introductions',
        start: 0,
        end: cut(0.12),
        summary: 'The host sets up the month and introduces a therapist and a collage artist.',
        source: 'youtube',
      },
      {
        title: 'There is no single way to be autistic',
        start: cut(0.12),
        end: cut(0.32),
        summary: 'The therapist reframes the goal of therapy as communication, not conformity.',
        source: 'ai',
      },
      {
        title: 'Awareness versus acceptance',
        start: cut(0.32),
        end: cut(0.5),
        summary: 'Small changes in a room decide whether families return to public spaces.',
        source: 'ai',
      },
      {
        title: 'Four hundred hours of paper',
        start: cut(0.5),
        end: cut(0.72),
        summary: 'The artist describes his texture-first process and what his nephew taught him.',
        source: 'ai',
      },
      {
        title: 'What families can do this week',
        start: cut(0.72),
        end: cut(0.92),
        summary: 'Ask what a family needs, invite children to a sensory-friendly workshop.',
        source: 'ai',
      },
      {
        title: 'Where to see the exhibit',
        start: cut(0.92),
        end: dur,
        summary: 'Opening night details and a goodbye.',
        source: 'youtube',
      },
    ],
    notes: {
      keyPoints: [
        'Awareness is knowing the word; acceptance is changing the room.',
        'The goal of therapy is communication, not typical behavior.',
        'Quiet corners and lower lights decide whether a family returns.',
        'Texture first, face last: the artist’s process was reshaped by his nephew.',
        'Ask families what they say they need, not what you assume.',
      ],
      quotes: [
        { text: 'If you’ve met one autistic child, you’ve met one autistic child.', at: at(tr, 5) },
        {
          text: 'Awareness means people know the word. Acceptance means they change something in the room.',
          at: at(tr, 11),
        },
        {
          text: 'It took me forty years to trust that, and one ten-year-old to teach me.',
          at: at(tr, 28),
        },
      ],
      numbers: [
        { text: 'Twenty years of working with local families (therapist).', at: at(tr, 2) },
        {
          text: '412 hours on a single collage, built from thousands of paper scraps.',
          at: at(tr, 18),
        },
        { text: 'The first fifty visitors on opening night get a collage kit.', at: at(tr, 44) },
      ],
      claims: [
        { text: 'One attentive server can turn a family’s whole year around.', at: at(tr, 15) },
        { text: 'Following the child’s lead lets structure appear on its own.', at: at(tr, 30) },
      ],
      actionItems: [
        'Ask a family what they need before you offer help.',
        'Lower the lights and offer a quiet corner at community events.',
        'Bring a child to Saturday’s free sensory-friendly workshop.',
        'Visit the exhibit opening Friday at six at the community arts center.',
      ],
    },
    topics: ['Autism acceptance', 'Community inclusion', 'Collage art', 'Therapy approaches'],
    entities: ['Community arts center', 'Main Street'],
    keywords: ['acceptance', 'sensory friendly', 'collage', 'texture', 'workshop', 'inclusion'],
  };
}

/* ------------------------------------------------------ clips ---------------------------------------------------- */

export interface ClipTemplate {
  title: string;
  hook: string;
  why: string;
  /** inclusive sentence index range in the interview */
  from: number;
  to: number;
  breakdown: ScoreBreakdown;
  confidence: number;
  thumb: string;
  render: string;
}

export const CLIP_TEMPLATES: ClipTemplate[] = [
  {
    title: 'Awareness isn’t enough. Acceptance changes the room.',
    hook: 'Awareness means people know the word.',
    why: 'A crisp definition delivered as a reframe in the first three seconds, followed by three concrete examples and a story payoff. Highly quotable.',
    from: 10,
    to: 15,
    breakdown: { hook: 24, retention: 23, emotion: 18, clarity: 14, shareability: 15 },
    confidence: 0.92,
    thumb: 'c1.jpg',
    render: 'clip-a.webm',
  },
  {
    title: 'The 412-hour collage that starts with texture',
    hook: 'Four hundred and twelve, if we’re counting.',
    why: 'Opens with a surprising number, builds curiosity about the method, and lands on an emotional reveal about his nephew.',
    from: 18,
    to: 23,
    breakdown: { hook: 22, retention: 23, emotion: 18, clarity: 13, shareability: 15 },
    confidence: 0.88,
    thumb: 'c2.jpg',
    render: 'clip-b.webm',
  },
  {
    title: '“It took me forty years to trust that”',
    hook: 'It took me forty years to trust that, and one ten-year-old to teach me.',
    why: 'A vulnerable, quotable line with a clear before/after arc and a warm payoff.',
    from: 25,
    to: 28,
    breakdown: { hook: 20, retention: 20, emotion: 19, clarity: 12, shareability: 14 },
    confidence: 0.86,
    thumb: 'c3.jpg',
    render: 'clip-c.webm',
  },
  {
    title: 'The proof is a drawing that says “this is my sister”',
    hook: 'The proof is the first time a nonverbal kid hands you a drawing.',
    why: 'Concrete image and an emotional peak; works well as a stand-alone testimonial.',
    from: 29,
    to: 31,
    breakdown: { hook: 19, retention: 19, emotion: 19, clarity: 11, shareability: 13 },
    confidence: 0.83,
    thumb: 'c4.jpg',
    render: 'clip-a.webm',
  },
  {
    title: 'One autistic child, one way of being autistic',
    hook: 'If you’ve met one autistic child, you’ve met one autistic child.',
    why: 'Memorable aphorism up front; clear goal statement follows.',
    from: 4,
    to: 7,
    breakdown: { hook: 18, retention: 17, emotion: 14, clarity: 14, shareability: 14 },
    confidence: 0.8,
    thumb: 'c5.jpg',
    render: 'clip-b.webm',
  },
  {
    title: 'Ask what they say they need, not what you think',
    hook: 'Ask the family what they need before you offer help.',
    why: 'Actionable advice with a simple three-step rhythm that is easy to follow and share.',
    from: 34,
    to: 37,
    breakdown: { hook: 16, retention: 15, emotion: 11, clarity: 14, shareability: 12 },
    confidence: 0.77,
    thumb: 'c6.jpg',
    render: 'clip-c.webm',
  },
  {
    title: 'Nobody has to talk: tear paper with us on Saturday',
    hook: 'Our workshop on Saturday is free, and nobody has to talk.',
    why: 'Clear call to action with an inviting tone; weaker hook but strong clarity.',
    from: 39,
    to: 41,
    breakdown: { hook: 13, retention: 14, emotion: 9, clarity: 13, shareability: 10 },
    confidence: 0.7,
    thumb: 'c7.jpg',
    render: 'clip-a.webm',
  },
  {
    title: 'Opening night: where and when',
    hook: 'The community arts center on Main Street, opening Friday at six.',
    why: 'Informational and local; useful but low emotional energy.',
    from: 43,
    to: 44,
    breakdown: { hook: 10, retention: 11, emotion: 7, clarity: 14, shareability: 6 },
    confidence: 0.66,
    thumb: 'c8.jpg',
    render: 'clip-b.webm',
  },
  {
    title: 'Welcome to Community Conversations',
    hook: 'Welcome back to Community Conversations.',
    why: 'Standard intro; no hook or payoff on its own.',
    from: 0,
    to: 2,
    breakdown: { hook: 8, retention: 9, emotion: 6, clarity: 12, shareability: 5 },
    confidence: 0.6,
    thumb: 'c9.jpg',
    render: 'clip-c.webm',
  },
];

export function clipFromTemplate(
  tpl: ClipTemplate,
  tr: Transcript,
  opts: {
    id: string;
    videoId: string;
    videoTitle: string;
    createdAt: number;
    rank: number;
    status?: ClipView['status'];
    favorite?: boolean;
    error?: string | null;
  },
): ClipView {
  const s = tr.sentences[tpl.from]!;
  const e = tr.sentences[tpl.to]!;
  const startSec = Math.max(0, Math.round((s.s - 0.15) * 100) / 100);
  const endSec = Math.round((e.e + 0.2) * 100) / 100;
  const status = opts.status ?? 'rendered';
  const rendered = status === 'rendered';
  return {
    id: opts.id,
    videoId: opts.videoId,
    videoTitle: opts.videoTitle,
    title: tpl.title,
    hook: tpl.hook,
    startSec,
    endSec,
    durationSec: Math.round((endSec - startSec) * 10) / 10,
    score: totalScore(tpl.breakdown),
    breakdown: tpl.breakdown,
    confidence: tpl.confidence,
    whyItWorks: tpl.why,
    status,
    renderProgress: status === 'rendering' ? 0.45 : null,
    error: opts.error ?? null,
    favorite: opts.favorite ?? false,
    tags: [],
    aspect: '9:16',
    hasRender: rendered,
    hasThumb: rendered || status === 'rendering',
    rank: opts.rank,
    createdAt: opts.createdAt,
  };
}

/* ------------------------------------------------------- stages -------------------------------------------------- */

export function doneStages(startedAt: number): StageState[] {
  const spans = [34, 9, 52, 21, 38, 64, 12];
  const msgs = [
    'Downloaded 1080p (212 MB)',
    'Audio extracted · 480p proxy ready',
    'Transcribed 2,986 words (EN)',
    'Overview, 6 chapters and notes written',
    'Found 9 moments',
    'Rendered 9 clips',
    'Uploaded 18 files · cleaned up',
  ];
  let t = startedAt;
  return PIPELINE_STAGES.map((stage, i) => {
    const s = t;
    t += (spans[i] ?? 10) * 1000;
    return {
      stage,
      status: 'done' as const,
      progress: 1,
      message: msgs[i] ?? null,
      startedAt: s,
      finishedAt: t,
      error: null,
      detail: null,
    };
  });
}

/* -------------------------------------------------------- videos ------------------------------------------------- */

export const BASE_OPTIONS = pipelineOptionsSchema.parse({ clipPreset: '15-30', clipCount: 10 });

export function videoView(
  p: Partial<VideoView> & Pick<VideoView, 'id' | 'title' | 'sourceUrl'>,
): VideoView {
  return {
    sourceId: p.id.replace(/^vid-/, '').slice(0, 11),
    channel: null,
    durationSec: null,
    thumbnail: null,
    status: 'ready',
    stage: null,
    progress: null,
    error: null,
    favorite: false,
    clipCount: 0,
    renderedCount: 0,
    topScore: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasProxy: false,
    options: BASE_OPTIONS,
    ...p,
  };
}
