'use client';

import * as React from 'react';
import { ClipboardCheck, ExternalLink, Gauge } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { useNowMs } from '@/lib/publish/now';
import { useAccounts, useSchedulerStatus } from '@/lib/publish/queries';
import { cn } from '@/lib/utils';
import { QuotaMeter } from '@/components/scheduler/accounts-strip';
import { openExternal } from './common';

const Link = ({ url, children }: { url: string; children: React.ReactNode }) => (
  <button
    type="button"
    onClick={() => void openExternal(url)}
    className="inline-flex items-center gap-1 rounded-xs font-medium text-primary-text underline-offset-2 hover:underline"
  >
    {children} <ExternalLink className="size-3" aria-hidden />
  </button>
);

/* ------------------------------------------------------------------------------ YouTube quota ----- */

/** What YouTube allows per day, how to see what is left, and how to ask Google for more (free). */
export function YoutubeQuotaExplainer() {
  const now = useNowMs();
  const accounts = useAccounts().data?.accounts.filter((a) => a.platform === 'shorts') ?? [];
  const quota = useSchedulerStatus().data?.quota.filter((q) => q.platform === 'shorts') ?? [];
  return (
    <section
      aria-label="YouTube quota"
      className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-4"
      data-testid="youtube-quota"
    >
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-primary-text" aria-hidden />
        <h3 className="text-sm font-semibold">YouTube&apos;s daily quota</h3>
      </div>
      <dl className="grid grid-cols-3 gap-3 max-[760px]:grid-cols-1">
        {[
          [
            'Default allowance',
            '100 uploads a day',
            'Per Google Cloud project: uploads have their own bucket. Every other call shares 10,000 units.',
          ],
          [
            'One upload costs',
            '1 unit',
            'Older guides say ≈ 1,600 of 10,000 units (about 6 a day); YouTube’s quota page now lists a separate upload bucket.',
          ],
          [
            'It resets',
            'Midnight Pacific time',
            'Clipfern shows how many posts still fit and waits for the reset.',
          ],
        ].map(([k, v, hint]) => (
          <div key={k} className="rounded-lg border bg-card px-3.5 py-3">
            <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle">{k}</dt>
            <dd className="mt-1 font-display text-md font-semibold tabular-nums">{v}</dd>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{hint}</p>
          </div>
        ))}
      </dl>
      {accounts.length && quota.length ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-3.5">
          {quota.map((q) => (
            <div key={q.accountId}>
              <p className="mb-1.5 text-xs font-medium">
                {accounts.find((a) => a.id === q.accountId)?.displayName ?? 'YouTube channel'}
              </p>
              <QuotaMeter quota={q} now={now} />
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Need more than 100 a day? Ask Google, it is free.</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
          <li>
            Open the{' '}
            <strong className="text-foreground">
              YouTube API Services – Audit and Quota Extension
            </strong>{' '}
            form (search for it in the{' '}
            <Link url="https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits">
              YouTube API docs
            </Link>
            ).
          </li>
          <li>
            Say what Clipfern does: it uploads your own clips to your own channel on a schedule.
          </li>
          <li>
            Answer the compliance questions and submit. Google usually replies within a few weeks.
          </li>
        </ol>
        <Banner
          tone="info"
          className="mt-1 py-2.5 text-xs"
          title="If your Shorts upload as private"
        >
          Google can keep uploads from a brand-new, unverified API project private until that
          project passes the same audit. If that happens to you, the audit form above is also the
          fix.
        </Banner>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------- TikTok audit ----- */

interface AuditItem {
  id: string;
  title: string;
  body: React.ReactNode;
}

const AUDIT_KEY = 'clipfern.tiktok.audit';

const AUDIT_ITEMS: AuditItem[] = [
  {
    id: 'details',
    title: 'Fill in the app details',
    body: 'App name, a 1024×1024 icon, a category and a short description of what the app does for you (for example “Posts my own short clips to my own TikTok account on a schedule”).',
  },
  {
    id: 'legal',
    title: 'Publish a privacy policy and terms of service',
    body: 'TikTok asks for public URLs for both. A one-page site or a public document is usually enough. They must describe what you do with TikTok data (here: nothing leaves your computer).',
  },
  {
    id: 'products',
    title: 'Add Login Kit and Content Posting API, and switch on Direct Post',
    body: 'Both products must be added to the app. Direct Post is a separate switch inside Content Posting API, and it is the part that gets audited.',
  },
  {
    id: 'scopes',
    title: 'Justify each scope in one sentence',
    body: (
      <>
        Request{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">user.info.basic</code>,{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">video.publish</code> and{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">video.upload</code>. For
        each, say why: show my account name, publish my clip to my account, upload my clip to my
        drafts.
      </>
    ),
  },
  {
    id: 'redirect',
    title: 'Register the redirect URI',
    body: 'Copy the exact address from the “Redirect URI to register” box above into the app’s Login Kit settings.',
  },
  {
    id: 'demo',
    title: 'Record a demo video of the whole flow',
    body: 'A screen recording of this app: connect your TikTok account, pick a clip, choose who can watch and the comment/Duet/Stitch options, post, then show it in TikTok. TikTok’s reviewers usually look for your account name being shown, a privacy choice with no pre-selected public option, interaction toggles, a commercial-content disclosure, and a preview of the video. Clipfern’s schedule dialog shows all of them.',
  },
  {
    id: 'submit',
    title: 'Submit the app for review',
    body: 'In the developer portal, submit the app with the demo video attached. TikTok does not promise a turnaround; plan on days to a few weeks, and answer reviewer questions quickly.',
  },
  {
    id: 'after',
    title: 'After approval, reconnect and switch to public',
    body: 'Disconnect and reconnect the account so the new permissions apply. Then “Who can watch” unlocks Everyone, Friends and Followers, and Clipfern posts publicly without any other change.',
  },
];

function readAudit(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(AUDIT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** What the free TikTok audit asks for, as a tick-off list (progress is remembered on this computer only). */
export function TiktokAuditChecklist() {
  const [done, setDone] = React.useState<string[]>(readAudit);
  const toggle = (id: string, on: boolean) =>
    setDone((prev) => {
      const next = on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id);
      try {
        localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the ticks simply are not remembered */
      }
      return next;
    });
  const pct = Math.round(
    (done.filter((d) => AUDIT_ITEMS.some((i) => i.id === d)).length / AUDIT_ITEMS.length) * 100,
  );
  return (
    <section
      id="tiktok-audit"
      aria-labelledby="tiktok-audit-title"
      className="flex scroll-mt-24 flex-col gap-4 rounded-xl border bg-muted/20 p-4"
      data-testid="tiktok-audit"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ClipboardCheck className="size-4 text-primary-text" aria-hidden />
        <h3 id="tiktok-audit-title" className="text-sm font-semibold">
          TikTok audit checklist
        </h3>
        <span
          className="ml-auto text-xs tabular-nums text-muted-foreground"
          data-testid="audit-progress"
        >
          {pct}% done
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label="Audit checklist progress" />
      <p className="text-sm text-muted-foreground">
        Until TikTok audits your app, every direct post is private to you. The audit is free. This
        is what it typically asks for; TikTok changes the process now and then, so follow the
        current instructions in the{' '}
        <Link url="https://developers.tiktok.com/doc/content-sharing-guidelines">
          Content Sharing Guidelines
        </Link>{' '}
        and the developer portal.
      </p>
      <ol className="flex flex-col gap-1" aria-label="Audit steps">
        {AUDIT_ITEMS.map((item, i) => {
          const on = done.includes(item.id);
          return (
            <li key={item.id}>
              <div className="flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/40">
                <Checkbox
                  id={`audit-${item.id}`}
                  checked={on}
                  aria-label={item.title}
                  onCheckedChange={(v) => toggle(item.id, v)}
                  className="mt-0.5"
                  data-testid="audit-check"
                />
                <div className="min-w-0">
                  <label
                    htmlFor={`audit-${item.id}`}
                    className={cn(
                      'cursor-pointer text-sm font-medium',
                      on && 'text-muted-foreground line-through decoration-subtle',
                    )}
                  >
                    {i + 1}. {item.title}
                  </label>
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{item.body}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <Banner tone="info" className="py-2.5 text-xs" title="Meanwhile: upload to drafts">
        Pick <strong>Upload to drafts</strong> when you schedule a TikTok. The video lands in your
        TikTok inbox and you press Post in the app, so it can be public today.
      </Banner>
    </section>
  );
}
