'use client';

import * as React from 'react';
import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { BrandTextStyle } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { newId } from '@/lib/brand/helpers';
import { useBrandFonts } from '@/lib/brand/fonts';
import { useKitSession } from '@/lib/brand/kit-session';
import { TEXT_KIND_LABEL, TEXT_KIND_SAMPLE } from '@/lib/brand/text-presets';
import { Section } from './section';
import { TextStyleDialog } from './text-style-dialog';
import { TextStylePreview } from './text-style-preview';

const ANIM_LABEL: Record<string, string> = {
  none: 'No animation',
  fade: 'Fade',
  pop: 'Pop',
  scale: 'Scale',
  slide: 'Slide',
  bounce: 'Bounce',
  typewriter: 'Typewriter',
};

export function describeAnim(s: Pick<BrandTextStyle, 'animIn' | 'animOut'>): string {
  const a = s.animIn.type;
  const b = s.animOut.type;
  if (a === 'none' && b === 'none') return 'No animation';
  return [
    a !== 'none' ? `${ANIM_LABEL[a]} in` : null,
    b !== 'none' ? `${ANIM_LABEL[b]?.toLowerCase()} out` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Text Styles: title / hook / CTA / lower-third presets for the editor, with a live preview editor. */
export function TextStylesSection() {
  const s = useKitSession();
  const styles = s.spec.textStyles;
  const hookId = s.spec.defaults.hookTextStyleId;
  useBrandFonts();
  const [dialog, setDialog] = React.useState<{ editing: BrandTextStyle | null } | null>(null);
  const [del, setDel] = React.useState<BrandTextStyle | null>(null);

  const save = (style: BrandTextStyle) => {
    const exists = styles.some((x) => x.id === style.id);
    s.update(
      'textStyles',
      (cur) => (exists ? cur.map((x) => (x.id === style.id ? style : x)) : [...cur, style]),
      {
        immediate: true,
      },
    );
    toast.success(`${exists ? 'Saved' : 'Added'} “${style.name}”`);
  };

  const setHook = (id: string | null) =>
    s.update('defaults', (d) => ({ ...d, hookTextStyleId: id }), { immediate: true });

  return (
    <Section
      id="text-styles"
      description="Title, hook, call-to-action and lower-third presets with entrance and exit animations, ready in the editor."
      badge={
        styles.length ? (
          <span className="rounded-full bg-muted px-2 py-0.5 font-sans text-2xs font-semibold tabular-nums text-muted-foreground">
            {styles.length}
          </span>
        ) : null
      }
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={styles.length >= 40}
          onClick={() => setDialog({ editing: null })}
        >
          <Plus /> Add text styles
        </Button>
      }
    >
      {styles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No text styles yet. Pick a title, hook, call-to-action or lower-third preset and make it
          yours; your styles show up in the editor’s Text tab.
        </p>
      ) : (
        <ul
          className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3"
          aria-label="Text styles of this kit"
        >
          {styles.map((t) => {
            const isHookDefault = hookId === t.id;
            return (
              <li key={t.id} data-testid="text-style-card" data-style-id={t.id}>
                <div className="group/ts flex flex-col gap-2 rounded-xl border bg-card p-2 transition-[border-color,box-shadow] duration-(--duration-base) hover:border-border-strong hover:shadow-sm">
                  <button
                    type="button"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setDialog({ editing: t })}
                    className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <TextStylePreview style={t.style} text={TEXT_KIND_SAMPLE[t.kind]} yPct={null} />
                  </button>
                  <div className="flex items-center gap-1 px-1">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold" title={t.name}>
                        {t.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {TEXT_KIND_LABEL[t.kind]} · {describeAnim(t)}
                      </p>
                    </div>
                    {t.kind === 'hook' ? (
                      <button
                        type="button"
                        aria-pressed={isHookDefault}
                        aria-label={
                          isHookDefault
                            ? `${t.name} is the default hook text style`
                            : `Use ${t.name} as the default hook text style`
                        }
                        onClick={() => setHook(isHookDefault ? null : t.id)}
                        className={cn(
                          'flex size-7 items-center justify-center rounded-full transition-[color,background-color,transform] duration-(--duration-fast) active:scale-90',
                          isHookDefault
                            ? 'text-warning'
                            : 'text-subtle hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <Star
                          className={cn('size-4', isHookDefault && 'fill-current')}
                          aria-hidden
                        />
                      </button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`More actions for ${t.name}`}
                          className="flex size-7 items-center justify-center rounded-full text-subtle transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <MoreHorizontal className="size-4" aria-hidden />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setDialog({ editing: t })}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            const copy: BrandTextStyle = {
                              ...t,
                              id: newId('ts'),
                              name: `${t.name} copy`.slice(0, 40),
                            };
                            s.update('textStyles', (cur) => [...cur, copy], { immediate: true });
                            toast.success(`Duplicated as “${copy.name}”`);
                          }}
                        >
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-danger [&_svg]:!text-danger"
                          onSelect={() => setDel(t)}
                        >
                          <Trash2 /> Delete…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <TextStyleDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        editing={dialog?.editing ?? null}
        onSave={save}
      />
      <ConfirmDialog
        open={del !== null}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name ?? ''}”?`}
        description={
          del && del.id === hookId
            ? 'This is the kit’s default hook text style; new projects will fall back to the hook card below. Items already in the editor keep their look.'
            : 'Items that already use it in the editor keep their look.'
        }
        confirmLabel="Delete style"
        onConfirm={() => {
          if (!del) return;
          s.update('textStyles', (cur) => cur.filter((x) => x.id !== del.id), { immediate: true });
          if (del.id === hookId) setHook(null);
          toast.success(`Deleted “${del.name}”`);
          setDel(null);
        }}
      />
    </Section>
  );
}
