---
name: visual-qa
description: Photograph every ForgeUI screen and the states worth seeing (empty, running, queued, failed, popovers, viewer, layouts, half-screen width, error pages) and lay them out as one dense HTML contact sheet for a visual QA pass. Run it at the end of every pull request — after the last code push, before calling the PR done — and link the sheet in the PR. Also use when asked for "screenshots of the app", "a visual check", "visual QA" or "the contact sheet".
---

# Visual QA

One command walks the built app against the fake ComfyUI and writes a
self-contained contact sheet: every shot inlined, grouped by screen, failures
outlined red, shots with browser console errors outlined amber. The person
reviewing the PR scans it in one look; clicking a shot opens it full size, with
← / → to step through.

## When

At the end of **every** pull request, once the code is final: after the last
push that changes code, not before each one. Run it again if a later push
changes anything under `src/frontend/` or `src/http/`.

## Steps

1. **Run it** from the repo root:

   ```sh
   deno task qa
   ```

   It builds the UI (`ui:install` first if `src/frontend/node_modules` is
   missing), runs `tests/e2e/qa.spec.ts` with `playwright.qa.config.ts` (its own
   port 7896, its own data dir, a fresh install every run), and writes
   `tests/e2e/.qa/index.html` plus `shots/` and `manifest.json`. About a minute.
   Flags: `--no-build` (the SPA already in `src/frontend/dist`), `--out <dir>`,
   `--sheet-only` (re-render from the manifest), `--link` (reference `shots/`
   instead of inlining).

   It needs Chrome, or `FORGEUI_E2E_BROWSER=/path/to/chromium`; a container's
   `/opt/pw-browsers/chromium` is picked up on its own. If the port is taken, a
   previous run's server is still alive: stop the `serve.ts` process.

2. **Read the summary** it prints: shots, failed, console errors, each named. A
   _failed_ shot is one whose state could not be reached — it is still
   photographed, showing what the screen did instead. Look at every failed and
   console-error shot with the Read tool, and at every shot of a screen this PR
   touched. Decide for each whether it is this PR's regression, a pre-existing
   problem, or the walk being out of date.

   - **This PR broke it** → fix it, push, run again.
   - **The walk is out of date** (a renamed button, a moved control) → fix the
     selector in `qa.spec.ts`. Never delete a shot or swallow its error to get a
     clean sheet.
   - **Pre-existing** → leave it and say so in the PR.

3. **Keep the walk complete.** If the PR adds a screen, a popover, a mode or a
   state a reviewer would want to see, add a `shot()` for it in
   `tests/e2e/qa.spec.ts` in the same PR. `shot()` runs its `setup` to reach the
   state, then photographs it whatever happened. Pass `true` last when the state
   is an error on purpose. The fake ComfyUI fails the next prompt on request:
   `POST http://127.0.0.1:8296/__fake/scenario?name=error-mid-graph`.

4. **Publish the sheet.** With the Artifact tool, publish
   `tests/e2e/.qa/index.html` (icon `image`; description naming the branch and
   commit). Re-running in the same session and publishing the same path updates
   the same link. Without the Artifact tool, send the file with SendUserFile, or
   name its absolute path.

5. **Link it in the PR.** Add a `## Visual QA` section to the PR description
   (update it in place on a re-run, don't add a second one):

   ```md
   ## Visual QA

   [Contact sheet](artifact url) — 70 shots, 0 failed, 0 with console errors, at
   <short sha>.

   - <anything failed or noisy, and whether this PR caused it>
   - <screens this PR changed: shot numbers worth looking at>
   ```

   Then tell the user the link and the counts in one line, plus anything that
   looked wrong.

The sheet and the shots are build output — never commit `tests/e2e/.qa/`.
