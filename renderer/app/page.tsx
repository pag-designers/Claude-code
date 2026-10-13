import { ContinueList } from '@/components/pages/continue-list';
import { HomeHero } from '@/components/pages/home-hero';
import { HomeStats } from '@/components/pages/home-stats';
import { RunningVideos } from '@/components/pages/running-videos';
import { SetupChecklist } from '@/components/pages/setup-checklist';
import { Page } from '@/components/ui/page';

export default function HomePage() {
  return (
    <Page>
      <HomeHero />
      <HomeStats />
      <div className="grid grid-cols-5 items-start gap-6 max-[1180px]:grid-cols-1">
        <div className="col-span-3 flex flex-col gap-6 max-[1180px]:col-span-1">
          <RunningVideos />
          <ContinueList />
        </div>
        <div className="col-span-2 max-[1180px]:col-span-1">
          <SetupChecklist />
        </div>
      </div>
    </Page>
  );
}
