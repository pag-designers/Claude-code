'use client';

import * as React from 'react';
import { Clock, Hash, Plus, Trash2, X } from 'lucide-react';
import { PLATFORMS, PLATFORM_LABELS, type Platform } from '@shared/cp2';
import type { HashtagSet, PostingWindow } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useCaptionStyles } from '@/lib/cp2-captions';
import { useIpcQuery } from '@/lib/ipc';
import {
  DAY_LABELS,
  DAY_NAMES,
  describeDays,
  newId,
  normalizeTag,
  parseTags,
  windowError,
} from '@/lib/brand/helpers';
import { useKitSession } from '@/lib/brand/kit-session';
import { BufferedInput, FieldRow, SelectField, SubHeading, SwitchRow } from './controls';
import { Section } from './section';

const ASPECTS = [
  { value: '9:16', label: '9:16 Vertical' },
  { value: '1:1', label: '1:1 Square' },
  { value: '4:5', label: '4:5 Portrait' },
  { value: '16:9', label: '16:9 Wide' },
] as const;

/* ---------------------------------------------------------------------------------------- hashtags ---- */

function TagSetCard({ set }: { set: HashtagSet }) {
  const s = useKitSession();
  const [input, setInput] = React.useState('');
  const patch = (p: Partial<HashtagSet>) =>
    s.update('defaults', (d) => ({
      ...d,
      hashtagSets: d.hashtagSets.map((x) => (x.id === set.id ? { ...x, ...p } : x)),
    }));
  const addFromInput = (raw: string) => {
    const tags = parseTags(raw, set.tags);
    if (tags.length) patch({ tags: [...set.tags, ...tags].slice(0, 60) });
    setInput('');
  };
  return (
    <li
      data-testid="hashtag-set"
      className="flex flex-col gap-2.5 rounded-lg border bg-muted/30 p-3"
    >
      <div className="flex items-center gap-2">
        <BufferedInput
          aria-label="Hashtag set name"
          value={set.name}
          maxLength={40}
          onValue={(name) => patch({ name })}
          className="h-8 font-medium"
        />
        <Button
          size="icon-sm"
          variant="danger-ghost"
          aria-label={`Delete hashtag set ${set.name}`}
          onClick={() =>
            s.update(
              'defaults',
              (d) => ({ ...d, hashtagSets: d.hashtagSets.filter((x) => x.id !== set.id) }),
              { immediate: true },
            )
          }
        >
          <Trash2 />
        </Button>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label={`Tags in ${set.name}`}>
        {set.tags.map((t) => (
          <li
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary-text"
          >
            #{t}
            <button
              type="button"
              aria-label={`Remove #${t}`}
              onClick={() => patch({ tags: set.tags.filter((x) => x !== t) })}
              className="flex size-4 items-center justify-center rounded-full hover:bg-primary/20"
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <input
        aria-label={`Add tags to ${set.name}`}
        value={input}
        placeholder={set.tags.length >= 60 ? 'Tag limit reached' : 'Add tags, press Enter or comma'}
        disabled={set.tags.length >= 60}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,\n;]$/.test(v)) addFromInput(v);
          else setInput(v);
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/[\s,;]/.test(text.trim())) {
            e.preventDefault();
            addFromInput(text);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (input.trim()) {
              e.preventDefault();
              addFromInput(input);
            }
          } else if (e.key === 'Backspace' && !input && set.tags.length) {
            patch({ tags: set.tags.slice(0, -1) });
          }
        }}
        onBlur={() => input.trim() && addFromInput(input)}
        className="h-8 rounded-md border border-input bg-field px-2.5 text-sm outline-none placeholder:text-subtle transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50"
      />
      <p className="text-xs text-subtle">
        {set.tags.length} {set.tags.length === 1 ? 'tag' : 'tags'}
        {normalizeTag(input) ? ` · press Enter to add #${normalizeTag(input)}` : ''}
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------ windows -- */

function WindowRow({ w }: { w: PostingWindow }) {
  const s = useKitSession();
  const [draft, setDraft] = React.useState<PostingWindow | null>(null);
  const cur = draft ?? w;
  const err = windowError(cur);
  const commit = (next: PostingWindow) => {
    if (windowError(next) === null) {
      setDraft(null);
      s.update('defaults', (d) => ({
        ...d,
        postingWindows: d.postingWindows.map((x) => (x.id === next.id ? next : x)),
      }));
    } else setDraft(next);
  };
  const toggleDay = (day: number) => {
    const days = cur.days.includes(day)
      ? cur.days.filter((x) => x !== day)
      : [...cur.days, day].sort();
    commit({ ...cur, days });
  };
  const inputCls =
    'h-8 w-[96px] rounded-md border border-input bg-field px-2 font-mono text-xs tabular-nums outline-none transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 aria-invalid:border-danger';
  return (
    <li
      data-testid="posting-window"
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <SelectField
          label="Window platform"
          value={cur.platform ?? 'all'}
          onChange={(v) => commit({ ...cur, platform: v === 'all' ? null : (v as Platform) })}
          options={[
            { value: 'all', label: 'All platforms' },
            ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] })),
          ]}
          className="w-44"
          triggerClassName="h-8"
        />
        <div role="group" aria-label="Days" className="flex gap-1">
          {DAY_LABELS.map((d, i) => {
            const on = cur.days.includes(i);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={DAY_NAMES[i]}
                onClick={() => toggleDay(i)}
                className={cn(
                  'h-8 w-9 rounded-md border text-xs font-medium transition-[background-color,border-color,color,transform] duration-(--duration-fast) active:scale-95',
                  on
                    ? 'border-primary/70 bg-primary-soft text-primary-text'
                    : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {d.slice(0, 2)}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="time"
            aria-label="Window start"
            value={cur.start}
            aria-invalid={err ? true : undefined}
            onChange={(e) => e.target.value && commit({ ...cur, start: e.target.value })}
            className={inputCls}
          />
          <span className="text-xs text-subtle" aria-hidden>
            to
          </span>
          <input
            type="time"
            aria-label="Window end"
            value={cur.end}
            aria-invalid={err ? true : undefined}
            onChange={(e) => e.target.value && commit({ ...cur, end: e.target.value })}
            className={inputCls}
          />
        </div>
        <Button
          size="icon-sm"
          variant="danger-ghost"
          className="ml-auto"
          aria-label="Delete posting window"
          onClick={() =>
            s.update(
              'defaults',
              (d) => ({ ...d, postingWindows: d.postingWindows.filter((x) => x.id !== w.id) }),
              { immediate: true },
            )
          }
        >
          <Trash2 />
        </Button>
      </div>
      {err ? (
        <p role="alert" className="text-xs text-danger">
          {err} Your last valid window is kept until this is fixed.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {describeDays(cur.days)}, {cur.start}–{cur.end}
          {cur.platform ? ` on ${PLATFORM_LABELS[cur.platform]}` : ''}
        </p>
      )}
    </li>
  );
}

/* --------------------------------------------------------------------------------------- section ---- */

export function DefaultsSection() {
  const s = useKitSession();
  const d = s.spec.defaults;
  const set = (patch: Partial<typeof d>, immediate = true) =>
    s.update('defaults', (cur) => ({ ...cur, ...patch }), { immediate });
  const builtin = useCaptionStyles();
  const kitStyles = useIpcQuery('brand:styles', { kitId: s.kit.id }, { staleTime: 30_000 });
  const styleOptions = [
    ...(kitStyles.data?.styles ?? []).map((x) => ({ value: x.id, label: `${x.name} (this kit)` })),
    ...(builtin.data?.styles ?? [])
      .filter((x) => x.builtin)
      .map((x) => ({ value: x.id, label: x.name })),
  ];
  // the stored id can be a custom style that no longer exists: still show it instead of an empty select
  if (!styleOptions.some((o) => o.value === d.captionStyleId))
    styleOptions.unshift({ value: d.captionStyleId, label: d.captionStyleId });
  const hookStyles = s.spec.textStyles.filter((t) => t.kind === 'hook');

  return (
    <Section id="defaults" description="What a new project starts with when this kit is selected.">
      <div className="grid gap-x-8 gap-y-5 @3xl:grid-cols-2">
        <FieldRow label="Aspect ratio">
          <Segmented
            size="sm"
            label="Default aspect ratio"
            value={d.aspect}
            onValueChange={(aspect) => set({ aspect })}
            options={ASPECTS.map((a) => ({ value: a.value, label: a.label }))}
            className="flex-wrap"
          />
        </FieldRow>
        <FieldRow
          label="Target platforms"
          hint="Where clips made with this kit are meant to be posted."
        >
          <div role="group" aria-label="Target platforms" className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const on = d.platforms.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? d.platforms.filter((x) => x !== p) : [...d.platforms, p];
                    if (next.length) set({ platforms: PLATFORMS.filter((x) => next.includes(x)) });
                  }}
                  className={cn(
                    'h-8 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-(--duration-fast) active:scale-[0.97]',
                    on
                      ? 'border-primary/70 bg-primary-soft text-primary-text'
                      : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {PLATFORM_LABELS[p]}
                </button>
              );
            })}
          </div>
        </FieldRow>
        <FieldRow label="Caption preset" htmlFor="def-caption">
          <SelectField
            id="def-caption"
            label="Default caption preset"
            value={d.captionStyleId}
            onChange={(captionStyleId) => set({ captionStyleId })}
            options={styleOptions}
          />
        </FieldRow>
        <FieldRow
          label="Hook text style"
          htmlFor="def-hook"
          hint="Used for the hook text in new editor projects. The burned-in hook card uses the Hook card section."
        >
          <SelectField
            id="def-hook"
            label="Default hook text style"
            value={d.hookTextStyleId ?? 'card'}
            onChange={(v) => set({ hookTextStyleId: v === 'card' ? null : v })}
            options={[
              { value: 'card', label: 'Hook card (default)' },
              ...hookStyles.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        </FieldRow>
      </div>

      <div className="grid gap-2.5 @3xl:grid-cols-2">
        <SwitchRow
          label="Watermark on by default"
          checked={d.watermarkOn}
          onChange={(v) => set({ watermarkOn: v })}
        />
        <SwitchRow
          label="Music bed on by default"
          checked={d.musicOn}
          onChange={(v) => set({ musicOn: v })}
        />
        <SwitchRow
          label="Intro on by default"
          checked={d.introOn}
          onChange={(v) => set({ introOn: v })}
        />
        <SwitchRow
          label="Outro on by default"
          checked={d.outroOn}
          onChange={(v) => set({ outroOn: v })}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <SubHeading>Hashtag sets</SubHeading>
            <p className="text-xs text-muted-foreground">
              Named lists you can drop into a post in one click.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set({
                hashtagSets: [
                  ...d.hashtagSets,
                  { id: newId('hs'), name: `Set ${d.hashtagSets.length + 1}`, tags: [] },
                ],
              })
            }
          >
            <Plus /> Add hashtag set
          </Button>
        </div>
        {d.hashtagSets.length ? (
          <ul className="grid gap-3 @3xl:grid-cols-2" aria-label="Hashtag sets">
            {d.hashtagSets.map((h) => (
              <TagSetCard key={h.id} set={h} />
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hash className="size-4 text-subtle" aria-hidden />
            No hashtag sets yet. Make one per niche, like “Podcast clips” or “Product demos”.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <SubHeading>Posting-time windows</SubHeading>
            <p className="text-xs text-muted-foreground">
              When the scheduler may place posts for this kit (your local time).
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set({
                postingWindows: [
                  ...d.postingWindows,
                  {
                    id: newId('pw'),
                    platform: null,
                    days: [1, 2, 3, 4, 5],
                    start: '09:00',
                    end: '12:00',
                  },
                ],
              })
            }
          >
            <Plus /> Add window
          </Button>
        </div>
        {d.postingWindows.length ? (
          <ul className="flex flex-col gap-2.5" aria-label="Posting-time windows">
            {d.postingWindows.map((w) => (
              <WindowRow key={w.id} w={w} />
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4 text-subtle" aria-hidden />
            No windows yet. Without one, the scheduler picks times on its own.
          </p>
        )}
      </div>
    </Section>
  );
}
