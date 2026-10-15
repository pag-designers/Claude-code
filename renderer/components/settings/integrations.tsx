'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { Platform as PostPlatform } from '@shared/cp2';
import type { SecretKey } from '@shared/secrets';
import { Banner } from '@/components/ui/banner';
import { Badge } from '@/components/ui/badge';
import { InstagramGlyph, TiktokGlyph, YoutubeGlyph } from '@/components/ui/brand-icons';
import { SecretInput } from '@/components/ui/secret-input';
import { useAccounts } from '@/lib/publish/queries';
import { useSecretActions, useSecrets } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { SettingsCard, openExternal } from './common';
import { PlatformAccounts } from './platform-accounts';
import { TiktokAuditChecklist, YoutubeQuotaExplainer } from './platform-guides';
import { SettingsHeading } from './settings-shell';

interface Step {
  title: string;
  body: React.ReactNode;
}
interface Platform {
  id: string;
  /** The posting platform id this card connects accounts for. */
  platform: PostPlatform;
  name: string;
  icon: typeof YoutubeGlyph;
  summary: string;
  steps: Step[];
  fields: { key: SecretKey; label: string }[];
  notes: React.ReactNode;
  /** Explainer rendered under the accounts (YouTube quota, TikTok audit checklist). */
  extra?: React.ReactNode;
  link: { label: string; url: string };
}

const code = (t: string) => (
  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{t}</code>
);

const PLATFORMS: Platform[] = [
  {
    id: 'youtube',
    platform: 'shorts',
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
            scopes {code('youtube.upload')} and {code('youtube.readonly')} (channel name and view
            counts). Then click <strong>Publish app</strong>: personal use needs no verification,
            but apps left in “Testing” have refresh tokens that expire every 7 days.
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
    notes: null,
    extra: <YoutubeQuotaExplainer />,
  },
  {
    id: 'instagram',
    platform: 'reels',
    name: 'Instagram Reels',
    icon: InstagramGlyph,
    summary:
      'Publishes Reels through “Instagram API with Instagram login” using a Meta developer app in Development mode.',
    link: { label: 'Open Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    steps: [
      {
        title: 'Prepare your account',
        body: 'Switch Instagram to a Business or Creator account (Settings → Account type). No Facebook Page is needed for this login.',
      },
      {
        title: 'Create a Meta app',
        body: 'At developers.facebook.com create an app of type Business, then add the product Instagram and open “API setup with Instagram login”.',
      },
      {
        title: 'Add Instagram publishing',
        body: (
          <>
            Enable {code('instagram_business_basic')}, {code('instagram_business_content_publish')}{' '}
            and {code('instagram_business_manage_comments')} (the last is only used for the first
            comment).
          </>
        ),
      },
      {
        title: 'Add your account as a tester and stay in Development mode',
        body: 'App roles → Roles → Instagram testers: add your Instagram account and accept the invite in the Instagram app. Development mode is meant for accounts you own, so no App Review should be needed (Meta does not spell this out; tell us if it asks).',
      },
      {
        title: 'Register the redirect',
        body: (
          <>
            Copy the exact redirect URI shown under “Connected accounts” below into{' '}
            <strong>Valid OAuth redirect URIs</strong> of the Instagram login settings. Meta may
            insist on https for this field and refuse an {code('http://127.0.0.1')} address; we
            could not confirm either way. If it refuses, Connect will not work yet.
          </>
        ),
      },
      {
        title: 'Paste the app credentials below',
        body: 'On the same “API setup with Instagram login” page, copy the Instagram app ID and Instagram app secret. They are not the same as the Meta App ID at the top of the app.',
      },
    ],
    fields: [
      { key: 'meta.appId', label: 'Instagram app ID' },
      { key: 'meta.appSecret', label: 'Instagram app secret' },
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
    platform: 'tiktok',
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
        body: 'Copy the exact redirect URI shown under “Connected accounts” below into the app’s Login Kit settings. For desktop apps TikTok accepts only http(s) on localhost or 127.0.0.1 with a port, no query string or fragment.',
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
        drafts so you publish from the TikTok app. The audit checklist below walks you through it.
      </Banner>
    ),
    extra: <TiktokAuditChecklist />,
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
  // deep links such as /settings/integrations/#tiktok-audit: the cards fill in after the page loads (accounts, quota),
  // so scroll once they have, or the target would move away again
  const accountsReady = useAccounts().isSuccess;
  const scrolled = React.useRef(false);
  React.useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !accountsReady || scrolled.current) return;
    const t = window.setTimeout(() => {
      scrolled.current = true;
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }, 80);
    return () => window.clearTimeout(t);
  }, [accountsReady]);
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
            <PlatformAccounts platform={p.platform} />
            {p.extra}
          </SettingsCard>
        );
      })}
    </>
  );
}
