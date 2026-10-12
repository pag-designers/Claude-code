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
- **Transcription:** faster-whisper (CPU, word timestamps) + approximate speaker labels (voice-fingerprint clustering; on-screen mouth movement used for framing)
- **AI analysis:** Claude API, strict JSON outputs, transcript fed in timestamped chunks
- **Video:** FFmpeg (cuts, encoding, burned-in ASS captions), MediaPipe (face / active-speaker tracking)
- **Frontend:** plain HTML + JS served by FastAPI (no build step)

## Folder layout
```
CLAUDE.md               this file. Keep "Current status" up to date
.env.example            template for secrets/settings → copy to .env (git-ignored)
requirements.txt        Python deps
scripts/doctor.py       checks python/node/ffmpeg/yt-dlp/API key
scripts/phase2_test.py  ingest + transcribe + cues on a file/URL from the command line
scripts/render_test.py  render a hand-picked sentence range in every layout/style (no AI)
docs/                   Wayin teardown, spec, screenshots (docs/img/)
prompts/                clipping.md, scoring.md (the viral-score rubric)
assets/fonts/           bundled OFL caption fonts (Poppins, Anton, Bebas Neue)
backend/app/
  main.py               FastAPI routes (the web API)
  pipeline.py           background jobs: ingest → transcribe → cues → clipping → scoring; previews; exports
  ingest.py             yt-dlp download / file import, ffprobe, audio extraction
  transcribe.py         faster-whisper word timestamps → sentences → approximate speaker labels
  cues.py               loudness peaks, scene changes, reaction words
  llm.py                every Claude call: structured JSON, caching, refusal fallback, cost log
  clipping.py           AI Clipping (chunked transcript → candidates)
  boundaries.py         deterministic cut rules (sentence snapping, length ranges, filler trim, dedupe)
  scoring.py            Viral Score (6 dimensions, weighted, reach ceiling)
  moments.py            Find Moments (natural-language search)
  reframe.py            MediaPipe face/mouth tracking on tiled frames, scene cuts → per-shot layout plan
  captions.py           ASS caption styles + hook/brand overlays
  timeline.py           text-edit ranges and source→output time mapping
  render.py             FFmpeg render: cut → per-shot crop/split/fit → speed/zoom → captions → 1080x1920
  campaign.py           Campaign Requirements Checker (parse, check, auto-fix, checklist.md)
  variants.py           originality engine (3 variants) + per-platform titles/captions/hashtags
  export.py             output/<campaign>/<clip>/ bundle
frontend/               index.html + app.js + style.css (no build step)
tests/                  pytest: boundaries, AI plumbing (fake LLM), campaign checks
data/                   cache per video: source.mp4, audio.wav, transcript.json, cues.json, clips.json, renders/ (git-ignored)
output/                 exports: output/<campaign>/<clip>/ (git-ignored)
index.html              pre-existing, UNRELATED barbershop landing page. Leave it alone
```

## How to run
```bash
python3.12 -m venv .venv                 # isolated Python env for this project
source .venv/bin/activate                # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                     # then paste your ANTHROPIC_API_KEY into .env
python scripts/doctor.py                 # every line should say OK
uvicorn backend.app.main:app --port 8000 # then open http://localhost:8000
pytest -q                                # unit tests (no API calls)
```
First run downloads the Whisper model (~500 MB for "small") and the MediaPipe face model (~4 MB).
On headless Linux, MediaPipe needs `sudo apt install libegl1 libgles2` (otherwise it falls back to OpenCV faces).

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
- **Phase 0 setup: DONE.** **Phase 1 teardown: DONE**, except §6 (logged-in Wayin results page), which needs the user's browser.
- **Phase 2 ingest + transcript: DONE, tested** (10-min CC podcast: 1,856 words, 142 sentences, ~4 min on 4 CPUs with `small`).
- **Phases 3–5 AI clipping / viral score / find moments: BUILT, plumbing tested with a fake LLM. NOT yet run
  against the real Claude API** (no key in the cloud session). First real run: check clip quality + log cost.
- **Phase 6 render: DONE, tested**: per-shot layouts (track / split / speaker / fit), 4 caption styles, hook + brand overlays.
- **Phase 7 text editing: DONE, tested** (click words to cut; nudge start/end by sentence).
- **Phase 8 campaign checker, variants, platform captions, export: DONE, tested** (code checks + fixes verified;
  AI-judged rules and AI captions need the key; without a key, variants use template captions).
- **Phase 9 web UI: DONE, tested with Playwright** (home, campaign, clips grid, editor, previews, variants, bulk export, mobile).
- Known limits: speaker labels from audio are approximate; Playwright's Chromium can't play H.264 (real Chrome/Safari can);
  YouTube download blocked in the cloud container (works on a home connection).
- Next: run with a real API key on a real video → tune prompts/scoring.md from results; fill teardown §6 if the user logs in.
