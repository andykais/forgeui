# Hardware checklist — proving Phase 1 for real

Nothing in this repository has ever run against a real ComfyUI. Every test
uses the in-process fake, and the fake is only as right as the assumptions it
was written from. Phase 2 hangs thumbnails, samples, output↔model links and
ETAs off that pipeline, so **Phase 2 stops at M5 until this checklist is
green**.

Two halves, in order:

1. `deno task test:comfy` — the §14.1 contract check, which asserts the
   assumptions `tests/fake-comfy/` is built on against a real ComfyUI. It
   needs no models and no GPU for the parts that matter.
2. The manual steps below, which cover the things no test can reach: the
   embedded editor, the bundled workflows' placeholder filenames, and one
   real generation end to end.

When you are done, send back the seven items under "What to report".

---

## 0. What you need

- ComfyUI installed and working on this machine, and at least one checkpoint
  you can generate with.
- This repository, with the UI built once:
  ```sh
  deno task ui:install && deno task ui:build
  ```
- A data directory. `deno task start --data-dir ./data` creates it with a
  default `config.yaml` on first run; §3.1 describes the layers.

---

## 1. The contract check (automated)

### Start ComfyUI the way the app would

Run it yourself for this step, with the same flags the app's managed mode
generates (`src/comfy/launch.ts`), so the check knows where files land:

```sh
cd <comfyui>
python main.py \
  --port 8188 --listen 127.0.0.1 \
  --output-directory <data-dir>/staging \
  --input-directory <data-dir>/comfy-input \
  --preview-method auto
```

`--preview-method auto` is **not** one of the flags the app passes today. It
is needed for the preview-frame assertion, and whether it should be added to
the generated flags (or left to `comfy.extra_args`) is one of the questions
this pass answers.

### Run it

```sh
cd <forgeui>
FORGEUI_COMFY_URL=http://127.0.0.1:8188 \
FORGEUI_COMFY_OUTPUT_DIR=<data-dir>/staging \
FORGEUI_COMFY_INPUT_DIR=<data-dir>/comfy-input \
FORGEUI_COMFY_CKPT=<a checkpoint filename, exactly as ComfyUI lists it> \
deno task test:comfy
```

| Variable | Effect |
| --- | --- |
| `FORGEUI_COMFY_URL` | Required. Without it every test in `tests/contract/` is ignored, which is also why `deno task test` still needs no ComfyUI. |
| `FORGEUI_COMFY_OUTPUT_DIR` | ComfyUI's `--output-directory`. Adds the on-disk check that `filename_prefix` really routes files into `<output-directory>/<jobid>/`, and cleans up after itself. |
| `FORGEUI_COMFY_INPUT_DIR` | ComfyUI's `--input-directory`. Only used to delete the one fixture the upload test leaves behind. |
| `FORGEUI_COMFY_CKPT` | A checkpoint filename. Enables the two tests that need a sampler; without it they are ignored and everything else still runs. |

Expected: `ok | 11 passed`. Nine of the eleven need no model.

### What it asserts

Each test is one assumption the fake makes, so a failure names the thing the
fake got wrong. The graphs are `EmptyImage` → `SaveImage`, which needs no
model of any kind.

- `/prompt` honours a client-supplied `prompt_id` (§5 step 5 depends on it).
- The websocket carries `execution_start`, `executing` (including the
  terminal `node: null`), `executed` with `output.images[]`, and `status`,
  with the field names `src/comfy/events.ts` decodes.
- `SaveImage` with `filename_prefix = <jobid>/out` writes into
  `<output-directory>/<jobid>/`, `/view` serves the bytes back, and the PNG
  survives having the sidecar `tEXt` chunk appended to it (§5 step 7).
- `/history` reports a finished prompt the way the reconcile pass reads it.
- A repeated node comes back as `execution_cached` with its node id.
- A node that throws sends `execution_error` with `node_id`, `node_type`,
  `exception_message`, `exception_type` and `traceback`.
- A graph with an unknown node type is rejected with 400 and a message.
- `/system_stats` carries the version, python and device fields Settings
  shows.
- `/upload/image` with `overwrite=true` keeps the name it was given (§9
  uploads the same content-addressed name repeatedly).
- With a checkpoint: `progress` events carry `value`/`max`/`node`, binary
  preview frames use the `uint32` event id + `uint32` format + image layout,
  and `/queue` lists the running and pending prompts.

### If something fails

**Do not change the app.** A failure means the fake — and therefore every
other test in the repository — is wrong about ComfyUI, and the fix goes into
`tests/fake-comfy/`. Send the output; two assertions are the least certain
and the most likely to need adjusting:

- `execution_cached` listing the cached node ids. The fake currently sends an
  empty list on every run.
- The `execution_error` test provokes a real runtime failure by pointing
  `filename_prefix` at a directory outside the output root, which `SaveImage`
  refuses. A build that rejects that at queue time instead fails the test with
  a message saying so, and the test needs a different way to make a node
  throw.

### What it leaves behind

Three model-free prompts (six with a checkpoint), each writing into
`<output-directory>/<ulid>/`; those directories are removed when
`FORGEUI_COMFY_OUTPUT_DIR` is set. One ~100-byte PNG named
`forgeui-contract-<uuid>.png` in the input directory, removed when
`FORGEUI_COMFY_INPUT_DIR` is set. One prompt fails on purpose, so ComfyUI's
console will log a traceback about saving outside the output folder.

---

## 2. The manual steps

Start the app against the ComfyUI you just used:

```sh
deno task start --data-dir ./data
```

Set `comfy.mode: local_url` and `comfy.url` in `config.yaml` while ComfyUI is
the one you started; switch to `managed` with `comfy.path` for step 2.4.
`model_folders` should point at your real folders — they are read-only and
launch-time only.

### 2.1 The embedded editor is reachable

The one Phase 1 path that cannot run without ComfyUI is `Save & return`,
which calls `app.graphToPrompt()` on the same-origin iframe
(`src/frontend/src/screens/Comfy.svelte`).

1. Open the app, rail → **Comfy**. ComfyUI's own frontend should render
   inside the app, served through `/comfy/*`. If it does not load at all, the
   proxy is the problem and nothing below will work.
2. **Workflows** → `krea2` → **Open in ComfyUI**. The app's own toolbar
   should sit above the iframe with **Save & return** and **Discard**.
3. If the toolbar shows *"This ComfyUI build does not expose
   app.graphToPrompt()"* or *"…app.loadGraphData()"*, **stop here and report
   it**. `IMPLEMENT-PHASE-1.md` says to stop and ask rather than work around
   it.

### 2.2 Fix the bundled model filenames

Every filename in `workflows/bundled/` is a placeholder (see the README
there). For `krea2` at minimum, and for any other workflow you want to use:

1. Open it in ComfyUI from the Workflows screen.
2. Pick real files in the loader nodes (`UNETLoader`, `DualCLIPLoader`,
   `VAELoader`, or `CheckpointLoaderSimple` depending on the workflow).
3. **Save & return.**

Then confirm the round trip actually wrote both files:

```sh
ls <data-dir>/workflows/user/krea2/
# workflow.api.json  workflow.ui.json  manifest.json
```

The workflow page should now show it as a **user** copy, and the bundled copy
should be untouched.

### 2.3 One real generation, end to end

1. **Generate** → `krea2` → type a prompt → **Generate**.
2. While it runs, watch the job card: percent, ETA, the current node's label,
   the step counter, and preview frames if you passed `--preview-method
   auto`. The ETA is deliberately crude in Phase 1 (equal weights per node);
   node-timing-based ETA is M8.
3. The output should appear in the session grid on its own, without a
   reload.

Then check the bytes on disk:

```sh
ls <data-dir>/outputs/$(date -u +%Y/%m/%d)/
# <jobid>-0.png  <jobid>.json
ls <data-dir>/staging/          # empty: the job's directory is removed
```

- The date directory must be today's UTC date, not 1970 (that was a real bug;
  see the int64 note in `PHASE-1-HANDOFF.md`).
- Open `<jobid>.json`: `params`, `models[]`, `api_graph` and `timing.nodes`
  should all be populated. `models[].hash` is `null` — hashing is M6.
- The PNG carries a copy of the sidecar in a `tEXt` chunk:
  ```sh
  deno eval --allow-read "import { readTextChunks } from './src/jobs/png.ts'; const t = readTextChunks(await Deno.readFile('<data-dir>/outputs/YYYY/MM/DD/<jobid>-0.png')); console.log(Object.keys(t)); console.log((t.forgeui ?? '(none)').slice(0, 200));"
  ```
  Expect a `forgeui` key alongside ComfyUI's own `prompt` and `workflow`
  chunks.

Then check the two reproduction paths (§6.4):

- Click the output, then **Rerun now ⟳**. A second job should run the frozen
  graph and land a visually identical image. The two files' checksums differ
  because each PNG embeds its own sidecar, which carries its own job id.
- **Edit in Generate →** should open the Generate view with the params
  filled in, and create no job.
- Reload the browser and open **Gallery**: both outputs are still there, with
  the same metadata.

### 2.4 The managed child

Set `comfy.mode: managed` and `comfy.path`, restart the app, and confirm:

- Settings shows the generated launch flags and the child's captured log.
- A generation works in this mode too.
- Whether previews arrive without `--preview-method auto` in
  `comfy.extra_args` — that is the open question from step 1.

---

## What to report

1. The full output of `deno task test:comfy`, pass or fail.
2. ComfyUI's version and python version (Settings, or `/system_stats`).
3. Did `app.graphToPrompt()` work (step 2.1)?
4. Did **Save & return** write both `workflow.api.json` and
   `workflow.ui.json` into `workflows/user/krea2/` (step 2.2)?
5. The `<jobid>.json` sidecar from the `krea2` run, and whether the PNG had a
   `forgeui` `tEXt` chunk (step 2.3).
6. Did **Rerun now** and **Edit in Generate** work (step 2.3)?
7. Anything that looked wrong, slow or surprising in the UI, however small.

With that in hand, Phase 2 resumes at M6 — the model library backend.
