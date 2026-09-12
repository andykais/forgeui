# Phase 1 against a real ComfyUI

This used to be a list of things for a person to do by hand. It is now three
commands, because the ComfyUI they need comes with the repository:

```sh
deno task comfy:setup     # once: a pinned ComfyUI, CPU-only torch, SD 1.5
deno task test:comfy      # the §14.1 contract check + the app-level run
deno task test:e2e:comfy  # the same, from a browser, including the editor
```

Each of the last two starts its own ComfyUI, runs against it, and shuts it
down. None of them need a GPU: `--cpu`, four steps at 256×256, about ten
seconds of sampling.

## What that proves

**`deno task test:comfy`** — `tests/contract/comfy_test.ts` asserts the
assumptions `tests/fake-comfy/` is built on, one test per assumption, so a
failure names the thing the fake got wrong:

- `/prompt` honours a client-supplied `prompt_id` (§5 step 5 depends on it).
- `execution_start`, `executing` (including the terminal `node: null`),
  `executed` with `output.images[]`, `execution_cached` with its node ids,
  `execution_error` with `node_id`/`node_type`/`exception_message`/
  `exception_type`/`traceback`, and `status` — every one decoded by
  `src/comfy/events.ts` itself rather than by a copy of it.
- `progress` with `value`/`max`/`node`, and the binary preview frame layout.
- `filename_prefix = <jobid>/out` writing into `<output-directory>/<jobid>/`,
  `/view` serving it back, and the PNG surviving the sidecar `tEXt` chunk.
- `/history`, `/queue`, `/system_stats`, `/upload/image` with `overwrite`.

`tests/contract/pipeline_test.ts` then runs the whole app against it: submit
`sd15`, watch progress and preview frames on the app's own `/ws`, find the
file in the day directory, read the sidecar back out of the PNG, and
reproduce it bit-for-bit with **Rerun now**.

**`deno task test:e2e:comfy`** — the same, from Chrome: a generation from the
Generate screen, and the embedded editor loading this workflow's graph and
writing both files back through `app.graphToPrompt()`.

## What it found

Both bugs were invisible to the fake and are fixed:

- **The `/comfy/*` proxy forwarded the browser's `Origin`.** ComfyUI answers
  403 to any request whose `Origin` does not match the host it serves on, and
  every `<script crossorigin>` in its `index.html` carries one — so the
  embedded editor loaded an empty page and `app.graphToPrompt()` was never
  reachable. The proxy now presents ComfyUI's own origin, as a reverse proxy
  should (`src/comfy/proxy.ts`).
- **The editor screen gave up too early.** It looked for
  `app.loadGraphData()` on the iframe's `load` event, which fires long before
  ComfyUI's frontend puts itself on the window, so it always reported the
  build as unsupported. It now waits for the object, and Save & return stays
  disabled until it is there (`src/frontend/src/screens/Comfy.svelte`).

Everything else the fake claims turned out to be right, including the two
assumptions that looked least safe: `execution_cached` really does list the
cached node ids, and a `SaveImage` pointed outside the output directory
really does fail at execution rather than at queue time.

Verified against **ComfyUI v0.34.0**, python 3.12, torch CPU, on Linux.

## What is still not covered

- **A GPU, and your own models.** Every bundled workflow except `sd15` names
  placeholder model filenames (`workflows/bundled/README.md`), so they load
  and list but cannot run until you point them at real files.
- **Video.** `ltx` writes a video; nothing here has produced one.
- **The upscale workflows.** One per image family, each of them
  `LoadImage` → scale → re-sample (§10). The plumbing is verified against the
  fake ComfyUI, but no upscale has ever been run on real weights, so the
  0.2 creativity default is reasoning rather than a measured result.
- **Windows and macOS.** `scripts/setup-comfy.sh` is written for both but has
  only been run on Linux.

## Using your own ComfyUI instead

`FORGEUI_COMFY_URL` points the protocol tests at a ComfyUI you started
yourself, and nothing is provisioned or shut down:

```sh
FORGEUI_COMFY_URL=http://127.0.0.1:8188 deno task test:comfy
```

The tests that boot the app also need `FORGEUI_COMFY_DATA_DIR` — an
`<appdata>` whose `staging/` is that ComfyUI's `--output-directory`, because
the app renames files out of there (§6.3) — and `FORGEUI_COMFY_DIR` for its
model folders. Without them those tests are ignored and the protocol tests
still run. `tests/contract/env.ts` lists every variable.

## If you want to check it by hand

Only worth doing on a machine with a GPU and your own models, since that is
what the automated run cannot reach.

1. `deno task ui:install && deno task ui:build`, then
   `deno task start --data-dir ./data` with `comfy.path` (managed) or
   `comfy.url` (`local_url`) set in `config.yaml`, and `model_folders`
   pointing at your real folders.
2. **Fix the placeholder filenames.** Workflows → a workflow → *Open in
   ComfyUI*, pick real files in the loader nodes, *Save & return*. That
   writes `workflow.api.json` and `workflow.ui.json` into
   `workflows/user/<id>/`, leaving the bundled copy alone.
3. **Generate.** Watch percent, ETA, node label, step counter and the preview
   frames. Note that the app does not pass `--preview-method`, so previews
   need it in `comfy.extra_args` (the test harness passes
   `--preview-method auto` for exactly this reason).
4. **Check the bytes.** `outputs/YYYY/MM/DD/` holds `<jobid>-0.png` and
   `<jobid>.json`; `staging/` is empty again; the day directory is today's
   UTC date. The PNG carries a copy of the sidecar:
   ```sh
   deno eval --allow-read "import { readTextChunks } from './src/jobs/png.ts'; const t = readTextChunks(await Deno.readFile('<path to png>')); console.log(Object.keys(t)); console.log((t.forgeui ?? '(none)').slice(0, 200));"
   ```
5. **Reproduce it.** Rerun now ⟳ should land the same image; Edit in
   Generate → should fill the panel and create no job.
