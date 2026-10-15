'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReframeMode } from '@shared/cp2';
import type { ClipView } from '@shared/pipeline';
import { invoke, type IpcCallError } from '@/lib/ipc';
import { patchClipsInCache } from '@/lib/pipeline-cache';

/** `clips:reframe`: re-crops (and re-renders) clips with another reframe mode. Clips show as queued right away. */
export function useReframeClips() {
  const qc = useQueryClient();
  return useMutation<unknown, IpcCallError, { ids: string[]; mode: ReframeMode }>({
    mutationFn: (p) => invoke('clips:reframe', p),
    onSuccess: (_d, { ids, mode }) => {
      const patch: Partial<ClipView> = {
        status: 'queued',
        renderProgress: null,
        error: null,
        reframeMode: mode,
      };
      patchClipsInCache(qc, ids, patch);
    },
    onError: (e) => toast.error('Could not re-frame', { description: e.message }),
  });
}
