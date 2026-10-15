'use client';

/**
 * Hooks of the "apply a Brand Kit" flows: the `brand:apply` mutation (optimistic, with recovery), and the live
 * brand state of one clip (effective kit, applied-vs-current comparison).
 */
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BrandApplyResult, BrandKitSummary } from '@shared/brand';
import type { ClipView } from '@shared/pipeline';
import { invoke, type IpcCallError } from '@/lib/ipc';
import { patchClipsInCache } from '@/lib/pipeline-cache';
import { useVideos } from '@/lib/library';
import { useBrandKit, useBrandKits, useDefaultBrandKitId } from '@/lib/brand/queries';
import {
  appliedHeadline,
  brandState,
  clipsWord,
  effectiveKit,
  type BrandState,
  type EffectiveKit,
} from './logic';

export interface ApplyVars {
  /** brand:apply `kitId`: a kit id, 'none' (remove) or null (inherit). */
  kitId: string | null;
  /** Exactly one of these scopes the call. */
  clipIds?: string[];
  videoId?: string;
  /** Clips shown as queued right away (the ones the plan says will be re-rendered). */
  optimisticIds: string[];
  /** Select value ('inherit' | 'none' | kit id), for the toast wording. */
  choice: string;
  kitName: string | null;
}

type Snapshot = Map<string, Pick<ClipView, 'brandKitId' | 'status' | 'renderProgress' | 'error'>>;

function recoveryText(e: IpcCallError): string {
  if (e.code === 'NOT_FOUND')
    return 'The Brand Kit or a clip no longer exists. Pick the kit again; the list has been refreshed.';
  if (e.code === 'CONFLICT') return 'The clips are being changed elsewhere. Try again in a moment.';
  return e.message;
}

/** `brand:apply` with optimistic "queued" state, a result toast and an error toast that offers Try again. */
export function useBrandApply() {
  const qc = useQueryClient();
  const retry = React.useRef<((v: ApplyVars) => void) | null>(null);

  const m = useMutation<BrandApplyResult, IpcCallError, ApplyVars, { prev: Snapshot }>({
    mutationFn: ({ kitId, clipIds, videoId }) =>
      invoke('brand:apply', {
        kitId,
        ...(clipIds ? { clipIds } : {}),
        ...(videoId ? { videoId } : {}),
      }),
    onMutate: ({ kitId, optimisticIds }) => {
      const prev: Snapshot = new Map();
      const wanted = new Set(optimisticIds);
      for (const [, d] of qc.getQueriesData<{ items: ClipView[] }>({ queryKey: ['clips:list'] }))
        for (const c of d?.items ?? [])
          if (wanted.has(c.id) && !prev.has(c.id))
            prev.set(c.id, {
              brandKitId: c.brandKitId,
              status: c.status,
              renderProgress: c.renderProgress,
              error: c.error,
            });
      patchClipsInCache(qc, optimisticIds, {
        brandKitId: kitId,
        status: 'queued',
        renderProgress: null,
        error: null,
      });
      return { prev };
    },
    onError: (e, vars, ctx) => {
      ctx?.prev.forEach((p, id) => patchClipsInCache(qc, [id], p));
      const transient = e.code !== 'NOT_FOUND' && e.code !== 'VALIDATION';
      if (e.code === 'NOT_FOUND') {
        void qc.invalidateQueries({ queryKey: ['brand:list'] });
        void qc.invalidateQueries({ queryKey: ['brand:defaultKit'] });
      }
      toast.error('Could not apply the Brand Kit', {
        description: recoveryText(e),
        ...(transient
          ? { action: { label: 'Try again', onClick: () => retry.current?.(vars) } }
          : {}),
      });
    },
    onSuccess: (r, vars) => {
      // main decides what it really queued (busy / unrendered clips are skipped): reconcile with the source of truth
      void qc.invalidateQueries({ queryKey: ['clips:list'] });
      if (r.queued === 0) {
        toast.info('Nothing to re-render', {
          description:
            r.skipped > 0
              ? `${clipsWord(r.skipped)} skipped: still rendering or not rendered yet.`
              : 'No clip needed a new render.',
        });
        return;
      }
      toast.success(
        appliedHeadline({ queued: r.queued, choice: vars.choice, kitName: vars.kitName }),
        {
          description:
            r.skipped > 0
              ? `${clipsWord(r.skipped)} skipped: still rendering or not rendered yet.`
              : 'Progress shows on each clip.',
        },
      );
    },
  });
  React.useEffect(() => {
    retry.current = (v) => m.mutate(v);
  });
  return m;
}

export interface ClipBrand {
  loading: boolean;
  kits: BrandKitSummary[];
  defaultKitId: string | null;
  /** `PipelineOptions.brandKitId` of the clip's video (undefined until the videos list is loaded). */
  runValue: string | undefined;
  effective: EffectiveKit;
  /** Current revision of the effective kit (undefined while loading). */
  effectiveRev: number | undefined;
  state: BrandState;
  effectiveName: string | null;
  appliedName: string | null;
}

/** Everything the drawer needs to explain and compare a clip's Brand Kit. */
export function useClipBrand(clip: ClipView): ClipBrand {
  const kitsQ = useBrandKits();
  const defaultQ = useDefaultBrandKitId();
  const videos = useVideos();
  const kits = React.useMemo(() => kitsQ.data?.items ?? [], [kitsQ.data]);
  const defaultKitId = defaultQ ?? null;
  const runValue = videos.data?.items.find((v) => v.id === clip.videoId)?.options.brandKitId;
  const effective = effectiveKit({ clipValue: clip.brandKitId, runValue, defaultKitId, kits });
  const kitQ = useBrandKit(effective.kitId);
  const effectiveRev = kitQ.data?.kit.rev;
  const state = brandState({
    status: clip.status,
    applied: clip.brandApplied,
    effectiveKitId: effective.kitId,
    effectiveRev,
  });
  const nameOf = (id: string | null | undefined) =>
    id ? (kits.find((k) => k.id === id)?.name ?? null) : null;
  return {
    loading: kitsQ.isPending || defaultQ === undefined,
    kits,
    defaultKitId,
    runValue,
    effective,
    effectiveRev,
    state,
    effectiveName: nameOf(effective.kitId),
    appliedName: nameOf(clip.brandApplied?.kitId),
  };
}
