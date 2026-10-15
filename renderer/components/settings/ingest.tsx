'use client';

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettings, useUpdateSettings } from '@/lib/settings';
import { SaveBar, SettingsCard } from './common';
import { SettingsHeading } from './settings-shell';

const schema = z.object({
  maxResolution: z.enum(['720', '1080', '1440', '2160']),
  cookiesFromBrowser: z.enum(['none', 'chrome', 'firefox', 'edge', 'safari', 'brave']),
  defaultClipPreset: z.enum(['15-30', '30-60', '60-90', 'custom']),
  defaultClipCount: z
    .number({ error: 'Enter a number.' })
    .int('Whole numbers only.')
    .min(1, 'At least 1.')
    .max(50, 'At most 50.'),
  defaultAspect: z.enum(['9:16', '1:1', '4:5', '16:9']),
});
type FormValues = z.infer<typeof schema>;

export function IngestSettings() {
  const { settings } = useSettings();
  const { update, saving } = useUpdateSettings();
  const values: FormValues = {
    maxResolution: String(settings.maxResolution) as FormValues['maxResolution'],
    cookiesFromBrowser: settings.cookiesFromBrowser,
    defaultClipPreset: settings.defaultClipPreset,
    defaultClipCount: settings.defaultClipCount,
    defaultAspect: settings.defaultAspect,
  };
  const { register, control, handleSubmit, reset, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    values,
    resetOptions: { keepDirtyValues: true },
    mode: 'onChange',
  });
  const { errors, isDirty } = formState;
  const onSave = handleSubmit(async (v) => {
    await update(
      { ...v, maxResolution: Number(v.maxResolution) as 720 | 1080 | 1440 | 2160 },
      { successMessage: 'Ingest settings saved' },
    );
    reset(v);
  });

  return (
    <>
      <SettingsHeading
        title="Ingest"
        description="How videos are downloaded, and what a new clipping run starts with."
      />
      <SettingsCard
        title="Download"
        description="Higher quality costs more time and temporary disk space, not cloud storage."
      >
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Maximum resolution"
            htmlFor="maxResolution"
            description="Best available up to this height."
          >
            <Controller
              control={control}
              name="maxResolution"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="maxResolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="720">720p</SelectItem>
                    <SelectItem value="1080">1080p (recommended)</SelectItem>
                    <SelectItem value="1440">1440p</SelectItem>
                    <SelectItem value="2160">4K (2160p)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field
            label="Use cookies from browser"
            htmlFor="cookiesFromBrowser"
            description="Needed only for age-restricted or members-only videos."
          >
            <Controller
              control={control}
              name="cookiesFromBrowser"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="cookiesFromBrowser">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Don&apos;t use cookies</SelectItem>
                    <SelectItem value="chrome">Chrome</SelectItem>
                    <SelectItem value="firefox">Firefox</SelectItem>
                    <SelectItem value="edge">Edge</SelectItem>
                    <SelectItem value="safari">Safari</SelectItem>
                    <SelectItem value="brave">Brave</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </div>
      </SettingsCard>
      <SettingsCard
        title="Clipping defaults"
        description="Pre-selected on Home. You can change them for any single run."
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Clip length" htmlFor="defaultClipPreset">
            <Controller
              control={control}
              name="defaultClipPreset"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="defaultClipPreset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15-30">15–30 seconds</SelectItem>
                    <SelectItem value="30-60">30–60 seconds</SelectItem>
                    <SelectItem value="60-90">60–90 seconds</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field
            label="Number of clips"
            htmlFor="defaultClipCount"
            error={errors.defaultClipCount?.message}
          >
            <Input
              id="defaultClipCount"
              type="number"
              min={1}
              max={50}
              invalid={!!errors.defaultClipCount}
              {...register('defaultClipCount', { valueAsNumber: true })}
            />
          </Field>
          <Field label="Aspect ratio" htmlFor="defaultAspect">
            <Controller
              control={control}
              name="defaultAspect"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="defaultAspect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="9:16">9:16 vertical</SelectItem>
                    <SelectItem value="1:1">1:1 square</SelectItem>
                    <SelectItem value="4:5">4:5 portrait</SelectItem>
                    <SelectItem value="16:9">16:9 landscape</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        </div>
      </SettingsCard>
      <SaveBar
        dirty={isDirty}
        saving={saving}
        onReset={() => reset(values)}
        onSave={() => void onSave()}
      />
    </>
  );
}
