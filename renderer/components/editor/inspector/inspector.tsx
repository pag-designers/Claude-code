'use client';

import * as React from 'react';
import { Captions, ImageIcon, MousePointerClick, Music, Shapes, Type, Video } from 'lucide-react';
import type { Item, ItemType, Track } from '@shared/editor';
import { findItem } from '@shared/editor-eval';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { InspectorProvider } from './context';
import { SelectedKeyframeEditor } from './graph/path-keyframe-editor';
import { Section } from './fields/section';
import { AudioSection, BeatsSection } from './panels/audio-section';
import { ColorSection } from './panels/color-section';
import { CropSection, FitSection } from './panels/crop-fit-section';
import { ProjectSettings } from './panels/project-section';
import { ReframeSection } from './panels/reframe-section';
import { ShapeSection } from './panels/shape-section';
import { SpeedSection } from './panels/speed-section';
import {
  ResyncSection,
  SubtitleStyleSection,
  SubtitleTimingSection,
  SubtitleWordsSection,
} from './panels/subtitle-section';
import {
  AnimationSection,
  FontSection,
  StyleSections,
  TextContentSection,
} from './panels/text-section';
import { TrackSection } from './panels/track-section';
import { TransitionSection } from './panels/transition-section';
import {
  BlendSelect,
  FadesFields,
  KeyframesSummary,
  TransformSection,
} from './panels/transform-section';
import { useEditorStore } from './store';

const TYPE_META: Record<
  ItemType,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  video: { label: 'Video', icon: Video },
  image: { label: 'Image', icon: ImageIcon },
  audio: { label: 'Audio', icon: Music },
  text: { label: 'Text', icon: Type },
  subtitle: { label: 'Caption', icon: Captions },
  shape: { label: 'Shape', icon: Shapes },
};

interface TabDef {
  id: string;
  label: string;
  render: (track: Track | undefined) => React.ReactNode;
}

const LayerSection = () => (
  <Section title="Blend & fades" testId="section-layer">
    <BlendSelect />
    <FadesFields />
  </Section>
);

const TABS: Record<ItemType, TabDef[]> = {
  video: [
    {
      id: 'video',
      label: 'Video',
      render: () => (
        <>
          <TransformSection />
          <FitSection />
          <CropSection />
          <LayerSection />
          <TransitionSection />
          <KeyframesSummary />
        </>
      ),
    },
    { id: 'speed', label: 'Speed', render: () => <SpeedSection /> },
    {
      id: 'audio',
      label: 'Audio',
      render: (track) => (
        <>
          <AudioSection />
          <BeatsSection />
          {track ? <TrackSection track={track} /> : null}
        </>
      ),
    },
    { id: 'colour', label: 'Colour', render: () => <ColorSection /> },
    { id: 'reframe', label: 'Reframe', render: () => <ReframeSection /> },
  ],
  image: [
    {
      id: 'image',
      label: 'Image',
      render: () => (
        <>
          <TransformSection />
          <FitSection />
          <CropSection />
          <LayerSection />
          <TransitionSection />
          <KeyframesSummary />
        </>
      ),
    },
    { id: 'colour', label: 'Colour', render: () => <ColorSection /> },
  ],
  audio: [
    {
      id: 'audio',
      label: 'Audio',
      render: () => (
        <>
          <AudioSection />
          <BeatsSection />
          <KeyframesSummary />
        </>
      ),
    },
    { id: 'speed', label: 'Speed', render: () => <SpeedSection /> },
    {
      id: 'track',
      label: 'Track',
      render: (track) => (track ? <TrackSection track={track} /> : null),
    },
  ],
  text: [
    {
      id: 'text',
      label: 'Text',
      render: () => (
        <>
          <TextContentSection />
          <FontSection />
        </>
      ),
    },
    { id: 'style', label: 'Style', render: () => <StyleSections /> },
    { id: 'motion', label: 'Motion', render: () => <AnimationSection /> },
    {
      id: 'layer',
      label: 'Layer',
      render: () => (
        <>
          <TransformSection />
          <Section title="Blend" testId="section-blend">
            <BlendSelect />
          </Section>
          <KeyframesSummary />
        </>
      ),
    },
  ],
  subtitle: [
    {
      id: 'words',
      label: 'Words',
      render: () => (
        <>
          <SubtitleWordsSection />
          <ResyncSection />
        </>
      ),
    },
    { id: 'style', label: 'Style', render: () => <SubtitleStyleSection /> },
    { id: 'timing', label: 'Timing', render: () => <SubtitleTimingSection /> },
  ],
  shape: [
    { id: 'shape', label: 'Shape', render: () => <ShapeSection /> },
    {
      id: 'layer',
      label: 'Layer',
      render: () => (
        <>
          <TransformSection />
          <Section title="Blend" testId="section-blend">
            <BlendSelect />
          </Section>
          <KeyframesSummary />
        </>
      ),
    },
  ],
};

const hasTransform = (i: Item): boolean => 'transform' in i;

function Header({ items }: { items: Item[] }) {
  const first = items[0] as Item;
  const same = items.every((i) => i.type === first.type);
  const meta = TYPE_META[first.type];
  const Icon = same ? meta.icon : MousePointerClick;
  const title =
    items.length > 1
      ? `${items.length} ${same ? meta.label.toLowerCase() : 'mixed'} items`
      : (first.name ?? meta.label);
  const sub =
    items.length > 1
      ? same
        ? 'Edits apply to all'
        : 'Shared properties only'
      : `${meta.label} · ${first.durationSec.toFixed(2)} s`;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <h2
          className="truncate text-sm font-semibold leading-4 text-foreground"
          data-testid="inspector-title"
        >
          {title}
        </h2>
        <p className="truncate text-2xs leading-4 text-subtle" data-testid="inspector-subtitle">
          {sub}
        </p>
      </div>
    </div>
  );
}

function ItemPanel({ items, track }: { items: Item[]; track: Track | undefined }) {
  const type = (items[0] as Item).type;
  const defs = TABS[type];
  const [tabs, setTabs] = React.useState<Partial<Record<ItemType, string>>>({});
  const value = defs.find((d) => d.id === tabs[type])?.id ?? (defs[0] as TabDef).id;
  return (
    <Tabs
      value={value}
      onValueChange={(v) => setTabs((t) => ({ ...t, [type]: v }))}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList
        className="shrink-0 gap-0 overflow-x-auto px-1.5"
        aria-label={`${TYPE_META[type].label} properties`}
      >
        {defs.map((d) => (
          <TabsTrigger
            key={d.id}
            value={d.id}
            data-testid={`tab-${d.id}`}
            className="px-2.5 pb-2 pt-1.5 text-xs after:inset-x-2 focus-visible:outline-offset-[-2px]"
          >
            {d.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {defs.map((d) => (
        <TabsContent
          key={d.id}
          value={d.id}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-testid={`panel-${d.id}`}
        >
          {value === d.id ? d.render(track) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** Items that share a transform, for a mixed-type selection. */
function MixedPanel() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="panel-mixed">
      <TransformSection />
      <Section title="Blend" testId="section-blend">
        <BlendSelect />
      </Section>
    </div>
  );
}

/**
 * The right dock. Reads the selection from the editor store and shows, per item type, tabbed sections for every clip
 * tool and property editor. Nothing selected → project settings (and the selected track, if any).
 */
export function Inspector({ className }: { className?: string }) {
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const itemIds = useEditorStore((s) => s.selection.itemIds);
  const trackId = useEditorStore((s) => s.selection.trackId);
  const keyframeSel = useEditorStore((s) => s.selection.keyframe);

  const items = React.useMemo(
    () => itemIds.map((id) => findItem(project, id)?.item).filter((i): i is Item => !!i),
    [project, itemIds],
  );
  const same = items.length > 0 && items.every((i) => i.type === (items[0] as Item).type);
  const shared = same ? items : items.filter(hasTransform);
  const track = React.useMemo(() => {
    const first = items[0];
    if (first) return project.tracks.find((t) => t.items.some((i) => i.id === first.id));
    return trackId ? project.tracks.find((t) => t.id === trackId) : undefined;
  }, [project, items, trackId]);

  return (
    <aside
      aria-label="Inspector"
      data-testid="inspector"
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden bg-card text-foreground',
        className,
      )}
    >
      {items.length > 0 ? (
        <>
          <Header items={items} />
          {keyframeSel ? (
            <div className="max-h-[58%] shrink-0 overflow-y-auto border-b border-border bg-muted/40 px-3 py-2.5">
              <SelectedKeyframeEditor />
            </div>
          ) : null}
          {same || shared.length > 0 ? (
            <InspectorProvider items={shared} project={project} projectId={projectId}>
              {same ? <ItemPanel items={items} track={track} /> : <MixedPanel />}
            </InspectorProvider>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              These items have no shared properties. Select items of one type to edit them together.
            </p>
          )}
        </>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-testid="inspector-empty"
        >
          <div className="flex items-center gap-3 border-b border-border px-3 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-subtle">
              <MousePointerClick className="size-4" aria-hidden />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Select a clip to edit it</h2>
              <p className="text-xs text-subtle">
                Click anything on the timeline or in the preview.
              </p>
            </div>
          </div>
          {keyframeSel ? (
            <div className="border-b border-border bg-muted/40 px-3 py-2.5">
              <SelectedKeyframeEditor />
            </div>
          ) : null}
          {track ? <TrackSection track={track} /> : null}
          <ProjectSettings />
        </div>
      )}
    </aside>
  );
}
