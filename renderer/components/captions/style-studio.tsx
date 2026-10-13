'use client';

import * as React from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Copy, Lock, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_STYLE_ID,
  captionStyleSchema,
  type CaptionStyle,
  type CaptionStyleInput,
} from '@shared/cp2';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  copyAsCustom,
  useCaptionStyles,
  useDeleteCaptionStyle,
  useSaveCaptionStyle,
} from '@/lib/cp2-captions';
import { StyleEditorFields, StyleNameField } from './style-editor';
import { StyleGallery } from './style-gallery';
import { StylePreview } from './style-preview';

export interface StyleStudioProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The style the caller uses now (shown with a check, preselected). */
  currentStyleId?: string | null;
  /** Called with the id of the style to use. The studio saves first when the draft was edited. */
  onApply: (styleId: string) => void | Promise<void>;
  /** Background of the previews: a frame of this clip (else a neutral gradient). */
  clipId?: string;
  title?: string;
  description?: React.ReactNode;
  applyLabel?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Stable key order so a style returned by main compares equal to the form's copy of it. */
function normalise(s: CaptionStyle | CaptionStyleInput): CaptionStyleInput {
  const parsed = captionStyleSchema.safeParse(s);
  return parsed.success ? parsed.data : (s as CaptionStyleInput);
}

/**
 * The Caption Style Studio (BRIEF §7): gallery of the 14 presets + custom styles on the left, a live editor on the right
 * and a REAL libass preview in the middle. Reusable: Home options, the video header and the AI Subtitles tool open it.
 */
export function StyleStudio(props: StyleStudioProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <StudioBody {...props} /> : null}
    </Dialog>
  );
}

function StudioBody({
  onOpenChange,
  currentStyleId,
  onApply,
  clipId,
  title = 'Caption style',
  description = 'Pick a preset or tune every detail. The preview is rendered with the same engine as your clips.',
  applyLabel = 'Apply',
}: StyleStudioProps) {
  const stylesQ = useCaptionStyles();
  const save = useSaveCaptionStyle();
  const del = useDeleteCaptionStyle();
  const styles = stylesQ.data?.styles;

  const [selectedId, setSelectedId] = React.useState<string>(currentStyleId ?? DEFAULT_STYLE_ID);
  const selected = React.useMemo(
    () =>
      styles?.find((s) => s.id === selectedId) ??
      styles?.find((s) => s.id === DEFAULT_STYLE_ID) ??
      styles?.[0],
    [styles, selectedId],
  );

  const form = useForm<CaptionStyleInput, undefined, CaptionStyle>({
    resolver: zodResolver(captionStyleSchema),
    mode: 'onChange',
    defaultValues: selected ? normalise(selected) : undefined,
  });

  // load the selected style into the form whenever the selection (or its saved content) changes
  const loadedKey = React.useRef<string>('');
  React.useEffect(() => {
    if (!selected) return;
    const key = `${selected.id}:${JSON.stringify(selected)}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    form.reset(normalise(selected));
  }, [selected, form]);

  const values = useWatch({ control: form.control }) as CaptionStyleInput;
  const parsed = React.useMemo(() => captionStyleSchema.safeParse(values), [values]);
  const draft: CaptionStyle | null = parsed.success ? parsed.data : null;
  const dirty = !!selected && !same(normalise(values), normalise(selected));
  const invalid = !parsed.success;

  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [applying, setApplying] = React.useState(false);

  const select = (id: string) => {
    if (id === selected?.id) return;
    if (dirty) setPendingId(id);
    else setSelectedId(id);
  };

  /** Persists the draft: custom styles are updated in place, built-ins always become a new custom copy. */
  const persist = async (mode: 'update' | 'copy'): Promise<CaptionStyle | null> => {
    if (!draft || !selected) return null;
    const toSave =
      mode === 'copy' || selected.builtin
        ? copyAsCustom(
            { ...draft, builtin: false },
            draft.name === selected.name ? `${selected.name} copy` : draft.name,
          )
        : { ...draft, builtin: false };
    try {
      const saved = await save.mutateAsync(toSave);
      loadedKey.current = '';
      setSelectedId(saved.id);
      form.reset(normalise(saved));
      toast.success(
        mode === 'copy' || selected.builtin ? `Saved “${saved.name}”` : `Updated “${saved.name}”`,
      );
      return saved;
    } catch {
      return null; // the mutation already toasted the error
    }
  };

  const doApply = async () => {
    if (!selected) return;
    setApplying(true);
    try {
      let id = selected.id;
      if (dirty) {
        const saved = await persist('update');
        if (!saved) return;
        id = saved.id;
      }
      await onApply(id);
      onOpenChange(false);
    } finally {
      setApplying(false);
    }
  };

  const confirmDelete = () => {
    if (!selected || selected.builtin) return;
    del.mutate(
      { id: selected.id, name: selected.name },
      {
        onSuccess: () => {
          setDeleteOpen(false);
          loadedKey.current = '';
          setSelectedId(DEFAULT_STYLE_ID);
        },
      },
    );
  };

  const busy = save.isPending || applying;
  const isBuiltin = !!selected?.builtin;
  const applyText = dirty ? (isBuiltin ? 'Save copy & apply' : 'Save & apply') : applyLabel;

  return (
    <DialogContent
      className="h-[min(90vh,880px)] max-h-[min(90vh,880px)] w-[calc(100vw-48px)] max-w-[1240px]"
      data-testid="style-studio"
      aria-describedby="style-studio-desc"
    >
      <DialogHeader className="flex-row items-center justify-between gap-6 pr-14">
        <div className="min-w-0">
          <DialogTitle className="font-display text-xl font-semibold">{title}</DialogTitle>
          <DialogDescription
            id="style-studio-desc"
            className="mt-0.5 text-sm text-muted-foreground"
          >
            {description}
          </DialogDescription>
        </div>
        {selected ? (
          <div className="flex shrink-0 items-center gap-2" data-testid="studio-selected">
            <Badge variant={isBuiltin ? 'neutral' : 'primary'}>
              {isBuiltin ? <Lock aria-hidden /> : null}
              {isBuiltin ? 'Built-in' : 'Custom'}
            </Badge>
            {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          </div>
        ) : null}
      </DialogHeader>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,390px)_minmax(0,1fr)_minmax(330px,390px)]">
        <div
          className="scrollbar-thin min-h-0 overflow-y-auto border-r p-3"
          data-testid="studio-gallery"
        >
          <StyleGallery
            styles={styles}
            loading={stylesQ.isPending}
            error={stylesQ.isError ? stylesQ.error.message : null}
            selectedId={selected?.id ?? selectedId}
            currentId={currentStyleId ?? null}
            onSelect={select}
            onRetry={() => void stylesQ.refetch()}
            clipId={clipId}
          />
        </div>

        <div className="flex min-h-0 flex-col bg-background/50 p-5">
          {selected ? (
            <StylePreview
              style={draft}
              clipId={clipId}
              invalidMessage={invalid ? 'Fix the highlighted fields to refresh the preview.' : null}
            />
          ) : null}
        </div>

        <div className="flex min-h-0 flex-col border-l">
          {selected ? (
            <FormProvider {...form}>
              <div className="border-b px-5 py-3.5">
                <StyleNameField />
              </div>
              <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
                <StyleEditorFields />
              </div>
            </FormProvider>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {stylesQ.isPending ? 'Loading styles…' : 'No caption styles are available.'}
            </p>
          )}
        </div>
      </div>

      <DialogFooter className="justify-between">
        <div className="flex items-center gap-2">
          {selected && !isBuiltin ? (
            <Button variant="danger-ghost" onClick={() => setDeleteOpen(true)} disabled={busy}>
              <Trash2 /> Delete
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => selected && form.reset(normalise(selected))}
            disabled={!dirty || busy}
          >
            <RotateCcw /> Reset
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {invalid && dirty ? (
            <span role="status" className="mr-1 text-xs text-danger">
              Fix the highlighted fields to save.
            </span>
          ) : null}
          <Button
            variant="outline"
            disabled={!draft || busy}
            loading={save.isPending && !applying}
            onClick={() => void persist('copy')}
          >
            <Copy /> {dirty && isBuiltin ? 'Save as custom copy' : 'Duplicate'}
          </Button>
          {dirty && !isBuiltin ? (
            <Button
              variant="secondary"
              disabled={!draft || busy}
              onClick={() => void persist('update')}
            >
              Save
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!selected || (dirty && !draft) || busy}
            loading={applying}
            onClick={() => void doApply()}
            data-testid="studio-apply"
          >
            {applyText}
          </Button>
        </div>
      </DialogFooter>

      <ConfirmDialog
        open={pendingId !== null}
        onOpenChange={(o) => !o && setPendingId(null)}
        title="Discard unsaved changes?"
        description={`Your edits to “${selected?.name ?? 'this style'}” have not been saved. Switching styles throws them away.`}
        confirmLabel="Discard changes"
        onConfirm={() => {
          if (pendingId) setSelectedId(pendingId);
          setPendingId(null);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete “${selected?.name ?? ''}”?`}
        description="This custom style is removed for good. Clips already rendered with it keep their look until they are re-rendered."
        confirmLabel="Delete style"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </DialogContent>
  );
}
