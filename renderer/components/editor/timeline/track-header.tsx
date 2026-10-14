'use client';

import * as React from 'react';
import {
  AudioLines,
  Captions,
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  Music,
  Type,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Track, TrackKind } from '@shared/editor';
import { Slider } from '@/components/ui/slider';
import { useEditorStore } from '@/lib/editor/core';
import { cn } from '@/lib/utils';
import { HEADER_W, TRACK_KIND_LABEL, type RowLayout } from './geometry';
import { useTimelineUi } from './timeline-ui';

export const TRACK_ICON: Record<TrackKind, React.ComponentType<{ className?: string }>> = {
  video: Video,
  overlay: Layers,
  image: ImageIcon,
  text: Type,
  subtitle: Captions,
  audio: Music,
  sfx: AudioLines,
};

const TRACK_COLOR: Record<TrackKind, string> = {
  video: 'var(--tl-video)',
  overlay: 'var(--tl-overlay)',
  image: 'var(--tl-image)',
  text: 'var(--tl-text)',
  subtitle: 'var(--tl-subtitle)',
  audio: 'var(--tl-audio)',
  sfx: 'var(--tl-sfx)',
};

const HAS_AUDIO: ReadonlySet<TrackKind> = new Set<TrackKind>(['video', 'overlay', 'audio', 'sfx']);

function ToggleButton({
  pressed,
  onClick,
  label,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        'app-no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-xs transition-colors [&_svg]:size-3.5',
        pressed
          ? 'bg-primary-soft text-primary-text'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function GainSlider({ track }: { track: Track }) {
  /** null = not dragging (the slider mirrors the store). */
  const [drag, setDrag] = React.useState<number | null>(null);
  const value = drag ?? track.gain;
  const commit = () => {
    if (drag !== null && Math.abs(drag - track.gain) > 1e-6)
      useEditorStore.getState().updateTrack(track.id, { gain: drag });
    setDrag(null);
  };
  return (
    <div className="flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
      <Volume2 className="size-3 shrink-0 text-subtle" aria-hidden />
      <Slider
        aria-label={`${track.name} gain`}
        className="min-w-0 flex-1"
        value={value}
        min={0}
        max={2}
        step={0.01}
        onValueChange={setDrag}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onDoubleClick={() => useEditorStore.getState().updateTrack(track.id, { gain: 1 })}
      />
      <span className="w-8 shrink-0 text-right text-2xs tabular-nums text-subtle">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function TrackNameEditor({ track }: { track: Track }) {
  const setUi = useTimelineUi((s) => s.set);
  const [draft, setDraft] = React.useState(track.name);
  const done = React.useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (name && name !== track.name) useEditorStore.getState().updateTrack(track.id, { name });
    setUi({ editingTrackId: null });
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      aria-label="Track name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          done.current = true;
          setUi({ editingTrackId: null });
        }
      }}
      className="h-6 min-w-0 flex-1 rounded-xs border border-ring bg-field px-1.5 text-xs text-foreground outline-none"
    />
  );
}

export const TrackHeader = React.memo(function TrackHeader({
  track,
  row,
  selected,
  reorderState,
  onContextMenu,
}: {
  track: Track;
  row: RowLayout;
  selected: boolean;
  reorderState: 'dragging' | 'over-ok' | 'over-bad' | null;
  onContextMenu: (e: React.MouseEvent, track: Track) => void;
}) {
  const Icon = TRACK_ICON[track.kind];
  const editing = useTimelineUi((s) => s.editingTrackId === track.id);
  const setUi = useTimelineUi((s) => s.set);
  const act = useEditorStore.getState;
  const hasAudio = HAS_AUDIO.has(track.kind);
  const twoLine = hasAudio && row.height >= 52;
  return (
    <div
      role="group"
      aria-label={`${track.name} track header, ${TRACK_KIND_LABEL[track.kind]}`}
      data-track-header={track.id}
      data-selected={selected || undefined}
      data-reorder={reorderState ?? undefined}
      onContextMenu={(e) => onContextMenu(e, track)}
      onClick={() => act().selectTrack(track.id)}
      className={cn(
        'group/hdr sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-1 border-b border-r bg-card pl-1 pr-1.5',
        'data-[selected=true]:bg-accent',
        'data-[reorder=dragging]:opacity-50 data-[reorder=over-ok]:shadow-[inset_0_2px_0_var(--ring)] data-[reorder=over-bad]:shadow-[inset_0_2px_0_var(--danger)]',
      )}
      style={{ width: HEADER_W, height: row.height }}
    >
      <div className="flex items-center gap-1">
        <span
          data-track-grip={track.id}
          role="button"
          tabIndex={0}
          aria-label={`Reorder ${track.name}. Use Alt plus arrow up or down.`}
          onKeyDown={(e) => {
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              e.stopPropagation();
              const tracks = act().project.tracks;
              const idx = tracks.findIndex((t) => t.id === track.id);
              // visual tracks are shown in reverse array order, audio in array order
              const visual = track.kind !== 'audio' && track.kind !== 'sfx';
              const dir = (e.key === 'ArrowUp') === visual ? 1 : -1;
              const next = idx + dir;
              const other = tracks[next];
              if (other && (other.kind === 'audio' || other.kind === 'sfx') === !visual)
                act().moveTrack(track.id, next);
            }
          }}
          className="app-no-drag flex h-6 w-3.5 shrink-0 cursor-grab items-center justify-center rounded-xs text-subtle hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </span>
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-xs"
          style={{ color: TRACK_COLOR[track.kind] }}
        >
          <Icon className="size-3.5" />
        </span>
        {editing ? (
          <TrackNameEditor track={track} />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
            title={`${track.name} (double-click to rename)`}
            onDoubleClick={() => setUi({ editingTrackId: track.id })}
          >
            {track.name}
          </span>
        )}
        <ToggleButton
          pressed={track.locked}
          label={`Lock ${track.name}`}
          onClick={() => act().updateTrack(track.id, { locked: !track.locked })}
        >
          {track.locked ? <Lock /> : <LockOpen />}
        </ToggleButton>
        {hasAudio ? (
          <ToggleButton
            pressed={track.muted}
            label={`Mute ${track.name}`}
            onClick={() => act().updateTrack(track.id, { muted: !track.muted })}
          >
            {track.muted ? <VolumeX /> : <Volume2 />}
          </ToggleButton>
        ) : null}
        <ToggleButton
          pressed={track.hidden}
          label={`Hide ${track.name}`}
          onClick={() => act().updateTrack(track.id, { hidden: !track.hidden })}
        >
          {track.hidden ? <EyeOff /> : <Eye />}
        </ToggleButton>
      </div>
      {twoLine ? <GainSlider track={track} /> : null}
    </div>
  );
});
