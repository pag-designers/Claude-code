#!/bin/bash
# Builds a PRIVATE static export of the renderer plus the inspector lab route (never touches renderer/out).
#   test/e2e/support/inspector-lab/build-lab.sh <work-dir> [<out-dir>]
# The lab route (/inspector-lab/) mounts <Inspector/> next to a stage. If the real editor-core store
# (renderer/lib/editor/core/index.ts) does not exist yet, a faithful fake (fake-store.ts) is dropped in as
# '@/lib/editor/core'; once the real one exists it is used as is.
set -e
ROOT=/home/user/Claude-code
HERE=$ROOT/test/e2e/support/inspector-lab
WORK=${1:?work dir}
OUT=${2:-$WORK/out}
mkdir -p "$WORK/renderer"
cd "$WORK"
[ -e node_modules ] || ln -s "$ROOT/node_modules" node_modules
[ -e shared ] || ln -s "$ROOT/shared" shared
cd renderer
rm -rf app components lib public
for d in app components lib public; do cp -a "$ROOT/renderer/$d" "$d"; done
cp "$ROOT/renderer/"{next.config.mjs,postcss.config.mjs,tsconfig.json} .
# the other editor modules are developed in parallel and need the REAL core: the lab keeps only what the inspector and
# the library (open-in-editor) need
rm -rf app/editor app/design/editor-panels components/editor/timeline components/editor/preview components/editor/shell lib/editor/playback
find components/editor/panels -type f ! -name open-in-editor.tsx -delete
sed -i 's/ignoreBuildErrors: false/ignoreBuildErrors: true/' next.config.mjs
mkdir -p app/editor app/inspector-lab
echo 'export default function EditorPlaceholder() { return null; }' > app/editor/page.tsx
cp "$HERE/lab-page.tsx.txt" app/inspector-lab/page.tsx
cp "$HERE/lab-project.ts" app/inspector-lab/lab-project.ts
sed -i "s#'../../../../shared/editor'#'@shared/editor'#" app/inspector-lab/lab-project.ts
if [ ! -e lib/editor/core/index.ts ]; then
  mkdir -p lib/editor/core
  cp "$HERE/fake-store.ts" lib/editor/core/fake-store.ts
  cat > lib/editor/core/index.ts <<'EOT'
import type { StoreApi, UseBoundStore } from 'zustand';
import type { EditorStore } from './api';
import { useFakeEditorStore } from './fake-store';
export const useEditorStore = useFakeEditorStore as unknown as UseBoundStore<StoreApi<EditorStore>>;
export type { AnimatedPath, DeepPartial, EditorStore, Selection } from './api';
EOT
  echo "lab: using the FAKE editor-core store"
else
  echo "lab: using the REAL editor-core store"
fi
rm -rf .next out
npx next build 2>&1 | tail -${TAIL:-30}
rm -rf "$OUT"
cp -r out "$OUT"
echo "export at $OUT"
