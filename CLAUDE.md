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

CP2 real-media e2e (same env vars; 13 tests: presets, restyle, subtitles, hooks, meta, thumbnails, reframe, highlights, steered run, analysis mode, chat):

```bash
CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> xvfb-run -a pnpm exec playwright test test/e2e/cp2-features.spec.ts
node scripts/llm-smoke.mjs <transcript.json> --cp2 [--dry-run]   # real-model check of hooks/meta/highlights/chat
```

CP3 editor: `test/e2e/editor-parity.spec.ts` (preview vs export frames), `editor-compositor|playback|timeline|panels` specs run on `renderer/out`; `editor-inspector.spec.ts` needs a private lab export (`test/e2e/support/inspector-lab/build-lab.sh <work> <out>`, then `CLIPFERN_E2E_OUT=<out>`). Real-media editor e2e (8 tests incl. a REAL export; Electron gets SwiftShader flags because xvfb has no GPU):

```bash
CLIPFERN_E2E_CP1_VIDEO=<mp4> CLIPFERN_E2E_SIDECAR_USERDATA=<ud> CLIPFERN_E2E_OUT=<dir> xvfb-run -a pnpm exec playwright test test/e2e/cp3-editor.spec.ts
```

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
- `electron/main/pipeline/` (CP1+CP2): `cp2.ts` (caption-style/subtitle/highlight/hook/meta/thumbnail/marker service), `chat.ts` (AI Chat + tool executors), `styles.ts` (caption style registry), `contracts2.ts` (CP2 module interfaces), `contracts.ts` (module interfaces), `orchestrator.ts` (windowed streaming pipeline on the queue), `render-worker.ts` (one clip: reframe → captions → hook → ffmpeg → upload), `library.ts` (list/favorite/delete/download), `wiring.ts` (builds all services), `state.ts`, `views.ts`, `signals-merge.ts`.
- `shared/editor.ts` (Project JSON) + `shared/editor-eval.ts` (pure evaluator used by BOTH the WebGL preview and the FFmpeg exporter — change semantics there only). `electron/main/pipeline/{editor,editor-projects,contracts3}.ts` (EditorService: CRUD/versions/open-from-clip/export job), `electron/main/services/{editor-export,editor-media}/` (project→FFmpeg compiler, waveform/beats/strips). `renderer/lib/editor/{core,compositor,playback}`, `renderer/components/editor/**`, `renderer/app/editor/page.tsx`.
- `electron/main/services/{media,analysis,llm,moments,reframe,captions,subtitles,thumbnails,chat,render}/` (CP1+CP2): yt-dlp+ffmpeg, audio signals/sentences, Claude layer, candidate moments, face-tracked crop path, ASS captions (Clean Pop), FFmpeg render.
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
| 2   | Clip intelligence depth     | **DONE (Linux-verified) — awaiting "go"** |
| 3   | Full editor                 | **DONE (Linux-verified) — awaiting "go"** |
| 4   | Brand Kit                   | not started                               |
| 5   | Posting + Scheduler         | not started                               |
| 6   | Whop                        | not started                               |
| 7   | Live Clipping               | not started                               |
| 8   | Polish & hardening          | not started                               |

Rule: never start checkpoint N+1 until the user says “go”.
