'use client';

import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Page, PageHeader, SectionTitle } from '@/components/ui/page';
import { DisabledTip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { TOOLS, toolHint, type Tool, type ToolGroup } from '@/lib/tools';

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

function ToolCard({ tool }: { tool: Tool }) {
  const later = tool.checkpoint === null;
  return (
    <li>
      <DisabledTip reason={toolHint(tool)} className="block w-full">
        <div
          aria-disabled="true"
          className={cn(
            'flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left',
            later ? 'opacity-55' : 'opacity-90',
          )}
        >
          <div className="flex items-center justify-between">
            <span
              className={cn(
                'flex size-10 items-center justify-center rounded-lg',
                later ? 'bg-muted text-subtle' : 'bg-primary-soft text-primary-text',
              )}
            >
              <tool.icon className="size-5" aria-hidden />
            </span>
            {later ? (
              <Badge variant="outline">
                <Lock /> Later
              </Badge>
            ) : (
              <Badge variant="neutral">Checkpoint {tool.checkpoint}</Badge>
            )}
          </div>
          <div>
            <p className="font-display text-md font-semibold">{tool.name}</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{tool.description}</p>
          </div>
        </div>
      </DisabledTip>
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
            {TOOLS.filter((t) => t.group === g.id).map((t) => (
              <ToolCard key={t.id} tool={t} />
            ))}
          </ul>
        </section>
      ))}
    </Page>
  );
}
