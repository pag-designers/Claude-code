import { z } from 'zod';
import type { Sentence } from '@shared/pipeline';
import type { ToolDef } from '../llm/client';
import { toJsonSchema } from '../llm/schemas';
import { fmtClock } from '../llm/transcript';

/**
 * The five client tools of the chat assistant (BRIEF §6 "AI Chat"). Definitions are STRICT tool
 * schemas (all properties required, optional ones nullable, no numeric bounds - those are not allowed
 * in strict schemas). Every input is validated again here BEFORE anything executes, against the
 * actual video: a model can still send out-of-range times (strict mode guarantees types, not ranges).
 */

export type ToolName =
  'create_clip' | 'add_marker' | 'write_metadata' | 'rewrite_hook' | 'find_moments';

export const CLIP_MIN_SEC = 3;
export const CLIP_MAX_SEC = 180;
export const TITLE_MAX = 80;
const LABEL_MAX = 80;
const TEXT_MAX = 300;

const createClip = z.object({
  startSec: z
    .number()
    .describe(
      'Start in seconds from the start of the video (convert [mm:ss] to seconds). Begin on the first word of a sentence.',
    ),
  endSec: z
    .number()
    .describe(
      'End in seconds from the start of the video. End after the last word of a sentence. 3-180 seconds after startSec.',
    ),
  title: z.string().describe('Clip title, at most 80 characters, true to what is said.'),
});
const addMarker = z.object({
  atSec: z.number().describe('Position in seconds from the start of the video.'),
  label: z.string().describe('Short marker label, at most 80 characters.'),
});
const writeMetadata = z.object({
  platform: z
    .enum(['tiktok', 'reels', 'shorts', 'all'])
    .describe('Which platform to write titles, descriptions and hashtags for, or "all".'),
});
const rewriteHook = z.object({
  clipId: z
    .string()
    .nullable()
    .describe('Id of the open clip (shown in <clip_context>), or null for the open clip.'),
  instruction: z
    .string()
    .nullable()
    .describe('Optional direction for the new hook, e.g. "more provocative", or null.'),
});
const findMoments = z.object({
  prompt: z
    .string()
    .describe('What to look for, e.g. "the funniest moments" or "where they talk about pricing".'),
});

export const TOOL_SCHEMAS = {
  create_clip: createClip,
  add_marker: addMarker,
  write_metadata: writeMetadata,
  rewrite_hook: rewriteHook,
  find_moments: findMoments,
} as const;

export const CHAT_TOOLS: ToolDef[] = [
  {
    name: 'create_clip',
    description:
      'Create a new clip from a span of this video. Call it only when the user asks to make, cut or save a clip. Pick the span from the transcript so that it starts at the beginning of a sentence and ends at the end of a sentence.',
    input_schema: toJsonSchema(createClip) as ToolDef['input_schema'],
  },
  {
    name: 'add_marker',
    description:
      'Add a labelled marker at one point of the video timeline. Call it only when the user asks to mark, bookmark or flag a moment.',
    input_schema: toJsonSchema(addMarker) as ToolDef['input_schema'],
  },
  {
    name: 'write_metadata',
    description:
      'Write titles, descriptions, hashtags and a posting-time suggestion for the open clip. Call it only when the user asks for metadata, captions or hashtags. Needs an open clip.',
    input_schema: toJsonSchema(writeMetadata) as ToolDef['input_schema'],
  },
  {
    name: 'rewrite_hook',
    description:
      'Write new hook variants for the open clip. Call it only when the user asks to rewrite or improve the hook. Needs an open clip.',
    input_schema: toJsonSchema(rewriteHook) as ToolDef['input_schema'],
  },
  {
    name: 'find_moments',
    description:
      'Start a search for the best clip candidates in the whole video that match a request. Call it only when the user asks to find or add moments or clips about something.',
    input_schema: toJsonSchema(findMoments) as ToolDef['input_schema'],
  },
];

export interface ToolValidationContext {
  durationSec: number;
  /** Sentences of the video, sorted by time (may be empty). */
  sentences: readonly Sentence[];
  /** Id of the clip the chat is attached to. */
  clipId: string | null;
}

export type ToolValidation =
  { ok: true; input: Record<string, unknown> } | { ok: false; message: string };

const fail = (message: string): ToolValidation => ({ ok: false, message });
const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
const clock = (s: number) => fmtClock(s, s >= 3600);

export function isToolName(n: string): n is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, n);
}

/** Validates (and normalises) one tool call. The message is shown to the model as an error result. */
export function validateToolCall(
  name: string,
  raw: unknown,
  v: ToolValidationContext,
): ToolValidation {
  if (!isToolName(name)) return fail(`Unknown tool "${name}".`);
  const parsed = TOOL_SCHEMAS[name].safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    return fail(`Invalid input for ${name}: ${why}.`);
  }
  switch (name) {
    case 'create_clip': {
      const p = parsed.data as z.infer<typeof createClip>;
      if (!Number.isFinite(p.startSec) || !Number.isFinite(p.endSec))
        return fail('startSec and endSec must be numbers of seconds.');
      const title = flat(p.title);
      if (!title) return fail('The clip needs a title.');
      if (title.length > TITLE_MAX)
        return fail(`The title has ${title.length} characters; use at most ${TITLE_MAX}.`);
      let start = p.startSec;
      let end = p.endSec;
      if (start < 0 || start >= v.durationSec)
        return fail(
          `startSec ${start} is outside the video (0 to ${Math.floor(v.durationSec)} seconds, i.e. ${clock(v.durationSec)}). Remember: seconds, not mm:ss.`,
        );
      if (end > v.durationSec + 1.5)
        return fail(
          `endSec ${end} is past the end of the video (${Math.floor(v.durationSec)} seconds, i.e. ${clock(v.durationSec)}).`,
        );
      end = Math.min(end, v.durationSec);
      if (end <= start) return fail('endSec must be greater than startSec.');
      [start, end] = snapSpan(v.sentences, start, end);
      const len = end - start;
      if (len < CLIP_MIN_SEC)
        return fail(
          `The clip would be ${len.toFixed(1)} seconds long; the minimum is ${CLIP_MIN_SEC}.`,
        );
      if (len > CLIP_MAX_SEC)
        return fail(
          `The clip would be ${Math.round(len)} seconds long; short-form clips are at most ${CLIP_MAX_SEC} seconds. Pick a shorter span.`,
        );
      return { ok: true, input: { startSec: round1(start), endSec: round1(end), title } };
    }
    case 'add_marker': {
      const p = parsed.data as z.infer<typeof addMarker>;
      if (!Number.isFinite(p.atSec) || p.atSec < 0 || p.atSec > v.durationSec)
        return fail(
          `atSec ${p.atSec} is outside the video (0 to ${Math.floor(v.durationSec)} seconds). Remember: seconds, not mm:ss.`,
        );
      const label = flat(p.label);
      if (!label) return fail('The marker needs a label.');
      if (label.length > LABEL_MAX)
        return fail(`The label has ${label.length} characters; use at most ${LABEL_MAX}.`);
      return { ok: true, input: { atSec: round1(p.atSec), label } };
    }
    case 'write_metadata': {
      const p = parsed.data as z.infer<typeof writeMetadata>;
      if (!v.clipId)
        return fail(
          'No clip is open in this chat. Ask the user to open a clip first, or create one.',
        );
      return { ok: true, input: { platform: p.platform, clipId: v.clipId } };
    }
    case 'rewrite_hook': {
      const p = parsed.data as z.infer<typeof rewriteHook>;
      if (!v.clipId)
        return fail(
          'No clip is open in this chat. Ask the user to open a clip first, or create one.',
        );
      if (p.clipId !== null && p.clipId !== v.clipId)
        return fail(
          `Unknown clip id "${p.clipId}". Only the open clip (${v.clipId}) can be changed here.`,
        );
      const instruction = p.instruction === null ? null : flat(p.instruction);
      if (instruction && instruction.length > TEXT_MAX)
        return fail(
          `The instruction has ${instruction.length} characters; use at most ${TEXT_MAX}.`,
        );
      return { ok: true, input: { clipId: v.clipId, instruction: instruction || null } };
    }
    case 'find_moments': {
      const p = parsed.data as z.infer<typeof findMoments>;
      const prompt = flat(p.prompt);
      if (prompt.length < 3) return fail('Describe what to look for (at least 3 characters).');
      if (prompt.length > TEXT_MAX)
        return fail(`The request has ${prompt.length} characters; use at most ${TEXT_MAX}.`);
      return { ok: true, input: { prompt } };
    }
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Transcript clocks are floored to whole seconds, so a model that reads "[01:31]" for a sentence that
 * starts at 91.7 s would cut that sentence's first words (start) or its last words (end). Moves the
 * start to the start of the sentence that starts within [start-2, start+1) and the end to the end of
 * the sentence that ends within [end-1, end+2]; anything else is left as given (the caller
 * word-aligns the cut anyway).
 */
export function snapSpan(
  sentences: readonly Sentence[],
  start: number,
  end: number,
): [number, number] {
  let s = start;
  let e = end;
  let best: Sentence | undefined;
  for (const x of sentences)
    if (x.s >= start - 2 && x.s < start + 1)
      best = best && Math.abs(best.s - start) <= Math.abs(x.s - start) ? best : x;
  if (best) s = best.s;
  // the last sentence that STARTS clearly before `end`
  let last: Sentence | undefined;
  for (const x of sentences) if (x.s < end - 0.9) last = x;
  if (last && last.e >= end - 1 && last.e <= end + 2 && last.e > s) e = last.e;
  return [s, e];
}
