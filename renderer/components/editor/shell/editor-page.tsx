'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { EditorWorkspace } from './workspace';
import { ProjectPicker } from './project-picker';

/** `/editor/?id=<projectId>` (static export: the id travels in the query string, like `/library/video/?id=`). */
export function EditorPage() {
  const params = useSearchParams();
  const id = params.get('id');
  return id ? <EditorWorkspace key={id} projectId={id} /> : <ProjectPicker />;
}
