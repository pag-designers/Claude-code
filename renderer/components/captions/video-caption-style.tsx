'use client';

import * as React from 'react';
import { Captions, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_STYLE_ID } from '@shared/cp2';
import type { ClipView, VideoView } from '@shared/pipeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { useCaptionStyle, useRestyleClips, useSetVideoCaptionStyle } from '@/lib/cp2-captions';
import { useVideoClips } from '@/lib/library';
import { StyleStudio } from './style-studio';

/** Clips whose existing render would change when the style changes. */
export const restylableClips = (clips: readonly ClipView[]): ClipView[] =>
  clips.filter((c) => c.status === 'rendered' || c.status === 'failed');

export function ApplyToClipsDialog({
  open,
  onOpenChange,
  styleName,
  count,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styleName: string;
  count: number;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="apply-all-dialog">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
              <RefreshCw className="size-4.5" aria-hidden />
            </span>
            <div className="min-w-0">
              <DialogTitle className="font-display text-lg font-semibold">
                Apply “{styleName}” to existing clips?
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted-foreground">
                This video now uses “{styleName}” for new clips. Re-rendering {count}{' '}
                {count === 1 ? 'clip' : 'clips'} replaces their current captions; each takes about
                as long as the first render.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Only new clips
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={loading}>
            Re-render {count} {count === 1 ? 'clip' : 'clips'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Caption style" button for a video: opens the Studio, stores the choice with `videos:setCaptionStyle` and offers to
 * re-render the video's existing clips (`clips:restyle`) after a confirmation.
 */
export function VideoCaptionStyleControl({
  video,
  variant = 'outline',
  className,
}: {
  video: Pick<VideoView, 'id' | 'options'>;
  variant?: 'outline' | 'secondary';
  className?: string;
}) {
  const styleId = video.options.captionStyleId || DEFAULT_STYLE_ID;
  const style = useCaptionStyle(styleId);
  const clipsQ = useVideoClips(video.id);
  const setStyle = useSetVideoCaptionStyle();
  const restyle = useRestyleClips();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ id: string; name: string } | null>(null);
  const eligible = React.useMemo(() => restylableClips(clipsQ.data?.items ?? []), [clipsQ.data]);
  const firstClip = clipsQ.data?.items.find((c) => c.hasThumb)?.id;

  const onApply = async (id: string) => {
    await setStyle.mutateAsync({ id: video.id, styleId: id });
    // the studio just saved/selected it, so the list already has the name
    const name = style && style.id === id ? style.name : id;
    if (eligible.length > 0) setConfirm({ id, name });
    else
      toast.success('Caption style updated', {
        description: 'New clips of this video will use it.',
      });
  };

  return (
    <>
      <Tip content="Pick, edit and preview caption styles">
        <Button
          variant={variant}
          className={className}
          onClick={() => setOpen(true)}
          data-testid="caption-style-button"
        >
          <Captions /> <span className="max-w-32 truncate">{style?.name ?? 'Caption style'}</span>
        </Button>
      </Tip>
      <StyleStudio
        open={open}
        onOpenChange={setOpen}
        currentStyleId={styleId}
        onApply={onApply}
        clipId={firstClip}
        title="Caption style for this video"
        applyLabel="Use for this video"
      />
      <ApplyNames
        confirm={confirm}
        count={eligible.length}
        loading={restyle.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(id) =>
          restyle.mutate(
            { ids: eligible.map((c) => c.id), styleId: id },
            {
              onSuccess: () => {
                setConfirm(null);
                toast.success(
                  `Re-rendering ${eligible.length} ${eligible.length === 1 ? 'clip' : 'clips'}`,
                  { description: 'They update here as each render finishes.' },
                );
              },
            },
          )
        }
      />
    </>
  );
}

/** Resolves the style name for the dialog (the style may have just been created by the studio). */
function ApplyNames({
  confirm,
  count,
  loading,
  onClose,
  onConfirm,
}: {
  confirm: { id: string; name: string } | null;
  count: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: (styleId: string) => void;
}) {
  const style = useCaptionStyle(confirm?.id);
  return (
    <ApplyToClipsDialog
      open={confirm !== null}
      onOpenChange={(o) => !o && onClose()}
      styleName={style?.name ?? confirm?.name ?? ''}
      count={count}
      loading={loading}
      onConfirm={() => confirm && onConfirm(confirm.id)}
    />
  );
}
