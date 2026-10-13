/**
 * Pure helpers shared by every pipeline view (no React, no '@/' imports so vitest can load it directly).
 */
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  type PipelineEvent,
  type PipelineStage,
  type StageState,
  type VideoView,
} from '@shared/pipeline';

export { PIPELINE_STAGES, STAGE_LABELS };

/** Relative cost of each stage in wall-clock terms; drives the overall progress bar. Sums to 100. */
export const STAGE_WEIGHT: Record<PipelineStage, number> = {
  ingest: 14,
  prepare: 6,
  transcribe: 26,
  understand: 12,
  moments: 14,
  render: 24,
  finalize: 4,
};

export function emptyStage(stage: PipelineStage): StageState {
  return {
    stage,
    status: 'pending',
    progress: null,
    message: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    detail: null,
  };
}

/** Always returns the 7 stages in pipeline order; stages main has not reported yet are `pending`. */
export function mergeStages(stages: readonly StageState[] | undefined): StageState[] {
  return PIPELINE_STAGES.map((s) => stages?.find((x) => x.stage === s) ?? emptyStage(s));
}

/** The stage list implied by a list-row VideoView (the list carries only `stage` + `progress`). */
export function stagesFromVideo(v: Pick<VideoView, 'status' | 'stage' | 'progress' | 'error'>): StageState[] {
  const at = v.stage ? PIPELINE_STAGES.indexOf(v.stage) : -1;
  return PIPELINE_STAGES.map((stage, i) => {
    const base = emptyStage(stage);
    if (v.status === 'ready') return { ...base, status: 'done' as const, progress: 1 };
    if (at < 0) return base;
    if (i < at) return { ...base, status: 'done' as const, progress: 1 };
    if (i === at) {
      if (v.status === 'failed') return { ...base, status: 'failed' as const, error: v.error };
      if (v.status === 'canceled') return { ...base, status: 'canceled' as const };
      return { ...base, status: 'running' as const, progress: v.progress };
    }
    return base;
  });
}

export function isActiveVideo(v: Pick<VideoView, 'status'>): boolean {
  return v.status === 'ingesting' || v.status === 'processing' || v.status === 'new';
}

export function currentStage(stages: readonly StageState[]): StageState | null {
  return (
    stages.find((s) => s.status === 'running') ??
    stages.find((s) => s.status === 'failed') ??
    stages.find((s) => s.status === 'canceled') ??
    null
  );
}

/** 0..1 weighted by STAGE_WEIGHT; running stages contribute their own progress (0 when indeterminate). */
export function overallProgress(stages: readonly StageState[]): number {
  let done = 0;
  let total = 0;
  for (const s of mergeStages(stages)) {
    const w = STAGE_WEIGHT[s.stage];
    total += w;
    if (s.status === 'done' || s.status === 'skipped') done += w;
    else if (s.status === 'running') done += w * Math.max(0, Math.min(1, s.progress ?? 0));
  }
  return total === 0 ? 0 : done / total;
}

/** Applies one pipeline event to a stage list (used to keep `videos:get` live without refetching). */
export function applyEventToStages(
  stages: readonly StageState[],
  e: Pick<PipelineEvent, 'stage' | 'status' | 'progress' | 'message' | 'detail' | 'at'>,
): StageState[] {
  const merged = mergeStages(stages);
  return merged.map((s) => {
    if (s.stage !== e.stage) {
      // a later stage starting implies every earlier non-terminal stage is finished
      const later = PIPELINE_STAGES.indexOf(e.stage) > PIPELINE_STAGES.indexOf(s.stage);
      if (later && e.status === 'running' && (s.status === 'running' || s.status === 'pending')) {
        return { ...s, status: 'done', progress: 1, finishedAt: s.finishedAt ?? e.at };
      }
      return s;
    }
    const startedAt = s.startedAt ?? (e.status === 'pending' ? null : e.at);
    const terminal = e.status === 'done' || e.status === 'failed' || e.status === 'canceled' || e.status === 'skipped';
    return {
      ...s,
      status: e.status,
      progress: e.status === 'done' ? 1 : e.progress,
      message: e.message ?? (terminal ? s.message : null),
      detail: e.detail,
      startedAt,
      finishedAt: terminal ? e.at : null,
      error: e.status === 'failed' ? (e.message ?? s.error ?? 'Stage failed') : e.status === 'running' ? null : s.error,
    };
  });
}

/* ------------------------------------------------ error recovery ------------------------------------------------ */

export type FailureKind = 'bot-check' | 'private' | 'age' | 'unavailable' | 'storage' | 'anthropic' | 'budget' | 'engine' | 'network' | 'other';

export interface Recovery {
  kind: FailureKind;
  title: string;
  hint: string;
  action?: { label: string; href: string };
}

/**
 * Turns a raw error (yt-dlp / main / provider text) into guidance. Matching is deliberately loose: the text comes
 * from several services, and a wrong "other" is better than a confident wrong hint.
 */
export function classifyFailure(message: string | null | undefined): Recovery {
  const m = (message ?? '').toLowerCase();
  if (/not a bot|confirm you.re not|sign in to confirm|cookies/.test(m))
    return {
      kind: 'bot-check',
      title: 'YouTube wants to confirm you are not a bot',
      hint: 'Let Clipfern borrow your browser’s YouTube cookies: choose your browser under Download, then retry.',
      action: { label: 'Open Ingest settings', href: '/settings/ingest/' },
    };
  if (/age.restrict|age-gated|confirm your age|inappropriate for some users/.test(m))
    return {
      kind: 'age',
      title: 'This video is age-restricted',
      hint: 'Signed-in cookies are required. Pick the browser you are signed in to YouTube with, then retry.',
      action: { label: 'Open Ingest settings', href: '/settings/ingest/' },
    };
  if (/private video|members.only|join this channel|is private/.test(m))
    return {
      kind: 'private',
      title: 'This video is private or members-only',
      hint: 'Only its owner (or members) can watch it. If you have access, sign in via your browser cookies and retry.',
      action: { label: 'Open Ingest settings', href: '/settings/ingest/' },
    };
  if (/video unavailable|has been removed|no longer available|copyright|blocked it|not available in your country/.test(m))
    return {
      kind: 'unavailable',
      title: 'This video is not available',
      hint: 'It was removed, blocked in your region, or taken down. Try a different video.',
    };
  if (/hard cap|budget|spend limit/.test(m))
    return {
      kind: 'budget',
      title: 'Monthly AI budget reached',
      hint: 'Raise the hard cap (or wait for next month) to continue. Transcripts you already have are kept.',
      action: { label: 'Open Models & Budget', href: '/settings/models/' },
    };
  if (/anthropic|api key|invalid x-api-key|authentication|\b401\b|overloaded|rate limit/.test(m))
    return {
      kind: 'anthropic',
      title: 'Claude could not be reached',
      hint: 'Check your Anthropic API key and credit balance, then retry this stage.',
      action: { label: 'Open API keys', href: '/settings/api-keys/' },
    };
  if (/bucket|\b(r2|b2|s3)\b|storage|accessdenied|nosuchbucket|signature/.test(m))
    return {
      kind: 'storage',
      title: 'Cloud storage rejected the upload',
      hint: 'Check your bucket name and access keys, then retry. Nothing is lost: intermediate files are kept.',
      action: { label: 'Open Storage settings', href: '/settings/storage/' },
    };
  if (/whisper|transcri|sidecar|engine|cuda|out of memory/.test(m))
    return {
      kind: 'engine',
      title: 'The transcription engine stopped',
      hint: 'Restart the engine from Compute settings (or pick a smaller model), then retry this stage.',
      action: { label: 'Open Compute settings', href: '/settings/compute/' },
    };
  if (/timed out|timeout|enotfound|econnreset|network|dns|connection/.test(m))
    return {
      kind: 'network',
      title: 'Network problem',
      hint: 'Check your connection and retry. Partial downloads resume where they stopped.',
    };
  return { kind: 'other', title: 'This step failed', hint: 'Retry the stage. If it keeps failing, Settings → Diagnostics → Export logs has the details.' };
}

/* --------------------------------------------------- status copy ---------------------------------------------------- */

export type StatusTone = 'primary' | 'success' | 'danger' | 'neutral' | 'warning';

export function videoStatusInfo(v: Pick<VideoView, 'status' | 'stage' | 'progress'>): {
  label: string;
  tone: StatusTone;
} {
  switch (v.status) {
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'failed':
      return { label: v.stage ? `Failed · ${STAGE_LABELS[v.stage]}` : 'Failed', tone: 'danger' };
    case 'canceled':
      return { label: 'Canceled', tone: 'neutral' };
    case 'new':
      return { label: 'Queued', tone: 'neutral' };
    default:
      return {
        label: v.stage ? STAGE_LABELS[v.stage] : 'Processing',
        tone: 'primary',
      };
  }
}
