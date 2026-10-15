import { Suspense } from 'react';
import { EditorPage } from '@/components/editor/shell/editor-page';

/**
 * Static export has no dynamic routes, so the project id travels in the query string: /editor/?id=<projectId>.
 * `useSearchParams` needs a Suspense boundary at build time.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <EditorPage />
    </Suspense>
  );
}
