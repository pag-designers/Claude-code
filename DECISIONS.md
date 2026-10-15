# DECISIONS.md — Architecture Decision Records

Source of truth for scope: `BRIEF.md`. This file records _why_ we chose X over Y.

---

## ADR-000 — Architecture plan (CP0)

```
┌────────────────────────── Electron main (Node/TS) ─────────────────────────┐
│ app.ts            window, tray, protocol app://, single-instance            │
│ ipc/              typed channel registry; every payload validated by Zod    │
│ services/                                                                    │
│   db (Prisma + libsql)   settings   secrets (safeStorage)   notifications   │
│   queue (durable, Job table, resumes on restart)                             │
│   storage (StorageProvider → S3Provider for R2 / B2, usage + cleanup)        │
│   binaries (ffmpeg, ffprobe, yt-dlp: locate / download / verify / update)    │
│   sidecar (uv + venv bootstrap, model download, HTTP client, lifecycle)      │
│   validators (Anthropic, R2/B2, Whop, Pexels, Pixabay "Test" buttons)        │
└───────────────▲──────────────────────────────────────────▲──────────────────┘
                │ contextBridge (preload): invoke(channel) + on(event)          │ spawn / HTTP 127.0.0.1
┌───────────────┴─────────────── Renderer ───────────────┐   ┌─────────────────┴───────────┐
│ Next.js 15 static export, served via app://            │   │ Python sidecar (FastAPI)     │
│ Tailwind v4 + shadcn/ui, Zustand, TanStack Query       │   │ faster-whisper, MediaPipe,   │
│ never sees a secret; talks only through window.clipfern│   │ PySceneDetect                │
└────────────────────────────────────────────────────────┘   └──────────────────────────────┘
```

Repo layout (single pnpm package, no workspaces — fewer moving parts for one user):

| Path                | Purpose                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `shared/`           | Zod schemas + IPC contract + domain types, imported by main, preload and renderer |
| `electron/main/`    | main-process code (bundled with esbuild → `dist-electron/main.cjs`)               |
| `electron/preload/` | preload bridge (→ `dist-electron/preload.cjs`)                                    |
| `renderer/`         | Next.js app (`output: "export"` → `renderer/out`)                                 |
| `sidecar/`          | Python FastAPI service + bootstrap scripts                                        |
| `prisma/`           | schema + migrations                                                               |
| `test/`             | vitest unit tests, Playwright e2e, fixtures                                       |
| `docs/`             | user/dev documentation (grows in CP8)                                             |

Data flow rule: **renderer → IPC → main → (DB | R2 | sidecar | ffmpeg | LLM)**. The renderer is a pure view; all secrets, network and disk access live in main.

---

## ADR-001 — App name: **Clipfern**

Short, brandable, English. `clipfern.com` returned 404 from the Verisign RDAP registry on 2026-10-13 (i.e. not registered) and the name is not an existing well-known brand. Used for window title, `package.json` name, About, `appId = app.clipfern.desktop`, preload global `window.clipfern`, protocol `clipfern://` (reserved for OAuth redirects in CP5).

## ADR-002 — Build tooling: esbuild for main/preload, `next build` for renderer, not electron-vite

The renderer is Next.js (decided), which owns its own bundler; electron-vite would add a second Vite pipeline we do not need. esbuild bundles main + preload to CJS in <1 s. `electron-builder` packages. Dev = `next dev` + esbuild watch + Electron pointed at `http://localhost:3210`; prod = static export served through a custom `app://` protocol (needed because Next's export uses absolute `/_next/...` URLs that `file://` cannot resolve).

## ADR-003 — Next.js 15 (not 16)

Brief pins Next.js 15; latest 15.x is used even though 16 exists. Not relitigated.

## ADR-004 — Prisma 6 + libsql driver adapter (not better-sqlite3)

`better-sqlite3` is a V8-ABI native module: a binary built for Electron cannot load under the Node that runs Vitest and vice versa, and it needs `electron-rebuild` on every platform. `@libsql/client` ships N-API prebuilt binaries (ABI-stable across Node and Electron), keeping dev, tests and packaging on one binary. Prisma 6.x with the driver-adapter `engineType = "client"` (no Rust query-engine binary to ship/unpack). Still "SQLite via Prisma" as the brief demands; database file lives in `userData/clipfern.db`. Migrations are applied at startup by a small embedded runner (Prisma `migrate deploy` is a CLI and unavailable in a packaged app), reading the generated SQL migration files.

## ADR-005 — Durable job queue = our own small SQLite-backed queue on Prisma

Brief forbids Redis/BullMQ. `better-queue`'s SQLite store pulls in sqlite3 (another native ABI problem). We implement ~200 lines on the `Job` table: states `queued → running → succeeded | failed | canceled`, attempts/backoff, priority, per-kind concurrency limits, heartbeat; on startup any `running` job is re-queued (jobs must be idempotent and resumable by stage). Handlers run in the main process but do heavy work in child processes (ffmpeg, yt-dlp, Python sidecar), so `worker_threads` are unnecessary and avoided.

## ADR-006 — Secrets: Electron `safeStorage`, not keytar

`keytar` is archived/unmaintained and needs native rebuilds. `safeStorage` uses Keychain (macOS), DPAPI (Windows), libsecret/kwallet (Linux). Ciphertext is stored in `userData/secrets.bin` (never in SQLite, never in the renderer). Where no OS keystore is available (e.g. headless Linux CI) the service reports `backend: "insecure-fallback"` and the Settings page shows a visible warning; the fallback obfuscates with a per-install random key file and is **never** used silently on macOS/Windows. `.env` values are read as _defaults_ (dev convenience) and surfaced as "from .env".

## ADR-007 — One `S3Provider` for Cloudflare R2 and Backblaze B2

Both are S3-compatible; `StorageProvider` interface has `put/get/head/delete/list/presignGet/presignPut/usage`. The user picks R2 or B2 in Settings (same code, different endpoint/region defaults). A `MemoryStorageProvider` backs unit tests; `s3rver` (real S3 protocol server) backs an integration test of `S3Provider` so we are not only testing mocks. Storage usage = listing objects under category prefixes (`videos/ clips/ renders/ assets/ thumbs/ misc/`), cached in DB, refreshed on writes and on demand.

## ADR-008 — Python sidecar bootstrapped with `uv`

`uv` creates the venv, can fetch a managed Python (so the user needs no system Python), and installs fast. First run: locate `uv` (PATH → `userData/bin/uv`; otherwise download the pinned standalone release from `astral-sh/uv` GitHub releases) → `uv venv --python 3.11` → `uv pip install fastapi uvicorn faster-whisper mediapipe scenedetect[opencv] huggingface_hub` → download `large-v3-turbo` weights via `huggingface_hub` with a progress callback → start `uvicorn` on a random localhost port with a per-run bearer token. Progress is streamed as JSON-lines to the renderer (`sidecar:progress` event). Model is selectable (default `large-v3-turbo`; `tiny` used in CI/smoke tests).

**As built (CP0):** `sidecar/requirements.txt` is a fully pinned _universal_ lock (`uv pip compile --universal --python-version 3.11`); `requirements-cuda.txt` (cuBLAS/cuDNN) is installed only when an NVIDIA GPU is detected. Face detection uses the MediaPipe **Tasks** API (`vision.FaceDetector`, BlazeFace `.tflite` downloaded at setup, SHA-256 pinned) because legacy `mp.solutions` no longer exists in mediapipe 1.1.0. Model download uses `huggingface_hub.snapshot_download` with a custom tqdm class (faster-whisper's helper is incompatible with hub 2.x). The manager's HTTP client uses `node:http` (undici's 300 s timeout would break long CPU transcriptions) and the sidecar exits when the parent dies (`--exit-on-stdin-eof`). On Linux MediaPipe needs `libegl1 libgles2`. `sidecar/` ships via electron-builder `extraResources` (must be a real directory, not inside the asar). Apple Silicon: faster-whisper runs on CPU int8 (no Metal backend in CTranslate2); whisper.cpp+Metal remains the documented fallback.

## ADR-009 — IPC contract

`shared/ipc.ts` exports a single `ipcContract` object: for every invoke channel `{ input: ZodSchema, output: ZodSchema }`, for every push event `{ payload: ZodSchema }`. Main registers handlers through `handle(channel, fn)` which parses input and output; preload exposes only `invoke(channel, payload)` and `on(event, cb)` and rejects channel names not in the contract. Renderer wraps with typed hooks (`useIpcQuery`, `useIpcMutation`). Errors cross the bridge as `{ code, message }` (never stack traces with secrets).

## ADR-010 — Settings vs secrets split

Non-secret settings (models, concurrency, cache cap, theme, default presets) → `Setting` table (key/value JSON). Secrets (API keys, OAuth client secrets, tokens) → `secrets.bin`. Renderer can only ask "is key X set?" and "set/clear X"; it can never read a secret back (masked display shows last 4 chars computed in main).

## ADR-011 — Multi-user hooks without auth

Every domain table that will be user-scoped carries `ownerId String @default("local")`. No auth is built.

## ADR-012 — Repo contains a pre-existing unrelated `index.html`

The repository was initialised with a barbershop landing page (`index.html`, "OB Barbería"). It is unrelated to this brief and is left untouched at the repo root (not part of any build, ignored by Next/Electron). Flagged to the user for removal if unwanted.

## ADR-013 — Environment caveats for verification

Development runs in a headless Linux cloud container (no GPU, no macOS/Windows, no OS keyring). Therefore: GUI is exercised with Electron under Xvfb + Playwright screenshots; macOS/Windows installers are configured but only a Linux build is produced and verified here; GPU/NVENC/VideoToolbox/CUDA paths cannot be run and are recorded as unverified in PROGRESS.md; real R2/Anthropic/Whop calls require the user's keys, so those validators are verified against recorded/simulated servers (s3rver, local HTTP stubs) and flagged for a live check on the user's machine.

## ADR-014 — Scheduler future-proofing (documented, not built)

Scheduled posts are rows `{ id, platform, accountId, mediaKey (R2), payload JSON, runAt, status }`. A future Cloudflare Worker cron could read the same shape from an R2-hosted `schedule/queue.json` mirror and publish via the same `PublisherProvider` contract. Not built in v1 (brief §9).

## ADR-015 — Packaging rules learned the hard way

- Only native/external modules are real `dependencies` (`@prisma/client`, `@prisma/adapter-libsql`, `@libsql/client`, `ffmpeg-static`, `ffprobe-static`); everything else is a devDependency because esbuild (main) and Next (renderer) bundle it. Installer: 418 MB → 194 MB.
- The generated Prisma client lives in `node_modules/.prisma` (not a dependency) and must be shipped explicitly: `files: [{from: node_modules/.prisma, to: node_modules/.prisma}]`.
- `files` must start with a positive pattern; a leading `!pattern` makes electron-builder prepend `**/*` and pack the whole repo. Per-platform `files` lists replace the top-level one, so each repeats the positive patterns.
- ffprobe-static ships binaries for every OS; each platform's list excludes the others.
- The `sidecar/` Python sources ship as `extraResources` (real directory, not asar); `.venv` is created in userData at first run, never packaged.
- Cross-platform installers must be built on their own OS (native optional deps are per-platform). A GitHub Actions matrix is the CP8 plan.

## ADR-016 — Whop API validation endpoint

Whop REST base `https://api.whop.com/api/v1`, `Authorization: Bearer <key>`; `GET /accounts/me` validates an Account API key (docs.whop.com, checked 2026-10-13). Content Rewards endpoints are researched in CP6.

---

## ADR-017 — CP1 pipeline architecture (streaming, windowed)

- **One durable queue job per video** (`pipeline.process`, concurrency 1) runs the stages `ingest → prepare → transcribe+moments → understand → select`; **one job per clip** (`pipeline.render-clip`, concurrency 2) renders in parallel. Stage state lives in `Video.stages` (JSON) so a restart resumes (finished stages are skipped, artifacts re-derived lazily); `reconcileOnStart` marks videos whose jobs vanished as failed with a Retry hint instead of leaving them spinning.
- **Streaming first clips (BRIEF §4.5):** the audio is transcribed in **10-minute windows** (4 s padding each side so boundary words are not cut; words are kept by midpoint). While window _k+1_ transcribes, window _k_ is ranked by the LLM; moments scoring ≥ 72 start rendering immediately, the rest wait for the final selection (top N, or all ≥ minScore). Ranking context overlaps the previous window by `maxClipSec + 15 s`; moments that start before the current window are left to the previous one; overlapping duplicates (IoU > 0.35) keep the higher score.
- **LLM returns sentence ids, not seconds** (removes timestamp hallucination); code converts to times and re-snaps to word boundaries (never mid-word, 120–250 ms padding).
- **Understand (overview/chapters/notes)** runs once the full transcript exists, concurrently with the last renders. Moment ranking does not wait for it (analysis context is optional).
- **Local disk is a temp cache** (`userData/cache/<videoId>`): the full-res source is deleted at finalize; only the 480p proxy is uploaded (`keepSourceAs`, default `proxy480`); a later re-render re-downloads the source (`ensureSource`). Rendered clips are uploaded then deleted locally; playback uses presigned URLs.
- **Cross-run cache:** `cache/yt-<sourceId>/<whisperModel>/{transcript,signals}.json` in object storage — re-running the same video (new clip length, steering prompt) skips ASR entirely.
- **Storage keys** are defined once in `shared/pipeline.ts` (`keys`).
- **Models:** defaults moved to `claude-sonnet-5-5` (moments/understand) and `claude-haiku-5-5` (cheap tasks) per the brief's "newest Sonnet/Haiku"; pricing table updated ($2/$10 and $0.10/$0.50 per MTok). Estimated cost for a 15-min video is a few cents (see PROGRESS.md for the measured token counts).
- **YouTube bot checks** (datacenter IPs): ingest tries default clients, then `android_vr` (360p progressive only, with an explicit quality-limited message), then fails with an actionable "use cookies from browser" error. Verified in this sandbox that metadata works but downloads are intermittently blocked.
- **Dev/test-only switches (never needed in production):** `CLIPFERN_S3_ENDPOINT_OVERRIDE` (S3 emulator), `CLIPFERN_ALLOW_ANY_URL=1` (direct media URL via yt-dlp's generic extractor), `CLIPFERN_ANTHROPIC_BASE_URL` (stub Claude server; deliberately not the SDK's `ANTHROPIC_BASE_URL`, which other tools set).
- **Queue:** global concurrency is `max(settings.concurrency, 3)` so one pipeline job and two renders can always run together.

---

## ADR-018 — CP2 architecture (clip intelligence depth)

- **Data-driven caption styles.** A `CaptionStyle` (font, case, fill, stroke, shadow, box, active-word highlight, keyword colour, animation, layout, chunking — all percentages, so resolution independent) drives libass. The 14 built-in presets ship in code; user presets live in `CaptionStylePreset` and are resolved by `StyleRegistry` (a deleted preset falls back to `clean-pop`, so a re-render never breaks). The Style Studio preview is a **real libass render** of the style on a real frame (`captions:preview`), not a CSS approximation.
- **Subtitle edits layer over the ASR transcript** (`SubtitleEdits`: per-word text/shift/hidden + cue breaks/merges), persisted per video (local cache + `videos/<id>/subtitle-edits.json`). The server assigns the revision (`Video.subtitleRev`); each rendered clip records the revision it was built from, which is how the UI shows "captions outdated" without re-rendering anything silently. Edits are applied by _transcript word index_, before windowing a clip's words.
- **Reframe modes** extend `ReframePlan` with `layout` + `panels` (`single` | `split` two stacked faces | `screen-face`). `auto` inspects real frames (`analyzeLayout`) to detect screen shares; the user can force a mode per clip (`clips:reframe`), which re-renders.
- **Steered re-runs** (`moments:find`) are a separate durable job (`pipeline.moments-run`) over the cached transcript/signals — no ASR, no download until a clip must render. Results are tagged with `runId`/`runPrompt` (shown as "found by: …") and de-duplicated against existing clips (IoU > 0.35 keeps the better score), keeping the best N.
- **Analysis-only mode** (`options.mode = 'analysis'`): ingest → prepare → transcribe → understand; moments/render are `skipped`. This backs the Video Summary and Transcript tools without spending ranking tokens.
- **One-Click Highlights** is a composed clip (`kind = 'highlight'`): the LLM picks 3–5 micro-moments _in narrative order_; code aligns each span to word boundaries; the render service renders segments independently (own reframe + captions) and stitches them with xfade/acrossfade, normalising loudness once on the final mix.
- **Hooks / metadata / thumbnails are clip artefacts** stored in `Clip.metadata` JSON (`hooks`, `meta`, `thumbs`, `appliedHookText`, `hookOff`) — no new tables for data that is always read together with the clip. Applying a hook re-renders with that title card. Thumbnails: sample → heuristic score (sharpness, face presence/size/centring via the sidecar, composition) → vision-model rank (falls back to the heuristic order if the call fails) → optional overlay text; candidates are stored under `clips/<id>/thumbs/`.
- **AI Chat** executes the model's tool calls through the same services as the UI (`create_clip`, `add_marker`, `write_metadata`, `rewrite_hook`, `find_moments`). Tools are non-destructive (they create candidates/markers/drafts; nothing is deleted or posted) and each call appears as an action card with a deep link. Answers stream over `chat:event`; threads/messages persist (cascade-deleted with the thread).
- **Migration 0003** only ADDs columns/tables (never Prisma's table-redefine form, which would cascade-delete clips); an upgrade test applies 0001–0002, inserts data, then 0003.

---

## ADR-019 — CP3 editor architecture (project JSON, one evaluator, two renderers)

- **One serialisable document** (`shared/editor.ts`, `Project`) describes an edit: canvas, tracks (z-order = array order), items (video, image, audio, text, subtitle, shape), assets, markers. Stored in SQLite (`EditorProject.data`, optimistic `rev`), mirrored to object storage (`projects/<id>/project.json`), with auto/manual/restore versions (`EditorVersion`; auto snapshots at most every 5 min, newest 40 kept). Autosave every 5 s from the renderer; a stale `baseRev` is a `CONFLICT`.
- **Parity by construction.** Everything both renderers must agree on lives in pure functions in `shared/editor-eval.ts` (easing, keyframe interpolation, source-time mapping incl. speed ramps/reverse/freeze, transition layer maths, fades, ducking envelope, colour maths, text animation state, natural layout). The WebGL preview and the FFmpeg exporter call or sample those; golden-frame tests compare the two. Coordinates are canvas pixels at export size, so a preview at any size is a pure scale.
- **Transitions are overlaps** (the later item starts `duration` before the earlier ends and carries `transitionIn`) — the same model as FFmpeg `xfade`/`acrossfade`, so the timeline, the preview and the export share one geometry.
- **Reframe = crop keyframes.** A face-tracking path is just keyframes on the item's normalised `crop`; the editor can show and override it. Opening a Library clip runs the same single-face tracker on the 480p proxy, thins the path, and adds the captions as subtitle items and the hook as an editable text item.
- **Ducking is deterministic**, not a sidechain: speech ranges come from the subtitle words (else the audible spans of speech tracks) and a look-ahead attack/release envelope (`duckGainAt`) is emitted as piecewise-linear gain in both the Web Audio mixer and the FFmpeg graph.
- **Preview media**: library videos play their 480p proxy, clips their rendered mp4, uploads a 480p copy made at import; export re-obtains full-resolution sources (`ensureSource`, clip/upload downloads) and compiles `Project → FFmpeg` (+ one ASS file for text/subtitles), normalising loudness last. Exports run as durable jobs and land in Library → Exported.
- **Pixabay music is not integrated.** Pixabay's official API (https://pixabay.com/api/docs/) covers images and videos only; music search would require scraping, which BRIEF §1 forbids. The Audio tab ships uploads + beat detection and shows the Pixabay box disabled with that explanation. Pexels/Pixabay image and video B-roll arrives with the Brand Kit checkpoint.
- **Fonts for text parity**: the OFL fonts shipped for libass (`electron/main/assets/fonts`) are also served to the renderer so preview text and exported text use the same faces.
- **Migration 0004** only creates tables (EditorProject, EditorVersion, EditorExport).

---

## ADR-020 — CP4 Brand Kit architecture

- **A kit is a small JSON document + asset rows.** `BrandKit.spec` (`shared/brand.ts` `BrandKitSpec`: colours, watermark, intro/outro/music-bed references, hook card style, text styles, defaults) with an optimistic `rev` (stale `baseRev` → `CONFLICT`); `BrandAsset` rows hold kind (logo | image | video | audio | font), probed metadata and the storage keys. References inside the spec are validated on every update (must point at this kit's assets of the right kind); deleting an asset clears the references and says what it cleared. Subtitle Styles are the existing CP2 custom presets with `brandKitId` (no second style system).
- **Storage layout** `brand/<kitId>/<assetId>.<ext>`; derived files hang off the original's key (`.usable.png`, `.preview.mp4` / `.preview.m4a`, `.thumb.jpg`). Using the editor's existing `${key}.preview.mp4` convention means **brand assets are referenced by editor projects as ordinary `upload` assets** — preview, waveform, export and the project backup all work without a special case. An object an editor project still references is kept when its brand asset is deleted.
- **Usable copies**: SVG → PNG (≤ 2048 px) through an offscreen, script-less, network-blocked Electron window (no native image dependency to package); animated GIF → first frame; WOFF/WOFF2 → sfnt (libass/fontconfig cannot read web fonts). Compositing (finisher, editor, preview) uses `usableKey ?? storageKey`.
- **Fonts**: one merged directory (shipped fonts + brand fonts as `<assetId>.ttf|otf`) is what libass reads (`fontsdir`) for clips and for editor export; the caption `fontBook` is told about it so caption layout measures the real glyph advances. The renderer registers the same fonts with `FontFace` from presigned URLs (editor canvas, pickers, previews). Fonts are re-registered on start from storage (`reconcileOnStart`), so a wiped app-data folder heals itself.
- **Applying a kit to clips is a post-pass, not a second renderer.** The clip renderer is unchanged apart from the hook card style; `BrandFinisher` runs one extra FFmpeg pass (watermark overlay placed by the shared `watermarkRect`, intro/outro join, music bed ducked by the programme audio with `sidechaincompress`, final loudness normalised to −14 LUFS) and only when the kit actually switches something on. Cost: one extra encode at high quality (crf 17) — accepted for isolation (CP1/CP2 render behaviour is byte-identical without a kit) and because a clip re-renders from its source anyway. SRT/VTT sidecars are shifted by the intro length.
- **Which kit a clip uses** (`resolveBrandKitId`): `Clip.brandKitId` (explicit override: kit id | `'none'`) > the run's `PipelineOptions.brandKitId` (`'default'` | `'none'` | id) > the default kit. Applying a kit sets the override, adopts the kit's default subtitle style and re-renders; the clip records `brandApplied {kitId, rev}` so the UI can show "kit changed since this render". For NEW runs the kit's subtitle style is used only while the run's own style is the built-in default (an explicit choice always wins).
- **Editor**: `applyBrandToProject` is a pure function (idempotent; watermark/intro/outro/music/subtitle style/hook text) applied as ONE undoable operation; new projects take the default kit's parts. Brand fonts, colours, images, videos and audio are offered inside the editor panels.
- **Stock B-roll**: Pexels and Pixabay official video APIs only (keys from Settings → API Keys; responses parsed tolerantly; 60 s search cache; rate-limit and key errors are plain-language). Downloads are ≤ 1080p MP4 and go to a project's media bin or a kit's Videos section with the provider credit kept. Claude suggests 3–5 concrete search queries from a transcript passage (fast model, cost-tracked). Pixabay has no official music API (see ADR-019), so music beds come from uploads.
- **Migration 0005** adds `BrandKit`, `BrandAsset` and one nullable column on `Clip` (no table redefinition).
- **Ids the editor and exporter rely on** (`shared/brand-apply.ts`): project asset `ba_<brandAssetId>`; items `brand_intro`, `brand_outro`, `brand_wm`, `brand_music_<n>`; tracks `tr_brand_wm`, `tr_brand_music`; a hook text item restyled from a kit carries `styleRef = brand:<kitId>:<textStyleId|hook>` (an item named "Hook" is recognised too). Applying is ONE undoable store operation (`replaceProject` in the editor store). In the editor the music bed spans the programme; in a rendered clip it runs under the whole result (intro + clip + outro) — they differ on purpose (an editor user can drag it).
- **Late caption presets** (a kit's subtitle style saved after startup) are re-read before every editor export (`primeStyles`), found by the real-app e2e.
- **CSP**: `font-src` allows `https:` (presigned storage URLs) so brand fonts load in the renderer; found by the real-app e2e.
- **Dev/test-only switches**: `CLIPFERN_PEXELS_BASE_URL`, `CLIPFERN_PIXABAY_BASE_URL` point the stock B-roll service at a fake provider.

---

## ADR-021 — CP5 posting + scheduler architecture

- **Official APIs only, one `PublisherProvider` per platform** (`electron/main/pipeline/contracts5.ts`): YouTube Data API v3 (`videos.insert`, resumable upload, own channel), Instagram "API with Instagram Login" (Reels container → poll → `media_publish`, the video is PULLED by Instagram from a presigned storage URL), TikTok Content Posting API (Direct Post or upload to the inbox/drafts). No scraping, no password automation. Platform ids reuse CP2's (`shorts`, `reels`, `tiktok`) so a clip's per-platform metadata maps 1:1 onto a post's fields.
- **Accounts + tokens.** OAuth for a desktop app (RFC 8252): system browser, loopback redirect `http://127.0.0.1:<port>/oauth/<platform>` on a FIXED, configurable port (default 53682, Settings → Scheduler) because every platform needs the redirect URI pre-registered; PKCE S256 + random `state` (TikTok wants the challenge hex-encoded: handled in its provider); one flow at a time, 5-minute timeout, cancelable. The user's own developer apps (client id/secret) live in the safeStorage secret store; tokens live in `tokens.bin` (same cipher), main process only: the renderer sees account rows, never a token (an e2e checks IPC output, the encrypted file and the log for every issued token).
- **Posts are database rows** (`Post`, migration 0006: draft | scheduled | queued | publishing | published | failed | missed | canceled) and publishing is a **durable queue job** (`posts.publish`, `maxAttempts: 1`: retries are ours). The job downloads the clip/export (cached by key+size), probes it, validates it against the platform's published limits (`shared/platform-specs.ts`, each number sourced and dated), **auto-fixes** fixable problems with ONE re-encode (never crops/trims/enlarges; the fixed copy is uploaded to `posts/<id>/media.mp4`), refreshes tokens (Instagram a week ahead, others minutes), checks the platform quota BEFORE uploading, publishes, records the result + quota use and notifies.
- **Retry policy** (`services/publish/retry.ts`, `decideRetry`, table-tested): auth/validation/media/unknown never retried; network/platform back off 1 min → 5 → 20 → 60 → 120 (±20 % jitter); rate limits honour `Retry-After`; quota errors wait for the reset (+1–2 min), not seconds. A failed post keeps the platform's own words and a hint. A user abort is a cancel, not a failure.
- **Scheduler** (`pipeline/scheduler.ts`): a tick loop (10 s) in the Electron main process that hands due posts to the queue; pause/resume persisted; the first tick after launch is the **catch-up**: late but within the grace window (default 120 min) → published, later → `missed` ("reschedule?", one click). A daily digest notification. **Tray / menu bar**: with tray mode on, closing the window hides it and the scheduler keeps running (Linux without a status-notifier host quits as before, so the window can never be lost); quitting with posts pending asks first. Not verified on macOS/Windows.
- **Smart spacing** (`shared/scheduling.ts`, pure, shared by the dialog preview and main): per-account min gap + max per day inside posting windows (default: the default Brand Kit's windows, else lunch/evening), one post per window occurrence, DST-safe zone arithmetic without a tz library. The default Brand Kit's hashtag sets and windows (stored since CP4) are finally consumed by `publish:prefill`.
- **Quota truth.** YouTube's current quota page lists `videos.insert` as its own bucket (100/day, 1 unit each) instead of ~1,600 of 10,000 units: the app follows the page, shows "N more posts today", and the explainer says older guides differ. Instagram: the platform's own `content_publishing_limit`; TikTok: ~15 posts/day estimate + the creator's `max_video_post_duration_sec`.
- **TikTok unaudited apps** can only post privately: `creator_info` is read first and only offered privacy levels are accepted; a request the account cannot have is downgraded to the most private allowed level WITH a note on the post; "upload to drafts" mode is offered; the Settings page carries the audit checklist. Public posting needs TikTok's audit (cannot be solved in code).
- **Serverless-worker interface (BRIEF §9).** The only coupling between "when" and "how" is `PostingService.dispatchDue({ graceMs })` → posts to run, and `runPublish(postId)`; both read only the database, the token store and a `StorageProvider`. A hosted worker would run the same query on a shared database/queue with the stored tokens (moved to a server-side secret store) and call the same publish routine; nothing in `scheduler.ts`/`posting.ts` depends on Electron (the host injects the clock, notifier, tray and `openExternal`).
- **Dev/test-only switches** (never needed in production): `CLIPFERN_GOOGLE_OAUTH_BASE`, `CLIPFERN_YOUTUBE_API_BASE`, `CLIPFERN_YOUTUBE_UPLOAD_BASE`, `CLIPFERN_META_OAUTH_BASE`, `CLIPFERN_GRAPH_BASE`, `CLIPFERN_TIKTOK_AUTH_BASE`, `CLIPFERN_TIKTOK_API_BASE`, `CLIPFERN_SCHEDULER_TICK_MS`, `CLIPFERN_SKIP_QUIT_CONFIRM`, `CLIPFERN_FORCE_TRAY`. The fake provider servers (`test/support/fake-*.ts`) enforce what the real ones enforce (PKCE, single-use codes, rotating refresh tokens, resumable-upload alignment…).
- **Known platform risks recorded, not solved:** Instagram's redirect-URI field may require https (a loopback `http://127.0.0.1` URI could be refused: then a local certificate or a Facebook-Login variant is needed); Google may keep uploads private for an unverified API project; Instagram has no container→media lookup, so a connection lost exactly during `media_publish` can duplicate a Reel on retry; Instagram's publish limit is documented as both 50 and 100 per day.

## ADR-022 — One SQLite build per process

- The app used two different native libsql builds (`@libsql/client` 0.18 → libsql 0.5 for the migration runner, the Prisma adapter's nested libsql 0.3 at runtime). SQLite's POSIX file locks are per process, not per library instance: closing a connection of one build silently drops the locks of the other build on the same file. Symptoms: random `disk I/O error` / `database disk image is malformed` (reproduced 3 times by the CP5 restart e2e, gone after the change; plausibly the macOS "Could not save setting — disk I/O error" report, not confirmed there).
- Migrations now run through the SAME Prisma connection (`applyMigrations`, one transaction per migration + its bookkeeping row). `runMigrations(url)` (standalone client) is lazy-loaded and used by tests only. Do not import `@libsql/client` from application code.
- **Self-healing (added after a user's macOS log showed `queue tick failed: DriverAdapterError: disk I/O error` every 1.5 s):** `DbHandle.prisma` is a stable proxy and `DbHandle.reconnect()` swaps in a fresh Prisma client + SQLite connection (the old one stays open 5 s so running queries finish). `isDbFault` (I/O error, corrupt/malformed, cannot open) triggers it from the job queue's poll and from the settings writer, at most once per 10 s; the third reconnect in two minutes logs ONE explanation (damaged file, network/cloud-synced folder, a second Clipfern instance). The queue logs the first failure of an outage and then one line per 40 polls instead of one every poll. The macOS root cause itself is NOT confirmed: this is a safety net, not a diagnosis.
- **Repair at startup (after the user's macOS screenshot "Could not save setting: database disk image is malformed", i.e. the FILE was damaged, probably by the old two-SQLite-builds bug):** before the real connection opens, `PRAGMA quick_check` runs (same SQLite build). A damaged or non-database file is MOVED ASIDE as `clipfern.db.corrupt-<time>` (+ `-wal`/`-shm`; nothing is deleted), a fresh database is built and migrated, and every readable row is copied table by table, row by row (a bad page costs only the rows on it; rows that fail on a foreign key get a second pass). The user gets a notification with the counts; the log has the reason. API keys (`secrets.bin`, `tokens.bin`) and storage objects are separate files and are untouched. `close()` now checkpoints the write-ahead log, so a cleanly closed database is a single file. After three failed reconnects at runtime an OS notification asks the user to restart (the repair then runs).
