'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ExternalLink, Link2 } from 'lucide-react';
import type { SecretKey } from '@shared/secrets';
import { Banner } from '@/components/ui/banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InstagramGlyph, TiktokGlyph, YoutubeGlyph } from '@/components/ui/brand-icons';
import { SecretInput } from '@/components/ui/secret-input';
import { DisabledTip } from '@/components/ui/tooltip';
import { useSecretActions, useSecrets } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { SettingsCard, openExternal } from './common';
import { SettingsHeading } from './settings-shell';

interface Step {
  title: string;
  body: React.ReactNode;
}
interface Platform {
  id: string;
  name: string;
  icon: typeof YoutubeGlyph;
  summary: string;
  steps: Step[];
  fields: { key: SecretKey; label: string }[];
  notes: React.ReactNode;
  link: { label: string; url: string };
}

const code = (t: string) => (
  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{t}</code>
);

const PLATFORMS: Platform[] = [
  {
    id: 'youtube',
    name: 'YouTube Shorts',
    icon: YoutubeGlyph,
    summary: 'Uploads through the YouTube Data API v3 with your own free Google Cloud project.',
    link: { label: 'Open Google Cloud Console', url: 'https://console.cloud.google.com/' },
    steps: [
      {
        title: 'Create a Google Cloud project',
        body: 'In the Cloud Console, create a project named “Clipfern”.',
      },
      {
        title: 'Enable the API',
        body: (
          <>
            Go to APIs &amp; Services → Library and enable <strong>YouTube Data API v3</strong>.
          </>
        ),
      },
      {
        title: 'Configure the OAuth consent screen',
        body: (
          <>
            Choose <strong>External</strong>, add your own Google account as a test user and add the
            scope {code('youtube.upload')}. Then click <strong>Publish app</strong>: personal use
            needs no verification, but apps left in “Testing” have refresh tokens that expire every
            7 days.
          </>
        ),
      },
      {
        title: 'Create the OAuth client',
        body: (
          <>
            Credentials → Create credentials → OAuth client ID → application type{' '}
            <strong>Desktop app</strong>.
          </>
        ),
      },
      {
        title: 'Paste the credentials below',
        body: 'Copy the client ID and client secret into the fields on this card.',
      },
    ],
    fields: [
      { key: 'google.clientId', label: 'Client ID' },
      { key: 'google.clientSecret', label: 'Client secret' },
    ],
    notes: (
      <Banner tone="info" title="Daily quota">
        The default quota is 10,000 units a day and each upload costs about 1,600, so roughly{' '}
        <strong>6 uploads a day</strong>. You can request more for free through Google&apos;s
        YouTube API quota extension form.
      </Banner>
    ),
  },
  {
    id: 'instagram',
    name: 'Instagram Reels',
    icon: InstagramGlyph,
    summary:
      'Publishes Reels through the Instagram Graph API using a Meta developer app in Development mode.',
    link: { label: 'Open Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    steps: [
      {
        title: 'Prepare your account',
        body: 'Switch Instagram to a Business or Creator account and link it to a Facebook Page.',
      },
      {
        title: 'Create a Meta app',
        body: 'At developers.facebook.com create an app of type Business.',
      },
      {
        title: 'Add Instagram publishing',
        body: (
          <>
            Add the Instagram product and request the permissions {code('instagram_basic')},{' '}
            {code('instagram_content_publish')} and {code('pages_show_list')}.
          </>
        ),
      },
      {
        title: 'Stay in Development mode',
        body: 'Development mode is enough for your own account as long as you are an admin or tester of the app. No App Review needed.',
      },
      {
        title: 'Paste the app credentials below',
        body: 'App settings → Basic holds the App ID and App secret.',
      },
    ],
    fields: [
      { key: 'meta.appId', label: 'App ID' },
      { key: 'meta.appSecret', label: 'App secret' },
    ],
    notes: (
      <Banner tone="info" title="How media reaches Instagram">
        Instagram fetches the video from a URL, so Clipfern hands it a short-lived presigned link
        from your storage bucket.
      </Banner>
    ),
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    icon: TiktokGlyph,
    summary: 'Posts through the TikTok Content Posting API.',
    link: { label: 'Open TikTok for Developers', url: 'https://developers.tiktok.com/apps/' },
    steps: [
      { title: 'Create an app', body: 'In TikTok for Developers → Manage apps, create a new app.' },
      {
        title: 'Add the products',
        body: (
          <>
            Add <strong>Login Kit</strong> and <strong>Content Posting API</strong>, with scopes{' '}
            {code('video.publish')} and {code('video.upload')}.
          </>
        ),
      },
      {
        title: 'Register the redirect',
        body: 'Clipfern shows the exact redirect URI to register when you connect your account (checkpoint 5).',
      },
      {
        title: 'Paste the credentials below',
        body: 'Copy the client key and client secret from the app page.',
      },
    ],
    fields: [
      { key: 'tiktok.clientKey', label: 'Client key' },
      { key: 'tiktok.clientSecret', label: 'Client secret' },
    ],
    notes: (
      <Banner tone="warning" title="Unaudited apps post privately">
        Until TikTok approves your app in their free audit, every post is{' '}
        <strong>private (visible only to you)</strong>. Clipfern can instead upload to your TikTok
        drafts so you publish from the TikTok app, and will walk you through the audit checklist.
      </Banner>
    ),
  },
];

function Guide({ steps }: { steps: Step[] }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-accent/50"
      >
        <span>Step-by-step setup guide</span>
        <ChevronDown
          className={cn(
            'size-4 text-muted-foreground transition-transform duration-(--duration-base)',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={id}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <ol className="flex flex-col gap-4 border-t px-4 py-4">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-2xs font-bold text-primary-text">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{s.title}</p>
                    <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function IntegrationsSettings() {
  const { keys, loading } = useSecrets();
  const { save, clear } = useSecretActions();
  return (
    <>
      <SettingsHeading
        title="Integrations"
        description="Clipfern posts through each platform's official, free API. You create the developer app once; nothing is shared with anyone else."
      />
      {PLATFORMS.map((p) => {
        const configured = p.fields.every((f) => keys?.[f.key]?.set);
        return (
          <SettingsCard
            key={p.id}
            id={p.id}
            title={p.name}
            description={p.summary}
            action={
              <div className="flex items-center gap-2.5">
                <Badge variant={configured ? 'success' : 'neutral'} dot>
                  {configured ? 'Credentials saved' : 'Needs setup'}
                </Badge>
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <p.icon className="size-5" />
                </span>
              </div>
            }
          >
            {p.notes}
            <Guide steps={p.steps} />
            <button
              type="button"
              onClick={() => void openExternal(p.link.url)}
              className="-mt-2 inline-flex items-center gap-1.5 self-start rounded-xs text-sm font-medium text-primary-text hover:underline"
            >
              {p.link.label} <ExternalLink className="size-3.5" aria-hidden />
            </button>
            <div className="grid grid-cols-2 gap-4 max-[1180px]:grid-cols-1">
              {p.fields.map((f) => (
                <SecretInput
                  key={f.key}
                  id={`secret-${f.key}`}
                  label={f.label}
                  status={keys?.[f.key]}
                  loading={loading}
                  onSave={(v) => save(f.key, v)}
                  onClear={() => clear(f.key)}
                />
              ))}
            </div>
            <div className="flex items-center gap-3 border-t pt-5">
              <DisabledTip reason="Account connection arrives in checkpoint 5">
                <Button variant="secondary" disabled>
                  <Link2 /> Connect account
                </Button>
              </DisabledTip>
              <span className="text-xs text-muted-foreground">
                Save the credentials first, then connect in checkpoint 5.
              </span>
            </div>
          </SettingsCard>
        );
      })}
    </>
  );
}
