# Clipper: feature spec (v1)

**One-liner:** paste a long video and a Whop campaign brief. Get ranked, campaign-compliant, visibly original
9:16 clips with per-platform captions, ready to post before the budget runs out.

**Design principles**
1. **Compliance first.** A clip that breaks a written campaign rule earns $0 however good it is, so every clip carries a rule-by-rule pass/fail.
2. **Speed to post.** The best clips show up first; exporting one clip shouldn't wait for twenty.
3. **Originality by default.** Every moment can render as 3 visibly different variants.
4. **AI proposes, code verifies.** Claude picks moments and writes text. Deterministic code enforces sentence boundaries, length limits and rule checks, so model mistakes can't slip through.
5. **Local and cheap.** Runs on your laptop. You pay only Claude API tokens: no credits, no export expiry, no watermark.

---

## Pipeline
```
URL/file ─► ingest (yt-dlp) ─► transcribe (words + timestamps + speakers) ─► cache data/<id>/
        ─► AI clipping (Claude, chunked) ─► boundary snapping + validation (code)
        ─► viral score (Claude, rubric in prompts/scoring.md)
        ─► campaign check (rules parsed by Claude, checked by code) ─► auto-fix
        ─► render variants (FFmpeg + MediaPipe + ASS captions) ─► export bundle
```

## Features by phase (each one has a test that proves it works)

### P2: Ingest + transcript
- Paste a URL (yt-dlp, `--js-runtimes node`, best ≤1080p) **or** upload a file.
- **faster-whisper** on CPU (int8): word-level timestamps, auto language detection (Spanish/English at minimum).
  Model `small` by default for speed, `medium`/`large-v3` as a "quality" option.
- **Speaker labels:** pyannote (needs a free Hugging Face token; slow on CPU) as an option, plus a
  visual fallback that uses MediaPipe face/mouth movement to tell who's talking. Final choice after benchmarking in P2.
- Everything is cached to `data/<video_id>/` (`source.mp4`, `transcript.json`), so re-runs are instant.
- **Done when:** a 15-min video gives a transcript JSON with words, times, speakers and sentence segments.

### P3: AI Clipping
- The transcript goes to Claude in **timestamped chunks** (~5–8 min, overlapping) as `[mm:ss.s] S1: sentence`.
- Claude returns strict JSON: 10–20 candidates `{start, end, category, title, why, hook_line, payoff_line}`.
- **Categories:** `hook` (fast hooks/reactions/memes, 15–30s) · `value` (story/value/Q&A, 30–60s) · `context` (setup → payoff, 60–90s).
- **Visual cues:** laughter/applause in the transcript, energy peaks in the audio track (loudness), scene changes (FFmpeg), and face reactions (MediaPipe) are passed to Claude as cue markers.
- **Boundary snapping (code):** start on the first word of a sentence; end on the last word of a sentence that completes the payoff; trim leading fillers ("so", "um", "y bueno"). Never mid-sentence.
- Duplicates across chunks are merged.
- **Done when:** a real video yields ≥10 clips, all starting and ending on sentence boundaries (checked automatically).

### P4: Viral Score 0–100
- Six dimensions, 0–100 each, with a one-line reason **and a concrete fix**: **Hook, Story, Value, Engagement, Reach, Pacing**.
- Overall = weighted (Hook 25, Story 20, Value 20, Engagement 15, Reach 10, Pacing 10). Reach acts as a soft ceiling, as in Wayin's model.
- Pacing is partly measured by code (words/sec, longest silence, filler ratio) and fed to Claude.
- The rubric, with example 90-score vs 40-score hooks in EN and ES, lives in `prompts/scoring.md`.
- **Done when:** scores are stable (±5 between runs on the same clip) and the ranking matches my own taste on a test video.

### P5: Find Moments
- Natural-language query ("funny moments", "cuando habla de deudas") → scored results, each with exact timestamps, a quote and a "matches because…" line.
- Uses the cached transcript plus cue markers; returns clips that obey the same boundary rules.

### P6: Render
- 1080×1920, H.264 + AAC, 30fps, `-movflags +faststart`.
- **Face-tracking reframe:** MediaPipe face detection on sampled frames → smoothed crop path (no jitter).
- **Split-screen** when two speakers are on screen (top/bottom), and **blurred-background fit** for wide shots or screens.
- **Animated word-by-word captions** via ASS, at least 3 styles: `bold-pop` (active word scales and changes color), `karaoke` (fill sweep), `clean-minimal` (2 lines, subtle highlight). Keywords and emojis optional.
- **Hook text overlay** for the first 1–3s (AI-written, editable).

### P7: Text-based editing
- The clip transcript is shown as clickable words; delete words or sentences → re-cut (with micro-crossfades to hide jumps).
- Filler and silence removal with one click.

### P8: My edge
1. **Campaign Requirements Checker**: paste the brief → Claude parses it into typed rules
   (`length_range`, `must_mention`, `required_hashtags`, `required_tags`, `language`, `banned_topics`,
   `no_watermark`, `aspect_ratio`, `platforms`, `caption_required`, `custom`). **Code checks each rule** against each clip
   (duration, transcript text, captions, metadata) → ✅/❌ with a reason. Auto-fixes: trim or extend to the length range,
   add brand text overlay, add required hashtags/tags to captions, force caption language. Rules code can't verify (e.g. "positive tone")
   go to Claude and are marked "AI-judged".
2. **Originality engine**: 3 variants per moment that differ in **hook text, caption style, cut point (±1 sentence), zoom/pacing (punch-ins, speed 1.0–1.1×), and the opening frame**. A difference check makes sure variants don't share the same first 2s and caption style.
3. **Per-platform metadata**: title, caption and hashtags for TikTok, YouTube Shorts, Instagram Reels and X, respecting each platform's length limits and the campaign's required tags.
4. **Export bundle**: `output/<campaign>/<clip>/` → `clip.mp4` (+ `variant-2.mp4`, `variant-3.mp4`), `caption.txt` (per platform), `requirements-checklist.md`.

### P9: Web UI
- Paste URL (+ optional campaign brief) → progress (download → transcribe → clip → score) → **ranked clip cards** (score, breakdown, compliance badges, preview) → edit (trim, text-edit, hook, style) → choose variants → **bulk export**.
- Fast path: the top 3 clips render first so you can post while the rest finish.

---

## Where it beats WayinVideo

| | WayinVideo | Clipper |
|---|---|---|
| Campaign rule check | none | **parse brief → per-rule ✅/❌ + auto-fix + checklist file** |
| Originality | 1 render per moment | **3 distinct variants per moment**, difference-checked |
| Score explanation | number free; breakdown paid, letter grades | **6 dimensions + reason + concrete fix, always** |
| Clip length | Shorter/Medium/Longer (no numbers) | exact second ranges, driven by campaign rules |
| Boundaries | AI judgment | **enforced in code**: never mid-sentence, always ends on payoff |
| Find Moments | scored clips, timestamps not documented | scored + exact timestamps + quote + why |
| Platform metadata | title/description/hashtags | **per-platform set for TikTok/Shorts/Reels/X** |
| Cost | credits per source minute; free = 720p, 3-day expiry | Claude tokens only (estimate in P3); 1080p; files are yours |
| Speed | shared cloud queue | local; top clips render first |

**Where Wayin stays ahead (not in v1):** AI B-roll, music/SFX, auto-publishing and scheduling, 4K, gaming layouts,
dubbing, and cloud GPU speed. Transcription on a laptop CPU will be slower than their cloud for long videos.

## Non-goals (v1)
Auto-posting to social accounts, accounts/multi-user, mobile app, gaming-specific detection, and copying any Wayin UI or assets.

## Open decisions (made during build)
- Speaker diarization: pyannote vs visual (benchmark in P2).
- Claude model per step: a cheap model for chunk scanning, a stronger model for final scoring (cost table in P3).
- Frontend: plain HTML + vanilla JS served by FastAPI (no build step), unless the editor needs more.
