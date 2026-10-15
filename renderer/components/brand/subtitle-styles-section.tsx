'use client';

import * as React from 'react';
import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DEFAULT_STYLE_ID, type CaptionStyle } from '@shared/cp2';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { StyleThumb } from '@/components/captions/style-thumb';
import { copyAsCustom, useCaptionStyles } from '@/lib/cp2-captions';
import { invoke, ipcKey, useIpcQuery } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useKitSession } from '@/lib/brand/kit-session';
import { KitStyleDialog } from './kit-style-dialog';
import { Section } from './section';

/** Subtitle Styles: this kit's own presets (live libass thumbnails), the default star, and the editor dialog. */
export function SubtitleStylesSection() {
  const s = useKitSession();
  const qc = useQueryClient();
  const kitId = s.kit.id;
  const q = useIpcQuery('brand:styles', { kitId }, { staleTime: 30_000 });
  const builtin = useCaptionStyles();
  const styles = q.data?.styles ?? [];
  const defaultId = s.spec.defaults.captionStyleId;
  const defaultBuiltin = builtin.data?.styles.find((x) => x.id === defaultId && x.builtin);

  const [dialog, setDialog] = React.useState<{ editing: CaptionStyle | null } | null>(null);
  const [del, setDel] = React.useState<CaptionStyle | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const makeDefault = (id: string) =>
    s.update('defaults', (d) => ({ ...d, captionStyleId: id }), { immediate: true });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ipcKey('brand:styles', { kitId }) });
    void qc.invalidateQueries({ queryKey: ['brand:list'] });
  };

  const duplicate = async (st: CaptionStyle) => {
    try {
      const saved = await invoke('brand:saveStyle', {
        kitId,
        style: copyAsCustom({ ...st, builtin: false }),
      });
      toast.success(`Duplicated as “${saved.name}”`);
      refresh();
    } catch (e) {
      toast.error('Could not duplicate the style', { description: (e as Error).message });
    }
  };

  const remove = async () => {
    if (!del) return;
    setDeleting(true);
    try {
      await invoke('captions:deleteStyle', { id: del.id });
      if (del.id === defaultId) makeDefault(DEFAULT_STYLE_ID);
      toast.success(`Deleted “${del.name}”`);
      refresh();
      setDel(null);
    } catch (e) {
      toast.error('Could not delete the style', { description: (e as Error).message });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Section
      id="subtitle-styles"
      description="Presets built from a live preview: font, stroke, highlight, animation, position. Rendered by the same engine as your clips."
      badge={
        styles.length ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-2xs font-semibold tabular-nums text-muted-foreground">
            {styles.length}
          </span>
        ) : null
      }
      actions={
        <Button variant="outline" size="sm" onClick={() => setDialog({ editing: null })}>
          <Plus /> Add subtitle styles
        </Button>
      }
    >
      {q.isPending ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3"
          aria-busy
          aria-label="Loading subtitle styles"
        >
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="aspect-[16/11] w-full rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <Banner
          tone="danger"
          title="Could not load this kit’s subtitle styles"
          action={
            <Button size="xs" variant="outline" onClick={() => void q.refetch()}>
              Try again
            </Button>
          }
        >
          {q.error.message}
        </Banner>
      ) : styles.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            No styles of your own yet. New clips use{' '}
            <strong className="font-medium text-foreground">
              {defaultBuiltin?.name ?? 'Clean Pop'}
            </strong>
            . Start from any of the built-in presets and make it yours.
          </p>
        </div>
      ) : (
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3"
          aria-label="Subtitle styles of this kit"
        >
          {styles.map((st) => {
            const isDefault = st.id === defaultId;
            return (
              <li key={st.id} data-testid="kit-style-card" data-style-id={st.id}>
                <div
                  className={cn(
                    'group/st relative flex flex-col gap-2 rounded-xl border bg-card p-1.5 transition-[border-color,box-shadow] duration-(--duration-base)',
                    isDefault
                      ? 'border-primary shadow-[0_0_0_1px_var(--primary)]'
                      : 'hover:border-border-strong hover:shadow-sm',
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Edit ${st.name}`}
                    onClick={() => setDialog({ editing: st })}
                    className="overflow-hidden rounded-lg border border-border-strong outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <StyleThumb style={st} band />
                  </button>
                  <div className="flex items-center gap-1 px-1">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium" title={st.name}>
                      {st.name}
                    </span>
                    <button
                      type="button"
                      aria-pressed={isDefault}
                      aria-label={
                        isDefault
                          ? `${st.name} is the default subtitle style`
                          : `Use ${st.name} as the default subtitle style`
                      }
                      onClick={() => makeDefault(st.id)}
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full transition-[color,background-color,transform] duration-(--duration-fast) active:scale-90',
                        isDefault
                          ? 'text-warning'
                          : 'text-subtle hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Star className={cn('size-3.5', isDefault && 'fill-current')} aria-hidden />
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`More actions for ${st.name}`}
                          className="flex size-6 items-center justify-center rounded-full text-subtle transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <MoreHorizontal className="size-3.5" aria-hidden />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setDialog({ editing: st })}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void duplicate(st)}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-danger [&_svg]:!text-danger"
                          onSelect={() => setDel(st)}
                        >
                          <Trash2 /> Delete…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {isDefault ? (
                    <span className="absolute left-3 top-3 rounded-full bg-primary px-2 py-0.5 text-2xs font-semibold text-primary-foreground shadow-xs">
                      Default
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {styles.length > 0 && defaultBuiltin ? (
        <p className="text-xs text-muted-foreground">
          The kit default is currently the built-in “{defaultBuiltin.name}”. Star one of your styles
          to use it instead.
        </p>
      ) : null}

      <KitStyleDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        kitId={kitId}
        editing={dialog?.editing ?? null}
        defaultStyleId={defaultId}
        onSaved={(saved, asDefault) => {
          refresh();
          if (asDefault) makeDefault(saved.id);
        }}
      />
      <ConfirmDialog
        open={del !== null}
        onOpenChange={(o) => !o && !deleting && setDel(null)}
        title={`Delete “${del?.name ?? ''}”?`}
        description={
          del?.id === defaultId
            ? 'This is the kit’s default subtitle style; new clips will use Clean Pop instead. Clips already rendered keep their look until they are re-rendered.'
            : 'Clips already rendered with it keep their look until they are re-rendered.'
        }
        confirmLabel="Delete style"
        loading={deleting}
        onConfirm={() => void remove()}
      />
    </Section>
  );
}
