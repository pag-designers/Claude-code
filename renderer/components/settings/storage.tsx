'use client';

import * as React from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PlugZap } from 'lucide-react';
import type { ValidationResult } from '@shared/domain';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { SecretInput } from '@/components/ui/secret-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DisabledTip } from '@/components/ui/tooltip';
import { invoke } from '@/lib/ipc';
import { useSecretActions, useSecrets, useSettings, useUpdateSettings } from '@/lib/settings';
import { useStorageUsage } from '@/lib/queries';
import { ResultChip, SaveBar, SettingsCard, openExternal } from './common';
import { SettingsHeading } from './settings-shell';

const optional = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || re.test(v), msg);

const schema = z.object({
  storageProvider: z.enum(['r2', 'b2']),
  r2AccountId: optional(
    /^[a-f0-9]{32}$/i,
    'The Cloudflare account ID is 32 hexadecimal characters.',
  ),
  r2Bucket: optional(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    'Bucket names use 3–63 lowercase letters, numbers and hyphens.',
  ),
  r2PublicDomain: optional(
    /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i,
    'Enter a domain such as media.example.com.',
  ),
  b2Endpoint: optional(
    /^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com\/?$/i,
    'Looks like https://s3.us-west-004.backblazeb2.com',
  ),
  b2Region: optional(/^[a-z]{2}-[a-z]+-\d{3}$/, 'Looks like us-west-004.'),
  b2Bucket: optional(/^[a-zA-Z0-9-]{6,50}$/, 'Bucket names use 6–50 letters, numbers and hyphens.'),
  cacheCapGb: z
    .number({ error: 'Enter a number.' })
    .min(1, 'At least 1 GB.')
    .max(500, 'At most 500 GB.'),
  keepSourceAs: z.enum(['proxy480', 'full', 'none']),
  storageFreeTierGb: z.number({ error: 'Enter a number.' }).positive('Must be greater than 0.'),
});
type FormValues = z.infer<typeof schema>;

export function StorageSettings() {
  const { settings } = useSettings();
  const { update, saving } = useUpdateSettings();
  const { keys, loading } = useSecrets();
  const { save, clear } = useSecretActions();
  const usage = useStorageUsage();

  const values: FormValues = {
    storageProvider: settings.storageProvider,
    r2AccountId: settings.r2AccountId,
    r2Bucket: settings.r2Bucket,
    r2PublicDomain: settings.r2PublicDomain,
    b2Endpoint: settings.b2Endpoint,
    b2Region: settings.b2Region,
    b2Bucket: settings.b2Bucket,
    cacheCapGb: settings.cacheCapGb,
    keepSourceAs: settings.keepSourceAs,
    storageFreeTierGb: settings.storageFreeTierGb,
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    values,
    resetOptions: { keepDirtyValues: true },
    mode: 'onChange',
  });
  const { register, control, handleSubmit, reset, formState } = form;
  const { errors, isDirty } = formState;
  const provider = useWatch({ control, name: 'storageProvider' });

  const onSave = handleSubmit(async (v) => {
    await update(v, { successMessage: 'Storage settings saved' });
    reset(v);
  });

  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ValidationResult | null>(null);
  const [testError, setTestError] = React.useState<string | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(null);
    setTestError(null);
    try {
      setResult(await invoke('validate:run', { service: 'storage' }));
      void usage.refetch();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const isR2 = provider === 'r2';

  return (
    <>
      <SettingsHeading
        title="Storage"
        description="Videos, clips and renders live in your own free-tier bucket. Local disk is only a temporary cache."
      />

      <SettingsCard
        title="Provider"
        description="Both offer a 10 GB free tier with S3-compatible access."
      >
        <Controller
          control={control}
          name="storageProvider"
          render={({ field }) => (
            <Segmented
              label="Storage provider"
              value={field.value}
              onValueChange={field.onChange}
              options={[
                { value: 'r2', label: 'Cloudflare R2', hint: 'Free egress, 10 GB free' },
                { value: 'b2', label: 'Backblaze B2', hint: '10 GB free' },
              ]}
            />
          )}
        />

        {isR2 ? (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Account ID"
              htmlFor="r2AccountId"
              error={errors.r2AccountId?.message}
              description="Cloudflare dashboard → R2 → Account details."
            >
              <Input
                id="r2AccountId"
                placeholder="32-character account ID"
                invalid={!!errors.r2AccountId}
                autoComplete="off"
                spellCheck={false}
                {...register('r2AccountId')}
              />
            </Field>
            <Field label="Bucket" htmlFor="r2Bucket" error={errors.r2Bucket?.message}>
              <Input
                id="r2Bucket"
                placeholder="clipfern-media"
                invalid={!!errors.r2Bucket}
                autoComplete="off"
                spellCheck={false}
                {...register('r2Bucket')}
              />
            </Field>
            <Field
              label="Public domain (optional)"
              htmlFor="r2PublicDomain"
              error={errors.r2PublicDomain?.message}
              description="A custom domain on the bucket. Leave empty to use presigned URLs."
              className="col-span-2"
            >
              <Input
                id="r2PublicDomain"
                placeholder="media.example.com"
                invalid={!!errors.r2PublicDomain}
                autoComplete="off"
                spellCheck={false}
                {...register('r2PublicDomain')}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="S3 endpoint"
              htmlFor="b2Endpoint"
              error={errors.b2Endpoint?.message}
              className="col-span-2"
            >
              <Input
                id="b2Endpoint"
                placeholder="https://s3.us-west-004.backblazeb2.com"
                invalid={!!errors.b2Endpoint}
                autoComplete="off"
                spellCheck={false}
                {...register('b2Endpoint')}
              />
            </Field>
            <Field label="Region" htmlFor="b2Region" error={errors.b2Region?.message}>
              <Input
                id="b2Region"
                placeholder="us-west-004"
                invalid={!!errors.b2Region}
                autoComplete="off"
                spellCheck={false}
                {...register('b2Region')}
              />
            </Field>
            <Field label="Bucket" htmlFor="b2Bucket" error={errors.b2Bucket?.message}>
              <Input
                id="b2Bucket"
                placeholder="clipfern-media"
                invalid={!!errors.b2Bucket}
                autoComplete="off"
                spellCheck={false}
                {...register('b2Bucket')}
              />
            </Field>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={isR2 ? 'R2 access keys' : 'B2 application key'}
        description={
          <>
            Create an API token with read &amp; write access to this bucket.{' '}
            <button
              type="button"
              className="rounded-xs font-medium text-primary-text hover:underline"
              onClick={() =>
                void openExternal(
                  isR2
                    ? 'https://developers.cloudflare.com/r2/api/tokens/'
                    : 'https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys',
                )
              }
            >
              How to create one
            </button>
          </>
        }
      >
        {isR2 ? (
          <>
            <SecretInput
              id="secret-r2-id"
              label="Access key ID"
              status={keys?.['r2.accessKeyId']}
              loading={loading}
              onSave={(v) => save('r2.accessKeyId', v)}
              onClear={() => clear('r2.accessKeyId')}
            />
            <SecretInput
              id="secret-r2-secret"
              label="Secret access key"
              status={keys?.['r2.secretAccessKey']}
              loading={loading}
              onSave={(v) => save('r2.secretAccessKey', v)}
              onClear={() => clear('r2.secretAccessKey')}
            />
          </>
        ) : (
          <>
            <SecretInput
              id="secret-b2-id"
              label="Key ID"
              status={keys?.['b2.keyId']}
              loading={loading}
              onSave={(v) => save('b2.keyId', v)}
              onClear={() => clear('b2.keyId')}
            />
            <SecretInput
              id="secret-b2-key"
              label="Application key"
              status={keys?.['b2.applicationKey']}
              loading={loading}
              onSave={(v) => save('b2.applicationKey', v)}
              onClear={() => clear('b2.applicationKey')}
            />
          </>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t pt-5">
          {isDirty ? (
            <DisabledTip reason="Save your changes first: the test uses the saved settings">
              <Button variant="soft" disabled>
                <PlugZap /> Test connection
              </Button>
            </DisabledTip>
          ) : (
            <Button variant="soft" onClick={test} loading={testing}>
              <PlugZap /> Test connection
            </Button>
          )}
          <ResultChip result={result} error={testError} />
        </div>
        {usage.data?.configured && usage.data.error ? (
          <Banner tone="danger" title="Bucket problem">
            {usage.data.error}
          </Banner>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Cache and retention" description="Keep the free tier free.">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Local cache cap (GB)"
            htmlFor="cacheCapGb"
            error={errors.cacheCapGb?.message}
            description="Temporary working files; oldest are removed first."
          >
            <Input
              id="cacheCapGb"
              type="number"
              min={1}
              max={500}
              step={1}
              invalid={!!errors.cacheCapGb}
              {...register('cacheCapGb', { valueAsNumber: true })}
            />
          </Field>
          <Field
            label="Free tier size (GB)"
            htmlFor="storageFreeTierGb"
            error={errors.storageFreeTierGb?.message}
            description="Drives the storage ring and the 80% warning."
          >
            <Input
              id="storageFreeTierGb"
              type="number"
              min={1}
              step={1}
              invalid={!!errors.storageFreeTierGb}
              {...register('storageFreeTierGb', { valueAsNumber: true })}
            />
          </Field>
          <Field
            label="After clipping, keep the source as"
            htmlFor="keepSourceAs"
            className="col-span-2"
            description="A 480p proxy is enough for the Library and re-clipping; full quality is re-downloaded only when you need a new render."
          >
            <Controller
              control={control}
              name="keepSourceAs"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="keepSourceAs" className="max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="proxy480">480p proxy only (recommended)</SelectItem>
                    <SelectItem value="full">Full-resolution source</SelectItem>
                    <SelectItem value="none">Delete the source</SelectItem>
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
