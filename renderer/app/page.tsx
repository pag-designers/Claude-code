import { Clock } from 'lucide-react';
import { HomeHero } from '@/components/pages/home-hero';
import { HomeStats } from '@/components/pages/home-stats';
import { JobsPanel } from '@/components/pages/jobs-panel';
import { SetupChecklist } from '@/components/pages/setup-checklist';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Page } from '@/components/ui/page';

export default function HomePage() {
  return (
    <Page>
      <HomeHero />
      <HomeStats />
      <div className="grid grid-cols-5 items-start gap-6 max-[1180px]:grid-cols-1">
        <div className="col-span-3 flex flex-col gap-6 max-[1180px]:col-span-1">
          <JobsPanel />
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">Continue where you left off</CardTitle>
              <CardDescription>Recent projects open straight into their clips.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <EmptyState
                size="sm"
                icon={Clock}
                title="No projects yet"
                description="Your first video will appear here with its clips, transcript and chapters, ready to pick up any time."
              />
            </CardContent>
          </Card>
        </div>
        <div className="col-span-2 max-[1180px]:col-span-1">
          <SetupChecklist />
        </div>
      </div>
    </Page>
  );
}
