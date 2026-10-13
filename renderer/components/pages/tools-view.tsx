'use client';

import Link from 'next/link';
import { ArrowRight, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Page, PageHeader, SectionTitle } from '@/components/ui/page';
import { DisabledTip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { TOOLS, isToolAvailable, toolHint, type Tool, type ToolGroup } from '@/lib/tools';

const GROUPS: { id: ToolGroup; title: string; description: string }[] = [
  {
    id: 'Clip',
    title: 'Find and cut',
    description: 'Turn long videos and streams into short clips.',
  },
  {
    id: 'Polish',
    title: 'Edit and enhance',
    description: 'Reframe, caption, hook and finish each clip.',
  },
  {
    id: 'Understand',
    title: 'Understand a video',
    description: 'Summaries and transcripts you can search and export.',
  },
  { id: 'Later', title: 'Later', description: 'On the roadmap, not part of the first release.' },
];

const cardBase =
  'flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-xs';

function ToolCard({ tool }: { tool: Tool }) {
  const available = isToolAvailable(tool);
  const later = tool.group === 'Later';
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'flex size-10 items-center justify-center rounded-lg',
            available ? 'bg-primary-soft text-primary-text' : 'bg-muted text-subtle',
          )}
        >
          <tool.icon className="size-5" aria-hidden />
        </span>
        {available ? null : (
          <Badge variant="outline">
            <Lock aria-hidden /> {later ? 'Later' : 'Coming later'}
          </Badge>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-display text-md font-semibold">{tool.name}</p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{tool.description}</p>
      </div>
      {available ? (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-primary-text">
          Open{' '}
          <ArrowRight
            className="size-3.5 transition-transform duration-(--duration-fast) group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      ) : null}
    </>
  );
  return (
    <li data-testid="tool-card" data-tool={tool.id} data-available={available}>
      {available ? (
        <Link
          href={tool.href!}
          className={cn(
            cardBase,
            'group outline-none transition-[border-color,box-shadow,transform] duration-(--duration-base) ease-(--ease-standard)',
            'hover:-translate-y-px hover:border-border-strong hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {inner}
        </Link>
      ) : (
        <DisabledTip reason={toolHint(tool)} className="flex h-full w-full">
          <div aria-disabled="true" className={cn(cardBase, later ? 'opacity-55' : 'opacity-70')}>
            {inner}
          </div>
        </DisabledTip>
      )}
    </li>
  );
}

export function ToolsView() {
  return (
    <Page>
      <PageHeader
        title="Tools"
        description="Every Clipfern tool in one place. Each one can also be launched standalone on any item in your library."
      />
      {GROUPS.map((g) => (
        <section key={g.id} aria-label={g.title} className="flex flex-col gap-4">
          <SectionTitle title={g.title} description={g.description} />
          <ul className="grid grid-cols-4 gap-4 max-[1280px]:grid-cols-3 max-[1000px]:grid-cols-2">
            {TOOLS.filter((t) => t.group === g.id)
              .sort((a, b) => Number(isToolAvailable(b)) - Number(isToolAvailable(a)))
              .map((t) => (
                <ToolCard key={t.id} tool={t} />
              ))}
          </ul>
        </section>
      ))}
    </Page>
  );
}
