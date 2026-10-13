'use client';

import { create } from 'zustand';
import type { PipelineEvent, PipelineStage, StageStatus } from '@shared/pipeline';

export interface LogEntry {
  at: number;
  stage: PipelineStage;
  status: StageStatus;
  text: string;
}

interface LogState {
  byVideo: Record<string, LogEntry[]>;
  record: (e: PipelineEvent) => void;
  clear: (videoId: string) => void;
}

const CAP = 300;

/**
 * In-memory run log built from `pipeline:event`s while the app is open. Progress-only ticks are dropped: an entry is
 * kept when the stage status or its message changes, so the log reads like a story, not a firehose.
 */
export const usePipelineLog = create<LogState>((set, get) => ({
  byVideo: {},
  record: (e) => {
    const text = [e.message, e.detail].filter(Boolean).join(' · ');
    const prev = get().byVideo[e.videoId] ?? [];
    const last = prev[prev.length - 1];
    if (last && last.stage === e.stage && last.status === e.status && last.text === text) return;
    // collapse consecutive running updates of the same stage into the latest message to avoid log spam
    if (
      last &&
      last.stage === e.stage &&
      last.status === 'running' &&
      e.status === 'running' &&
      !e.message
    )
      return;
    const next = [...prev, { at: e.at, stage: e.stage, status: e.status, text }].slice(-CAP);
    set({ byVideo: { ...get().byVideo, [e.videoId]: next } });
  },
  clear: (videoId) => {
    const { [videoId]: _drop, ...rest } = get().byVideo;
    void _drop;
    set({ byVideo: rest });
  },
}));
