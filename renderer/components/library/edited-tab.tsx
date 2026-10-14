'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Clapperboard,
  Copy,
  FilePlus2,
  MoreHorizontal,
  Pencil,
  Scissors,
  SquarePen,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { EditorProjectSummary } from '@shared/editor';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, timeAgo } from '@/lib/format';
import { editorHref, libraryHref } from '@/lib/hrefs';
import {
  useDeleteProject,
  useDuplicateProject,
  useEditorProjects,
  useRenameProject,
} from '@/lib/editor-panels/projects';
import { useInView } from '@/lib/use-in-view';
import { NewProjectDialog } from './new-project-dialog';

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4';

function sourceOf(p: EditorProjectSummary): { label: string; icon: LucideIcon } {
  if (p.clipId) return { label: 'From a clip', icon: Scissors };
  if (p.videoId) return { label: 'From a video', icon: Video };
  return { label: 'Blank', icon: FilePlus2 };
}

function RenameDialog({
  project,
  onClose,
}: {
  project: EditorProjectSummary | null;
  onClose: () => void;
}) {
  const rename = useRenameProject();
  const [name, setName] = React.useState('');
  const [seen, setSeen] = React.useState<string | null>(null);
  if (project && project.id !== seen) {
    setSeen(project.id);
    setName(project.name);
  }
  const trimmed = name.trim();
  const submit = () => {
    if (!project || !trimmed) return;
    if (trimmed === project.name) return onClose();
    rename.mutate({ id: project.id, name: trimmed }, { onSuccess: onClose });
  };
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && !rename.isPending && onClose()}>
      <DialogContent className="max-w-sm" data-testid="rename-project-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold">Rename project</DialogTitle>
          <DialogDescription className="sr-only">Give the project a new name.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            value={name}
            maxLength={120}
            aria-label="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            data-testid="rename-project-input"
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={rename.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={rename.isPending}
            disabled={!trimmed}
            onClick={submit}
            data-testid="rename-project-save"
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCard({
  project,
  onRename,
  onDelete,
}: {
  project: EditorProjectSummary;
  onRename: (p: EditorProjectSummary) => void;
  onDelete: (p: EditorProjectSummary) => void;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [broken, setBroken] = React.useState(false);
  const dup = useDuplicateProject();
  const src = sourceOf(project);
  const href = editorHref(project.id);
  return (
    <li
      data-testid="project-card"
      data-project-id={project.id}
      className="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard) hover:-translate-y-px hover:border-border-strong hover:shadow-sm"
    >
      <Link
        href={href}
        aria-label={`Open project: ${project.name}`}
        className="relative block aspect-[4/3] bg-muted outline-offset-[-2px]"
      >
        <div ref={ref} className="absolute inset-0 flex items-center justify-center p-3">
          {project.thumbUrl && inView && !broken ? (
            <img
              src={project.thumbUrl}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() => setBroken(true)}
              className="max-h-full max-w-full rounded-md object-contain shadow-sm"
            />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-xl border border-border-strong bg-raised text-primary-text">
              <Clapperboard className="size-5" strokeWidth={1.75} aria-hidden />
            </span>
          )}
        </div>
        <span className="absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-white backdrop-blur-sm">
          {formatClock(project.durationSec)}
        </span>
        <span className="absolute left-2 top-2 flex gap-1">
          <Badge
            variant="neutral"
            className="bg-card/90 backdrop-blur-sm tabular-nums"
            data-testid="project-aspect"
          >
            {project.aspect}
          </Badge>
        </span>
      </Link>
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          <h3
            className="line-clamp-2 font-sans text-sm font-semibold leading-[18px] tracking-normal"
            title={project.name}
          >
            {project.name}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-2xs text-subtle">
            <span className="inline-flex items-center gap-1" data-testid="project-source">
              <src.icon className="size-3" aria-hidden /> {src.label}
            </span>
            <span aria-hidden>·</span>
            <span>Edited {timeAgo(project.updatedAt)}</span>
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${project.name}`}
              data-testid="project-menu"
              className="-mr-1.5 -mt-1"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem asChild>
              <Link href={href}>
                <SquarePen /> Open in editor
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRename(project)} data-testid="project-rename">
              <Pencil /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={dup.isPending}
              onSelect={() => dup.mutate({ id: project.id })}
              data-testid="project-duplicate"
            >
              <Copy /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger [&_svg]:text-danger"
              onSelect={() => onDelete(project)}
              data-testid="project-delete"
            >
              <Trash2 /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** Library → Edited: the user's editor projects. */
export function EditedTab() {
  const q = useEditorProjects();
  const del = useDeleteProject();
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<EditorProjectSummary | null>(null);
  const [deleting, setDeleting] = React.useState<EditorProjectSummary | null>(null);
  const items = React.useMemo(
    () => [...(q.data?.items ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [q.data],
  );

  return (
    <div className="flex flex-col gap-5" data-testid="edited-tab">
      {q.isError ? (
        <Banner
          tone="danger"
          title="Could not load your projects"
          action={
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          {q.error.message}
        </Banner>
      ) : q.isPending ? (
        <div className={GRID} aria-busy aria-label="Loading projects">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border bg-card">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          size="lg"
          icon={Clapperboard}
          title="Nothing edited yet"
          description="Projects you create in the multi-track editor live here with their full edit history. Open any clip or video from your Library, or start from a blank canvas."
          actions={
            <>
              <Button variant="primary" onClick={() => setCreating(true)} data-testid="edited-new">
                <FilePlus2 /> New blank project
              </Button>
              <Button variant="outline" asChild>
                <Link href={libraryHref('clips')}>
                  <Scissors /> Open a clip in the editor
                </Link>
              </Button>
            </>
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="edited-count">
              {items.length} {items.length === 1 ? 'project' : 'projects'}, newest first
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
              data-testid="edited-new"
            >
              <FilePlus2 /> New blank project
            </Button>
          </div>
          <ul className={GRID} aria-label="Edited projects">
            {items.map((p) => (
              <ProjectCard key={p.id} project={p} onRename={setRenaming} onDelete={setDeleting} />
            ))}
          </ul>
        </>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
      <RenameDialog project={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this project?"
        description={
          <>
            “{deleting?.name}” and its version history are removed. The clips and videos in your
            Library are not affected.
          </>
        }
        loading={del.isPending}
        onConfirm={() =>
          deleting && del.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) })
        }
      />
    </div>
  );
}
