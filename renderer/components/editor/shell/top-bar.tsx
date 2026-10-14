'use client';

import * as React from 'react';
import {
  ChevronLeft,
  Download,
  History,
  Keyboard,
  Maximize2,
  Palette,
  PanelLeft,
  PanelRight,
  Redo2,
  Undo2,
} from 'lucide-react';
import { ASPECT_SIZES, type AspectId } from '@shared/editor';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tip } from '@/components/ui/tooltip';
import { onEditorFontsLoaded, refreshBrandFonts } from '@/lib/editor/compositor';
import { useEditorStore } from '@/lib/editor/core';
import { getEngine } from '@/lib/editor/playback';
import { ipc, useIpcEvent } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useTimelineUi } from '@/components/editor/timeline/timeline-ui';
import { ApplyBrandDialog } from './apply-brand-dialog';
import { SaveChip } from './save-chip';

const ASPECTS: { id: Exclude<AspectId, 'custom'>; label: string; w: number; h: number }[] = [
  { id: '9:16', label: '9:16 Vertical', w: 9, h: 16 },
  { id: '1:1', label: '1:1 Square', w: 1, h: 1 },
  { id: '16:9', label: '16:9 Landscape', w: 16, h: 9 },
  { id: '4:5', label: '4:5 Portrait', w: 4, h: 5 },
];

function AspectGlyph({ w, h }: { w: number; h: number }) {
  const k = 14 / Math.max(w, h);
  return (
    <span aria-hidden className="flex size-4 items-center justify-center">
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ width: Math.round(w * k), height: Math.round(h * k) }}
      />
    </span>
  );
}

function ProjectName() {
  const name = useEditorStore((s) => s.name);
  const projectId = useEditorStore((s) => s.projectId);
  /** null = not editing (the field mirrors the store). */
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    const next = (draft ?? name).trim().slice(0, 120);
    setDraft(null);
    if (!next || next === name || !projectId) return;
    useEditorStore.getState().rename(next);
    // the project name lives beside the document (editor:save carries only the project), so persist it explicitly
    void ipc.invoke('editor:rename', { id: projectId, name: next }).catch(() => {});
  };
  return (
    <input
      aria-label="Project name"
      data-testid="project-name"
      value={draft ?? name}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        setDraft(name);
        e.currentTarget.select();
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      maxLength={120}
      spellCheck={false}
      className="h-8 w-56 min-w-24 max-w-[28vw] truncate rounded-md border border-transparent bg-transparent px-2 text-md font-semibold text-foreground outline-none transition-colors hover:border-border hover:bg-field focus:border-ring focus:bg-field"
    />
  );
}

function UndoRedo() {
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const undoLabel = useEditorStore((s) => s.undoLabel);
  const redoLabel = useEditorStore((s) => s.redoLabel);
  const act = useEditorStore.getState;
  return (
    <div className="flex items-center gap-0.5">
      <Tip
        content={
          <span className="flex items-center gap-2">
            {undoLabel ? `Undo ${undoLabel}` : 'Undo'} <Kbd keys={['mod', 'Z']} />
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
          data-testid="undo"
          disabled={!canUndo}
          onClick={() => act().undo()}
        >
          <Undo2 />
        </Button>
      </Tip>
      <Tip
        content={
          <span className="flex items-center gap-2">
            {redoLabel ? `Redo ${redoLabel}` : 'Redo'} <Kbd keys={['mod', 'shift', 'Z']} />
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
          data-testid="redo"
          disabled={!canRedo}
          onClick={() => act().redo()}
        >
          <Redo2 />
        </Button>
      </Tip>
    </div>
  );
}

function AspectMenu() {
  const aspect = useEditorStore((s) => s.project.canvas.aspect);
  const cur = ASPECTS.find((a) => a.id === aspect);
  return (
    <DropdownMenu>
      <Tip content="Canvas aspect ratio">
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="gap-2"
            aria-label={`Aspect ratio ${cur?.id ?? 'custom'}`}
            data-testid="aspect-menu"
          >
            <AspectGlyph w={cur?.w ?? 1} h={cur?.h ?? 1} />
            <span className="tabular-nums">{cur?.id ?? 'Custom'}</span>
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="center" className="min-w-52">
        <DropdownMenuLabel>Canvas</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={aspect}
          onValueChange={(v) => {
            const id = v as Exclude<AspectId, 'custom'>;
            const size = ASPECT_SIZES[id];
            if (size)
              useEditorStore
                .getState()
                .setCanvas({ aspect: id, width: size.width, height: size.height });
          }}
        >
          {ASPECTS.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id}>
              <AspectGlyph w={a.w} h={a.h} /> {a.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Keeps the preview canvas in step with the Brand Kit's fonts: a kit that gained or lost a font re-registers them, and
 * whenever fonts finish loading the preview draws a fresh frame (text rasters are keyed on the font epoch).
 */
function useBrandCanvasSync() {
  useIpcEvent('brand:changed', () => void refreshBrandFonts());
  React.useEffect(() => onEditorFontsLoaded(() => getEngine()?.requestRender()), []);
}

export function TopBar({
  onBack,
  onVersions,
  onExport,
  onShortcuts,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
}: {
  onBack: () => void;
  onVersions: () => void;
  onExport: () => void;
  onShortcuts: () => void;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}) {
  useBrandCanvasSync();
  const [brandOpen, setBrandOpen] = React.useState(false);
  const fit = () => {
    const s = useEditorStore.getState();
    s.zoomToFit(useTimelineUi.getState().viewportPx);
    s.setScroll(0);
  };
  return (
    <header
      className="editor-topbar app-drag relative z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background"
      data-testid="editor-topbar"
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        data-testid="back-to-library"
        className="gap-1 pl-1.5 pr-2.5"
      >
        <ChevronLeft /> Library
      </Button>
      <span className="h-5 w-px bg-border" aria-hidden />
      <ProjectName />
      <SaveChip />

      <div className="ml-auto flex items-center gap-1.5">
        <Tip content={leftOpen ? 'Hide media bin' : 'Show media bin'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle media bin"
            aria-pressed={leftOpen}
            onClick={onToggleLeft}
            className={cn(leftOpen && 'text-foreground')}
          >
            <PanelLeft />
          </Button>
        </Tip>
        <UndoRedo />
        <AspectMenu />
        <Tip content="Zoom the timeline to fit the whole project">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom timeline to fit"
            data-testid="top-zoom-fit"
            onClick={fit}
          >
            <Maximize2 />
          </Button>
        </Tip>
        <Tip content="Apply a Brand Kit: watermark, intro and outro, captions, hook, music">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setBrandOpen(true)}
            data-testid="open-apply-brand"
          >
            <Palette /> Brand Kit
          </Button>
        </Tip>
        <Tip content="Version history">
          <Button variant="secondary" size="sm" onClick={onVersions} data-testid="open-versions">
            <History /> Versions
          </Button>
        </Tip>
        <Tip
          content={
            <span className="flex items-center gap-2">
              Keyboard shortcuts <Kbd keys={['?']} />
            </span>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            data-testid="open-shortcuts"
            onClick={onShortcuts}
          >
            <Keyboard />
          </Button>
        </Tip>
        <Button variant="primary" size="sm" onClick={onExport} data-testid="open-export">
          <Download /> Export
        </Button>
        <Tip content={rightOpen ? 'Hide inspector' : 'Show inspector'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle inspector"
            aria-pressed={rightOpen}
            onClick={onToggleRight}
            className={cn(rightOpen && 'text-foreground')}
          >
            <PanelRight />
          </Button>
        </Tip>
      </div>
      <ApplyBrandDialog open={brandOpen} onOpenChange={setBrandOpen} />
    </header>
  );
}
