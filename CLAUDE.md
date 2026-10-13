# CLAUDE.md — Clipfern

AI YouTube clipping desktop app (Electron + Next.js). **`BRIEF.md` is the single source of truth** — read it fully before big decisions. Decisions live in `DECISIONS.md`, live status in `PROGRESS.md`. To resume in a fresh session: _"read PROGRESS.md and continue"_.

## Run / build / test

```bash
pnpm install                # also runs prisma generate
pnpm dev                    # next dev (:3210) + esbuild watch + Electron
pnpm build                  # prisma generate, next export, esbuild main/preload
pnpm start                  # run the built app (Electron on dist-electron + renderer/out)
pnpm typecheck              # tsc --noEmit for shared+main+preload AND renderer
pnpm lint                   # eslint
pnpm test                   # vitest (unit + storage integration via s3rver)
pnpm test:e2e               # playwright-electron (needs xvfb on Linux: xvfb-run -a pnpm test:e2e)
pnpm dist                   # electron-builder installer for the current OS
```

Headless Linux: `xvfb-run -a pnpm start`.

CP1 real-media e2e (real yt-dlp/ffmpeg/faster-whisper/render; only the Claude answers are scripted — no key needed):

```bash
CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<userData with sidecar-venv+models+uv> \
  CLIPFERN_E2E_OUT=<dir for inspectable output> xvfb-run -a pnpm exec playwright test test/e2e/cp1-pipeline.spec.ts
node scripts/llm-smoke.mjs <transcript.json> [--dry-run]   # with ANTHROPIC_API_KEY: real-model check + dollar cost
```

Dev/test-only env: `CLIPFERN_S3_ENDPOINT_OVERRIDE`, `CLIPFERN_ALLOW_ANY_URL=1`, `CLIPFERN_ANTHROPIC_BASE_URL` (see `.env.example`). Set `CLIPFERN_USER_DATA=/some/dir` to isolate app data.

## Architecture (see DECISIONS.md ADR-000)

- `shared/` Zod IPC contract + types (used by main, preload, renderer). **Add a channel here first.**
- `electron/main/` services: db (Prisma+libsql), queue (durable), secrets (safeStorage), storage (S3Provider R2/B2), notifications, binaries (ffmpeg/yt-dlp), sidecar (uv/venv/faster-whisper), validators, ipc handlers.
- `electron/main/pipeline/` (CP1): `contracts.ts` (module interfaces), `orchestrator.ts` (windowed streaming pipeline on the queue), `render-worker.ts` (one clip: reframe → captions → hook → ffmpeg → upload), `library.ts` (list/favorite/delete/download), `wiring.ts` (builds all services), `state.ts`, `views.ts`, `signals-merge.ts`.
- `electron/main/services/{media,analysis,llm,moments,reframe,captions,render}/` (CP1): yt-dlp+ffmpeg, audio signals/sentences, Claude layer, candidate moments, face-tracked crop path, ASS captions (Clean Pop), FFmpeg render.
- `electron/preload/` strict contextBridge: only contract channels.
- `renderer/` Next 15 static export, Tailwind v4, shadcn/ui, Zustand, TanStack Query. Never sees secrets.
- `sidecar/` Python FastAPI (faster-whisper, MediaPipe, PySceneDetect).
- `prisma/` schema + migrations (applied at startup by embedded runner).

## Conventions

- TypeScript strict, no `any` without a comment. Validate every IPC payload with Zod (input AND output).
- Secrets only in main (`safeStorage`). Never log them. Renderer can only ask “is set?” / set / clear.
- Every domain table has `ownerId String @default("local")`.
- No placeholders / fake data in shipped paths. LATER features: hidden or disabled with tooltip “Coming in a later version”.
- Design tokens only (CSS variables in `renderer/app/globals.css`); no hard-coded colors in components. Motion 120/200/320 ms; honour `prefers-reduced-motion`.
- Tests next to behaviour: `test/unit/**`, `test/e2e/**`, fixtures in `test/fixtures`.
- Update CLAUDE.md / PROGRESS.md / DECISIONS.md whenever things change.

## Checkpoints (status)

| #   | Name                        | Status                                    |
| --- | --------------------------- | ----------------------------------------- |
| 0   | Foundation (runnable shell) | **DONE (Linux-verified) — awaiting "go"** |
| 1   | YouTube → clips (core)      | **DONE (Linux-verified) — awaiting "go"** |
| 2   | Clip intelligence depth     | not started                               |
| 3   | Full editor                 | not started                               |
| 4   | Brand Kit                   | not started                               |
| 5   | Posting + Scheduler         | not started                               |
| 6   | Whop                        | not started                               |
| 7   | Live Clipping               | not started                               |
| 8   | Polish & hardening          | not started                               |

Rule: never start checkpoint N+1 until the user says “go”.
