'use client';

import * as React from 'react';
import Link from 'next/link';
import { BadgeDollarSign, Check, KeyRound, Megaphone, Receipt, Store, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/skeleton';
import { invoke } from '@/lib/ipc';
import { useSecrets } from '@/lib/settings';
import type { ValidationResult } from '@shared/domain';

const PREVIEW = [
  {
    icon: Megaphone,
    title: 'Campaigns',
    text: 'Content Rewards campaigns you joined or can join: payout per 1k views, caps, rules and deadlines.',
  },
  {
    icon: Receipt,
    title: 'Submissions',
    text: 'Post links submitted per campaign, with approval status and view counts.',
  },
  {
    icon: BadgeDollarSign,
    title: 'Earnings',
    text: 'Estimated and paid earnings, with alerts when a matching campaign opens.',
  },
];

export function WhopView() {
  const { keys, loading } = useSecrets();
  const hasKey = keys?.['whop.apiKey']?.set === true;
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ValidationResult | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await invoke('validate:run', { service: 'whop' }));
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : 'Test failed',
        latencyMs: 0,
        detail: null,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Whop"
        description="Find Content Rewards campaigns that fit your videos, track submissions and see what you've earned."
      />
      <Card className="overflow-hidden">
        {loading ? (
          <CardContent className="py-16">
            <Skeleton className="mx-auto h-40 max-w-md" />
          </CardContent>
        ) : hasKey ? (
          <EmptyState
            size="lg"
            icon={Check}
            title="Whop key saved"
            description="Your key is stored in the OS keychain. Campaign sync, submissions and earnings arrive in checkpoint 6, so there is nothing to show yet."
            actions={
              <>
                <Button variant="soft" onClick={test} loading={testing}>
                  Test key
                </Button>
                <Button variant="outline" asChild>
                  <Link href="/settings/api-keys/">Manage key</Link>
                </Button>
              </>
            }
          >
            {result ? (
              <Badge variant={result.ok ? 'success' : 'danger'} className="mt-4" role="status">
                {result.ok ? <Check /> : <X />}
                {result.ok ? 'Key works' : 'Key failed'} · {Math.round(result.latencyMs)} ms ·{' '}
                {result.message}
              </Badge>
            ) : null}
          </EmptyState>
        ) : (
          <EmptyState
            size="lg"
            icon={Store}
            title="Connect Whop to see campaigns"
            description="Add your Whop API key and Clipfern will list the Content Rewards campaigns you can clip for, and warn you when a clip breaks a campaign's rules."
            steps={[
              'Create an API key in your Whop developer dashboard.',
              'Paste it in Settings → API Keys and press Test.',
              'Campaigns appear here once sync ships in checkpoint 6.',
            ]}
            actions={
              <Button variant="primary" asChild>
                <Link href="/settings/api-keys/">
                  <KeyRound /> Add Whop API key
                </Link>
              </Button>
            }
          />
        )}
      </Card>
      <section aria-label="What this page will show">
        <h2 className="mb-3 font-display text-lg font-semibold">What you&apos;ll see here</h2>
        <ul className="grid grid-cols-3 gap-4 max-[1180px]:grid-cols-1">
          {PREVIEW.map((p) => (
            <li
              key={p.title}
              className="flex gap-3 rounded-xl border border-dashed border-border-strong bg-card/50 p-4"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <p.icon className="size-[18px]" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">{p.title}</p>
                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{p.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
