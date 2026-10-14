'use client';

import './editor-shell.css';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { CircleAlert, Clapperboard, Library, RotateCw } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportPanel, MediaBin, VersionsPanel } from '@/components/editor/panels';
import { Inspector } from '@/components/editor/inspector';
import { Timeline } from '@/components/editor/timeline';
import { useEditorStore } from '@/lib/editor/core';
import { PreviewPlayer } from '@/lib/editor/playback';
import { libraryHref } from '@/lib/hrefs';
import { ConflictBanner } from './conflict-banner';
import { Splitter, usePaneSizes } from './panes';
import { ShortcutsOverlay } from './shortcuts-overlay';
import { TopBar } from './top-bar';
import { TransportBar } from './transport-bar';
import { useEditorKeys, useEditorSession } from './use-editor-session';

const MIN_CENTRE = 420;
const noopSubscribe = () => () => {};

function Loading() {
  return (
    <div
      className="flex h-full flex-col"
      aria-busy="true"
      aria-label="Opening project"
      data-testid="editor-loading"
    >
      <div className="h-12 border-b" />
      <div className="flex min-h-0 flex-1">
        <Skeleton className="m-3 w-72 rounded-xl" />
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <Skeleton className="h-[70%] w-56 rounded-xl" />
        </div>
        <Skeleton className="m-3 w-80 rounded-xl" />
      </div>
      <Skeleton className="m-3 h-56 rounded-xl" />
    </div>
  );
}

/** The full-screen editor for one project. Mounted into <body> so it covers the app shell (sidebar + top bar). */
export function EditorWorkspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { status, conflict, reload, resolveConflict } = useEditorSession(projectId);
  const saveState = useEditorStore((s) => s.saveState);
  const mounted = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  const [sizes, updateSizes] = usePaneSizes();
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [leaveOpen, setLeaveOpen] = React.useState(false);
  const toggleShortcuts = React.useCallback(() => setShortcutsOpen((o) => !o), []);
  useEditorKeys({ toggleShortcuts });

  /* ---- measured workspace for automatic sizes -------------------------------------------- */
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState({ w: 1440, h: 800 });
  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status.phase]);

  const autoTimeline = Math.round(Math.min(480, Math.max(250, box.h * 0.44)));
  const timelineH = Math.min(
    Math.max(160, sizes.timeline ?? autoTimeline),
    Math.max(160, box.h - 260),
  );
  const budget = Math.max(0, box.w - MIN_CENTRE);
  const leftW = sizes.leftOpen
    ? Math.min(sizes.left, Math.max(200, budget - (sizes.rightOpen ? 240 : 0)))
    : 0;
  const rightW = sizes.rightOpen ? Math.min(sizes.right, Math.max(240, budget - leftW)) : 0;

  /* ---- leaving -------------------------------------------------------------------------- */
  const go = React.useCallback(() => router.push(libraryHref('edited')), [router]);
  const back = () => {
    const st = useEditorStore.getState().saveState;
    if (st === 'error' || st === 'conflict') setLeaveOpen(true);
    else go();
  };

  /* ---- Enter on a clip opens the inspector ------------------------------------------------ */
  const inspectorRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const focusInspector = () => {
      if (!sizes.rightOpen) updateSizes({ rightOpen: true });
      requestAnimationFrame(() => {
        const root = inspectorRef.current;
        root
          ?.querySelector<HTMLElement>(
            'input:not([disabled]), button:not([disabled]), [tabindex="0"]',
          )
          ?.focus();
      });
    };
    window.addEventListener('clipfern:editor-focus-inspector', focusInspector);
    return () => window.removeEventListener('clipfern:editor-focus-inspector', focusInspector);
  }, [sizes.rightOpen, updateSizes]);

  if (!mounted) return null;

  let body: React.ReactNode;
  if (status.phase === 'loading') body = <Loading />;
  else if (status.phase === 'error') {
    body = (
      <div className="flex h-full flex-col items-center justify-center" data-testid="editor-error">
        <EmptyState
          icon={status.code === 'NOT_FOUND' ? Clapperboard : CircleAlert}
          title={
            status.code === 'NOT_FOUND'
              ? 'This project no longer exists'
              : 'Could not open the project'
          }
          description={status.message}
          actions={
            <>
              <Button variant="secondary" asChild>
                <a href={libraryHref('edited')}>
                  <Library /> Back to Library
                </a>
              </Button>
              {status.code !== 'NOT_FOUND' ? (
                <Button variant="primary" onClick={reload}>
                  <RotateCw /> Try again
                </Button>
              ) : null}
            </>
          }
        />
      </div>
    );
  } else {
    body = (
      <div className="flex h-full min-h-0 flex-col" data-testid="editor-workspace">
        <TopBar
          onBack={back}
          onVersions={() => setVersionsOpen(true)}
          onExport={() => setExportOpen(true)}
          onShortcuts={() => setShortcutsOpen(true)}
          leftOpen={sizes.leftOpen}
          rightOpen={sizes.rightOpen}
          onToggleLeft={() => updateSizes({ leftOpen: !sizes.leftOpen })}
          onToggleRight={() => updateSizes({ rightOpen: !sizes.rightOpen })}
        />
        {conflict || saveState === 'conflict' ? (
          <ConflictBanner onResolve={resolveConflict} />
        ) : null}
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {sizes.leftOpen ? (
              <>
                <aside
                  aria-label="Media bin"
                  className="min-h-0 shrink-0 overflow-hidden"
                  style={{ width: leftW }}
                  data-testid="dock-left"
                >
                  <MediaBin className="h-full" />
                </aside>
                <Splitter
                  orientation="vertical"
                  label="Resize media bin"
                  value={leftW}
                  min={200}
                  max={Math.max(200, Math.min(560, box.w - MIN_CENTRE - rightW))}
                  onChange={(v) => updateSizes({ left: v })}
                  onReset={() => updateSizes({ left: 288 })}
                />
              </>
            ) : null}
            <section
              aria-label="Preview"
              className="flex min-w-0 flex-1 flex-col bg-background"
              data-testid="centre"
            >
              <PreviewPlayer className="min-h-0 flex-1" />
              <TransportBar />
            </section>
            {sizes.rightOpen ? (
              <>
                <Splitter
                  orientation="vertical"
                  invert
                  label="Resize inspector"
                  value={rightW}
                  min={240}
                  max={Math.max(240, Math.min(600, box.w - MIN_CENTRE - leftW))}
                  onChange={(v) => updateSizes({ right: v })}
                  onReset={() => updateSizes({ right: 332 })}
                />
                <aside
                  ref={inspectorRef}
                  aria-label="Inspector"
                  className="min-h-0 shrink-0 overflow-hidden bg-sidebar"
                  style={{ width: rightW }}
                  data-testid="dock-right"
                >
                  <Inspector />
                </aside>
              </>
            ) : null}
          </div>
          <Splitter
            orientation="horizontal"
            label="Resize timeline"
            value={timelineH}
            min={160}
            max={Math.max(160, box.h - 260)}
            onChange={(v) => updateSizes({ timeline: v })}
            onReset={() => updateSizes({ timeline: null })}
          />
          <div className="shrink-0" style={{ height: timelineH }} data-testid="dock-timeline">
            <Timeline className="h-full" />
          </div>
        </div>
        <VersionsPanel open={versionsOpen} onOpenChange={setVersionsOpen} />
        <ExportPanel open={exportOpen} onOpenChange={setExportOpen} />
        <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <ConfirmDialog
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
          title="Leave without saving?"
          description="The latest changes could not be saved to disk. If you leave now they will be lost."
          confirmLabel="Leave anyway"
          onConfirm={() => {
            setLeaveOpen(false);
            go();
          }}
        />
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-40 bg-background text-foreground"
      role="application"
      aria-label="Video editor"
      data-testid="editor-root"
    >
      {body}
    </div>,
    document.body,
  );
}
