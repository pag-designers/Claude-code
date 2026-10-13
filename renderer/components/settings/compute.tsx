'use client';

import * as React from 'react';
import {
  Check,
  ChevronDown,
  Download,
  Layers,
  Package,
  Play,
  Rocket,
  Square,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { SidecarPhase, SidecarStatus } from '@shared/domain';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { PipelineStageCard, type StageStatus } from '@/components/ui/pipeline-stage-card';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useIpcMutation, useIpcQuery } from '@/lib/ipc';
import { useSidecarStatus } from '@/lib/queries';
import { useSettings, useUpdateSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { SettingRow, SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

const PHASE_LABEL: Record<SidecarPhase, string> = {
  idle: 'Not started',
  'locating-uv': 'Finding uv',
  'downloading-uv': 'Downloading uv',
  'creating-venv': 'Creating environment',
  'installing-packages': 'Installing packages',
  'downloading-model': 'Downloading model',
  starting: 'Starting',
  ready: 'Running',
  error: 'Error',
  stopped: 'Stopped',
};

const STAGES: {
  id: string;
  phases: SidecarPhase[];
  icon: LucideIcon;
  title: (m: string) => string;
  description: string;
}[] = [
  {
    id: 'uv',
    phases: ['locating-uv', 'downloading-uv'],
    icon: Package,
    title: () => 'Package manager',
    description: 'Locate or download uv',
  },
  {
    id: 'venv',
    phases: ['creating-venv'],
    icon: Layers,
    title: () => 'Python environment',
    description: 'Isolated, no system Python needed',
  },
  {
    id: 'pkgs',
    phases: ['installing-packages'],
    icon: Wrench,
    title: () => 'Install engine packages',
    description: 'faster-whisper, MediaPipe, PySceneDetect',
  },
  {
    id: 'model',
    phases: ['downloading-model'],
    icon: Download,
    title: (m) => `Download Whisper ${m}`,
    description: 'One-time model download',
  },
  {
    id: 'start',
    phases: ['starting', 'ready'],
    icon: Rocket,
    title: () => 'Start engine',
    description: 'Local server on 127.0.0.1',
  },
];
const ORDER: SidecarPhase[] = [
  'locating-uv',
  'downloading-uv',
  'creating-venv',
  'installing-packages',
  'downloading-model',
  'starting',
  'ready',
];

function stageStatus(idx: number, s: SidecarStatus): StageStatus {
  const stage = STAGES[idx]!;
  if (s.phase === 'ready') return 'done';
  if (stage.phases.includes(s.phase)) return 'active';
  const persisted =
    stage.id === 'start' ? false : stage.id === 'model' ? s.modelReady : s.installed;
  if (persisted) return 'done';
  const cur = ORDER.indexOf(s.phase);
  if (cur < 0) return 'pending';
  return Math.min(...stage.phases.map((p) => ORDER.indexOf(p))) < cur ? 'done' : 'pending';
}

function EngineCard() {
  const { data: s, isPending } = useSidecarStatus();
  const { settings } = useSettings();
  const [logOpen, setLogOpen] = React.useState(false);
  const fail = (title: string) => (e: Error) => toast.error(title, { description: e.message });
  const setup = useIpcMutation('sidecar:setup', {
    invalidate: ['sidecar:status', 'binaries:status'],
    onError: fail('Engine setup failed'),
  });
  const start = useIpcMutation('sidecar:start', {
    invalidate: ['sidecar:status'],
    onError: fail('Could not start the engine'),
  });
  const stop = useIpcMutation('sidecar:stop', {
    invalidate: ['sidecar:status'],
    onError: fail('Could not stop the engine'),
  });

  const busyPhases: SidecarPhase[] = [
    'locating-uv',
    'downloading-uv',
    'creating-venv',
    'installing-packages',
    'downloading-model',
    'starting',
  ];
  const working = !!s && busyPhases.includes(s.phase);
  const installedOk = !!s?.installed && !!s.modelReady;
  const running = s?.phase === 'ready';

  return (
    <SettingsCard
      title="Transcription engine"
      description="Local Whisper (faster-whisper) plus face tracking and scene detection. Free, private, runs on your machine."
      action={
        s ? (
          <Badge
            variant={
              running ? 'success' : s.phase === 'error' ? 'danger' : working ? 'primary' : 'neutral'
            }
            dot
          >
            {PHASE_LABEL[s.phase]}
          </Badge>
        ) : null
      }
    >
      {isPending || !s ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {s.phase === 'error' ? (
            <Banner tone="danger" title="Setup stopped with an error">
              {s.error ?? s.message}
            </Banner>
          ) : null}

          {working || setup.isPending ? (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">{s.message || PHASE_LABEL[s.phase]}</span>
                <span className="tabular-nums text-muted-foreground">
                  {s.progress === null ? '' : `${Math.round(s.progress * 100)}%`}
                </span>
              </div>
              <Progress
                value={s.progress === null ? null : s.progress * 100}
                aria-label="Engine setup progress"
              />
            </div>
          ) : null}

          {installedOk && !working && s.phase !== 'error' ? (
            <ul aria-label="Installed components" className="flex flex-wrap gap-2">
              {STAGES.map((st, i) => (
                <li
                  key={st.id}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  <Check
                    className={cn(
                      'size-3.5',
                      stageStatus(i, s) === 'done' ? 'text-success' : 'text-subtle',
                    )}
                    aria-hidden
                  />
                  {st.id === 'model'
                    ? `Whisper ${settings.whisperModel}`
                    : st.id === 'start'
                      ? 'Engine'
                      : st.title(settings.whisperModel)}
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {STAGES.map((st, i) => (
                <PipelineStageCard
                  key={st.id}
                  icon={st.icon}
                  title={st.title(settings.whisperModel)}
                  description={st.description}
                  status={stageStatus(i, s)}
                  progress={s.progress}
                  meta={
                    st.id === 'start' && s.port
                      ? `port ${s.port}`
                      : st.id === 'start' && s.device
                        ? s.device
                        : undefined
                  }
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            {!installedOk ? (
              <Button
                variant="primary"
                onClick={() => setup.mutate(undefined)}
                loading={setup.isPending || working}
              >
                {setup.isPending || working ? null : <Download />}{' '}
                {working || setup.isPending
                  ? 'Installing…'
                  : s.phase === 'error'
                    ? 'Retry setup'
                    : 'Install transcription engine'}
              </Button>
            ) : running ? (
              <Button
                variant="outline"
                onClick={() => stop.mutate(undefined)}
                loading={stop.isPending}
              >
                <Square /> Stop engine
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => start.mutate(undefined)}
                loading={start.isPending || working}
              >
                <Play /> Start engine
              </Button>
            )}
            {!installedOk ? (
              <span className="text-xs text-muted-foreground">
                Needs roughly 3 GB of disk and a few minutes the first time.
              </span>
            ) : null}
          </div>

          <div className="border-t pt-4">
            <button
              type="button"
              onClick={() => setLogOpen((o) => !o)}
              aria-expanded={logOpen}
              className="flex items-center gap-2 rounded-xs text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Terminal className="size-4" aria-hidden /> Engine log
              <ChevronDown
                className={cn(
                  'size-4 transition-transform duration-(--duration-base)',
                  logOpen && 'rotate-180',
                )}
                aria-hidden
              />
            </button>
            {logOpen ? (
              <pre
                className="selectable scrollbar-thin mt-3 max-h-56 overflow-auto rounded-lg border bg-field p-3 font-mono text-xs leading-5 text-muted-foreground"
                tabIndex={0}
                aria-label="Engine log output"
              >
                {s.logTail.length ? s.logTail.join('\n') : 'No log output yet.'}
              </pre>
            ) : null}
          </div>
        </>
      )}
    </SettingsCard>
  );
}

function HardwareCard() {
  const {
    data: h,
    isPending,
    isError,
  } = useIpcQuery('system:hardware', undefined, { staleTime: Infinity });
  return (
    <SettingsCard
      title="Your hardware"
      description="What Clipfern found. “Auto” picks the fastest option."
    >
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError || !h ? (
        <p className="text-sm text-danger">Could not read hardware details.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <div>
              <dt className="text-xs text-muted-foreground">Processor</dt>
              <dd className="mt-0.5 text-sm font-medium">{h.cpuModel}</dd>
              <dd className="text-xs text-subtle">
                {h.cpuCores} threads · {h.arch}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Memory</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums">
                {h.totalMemGb.toFixed(1)} GB
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Graphics</dt>
              <dd className="mt-0.5 text-sm font-medium">
                {h.gpu.kind === 'none'
                  ? 'No supported GPU found'
                  : (h.gpu.name ?? (h.gpu.kind === 'apple' ? 'Apple Silicon' : 'NVIDIA GPU'))}
              </dd>
              <dd className="text-xs text-subtle">
                {h.gpu.kind === 'nvidia'
                  ? `CUDA${h.gpu.vramMb ? ` · ${(h.gpu.vramMb / 1024).toFixed(0)} GB VRAM` : ''}`
                  : h.gpu.kind === 'apple'
                    ? 'Metal and VideoToolbox'
                    : 'Transcription will run on the CPU'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Video encoders</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {h.encoders.length ? (
                  h.encoders.map((e) => (
                    <Badge key={e} variant="outline" className="font-mono">
                      {e}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">Software x264 only</span>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
    </SettingsCard>
  );
}

export function ComputeSettings() {
  const { settings, ready } = useSettings();
  const { update } = useUpdateSettings();
  return (
    <>
      <SettingsHeading
        title="Compute"
        description="Where transcription and rendering run, and how many jobs run at once."
      />
      <HardwareCard />
      <SettingsCard title="Performance" description="Changes apply to the next job.">
        <SettingRow
          label="Processing device"
          description="Auto uses your GPU when one is available."
        >
          <Segmented
            label="Processing device"
            value={settings.computeDevice}
            disabled={!ready}
            onValueChange={(v) =>
              void update({ computeDevice: v }, { successMessage: `Device: ${v}` })
            }
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'gpu', label: 'GPU' },
              { value: 'cpu', label: 'CPU' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Whisper model"
          htmlFor="whisperModel"
          description="Larger is more accurate and slower. large-v3-turbo is the best balance."
        >
          <Select
            value={settings.whisperModel}
            disabled={!ready}
            onValueChange={(v) =>
              void update(
                { whisperModel: v as typeof settings.whisperModel },
                { successMessage: `Whisper model: ${v}` },
              )
            }
          >
            <SelectTrigger id="whisperModel" className="w-52 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'] as const).map(
                (m) => (
                  <SelectItem key={m} value={m} className="font-mono">
                    {m}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Concurrent jobs"
          htmlFor="concurrency"
          description="Higher is faster on strong machines and heavier on RAM."
        >
          <Select
            value={String(settings.concurrency)}
            disabled={!ready}
            onValueChange={(v) =>
              void update({ concurrency: Number(v) }, { successMessage: `Concurrency: ${v}` })
            }
          >
            <SelectTrigger id="concurrency" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} {n === 1 ? 'job' : 'jobs'} at a time
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsCard>
      <EngineCard />
    </>
  );
}
