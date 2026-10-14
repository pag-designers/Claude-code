'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Download, Film, Heart, Scissors, Star, SquarePen, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DisabledTip } from '@/components/ui/tooltip';
import { ClipsBrowser } from '@/components/library/clips-browser';
import { VideosBrowser } from '@/components/library/videos-browser';
import { EditedTab } from '@/components/library/edited-tab';
import { ExportedTab } from '@/components/library/exported-tab';
import { useAllClips, useVideos } from '@/lib/library';
import { useEditorProjects } from '@/lib/editor-panels/projects';

const TABS = ['videos', 'clips', 'favorites', 'edited', 'exported'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string | null): v is Tab => !!v && (TABS as readonly string[]).includes(v);

function Count({ n }: { n: number | undefined }) {
  if (!n) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 text-2xs font-semibold tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function FavoritesTab() {
  const clips = useAllClips();
  const videos = useVideos();
  const favClips = (clips.data?.items ?? []).filter((c) => c.favorite).length;
  const favVideos = (videos.data?.items ?? []).filter((v) => v.favorite).length;
  if (clips.isSuccess && videos.isSuccess && favClips + favVideos === 0)
    return (
      <EmptyState
        size="lg"
        icon={Heart}
        title="No favorites yet"
        description="Star the clips and videos you love and they are pinned here, so your best candidates are one click away."
        actions={
          <Button variant="outline" asChild>
            <Link href="/library/?tab=clips">Browse clips</Link>
          </Button>
        }
      />
    );
  return (
    <div className="flex flex-col gap-10">
      {favClips > 0 || clips.isPending ? (
        <section aria-labelledby="fav-clips">
          <h2
            id="fav-clips"
            className="mb-4 flex items-center gap-2 font-display text-lg font-semibold"
          >
            <Star className="size-4 fill-current text-warning" aria-hidden /> Favorite clips
          </h2>
          <ClipsBrowser scope={{ kind: 'favorites' }} />
        </section>
      ) : null}
      {favVideos > 0 || videos.isPending ? (
        <section aria-labelledby="fav-videos">
          <h2
            id="fav-videos"
            className="mb-4 flex items-center gap-2 font-display text-lg font-semibold"
          >
            <Film className="size-4 text-primary-text" aria-hidden /> Favorite videos
          </h2>
          <VideosBrowser favoritesOnly />
        </section>
      ) : null}
    </div>
  );
}

function LibraryTabs() {
  const params = useSearchParams();
  const fromUrl = params.get('tab');
  const [tab, setTab] = React.useState<Tab>(isTab(fromUrl) ? fromUrl : 'videos');
  const [lastUrlTab, setLastUrlTab] = React.useState(fromUrl);
  // follow in-app links such as /library/?tab=clips while already on the page
  if (fromUrl !== lastUrlTab) {
    setLastUrlTab(fromUrl);
    if (isTab(fromUrl)) setTab(fromUrl);
  }
  const change = (v: string) => {
    if (!isTab(v)) return;
    setTab(v);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', v);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    setLastUrlTab(v);
  };
  const videos = useVideos();
  const clips = useAllClips();
  const projects = useEditorProjects();
  return (
    <Tabs value={tab} onValueChange={change} className="flex flex-col gap-6">
      <TabsList aria-label="Library sections" className="w-full">
        <TabsTrigger value="videos">
          <Film /> Videos <Count n={videos.data?.items.length} />
        </TabsTrigger>
        <TabsTrigger value="clips">
          <Scissors /> Clips <Count n={clips.data?.items.length} />
        </TabsTrigger>
        <TabsTrigger value="favorites">
          <Heart /> Favorites
        </TabsTrigger>
        <TabsTrigger value="edited">
          <SquarePen /> Edited <Count n={projects.data?.items.length} />
        </TabsTrigger>
        <TabsTrigger value="exported">
          <Download /> Exported
        </TabsTrigger>
      </TabsList>
      <TabsContent value="videos">
        <VideosBrowser />
      </TabsContent>
      <TabsContent value="clips">
        <ClipsBrowser scope={{ kind: 'all' }} />
      </TabsContent>
      <TabsContent value="favorites">
        <FavoritesTab />
      </TabsContent>
      <TabsContent value="edited">
        <EditedTab />
      </TabsContent>
      <TabsContent value="exported">
        <ExportedTab />
      </TabsContent>
    </Tabs>
  );
}

export function LibraryView() {
  return (
    <Page wide>
      <PageHeader
        title="Library"
        description="Everything Clipfern has imported, found, edited and exported, in one searchable place."
        actions={
          <DisabledTip reason="Local file import arrives in a later version">
            <Button disabled>
              <Upload /> Import file
            </Button>
          </DisabledTip>
        }
      />
      <React.Suspense fallback={null}>
        <LibraryTabs />
      </React.Suspense>
    </Page>
  );
}
