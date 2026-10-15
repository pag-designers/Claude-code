'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarClock,
  CircleAlert,
  Download,
  FolderOpen,
  Info,
  Play,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ExportJob, ExportPresetId, ExportSettings } from '@shared/editor';
import { projectDuration } from '@shared/editor-eval';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Segmented } from '@/components/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { SchedulePostDialog } from '@/components/scheduler';
import { useEditorStore } from '@/lib/editor/core';
import {
  AUDIO_KBPS_CHOICES,
  FILENAME_TOKENS,
  FPS_CHOICES,
  LOUDNESS_CHOICES,
  PRESET_IDS,
  aspectLabel,
  applyPreset,
  describeSize,
  durationWarning,
  editSettings,
  estimateVideoKbps,
  hasErrors,
  loadSettings,
  presetLabel,
  qualityLabel,
  renderFilename,
  saveSettings,
  validateExport,
  type ExportIssue,
} from '@/lib/editor-panels/export-logic';
import { EXPORT_PRESETS } from '@shared/editor';
import { formatBytes, formatClock } from '@/lib/format';
import { libraryHref } from '@/lib/hrefs';
import { invoke, IpcCallError, useIpcQuery } from '@/lib/ipc';
import {
  EXPORTS_PAYLOAD,
  isActiveExport,
  useExportEvents,
  useExportUrl,
} from '@/lib/editor-panels/projects';
import { cn } from '@/lib/utils';
import { GroupLabel } from './bits';

/* --------------------------------------------------------------------------------- small fields */

/** Integer field that lets you type freely and only commits valid numbers; reverts on blur. */
function NumField({
  value,
  onCommit,
  label,
  suffix,
  invalid,
  className,
  testId,
}: {
  value: number;
  onCommit: (n: number) => void;
  label: string;
  suffix?: string;
  invalid?: boolean;
  className?: string;
  testId?: string;
}) {
  const [text, setText] = React.useState(String(value));
  const [lastValue, setLastValue] = React.useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={text}
      aria-label={label}
      invalid={invalid}
      trailing={suffix ? <span className="pr-1.5 text-2xs text-subtle">{suffix}</span> : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(Math.round(n));
      }}
      onBlur={() => setText(String(value))}
      className={cn('h-8 tabular-nums', className)}
      data-testid={testId}
    />
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  const id = React.useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

function PresetGlyph({ id }: { id: ExportPresetId }) {
  if (id === 'custom')
    return <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />;
  const p = EXPORT_PRESETS[id];
  const h = 22;
  const w = Math.max(10, Math.round((h * p.width) / p.height));
  return (
    <span
      aria-hidden
      className="rounded-[3px] border-[1.5px] border-current opacity-80"
      style={{ width: w, height: h }}
    />
  );
}

const ISSUE_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const ISSUE_TONE = { error: 'text-danger', warning: 'text-warning', info: 'text-info' } as const;

function Issues({ issues }: { issues: ExportIssue[] }) {
  const shown = issues.filter((i) => i.field !== 'project' || i.level !== 'error');
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Export checks" data-testid="export-issues">
      {shown.map((i, k) => {
        const Icon = ISSUE_ICON[i.level];
        return (
          <li
            key={`${i.field}-${k}`}
            data-level={i.level}
            data-field={i.field}
            role={i.level === 'error' ? 'alert' : undefined}
            className="flex items-start gap-2 text-xs leading-4 text-muted-foreground"
          >
            <Icon className={cn('mt-px size-3.5 shrink-0', ISSUE_TONE[i.level])} aria-hidden />
            <span>{i.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------- status */

function ResultView({
  job,
  onShowLibrary,
  onAgain,
}: {
  job: ExportJob;
  onShowLibrary: () => void;
  onAgain: () => void;
}) {
  const thumb = useExportUrl(job.id, 'thumb', job.hasThumb);
  const [playing, setPlaying] = React.useState(false);
  const video = useExportUrl(job.id, 'video', playing && job.hasFile);
  const [saving, setSaving] = React.useState(false);

  const download = async () => {
    setSaving(true);
    try {
      const r = await invoke('exports:download', { ids: [job.id] });
      if (!r.canceled && r.saved > 0)
        toast.success('Export saved', { description: r.dir ?? undefined });
    } catch (e) {
      toast.error('Could not save the export', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="export-done">
      <Banner tone="success" title="Export finished">
        {job.sizeBytes !== null ? formatBytes(job.sizeBytes) : 'Ready'}
        {job.durationSec !== null ? ` · ${formatClock(job.durationSec)}` : ''}
      </Banner>
      <div
        className="relative mx-auto aspect-[9/16] max-h-[250px] overflow-hidden rounded-xl border bg-black"
        style={{ aspectRatio: `${job.settings.width} / ${job.settings.height}` }}
      >
        {playing && video.data?.url ? (
          <video
            src={video.data.url}
            controls
            autoPlay
            playsInline
            data-testid="export-preview-video"
            className="size-full object-contain"
          />
        ) : (
          <>
            {thumb.data?.url ? (
              <img
                src={thumb.data.url}
                alt="Preview of the exported video"
                data-testid="export-thumb"
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full items-center justify-center text-white/70">
                <Play className="size-6" aria-hidden />
              </div>
            )}
            {job.hasFile ? (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                aria-label="Play the exported video"
                className="absolute inset-0 flex items-center justify-center bg-black/20 text-white opacity-0 outline-none transition-opacity duration-(--duration-fast) hover:opacity-100 focus-visible:opacity-100"
              >
                <span className="flex size-11 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
                  <Play className="size-5 fill-current" aria-hidden />
                </span>
              </button>
            ) : null}
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="primary" onClick={onShowLibrary} data-testid="export-show-library">
          <FolderOpen /> Show in Library → Exported
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            loading={saving}
            onClick={() => void download()}
          >
            <Download /> Save a copy
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1"
            onClick={onAgain}
            data-testid="export-again"
          >
            <RotateCcw /> Export again
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------- the panel */

export function ExportPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const projectId = useEditorStore((s) => s.projectId);
  const projectName = useEditorStore((s) => s.name);
  const canvas = useEditorStore((s) => s.project.canvas);
  const durationSec = useEditorStore((s) => projectDuration(s.project));
  const hasSubtitles = useEditorStore((s) =>
    s.project.tracks.some((t) => t.items.some((i) => i.type === 'subtitle')),
  );

  const canvasRef = React.useRef(canvas);
  React.useEffect(() => {
    canvasRef.current = canvas;
  });

  const [settings, setSettings] = React.useState<ExportSettings>(() => loadSettings(canvas));
  // reload the remembered settings each time the panel opens (the canvas may have changed since)
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) setSettings(loadSettings(canvasRef.current));
    wasOpen.current = open;
  }, [open]);
  const update = (next: ExportSettings) => {
    setSettings(next);
    saveSettings(next);
  };
  const patch = (p: Partial<ExportSettings>) => update(editSettings(settings, p));

  /* run state */
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [canceling, setCanceling] = React.useState(false);
  const [live, setLive] = React.useState<Record<string, ExportJob>>({});
  useExportEvents((j) => setLive((prev) => ({ ...prev, [j.id]: j })));

  // rejoin an export that is still rendering when the panel is (re)opened
  const list = useIpcQuery('exports:list', EXPORTS_PAYLOAD, {
    enabled: open && !!projectId,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const adopted =
    !runId && !starting && projectId
      ? list.data?.items.find((j) => j.projectId === projectId && isActiveExport(j))
      : undefined;
  const activeId = runId ?? adopted?.id ?? null;

  const job: ExportJob | undefined = activeId
    ? (live[activeId] ?? list.data?.items.find((j) => j.id === activeId))
    : undefined;
  const running = starting || (!!job && isActiveExport(job)) || (!!activeId && !job);
  const locked = running || !!job;

  /* "Export & Schedule": export first, then open the schedule dialog with the finished export */
  const [scheduleAfter, setScheduleAfter] = React.useState(false);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  if (scheduleAfter && job?.status === 'done') {
    setScheduleAfter(false);
    setScheduleOpen(true);
  } else if (
    scheduleAfter &&
    (startError || job?.status === 'failed' || job?.status === 'canceled')
  ) {
    setScheduleAfter(false);
  }

  const issues = React.useMemo(
    () => validateExport(settings, { durationSec, canvas, hasSubtitles }),
    [settings, durationSec, canvas, hasSubtitles],
  );
  const blocked = hasErrors(issues);
  const emptyTimeline = !(durationSec > 0);

  const start = async () => {
    if (!projectId || blocked || starting) return;
    setStartError(null);
    setStarting(true);
    setCanceling(false);
    setRunId(null);
    try {
      // the exporter renders the SAVED project, so flush pending edits first
      await useEditorStore.getState().saveNow();
      const state = useEditorStore.getState().saveState;
      if (state === 'error' || state === 'conflict')
        throw new Error(
          state === 'conflict'
            ? 'This project was changed in another window. Reload it before exporting.'
            : 'The latest edits could not be saved, so they would be missing from the export.',
        );
      const r = await invoke('editor:export', { projectId, settings });
      setRunId(r.exportId);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'The export could not be started.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!activeId) return;
    setCanceling(true);
    try {
      await invoke('editor:exportCancel', { id: activeId });
    } catch (e) {
      setCanceling(false);
      toast.error('Could not cancel the export', {
        description: e instanceof IpcCallError ? e.message : undefined,
      });
    }
  };

  const reset = () => {
    setRunId(null);
    setStartError(null);
    setCanceling(false);
  };

  const showLibrary = () => {
    onOpenChange(false);
    router.push(libraryHref('exported'));
  };

  const name = renderFilename(settings.filenameTemplate, {
    title: projectName,
    preset: settings.preset,
    date: new Date(),
    n: 1,
  });
  const videoKbps = estimateVideoKbps(settings);
  const progress = job?.progress ?? null;
  const exAspect = aspectLabel(settings.width, settings.height);
  const limitWarn = durationWarning(settings.preset, durationSec);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,780px)] max-h-none max-w-[940px]"
        data-testid="export-panel"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold">Export</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {projectName || 'Untitled project'} · {formatClock(durationSec)} · canvas{' '}
            {aspectLabel(canvas.width, canvas.height)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex min-h-0 gap-0 p-0 max-[820px]:flex-col">
          <fieldset
            disabled={locked}
            className="scrollbar-thin flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6 disabled:opacity-60"
            aria-label="Export settings"
          >
            {/* platform presets */}
            <section className="flex flex-col gap-2.5" aria-label="Platform preset">
              <GroupLabel>Platform</GroupLabel>
              <div
                role="radiogroup"
                aria-label="Platform preset"
                className="grid grid-cols-3 gap-2"
              >
                {PRESET_IDS.map((id) => {
                  const active = settings.preset === id;
                  const p = id === 'custom' ? null : EXPORT_PRESETS[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid="export-preset"
                      data-preset={id}
                      onClick={() => update(applyPreset(settings, id, canvas))}
                      className={cn(
                        'flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none transition-[border-color,background-color] duration-(--duration-fast)',
                        'hover:border-border-strong hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'border-primary bg-primary-soft text-primary-text hover:border-primary'
                          : 'text-foreground',
                      )}
                    >
                      <span className="flex w-6 shrink-0 justify-center">
                        <PresetGlyph id={id} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold">
                          {presetLabel(id)}
                        </span>
                        <span className="block truncate text-2xs tabular-nums opacity-75">
                          {p ? `${p.width}×${p.height}` : 'Your numbers'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {limitWarn ? (
                <Banner
                  tone="warning"
                  className="py-2 text-xs"
                  title="Longer than the platform allows"
                >
                  <span data-testid="export-duration-warning">{limitWarn}</span>
                </Banner>
              ) : null}
            </section>

            {/* video */}
            <section className="flex flex-col gap-3" aria-label="Video">
              <GroupLabel>Video</GroupLabel>
              <div className="grid grid-cols-[1fr_auto_1fr_120px] items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Width</Label>
                  <NumField
                    value={settings.width}
                    onCommit={(n) => patch({ width: n })}
                    label="Width in pixels"
                    suffix="px"
                    invalid={issues.some((i) => i.field === 'size' && i.level === 'error')}
                    testId="export-width"
                  />
                </div>
                <span className="pb-1.5 text-subtle" aria-hidden>
                  ×
                </span>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Height</Label>
                  <NumField
                    value={settings.height}
                    onCommit={(n) => patch({ height: n })}
                    label="Height in pixels"
                    suffix="px"
                    invalid={issues.some((i) => i.field === 'size' && i.level === 'error')}
                    testId="export-height"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Frame rate</Label>
                  <Select
                    value={String(settings.fps)}
                    onValueChange={(v) => patch({ fps: Number(v) })}
                  >
                    <SelectTrigger className="h-8" aria-label="Frame rate" data-testid="export-fps">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...new Set<number>([...FPS_CHOICES, settings.fps])]
                        .sort((a, b) => a - b)
                        .map((f) => (
                          <SelectItem key={f} value={String(f)}>
                            {f} fps
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">Rate control</Label>
                  <Segmented<ExportSettings['rateMode']>
                    label="Rate control"
                    size="sm"
                    value={settings.rateMode}
                    onValueChange={(v) => update({ ...settings, rateMode: v })}
                    options={[
                      { value: 'quality', label: 'Quality' },
                      { value: 'bitrate', label: 'Bitrate' },
                    ]}
                  />
                </div>
                {settings.rateMode === 'quality' ? (
                  <div className="flex items-center gap-3">
                    <Slider
                      value={settings.quality}
                      onValueChange={(v) => update({ ...settings, quality: v })}
                      min={0}
                      max={100}
                      step={1}
                      aria-label="Quality"
                      className="flex-1"
                      data-testid="export-quality"
                    />
                    <span
                      className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                      data-testid="export-quality-label"
                    >
                      {settings.quality} · {qualityLabel(settings.quality)}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <NumField
                      value={settings.videoKbps}
                      onCommit={(n) => patch({ videoKbps: n })}
                      label="Video bitrate in kilobits per second"
                      suffix="kbps"
                      invalid={issues.some((i) => i.field === 'bitrate')}
                      className="w-36"
                      testId="export-bitrate"
                    />
                    <span className="text-xs text-muted-foreground">
                      {(settings.videoKbps / 1000).toFixed(1)} Mbps video
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* audio */}
            <section className="flex flex-col gap-3" aria-label="Audio">
              <GroupLabel>Audio</GroupLabel>
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Audio bitrate</Label>
                <Select
                  value={String(settings.audioKbps)}
                  onValueChange={(v) => update({ ...settings, audioKbps: Number(v) })}
                >
                  <SelectTrigger
                    className="h-8 w-36"
                    aria-label="Audio bitrate"
                    data-testid="export-audio-kbps"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set<number>([...AUDIO_KBPS_CHOICES, settings.audioKbps])]
                      .sort((a, b) => a - b)
                      .map((k) => (
                        <SelectItem key={k} value={String(k)}>
                          {k} kbps
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-xs">Loudness target</Label>
                <div
                  role="radiogroup"
                  aria-label="Loudness target"
                  className="flex flex-wrap gap-1.5"
                >
                  {LOUDNESS_CHOICES.map((c) => {
                    const active = settings.loudnessLufs === c.value;
                    return (
                      <button
                        key={c.label}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={c.hint}
                        data-testid="export-loudness"
                        data-lufs={c.value ?? 'off'}
                        onClick={() => update({ ...settings, loudnessLufs: c.value })}
                        className={cn(
                          'h-8 rounded-full border px-3.5 text-xs font-medium tabular-nums outline-none transition-[background-color,border-color,color] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring',
                          active
                            ? 'border-primary/70 bg-primary-soft text-primary-text'
                            : 'border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-2xs text-subtle">
                  {LOUDNESS_CHOICES.find((c) => c.value === settings.loudnessLufs)?.hint ??
                    'Custom target'}
                </p>
              </div>
            </section>

            {/* captions */}
            <section className="flex flex-col gap-3" aria-label="Captions">
              <GroupLabel>Captions</GroupLabel>
              <ToggleRow
                label="Burn captions into the video"
                description="Draws the subtitle track on the picture. Text layers always render."
                checked={settings.burnCaptions}
                onChange={(v) => update({ ...settings, burnCaptions: v })}
                testId="export-burn"
              />
              <ToggleRow
                label="Also save an .srt file"
                description="Subtitles as a separate file for upload."
                checked={settings.sidecarSrt}
                onChange={(v) => update({ ...settings, sidecarSrt: v })}
                testId="export-srt"
              />
              <ToggleRow
                label="Also save a .vtt file"
                description="WebVTT version for web players."
                checked={settings.sidecarVtt}
                onChange={(v) => update({ ...settings, sidecarVtt: v })}
                testId="export-vtt"
              />
            </section>

            {/* file name */}
            <section className="flex flex-col gap-2.5" aria-label="File name">
              <GroupLabel>File name</GroupLabel>
              <Input
                value={settings.filenameTemplate}
                onChange={(e) => update({ ...settings, filenameTemplate: e.target.value })}
                aria-label="File name template"
                invalid={issues.some((i) => i.field === 'filename' && i.level === 'error')}
                className="h-8"
                data-testid="export-filename"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-subtle">Insert</span>
                {FILENAME_TOKENS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      update({
                        ...settings,
                        filenameTemplate: `${settings.filenameTemplate}${t}`.slice(0, 120),
                      })
                    }
                    className="rounded-md border border-border-strong px-1.5 py-0.5 font-mono text-2xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Saves as{' '}
                <code
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
                  data-testid="export-filename-preview"
                >
                  {name}
                </code>
              </p>
            </section>
          </fieldset>

          {/* summary / progress / result */}
          <aside
            aria-label="Export summary"
            aria-live="polite"
            className="scrollbar-thin flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l bg-card/50 p-5 max-[820px]:w-full max-[820px]:border-l-0 max-[820px]:border-t"
          >
            {job && job.status === 'done' ? (
              <ResultView job={job} onShowLibrary={showLibrary} onAgain={reset} />
            ) : job && (job.status === 'failed' || job.status === 'canceled') ? (
              <div
                className="flex flex-col gap-3"
                data-testid="export-failed"
                data-status={job.status}
              >
                <Banner
                  tone={job.status === 'failed' ? 'danger' : 'neutral'}
                  title={job.status === 'failed' ? 'Export failed' : 'Export canceled'}
                >
                  {job.status === 'failed'
                    ? (job.error ?? job.message ?? 'The render stopped unexpectedly.')
                    : 'Nothing was added to your Library.'}
                </Banner>
                <Button variant="outline" onClick={reset} data-testid="export-retry">
                  <RotateCcw /> {job.status === 'failed' ? 'Adjust and retry' : 'Back to settings'}
                </Button>
              </div>
            ) : running ? (
              <div className="flex flex-col gap-3" data-testid="export-progress">
                <div className="flex items-center justify-between">
                  <p className="font-display text-md font-semibold">
                    {canceling
                      ? 'Canceling…'
                      : job?.status === 'queued'
                        ? 'Waiting in the queue'
                        : 'Rendering'}
                  </p>
                  <span className="text-sm font-semibold tabular-nums" data-testid="export-percent">
                    {progress !== null ? `${Math.round(progress * 100)}%` : ''}
                  </span>
                </div>
                <p className="text-2xs tabular-nums text-subtle" data-testid="export-target">
                  {presetLabel(job?.settings.preset ?? settings.preset)} ·{' '}
                  {job?.settings.width ?? settings.width}×{job?.settings.height ?? settings.height}{' '}
                  · {job?.settings.fps ?? settings.fps} fps
                </p>
                <Progress
                  value={progress === null ? null : progress * 100}
                  aria-label="Export progress"
                  data-testid="export-bar"
                />
                <p className="min-h-4 text-xs text-muted-foreground" data-testid="export-message">
                  {job?.message ?? (starting ? 'Saving your edits…' : 'Starting…')}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={canceling || starting || !activeId}
                  onClick={() => void cancel()}
                  data-testid="export-cancel"
                >
                  Cancel export
                </Button>
                <p className="text-2xs leading-4 text-subtle">
                  You can close this window; the export keeps rendering and appears in Library →
                  Exported.
                </p>
              </div>
            ) : (
              <>
                <section aria-label="Summary" className="flex flex-col gap-3">
                  <GroupLabel>Summary</GroupLabel>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Format</dt>
                    <dd className="text-right tabular-nums">MP4 · H.264</dd>
                    <dt className="text-muted-foreground">Size</dt>
                    <dd className="text-right tabular-nums" data-testid="export-dims">
                      {settings.width}×{settings.height} · {exAspect}
                    </dd>
                    <dt className="text-muted-foreground">Frame rate</dt>
                    <dd className="text-right tabular-nums">{settings.fps} fps</dd>
                    <dt className="text-muted-foreground">Length</dt>
                    <dd className="text-right tabular-nums">{formatClock(durationSec)}</dd>
                    <dt className="text-muted-foreground">Bitrate</dt>
                    <dd className="text-right tabular-nums">
                      {(videoKbps / 1000).toFixed(1)} Mbps
                      <span className="text-subtle"> + {settings.audioKbps} kbps</span>
                    </dd>
                    <dt className="text-muted-foreground">Loudness</dt>
                    <dd className="text-right tabular-nums">
                      {settings.loudnessLufs === null
                        ? 'Unchanged'
                        : `${settings.loudnessLufs} LUFS`}
                    </dd>
                  </dl>
                  <div className="flex items-baseline justify-between rounded-lg border bg-muted/50 px-3 py-2.5">
                    <span className="text-sm text-muted-foreground">Estimated size</span>
                    <span
                      className="font-display text-lg font-semibold tabular-nums"
                      data-testid="export-size"
                    >
                      {describeSize(settings, durationSec)}
                    </span>
                  </div>
                  <p className="text-2xs text-subtle">
                    An estimate from the bitrate; real files vary with the picture.
                  </p>
                </section>
                {emptyTimeline ? (
                  <Banner tone="warning" className="py-2 text-xs" title="Nothing to export">
                    The timeline is empty. Add a clip first.
                  </Banner>
                ) : null}
                <Issues issues={issues.filter((i) => i.field !== 'duration')} />
                {startError ? (
                  <Banner tone="danger" className="py-2 text-xs" title="Could not start the export">
                    <span data-testid="export-start-error">{startError}</span>
                  </Banner>
                ) : null}
              </>
            )}
          </aside>
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button
            variant="outline"
            disabled={
              job?.status === 'done'
                ? false
                : scheduleAfter || blocked || !projectId || emptyTimeline || starting
            }
            loading={scheduleAfter && running}
            onClick={() => {
              if (job?.status === 'done') {
                setScheduleOpen(true);
                return;
              }
              setScheduleAfter(true);
              if (!running) void start();
            }}
            data-testid="export-schedule"
          >
            {scheduleAfter && running ? null : <CalendarClock />}{' '}
            {scheduleAfter && running ? 'Scheduling when done…' : 'Export & Schedule'}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant={starting || !locked ? 'ghost' : 'primary'}
              onClick={() => onOpenChange(false)}
              data-testid="export-close"
            >
              {running ? 'Hide' : job?.status === 'done' ? 'Done' : 'Close'}
            </Button>
            {starting || !locked ? (
              <Button
                variant="primary"
                loading={starting}
                disabled={blocked || !projectId}
                onClick={() => void start()}
                data-testid="export-start"
              >
                {starting ? null : <Upload />} Export
              </Button>
            ) : null}
          </div>
        </DialogFooter>
        {job?.status === 'done' ? (
          <SchedulePostDialog
            source={{ exportId: job.id }}
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
