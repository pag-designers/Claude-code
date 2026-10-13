import {
  chatActionSchema,
  chatToolNameSchema,
  type ChatAction,
  type ChatEvent,
  type ChatMessage,
  type ChatThread,
  type Citation,
} from '@shared/cp2';
import type { Db } from '../db/client';
import { AppError } from '../ipc/dispatch';
import type { MomentService } from './contracts';
import type { ChatRunInput, ChatToolResult, LlmServiceV2 } from './contracts2';
import type { Cp2Service } from './cp2';
import type { PipelineOrchestrator } from './orchestrator';
import { parseJson, readOptions } from './views';

export interface ChatDeps {
  db: Db;
  cp2: Cp2Service;
  orchestrator: PipelineOrchestrator;
  moments: MomentService;
  llm: LlmServiceV2;
  emit(e: ChatEvent): void;
  /** Reason the chat cannot run (no key, ...) or null. */
  checkLlmReady(): string | null;
  log: (m: string) => void;
}

type MessageRow = {
  id: string;
  threadId: string;
  role: string;
  text: string;
  citations: string;
  actions: string;
  createdAt: Date;
};

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function toChatMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    threadId: r.threadId,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    text: r.text,
    citations: parseJson<Citation[]>(r.citations, []),
    actions: parseJson<unknown[]>(r.actions, []).flatMap((a) => {
      const p = chatActionSchema.safeParse(a);
      return p.success ? [p.data] : [];
    }),
    createdAt: r.createdAt.getTime(),
  };
}

/** AI Chat drawer (BRIEF §4.14): context-aware answers with citations and executable, non-destructive actions. */
export class ChatService {
  private running = new Map<string, AbortController>();

  constructor(private readonly d: ChatDeps) {}

  async threads(videoId: string, clipId?: string): Promise<ChatThread[]> {
    const rows = await this.d.db.chatThread.findMany({
      where: { videoId, ...(clipId ? { clipId } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      videoId: r.videoId,
      clipId: r.clipId,
      title: r.title,
      updatedAt: r.updatedAt.getTime(),
    }));
  }

  async messages(threadId: string): Promise<ChatMessage[]> {
    const rows = await this.d.db.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toChatMessage);
  }

  cancel(threadId: string): void {
    this.running.get(threadId)?.abort(new Error('canceled'));
  }

  async delete(threadId: string): Promise<void> {
    this.cancel(threadId);
    await this.d.db.chatThread.deleteMany({ where: { id: threadId } });
  }

  /** Stores the user message and starts the answer in the background; the answer streams through `chat:event`. */
  async send(a: {
    videoId: string;
    clipId?: string;
    threadId?: string;
    text: string;
  }): Promise<{ threadId: string; messageId: string }> {
    const notReady = this.d.checkLlmReady();
    if (notReady) throw new AppError('UNAVAILABLE', notReady);
    await this.d.cp2.mustVideo(a.videoId);
    if (a.clipId) await this.d.cp2.mustClip(a.clipId);
    let thread = a.threadId ? await this.d.db.chatThread.findUnique({ where: { id: a.threadId } }) : null;
    if (a.threadId && !thread) throw new AppError('NOT_FOUND', 'Chat not found.');
    if (this.running.has(thread?.id ?? '')) throw new AppError('VALIDATION', 'Wait for the current answer to finish.');
    thread ??= await this.d.db.chatThread.create({
      data: { videoId: a.videoId, clipId: a.clipId ?? null, title: a.text.trim().slice(0, 60) },
    });
    const history = await this.d.db.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    const user = await this.d.db.chatMessage.create({
      data: { threadId: thread.id, role: 'user', text: a.text.trim() },
    });
    const threadId = thread.id;
    const clipId = thread.clipId;
    const ac = new AbortController();
    this.running.set(threadId, ac);
    void this.answer({
      threadId,
      videoId: thread.videoId,
      clipId,
      userText: a.text.trim(),
      history: history.map((h) => ({ role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const), text: h.text })),
      signal: ac.signal,
    }).finally(() => this.running.delete(threadId));
    return { threadId, messageId: user.id };
  }

  private async answer(a: {
    threadId: string;
    videoId: string;
    clipId: string | null;
    userText: string;
    history: { role: 'user' | 'assistant'; text: string }[];
    signal: AbortSignal;
  }): Promise<void> {
    const row = await this.d.db.chatMessage.create({ data: { threadId: a.threadId, role: 'assistant', text: '' } });
    const messageId = row.id;
    let text = '';
    const citations: Citation[] = [];
    const actions = new Map<string, ChatAction>();
    this.d.emit({ type: 'start', threadId: a.threadId, messageId });
    const persist = async () => {
      await this.d.db.chatMessage.update({
        where: { id: messageId },
        data: { text, citations: JSON.stringify(citations), actions: JSON.stringify([...actions.values()]) },
      });
      await this.d.db.chatThread.update({ where: { id: a.threadId }, data: { updatedAt: new Date() } }).catch(() => {});
    };
    try {
      const video = await this.d.cp2.mustVideo(a.videoId);
      const [transcript, analysis] = await Promise.all([
        this.d.cp2.mustTranscript(a.videoId),
        this.d.orchestrator.loadAnalysis(a.videoId),
      ]);
      const clipRow = a.clipId ? await this.d.db.clip.findUnique({ where: { id: a.clipId } }) : null;
      const input: ChatRunInput = {
        info: this.d.cp2.infoOf(video),
        analysis,
        transcript,
        clip: clipRow ? { ...this.d.cp2.contextOf(clipRow, transcript), id: clipRow.id } : null,
        history: a.history,
        userText: a.userText,
        signal: a.signal,
        executeTool: (name, toolInput) => this.execute(name, toolInput, a.videoId, a.clipId),
        onDelta: (t) => {
          text += t;
          this.d.emit({ type: 'delta', threadId: a.threadId, messageId, text: t });
        },
        onCitation: (c) => {
          citations.push(c);
          this.d.emit({ type: 'citation', threadId: a.threadId, messageId, citation: c });
        },
        onAction: (act) => {
          const parsed = chatActionSchema.safeParse(act);
          if (!parsed.success) return;
          actions.set(parsed.data.id, parsed.data);
          this.d.emit({ type: 'action', threadId: a.threadId, messageId, action: parsed.data });
        },
      };
      const res = await this.d.llm.chat(input);
      if (res.text) text = res.text;
      for (const c of res.citations) if (!citations.some((x) => x.t === c.t && x.label === c.label)) citations.push(c);
      await persist();
      const saved = await this.d.db.chatMessage.findUniqueOrThrow({ where: { id: messageId } });
      this.d.emit({ type: 'done', threadId: a.threadId, message: toChatMessage(saved) });
    } catch (err) {
      if (a.signal.aborted) {
        if (!text) text = '(stopped)';
        await persist();
        const saved = await this.d.db.chatMessage.findUnique({ where: { id: messageId } });
        if (saved) this.d.emit({ type: 'done', threadId: a.threadId, message: toChatMessage(saved) });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.d.log(`chat ${a.threadId} failed: ${err instanceof Error ? (err.stack ?? message) : message}`);
      if (!text) text = `Sorry, that did not work: ${message}`;
      await persist();
      this.d.emit({ type: 'error', threadId: a.threadId, message });
    }
  }

  /* ------------------------------------------------------------------- tool executors ------- */

  private async execute(
    rawName: string,
    input: Record<string, unknown>,
    videoId: string,
    threadClipId: string | null,
  ): Promise<ChatToolResult> {
    const name = chatToolNameSchema.safeParse(rawName);
    if (!name.success) return { ok: false, summary: `Unknown action “${rawName}”.` };
    try {
      switch (name.data) {
        case 'create_clip':
          return await this.createClip(videoId, input);
        case 'add_marker': {
          const at = num(input.atSec);
          const label = str(input.label);
          if (at === null || !label) return { ok: false, summary: 'A marker needs a time and a label.' };
          await this.d.cp2.addMarker(videoId, Math.max(0, at), label.slice(0, 120));
          return { ok: true, summary: `Added marker “${label}” at ${fmt(at)}.`, href: `/library/video/?id=${videoId}&t=${Math.floor(at)}` };
        }
        case 'write_metadata': {
          const id = str(input.clipId) ?? threadClipId;
          if (!id) return { ok: false, summary: 'Open a clip first, or tell me which clip.' };
          await this.d.cp2.metaGenerate(id);
          return { ok: true, summary: 'Wrote titles, descriptions, hashtags and posting times for TikTok, Reels and Shorts.', href: `/library/video/?id=${videoId}&clip=${id}&tab=meta` };
        }
        case 'rewrite_hook': {
          const id = str(input.clipId) ?? threadClipId;
          if (!id) return { ok: false, summary: 'Open a clip first, or tell me which clip.' };
          await this.d.cp2.hooksGenerate(id);
          return { ok: true, summary: 'Wrote 5 new hook variants per platform — pick one in the Hook tab.', href: `/library/video/?id=${videoId}&clip=${id}&tab=hook` };
        }
        case 'find_moments': {
          const prompt = str(input.prompt);
          if (!prompt || prompt.length < 2) return { ok: false, summary: 'What should I look for?' };
          await this.d.orchestrator.startMomentsRun(videoId, prompt.slice(0, 500));
          return { ok: true, summary: `Searching the video for “${prompt.slice(0, 60)}”. New clips appear in the Clips tab.`, href: `/library/video/?id=${videoId}&tab=clips` };
        }
      }
    } catch (err) {
      return { ok: false, summary: err instanceof Error ? err.message : String(err) };
    }
  }

  private async createClip(videoId: string, input: Record<string, unknown>): Promise<ChatToolResult> {
    const s = num(input.startSec);
    const e = num(input.endSec);
    if (s === null || e === null || e <= s) return { ok: false, summary: 'A clip needs a start and an end time.' };
    const [video, transcript, signals] = await Promise.all([
      this.d.cp2.mustVideo(videoId),
      this.d.cp2.mustTranscript(videoId),
      this.d.orchestrator.loadSignals(videoId),
    ]);
    if (!signals) return { ok: false, summary: 'The audio analysis of this video is not available.' };
    const options = readOptions(video.options);
    if (e - s > 180) return { ok: false, summary: 'Clips can be at most 3 minutes long.' };
    // Snap to word boundaries without forcing the user's duration preset on a manually requested range.
    const snapped = this.d.moments.snap({
      startSec: Math.max(0, s),
      endSec: Math.min(transcript.durationSec, e),
      transcript,
      signals,
      options: { ...options, clipPreset: 'custom', minSec: 5, maxSec: 300 },
    });
    const title = str(input.title)?.slice(0, 120) ?? `Clip at ${fmt(snapped.startSec)}`;
    const hook = str(input.hook)?.slice(0, 120) ?? null;
    const row = await this.d.db.clip.create({
      data: {
        videoId,
        title,
        hook,
        startSec: snapped.startSec,
        endSec: snapped.endSec,
        aspect: options.aspect,
        captionStyleId: options.captionStyleId,
        reframeMode: options.reframeMode,
        metadata: JSON.stringify({ whyItWorks: str(input.reason) ?? 'Requested in chat.', keywords: [] }),
      },
    });
    await this.d.orchestrator.emitClip(row.id);
    await this.d.orchestrator.queueRender(videoId, row.id);
    await this.d.orchestrator.emitVideo(videoId);
    return {
      ok: true,
      summary: `Created clip “${title}” (${fmt(snapped.startSec)}–${fmt(snapped.endSec)}) — rendering now.`,
      href: `/library/video/?id=${videoId}&clip=${row.id}`,
    };
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
