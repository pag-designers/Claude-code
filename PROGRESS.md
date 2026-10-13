# PROGRESS.md

**Current checkpoint:** CP0 — Foundation (runnable shell) — **DONE (Linux-verified), waiting for the user's "go" before CP1**
**Last updated:** 2026-10-13
**Resume with:** "read PROGRESS.md and continue".

## Task status (CP0)

- [x] Brief read in full → `BRIEF.md`; `CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md` (ADR-000…015), `.env.example`
- [x] App name **Clipfern** (clipfern.com unregistered per Verisign RDAP, 2026-10-13)
- [x] Scaffold: Electron main/preload (esbuild), Next 15 static export served via `app://`, Tailwind v4, shadcn-style components, shared Zod IPC contract, Husky (lint-staged + typecheck + tests)
- [x] SQLite via Prisma 6 + libsql adapter, schema v1, embedded migration runner
- [x] Durable job queue (restart recovery, priority, per-kind concurrency, retry/backoff, cancel)
- [x] Secrets (Electron safeStorage, flagged insecure fallback), masked status only
- [x] Storage: `StorageProvider` + `S3Provider` (R2/B2), live usage, 80% alert
- [x] Notifications (DB + push + OS), cost tracker, key validators (Anthropic, R2/B2, Pexels, Pixabay, Whop)
- [x] Binaries: bundled ffmpeg/ffprobe; yt-dlp auto-download through the queue
- [x] Python sidecar (uv + venv + faster-whisper + PySceneDetect + MediaPipe, model download w/ progress, crash restart)
- [x] Design system, all pages, Settings (9 sections), command palette, notifications bell, storage indicator, light/dark without flash
- [x] Packaging: `pnpm dist` → `release/Clipfern-0.1.0.AppImage` (194 MB) + `.deb` (157 MB)

## Verified (what was run)

| Check                                                                                  | Result                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`                                                          | clean                                                                                                                                                                                                                                                                                  |
| `pnpm test`                                                                            | **144 unit tests pass** (IPC contract, secrets encryption at rest, queue incl. restart recovery, storage incl. **S3Provider vs a real S3-protocol server**, validators vs stub servers, cost, notifications, migrations, settings, sidecar logic, AA contrast of design tokens)        |
| Electron e2e, dev bundle                                                               | `app-shell.spec.ts` 12/12 in the REAL app + `renderer-shots.spec.ts` 17/17                                                                                                                                                                                                             |
| Electron e2e, **packaged binary** (`CLIPFERN_E2E_EXE=release/linux-unpacked/clipfern`) | 12/12: no `require/process` in renderer, strict CSP, typed IPC errors, settings→SQLite, secrets masked + encrypted on disk, queue ran startup jobs, ffmpeg/ffprobe run, theme persists, all 8 pages clean, 0 hydration errors over 24 full loads, honest sidecar "not installed" state |
| Sidecar (real, CPU, this sandbox)                                                      | clean setup 41 s; `tiny` transcribed a real speech clip with word timestamps (2.6 s for 11 s audio); scene cut found; face found / none in blank clip; `kill -9` → auto-restart; no orphans                                                                                            |
| Screenshots                                                                            | ~100 PNGs, 3 critique rounds (dark/light, fresh/configured, collapsed, ultrawide, mac/win chrome simulated)                                                                                                                                                                            |

### Bugs found by verifying and fixed (all have regression tests)

1. `settingsPatchSchema = settingsSchema.partial()` re-applied zod defaults → a one-key `settings:set` reset all other settings.
2. IPC error codes were lost across `contextBridge` → now encoded/decoded (`encodeIpcError`/`decodeIpcError`).
3. `SidecarManager` settings closure used before init (caught by smoke-booting the bundle).
4. Intermittent React #418 on reload: layout imported a constant from a `'use client'` module (→ client reference, hydration waited on a lazy chunk). Moved to `lib/pre-paint.ts`; 0/60 errors after (4–13 per 20 before).
5. Packaged app crashed at start: generated Prisma client (`node_modules/.prisma`) wasn't packed → added via `files: {from,to}`. Also: a leading `!` pattern in `files` makes electron-builder pack the entire repo; per-platform ffprobe binaries filtered; renderer-only deps moved to devDependencies (installer 418 MB → 194 MB).

## NOT verified (honest list)

- **macOS / Windows**: no installer built or launched (config is in `electron-builder.yml`); build each on its own OS (native libsql/ffmpeg/ffprobe are per-platform). Traffic-light / `titleBarOverlay` drag regions were only simulated in Chromium. Notarization is CP8.
- **GPU** (CUDA/NVENC/VideoToolbox): no GPU here. Whisper `large-v3-turbo` was not downloaded (`tiny`/`base` used).
- **Live services**: real R2/B2, Anthropic and Whop keys were not available; validators ran against stub servers and a real S3-protocol server. Do Settings → API Keys / Storage → **Test** once on your machine.
- **OS keychain**: this container has none, so only the insecure-fallback path ran (Settings → Diagnostics shows a warning whenever it is active).
- **yt-dlp download / uv download** ran in the sandbox (network OK); a real YouTube ingest is CP1.

## Known issues / notes

- Sidebar logo mark is a leaf glyph; `build/icon.svg` (play-in-C) is the app icon — align in a polish pass.
- Linux MediaPipe needs `libegl1 libgles2` (selfcheck reports it).
- `release/` and `dist-electron/` are build outputs (gitignored).

## Next step

Wait for the user's **"go"**, then start CP1 (YouTube → clips): ingest (yt-dlp) → transcribe → understand → Find Moments + Virality Score → reframe → captions → hook → render, with streaming of first clips.
