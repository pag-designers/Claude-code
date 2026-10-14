'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  AudioLines,
  CircleCheck,
  ChevronDown,
  Crop,
  Download,
  Film,
  Link2,
  Play,
  Sparkles,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { REFRAME_MODE_LABELS, reframeModeSchema } from '@shared/cp2';
import { parseYouTubeId } from '@shared/pipeline';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { ChipGroup } from '@/components/ui/chip-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { DisabledTip } from '@/components/ui/tooltip';
import { BrandKitStartOption, useStartBrandKit } from '@/components/brand-apply/start-option';
import { StyleStudio } from '@/components/captions/style-studio';
import { StyleThumb } from '@/components/captions/style-thumb';
import {
  LiveRejected,
  PreviewSkeleton,
  ProbeError,
  UrlPreviewCard,
} from '@/components/home/url-preview';
import { useCaptionStyle } from '@/lib/cp2-captions';
import { videoHref } from '@/lib/hrefs';
import { useIpcQuery } from '@/lib/ipc';
import { useStartPipeline, useVideos } from '@/lib/library';
import { duration, ease } from '@/lib/motion';
import { usePipelineReadiness } from '@/lib/readiness';
import { useSettings } from '@/lib/settings';
import {
  buildStartOptions,
  customRangeError,
  formFromSettings,
  type StartForm,
} from '@/lib/start-options';
import { useDebounced } from '@/lib/use-debounced';
import { parseYoutubeUrl } from '@/lib/urls';

const LENGTHS = [
  { value: '15-30', label: '15–30 s', hint: 'Punchy, TikTok-style' },
  { value: '30-60', label: '30–60 s', hint: 'The sweet spot for Shorts and Reels' },
  { value: '60-90', label: '60–90 s', hint: 'Story-driven clips' },
  { value: 'custom', label: 'Custom', hint: 'Set your own min and max length' },
] as const;
const COUNTS = ['5', '8', '10', '15', '20'];
const ASPECTS = ['9:16', '1:1', '4:5', '16:9'] as const;

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  suffix: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-sm text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="h-9 w-full pr-7 tabular-nums"
        trailing={<span className="pr-1.5 text-xs">{suffix}</span>}
        wrapperClassName="w-28"
      />
    </div>
  );
}

/** Home option: opens the Caption Style Studio; shows the chosen preset with a real libass thumbnail. */
function CaptionStyleOption({
  styleId,
  disabled,
  onChange,
}: {
  styleId: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const style = useCaptionStyle(styleId);
  const button = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setOpen(true)}
      aria-label={`Caption style: ${style?.name ?? 'loading'}`}
      data-testid="home-caption-style"
      className="flex h-11 items-center gap-3 rounded-lg border border-border-strong bg-transparent py-1 pl-1 pr-3 text-left transition-colors duration-(--duration-fast) hover:bg-accent disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="w-[68px] shrink-0 overflow-hidden rounded-md border border-border-strong">
        {style ? (
          <StyleThumb style={style} alt="" band />
        ) : (
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block max-w-36 truncate text-sm font-medium leading-4">
          {style?.name ?? 'Loading…'}
        </span>
        <span className="block text-2xs leading-3 text-subtle">Change style</span>
      </span>
      <ChevronDown className="size-4 shrink-0 text-subtle" aria-hidden />
    </button>
  );
  return (
    <>
      {disabled ? <DisabledTip reason="Captions are switched off">{button}</DisabledTip> : button}
      <StyleStudio
        open={open}
        onOpenChange={setOpen}
        currentStyleId={styleId}
        onApply={onChange}
        title="Caption style for new clips"
        description="Pick a preset or tune every detail. Your choice is used for the next run; change it per video any time."
        applyLabel="Use this style"
      />
    </>
  );
}

export function HomeHero() {
  const router = useRouter();
  const { settings } = useSettings();
  const readiness = usePipelineReadiness();
  const videos = useVideos();
  const start = useStartPipeline();

  const [url, setUrl] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [overrides, setOverrides] = React.useState<Partial<StartForm>>({});
  const [brandKitId, setBrandKitId] = useStartBrandKit();
  const form = React.useMemo<StartForm>(
    () => ({ ...formFromSettings(settings), ...overrides, brandKitId }),
    [settings, overrides, brandKitId],
  );
  const set = <K extends keyof StartForm>(k: K, v: StartForm[K]) =>
    setOverrides((o) => ({ ...o, [k]: v }));

  const raw = url.trim();
  const normalized = raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `https://${raw}` : raw;
  const parsed = parseYoutubeUrl(raw);
  // `parseYouTubeId` (shared with main) is the authority; the renderer parser only supplies friendlier wording.
  const videoId = parsed.ok ? parseYouTubeId(normalized) : null;
  const valid = parsed.ok && videoId !== null;
  const empty = raw.length === 0;
  const showError = touched && !empty && !valid;

  const probeUrl = useDebounced(valid ? normalized : '', 350);
  const probeActive = valid && probeUrl === normalized;
  const probe = useIpcQuery(
    'pipeline:probe',
    { url: probeUrl },
    {
      enabled: probeActive,
      staleTime: Infinity,
      gcTime: 10 * 60_000,
      retry: false,
    },
  );
  const probing = valid && (!probeActive || probe.isFetching);
  const live = probeActive && probe.data?.isLive === true;
  const probeFailed = probeActive && probe.isError;

  const existing = videoId
    ? videos.data?.items.find(
        (v) => v.sourceId === videoId && v.status !== 'failed' && v.status !== 'canceled',
      )
    : undefined;

  const rangeError = customRangeError(form);
  const first = readiness.blockers[0];
  const disabledReason = !valid
    ? 'Paste a valid YouTube link first.'
    : readiness.loading
      ? 'Checking your setup…'
      : first
        ? `${first.message}${readiness.blockers.length > 1 ? ` (+${readiness.blockers.length - 1} more setup steps)` : ''}`
        : live
          ? 'Live streams cannot be clipped until they have ended.'
          : probeFailed
            ? 'Fix the link problem above, then try again.'
            : rangeError
              ? rangeError
              : null;

  const submit = () => {
    setTouched(true);
    if (disabledReason || start.isPending) return;
    start.mutate(
      { url: normalized, options: buildStartOptions(form, settings.maxResolution) },
      {
        onSuccess: ({ videoId: id }) => {
          toast.success('Clipping started', {
            description: 'Clips appear in the video as they are found.',
          });
          router.push(videoHref(id));
        },
      },
    );
  };

  const countValue = form.countMode === 'score' ? 'score' : String(form.clipCount);
  const countOptions =
    COUNTS.includes(String(form.clipCount)) || form.countMode === 'score'
      ? COUNTS
      : [...COUNTS, String(form.clipCount)].sort((a, b) => Number(a) - Number(b));

  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden rounded-2xl border bg-card px-10 py-9 shadow-sm"
    >
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(60% 90% at 12% 0%, var(--hero-glow-a), transparent 70%), radial-gradient(50% 80% at 100% 100%, var(--hero-glow-b), transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="bg-dots absolute inset-0 -z-10 opacity-70 [mask-image:linear-gradient(to_bottom,#000,transparent_85%)]"
      />

      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-12 max-[1180px]:grid-cols-1">
        <div>
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary-text">
            <Sparkles className="size-3.5" aria-hidden /> AI clipping for Whop campaigns
          </p>
          <h1
            id="hero-title"
            className="max-w-3xl font-display text-4xl font-semibold leading-[1.1] text-balance"
          >
            Paste a YouTube URL. Get clips worth posting.
          </h1>
          <p className="mt-3 max-w-2xl text-md text-muted-foreground">
            Clipfern finds the strongest moments, scores them for virality, reframes them to
            vertical and captions them, without ever keeping the source video on your disk.
          </p>

          <form
            className="mt-7 flex max-w-3xl flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            noValidate
          >
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <Input
                  id="yt-url"
                  aria-label="YouTube URL"
                  aria-describedby="yt-url-status"
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  invalid={showError}
                  leading={<Link2 />}
                  className="h-12 rounded-lg pl-10 text-md"
                />
              </div>
              {disabledReason ? (
                <DisabledTip reason={disabledReason} side="bottom">
                  <Button type="submit" variant="primary" size="lg" disabled className="h-12">
                    <Play className="fill-current" /> Start clipping
                  </Button>
                </DisabledTip>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="h-12"
                  loading={start.isPending}
                >
                  <Play className="fill-current" /> Start clipping
                </Button>
              )}
            </div>
            <div id="yt-url-status" className="min-h-5 text-sm" aria-live="polite">
              {showError && !parsed.ok ? (
                <p className="flex items-center gap-1.5 text-danger">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {parsed.reason}
                </p>
              ) : valid && parsed.ok && !probeFailed ? (
                <p className="flex items-center gap-1.5 text-success">
                  <CircleCheck className="size-4 shrink-0" aria-hidden />
                  Valid YouTube{' '}
                  {parsed.kind === 'shorts'
                    ? 'Short'
                    : parsed.kind === 'live'
                      ? 'live stream'
                      : 'video'}{' '}
                  link · ID <span className="selectable font-mono">{videoId}</span>
                </p>
              ) : (
                <p className="text-subtle">
                  Supports youtube.com/watch, youtu.be, /shorts and /live links.
                </p>
              )}
            </div>
          </form>

          {valid ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: duration.base, ease: ease.out }}
              className="mt-3 flex max-w-3xl flex-col gap-3"
            >
              {probing && !probe.data ? <PreviewSkeleton /> : null}
              {probeActive && probe.data ? <UrlPreviewCard info={probe.data} /> : null}
              {live ? <LiveRejected /> : null}
              {probeFailed ? (
                <ProbeError
                  message={probe.error.message}
                  onRetry={() => void probe.refetch()}
                  retrying={probe.isFetching}
                />
              ) : null}
              {existing ? (
                <Banner
                  tone="info"
                  title="This video is already in your library"
                  action={
                    <Button size="sm" variant="outline" asChild>
                      <Link href={videoHref(existing.id)}>
                        Open <ArrowRight />
                      </Link>
                    </Button>
                  }
                >
                  Start again to make a new set of clips with different settings.
                </Banner>
              ) : null}
            </motion.div>
          ) : null}

          {first ? (
            <Banner
              tone="warning"
              title="Finish setup to start clipping"
              className="mt-4 max-w-3xl"
              action={
                <Button size="sm" variant="outline" asChild>
                  <Link href={first.href}>Fix in Settings</Link>
                </Button>
              }
            >
              <span data-testid="setup-blocker">{first.message}</span>
              {readiness.blockers.length > 1 ? (
                <span className="mt-0.5 block text-xs text-subtle">
                  {readiness.blockers.length - 1} more{' '}
                  {readiness.blockers.length === 2 ? 'step' : 'steps'} in the setup checklist below.
                </span>
              ) : null}
            </Banner>
          ) : null}

          <div className="mt-6 flex max-w-3xl flex-col gap-5">
            <div className="flex flex-wrap gap-x-10 gap-y-5">
              <ChipGroup
                label="Clip length"
                value={form.clipPreset}
                onValueChange={(v) => set('clipPreset', v)}
                options={LENGTHS.map((l) => ({ ...l }))}
              />
              <ChipGroup
                label="Clips"
                value={countValue}
                onValueChange={(v) => {
                  if (v === 'score') set('countMode', 'score');
                  else setOverrides((o) => ({ ...o, countMode: 'fixed', clipCount: Number(v) }));
                }}
                options={[
                  ...countOptions.map((c) => ({ value: c, label: c })),
                  {
                    value: 'score',
                    label: 'All above score',
                    hint: 'Every moment at or above a minimum virality score',
                  },
                ]}
              />
              <ChipGroup
                label="Format"
                value={form.aspect}
                onValueChange={(v) => set('aspect', v)}
                options={ASPECTS.map((a) => ({ value: a, label: a }))}
              />
            </div>

            <div className="flex flex-wrap items-end gap-x-6 gap-y-5">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-subtle">
                  Caption style
                </span>
                <CaptionStyleOption
                  styleId={form.captionStyleId}
                  disabled={!form.captions}
                  onChange={(id) => set('captionStyleId', id)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label
                  htmlFor="reframe-mode"
                  className="text-xs font-semibold uppercase tracking-wider text-subtle"
                >
                  Reframe
                </Label>
                <Select
                  value={form.reframeMode}
                  onValueChange={(v) => set('reframeMode', reframeModeSchema.parse(v))}
                >
                  <SelectTrigger id="reframe-mode" className="h-11 w-56" data-testid="home-reframe">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reframeModeSchema.options.map((m) => (
                      <SelectItem key={m} value={m}>
                        {REFRAME_MODE_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <BrandKitStartOption value={form.brandKitId} onChange={setBrandKitId} />
            </div>

            {form.clipPreset === 'custom' ? (
              <div
                className="flex flex-wrap items-center gap-x-6 gap-y-2"
                data-testid="custom-range"
              >
                <NumberField
                  id="min-sec"
                  label="Min length"
                  value={form.minSec}
                  onChange={(n) => set('minSec', n)}
                  min={5}
                  max={300}
                  suffix="s"
                />
                <NumberField
                  id="max-sec"
                  label="Max length"
                  value={form.maxSec}
                  onChange={(n) => set('maxSec', n)}
                  min={5}
                  max={300}
                  suffix="s"
                />
                {rangeError ? (
                  <p role="alert" className="text-xs text-danger">
                    {rangeError}
                  </p>
                ) : null}
              </div>
            ) : null}
            {form.countMode === 'score' ? (
              <div className="flex max-w-sm items-center gap-4" data-testid="score-threshold">
                <Label htmlFor="min-score-home" className="shrink-0 text-sm text-muted-foreground">
                  Minimum score
                </Label>
                <Slider
                  id="min-score-home"
                  value={form.minScore}
                  onValueChange={(v) => set('minScore', v)}
                  min={40}
                  max={95}
                  step={5}
                />
                <span className="w-8 text-right text-sm font-semibold tabular-nums">
                  {form.minScore}
                </span>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
                <Switch
                  checked={form.captions}
                  onCheckedChange={(v) => set('captions', v)}
                  aria-label="Captions"
                />
                Captions
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
                <Switch
                  checked={form.hookCard}
                  onCheckedChange={(v) => set('hookCard', v)}
                  aria-label="Hook card"
                />
                Hook card
              </label>
              <div className="min-w-64 flex-1">
                <Input
                  aria-label="Steering prompt"
                  placeholder="Find moments about… (optional)"
                  leading={<Wand2 />}
                  value={form.prompt}
                  maxLength={500}
                  onChange={(e) => set('prompt', e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
          </div>
        </div>
        <HowItWorks />
      </div>
    </section>
  );
}

const STEPS = [
  { icon: Download, title: 'Download', text: 'Up to 1080p with yt-dlp' },
  { icon: AudioLines, title: 'Transcribe', text: 'Word-timed, on your machine' },
  { icon: Sparkles, title: 'Find moments', text: 'Claude scores each 0–100' },
  { icon: Crop, title: 'Reframe + caption', text: 'Face-tracked 9:16, word-pop' },
  { icon: Film, title: 'Render', text: '1080×1920 MP4 to your bucket' },
] as const;

function HowItWorks() {
  return (
    <aside
      aria-label="How clipping works"
      className="rounded-xl border bg-background/60 p-4 backdrop-blur max-[1180px]:hidden"
    >
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-subtle">
        <Wand2 className="size-3.5" aria-hidden /> What happens next
      </p>
      <ol className="relative flex flex-col gap-3.5">
        <span aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-border-strong" />
        {STEPS.map((st) => (
          <li key={st.title} className="relative flex items-center gap-3">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-card text-primary-text">
              <st.icon className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold leading-4">{st.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{st.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
