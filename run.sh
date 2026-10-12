#!/usr/bin/env bash
# One-command launcher for Mac/Linux: creates the Python env, installs deps, starts the app, opens the browser.
# Usage:  ./run.sh        (first run takes a few minutes; later runs start in seconds)
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
URL="http://localhost:$PORT"

if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/config"; then
  echo "Clipper is already running (maybe an older copy in another terminal). Opening it."
  echo "To restart: stop the other one with Ctrl+C, then run ./run.sh again."
  (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true
  exit 0
fi

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
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  cp requirements.txt .venv/requirements.installed
fi
echo "Updating the YouTube downloader…"   # YouTube changes often; old yt-dlp versions stop working
.venv/bin/python -m pip install -q -U "yt-dlp[default]" >/dev/null 2>&1 || true
[ -f .env ] || cp .env.example .env

echo
echo "Clipper is starting at $URL  (press Ctrl+C to stop)"
echo "Paste your Anthropic API key in Settings (⚙, top right) the first time."
# Open the browser as soon as the app answers.
( for _ in $(seq 1 120); do
    if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/config"; then
      (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true
      break
    fi
    sleep 0.5
  done ) &
exec .venv/bin/python -m uvicorn backend.app.main:app --port "$PORT" --no-access-log
