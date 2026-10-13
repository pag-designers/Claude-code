'use client';

import * as React from 'react';
import {
  AudioLines,
  Film,
  ImageIcon,
  Palette,
  Plus,
  Sliders,
  Stamp,
  Subtitles,
  Type,
  UploadCloud,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Switch } from '@/components/ui/switch';
import { DisabledTip } from '@/components/ui/tooltip';

const LOCKED = 'Brand Kit arrives in checkpoint 4';

function UploadPanel({ formats, label }: { formats: string; label: string }) {
  return (
    <DisabledTip reason={LOCKED} className="block w-full" side="top">
      <div
        role="button"
        aria-disabled="true"
        aria-label={`${label}: drop a file here, or browse`}
        className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-border-strong bg-muted/30 px-4 py-6 text-center opacity-80"
      >
        <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <UploadCloud className="size-[18px]" aria-hidden />
        </span>
        <p className="text-sm font-medium text-foreground">
          Drop a file here, or{' '}
          <span className="text-primary-text underline underline-offset-2">browse</span>.
        </p>
        <p className="text-xs text-muted-foreground">{formats}</p>
      </div>
    </DisabledTip>
  );
}

function Section({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div>
          <CardTitle className="font-display text-lg">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

function AddButton({ children }: { children: React.ReactNode }) {
  return (
    <DisabledTip reason={LOCKED}>
      <Button variant="outline" disabled>
        <Plus /> {children}
      </Button>
    </DisabledTip>
  );
}

const DEFAULTS = [
  'Aspect ratio',
  'Caption preset',
  'Hook style',
  'Target platforms',
  'Hashtag sets',
  'Posting-time windows',
];

export function BrandKitView() {
  return (
    <Page>
      <PageHeader
        title="Brand Kit"
        description="One kit per creator or campaign: logos, fonts, colours and caption styles that every clip picks up automatically."
        actions={
          <>
            <DisabledTip reason={LOCKED}>
              <Badge variant="outline" className="h-9 rounded-md px-3 text-sm">
                Default kit
              </Badge>
            </DisabledTip>
            <AddButton>New brand kit</AddButton>
          </>
        }
      />
      <div className="grid grid-cols-2 items-start gap-5 max-[1180px]:grid-cols-1">
        <Section
          icon={Stamp}
          title="Logos & watermarks"
          description="Position, opacity and size, kept inside platform safe areas."
        >
          <UploadPanel label="Logos" formats="Supported: PNG, SVG" />
        </Section>
        <Section
          icon={ImageIcon}
          title="Images"
          description="Stickers, call-to-action graphics and end cards."
        >
          <UploadPanel label="Images" formats="Supported: PNG, JPG, WEBP, SVG, GIF" />
        </Section>
        <Section
          icon={Film}
          title="Videos"
          description="Intros, outros, transitions and B-roll packs."
        >
          <UploadPanel label="Videos" formats="Supported: MP4, MOV, WEBM" />
        </Section>
        <Section
          icon={AudioLines}
          title="Audio"
          description="Music beds, sound effects and stingers, loudness-normalised."
        >
          <UploadPanel label="Audio" formats="Supported: MP3, WAV, AAC, M4A" />
        </Section>
        <Section
          icon={Type}
          title="Fonts"
          description="Registered for the editor canvas and for caption rendering."
        >
          <UploadPanel label="Fonts" formats="Supported: TTF, OTF, WOFF, WOFF2" />
        </Section>
        <Section
          icon={Palette}
          title="Colors"
          description="Named swatches and palette groups, or extract them from a logo."
        >
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              No colors yet. Swatches you add here become choices in caption and text styles.
            </p>
            <AddButton>Add colors</AddButton>
          </div>
        </Section>
        <Section
          icon={Subtitles}
          title="Subtitle styles"
          description="Presets built from a live preview: font, stroke, highlight, animation."
        >
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              The default “Clean Pop” style arrives with the caption engine, alongside 13 other
              editable presets.
            </p>
            <AddButton>Add subtitle styles</AddButton>
          </div>
        </Section>
        <Section
          icon={Type}
          title="Text styles"
          description="Title, hook and call-to-action presets with entrance animations."
        >
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              No text styles yet. Hook title cards pick their look from here.
            </p>
            <AddButton>Add text styles</AddButton>
          </div>
        </Section>
        <Section
          icon={Sliders}
          title="Defaults"
          description="What a new project starts with when this kit is selected."
          className="col-span-2 max-[1180px]:col-span-1"
        >
          <ul className="grid grid-cols-3 gap-3 max-[1180px]:grid-cols-2">
            {DEFAULTS.map((d) => (
              <li
                key={d}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3.5 py-2.5 opacity-70"
              >
                <span className="text-sm font-medium">{d}</span>
                <span className="text-xs text-subtle">Not set</span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3.5 py-2.5 opacity-70">
              <span className="text-sm font-medium">Watermark on by default</span>
              <Switch disabled aria-label="Watermark on by default" />
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3.5 py-2.5 opacity-70">
              <span className="text-sm font-medium">Intro and outro</span>
              <Switch disabled aria-label="Intro and outro" />
            </li>
          </ul>
        </Section>
      </div>
    </Page>
  );
}
