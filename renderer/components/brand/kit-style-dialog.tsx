'use client';

import * as React from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Lock, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { captionStyleSchema, type CaptionStyle, type CaptionStyleInput } from '@shared/cp2';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StyleEditorFields, StyleNameField } from '@/components/captions/style-editor';
import { StylePreview } from '@/components/captions/style-preview';
import { StyleThumb } from '@/components/captions/style-thumb';
import { Skeleton } from '@/components/ui/skeleton';
import { copyAsCustom, useCaptionStyles } from '@/lib/cp2-captions';
import { invoke, type IpcCallError } from '@/lib/ipc';
import { cn } from '@/lib/utils';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Stable key order so a style returned by main compares equal to the form's copy of it. */
function normalise(s: CaptionStyle | CaptionStyleInput): CaptionStyleInput {
  const parsed = captionStyleSchema.safeParse(s);
  return parsed.success ? parsed.data : (s as CaptionStyleInput);
}

export interface KitStyleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kitId: string;
  /** Edit this kit style, or null to start a new one from a built-in preset. */
  editing: CaptionStyle | null;
  /** Called after `brand:saveStyle` succeeded. `makeDefault` = the person chose "Save and use as default". */
  onSaved: (style: CaptionStyle, makeDefault: boolean) => void;
  /** Id of the kit's current default caption style (to hide "use as default" when it already is). */
  defaultStyleId: string;
}

/**
 * "Add subtitle styles": pick a built-in preset to start from, then tune it in the SAME editor and live libass preview
 * as the Caption Style Studio (its field and preview components are reused as they are). Saving goes through
 * `brand:saveStyle`, so the style belongs to this kit.
 */
export function KitStyleDialog(props: KitStyleDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <Body {...props} /> : null}
    </Dialog>
  );
}

function Body({ onOpenChange, kitId, editing, onSaved, defaultStyleId }: KitStyleDialogProps) {
  const [base, setBase] = React.useState<CaptionStyle | null>(editing);
  const [stage, setStage] = React.useState<'pick' | 'edit'>(editing ? 'edit' : 'pick');
  return (
    <DialogContent
      className="h-[min(88vh,820px)] max-h-[min(88vh,820px)] w-[calc(100vw-48px)] max-w-[1080px]"
      data-testid="kit-style-dialog"
      aria-describedby="kit-style-desc"
    >
      {stage === 'pick' ? (
        <Picker
          onPick={(s) => {
            // a fresh custom copy owned by this kit; it keeps the preset's name so you can tell where it came from
            setBase(copyAsCustom({ ...s, builtin: false }, s.name));
            setStage('edit');
          }}
        />
      ) : base ? (
        <Editor
          key={base.id}
          base={base}
          isNew={!editing}
          kitId={kitId}
          defaultStyleId={defaultStyleId}
          onBack={editing ? undefined : () => setStage('pick')}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      ) : null}
    </DialogContent>
  );
}

/* ----------------------------------------------------------------------------------- start from ---- */

function Picker({ onPick }: { onPick: (s: CaptionStyle) => void }) {
  const q = useCaptionStyles();
  const builtin = (q.data?.styles ?? []).filter((s) => s.builtin);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl font-semibold">
          Add subtitle styles
        </DialogTitle>
        <DialogDescription id="kit-style-desc" className="text-sm text-muted-foreground">
          Start from one of the built-in presets. You will tune it next with a live preview rendered
          by the same engine as your clips.
        </DialogDescription>
      </DialogHeader>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
        {q.isPending ? (
          <div className="grid grid-cols-7 gap-3" aria-busy aria-label="Loading presets">
            {Array.from({ length: 14 }, (_, i) => (
              <Skeleton key={i} className="aspect-[9/16] w-full rounded-md" />
            ))}
          </div>
        ) : q.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/35 bg-danger-soft p-4 text-sm"
          >
            <p className="font-semibold">Could not load the presets</p>
            <p className="mt-1 text-muted-foreground">{q.error.message}</p>
            <Button size="xs" variant="outline" className="mt-2" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3"
            aria-label="Built-in presets"
          >
            {builtin.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid="preset-tile"
                  data-style-id={s.id}
                  onClick={() => onPick(s)}
                  aria-label={`Start from ${s.name}`}
                  className="group flex w-full flex-col gap-1.5 rounded-lg p-1.5 text-left outline-none transition-[background-color,box-shadow,transform] duration-(--duration-fast) hover:-translate-y-px hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="overflow-hidden rounded-md border border-border-strong">
                    <StyleThumb style={s} />
                  </span>
                  <span className="flex items-center gap-1 px-0.5 text-xs font-medium text-foreground">
                    <span className="truncate">{s.name}</span>
                    <Lock className="size-3 shrink-0 text-subtle" aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ edit ---- */

function Editor({
  base,
  isNew,
  kitId,
  defaultStyleId,
  onBack,
  onClose,
  onSaved,
}: {
  base: CaptionStyle;
  isNew: boolean;
  kitId: string;
  defaultStyleId: string;
  onBack?: () => void;
  onClose: () => void;
  onSaved: (s: CaptionStyle, makeDefault: boolean) => void;
}) {
  const form = useForm<CaptionStyleInput, undefined, CaptionStyle>({
    resolver: zodResolver(captionStyleSchema),
    mode: 'onChange',
    defaultValues: normalise(base),
  });
  const values = useWatch({ control: form.control }) as CaptionStyleInput;
  const parsed = React.useMemo(() => captionStyleSchema.safeParse(values), [values]);
  const draft: CaptionStyle | null = parsed.success ? parsed.data : null;
  const dirty = !same(normalise(values), normalise(base));
  const [saving, setSaving] = React.useState<'save' | 'default' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const save = async (makeDefault: boolean) => {
    if (!draft) return;
    setSaving(makeDefault ? 'default' : 'save');
    setError(null);
    try {
      const saved = await invoke('brand:saveStyle', {
        kitId,
        style: { ...draft, builtin: false },
      });
      toast.success(`${isNew ? 'Added' : 'Saved'} “${saved.name}”`);
      onSaved(saved, makeDefault);
      onClose();
    } catch (e) {
      setError((e as IpcCallError).message || 'Could not save the style.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <DialogHeader className="flex-row items-center justify-between gap-6 pr-14">
        <div className="flex min-w-0 items-center gap-3">
          {onBack ? (
            <Button size="icon-sm" variant="ghost" aria-label="Back to presets" onClick={onBack}>
              <ArrowLeft />
            </Button>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="font-display text-xl font-semibold">
              {isNew ? 'New subtitle style' : 'Edit subtitle style'}
            </DialogTitle>
            <DialogDescription id="kit-style-desc" className="text-sm text-muted-foreground">
              Changes show in the preview as you make them. The style is saved to this Brand Kit.
            </DialogDescription>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="primary">{isNew ? 'New' : 'Kit style'}</Badge>
          {dirty && !isNew ? <Badge variant="warning">Unsaved changes</Badge> : null}
        </div>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <div className="flex min-h-0 flex-col bg-background/50 p-5">
          <StylePreview
            style={draft}
            invalidMessage={draft ? null : 'Fix the highlighted fields to refresh the preview.'}
          />
        </div>
        <div className="flex min-h-0 flex-col border-l">
          <FormProvider {...form}>
            <div className="border-b px-5 py-3.5">
              <StyleNameField />
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              <StyleEditorFields />
            </div>
          </FormProvider>
        </div>
      </div>
      <DialogFooter className="justify-between">
        <Button
          variant="ghost"
          onClick={() => form.reset(normalise(base))}
          disabled={!dirty || saving !== null}
        >
          <RotateCcw /> Reset
        </Button>
        <div className="flex items-center gap-2">
          {error ? (
            <span role="alert" className="mr-1 max-w-72 truncate text-xs text-danger" title={error}>
              {error}
            </span>
          ) : !draft ? (
            <span role="status" className="mr-1 text-xs text-danger">
              Fix the highlighted fields to save.
            </span>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={saving !== null}>
            Cancel
          </Button>
          {base.id !== defaultStyleId ? (
            <Button
              variant="secondary"
              disabled={!draft || saving !== null}
              loading={saving === 'default'}
              onClick={() => void save(true)}
            >
              Save and use as default
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={!draft || saving !== null || (!isNew && !dirty)}
            loading={saving === 'save'}
            onClick={() => void save(false)}
            data-testid="kit-style-save"
            className={cn(saving === 'default' && 'opacity-60')}
          >
            {isNew ? 'Add style' : 'Save'}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
