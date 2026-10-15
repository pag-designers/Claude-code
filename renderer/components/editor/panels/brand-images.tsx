'use client';

import * as React from 'react';
import { ImageIcon, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { BrandAssetView } from '@shared/brand';
import { Badge } from '@/components/ui/badge';
import { groupBrandAssets, imageRole } from '@/lib/editor-panels/brand';
import { useBrandPanelKit } from '@/lib/editor-panels/brand-hooks';
import { startAssetDrag } from '@/lib/editor-panels/drag';
import { brandProjectAssetId } from '@shared/brand-apply';
import { cn } from '@/lib/utils';
import { addBrandImage, ensureBrandAsset } from './brand-actions';
import { BrandSection } from './brand-bits';
import { tileBase } from './bits';

function BrandImageTile({ asset, watermark }: { asset: BrandAssetView; watermark: boolean }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <li className="min-w-0">
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          // the drop target needs a project asset id, so the asset is created the moment the drag starts
          const a = ensureBrandAsset(asset, { defer: true });
          startAssetDrag(e.dataTransfer, a.id, a.name);
        }}
        onClick={() => {
          if (addBrandImage(asset)) toast.success(`${asset.name} added at the playhead`);
        }}
        aria-label={`Add ${asset.name} at the playhead`}
        title="Click to add at the playhead, or drag to the timeline"
        data-testid="bin-brand-image"
        data-asset-id={asset.id}
        data-project-asset-id={brandProjectAssetId(asset.id)}
        className={cn(tileBase, 'w-full cursor-grab active:cursor-grabbing')}
      >
        <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-muted">
          {asset.thumbUrl && !failed ? (
            <img
              src={asset.thumbUrl}
              alt=""
              loading="lazy"
              draggable={false}
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="size-full object-contain p-1.5"
            />
          ) : (
            <ImageIcon className="size-6 text-muted-foreground" aria-hidden />
          )}
          {watermark ? (
            <Badge variant="primary" className="absolute left-1 top-1 h-4 px-1.5">
              Watermark
            </Badge>
          ) : null}
          <span className="pointer-events-none absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100">
            <Plus className="size-3" aria-hidden />
          </span>
        </span>
        <span className="block truncate px-0.5 text-center text-2xs font-medium">{asset.name}</span>
      </button>
    </li>
  );
}

/** Stickers tab: the kit's logos and images (stickers, CTA graphics, end cards), click or drag to use. */
export function BrandImagesSection() {
  const panel = useBrandPanelKit();
  const images = React.useMemo(() => groupBrandAssets(panel.assets).images, [panel.assets]);
  return (
    <BrandSection
      title="Brand Kit images"
      testId="bin-brandkit-images"
      panel={panel}
      isEmpty={images.length === 0}
      emptyTitle="No images in this kit"
      emptyHint="Upload logos, stickers or end cards in the kit and they show up here."
    >
      <ul className="grid grid-cols-2 gap-2" aria-label="Brand Kit images">
        {images.map((a) => (
          <BrandImageTile
            key={a.id}
            asset={a}
            watermark={!!panel.kit && imageRole(panel.kit, a.id) === 'watermark'}
          />
        ))}
      </ul>
      <p className="text-2xs leading-4 text-subtle">
        Click adds it at the playhead, about 42 % of the canvas wide; resize it in the inspector.
        Drag to drop it on a track yourself.
      </p>
    </BrandSection>
  );
}
