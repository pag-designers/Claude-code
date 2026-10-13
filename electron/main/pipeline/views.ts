import {
  pipelineOptionsSchema,
  scoreBreakdownSchema,
  stageStateSchema,
  PIPELINE_STAGES,
  STAGE_LABELS,
  type ClipStatus,
  type ClipView,
  type PipelineOptions,
  type PipelineStage,
  type ScoreBreakdown,
  type StageState,
  type VideoStatus,
  type VideoView,
} from '@shared/pipeline';
import { z } from 'zod';

/* Minimal structural row types so mappers don't depend on the generated Prisma types' exact shape. */
export interface VideoRow {
  id: string;
  sourceUrl: string;
  sourceId: string | null;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnail: string | null;
  status: string;
  stage: string | null;
  progress: number | null;
  error: string | null;
  favorite: boolean;
  options: string;
  stages: string;
  storageKeys: string;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClipRow {
  id: string;
  videoId: string;
  title: string;
  hook: string | null;
  startSec: number;
  endSec: number;
  score: number | null;
  scoreDetail: string | null;
  status: string;
  rank: number | null;
  error: string | null;
  renderProgress: number | null;
  aspect: string;
  favorite: boolean;
  tags: string;
  storageKeys: string;
  metadata: string;
  createdAt: Date;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function initialStages(): StageState[] {
  return PIPELINE_STAGES.map((stage) => ({
    stage,
    status: 'pending',
    progress: null,
    message: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    detail: null,
  }));
}

export function readStages(raw: string): StageState[] {
  const parsed = z.array(stageStateSchema).safeParse(parseJson(raw, []));
  if (!parsed.success || parsed.data.length !== PIPELINE_STAGES.length) return initialStages();
  return parsed.data;
}

export function readOptions(raw: string): PipelineOptions {
  return pipelineOptionsSchema.parse(parseJson<unknown>(raw, {}));
}

export interface VideoCounts {
  clipCount: number;
  renderedCount: number;
  topScore: number | null;
}

export function toVideoView(row: VideoRow, counts: VideoCounts): VideoView {
  const keys = parseJson<Record<string, string>>(row.storageKeys, {});
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    sourceId: row.sourceId,
    title: row.title,
    channel: row.channel,
    durationSec: row.durationSec,
    thumbnail: row.thumbnail,
    status: row.status as VideoStatus,
    stage: (row.stage as PipelineStage | null) ?? null,
    progress: row.progress,
    error: row.error,
    favorite: row.favorite,
    clipCount: counts.clipCount,
    renderedCount: counts.renderedCount,
    topScore: counts.topScore,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    hasProxy: Boolean(keys.proxy),
    options: readOptions(row.options),
  };
}

export function toClipView(row: ClipRow, videoTitle: string | null): ClipView {
  const keys = parseJson<Record<string, string>>(row.storageKeys, {});
  const meta = parseJson<{ whyItWorks?: string; confidence?: number }>(row.metadata, {});
  const bd = scoreBreakdownSchema.safeParse(parseJson<unknown>(row.scoreDetail, null));
  const breakdown: ScoreBreakdown | null = bd.success ? bd.data : null;
  return {
    id: row.id,
    videoId: row.videoId,
    videoTitle,
    title: row.title,
    hook: row.hook,
    startSec: row.startSec,
    endSec: row.endSec,
    durationSec: Math.max(0, row.endSec - row.startSec),
    score: row.score,
    breakdown,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
    whyItWorks: meta.whyItWorks ?? null,
    status: row.status as ClipStatus,
    renderProgress: row.renderProgress,
    error: row.error,
    favorite: row.favorite,
    tags: parseJson<string[]>(row.tags, []),
    aspect: (['9:16', '1:1', '4:5', '16:9'] as const).find((a) => a === row.aspect) ?? '9:16',
    hasRender: Boolean(keys.render),
    hasThumb: Boolean(keys.thumb),
    rank: row.rank,
    createdAt: row.createdAt.getTime(),
  };
}

export const stageLabel = (s: PipelineStage): string => STAGE_LABELS[s];
