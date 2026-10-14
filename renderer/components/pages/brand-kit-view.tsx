'use client';

import * as React from 'react';
import { Palette, Plus, RefreshCw } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetSection } from '@/components/brand/asset-sections';
import { ColorsSection } from '@/components/brand/colors-section';
import { DefaultsSection } from '@/components/brand/defaults-section';
import { HookSection } from '@/components/brand/hook-section';
import { IntroOutroSection } from '@/components/brand/intro-outro-section';
import { KitHeader, SaveBanners } from '@/components/brand/kit-header';
import { KitSwitcher } from '@/components/brand/kit-switcher';
import { MusicSection } from '@/components/brand/music-section';
import { NewKitDialog } from '@/components/brand/new-kit-dialog';
import { SectionNav } from '@/components/brand/section';
import { SubtitleStylesSection } from '@/components/brand/subtitle-styles-section';
import { TextStylesSection } from '@/components/brand/text-styles-section';
import { WatermarkSection } from '@/components/brand/watermark-section';
import { KitSessionProvider, useKitSession } from '@/lib/brand/kit-session';
import { useBrandKits } from '@/lib/brand/queries';
import { useKitActions, useSelectedKit } from '@/lib/brand/use-kits';

const scrollRoot = () => (typeof document === 'undefined' ? null : document.getElementById('main'));

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading brand kit">
      <Skeleton className="h-10 w-72" />
      <div className="grid grid-cols-[184px_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
        <div className="flex flex-col gap-2 max-[1100px]:hidden">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex flex-col gap-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Everything inside one kit: sticky header, save banners, section nav and the sections. */
function KitEditor({
  onDuplicate,
  onDelete,
  onMakeDefault,
}: {
  onDuplicate: () => void;
  onDelete: () => void;
  onMakeDefault: () => void;
}) {
  const s = useKitSession();
  const counts = {
    logos: s.byKind.logo.length,
    images: s.byKind.image.length,
    videos: s.byKind.video.length,
    audio: s.byKind.audio.length,
    fonts: s.byKind.font.length,
    colors: s.spec.colors.length,
    'text-styles': s.spec.textStyles.length,
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-20 -mx-8 flex flex-col gap-3 border-b bg-background/90 px-8 py-3 backdrop-blur-md">
        <KitHeader onDuplicate={onDuplicate} onDelete={onDelete} onMakeDefault={onMakeDefault} />
        <SaveBanners />
      </div>
      <div className="grid grid-cols-[184px_minmax(0,1fr)] items-start gap-6 max-[1100px]:grid-cols-1">
        <div className="sticky top-24 max-[1100px]:static max-[1100px]:z-10">
          <SectionNav counts={counts} scrollRoot={scrollRoot} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <AssetSection kind="logo" />
          <AssetSection kind="image" />
          <AssetSection kind="video" />
          <AssetSection kind="audio" />
          <AssetSection kind="font" />
          <ColorsSection />
          <SubtitleStylesSection />
          <TextStylesSection />
          <HookSection />
          <WatermarkSection />
          <IntroOutroSection />
          <MusicSection />
          <DefaultsSection />
        </div>
      </div>
    </div>
  );
}

export function BrandKitView() {
  const kitsQ = useBrandKits();
  const kits = kitsQ.data?.items;
  const [selectedId, select] = useSelectedKit(kits);
  const actions = useKitActions(select);
  const [newOpen, setNewOpen] = React.useState(false);
  const [delId, setDelId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const delKit = kits?.find((k) => k.id === delId) ?? null;

  const onCreate = async (name: string, copyFrom?: string) => {
    if (await actions.create(name, copyFrom)) setNewOpen(false);
  };

  return (
    <Page wide className="gap-5 py-6">
      <PageHeader
        title="Brand Kit"
        description="One kit per creator or campaign: logos, fonts, colors and caption styles for every clip."
        actions={
          kits && kits.length > 0 ? (
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus /> New brand kit
            </Button>
          ) : null
        }
      />

      {kitsQ.isPending ? (
        <div className="flex flex-col gap-5">
          <div className="flex gap-3" aria-busy="true" aria-label="Loading brand kits">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[84px] w-[252px] rounded-xl" />
            ))}
          </div>
          <EditorSkeleton />
        </div>
      ) : kitsQ.isError ? (
        <Banner
          tone="danger"
          title="Could not load your brand kits"
          action={
            <Button size="sm" variant="outline" onClick={() => void kitsQ.refetch()}>
              <RefreshCw /> Try again
            </Button>
          }
        >
          {kitsQ.error.message}
        </Banner>
      ) : kits && kits.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Palette}
            size="lg"
            title="Create your first Brand Kit"
            description="A kit holds your logo, fonts, colors and caption styles. Every clip you make picks them up automatically."
            steps={[
              'Create a kit and name it after the channel or campaign.',
              'Drop in your logo, fonts and brand colors.',
              'Set a watermark, caption style and defaults once, then reuse them everywhere.',
            ]}
            actions={
              <Button variant="primary" size="lg" onClick={() => setNewOpen(true)}>
                <Plus /> Create Brand Kit
              </Button>
            }
          />
        </div>
      ) : kits ? (
        <>
          <KitSwitcher
            kits={kits}
            selectedId={selectedId}
            onSelect={select}
            onNew={() => setNewOpen(true)}
            onMakeDefault={(id) =>
              void actions.makeDefault(id, kits.find((k) => k.id === id)?.name ?? '')
            }
            onDuplicate={(id) => void actions.duplicate(id)}
            onDelete={setDelId}
          />
          {selectedId ? (
            <KitSessionProvider
              key={selectedId}
              kitId={selectedId}
              loading={<EditorSkeleton />}
              error={(message, retry) => (
                <Banner
                  tone="danger"
                  title="Could not open this brand kit"
                  action={
                    <Button size="sm" variant="outline" onClick={retry}>
                      <RefreshCw /> Try again
                    </Button>
                  }
                >
                  {message}
                </Banner>
              )}
            >
              <KitEditor
                onDuplicate={() => void actions.duplicate(selectedId)}
                onDelete={() => setDelId(selectedId)}
                onMakeDefault={() =>
                  void actions.makeDefault(
                    selectedId,
                    kits.find((k) => k.id === selectedId)?.name ?? '',
                  )
                }
              />
            </KitSessionProvider>
          ) : null}
        </>
      ) : null}

      <NewKitDialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) actions.setCreateError(null);
        }}
        kits={kits ?? []}
        busy={actions.creating}
        error={actions.createError}
        onCreate={(n, c) => void onCreate(n, c)}
      />
      <ConfirmDialog
        open={delKit !== null}
        onOpenChange={(o) => !o && !deleting && setDelId(null)}
        title={`Delete “${delKit?.name ?? ''}”?`}
        description={
          <>
            The kit, its uploaded files and its subtitle styles are removed for good. Clips and
            projects that use it fall back to no branding until you pick another kit.
            {delKit?.isDefault
              ? ' It is your default kit, so new projects will have no default until you star another.'
              : ''}
          </>
        }
        confirmLabel="Delete kit"
        loading={deleting}
        onConfirm={async () => {
          if (!delKit) return;
          setDeleting(true);
          const ok = await actions.remove(delKit.id, delKit.name);
          setDeleting(false);
          if (ok) setDelId(null);
        }}
      />
    </Page>
  );
}
