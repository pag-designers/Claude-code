'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clapperboard, FilePlus2, Library } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, timeAgo } from '@/lib/format';
import { useIpcMutation, useIpcQuery } from '@/lib/ipc';

/** `/editor/` without a project id: the recent projects, a blank project, and a way back to the Library. */
export function ProjectPicker() {
  const router = useRouter();
  const list = useIpcQuery('editor:list');
  const create = useIpcMutation('editor:create', {
    invalidate: ['editor:list'],
    onSuccess: (doc) => router.push(`/editor/?id=${encodeURIComponent(doc.id)}`),
    onError: (e) => toast.error('Could not create the project', { description: e.message }),
  });
  const items = list.data?.items ?? [];
  return (
    <div className="mx-auto w-full max-w-[1100px] px-8 py-8" data-testid="project-picker">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Editor</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" asChild>
            <Link href="/library/">
              <Library /> Open from Library
            </Link>
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => create.mutate({ from: { blank: true, aspect: '9:16' } })}
            data-testid="new-blank-project"
          >
            <FilePlus2 /> New blank project
          </Button>
        </div>
      </div>
      {list.isPending ? (
        <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="No editor projects yet"
          description="Open any clip or video from the Library with Open in editor, or start from a blank project."
          className="rounded-xl border bg-card"
        />
      ) : (
        <ul
          className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2"
          aria-label="Recent projects"
        >
          {items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/editor/?id=${encodeURIComponent(p.id)}`}
                className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-border-strong"
              >
                <div className="relative flex h-32 items-center justify-center bg-muted">
                  {p.thumbUrl ? (
                    <img src={p.thumbUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Clapperboard className="size-6 text-subtle" aria-hidden />
                  )}
                  <span className="absolute bottom-2 right-2 rounded-xs bg-background/80 px-1.5 text-2xs font-semibold tabular-nums">
                    {formatClock(p.durationSec)}
                  </span>
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.aspect} · edited {timeAgo(p.updatedAt)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
