import { Suspense } from 'react';
import { VideoDetail } from '@/components/pages/video-detail';

/**
 * Static export has no dynamic routes, so the video id travels in the query string: /library/video/?id=<videoId>.
 * `useSearchParams` needs a Suspense boundary at build time.
 */
export default function VideoPage() {
  return (
    <Suspense fallback={null}>
      <VideoDetail />
    </Suspense>
  );
}
