# Clipper — my own AI clipping tool

## Goal
A local web app that turns long-form videos (podcasts, interviews, streams) into high-quality
9:16 clips for **Whop Content Rewards** campaigns. Clips only get paid (per 1,000 views) if they meet
each campaign's rules (length, brand mention, hashtags/tags, language, banned content, format).
Budgets are first-come-first-served, so **speed matters**. Platforms penalize low-originality,
duplicate-looking clips, so **every export must be visibly distinct**.

## Stack
- **Backend:** Python 3.12 + FastAPI
- **Ingest:** yt-dlp (YouTube/URLs) or file upload
- **Transcription:** faster-whisper (CPU, word timestamps) + speaker labels (WhisperX/pyannote, decided in Phase 2)
- **AI analysis:** Claude API, strict JSON outputs, transcript fed in timestamped chunks
- **Video:** FFmpeg (cuts, encoding, burned-in ASS captions), MediaPipe (face / active-speaker tracking)
- **Frontend:** simple static web UI served by FastAPI (Phase 9)

## Folder layout
```
CLAUDE.md          this file. Keep "Current status" up to date
.env.example       template for secrets → copy to .env (git-ignored)
requirements.txt   Python deps (grows each phase)
scripts/doctor.py  checks python/node/ffmpeg/yt-dlp/API key
docs/              research + spec (Phase 1); screenshots in docs/img/
prompts/           Claude prompt files, e.g. prompts/scoring.md (Phase 4)
backend/           FastAPI app (Phase 2+)
frontend/          web UI (Phase 9)
data/              cache: downloads, transcripts (git-ignored)
output/            exports: output/<campaign>/<clip>/ (git-ignored)
index.html         pre-existing, UNRELATED barbershop landing page. Leave it alone
```

## How to run
```bash
python3.12 -m venv .venv                 # isolated Python env for this project
source .venv/bin/activate                # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                     # then paste your ANTHROPIC_API_KEY into .env
python scripts/doctor.py                 # every line should say OK
```
(The app server command gets added here in Phase 2.)

## Conventions
- Commit after every phase; update "Current status" below first.
- All Claude calls return strict JSON validated against a schema; prompts live in `prompts/`.
- Cache everything expensive (downloads, transcripts, AI results) under `data/<video_id>/`.
- yt-dlp needs a JS runtime for YouTube: always pass `--js-runtimes node`.
- Research on WayinVideo is observation only. Never copy their code/assets/branding or call their private APIs.

## Environment notes
- The Claude Code **cloud** container: no GPU, 4 CPUs, 15 GB RAM. YouTube **blocks video downloads**
  from its datacenter IP ("Sign in to confirm you're not a bot"); metadata still works. On a home
  connection, downloads work normally. In the cloud, test with uploaded files or archive.org videos.
- archive.org, Wikimedia Commons and api.anthropic.com are reachable from the cloud container.

## Current status
**Phase 0: setup. DONE.** Python 3.12.3 (.venv), Node 22.22, ffmpeg 6.1.1, yt-dlp 2026.08.19.

**Phase 1: Wayin teardown. IN PROGRESS.**
- Done: public pages, help center, pricing, Whop rules research → `docs/wayin-teardown.md` (§1–5, 7–8), `docs/spec.md` draft.
- Pending: §6, the logged-in results page. The user logs in themselves in their own Opera browser; Claude reads it via the
  Opera MCP connector (needs "Allow AI connection" enabled in Opera's Browser Connector).
- Pending: the user's OK on `docs/spec.md`.
- Waiting on: ANTHROPIC_API_KEY as a cloud environment secret (needed from Phase 3).
- Dev tooling: Playwright is in .venv; launch with executable_path=/opt/pw-browsers/chromium-1194/chrome-linux/chrome in the cloud.
