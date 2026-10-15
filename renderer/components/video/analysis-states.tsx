'use client';

import { BookOpen, Loader2 } from 'lucide-react';
import type { VideoView } from '@shared/pipeline';
import { EmptyState } from '@/components/ui/empty-state';
import { isActiveVideo } from '@/lib/pipeline-ui';

/** Shown by Overview / Chapters / Notes while `analysis` is null. Honest about WHY it is empty. */
export function AnalysisPending({ video, what }: { video: VideoView; what: string }) {
  const active = isActiveVideo(video);
  return (
    <EmptyState
      size="md"
      icon={active ? Loader2 : BookOpen}
      title={active ? `${what} are on the way` : `No ${what.toLowerCase()} for this video`}
      description={
        active
          ? 'Claude writes the overview, chapters and notes in the Understand stage, right after transcription.'
          : video.status === 'failed'
            ? `The run stopped before the Understand stage finished. Retry the failed stage from the pipeline card above.`
            : 'Re-run the Understand stage from “Re-run stage” in the header to generate them.'
      }
    />
  );
}
