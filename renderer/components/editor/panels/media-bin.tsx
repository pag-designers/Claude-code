'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Blend, Film, Music, Shapes, Type, WandSparkles, type LucideIcon } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import { usePersistedChoice } from '@/lib/persist';
import { cn } from '@/lib/utils';
import { AudioTab } from './audio-tab';
import { EffectsTab } from './effects-tab';
import { MediaTab } from './media-tab';
import './panels.css';
import { StickersTab } from './stickers-tab';
import { TextTab } from './text-tab';
import { TransitionsTab } from './transitions-tab';

const TABS = ['media', 'audio', 'text', 'stickers', 'transitions', 'effects'] as const;
export type BinTab = (typeof TABS)[number];

const META: Record<BinTab, { label: string; icon: LucideIcon; blurb: string }> = {
  media: { label: 'Media', icon: Film, blurb: 'Your files and Library clips' },
  audio: { label: 'Audio', icon: Music, blurb: 'Music, sound and beat sync' },
  text: { label: 'Text', icon: Type, blurb: 'Titles, captions and animations' },
  stickers: { label: 'Stickers', icon: Shapes, blurb: 'Shapes, progress bar and CTAs' },
  transitions: { label: 'Transitions', icon: Blend, blurb: 'Between two clips' },
  effects: { label: 'Effects', icon: WandSparkles, blurb: 'Filters and LUTs' },
};

/**
 * The editor's left dock: a vertical tab rail (Media · Audio · Text · Stickers · Transitions · Effects) and the
 * active tab's content. It reads and writes the editor store only; the host decides its width (≥ 280 px works).
 *
 * Drag sources: assets carry `application/x-clipfern-asset` {assetId}, transition tiles carry
 * `application/x-clipfern-transition` {type} (see lib/editor-panels/drag.ts).
 */
export function MediaBin({
  className,
  defaultTab = 'media',
}: {
  className?: string;
  defaultTab?: BinTab;
}) {
  const [tab, setTab] = usePersistedChoice<BinTab>('clipfern.editor.bin.tab', TABS, defaultTab);
  return (
    <TabsPrimitive.Root
      value={tab}
      onValueChange={(v) => setTab(v as BinTab)}
      orientation="vertical"
      data-testid="media-bin"
      className={cn('flex h-full min-h-0 min-w-0 bg-sidebar text-foreground', className)}
    >
      <TabsPrimitive.List
        aria-label="Editor panels"
        className="flex w-[60px] shrink-0 flex-col gap-0.5 border-r bg-card/50 p-1.5"
      >
        {TABS.map((t) => {
          const m = META[t];
          return (
            <Tip key={t} content={m.blurb} side="right">
              <TabsPrimitive.Trigger
                value={t}
                data-testid={`bin-tab-${t}`}
                className={cn(
                  'group flex h-[52px] w-full flex-col items-center justify-center gap-1 rounded-lg text-2xs font-medium text-muted-foreground outline-none transition-colors duration-(--duration-fast)',
                  'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                  'data-[state=active]:bg-primary-soft data-[state=active]:text-primary-text',
                )}
              >
                <m.icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
                {m.label}
              </TabsPrimitive.Trigger>
            </Tip>
          );
        })}
      </TabsPrimitive.List>
      <div className="min-w-0 flex-1">
        {TABS.map((t) => (
          <TabsPrimitive.Content
            key={t}
            value={t}
            tabIndex={-1}
            className="scrollbar-thin h-full overflow-y-auto overflow-x-hidden p-3 outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0"
          >
            <h2 className="mb-3 font-display text-md font-semibold">{META[t].label}</h2>
            {t === 'media' ? <MediaTab /> : null}
            {t === 'audio' ? <AudioTab /> : null}
            {t === 'text' ? <TextTab /> : null}
            {t === 'stickers' ? <StickersTab /> : null}
            {t === 'transitions' ? <TransitionsTab /> : null}
            {t === 'effects' ? <EffectsTab /> : null}
          </TabsPrimitive.Content>
        ))}
      </div>
    </TabsPrimitive.Root>
  );
}
