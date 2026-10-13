# Getting the best out of Claude Code (Clipper playbook)

Honest note first: no prompt makes an AI "never wrong". What works is a **loop that catches mistakes before you see them**:
write the code, run it, look at it, have separate reviewers attack it, fix, then ship. This project already has that loop
(`/ship-check`). The rest of this page is how to keep it that way and how to keep long chats sharp.

## 1. The three things that matter most

1. **Put rules in `CLAUDE.md`, not in chat.** Claude re-reads it at the start of every session, so it never "forgets".
   Anything you'd repeat twice (how to run, design rules, "you're on Windows and not a programmer") belongs there.
2. **Always ask for proof, not promises.** "Done" should come with: tests that passed, the page screenshotted at desktop
   and phone width, zero console errors, and what was NOT tested. If it can't prove it, it should say so.
3. **Small steps, one goal per chat.** Long chats get sloppy because old details crowd out new ones. See section 4.

## 2. The prompt to paste at the start of a big task

Copy everything between the lines:

=====

Task: <one sentence: what you want and who it's for>.

Before you write any code:
1. Read `CLAUDE.md` and the files you will touch. Tell me in 5 lines how you understand the task and what you will NOT do.
2. If something is ambiguous and the answer changes the work, ask me ONE batched question. Otherwise choose the sensible
   default and say which one you chose.
3. Give me a short plan (files, steps, how you'll verify). Wait for "go" only if the change is large or hard to undo.

While you work:
- Match the surrounding code's style. Don't add features I didn't ask for. Don't refactor unrelated code.
- Run the code for real: unit tests, the server, and the actual page in a headless browser (Playwright), at 1440px and 390px.
  Fix every console error and layout overflow yourself.
- For anything visual, judge it like a senior designer: spacing, contrast (WCAG AA), consistent type scale, hover/focus/
  disabled states, empty/loading/error states, motion that respects `prefers-reduced-motion`, sound only when the user
  expects it (and always mutable). Compare screenshots to the design spec before you say it's done.
- Anything that talks to an outside service (APIs, downloads, posting) must handle: no internet, bad key, rate limit, timeout.
- Assume the user is on Windows, not a programmer, and it must work the first time. Paths with spaces, `.exe` names,
  PowerShell vs cmd, and encodings are your problem, not theirs.

Before you say "done":
- Run `/ship-check` (reviewer agents in parallel), verify each finding yourself, fix the real ones, re-run the tests.
- Report in this format: **What changed** (3 bullets) · **Proof** (tests, screenshots, commands) · **Not tested / risks** · **What I need from you**.
- Update the "Current status" section of `CLAUDE.md`. Commit with a clear message and push.

=====

Shorter version for small fixes: "Fix X. Reproduce it first, fix the cause not the symptom, add a test if one is cheap,
run the tests, tell me what you verified."

## 3. Settings and habits that make it faster and more careful

- **Plan mode** (Shift+Tab until it says plan): for big or risky changes, Claude proposes the plan and you approve it
  before any file is touched. Cheap insurance.
- **Subagents**: ask for "parallel reviewers" (the `/ship-check` skill already does Windows, code, first-run and UI).
  Separate agents catch things the author misses because they didn't write the code.
- **Give it things to look at**: screenshots of designs you like, error text pasted whole, the exact command you ran.
  "It doesn't work" costs ten messages; the pasted error costs one.
- **Say what "good" looks like** with numbers or examples: "like this screenshot", "under 2 s to first clip", "works on a phone".
- **One task per message** when you can, and say the order if there are several.
- **Hooks / permissions**: `/fewer-permission-prompts` builds an allowlist so it stops asking about harmless commands.
  Don't allow destructive commands (delete, force-push) without asking.
- **Model**: use the strongest model for design, architecture and hard bugs; a cheaper one for small edits and renames.

## 4. "Clear the chat but keep everything"

You can't keep the *conversation* and drop the clutter, but you can keep everything that matters:

1. **Make sure the facts live in files.** Ask: "Update `CLAUDE.md` current status with everything decided so far, and
   list open TODOs." (Claude already does this after each phase.) Commit it.
2. **Then pick one:**
   - `/compact` — keeps a summary of this chat and frees space. Use mid-task. You can steer it:
     `/compact keep the design decisions, file names, and what's still untested`.
   - `/clear` — wipes the chat completely. Use between tasks. Safe once step 1 is done, because `CLAUDE.md`,
     your files and git history are untouched.
3. **Start the next chat with:** "Read `CLAUDE.md`, then continue with: <next task>."

Rule of thumb: finish a feature, update `CLAUDE.md`, commit, `/clear`, start the next feature.

## 5. What to do when something still goes wrong

- Paste the **exact** error and say what you clicked or typed.
- Ask: "Reproduce it, explain the cause in two sentences, then fix it and show me it passing."
- If it's the same bug a second time, ask: "Why did our checks miss this? Add the check so it can't come back."
  (That's how `/ship-check` keeps getting better.)
- Tell it when something about the result is bad ("the site genuinely sucks") and *why* if you know. Specific beats polite.

## 6. Quick checklist before you trust a result

- [ ] It ran the code and says what happened (not "should work")
- [ ] Screenshots at desktop and phone, no console errors
- [ ] It listed what it did NOT test
- [ ] `CLAUDE.md` status updated, changes committed and pushed
- [ ] You tried the one thing you care about most, yourself, once
