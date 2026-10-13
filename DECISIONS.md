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
