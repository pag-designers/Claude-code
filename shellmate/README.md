# 🐚 Shellmate — learn Claude Code, one bite at a time

A Duolingo-style web app that teaches [Claude Code](https://code.claude.com/docs) through short lessons,
practice exercises, hearts, XP and streaks. Your guide is **Kip**, a hermit crab whose shell is a tiny terminal.

No backend: all progress lives in `localStorage` (key `shellmate-v1`).

## Run it

```bash
cd shellmate
npm install
npm run dev        # → http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

`dist/` uses relative asset paths (`base: './'`), so it can be dropped onto any static host
(GitHub Pages, Netlify, an S3 bucket…).

## What's inside

- **13 units / 37 lessons / 297 exercises**, starting with **Unit 0 "Before You Start"** (terminal basics,
  command anatomy, reading JSON and Markdown) for people who have never coded, each with 1–2 theory cards and 6–10 exercises, plus a real-world
  **mission** at the end of every unit (bonus XP + badge).
- **8 exercise types**: multiple choice, fake terminal, fill-the-blank, order the steps, match pairs,
  spot the bad prompt, prompt workshop (local rubric grading, 1–3 ★), real-world mission.
- **Game mechanics**: XP (10 per first-try correct answer, +5 perfect lesson), **unlimited hearts by default**
  (switch to 5 hearts in Profile: −1 per mistake, +1 every 30 min, full refill by practising a finished lesson), daily streak with 1 auto-used freeze per
  ISO week, daily goal ring (20/50/100 XP), Leitner-box review deck, weekly league against 9 local bots,
  badges, and **Legendary** (replay a finished unit with zero mistakes to turn it gold).
- **Screens**: onboarding, winding path with unit guidebooks, lesson player, lesson complete,
  review, searchable cheat sheet with one-click copy, league, profile (streak heatmap, badges, settings,
  reset).
- Sound effects generated with the Web Audio API (no audio files) with a mute toggle; dark
  "terminal-cozy" theme with a light-mode toggle; keyboard support (1–4 to pick, Enter to check/continue,
  Ctrl/⌘+Enter inside text areas).

## Project layout

```
src/
  types.ts                 # the typed contract: Unit, Lesson, Exercise (discriminated union), …
  content/
    index.ts               # auto-loads every units/*.json via import.meta.glob
    badges.json
    units/u01-first-steps.json … u12-pro-habits.json
  components/
    exercises/             # one component per Exercise type + ExerciseRenderer
    Kip.tsx, TopBar.tsx, …
  screens/                 # Onboarding, Home (path), LessonPlayer, LessonComplete, Review, CheatSheet, League, Profile
  store/useGame.ts         # zustand game store persisted to localStorage (XP, hearts, streak, Leitner deck…)
  store/useNav.ts          # tiny in-memory screen router
  lib/grading.ts           # command equivalence + prompt-workshop rubric
  lib/progress.ts          # unlock rules for the path
  lib/league.ts            # deterministic weekly bots
  lib/sound.ts             # Web Audio beeps
```

## Adding a lesson (no code changes)

Open a unit file in `src/content/units/` and append to `lessons`:

```json
{
  "id": "u4-l5",
  "title": "Budgeting tokens",
  "description": "Keep your context lean.",
  "theory": [
    { "title": "Why it matters", "body": "Every message costs context.\n\nUse `/context` to see the budget.", "code": "> /context" }
  ],
  "exercises": [
    {
      "id": "u4-l5-e1",
      "type": "multiple-choice",
      "prompt": "Which command visualizes current context usage?",
      "options": ["/context", "/memory", "/init", "/agents"],
      "answer": 0,
      "explanation": "/context shows what is filling your context window."
    },
    {
      "id": "u4-l5-e2",
      "type": "terminal",
      "prompt": "Summarize the conversation to free up context.",
      "promptSymbol": ">",
      "accepted": ["/compact"],
      "hint": "It compacts…",
      "explanation": "/compact replaces history with a summary."
    }
  ]
}
```

Rules: ids must be globally unique; lessons unlock in file order; units are ordered by their `order`
field. To add a **whole unit**, drop a new `uNN-something.json` into `src/content/units/` — it's
picked up automatically. Every exercise shape is documented in `src/types.ts`:

| `type`             | key fields |
|--------------------|-----------|
| `multiple-choice`  | `prompt`, `options` (4), `answer` (index) |
| `terminal`         | `prompt`, `accepted[]`, `promptSymbol` (`$` shell / `>` in-session), `hint` |
| `fill-blank`       | `prompt`, `code` with `___` blanks, `blanks[]` (in order), `wordBank[]` |
| `order-steps`      | `prompt`, `steps[]` in the correct order (shuffled at runtime) |
| `match-pairs`      | `prompt`, `pairs[{left,right}]` |
| `spot-bad-prompt`  | `prompt` (scenario), `options` [A, B], `better` (0/1) |
| `prompt-workshop`  | `scenario`, `files[]`, `keywords[]`, `sample` |
| `mission`          | `title`, `intro`, `checklist[]`, `bonusXp`, `badge` (unit-level `mission` field) |

Every exercise also needs a one-sentence `explanation`.

## Design decisions

- **Teach before testing.** Every lesson's theory cards show the exact command or config shape an
  exercise will ask for, exercises run from recognition (multiple choice, matching) to production
  (fill-in, terminal, prompt writing), and a **Tips** button in the lesson player reopens the theory at
  any time. Terminal and fill-in exercises always have a hint.

- **Lives in `shellmate/`.** The repository already contained an unrelated static page (`index.html`
  at the root), so the app was scaffolded in its own folder rather than overwriting it.
- **Zustand + `persist`** instead of hand-rolled context: tiny, typed, and gives localStorage
  persistence for free.
- **No router.** A handful of screens are switched from store state; it keeps the bundle small and
  the lesson flow simple.
- **Tailwind v4 with CSS variables.** Colours are tokens on `:root`; light mode swaps the tokens via a
  `.light` class, so every component themes without `dark:` variants. Code blocks stay dark in light
  mode, like a real terminal.
- **Command grading** normalizes whitespace, quote style and a leading `$`/`>`, and treats flags as
  order-independent (`claude -p --output-format json "hi"` ≡ `claude --output-format json -p 'hi'`).
  Short and long flag forms are listed explicitly in each exercise's `accepted` list.
- **Prompt workshop** grading is a local heuristic rubric (context, specific goal, constraints,
  definition of done, file references) — no API calls. 4–5 checks = ★★★, 2–3 = ★★, 0–1 = ★.
  ★★ or better counts as correct.
- **XP only for first-try answers.** Missed exercises are re-queued at the end of the lesson and added to
  the Review deck, but re-answering gives no XP.
- **Hearts regenerate lazily** (computed from a timestamp), so there are no timers running in the
  background. Practice, review and legendary runs don't cost hearts; Legendary fails on the first mistake.
- **Streak freeze**: if you miss exactly one day, a freeze is used automatically (max one per ISO week).
- **League bots** are deterministic per week (seeded PRNG), so the leaderboard is stable across reloads.
- **Testing out of Unit 1** ("Some coding" / "I'm a dev" in onboarding) marks its lessons complete
  without XP.
- **Content accuracy**: commands, flags and shortcuts were checked against the official Claude Code docs
  (code.claude.com/docs) as of October 2026. Features whose behavior has changed recently (e.g. the old
  `#` memory shortcut) were deliberately left out.
- **Legendary is per lesson**: replay each finished lesson of a unit with zero mistakes; once every lesson
  in the unit is legendary, the unit's nodes turn gold.
- **Theory cards only show on the first run**; practice/legendary go straight to exercises (the
  Guidebook on each unit banner keeps all theory one tap away).
- **Navigation is in-memory**, so a browser refresh returns to the path (progress is never lost).
- **One bundle** (~190 kB gzipped, content included); code-splitting wasn't worth the complexity for an MVP.
- **Kip** is an original SVG character (no third-party mascots or logos).
