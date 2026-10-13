'use client';

import Link from 'next/link';
import {
  Clapperboard,
  Download,
  Film,
  Grid2x2,
  Heart,
  List,
  Scissors,
  Search,
  SquarePen,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DisabledTip } from '@/components/ui/tooltip';
import { Page, PageHeader } from '@/components/ui/page';
import { Segmented } from '@/components/ui/segmented';

const LOCKED = 'Filters unlock once your library has items';

function FilterBar() {
  return (
    <div
      className="flex flex-wrap items-center gap-2.5"
      role="group"
      aria-label="Filters (unavailable until the library has items)"
    >
      <DisabledTip reason={LOCKED} side="bottom">
        <Input
          aria-label="Search library"
          placeholder="Search titles and transcripts"
          leading={<Search />}
          disabled
          className="w-72"
        />
      </DisabledTip>
      {['Score', 'Duration', 'Platform', 'Campaign', 'Date'].map((f) => (
        <DisabledTip key={f} reason={LOCKED} side="bottom">
          <Select disabled>
            <SelectTrigger aria-label={f} className="w-32">
              <SelectValue placeholder={f} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
            </SelectContent>
          </Select>
        </DisabledTip>
      ))}
      <div className="ml-auto">
        <DisabledTip reason={LOCKED} side="bottom">
          <Segmented
            label="Layout"
            value="grid"
            onValueChange={() => {}}
            disabled
            size="sm"
            options={[
              { value: 'grid', label: <Grid2x2 className="size-4" />, hint: 'Grid' },
              { value: 'list', label: <List className="size-4" />, hint: 'List' },
            ]}
          />
        </DisabledTip>
      </div>
    </div>
  );
}

const HOME_CTA = (
  <Button variant="primary" asChild>
    <Link href="/">Paste a YouTube URL</Link>
  </Button>
);

export function LibraryView() {
  return (
    <Page>
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
      <Tabs defaultValue="videos" className="flex flex-col gap-5">
        <TabsList aria-label="Library sections" className="w-full">
          <TabsTrigger value="videos">
            <Film /> Videos
          </TabsTrigger>
          <TabsTrigger value="clips">
            <Scissors /> Clips
          </TabsTrigger>
          <TabsTrigger value="favorites">
            <Heart /> Favorites
          </TabsTrigger>
          <TabsTrigger value="edited">
            <SquarePen /> Edited
          </TabsTrigger>
          <TabsTrigger value="exported">
            <Download /> Exported
          </TabsTrigger>
        </TabsList>
        <FilterBar />
        <Card className="overflow-hidden">
          <TabsContent value="videos">
            <EmptyState
              size="lg"
              icon={Film}
              title="No videos imported yet"
              description="Imported YouTube videos live here as lightweight 480p proxies, with their transcript, chapters and AI notes."
              steps={[
                'Paste a YouTube URL on Home.',
                'Clipfern downloads, transcribes and understands it.',
                'Open the video to browse chapters and clips.',
              ]}
              actions={HOME_CTA}
            />
          </TabsContent>
          <TabsContent value="clips">
            <EmptyState
              size="lg"
              icon={Scissors}
              title="Your clips will land here"
              description="Every AI-found moment shows up as a card with a virality score, hook and captions, appearing as soon as the first candidates are ready."
              steps={[
                'Sort by score to see the strongest first.',
                'Select several to render, download or schedule together.',
              ]}
              actions={HOME_CTA}
            />
          </TabsContent>
          <TabsContent value="favorites">
            <EmptyState
              size="lg"
              icon={Heart}
              title="No favorites yet"
              description="Star the clips you love and they are pinned here, so your best candidates are one click away."
            />
          </TabsContent>
          <TabsContent value="edited">
            <EmptyState
              size="lg"
              icon={Clapperboard}
              title="Nothing edited yet"
              description="Clips you refine in the multi-track editor are kept here with their full edit history. The editor arrives in checkpoint 3."
            />
          </TabsContent>
          <TabsContent value="exported">
            <EmptyState
              size="lg"
              icon={Download}
              title="No exports yet"
              description="Finished renders (1080×1920 MP4 plus optional SRT/VTT) are listed here, ready to download or send to the scheduler."
            />
          </TabsContent>
        </Card>
      </Tabs>
    </Page>
  );
}
