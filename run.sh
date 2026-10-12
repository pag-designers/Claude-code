#!/usr/bin/env bash
# One-command launcher for Mac/Linux: creates the Python env, installs deps, starts the app, opens the browser.
# Usage:  ./run.sh        (first run takes a few minutes; later runs start in seconds)
set -e
cd "$(dirname "$0")"

# Auto-update: if this folder came from "git clone", pull the newest version first.
# Your videos, clips, exports and API key (data/, output/, .env) are never touched by this.
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo "Checking for updates…"
  before=$(git rev-parse HEAD)
  if git pull --ff-only --quiet; then
    [ "$before" = "$(git rev-parse HEAD)" ] && echo "Up to date." || echo "Updated to the newest version."
  else
    echo "Could not update right now — starting the version you have."
  fi
fi

PY=""
for c in python3.12 python3.11 python3.13 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.11+ not found. Install it:  mac: brew install python@3.12   ubuntu: sudo apt install python3.12 python3.12-venv"
  exit 1
fi
for tool in ffmpeg node; do
  if ! command -v $tool >/dev/null 2>&1; then
    echo "$tool is not installed."
    [ "$tool" = ffmpeg ] && echo "  mac: brew install ffmpeg   ubuntu: sudo apt install ffmpeg"
    [ "$tool" = node ]   && echo "  mac: brew install node     ubuntu: sudo apt install nodejs"
    exit 1
  fi
done

if [ ! -x .venv/bin/python ]; then
  echo "Creating Python environment (.venv)…"
  "$PY" -m venv .venv
fi
if ! cmp -s requirements.txt .venv/requirements.installed; then  # first run, or requirements changed in an update
  echo "Installing dependencies (first time: 3–5 minutes; after updates: usually under a minute)…"
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
  cp requirements.txt .venv/requirements.installed
fi
[ -f .env ] || cp .env.example .env

PORT="${PORT:-8000}"
URL="http://localhost:$PORT"
echo
echo "Clipper is starting at $URL  (press Ctrl+C to stop)"
echo "Paste your Anthropic API key in Settings (⚙, top right) the first time."
( sleep 2; command -v open >/dev/null && open "$URL" || command -v xdg-open >/dev/null && xdg-open "$URL" || true ) &
exec .venv/bin/uvicorn backend.app.main:app --port "$PORT"
