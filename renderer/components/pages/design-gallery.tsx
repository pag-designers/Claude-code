'use client';

import * as React from 'react';
import { Cpu, Download, FolderOpen, Layers, Scissors, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { SecretStatus } from '@shared/secrets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Page, PageHeader, SectionTitle } from '@/components/ui/page';
import { PipelineStageCard } from '@/components/ui/pipeline-stage-card';
import { Progress } from '@/components/ui/progress';
import { ProgressRing } from '@/components/ui/progress-ring';
import { ScoreBadge, ScoreChip } from '@/components/ui/score-badge';
import { SecretInput } from '@/components/ui/secret-input';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tip } from '@/components/ui/tooltip';

const SWATCHES = [
  ['background', 'bg-background'],
  ['card', 'bg-card'],
  ['raised', 'bg-raised'],
  ['muted', 'bg-muted'],
  ['accent', 'bg-accent'],
  ['primary', 'bg-primary'],
  ['primary-soft', 'bg-primary-soft'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['info', 'bg-info'],
  ['viral', 'bg-viral'],
] as const;

/** Internal reference page (not in navigation). Shows every design-system primitive with its states. */
export function DesignGallery() {
  const [secret, setSecret] = React.useState<SecretStatus>({
    set: false,
    masked: null,
    source: null,
  });
  const [score, setScore] = React.useState(0);
  return (
    <Page>
      <PageHeader
        title="Design system"
        description="Tokens and primitives used across Clipfern. Documented in renderer/DESIGN.md."
        eyebrow="Internal reference"
      />

      <section className="flex flex-col gap-4">
        <SectionTitle title="Color tokens" />
        <div className="grid grid-cols-6 gap-3">
          {SWATCHES.map(([n, cls]) => (
            <div key={n} className="overflow-hidden rounded-lg border">
              <div className={`h-14 ${cls}`} />
              <p className="px-2.5 py-1.5 font-mono text-2xs text-muted-foreground">{n}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="Typography" />
        <Card className="flex flex-col gap-2 p-6">
          <p className="font-display text-5xl font-semibold">Display 48 · Space Grotesk</p>
          <p className="font-display text-3xl font-semibold">Heading 30 · Clips worth posting</p>
          <p className="font-display text-xl font-semibold">Title 20 · Setup checklist</p>
          <p className="text-md">
            Body 15 · Inter. The quick brown fox jumps over the lazy dog 0123456789.
          </p>
          <p className="text-base text-muted-foreground">
            Base 14 · The default interface size for dense desktop UI.
          </p>
          <p className="text-sm text-muted-foreground">
            Small 13 · Secondary labels and helper text.
          </p>
          <p className="text-xs text-subtle">Caption 12 · Hints and metadata</p>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title="Virality score"
          description="Tier colours: 0–49 muted, 50–74 amber, 75–89 green, 90+ viral gradient with glow."
        />
        <Card className="flex flex-wrap items-start gap-10 p-6">
          {[32, 61, 83, 94].map((s) => (
            <ScoreBadge key={s} score={s} size={72} showLabel />
          ))}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {[32, 61, 83, 94].map((s) => (
                <ScoreChip key={s} score={s} />
              ))}
            </div>
            <Button size="sm" onClick={() => setScore((n) => n + 1)}>
              Replay reveal
            </Button>
            <ScoreBadge key={score} score={96} size={56} />
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="Buttons, badges, inputs" />
        <Card className="flex flex-col gap-6 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="soft">Soft</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="primary" loading>
              Loading
            </Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
            <Tip content="Tooltip content">
              <Button variant="outline">Hover me</Button>
            </Tip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Neutral</Badge>
            <Badge variant="primary">Primary</Badge>
            <Badge variant="success" dot>
              Success
            </Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="danger">Danger</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="outline">Outline</Badge>
            <Kbd keys={['mod', 'K']} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Input placeholder="Default input" aria-label="Default input" />
            <Input placeholder="Invalid input" aria-label="Invalid input" invalid />
            <Select defaultValue="a">
              <SelectTrigger aria-label="Select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a">Option A</SelectItem>
                <SelectItem value="b">Option B</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Switch defaultChecked aria-label="Switch on" />
            <Switch aria-label="Switch off" />
            <Segmented
              label="Demo"
              value="b"
              onValueChange={() => {}}
              options={[
                { value: 'a', label: 'One' },
                { value: 'b', label: 'Two' },
                { value: 'c', label: 'Three' },
              ]}
            />
            <Tabs defaultValue="x">
              <TabsList>
                <TabsTrigger value="x">Tab one</TabsTrigger>
                <TabsTrigger value="y">Tab two</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              onClick={() =>
                toast.success('Toast looks like this', {
                  description: 'Supporting detail goes here.',
                })
              }
            >
              Show toast
            </Button>
          </div>
          <SecretInput
            id="demo-secret"
            label="Secret input (local demo, nothing is stored)"
            status={secret}
            onSave={async (v) =>
              setSecret({ set: true, masked: `••••${v.slice(-4)}`, source: 'store' })
            }
            onClear={async () => setSecret({ set: false, masked: null, source: null })}
            onTest={async () => ({
              ok: true,
              message: 'Demo result',
              latencyMs: 142,
              detail: null,
            })}
          />
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="Progress, ring, skeleton, stat cards" />
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="Stat card"
            value="128"
            hint="Helper text under the number"
            icon={Scissors}
          />
          <StatCard label="Loading" value="" loading icon={Layers} />
          <Card className="flex items-center justify-around p-4">
            <ProgressRing value={0.34} size={56} stroke={5}>
              <span className="text-xs font-semibold">34</span>
            </ProgressRing>
            <ProgressRing value={0.86} size={56} stroke={5} tone="warning">
              <span className="text-xs font-semibold">86</span>
            </ProgressRing>
            <ProgressRing value={0} size={56} stroke={5} dashed />
          </Card>
          <Card className="flex flex-col justify-center gap-3 p-4">
            <Progress value={62} aria-label="Determinate" />
            <Progress value={null} aria-label="Indeterminate" />
            <Skeleton className="h-4 w-2/3" />
          </Card>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <PipelineStageCard
            icon={Download}
            title="Download"
            description="Done in 41 s"
            status="done"
          />
          <PipelineStageCard
            icon={Cpu}
            title="Transcribe"
            description="Word-level timestamps"
            status="active"
            progress={0.42}
            meta="42%"
          />
          <PipelineStageCard
            icon={Sparkles}
            title="Find moments"
            description="Waiting"
            status="pending"
          />
          <PipelineStageCard
            icon={Scissors}
            title="Render"
            description="Encoder not found"
            status="error"
          />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="Empty state" />
        <Card>
          <EmptyState
            icon={FolderOpen}
            title="Nothing here yet"
            description="Empty states explain what will appear and offer the next step."
            actions={<Button variant="primary">Primary action</Button>}
          />
        </Card>
      </section>
    </Page>
  );
}
