#!/bin/bash
# Builds a PRIVATE static export of the renderer for the Brand Kit page specs (never touches renderer/out).
#   test/e2e/support/brand-build.sh <work-dir> [<out-dir>]
# Several engineers build the renderer in parallel; a private copy keeps their exports from racing. Type errors in
# files owned by others do not block the export (ignoreBuildErrors), run `npx tsc -p renderer/tsconfig.json --noEmit`
# for the real check.
set -e
ROOT=${CLIPFERN_ROOT:-/home/user/Claude-code}
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
sed -i 's/ignoreBuildErrors: false/ignoreBuildErrors: true/' next.config.mjs
rm -rf .next out
npx next build 2>&1 | tail -${TAIL:-30}
rm -rf "$OUT"
cp -r out "$OUT"
echo "export at $OUT"
