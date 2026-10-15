'use client';

import * as React from 'react';
import { BellRing, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { StatusDot, schedulerTone } from '@/components/scheduler/status-bar';
import { getApi, invoke } from '@/lib/ipc';
import { formatWhen } from '@/lib/publish/dates';
import { useNowMs } from '@/lib/publish/now';
import { useSchedulerStatus, useSetPaused } from '@/lib/publish/queries';
import { useSettings, useUpdateSettings } from '@/lib/settings';
import { SettingRow, SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

const GRACE = [15, 30, 60, 120, 240, 360, 720, 1440];
const GAPS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const PER_DAY = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function minutesLabel(m: number): string {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  if (Number.isInteger(h)) return h === 1 ? '1 hour' : `${h} hours`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const hourLabel = (h: number) =>
  new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** A numeric Select whose list always contains the stored value (even if it is not one of the presets). */
function NumberSelect({
  id,
  label,
  value,
  options,
  format,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  options: number[];
  format: (n: number) => string;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="h-9 w-40" data-testid={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {list.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {format(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SchedulerSettings() {
  const { settings, ready } = useSettings();
  const { update } = useUpdateSettings();
  const status = useSchedulerStatus();
  const setPaused = useSetPaused();
  const now = useNowMs();
  const [digesting, setDigesting] = React.useState(false);
  const s = status.data;
  const where = getApi()?.platform === 'darwin' ? 'menu bar' : 'system tray';
  const trayUnavailable = s ? !s.trayAvailable : false;

  const digestNow = async () => {
    setDigesting(true);
    try {
      const r = await invoke('scheduler:digestNow');
      if (r.sent) toast.success('Digest sent', { description: 'Check your notifications.' });
      else toast.info('Nothing to report', { description: 'There are no posts to summarise yet.' });
    } catch (e) {
      toast.error('Could not send the digest', {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDigesting(false);
    }
  };

  return (
    <>
      <SettingsHeading
        title="Scheduler"
        description="How Clipfern keeps posting while you are away, and how it spaces posts out."
      />

      <SettingsCard
        title="Scheduler"
        description="Clipfern publishes from this computer, so the app has to be running at the scheduled time."
        action={
          s ? (
            <span
              className="flex items-center gap-2 text-sm font-medium"
              data-testid="settings-scheduler-state"
            >
              <StatusDot tone={schedulerTone(s)} />
              {s.paused ? 'Paused' : s.active ? 'Active' : 'Not running'}
            </span>
          ) : null
        }
      >
        <SettingRow
          label="Pause the scheduler"
          description={
            s && s.nextAt !== null && now !== null
              ? `Next post: ${formatWhen(s.nextAt, now)}. While paused, nothing is published.`
              : 'While paused, nothing is published.'
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!s}
            loading={setPaused.isPending}
            onClick={() => s && setPaused.mutate(!s.paused)}
            data-testid="settings-pause"
          >
            {s?.paused ? <Play /> : <Pause />} {s?.paused ? 'Resume' : 'Pause'}
          </Button>
        </SettingRow>
        <SettingRow
          label={`Keep running in the ${where}`}
          htmlFor="tray-mode"
          description={
            trayUnavailable
              ? `The ${where} is not available on this system, so closing the window quits Clipfern and stops posting.`
              : `Closing the window hides Clipfern in the ${where} instead of quitting, so scheduled posts still go out. Quit from the ${where} icon.`
          }
        >
          <Switch
            id="tray-mode"
            checked={settings.schedulerTrayMode && !trayUnavailable}
            disabled={!ready || trayUnavailable}
            onCheckedChange={(v) => void update({ schedulerTrayMode: v })}
          />
        </SettingRow>
        <SettingRow
          label="Catch-up window"
          htmlFor="grace"
          description="If Clipfern was closed when a post was due, it still publishes when it is at most this late. Later than that it is marked Missed so you can reschedule it."
        >
          <NumberSelect
            id="grace"
            label="Catch-up window"
            value={settings.schedulerGraceMinutes}
            options={GRACE}
            format={minutesLabel}
            disabled={!ready}
            onChange={(n) => void update({ schedulerGraceMinutes: n })}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Smart spacing"
        description="Used when you schedule several clips at once. Posts land inside your Brand Kit posting windows."
      >
        <SettingRow
          label="Minimum gap between posts"
          htmlFor="min-gap"
          description="Per account. Prevents two clips going out back to back."
        >
          <NumberSelect
            id="min-gap"
            label="Minimum gap between posts"
            value={settings.schedulerMinGapMinutes}
            options={GAPS}
            format={minutesLabel}
            disabled={!ready}
            onChange={(n) => void update({ schedulerMinGapMinutes: n })}
          />
        </SettingRow>
        <SettingRow
          label="Maximum posts per day"
          htmlFor="max-per-day"
          description="Per account. Instagram and YouTube also have their own daily limits."
        >
          <NumberSelect
            id="max-per-day"
            label="Maximum posts per day"
            value={settings.schedulerMaxPerDay}
            options={PER_DAY}
            format={(n) => `${n} a day`}
            disabled={!ready}
            onChange={(n) => void update({ schedulerMaxPerDay: n })}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Posting" description="Checks and notifications around each post.">
        <SettingRow
          label="Auto-fix media"
          htmlFor="auto-fix"
          description="When a clip is outside a platform's limits (length, size, codec, frame rate), re-encode a compliant copy right before posting. Your original clip is never changed."
        >
          <Switch
            id="auto-fix"
            checked={settings.autoFixMedia}
            disabled={!ready}
            onCheckedChange={(v) => void update({ autoFixMedia: v })}
          />
        </SettingRow>
        <SettingRow
          label="Daily digest"
          htmlFor="digest"
          description="One notification each morning: what posted yesterday, what is coming up today, and anything that failed or was missed."
        >
          <Switch
            id="digest"
            checked={settings.digestEnabled}
            disabled={!ready}
            onCheckedChange={(v) => void update({ digestEnabled: v })}
          />
        </SettingRow>
        <SettingRow
          label="Digest time"
          htmlFor="digest-hour"
          description="Local time. If Clipfern is closed then, the digest is sent when it next starts."
        >
          <div className="flex items-center gap-2">
            <NumberSelect
              id="digest-hour"
              label="Digest time"
              value={settings.digestHour}
              options={HOURS}
              format={hourLabel}
              disabled={!ready || !settings.digestEnabled}
              onChange={(n) => void update({ digestHour: n })}
            />
            <Button
              variant="outline"
              size="sm"
              loading={digesting}
              onClick={() => void digestNow()}
              data-testid="digest-now"
            >
              <BellRing /> Send now
            </Button>
          </div>
        </SettingRow>
      </SettingsCard>
    </>
  );
}
