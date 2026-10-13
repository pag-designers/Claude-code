/**
 * Standalone tool routes (BRIEF §6 "Tools hub"): ids, copy and helpers shared by the hub, the routes and the command
 * palette. Deliberately NOT a 'use client' module and free of icon imports, so the static route
 * (`app/tools/[tool]/page.tsx`) can import `TOOL_ROUTE_IDS` in `generateStaticParams`.
 */
import type { VideoAnalysis } from '@shared/pipeline';

export const TOOL_ROUTE_IDS = [
  'find-moments',
  'highlights',
  'summary',
  'transcripts',
  'subtitles',
  'reframe',
  'thumbnail',
  'hook',
] as const;
export type ToolRouteId = (typeof TOOL_ROUTE_IDS)[number];

export const isToolRouteId = (v: string | null | undefined): v is ToolRouteId =>
  !!v && (TOOL_ROUTE_IDS as readonly string[]).includes(v);

/** What a tool needs from the chosen video before it can do its job. */
export type ToolNeeds = 'analysis' | 'transcript' | 'clips';

export interface ToolRouteMeta {
  title: string;
  /** One line under the title once a video is chosen. */
  blurb: string;
  /** Shown above the picker. */
  pickerHint: string;
  needs: ToolNeeds;
}

export const TOOL_ROUTE_META: Record<ToolRouteId, ToolRouteMeta> = {
  'find-moments': {
    title: 'Find Moments',
    blurb: 'Steer the search with a plain-language request and Clipfern cuts the matching moments.',
    pickerHint: 'Choose a video that has been transcribed to search for new moments.',
    needs: 'transcript',
  },
  highlights: {
    title: 'One-Click Highlights',
    blurb: 'A single highlight reel stitched from the best micro-moments, in the order that tells the story.',
    pickerHint: 'Choose a transcribed video to build its highlight reel.',
    needs: 'transcript',
  },
  summary: {
    title: 'Video Summary',
    blurb: 'Overview, chapters, key takeaways and structured notes, ready to copy or download.',
    pickerHint: 'Choose a video to read its summary, or analyse a new one.',
    needs: 'analysis',
  },
  transcripts: {
    title: 'Video Transcripts',
    blurb: 'A word-timed transcript you can search, copy and export as TXT, SRT or VTT.',
    pickerHint: 'Choose a video to open its transcript, or analyse a new one.',
    needs: 'transcript',
  },
  subtitles: {
    title: 'AI Subtitles',
    blurb: 'Edit every caption inline, retime it, and pick a caption style with a live preview.',
    pickerHint: 'Choose a video to edit its captions, or analyse a new one.',
    needs: 'transcript',
  },
  reframe: {
    title: 'AI Reframe',
    blurb: 'Pick how each clip is cropped to vertical: follow a face, split two people, or show the screen.',
    pickerHint: 'Choose a video that already has clips.',
    needs: 'clips',
  },
  thumbnail: {
    title: 'AI Thumbnail',
    blurb: 'Best-frame candidates for a clip, with a feed mock-up to compare them side by side.',
    pickerHint: 'Choose a video, then pick one of its clips.',
    needs: 'clips',
  },
  hook: {
    title: 'AI Hook',
    blurb: 'Five hook variants per platform for a clip, and one click to burn the best in.',
    pickerHint: 'Choose a video, then pick one of its clips.',
    needs: 'clips',
  },
};

export function toolHref(tool: ToolRouteId, params: { video?: string | null; clip?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (params.video) q.set('video', params.video);
  if (params.clip) q.set('clip', params.clip);
  const qs = q.toString();
  return `/tools/${tool}/${qs ? `?${qs}` : ''}`;
}

export const LAST_VIDEO_KEY = 'clipfern.tools.lastVideo';

export function readLastVideo(): string | null {
  try {
    return localStorage.getItem(LAST_VIDEO_KEY);
  } catch {
    return null;
  }
}
export function rememberVideo(id: string): void {
  try {
    localStorage.setItem(LAST_VIDEO_KEY, id);
  } catch {
    /* storage blocked: the choice is simply not remembered */
  }
}

/** "My Video: Title!" -> "my-video-title" (safe file name stem). */
export function slugify(text: string, fallback = 'video'): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

const clock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

/** The whole summary as Markdown: overview, takeaways, chapters, notes and topics. */
export function summaryToMarkdown(
  title: string,
  meta: { channel?: string | null; sourceUrl?: string | null; durationSec?: number | null },
  a: VideoAnalysis,
): string {
  const out: string[] = [`# ${title}`, ''];
  const facts = [
    meta.channel,
    meta.durationSec ? clock(meta.durationSec) : null,
    a.overview.tone ? `Tone: ${a.overview.tone}` : null,
  ].filter(Boolean);
  if (facts.length) out.push(`_${facts.join(' · ')}_`, '');
  if (meta.sourceUrl) out.push(`Source: ${meta.sourceUrl}`, '');
  out.push('## Summary', '', a.overview.summary, '');
  if (a.overview.participants.length) out.push(`**Participants:** ${a.overview.participants.join(', ')}`, '');
  const list = (h: string, items: string[]) => {
    if (items.length) out.push(`## ${h}`, '', ...items.map((i) => `- ${i}`), '');
  };
  const stamped = (h: string, items: { text: string; at: number }[]) =>
    list(
      h,
      items.map((i) => `[${clock(i.at)}] ${i.text}`),
    );
  list('Key takeaways', a.overview.takeaways);
  if (a.chapters.length) {
    out.push('## Chapters', '');
    for (const c of a.chapters) out.push(`- **${clock(c.start)} ${c.title}**: ${c.summary}`);
    out.push('');
  }
  list('Key points', a.notes.keyPoints);
  stamped('Quotes', a.notes.quotes);
  stamped('Numbers', a.notes.numbers);
  stamped('Claims', a.notes.claims);
  list('Action items', a.notes.actionItems);
  if (a.topics.length) out.push('## Topics', '', a.topics.join(', '), '');
  if (a.keywords.length) out.push('## Keywords', '', a.keywords.join(', '), '');
  return `${out.join('\n').trim()}\n`;
}

/** Triggers a browser download of a text file (no IPC: works the same in Electron and a plain browser). */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
