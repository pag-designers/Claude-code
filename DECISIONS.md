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
- **Streaming first clips (BRIEF §4.5):** the audio is transcribed in **10-minute windows** (4 s padding each side so boundary words are not cut; words are kept by midpoint). While window *k+1* transcribes, window *k* is ranked by the LLM; moments scoring ≥ 72 start rendering immediately, the rest wait for the final selection (top N, or all ≥ minScore). Ranking context overlaps the previous window by `maxClipSec + 15 s`; moments that start before the current window are left to the previous one; overlapping duplicates (IoU > 0.35) keep the higher score.
- **LLM returns sentence ids, not seconds** (removes timestamp hallucination); code converts to times and re-snaps to word boundaries (never mid-word, 120–250 ms padding).
- **Understand (overview/chapters/notes)** runs once the full transcript exists, concurrently with the last renders. Moment ranking does not wait for it (analysis context is optional).
- **Local disk is a temp cache** (`userData/cache/<videoId>`): the full-res source is deleted at finalize; only the 480p proxy is uploaded (`keepSourceAs`, default `proxy480`); a later re-render re-downloads the source (`ensureSource`). Rendered clips are uploaded then deleted locally; playback uses presigned URLs.
- **Cross-run cache:** `cache/yt-<sourceId>/<whisperModel>/{transcript,signals}.json` in object storage — re-running the same video (new clip length, steering prompt) skips ASR entirely.
- **Storage keys** are defined once in `shared/pipeline.ts` (`keys`).
- **Models:** defaults moved to `claude-sonnet-5-5` (moments/understand) and `claude-haiku-5-5` (cheap tasks) per the brief's "newest Sonnet/Haiku"; pricing table updated ($2/$10 and $0.10/$0.50 per MTok). Estimated cost for a 15-min video is a few cents (see PROGRESS.md for the measured token counts).
- **YouTube bot checks** (datacenter IPs): ingest tries default clients, then `android_vr` (360p progressive only, with an explicit quality-limited message), then fails with an actionable "use cookies from browser" error. Verified in this sandbox that metadata works but downloads are intermittently blocked.
- **Dev/test-only switches (never needed in production):** `CLIPFERN_S3_ENDPOINT_OVERRIDE` (S3 emulator), `CLIPFERN_ALLOW_ANY_URL=1` (direct media URL via yt-dlp's generic extractor), `ANTHROPIC_BASE_URL` (stub Claude server).
- **Queue:** global concurrency is `max(settings.concurrency, 3)` so one pipeline job and two renders can always run together.
