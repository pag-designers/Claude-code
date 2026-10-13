import {
  AudioLines,
  Captions,
  Clapperboard,
  Crop,
  FileText,
  Film,
  Gamepad2,
  Layers,
  type LucideIcon,
  MessageSquareQuote,
  Radio,
  ScrollText,
  Scissors,
  Sparkles,
  Wand2,
  Image as ImageIcon,
} from 'lucide-react';

export type ToolGroup = 'Clip' | 'Polish' | 'Understand' | 'Later';

export interface Tool {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  group: ToolGroup;
  /** Checkpoint in which it lands (BRIEF §11). `null` = LATER (post v1). */
  checkpoint: number | null;
  /** Where the tool lives. Absent = not available yet (card disabled with "Coming in a later version"). */
  href?: string;
}

export const TOOLS: Tool[] = [
  {
    id: 'ai-clipping',
    name: 'AI Clipping',
    description: 'Paste a YouTube URL and get scored, captioned, reframed clips.',
    icon: Scissors,
    group: 'Clip',
    checkpoint: 1,
    href: '/',
  },
  {
    id: 'find-moments',
    name: 'Find Moments',
    description: 'Steer the search: “only the funny parts”, “guest speaking”, “about pricing”.',
    icon: Sparkles,
    group: 'Clip',
    checkpoint: 2,
    href: '/tools/find-moments/',
  },
  {
    id: 'highlights',
    name: 'One-Click Highlights',
    description: 'A single 60–90 s highlight reel stitched from the best micro-moments.',
    icon: Film,
    group: 'Clip',
    checkpoint: 2,
    href: '/tools/highlights/',
  },
  {
    id: 'live-clipping',
    name: 'Live Clipping',
    description: 'Clip live streams as they happen, with a “clip the last 60 s” hotkey.',
    icon: Radio,
    group: 'Clip',
    checkpoint: 7,
  },
  {
    id: 'editor',
    name: 'Video Editor',
    description: 'A multi-track timeline with keyframes, transitions and subtitle editing.',
    icon: Clapperboard,
    group: 'Polish',
    checkpoint: 3,
  },
  {
    id: 'subtitles',
    name: 'AI Subtitles',
    description: 'Word-level captions in 14 styles, exported burned-in or as SRT/VTT.',
    icon: Captions,
    group: 'Polish',
    checkpoint: 2,
    href: '/tools/subtitles/',
  },
  {
    id: 'reframe',
    name: 'AI Reframe',
    description: 'Face-tracked 9:16, 1:1 and 4:5 crops with split-screen layouts.',
    icon: Crop,
    group: 'Polish',
    checkpoint: 1,
    href: '/tools/reframe/',
  },
  {
    id: 'hook',
    name: 'AI Hook',
    description: 'Five hook variants per clip, tuned for TikTok, Reels and Shorts.',
    icon: MessageSquareQuote,
    group: 'Polish',
    checkpoint: 2,
    href: '/tools/hook/',
  },
  {
    id: 'thumbnail',
    name: 'AI Thumbnail',
    description: 'Best-frame picker with a feed-mockup tester.',
    icon: ImageIcon,
    group: 'Polish',
    checkpoint: 2,
    href: '/tools/thumbnail/',
  },
  {
    id: 'broll',
    name: 'B-roll',
    description: 'Stock cutaways from Pexels and Pixabay, proposed per sentence.',
    icon: Layers,
    group: 'Polish',
    checkpoint: 4,
  },
  {
    id: 'summary',
    name: 'Video Summary',
    description: 'Overview, chapters, key takeaways and structured notes.',
    icon: FileText,
    group: 'Understand',
    checkpoint: 2,
    href: '/tools/summary/',
  },
  {
    id: 'transcripts',
    name: 'Video Transcripts',
    description: 'Word-timed transcripts you can search, edit and export.',
    icon: ScrollText,
    group: 'Understand',
    checkpoint: 2,
    href: '/tools/transcripts/',
  },
  {
    id: 'game-clipping',
    name: 'Game Clipping',
    description: 'Kill and win detection for gameplay footage.',
    icon: Gamepad2,
    group: 'Later',
    checkpoint: null,
  },
  {
    id: 'speech-enhancer',
    name: 'Speech Enhancer',
    description: 'Noise and echo removal for cleaner voice audio.',
    icon: AudioLines,
    group: 'Later',
    checkpoint: null,
  },
  {
    id: 'video-generator',
    name: 'AI Video Generator',
    description: 'Generate original video from a prompt.',
    icon: Wand2,
    group: 'Later',
    checkpoint: null,
  },
];

export const LATER_HINT = 'Coming in a later version';
export const isToolAvailable = (t: Tool): boolean => !!t.href;
export const toolHint = (t: Tool) => (t.href ? t.description : LATER_HINT);
