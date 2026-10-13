# Clipfern renderer — design system

Everything visual comes from tokens in `app/globals.css`. Components never hard-code a colour, radius, shadow or duration.
A live reference of every primitive is the unlisted route `/design/` (not in navigation).

## Principles

1. **Dark-first, true light mode.** Same tokens, two palettes. Theme = `system | light | dark`, stored in the `theme` setting (`settings:get/set`) and mirrored to `localStorage` so the inline `<head>` script (`lib/prefs.ts → PRE_PAINT_SCRIPT`) sets `data-theme` before first paint. No flash, no hydration mismatch (React reads `<html data-*>` back through `useSyncExternalStore`).
2. **Dense but airy.** 14 px body, 4 px spacing grid, generous card padding (20 px), 32 px page gutters, content capped at 1360 px (1680 px for wide pages such as Scheduler).
3. **Honest UI.** No fake data. Zeros are real and labelled with when they start moving. Unavailable features are rendered disabled with a tooltip (`DisabledTip`): "Arrives in checkpoint N" or "Coming in a later version".
4. **Offline.** Fonts are self-hosted woff2 in `public/fonts` (Inter Variable for UI, Space Grotesk Variable for display). No runtime network requests.

## Tokens

| Group       | Tokens                                                                                                   | Notes                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Surfaces    | `background`, `sidebar`, `card`, `raised`, `popover`, `muted`, `accent`, `field`                         | `bg-card`, `bg-muted`, … in Tailwind                                                                             |
| Text        | `foreground`, `muted-foreground`, `subtle`                                                               | all ≥ 4.5:1 on `background`, `card` and `muted` in both themes (enforced by `test/unit/renderer-tokens.test.ts`) |
| Lines       | `border`, `border-strong`, `input`, `ring`                                                               | `ring` ≥ 3:1 on surfaces                                                                                         |
| Primary     | `primary` (fills), `primary-hover`, `primary-foreground`, `primary-text` (text/icons), `primary-soft`    | electric violet `#6a4bf2` / `#5b3ae8`                                                                            |
| Semantic    | `success`, `warning`, `danger`, `info` (+ `-soft` tints, `danger-solid`)                                 | text colour on its own soft tint ≥ 4.5:1                                                                         |
| Score tiers | `score-low` 0–49 muted · `score-mid` 50–74 amber · `score-good` 75–89 green · `viral-a/b/c` 90+ gradient | utilities `bg-viral`, `text-viral`                                                                               |
| Radius      | `xs 4 · sm 6 · md 8 · lg 12 · xl 16 · 2xl 24`                                                            | cards `xl`, controls `md`                                                                                        |
| Elevation   | `shadow-xs/sm/md/lg`, `shadow-glow`                                                                      | popovers `lg`, resting cards `xs`                                                                                |
| Type        | `2xs 11 · xs 12 · sm 13 · base 14 · md 15 · lg 17 · xl 20 · 2xl 24 · 3xl 30 · 4xl 38 · 5xl 48`           | headings use `font-display`; numbers use `tabular-nums`                                                          |
| Motion      | `--duration-fast 120ms · base 200ms · slow 320ms`, `--ease-standard/out/in/spring`                       | JS twins in `lib/motion.ts` (`duration`, `ease`, `spring.snappy/gentle/bouncy/drag`)                             |

Tailwind's default palette is removed (`--color-*: initial`), so `bg-red-500` cannot exist by accident.

### Reduced motion

`@media (prefers-reduced-motion: reduce)` collapses all CSS animation/transition durations, and the app is wrapped in `<MotionConfig reducedMotion="user">`, which drops framer-motion transforms.

### Focus

Global `:focus-visible` outline (2 px `ring`, 2 px offset). Text fields add a 3 px `ring/25` halo. Never remove an outline without replacing it.

## Primitives (`components/ui`)

`Button` (primary · secondary · outline · soft · ghost · danger · danger-ghost · link; xs–lg + icon sizes; `loading`) · `Badge` · `Card` · `Input` · `Field` · `Label` · `Select` · `Switch` · `Segmented` (radio group, animated thumb) · `ChipGroup` · `Tabs` · `Dialog` · `Popover` · `DropdownMenu` · `Tooltip` / `Tip` / `DisabledTip` · `ScrollArea` · `Separator` · `Progress` (determinate, indeterminate, markers) · `ProgressRing` · `Skeleton` · `Kbd` (⌘ on macOS, Ctrl elsewhere) · `Banner` · `EmptyState` · `StatCard` · `PipelineStageCard` · `ScoreBadge` / `ScoreChip` · `SecretInput` · `Toaster` (sonner, themed) · `LogoMark` · brand glyphs · (CP1) `Slider` (native range, `.range` in globals.css) · `Checkbox` (role=checkbox button, indeterminate) · `ConfirmDialog` · `StarButton`.

Never wrap a `Checkbox` (a `<button>`) in a `<label>`: the click reaches the button twice and it never toggles.

- **ScoreBadge** animates a count-up and ring sweep; ≥ 90 adds a gradient ring, pulsing glow and a one-shot spark burst. Reduced motion renders the final state immediately.
- **SecretInput** never receives a secret: it shows `status.masked` (last 4) from `secrets:status`. Save / Replace / Clear (two-step) / Test (`validate:run`, result chip with latency). `.env`-sourced values show "From .env" and can only be overridden.
- **EmptyState** is illustration-free: an icon lens over concentric rings and a dotted field, always with guidance and a next action.

## App shell

- Sidebar 248 px / 68 px collapsed (`<html data-sidebar="collapsed">`, persisted in `sidebarCollapsed`), active pill animated with `layoutId`, storage indicator pinned at the bottom (ring + `X.XX GB / 10 GB` + Manage → dialog with the real breakdown).
- Top bar 48 px: page title, command-palette trigger, notifications popover, theme menu.
- **Window chrome:** the top 36 px strip is a `-webkit-app-region: drag` region; every interactive element is `no-drag` in the base layer. `html[data-platform]` (set from `window.clipfern.platform`) reserves 36 px above the sidebar brand for macOS traffic lights and ≥ 138 px on the right of the top bar for Windows/Linux caption buttons (`env(titlebar-area-*)` when available).
- Command palette: ⌘/Ctrl+K. ⌘/Ctrl+B toggles the sidebar, ⌘/Ctrl+1…8 jump to pages, ⌘/Ctrl+, opens settings.

## Data layer (`lib/ipc.ts`)

`ipc.invoke` → `window.clipfern.invoke`, always rejecting with `IpcCallError`; `useIpcQuery` / `useIpcMutation` (TanStack Query); `useIpcEvent`. `components/shell/providers.tsx → EventBridge` writes pushed events (`settings:changed`, `storage:updated`, `jobs:updated`, `sidecar:progress`, `notifications:new`, `nav:go`) straight into the query cache. Without `window.clipfern` the app renders a full-page "Open Clipfern's desktop app" notice.

## Adding UI

1. Use a token (or add one to both theme blocks and `@theme inline`).
2. Reuse a primitive; if you need a new one, add it to `components/ui` and to `/design/`.
3. Every empty state gets guidance and an action; every disabled control gets a reason.
4. Check contrast: `pnpm test` runs the token contrast test.

## CP1: pipeline, library, video detail

| Area          | Where                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home hero     | `components/pages/home-hero.tsx`, `components/home/url-preview.tsx` | URL gate = `parseYouTubeId` (shared with main; `lib/urls.ts` only supplies friendlier wording). Debounced `pipeline:probe` preview (thumbnail, channel, duration, CC badge, chapters). Options come from settings defaults (`lib/start-options.ts`) and are sent **complete** to `pipeline:start`. Start is disabled with the first unmet prerequisite (`lib/readiness.ts`: Anthropic key, storage, ffmpeg/ffprobe, yt-dlp, transcription engine, budget hard cap) + a "Fix in Settings" link. |
| Pipeline view | `components/pipeline/pipeline-progress.tsx`                         | `PipelineProgress` (7 stages, determinate / indeterminate bar, message + ETA, run log, per-stage Retry with recovery link from `classifyFailure`, Cancel/Resume), `PipelineProgressCompact` + `StageSegments` for Home and Library cards. Folds to a one-line summary once clips arrive or the run is ready.                                                                                                                                                                                   |
| Library       | `components/pages/library-view.tsx`, `components/library/*`         | Tabs Videos · Clips · Favorites · Edited · Exported (`?tab=`). `ClipsBrowser` is shared by Library and the video page: filters (`lib/library-filters.ts`), grid/list, shift-click multi-select, floating `SelectionBar`, `ClipDrawer`. `ClipCard` loads thumbnails lazily (`useInView`), previews on hover (muted `<video>` from the presigned render URL) and plays the score count-up once per clip per session.                                                                             |
| Video detail  | `app/library/video/page.tsx` → `components/pages/video-detail.tsx`  | `/library/video/?id=<id>[&tab=…]` (static export: `useSearchParams` inside Suspense). A single `PlayerProvider` (`lib/player.tsx`) owns the proxy `<video>`; transcript, chapters, notes and the clip drawer seek it. `usePlayerSelector` re-renders a consumer only when ITS derived value changes. The transcript is windowed (`lib/virtual.ts`, measured row heights, ~30 DOM rows for 12k words).                                                                                          |
| Cost chip     | `components/shell/cost-chip.tsx`                                    | Top bar "AI $x / $target", tone by `cost:summary.level`, links to Settings → Models.                                                                                                                                                                                                                                                                                                                                                                                                           |

### Data layer for CP1

- `lib/library.ts`: query + mutation hooks (`useVideos`, `useVideo`, `useAllClips`, `useVideoClips`, favorites with optimistic update + rollback, deletes, retry/cancel, download).
- `lib/pipeline-cache.ts`: `EventBridge` writes `videos:updated`, `clips:updated` and `pipeline:event` straight into every cached `videos:list` / `clips:list` / `videos:get` query (no refetch, no polling). Deletions have no event, so mutations patch the cache. Cost has no event: pipeline activity invalidates `cost:summary` (throttled).
- `lib/pipeline-log.ts`: in-memory run log built from `pipeline:event`s (shown in the pipeline card).
- Deep links: `lib/hrefs.ts → normalizeHref` fixes `/library/video?id=x` and legacy `/settings?section=x` before `router.push` (used by `nav:go`, notification rows and toast actions).
- Media URLs (`clips:mediaUrl`, `videos:proxyUrl`) are presigned, cached for 20 min and re-fetched on a media `error`.

## CP2 (UI-A): subtitles, caption styles, tools

| Area                 | Where                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtitles tab        | `components/subtitles/*` (`subtitles-tab.tsx`, `use-subtitle-editor.ts`, `edits.ts`, `use-virtual-rows.ts`) | Video detail tab and the AI Subtitles tool. `edits.ts` is a pure model (word text/shift/hidden + forced breaks/merges, 50-level history) mirrored optimistically on the cue list; `subtitles:save` is debounced (700 ms), serialised, flushed when the tab unmounts, and its answer is adopted only when nothing newer happened. Cues are windowed by stable cue id (thousands of cues, ~30 DOM rows). Undo/redo: Ctrl/⌘ Z outside text fields. |
| Caption Style Studio | `components/captions/*` (`style-studio.tsx`, `style-gallery.tsx`, `style-editor.tsx`, `style-preview.tsx`)   | One reusable dialog: gallery (built-in + custom) · live libass preview · react-hook-form editor validated by the REAL `captionStyleSchema`. Previews come from `captions:preview` (`lib/cp2-captions.ts`): cached by a hash of the style JSON (id/name/builtin excluded), de-duplicated, gallery tiles limited to 2 concurrent and fetched only once visible; the editor preview is debounced 250 ms and keeps the previous image (dimmed) while loading. |
| Entry points         | `VideoCaptionStyleControl` (video header + subtitles toolbar), Home option, `StyleStudio` directly         | Applying from a video stores `videos:setCaptionStyle` and asks (dialog) whether to re-render the N existing clips (`clips:restyle`). Home sends `captionStyleId` + `reframeMode` in `pipeline:start`.                                                                                                                                                                                                                              |
| Colour picker        | `captions/color-field.tsx`                                                                                  | Native `<input type=color>` + hex field + swatches read from the `--swatch-*` tokens (the only hex-valued, theme-independent tokens; caption colours are data, not UI chrome).                                                                                                                                                                                                                                                  |
| Tools hub            | `components/pages/tools-view.tsx`, `lib/tools.tsx`, `lib/cp2-tools.ts`                                      | 15 cards (12 tools + 3 LATER). Cards without an `href` are disabled with "Coming in a later version". Command palette lists every tool.                                                                                                                                                                                                                                                                                         |
| Tool routes         | `app/tools/[tool]/page.tsx` → `components/tools/*`                                                          | `/tools/<tool>/?video=<id>&clip=<id>`: picker (library videos, search, last choice, "Analyse a new video" = `pipeline:start { mode: 'analysis' }` + live `PipelineProgress`) → tool body. `generateStaticParams` reads `TOOL_ROUTE_IDS` from `lib/cp2-tools.ts` (server-safe: no `'use client'`, no icons).                                                                                                                  |
