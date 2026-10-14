'use client';

import * as React from 'react';
import { Loader2, Merge, Palette, RefreshCw, Scissors, Sparkles } from 'lucide-react';
import type { SubtitleItem } from '@shared/editor';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { StyleStudio } from '@/components/captions/style-studio';
import { StyleGallery } from '@/components/captions/style-gallery';
import { StyleThumb } from '@/components/captions/style-thumb';
import { useCaptionStyles } from '@/lib/cp2-captions';
import { invoke } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { ColorInput } from '../fields/color-input';
import { IconButton } from '../fields/controls';
import { NumberField } from '../fields/number-field';
import { Hint, Notice, Row, Section } from '../fields/section';
import { asPatch, useInspector } from '../context';
import { useEditorStore } from '../store';
import { cueSourceRange, findCueMedia, mapSourceWordsToCue } from '../lib/retime';
import {
  activeWordIndex,
  setLastWordEnd,
  setWordColor,
  setWordStart,
  setWordText,
} from '../lib/subtitle-edit';

const cue = (i: unknown) => i as SubtitleItem;

function WordRow({
  item,
  index,
  active,
  timing,
}: {
  item: SubtitleItem;
  index: number;
  active: boolean;
  timing: boolean;
}) {
  const ctx = useInspector();
  const word = item.words[index]!;
  const last = index === item.words.length - 1;
  const [text, setText] = React.useState<string | null>(null);
  const st = () => useEditorStore.getState();
  const write = (words: SubtitleItem['words'], label: string, key?: string) =>
    st().updateItem(item.id, asPatch({ words }), {
      label,
      coalesceKey: key ? `${item.id}:${key}` : undefined,
    });
  const commit = () => {
    if (text === null) return;
    const next = text;
    setText(null);
    if (next.trim() === word.w) return;
    write(setWordText(item.words, index, next), 'Edit word');
  };
  return (
    <li
      data-testid="word-row"
      data-active={active || undefined}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors duration-(--duration-fast)',
        active && 'bg-primary-soft',
      )}
    >
      <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-subtle">{index + 1}</span>
      <input
        aria-label={`Word ${index + 1}`}
        data-testid="word-input"
        spellCheck={false}
        value={text ?? word.w}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(null);
            e.currentTarget.blur();
          }
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-foreground outline-none transition-[border-color,background-color] duration-(--duration-fast) hover:border-border-strong focus-visible:border-ring focus-visible:bg-field focus-visible:ring-2 focus-visible:ring-ring/25"
      />
      {timing ? (
        <>
          <NumberField
            label={`Word ${index + 1} start`}
            testId={`word-start-${index}`}
            value={word.s}
            min={0}
            max={item.durationSec}
            step={0.01}
            decimals={2}
            unit="s"
            onChange={() => undefined}
            onCommit={(v) =>
              write(setWordStart(item.words, index, v, item.durationSec), 'Word timing')
            }
            className="w-[4.25rem]"
          />
          {last ? (
            <NumberField
              label={`Word ${index + 1} end`}
              testId={`word-end-${index}`}
              value={word.e}
              min={0}
              max={item.durationSec}
              step={0.01}
              decimals={2}
              unit="s"
              onChange={() => undefined}
              onCommit={(v) =>
                write(setLastWordEnd(item.words, v, item.durationSec), 'Word timing')
              }
              className="w-[4.25rem]"
            />
          ) : null}
        </>
      ) : null}
      <ColorInput
        compact
        label={`Word ${index + 1} highlight`}
        value={word.color ?? '#FFFFFF'}
        empty={word.color === null}
        allowClear
        onChange={(hex) =>
          write(setWordColor(item.words, index, hex), 'Word colour', `word-color-${index}`)
        }
        onClear={() => write(setWordColor(item.words, index, null), 'Clear word colour')}
      />
      <IconButton
        label={
          index === 0 ? 'Cannot split before the first word' : `Split caption before “${word.w}”`
        }
        disabled={index === 0 || ctx.multi}
        testId="word-split"
        onClick={() => st().splitCue(item.id, index)}
      >
        <Scissors />
      </IconButton>
    </li>
  );
}

/** Word-by-word list: inline edit, per-word highlight colour, split / merge, optional per-word timing. */
export function SubtitleWordsSection() {
  const ctx = useInspector();
  const item = cue(ctx.primary);
  const playhead = useEditorStore((s) => s.playheadSec);
  const [timing, setTiming] = React.useState(false);
  const track = ctx.project.tracks.find((t) => t.items.some((i) => i.id === item.id));
  const hasNext =
    !!track &&
    track.items.some(
      (i) => i.startSec >= item.startSec + item.durationSec - 1e-6 && i.id !== item.id,
    );
  if (ctx.multi)
    return (
      <Section title="Words" testId="section-words">
        <Hint>{ctx.items.length} captions selected. Select one to edit its words.</Hint>
      </Section>
    );
  const active = activeWordIndex(item.words, playhead - item.startSec);
  return (
    <Section
      title={`Words · ${item.words.length}`}
      testId="section-words"
      action={
        <label className="flex items-center gap-1.5 text-2xs text-subtle">
          Timing
          <Switch
            aria-label="Show word timing"
            data-testid="word-timing-toggle"
            checked={timing}
            onCheckedChange={setTiming}
          />
        </label>
      }
    >
      {item.words.length === 0 ? (
        <Hint>
          This caption has no words yet. Re-sync with AI to transcribe the speech under it.
        </Hint>
      ) : (
        <ul className="-mx-1 flex flex-col" aria-label="Words">
          {item.words.map((_, i) => (
            <WordRow key={i} item={item} index={i} active={i === active} timing={timing} />
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          data-testid="merge-next"
          disabled={!hasNext}
          onClick={() => useEditorStore.getState().mergeCueWithNext(item.id)}
        >
          <Merge aria-hidden /> Merge with next
        </Button>
      </div>
      <Hint>Type a space inside a word to split it into two. Clear a word to delete it.</Hint>
    </Section>
  );
}

/** Start / end / duration of the cue on the timeline, plus nudge buttons. */
export function SubtitleTimingSection() {
  const ctx = useInspector();
  const item = cue(ctx.primary);
  const fps = ctx.fps;
  const st = () => useEditorStore.getState();
  const start = item.startSec;
  const end = item.startSec + item.durationSec;
  const retime = (s: number, e: number) => {
    if (ctx.multi) return;
    st().retimeCue(item.id, Math.max(0, s), Math.max(s + 0.1, e));
  };
  const nudge = (d: number) => {
    const s = Math.max(0, start + d);
    retime(s, s + item.durationSec);
  };
  return (
    <Section title="Timing" testId="section-sub-timing">
      <Row label="Start">
        <NumberField
          label="Caption start"
          testId="cue-start"
          value={start}
          min={0}
          step={0.05}
          decimals={2}
          unit="s"
          disabled={ctx.multi}
          onChange={() => undefined}
          onCommit={(v) => retime(v, end)}
        />
      </Row>
      <Row label="End">
        <NumberField
          label="Caption end"
          testId="cue-end"
          value={end}
          min={start + 0.1}
          step={0.05}
          decimals={2}
          unit="s"
          disabled={ctx.multi}
          onChange={() => undefined}
          onCommit={(v) => retime(start, v)}
        />
      </Row>
      <Row label="Duration">
        <NumberField
          label="Caption duration"
          testId="cue-duration"
          value={item.durationSec}
          min={0.1}
          step={0.05}
          decimals={2}
          unit="s"
          disabled={ctx.multi}
          onChange={() => undefined}
          onCommit={(v) => retime(start, start + v)}
        />
      </Row>
      <Row label="Nudge">
        <div role="group" aria-label="Nudge caption" className="flex flex-wrap gap-1">
          {[
            { d: -0.1, label: '−0.1 s' },
            { d: -1 / fps, label: '−1 f' },
            { d: 1 / fps, label: '+1 f' },
            { d: 0.1, label: '+0.1 s' },
          ].map((n) => (
            <Button
              key={n.label}
              size="xs"
              variant="secondary"
              className="h-6 px-2 text-2xs tabular-nums"
              disabled={ctx.multi}
              data-testid={`nudge-${n.label}`}
              onClick={() => nudge(n.d)}
            >
              {n.label}
            </Button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

/**
 * While a dialog we opened is up, Escape closes it AND would reach the editor's global shortcuts (deselect). Radix handles
 * Escape on a document capture listener; this one runs after it and stops the event from travelling further.
 */
function useConsumeEscape(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    const stop = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation();
    };
    document.addEventListener('keydown', stop, true);
    return () => document.removeEventListener('keydown', stop, true);
  }, [active]);
}

/** Caption preset for this line (and every line on the track), with the Caption Style Studio for custom looks. */
export function SubtitleStyleSection() {
  const ctx = useInspector();
  const item = cue(ctx.primary);
  const stylesQ = useCaptionStyles();
  const styles = stylesQ.data?.styles;
  const [pickOpen, setPickOpen] = React.useState(false);
  const [studio, setStudio] = React.useState(false);
  useConsumeEscape(studio);
  const styleId = ctx.read((i) => cue(i).styleId);
  const current = styles?.find((s) => s.id === item.styleId);
  const override = !!item.styleOverride;
  const track = ctx.project.tracks.find((t) => t.items.some((i) => i.id === item.id));
  const trackIds = (track?.items ?? []).filter((i) => i.type === 'subtitle').map((i) => i.id);

  return (
    <Section title="Style" testId="section-sub-style">
      <div className="flex items-center gap-2.5">
        <div
          className="w-24 shrink-0 overflow-hidden rounded-md border border-border-strong"
          data-testid="sub-style-preview"
        >
          {current && !override ? (
            <StyleThumb style={current} band alt={`${current.name} preview`} />
          ) : (
            <div className="flex aspect-[16/9] items-center justify-center bg-muted text-subtle">
              <Palette className="size-4" aria-hidden />
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span
            className="truncate text-sm font-medium text-foreground"
            data-testid="sub-style-name"
          >
            {styleId.mixed
              ? 'Mixed styles'
              : override
                ? 'Custom override'
                : (current?.name ?? item.styleId)}
          </span>
          <div className="flex gap-1.5">
            <Popover open={pickOpen} onOpenChange={setPickOpen}>
              <PopoverTrigger asChild>
                <Button size="xs" variant="secondary" data-testid="sub-style-pick">
                  Preset
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-[60vh] w-[19rem] overflow-y-auto p-2"
                data-testid="sub-style-gallery"
                onEscapeKeyDown={(e) => e.stopPropagation()}
              >
                <StyleGallery
                  styles={styles}
                  loading={stylesQ.isLoading}
                  error={stylesQ.error ? stylesQ.error.message : null}
                  selectedId={item.styleId}
                  currentId={item.styleId}
                  onRetry={() => void stylesQ.refetch()}
                  onSelect={(id) => {
                    ctx.set({ styleId: id, styleOverride: null }, 'Caption style');
                    setPickOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            <Button
              size="xs"
              variant="secondary"
              data-testid="sub-style-studio"
              onClick={() => setStudio(true)}
            >
              <Sparkles aria-hidden /> Customise…
            </Button>
          </div>
        </div>
      </div>
      {override ? (
        <Notice
          tone="info"
          testId="sub-override-note"
          action={
            <Button
              size="xs"
              variant="secondary"
              onClick={() => ctx.set({ styleOverride: null }, 'Remove override')}
            >
              Remove
            </Button>
          }
        >
          This line has its own style override; the preset is ignored.
        </Notice>
      ) : null}
      <Button
        size="xs"
        variant="soft"
        className="self-start"
        data-testid="apply-all-cues"
        disabled={trackIds.length < 2 && !ctx.multi}
        onClick={() =>
          useEditorStore
            .getState()
            .updateItems(trackIds, asPatch({ styleId: item.styleId, styleOverride: null }), {
              label: 'Apply caption style to all',
            })
        }
      >
        Apply to all {trackIds.length} captions on this track
      </Button>
      <StyleStudio
        open={studio}
        onOpenChange={setStudio}
        currentStyleId={item.styleId}
        title="Caption style for this line"
        description="Pick a preset or tune every detail. It is applied to the selected caption."
        applyLabel="Use for this caption"
        onApply={(id) => {
          ctx.set({ styleId: id, styleOverride: null }, 'Caption style');
          setStudio(false);
        }}
      />
    </Section>
  );
}

/** Re-transcribe the speech under the caption and map the fresh word times back onto the timeline. */
export function ResyncSection() {
  const ctx = useInspector();
  const item = cue(ctx.primary);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<number | null>(null);
  const media = findCueMedia(ctx.project, item);

  const run = async () => {
    if (!ctx.projectId || !media) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = cueSourceRange(media, item);
      const res = await invoke('editor:resyncSubtitles', {
        projectId: ctx.projectId,
        assetId: media.assetId,
        srcStartSec: r.srcStartSec,
        srcEndSec: r.srcEndSec,
      });
      const words = mapSourceWordsToCue(media, item, res.words);
      if (words.length === 0) {
        setError('No speech was found under this caption.');
        return;
      }
      useEditorStore
        .getState()
        .updateItem(item.id, asPatch({ words }), { label: 'Re-sync subtitles' });
      setDone(words.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Re-sync" testId="section-resync">
      <Button
        size="xs"
        variant="secondary"
        className="self-start"
        data-testid="resync"
        loading={busy}
        disabled={ctx.multi || !media || !ctx.projectId}
        onClick={() => void run()}
      >
        {busy ? null : <RefreshCw aria-hidden />} Re-sync with AI
      </Button>
      {busy ? (
        <div className="flex flex-col gap-1" data-testid="resync-progress">
          <Progress value={null} className="h-1" aria-label="Re-syncing captions" />
          <span className="flex items-center gap-1.5 text-2xs text-subtle">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Transcribing the audio under
            this caption…
          </span>
        </div>
      ) : null}
      {error ? (
        <Notice
          tone="danger"
          title="Re-sync failed"
          testId="resync-error"
          action={
            <Button size="xs" variant="secondary" onClick={() => void run()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      ) : null}
      {done !== null && !busy && !error ? (
        <Hint testId="resync-done">Updated {done} words from the audio.</Hint>
      ) : null}
      <Hint>
        {media
          ? 'Runs speech recognition on just this caption’s audio and re-times the words.'
          : 'No audible clip sits under this caption, so there is nothing to re-sync with.'}
      </Hint>
    </Section>
  );
}
