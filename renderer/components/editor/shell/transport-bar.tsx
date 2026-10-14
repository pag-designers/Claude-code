'use client';

import * as React from 'react';
import {
  FastForward,
  Grid3x3,
  Magnet,
  MoveHorizontal,
  Pause,
  Play,
  Repeat,
  Rewind,
  ScanLine,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from 'lucide-react';
import { SAFE_AREAS } from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tip } from '@/components/ui/tooltip';
import { useEditorStore } from '@/lib/editor/core';
import { cn } from '@/lib/utils';
import { formatTimecode, parseTimecode } from '@/components/editor/timeline/geometry';

function TButton({
  label,
  keys,
  pressed,
  onClick,
  children,
  testId,
  className,
}: {
  label: string;
  keys?: string[];
  pressed?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <Tip
      content={
        <span className="flex items-center gap-2">
          {label}
          {keys ? <Kbd keys={keys} /> : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        onClick={onClick}
        className={cn(
          'app-no-drag inline-flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-4',
          pressed
            ? 'bg-primary-soft text-primary-text'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          className,
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

/** mm:ss:ff readout of the playhead; click to type a timecode and jump there. */
function Timecode() {
  const t = useEditorStore((s) => s.playheadSec);
  const fps = useEditorStore((s) => s.project.canvas.fps);
  const tracks = useEditorStore((s) => s.project.tracks);
  const total = React.useMemo(() => projectDuration({ tracks }), [tracks]);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const commit = () => {
    setEditing(false);
    const sec = parseTimecode(draft, fps);
    if (sec !== null) useEditorStore.getState().setPlayhead(Math.min(sec, Math.max(total, sec)));
  };
  return (
    <div className="flex items-baseline gap-1.5 font-mono tabular-nums" data-testid="timecode-wrap">
      {editing ? (
        <input
          autoFocus
          aria-label="Go to timecode"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          className="h-7 w-24 rounded-md border border-ring bg-field px-1.5 text-center text-md font-semibold text-foreground outline-none"
        />
      ) : (
        <button
          type="button"
          data-testid="timecode"
          aria-label={`Playhead ${formatTimecode(t, fps)}. Click to type a timecode.`}
          title="Click to jump to a timecode"
          onClick={() => {
            setDraft(formatTimecode(t, fps));
            setEditing(true);
          }}
          className="app-no-drag h-7 min-w-24 rounded-md px-1.5 text-center text-md font-semibold text-foreground hover:bg-accent"
        >
          {formatTimecode(t, fps)}
        </button>
      )}
      <span className="text-xs text-subtle" data-testid="timecode-total">
        / {formatTimecode(total, fps)}
      </span>
    </div>
  );
}

const RATES = [0.25, 0.5, 1, 1.5, 2, 4] as const;

function RateMenu() {
  const rate = useEditorStore((s) => s.rate);
  return (
    <DropdownMenu>
      <Tip content="Playback speed">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Playback rate ${rate}×`}
            data-testid="rate-menu"
            className="app-no-drag inline-flex h-7 min-w-9 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {rate < 0 ? '◀ ' : ''}
            {Math.abs(rate)}×
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="center" className="min-w-32">
        <DropdownMenuRadioGroup
          value={String(rate)}
          onValueChange={(v) => useEditorStore.getState().setRate(Number(v))}
        >
          {RATES.map((r) => (
            <DropdownMenuRadioItem key={r} value={String(r)}>
              {r}×
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SafeAreaMenu() {
  const safeArea = useEditorStore((s) => s.safeArea);
  return (
    <DropdownMenu>
      <Tip
        content={
          safeArea ? `Safe area: ${SAFE_AREAS[safeArea]?.label ?? safeArea}` : 'Safe-area guides'
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Safe-area guides"
            aria-pressed={!!safeArea}
            data-testid="safe-area-menu"
            className={cn(
              'app-no-drag inline-flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-4',
              safeArea
                ? 'bg-primary-soft text-primary-text'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <ScanLine />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="center" className="min-w-48">
        <DropdownMenuRadioGroup
          value={safeArea ?? 'none'}
          onValueChange={(v) => useEditorStore.getState().setSafeArea(v === 'none' ? null : v)}
        >
          <DropdownMenuRadioItem value="none">No guides</DropdownMenuRadioItem>
          {Object.entries(SAFE_AREAS).map(([id, a]) => (
            <DropdownMenuRadioItem key={id} value={id}>
              {a.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Play controls, timecode, loop / rate / guides and the snapping + ripple switches. */
export function TransportBar() {
  const playing = useEditorStore((s) => s.playing);
  const loop = useEditorStore((s) => s.loop);
  const showGrid = useEditorStore((s) => s.showGrid);
  const snap = useEditorStore((s) => s.snapEnabled);
  const ripple = useEditorStore((s) => s.rippleEnabled);
  const act = useEditorStore.getState;
  return (
    <div
      role="toolbar"
      aria-label="Transport"
      data-testid="transport-bar"
      className="flex h-11 shrink-0 items-center gap-1 border-t bg-card px-3"
    >
      <div className="flex items-center gap-0.5">
        <TButton
          label="Go to start"
          keys={['Home']}
          onClick={() => act().setPlayhead(0)}
          testId="to-start"
        >
          <SkipBack />
        </TButton>
        <TButton
          label="Previous frame"
          keys={['←']}
          onClick={() => act().stepFrames(-1)}
          testId="step-back"
        >
          <StepBack />
        </TButton>
        <TButton
          label="Play backwards (J)"
          keys={['J']}
          onClick={() => act().shuttle('J')}
          testId="shuttle-j"
        >
          <Rewind />
        </TButton>
        <Tip
          content={
            <span className="flex items-center gap-2">
              {playing ? 'Pause' : 'Play'} <Kbd keys={['Space']} />
            </span>
          }
        >
          <button
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
            data-testid="play-pause"
            onClick={() => act().togglePlay()}
            className="app-no-drag mx-0.5 inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs transition-colors hover:bg-primary-hover [&_svg]:size-4"
          >
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </button>
        </Tip>
        <TButton
          label="Play forwards (L)"
          keys={['L']}
          onClick={() => act().shuttle('L')}
          testId="shuttle-l"
        >
          <FastForward />
        </TButton>
        <TButton
          label="Next frame"
          keys={['→']}
          onClick={() => act().stepFrames(1)}
          testId="step-forward"
        >
          <StepForward />
        </TButton>
        <TButton
          label="Go to end"
          keys={['End']}
          onClick={() => act().setPlayhead(projectDuration(act().project))}
          testId="to-end"
        >
          <SkipForward />
        </TButton>
      </div>

      <div className="mx-auto px-2">
        <Timecode />
      </div>

      <div className="flex items-center gap-0.5">
        <TButton
          label="Loop playback"
          keys={['mod', 'L']}
          pressed={loop}
          onClick={() => act().setLoop(!loop)}
          testId="loop"
        >
          <Repeat />
        </TButton>
        <RateMenu />
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <SafeAreaMenu />
        <TButton label="Grid" pressed={showGrid} onClick={() => act().toggleGrid()} testId="grid">
          <Grid3x3 />
        </TButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <TButton
          label="Snapping"
          keys={['N']}
          pressed={snap}
          onClick={() => act().toggleSnap()}
          testId="snap"
        >
          <Magnet />
        </TButton>
        <TButton
          label="Ripple edit"
          keys={['R']}
          pressed={ripple}
          onClick={() => act().toggleRipple()}
          testId="ripple"
        >
          <MoveHorizontal />
        </TButton>
      </div>
    </div>
  );
}
