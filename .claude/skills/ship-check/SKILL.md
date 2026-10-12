---
name: ship-check
description: Multi-step quality gate for Clipper. Runs four specialist reviewers in parallel (windows-checker, code-verifier, first-run-tester, ui-designer), verifies every finding, fixes the real ones, re-tests, and only then commits and pushes. Use before every push, after any change, or when the user says "check everything", "make sure it works", or "ship it".
---
# Ship check: make it work on the user's first try

The user runs Clipper on **Windows**, isn't a programmer, and pays for every failed attempt with frustration.
Linux tests have repeatedly missed Windows-only bugs. This process exists so the next version works first time.

## Step 1: Frame the change (you, before any agent)
- `git status`, `git log --oneline -15`, `git diff` against the last commit the user actually ran (ask, or
  use the last commit before this session's work). Write down in 3–6 bullets what changed and which user flows it
  touches (launch, settings, ingest, transcribe, clipping, scoring, render, edit, campaign, export, UI).
- Run the fast checks yourself first and fix anything red before spending agents:
  `.venv/bin/python -m pytest -q tests`, `python -c "import backend.app.main"`, `bash -n run.sh`.

## Step 2: Fan out to four reviewers in parallel
Launch these with the Agent tool **in one message** so they run concurrently. Use the project agents in
`.claude/agents/` if they're available in this session; otherwise use `general-purpose` agents and paste the
agent file's body as the prompt. Give each one the change summary from Step 1, the branch name, and the path of
the cached test video folder in `data/`. Tell each to use its own port (8123/8124/8125) and to clean up after itself.

| Agent | Looks for |
|---|---|
| `windows-checker` | Anything that breaks on Windows: PATH, .exe names, encodings, run.bat parsing, file locks, wheels |
| `code-verifier` | Real bugs, reproduced by running tests, every API route, and the pipeline (fake LLM for AI steps) |
| `first-run-tester` | The beginner's journey from fresh download to first export; every confusing wait or message |
| `ui-designer` | Looks, layout, typography, color, motion, sound, copy, states, mobile and accessibility, from real screenshots |

Skip an agent only if the change can't affect its area (e.g. a prompt-text tweak doesn't need ui-designer), and
say which ones you skipped and why.

## Step 3: Verify every finding (don't trust, reproduce)
For each finding: reproduce it, or trace a concrete input to the failure. Sort into:
- **Fix now**: real and likely to hit the user (always: anything Windows, anything that blocks a flow, unclear
  errors, broken UI).
- **Fix if cheap**: real but rare, and the fix is small.
- **Reject**: can't reproduce, or the fix costs more than the problem; note why in one line.
For design findings, apply your own taste: keep the app's style consistent; don't adopt changes that add clutter.

## Step 4: Fix
Apply the fixes with minimal diffs that match the surrounding code style. Group related changes. For Windows
fixes you can't run, simulate (no-venv PATH, non-ASCII paths, spaces in paths) and re-read the batch file line by
line.

## Step 5: Re-verify
Re-run Step 1's fast checks, plus each failing scenario from Step 3 to show it now passes. For UI changes, take
fresh screenshots and look at them. If something new breaks, loop back to Step 3. Don't push red.

## Step 6: Ship and report
- Update CLAUDE.md "Current status" if behaviour changed. Commit with a clear message and push to the session
  branch.
- Tell the user in plain words: what was checked (each agent, one line), what was fixed, what was rejected and
  why, what still can't be tested here (anything needing their Windows PC or a real API key), and the exact
  thing they should do next (usually: double-click run.bat, which auto-updates).
