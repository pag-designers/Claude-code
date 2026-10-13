import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ToolRoute } from '@/components/tools/tool-route';
import { TOOL_ROUTE_IDS, isToolRouteId } from '@/lib/cp2-tools';

/**
 * One static page per standalone tool (/tools/summary/, /tools/subtitles/, …). The chosen library item travels in the
 * query string (`?video=<id>&clip=<id>`), because a static export has no dynamic data routes.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return TOOL_ROUTE_IDS.map((tool) => ({ tool }));
}

export default async function ToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  if (!isToolRouteId(tool)) notFound();
  return (
    <Suspense fallback={null}>
      <ToolRoute tool={tool} />
    </Suspense>
  );
}
