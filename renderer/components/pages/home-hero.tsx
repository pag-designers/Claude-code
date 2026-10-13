'use client';

import * as React from 'react';
import { CircleCheck, Link2, Play, Sparkles, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChipGroup } from '@/components/ui/chip-group';
import { Input } from '@/components/ui/input';
import { DisabledTip } from '@/components/ui/tooltip';
import { useSettings } from '@/lib/settings';
import { parseYoutubeUrl } from '@/lib/urls';

type Length = '15-30' | '30-60' | '60-90';
const LENGTHS = [
  { value: '15-30', label: '15–30 s', hint: 'Punchy, TikTok-style' },
  { value: '30-60', label: '30–60 s', hint: 'The sweet spot for Shorts and Reels' },
  { value: '60-90', label: '60–90 s', hint: 'Story-driven clips' },
] as const;
const COUNTS = ['5', '8', '10', '15', '20'];

export function HomeHero() {
  const { settings } = useSettings();
  const [url, setUrl] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [length, setLength] = React.useState<Length | null>(null);
  const [count, setCount] = React.useState<string | null>(null);
  const [aspect, setAspect] = React.useState<string | null>(null);

  const effLength: Length =
    length ?? (settings.defaultClipPreset === 'custom' ? '30-60' : settings.defaultClipPreset);
  const effCount = count ?? String(settings.defaultClipCount);
  const effAspect = aspect ?? settings.defaultAspect;
  const countOptions = COUNTS.includes(effCount)
    ? COUNTS
    : [...COUNTS, effCount].sort((a, b) => Number(a) - Number(b));

  const parsed = parseYoutubeUrl(url);
  const empty = url.trim().length === 0;
  const showError = touched && !empty && !parsed.ok;

  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden rounded-2xl border bg-card px-10 py-10 shadow-sm"
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
        Clipfern finds the strongest moments, scores them for virality, reframes them to vertical
        and captions them, without ever keeping the source video on your disk.
      </p>

      <form
        className="mt-7 flex max-w-3xl flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
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
              wrapperClassName=""
            />
          </div>
          <DisabledTip reason="Pipeline arrives in the next checkpoint" side="bottom">
            <Button type="submit" variant="primary" size="lg" disabled className="h-12">
              <Play className="fill-current" /> Start clipping
            </Button>
          </DisabledTip>
        </div>
        <div id="yt-url-status" className="min-h-5 text-sm" aria-live="polite">
          {showError && !parsed.ok ? (
            <p className="flex items-center gap-1.5 text-danger">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {parsed.reason}
            </p>
          ) : parsed.ok ? (
            <p className="flex items-center gap-1.5 text-success">
              <CircleCheck className="size-4 shrink-0" aria-hidden />
              Valid YouTube{' '}
              {parsed.kind === 'shorts'
                ? 'Short'
                : parsed.kind === 'live'
                  ? 'live stream'
                  : 'video'}{' '}
              link · ID <span className="selectable font-mono">{parsed.id}</span>
            </p>
          ) : (
            <p className="text-subtle">
              Supports youtube.com/watch, youtu.be, /shorts and /live links.
            </p>
          )}
        </div>
      </form>

      <div className="mt-6 grid max-w-3xl gap-x-10 gap-y-5 sm:grid-cols-[auto_auto_auto]">
        <ChipGroup
          label="Clip length"
          value={effLength}
          onValueChange={(v) => setLength(v as Length)}
          options={LENGTHS.map((l) => ({ ...l }))}
        />
        <ChipGroup
          label="Clips"
          value={effCount}
          onValueChange={setCount}
          options={countOptions.map((c) => ({ value: c, label: c }))}
        />
        <ChipGroup
          label="Format"
          value={effAspect}
          onValueChange={setAspect}
          options={[
            { value: '9:16', label: '9:16' },
            { value: '1:1', label: '1:1' },
            { value: '4:5', label: '4:5' },
            { value: '16:9', label: '16:9' },
          ]}
        />
      </div>
    </section>
  );
}
