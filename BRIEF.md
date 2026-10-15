# MASTER BRIEF — AI YouTube Clipping Desktop App

You are the lead engineer, architect, designer, and QA for a new desktop application. Read this entire brief before doing anything. It is the single source of truth for the project. Nothing here is optional unless it is explicitly marked **LATER**.

---

## 0. Who you are building for and why

- **One user.** The owner of this machine. No multi-user accounts, no billing, no signup. Design the data model so a user/tenant column could be added later, but do not build auth now.
- **Purpose.** The user participates in **Whop clipping programs** ("Content Rewards" campaigns): creators pay clippers per view for short-form clips cut from their long YouTube videos/streams and posted to TikTok, Instagram Reels and YouTube Shorts. The app's job is to turn a YouTube URL into the most engaging, highest-performing short clips that exist, let the user edit them in a full CapCut-grade editor, brand them, score them, schedule them, post them automatically, and track them against Whop campaigns.
- **Benchmarks.** The product must match or beat the quality and polish of **WayinVideo, OpusClip, CapCut (desktop) and Descript**. Study their UX patterns (you may research them on the web) and take the best idea from each. The product must feel like a $50/month SaaS, not a hobby project.
- **Budget guardrail.** The **only paid service is the Anthropic Claude API** (target ≤ $30/month, hard cap $70). Everything else must be free: free-tier object storage, local Whisper, local FFmpeg, free stock-media APIs, and **direct official social platform APIs** (YouTube Data API, Instagram Graph API, TikTok Content Posting API) which cost nothing. No subscriptions, no paid posting services. Every design decision that touches a paid API must respect this. Add a cost tracker (see §9).

---

## 1. Non-negotiable rules of engagement

1. **Checkpoints.** Work is organized into numbered checkpoints (§11). Each checkpoint must end with a product that **builds, runs, and is usable** end-to-end for the features it claims. Never leave the app in a broken state at the end of a checkpoint. Never start the next checkpoint until the current one passes its acceptance criteria.
2. **No placeholders, no mocks in shipped paths.** No `TODO: implement`, no `lorem ipsum`, no fake data rendered as if it were real, no "coming soon" buttons that do nothing. If a feature is marked LATER, its UI entry point is either hidden or clearly disabled with a tooltip "Coming in a later version".
3. **No mistakes shipped.** Before declaring any checkpoint done: `typecheck` passes with zero errors, `lint` passes, unit tests pass, the app launches cleanly, and you have personally exercised the checkpoint's user flow (run the app, run the pipeline on a real public YouTube video, inspect outputs). If you cannot run something (e.g., a GPU-only path), say so explicitly in PROGRESS.md.
4. **Use every relevant skill and tool you have.** Frontend design skills, web-artifact/UI skills, code-review skills, testing skills, documentation skills, web search for current docs (yt-dlp, FFmpeg, faster-whisper, Anthropic SDK, Cloudflare R2, Postiz API, Whop API, Electron, Next.js). Never guess an API signature when you can look it up.
5. **Keep durable project memory.** Maintain these files in the repo root at all times:
   - `CLAUDE.md` — how to run, build, test; architecture summary; conventions; the checkpoint list with status. Update it whenever something changes.
   - `PROGRESS.md` — current checkpoint, task-by-task status, what was verified and how, known issues, exact next step. Update after every meaningful unit of work so a fresh session can resume with "read PROGRESS.md and continue".
   - `DECISIONS.md` — architecture decision records (why X over Y).
   - `.env.example` — every env var with a comment.
6. **Ask before, not after.** If something is genuinely ambiguous and would cost hours to redo, ask the user **one batch of concrete questions** before building. Otherwise make the best decision, write it in DECISIONS.md, and continue. Never stall waiting for approval on reversible things.
7. **Security.** API keys only in `.env`/OS keychain, never in the renderer bundle, never logged. All secrets handled in the Electron main process. Context isolation on, nodeIntegration off, strict preload bridge with a typed IPC contract. Validate every IPC payload with Zod.
8. **Performance budget.** UI must stay at 60fps during scrubbing and timeline drag. First clip from a 1-hour video must be ready in under 6 minutes on a GPU machine (streaming pipeline — do not wait for the whole video to finish before showing the first clips).
9. **Quality bar for clips.** The clipping brain is the core product. Spend the most care there. A mediocre editor with great clips beats the reverse.

---

## 2. Tech stack (decided — do not relitigate)

| Layer | Choice |
|---|---|
| Shell | **Electron** (latest stable) with `electron-vite` or `electron-builder` for packaging. macOS and Windows targets. |
| Renderer / UI | **Next.js 15** (App Router, static export served by Electron), **TypeScript strict**, **Tailwind CSS v4**, **shadcn/ui**, **Framer Motion** (animations), **lucide-react** icons, **Zustand** (client state), **TanStack Query** (async/IPC state), **react-hook-form + Zod**, **dnd-kit** (drag/drop), **react-hotkeys-hook**. |
| Main process | Node/TypeScript. Job queue (**BullMQ** backed by an embedded Redis alternative is NOT acceptable — use **a persistent SQLite-backed job queue** such as `better-queue` with SQLite store, or implement a small durable queue on Prisma with worker threads). Jobs must survive app restarts. |
| Database | **SQLite via Prisma** (metadata only, lives in app userData). Videos never persist on disk — see §3. |
| Media processing | **FFmpeg + FFprobe** (`ffmpeg-static`/`ffprobe-static`, with hardware encoders: NVENC on Windows/NVIDIA, VideoToolbox on macOS, x264 fallback). **yt-dlp** (`yt-dlp-wrap`, auto-updated binary). |
| Transcription | **Local, free: faster-whisper** (`large-v3-turbo`, CUDA when available, CPU int8 fallback) via a bundled **Python sidecar** (uv/venv managed at first run), communicating over local HTTP/JSON. Word-level timestamps required. Fallback: whisper.cpp with Metal on Apple Silicon if faster-whisper CPU is unacceptably slow on Mac. Speaker diarization via pyannote is LATER; implement simple speaker-change heuristics now. |
| Face / subject tracking (reframe) | Python sidecar: **MediaPipe** face/pose detection + **PySceneDetect** scene cuts. Cheap, free, local. |
| LLM | **Anthropic Claude API** via official TypeScript SDK. Use `claude-sonnet-4-5` (or newest Sonnet) for moment finding, hook writing and virality scoring; use the newest Haiku for cheap tasks (titles, descriptions, hashtags, chapter names, chat on short contexts). Use prompt caching for transcripts. Stream responses to the UI. |
| Image generation (thumbnails) | Free: frame-based thumbnails (best frames chosen by vision scoring with Claude + brand-kit text overlays via canvas) as the primary path. Optional generative path behind a feature flag using a free provider (e.g., Pollinations.ai or Hugging Face free inference) — must degrade gracefully if the free provider is down. |
| B-roll | **Pexels Video API + Pixabay API** (free keys) for stock; LLM proposes search terms per sentence; user approves inserts. |
| Cloud storage | **Cloudflare R2 free tier** (10 GB, S3-compatible, free egress) via `@aws-sdk/client-s3`, with **Backblaze B2** (10 GB free) as a drop-in alternative behind the same `StorageProvider` interface — the user picks one in Settings. Presigned URLs for playback. Local disk is a temp cache only. |
| Social posting | **Direct official platform APIs, all free**: **YouTube Data API v3** (Google OAuth, `videos.insert` for Shorts), **Instagram Graph API** (Meta app in Development mode, Instagram Business/Creator account linked to a Facebook Page, Reels container publish), **TikTok Content Posting API** (Direct Post + Upload-to-inbox; note unaudited apps post as private until TikTok's free audit passes — surface this clearly in the UI). Each behind a `PublisherProvider` interface; OAuth flows run in an Electron auth window; tokens refreshed automatically and stored in the OS keychain. No third-party posting services, no scraping bots. |
| Whop | **Whop API** (research current docs) for Content Rewards campaigns, submissions, and earnings. |
| Testing | **Vitest** (unit), **Playwright** (Electron e2e for the main flows), fixture videos in `test/fixtures` (short, royalty-free). |
| Tooling | pnpm, ESLint, Prettier, Husky pre-commit (typecheck + lint + test on staged). |

**App name:** choose a short, brandable, memorable English name in Checkpoint 0, check that the `.com` isn't an obvious famous brand, record it in DECISIONS.md, and use it consistently (window title, package name, about screen).

---

## 3. Storage model (critical)

- Videos **must not live permanently on the user's disk**. All source videos, clips, renders, thumbnails, fonts, brand assets and caption files are stored in a **Cloudflare R2 bucket** owned by the user (`.env`: account id, access key, secret, bucket, public/custom domain if any).
- Local disk is a **temp working cache** in `userData/cache` with a configurable cap (default 20 GB). Pipeline: download → process → upload to R2 → delete local. Playback in the UI uses presigned R2 URLs with range requests (streaming), with an LRU local cache of recently played files for smooth scrubbing in the editor.
- The **Storage counter** in the UI reads real bucket usage (object list + sizes, cached and refreshed on changes), shows used / free-tier (10 GB) / projected monthly cost, breakdown by videos / clips / renders / assets, and offers one-click cleanup (delete source after clips exported, delete unexported renders older than N days, etc.).
- **Stay inside the 10 GB free tier by design.** A 1-hour 1080p source is 1.5–3 GB, so: (a) default **"Keep source as 480p proxy only"** after the clipping pass finishes — the proxy is enough for the Library, transcript sync and re-clipping; the full-res source is re-downloaded from YouTube on demand if a new full-quality render is needed (URL + content hash stored); (b) clips are stored at delivery resolution only; (c) a storage-threshold notification at 80% with a one-click "free space" plan; (d) the user can raise the cap if they ever choose a paid tier, but nothing in the app assumes it.
- Implement a `StorageProvider` interface so S3/B2/Supabase could be swapped.

---

## 4. The clipping brain (highest priority — build it best-in-class)

Pipeline for a YouTube URL (and later other inputs), fully observable with per-stage progress in the UI:

1. **Ingest.** yt-dlp: best video ≤1080p (user-configurable up to 4K), best audio, metadata (title, channel, description, chapters if present, thumbnail, duration, upload date), auto-captions as a weak prior only. Handle age-gated/cookies gracefully (cookies-from-browser option). Show download speed/ETA.
2. **Probe & normalize.** ffprobe; extract 16 kHz mono WAV for ASR; extract a low-res proxy (480p) for fast analysis/scrubbing; keyframe index.
3. **Transcribe.** faster-whisper with word timestamps, language auto-detect, VAD filter. Produce: full transcript, word-level JSON, sentence segmentation, silence map, speech-rate map, loudness/energy envelope (FFmpeg `ebur128`/`astats`), laughter/applause heuristics (energy spikes without speech).
4. **Understand.** Claude (with prompt caching on the transcript) produces for the whole video:
   - **AI Overview** (what the video is, who's in it, tone, 5 key takeaways)
   - **Chapters** (title, start, end, one-line summary) — merge with YouTube chapters if present
   - **AI Notes** (structured notes: key points, quotes, numbers, claims, action items)
   - **Topics/entities/keywords**
   - **Speaker labels** (heuristic)
5. **Find Moments** (the core). Multi-signal candidate generation, then LLM ranking:
   - Signals: semantic self-containment, hook strength in first 3 seconds, emotional intensity, humor, controversy, surprise, storytelling arc (setup → tension → payoff), quotability, numbers/claims, questions, energy/loudness peaks, speech-rate changes, laughter, silence boundaries (never cut mid-word; snap to word boundaries + 120–250 ms padding), scene changes.
   - Claude returns candidate clips with: start/end (word-aligned), title, hook line, why-it-works, suggested caption style, **Virality Score 0–100 with a breakdown** (hook 25, retention arc 25, emotional/entertainment value 20, clarity/self-containment 15, shareability/quotability 15) plus confidence.
   - Target durations configurable: presets 15–30s, 30–60s, 60–90s; user-defined min/max; number of clips requested (default 8–12 for a 1-hour video) or "all above score X".
   - **Streaming:** emit the first candidates as soon as the first ~10 minutes of transcript are available, so clips appear progressively.
   - Allow user-steered re-runs: "find moments about X", "funnier", "more controversial", "only guest speaking", with a free-text prompt box.
6. **One-Click Highlights.** A single "best 60–90s highlight reel" that stitches the top 3–5 micro-moments with transitions, with the LLM writing the narrative order.
7. **Reframe (AI).** For each clip, convert 16:9 → 9:16 / 1:1 / 4:5 with: single-face tracking (smooth, no jitter — Kalman/EMA smoothing, scene-cut aware), multi-face split-screen (two speakers stacked), "screen + face" layout when a screen share is detected, static center crop fallback, and manual keyframed crop in the editor. Preview before render.
8. **Captions (AI Subtitles).** Word-level subtitles burned via **ASS/libass** (full style control, karaoke/pop effects via `\k`, `\t`, `\fscx` etc.) and also exported as SRT/VTT. Styles are presets in the Brand Kit (§7). Default preset: a clean, bold, high-contrast, 1–3 words per line "word pop" style with the active word emphasized (think modern TikTok/Opus default). Must support emoji, auto line-breaking that never splits short phrases awkwardly, profanity masking toggle, keyword highlight colors chosen by the LLM.
9. **Hook.** AI Hook Generator: for each clip, 5 hook variants (text overlay for the first 2–3 s + optional spoken-hook suggestion), platform-specific (TikTok / Reels / Shorts), with the best one auto-applied as a title card the user can toggle.
10. **B-roll.** LLM tags sentences that benefit from B-roll, searches Pexels/Pixabay, proposes 3 options each, user approves; inserted as picture-in-picture or full-frame cutaways with the speaker audio continuous.
11. **Metadata.** Per clip and per platform: title, description, hashtags, best posting time suggestion, with a one-click "copy all".
12. **Thumbnail.** Best-frame selection (sharpness + face + expression + LLM vision ranking) + brand-kit text overlay; Thumbnail Tester shows the thumbnail in TikTok/Reels/Shorts feed mockups side by side for A/B eyeballing.
13. **Render.** FFmpeg filtergraph: crop/scale per reframe keyframes, captions, hook title card, brand watermark/logo, intro/outro, music bed with ducking under speech, loudness normalization to −14 LUFS, safe-area aware layout for each platform (avoid UI overlays). Hardware encode when available. Output 1080×1920 H.264 MP4 (+ optional 4K, MOV, GIF preview). Render queue with cancel/retry, parallelism tuned to CPU/GPU.
14. **Bulk.** Select many clips → bulk render, bulk download (zip or folder), bulk send to scheduler, bulk open in editor, bulk favorite/tag.

Every stage emits typed progress events over IPC; the UI shows a live pipeline view (stage, %, ETA, logs on expand). Every stage is retryable in isolation. Cache every intermediate in R2 keyed by content hash so re-runs are instant.

---

## 5. Full multi-track editor (CapCut-grade — no simple trimmer)

Build a real NLE in the renderer:

- **Timeline:** unlimited tracks (video, overlay/PiP, image, text, subtitle, audio/music, SFX), magnetic snapping, ripple/roll edits, split (S), delete gaps, multi-select, group, lock/mute/hide tracks, zoom (pinch/ctrl+wheel), waveform display on audio, thumbnails strip on video, markers, playhead scrubbing with audio scrub, frame-accurate stepping (←/→), J/K/L transport, undo/redo (command pattern, 200 levels), autosave every 5 s and version history.
- **Preview:** WebGL/Canvas compositor rendering the timeline in real time at proxy resolution with aspect-ratio canvas (9:16 / 1:1 / 16:9 / 4:5 / custom), safe-area guides per platform, grid/snapping for layers, transform handles (move/scale/rotate/crop), keyframes for position/scale/rotation/opacity/crop with easing curves (linear, ease in/out, bezier editor).
- **Clip tools:** speed (0.1×–10×, with pitch preserve toggle), reverse, freeze frame, duration ramp (speed curves), volume keyframes, fade in/out, opacity, blend modes, crop, mirror, rotate, background blur fill, color adjustments (exposure, contrast, saturation, temperature, LUT import), filters/presets.
- **Transitions:** cut, crossfade, dip to black/white, slide, zoom, blur, whip-pan, glitch — applied between adjacent clips with duration handles.
- **Text:** rich text layers with the Brand Kit's text styles, animations in/out (pop, typewriter, slide, bounce, fade, scale), stroke, shadow, background box, letter spacing, line height; emoji support.
- **Subtitles track:** first-class subtitle editor (edit words inline, merge/split lines, retime by dragging, change style per line, highlight word colors, bulk apply preset, re-sync with AI), fully separate from text layers.
- **Audio:** music library (user-uploaded, in brand kit) + Pixabay free music search, auto-ducking under speech, beat detection to snap cuts to beats, noise gate; Speech Enhancer is LATER — leave a disabled menu entry.
- **Reframe tool inside the editor:** show the face-tracking path as keyframes; user can override.
- **Stickers/shapes:** basic shapes, progress bar overlay, "swipe up"/CTA stickers from brand kit images.
- **Export panel:** platform presets, resolution, fps, bitrate/quality slider, burned captions on/off, separate SRT/VTT, filename template, export to Library → Exported tab, and "Export & Schedule".
- Open from Library: any clip or source video opens in the editor with its AI data (transcript, moments, captions) already loaded.
- Keyboard shortcut map modeled on CapCut/Premiere; a `?` overlay lists them.

The editor state is a serializable JSON project format (store in SQLite, back up to R2). Rendering = compile project JSON → FFmpeg filtergraph (with the ASS subtitle file). Verify that preview and export are visually identical; write golden-frame tests for the compositor.

---

## 6. App structure, UI and design system

### Navigation (left sidebar, collapsible) + top bar
- **Home** — hero input: "Paste a YouTube URL" (also drop file / Google Drive link LATER), quick presets (clip length, count, style), recent projects, pipeline status cards for running jobs, "Continue where you left off", stats (clips made this week, posts scheduled, Whop earnings).
- **Library** — tabs: **Videos (imported)**, **Clips (AI-made)**, **Favorites**, **Edited**, **Exported**, plus filters (score, duration, platform, campaign, date, tags), grid/list views, hover-to-preview autoplay, multi-select action bar (download, send to scheduler, open in editor, favorite, tag, delete), per-video detail page with tabs: **Overview / Transcript / Chapters / Clips / Notes / Chat / Subtitles**.
- **Editor** — full-screen NLE (§5).
- **Scheduler** — calendar (month/week/day) + queue list; drag clips onto time slots; per-platform account chips; post status (scheduled/posting/posted/failed with retry); best-time heatmap; connected accounts management (OAuth to YouTube / Instagram / TikTok directly from the app).
- **Brand Kit** (§7).
- **Whop** (§8) — campaigns, submissions, earnings.
- **Tools** — a hub page (cards) with every tool: AI Clipping, Find Moments, One-Click Highlights, Video Editor, Video Summary, Video Transcripts, AI Subtitles, AI Reframe, AI Thumbnail, AI Hook, B-roll, Live Clipping; and greyed cards for **LATER**: Game Clipping, Speech Enhancer, AI Video Generator. Each tool is also a route that can be launched standalone on any library item.
- **Notifications** — bell with unread count; in-app toasts + OS notifications: job finished, first clips ready, render done, post published/failed, storage threshold, Whop payout/approval changes, yt-dlp/model updates.
- **Settings** — API keys (masked, validated with a "Test" button), models, GPU/CPU selection, concurrency, cache cap, default presets, theme, shortcuts, cost tracker, diagnostics (versions of ffmpeg/yt-dlp/whisper, logs export).
- **Storage** indicator pinned at the bottom of the sidebar (ring + GB used + "Manage").
- **Global command palette** (⌘/Ctrl+K) to jump anywhere and run any tool.
- **AI Chat** — context-aware drawer available on any video/clip: ask questions about the video, "find the part where…", "make a clip of…", "rewrite this hook", "summarize for LinkedIn"; actions are executable (chat can create clips, add markers, write metadata). Uses Haiku for retrieval + Sonnet for generation; cite timestamps that are clickable.

### Design language
- Inspired by WayinVideo / OpusClip / CapCut / Descript: dense but airy, dark-first with a true **light mode** too (system/auto + manual toggle; tokenized via CSS variables; no flash on load).
- Define a design system first: color scale (primary accent with an electric-but-professional feel, semantic colors for score tiers: 0–49 muted, 50–74 amber, 75–89 green, 90+ "viral" gradient), typography (Inter or Geist for UI, a display face for headings), 4px spacing scale, radius scale, elevation, motion tokens (durations 120/200/320 ms; springs for drag), focus rings, reduced-motion support.
- Micro-interactions everywhere: skeleton loaders, progress rings, animated score reveal, hover previews, drag ghosts, confetti/glow on 90+ score, smooth page transitions, toast stack. Must remain tasteful and fast.
- Accessibility: keyboard-navigable, ARIA labels, contrast AA.
- Empty states with guidance, not blank screens. Error states with recovery actions.
- Responsive from 1280 px laptop to ultrawide; editor adapts panel layout.

---

## 7. Brand Kit

Multiple brand kits (one per creator/campaign), one marked default, selectable per project. Each kit has sections, each with a consistent upload panel: **"Drop a file here, or browse."** with the supported formats listed under it.

- **Logos / Watermarks** — PNG/SVG, position, opacity, size, safe-area aware.
- **Images** — stickers, CTA graphics, end cards. PNG/JPG/WEBP/SVG/GIF.
- **Videos** — intros, outros, transitions, B-roll packs. MP4/MOV/WEBM.
- **Audio** — music beds, SFX, stingers. MP3/WAV/AAC/M4A; with loudness-normalized previews.
- **Fonts** — "Drop a file here, or browse. Supported: TTF, OTF, WOFF, WOFF2"; font preview with sample text; fonts registered for both the editor canvas and FFmpeg/libass rendering.
- **Colors** — "Add colors": named swatches, palette groups, extract from logo.
- **Subtitle Styles** — "Add subtitle styles": presets built from a live preview editor (font, size, weight, case, fill, stroke, shadow, background box, highlight color/animation, position, max words per line, animation type). Ship these presets, all interchangeable and editable: **Clean Pop (default)**, Hormozi Bold, Karaoke Highlight, TikTok Classic, Minimal Lower-Third, Neon Glow, Boxed Highlight, Typewriter, Bounce Word, Gradient Glow, Outline Only, Caption Bubble, Podcast Lower-Third, Subtle Serif. Each preset has a thumbnail rendered with real text.
- **Text Styles** — "Add text styles": title/hook/CTA presets with animations.
- **Defaults** — aspect ratio, caption preset, hook style, watermark on/off, intro/outro on/off, target platforms, hashtag sets, posting-time windows.
- Apply a brand kit to a clip, a selection, or set as default for new projects. Assets upload to R2 and are referenced by id.

---

## 8. Whop integration

Research the current Whop developer API/SDK. Implement:
- Connect with the user's Whop API key/OAuth (Settings).
- Pull **Content Rewards campaigns** the user has joined or can join: name, creator, platforms allowed, payout per 1k views, caps, content requirements (length, must include X, hashtags, disallowed), status, deadlines.
- Attach a campaign to a project; the app enforces/warns on the campaign's rules during clip generation and export (e.g., required hashtags, duration limits, required mention).
- **Submissions**: after a post is published, submit the post URL to the campaign through the API where supported; otherwise store the submission locally with a "copy link" helper and status tracking. Track views (via Postiz/platform analytics where available), estimated earnings, approval status, payouts.
- Whop page: campaigns grid, "best campaigns for this video" suggestion (LLM matches video content to campaign requirements), submissions table, earnings dashboard, alerts for new campaigns matching the user's niches.
- If any part of the Whop API is unavailable, degrade to manual tracking and say so clearly in the UI — never fake data.

---

## 9. Social posting, scheduler, cost tracker

- **Direct platform integrations (free, official):**
  - **YouTube Shorts** — Google Cloud project + OAuth client (the user creates it; the app's Settings page shows step-by-step instructions with screenshots-as-text and a "Test connection" button). `videos.insert` with resumable upload, title/description/tags/visibility/made-for-kids/#Shorts; daily quota awareness (10,000 units; an upload costs ~1,600 → ~6 uploads/day on the default quota; show remaining quota and explain how to request more for free).
  - **Instagram Reels** — Meta developer app (Development mode is enough for the user's own account as long as the account is an admin/tester), Instagram Business or Creator account linked to a Facebook Page; container create → status poll → publish; caption, cover frame, share-to-feed, first comment. Media must be reachable by URL → use a short-lived presigned R2/B2 URL.
  - **TikTok** — TikTok for Developers app with Content Posting API scopes (`video.publish`, `video.upload`). Direct Post (FILE_UPLOAD or PULL_FROM_URL) with privacy level, comments/duet/stitch toggles, commercial-content flags. **Unaudited apps can only post as private/self-only** — the UI must say this, offer "Upload to drafts/inbox so I publish in the TikTok app", and include a checklist for submitting the free audit. Once audited, public posting works automatically.
  - Platform-specific fields are validated with Zod per platform. Validate media specs before upload (duration, size, aspect, codec, fps) and auto-fix (re-encode) when possible. OAuth refresh handled silently; re-auth prompt when a token is revoked.
- **Scheduler is real and local:** the Electron main process owns a durable scheduler (SQLite-backed, survives restarts). At the scheduled time it publishes directly through the platform APIs. Since there is no cloud service, the app must be running: it minimizes to the **system tray / menu bar** and keeps the scheduler alive; on launch after being closed it runs **catch-up** (publishes missed posts within a configurable grace window, otherwise marks them "missed — reschedule?"). Show a clear "Scheduler active" indicator. Also "post now", bulk scheduling with smart spacing, failures with the platform's error + retry/backoff, rate-limit and quota awareness, a daily digest notification. Design the scheduler so a free serverless worker (e.g., a Cloudflare Worker cron reading from R2) could take over publishing later without the app running — document the interface in DECISIONS.md but do not build it now.
- **Safety:** never use unofficial/scraping bots or password-based automation to post. Only official OAuth APIs. Keep all tokens in the OS keychain (`safeStorage`/`keytar`), never in SQLite plaintext.
- **Cost tracker:** count every Claude call (input/output/cached tokens × current published prices, fetched/updatable) and show monthly spend vs the $30 target (hard cap $70) with a projection and a soft alert at 80%; auto-switch low-value tasks to Haiku and reduce clip candidates when over budget. Storage usage shown separately against the free tier.
- **Local API (bonus):** a localhost REST API (token-protected) exposing library listing, clip download and "clip this URL" so other tools/scripts can drive the app. Document it in `docs/api.md`.

---

## 10. Live Clipping (build after the core; still part of v1)

- Input: a live YouTube/Twitch/Kick stream URL (via yt-dlp/streamlink).
- Continuous recording into rolling segments (e.g., 2-min HLS/TS chunks) uploaded to R2 as they complete; a rolling transcript via faster-whisper on each chunk; real-time moment detection on a sliding window (energy spikes, chat velocity if available, LLM scoring every N minutes with the last 10 minutes of context).
- Auto-create clips as the stream progresses, appear live in Library with scores; "clip the last 60 s" hotkey; stop/resume; auto-stop at stream end; session summary.
- Resource-aware: lower-res recording option, GPU/CPU usage display.

---

## 11. Checkpoints (build in this order; each must be runnable and usable)

For every checkpoint: update CLAUDE.md/PROGRESS.md, run typecheck + lint + tests, launch the app, exercise the flow on a real public YouTube video (choose a ~15-min CC-licensed talk/podcast for speed), record evidence in PROGRESS.md, then stop and report to the user with a short demo script ("open X, paste Y, click Z"). Then wait for "go" before the next checkpoint.

**CP0 — Foundation (runnable shell)**
Electron + Next.js + Tailwind + shadcn + design system (tokens, light/dark, typography, motion), sidebar navigation with all pages as styled empty states, settings with API key / OAuth entry + validation (Anthropic, R2 or B2, Whop, Pexels/Pixabay; YouTube/Instagram/TikTok OAuth placeholders with guided setup instructions, wired in CP5), Python sidecar bootstrap (creates venv, installs faster-whisper/mediapipe/scenedetect, downloads model with progress), ffmpeg/yt-dlp binaries verified, R2 connection test, SQLite/Prisma schema v1, job queue skeleton, notifications system, command palette, storage indicator reading real R2 usage, CLAUDE.md/PROGRESS.md/DECISIONS.md created, app name chosen, packaging works (`pnpm dist` produces an installable build). Tests: unit tests for IPC contract and storage provider.

**CP1 — YouTube → clips (the core, usable)**
Paste URL → ingest → transcribe → understand (overview, chapters, notes) → Find Moments with Virality Scores → auto reframe (single-face) → captions with the default Clean Pop preset → hook title card → render 9:16 clips → Library "Videos" + "Clips" tabs + video detail page with Overview/Transcript/Chapters/Clips/Notes. Streaming of first clips. Progress UI. Download single/bulk. Favorites. Cost tracker live. Acceptance: a 15-min video yields ≥6 clips you would actually post, no mid-word cuts, captions perfectly timed, face stays centered.

**CP2 — Clip intelligence depth**
All caption presets + live preview editor, multi-face/split/screen-share reframe modes, user-steered re-runs and the free-text moment prompt, One-Click Highlights, AI Hook variants per platform, Thumbnail (best frame + tester), per-platform metadata, Subtitles tab with inline editing and SRT/VTT export, AI Chat drawer with executable actions, Video Summary/Transcript tools as standalone routes, Tools hub.

**CP3 — Full editor**
Everything in §5. Open any clip/video from Library; Edited/Exported tabs; export presets; preview/export parity tests; keyboard shortcuts; autosave + versions.

**CP4 — Brand Kit**
Everything in §7, applied in the pipeline and the editor; fonts registered for libass; B-roll (Pexels/Pixabay) flow; music with ducking.

**CP5 — Posting + Scheduler**
Direct YouTube / Instagram / TikTok OAuth + publishing (§9) with guided in-app setup for each developer app, local durable scheduler with tray mode and catch-up, calendar/queue, post now, status/analytics, media validation/auto-fix, "Export & Schedule", bulk scheduling with smart spacing, daily digest. Acceptance: a real Short lands on the user's YouTube channel at the scheduled minute; a Reel publishes to the user's Instagram; TikTok posts (private if unaudited) and the UI explains the audit path.

**CP6 — Whop**
Everything in §8.

**CP7 — Live Clipping**
Everything in §10.

**CP8 — Polish & hardening**
Performance pass (profiling, memory leaks, long-video stress: 3-hour podcast), error-recovery audit, crash reporting (local), onboarding tour, docs (`docs/`), e2e Playwright suite for CP1/CP3/CP5 flows, final packaging for macOS (notarization steps documented) and Windows, "Health check" page.

**LATER (do not build now; keep hooks/disabled entries):** Game Clipping (kill/win detection), Speech Enhancer (noise/echo removal), AI Video Generator, speaker diarization with pyannote, Google Drive/Zoom/Twitch VOD/Rumble/Vimeo ingest, platforms beyond TikTok/Reels/Shorts (X, Facebook, LinkedIn, Threads, Pinterest — leave `PublisherProvider` slots), a serverless publishing worker so posts go out while the app is closed, mobile companion, multi-user.

---

## 12. Reporting format at the end of each checkpoint

Reply to the user with exactly:
1. **Checkpoint N — DONE / PARTIAL** and one paragraph of what works.
2. **How to try it** — numbered steps (max 8).
3. **Verified by** — what you ran and observed (real video used, timings, output paths).
4. **Known issues / deferred** — honest list.
5. **Questions for you** — only if blocking; otherwise "None — proceed with 'go' to start CP N+1".

Begin now with **Checkpoint 0**. First, before writing code: (a) create the three memory files, (b) write a short architecture plan into DECISIONS.md, (c) list any blocking questions in one batch (if none, say so), then build.
