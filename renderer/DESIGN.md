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

`Button` (primary · secondary · outline · soft · ghost · danger · danger-ghost · link; xs–lg + icon sizes; `loading`) · `Badge` · `Card` · `Input` · `Field` · `Label` · `Select` · `Switch` · `Segmented` (radio group, animated thumb) · `ChipGroup` · `Tabs` · `Dialog` · `Popover` · `DropdownMenu` · `Tooltip` / `Tip` / `DisabledTip` · `ScrollArea` · `Separator` · `Progress` (determinate, indeterminate, markers) · `ProgressRing` · `Skeleton` · `Kbd` (⌘ on macOS, Ctrl elsewhere) · `Banner` · `EmptyState` · `StatCard` · `PipelineStageCard` · `ScoreBadge` / `ScoreChip` · `SecretInput` · `Toaster` (sonner, themed) · `LogoMark` · brand glyphs.

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
