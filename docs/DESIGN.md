# ForgeUI — Design Document

Project name: **ForgeUI** (referred to as "the app" below).

## 1. Purpose

A SwarmUI alternative built on the ComfyUI ecosystem. The app never invents
its own generation pipeline: **every generation runs a ComfyUI workflow**, and
the UI is nothing more than the small set of inputs that a workflow chooses to
expose. Complexity is controlled by limiting what each workflow surfaces, not
by building a universal parameter panel.

### Goals (things to keep from SwarmUI)
- Runs on ComfyUI; use its models, custom nodes, and embedded editor.
- Every output is fully reproducible via **Reuse Parameters**.
- Progress indicators show how far a generation has left.
- "Just works" for common image models via bundled workflows.

### Goals (pain points to fix)
- Video is first-class: a video workflow is exactly like an image workflow.
- No cap on gallery history; no separate "recent" vs "history" views.
- Per-workflow parameter panels, with rarely-touched params collapsed.
- Images and videos both get a sidecar with full reproduction data.
- No model downloading, ever. Model folders are **read-only** to the app.
- Model metadata lives inside the app's data dir, never beside safetensors.
- SQLite for all state so it can be inspected with standard tools.
- Browser refresh loses nothing; in-flight jobs reappear where they were.
- Switching models never requires re-tuning VAE/steps/CFG/LoRAs by hand.
- Models and LoRAs are discoverable: click one, see what it produced.

### Non-goals
- Replacing the ComfyUI node editor. Workflow editing happens in the embedded
  ComfyUI UI, as SwarmUI already allows.
- Model management/downloads. The user curates model folders themselves.
- Multi-user / auth (single local user; may revisit).

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Deno (TypeScript) | Single binary via `deno compile`, embeds the frontend. |
| DB | SQLite (WAL mode) | One file under `<appdata>/app.db`. |
| Frontend | Svelte (SPA) | Served by the Deno process. |
| Backend ↔ ComfyUI | HTTP + WebSocket client | `/prompt`, `/history`, `/view`, `/upload/image`, `/ws`. |
| Embedded editor | ComfyUI's own frontend in an iframe | Used to author workflows. |

C# / Python were considered and rejected: nothing from SwarmUI is being
ported, and running inside ComfyUI's process (Python custom node) couples the
app to ComfyUI's lifecycle for no benefit.

### Process model
- The app is a separate process from ComfyUI and always runs on the same
  machine. It launches ComfyUI as a managed child process (default) or
  connects to a local instance the user started themselves; both share the
  same filesystem, which §6.3 and §9 rely on.
- ComfyUI is started with:
  - `--output-directory <appdata>/staging` (see §6.3)
  - `--input-directory <appdata>/comfy-input` (a cache, see §9)
  - `--extra-model-paths-config <appdata>/extra_model_paths.yaml` generated from
    the app's configured (read-only) model folders.

---

## 3. Directory layout

```
<appdata>/
  app.db                    SQLite (derived index; rebuildable — see §7)
  config.yaml
  extra_model_paths.yaml    generated
  workflows/
    bundled/<id>/           shipped with the app, overwritten on upgrade
    user/<id>/              user-created or user-overridden; never touched by upgrades
      workflow.ui.json      LiteGraph format (for the embedded editor)
      workflow.api.json     prompt format (what gets queued)
      manifest.json         exposed params (§4)
  outputs/YYYY/MM/DD/
    <jobid>-<n>.png|mp4|…   generated media
    <jobid>.json            sidecar: full reproduction record (§6.2)
  inputs/<sha256[0:2]>/<sha256>.<ext>   content-addressed input images/masks (§9)
  samples/<model_hash>/     sample media per model/LoRA (§8.3)
    <file>.<ext>
    <file>.json             sidecar, same schema as outputs
  models-meta/<model_hash>/ thumbnails, civitai json, notes (§8.1)
  staging/                  ComfyUI writes here; app moves files out
  comfy-input/              ComfyUI reads inputs here; cache, swept on startup
```

Model folders (checkpoints, loras, vae, …) are configured in `config.yaml` and
are **never written to**.

### 3.1 Configuration and first run
Settings must be expressible before the app has ever run, so they do not live
in SQLite (which sits inside the data dir and is a rebuildable index).

| Layer | Holds | Set by |
|---|---|---|
| Bootstrap | data dir only | `--data-dir` flag or `FORGEUI_DATA_DIR` env; default `~/.forgeui` |
| `config.yaml` | five top-level blocks: `server` (host and port the app itself serves on), `comfy` (`mode: managed \| local_url`, install `path`, `url`, `python` interpreter, `extra_args` appended to the generated launch flags), `model_folders` (folders per kind), `keys` (§11.4), `ui` (rail state, tile size per screen, sidebar/filmstrip collapsed) | hand-edited before first run; Settings writes it on field blur; `GET/PATCH /api/config` |
| Per-run overrides | any `config.yaml` key | CLI flags (`--comfy-path`, `--comfy-url`, `--comfy-mode`, `--models-dir kind=path`, `--host`, `--port`), applied for that process only, never written back |

First run: if `config.yaml` is absent the app writes one with defaults and
empty model folders, starts, and Settings shows a first-run state (no ComfyUI
path / no folders). `extra_model_paths.yaml` is regenerated from
`config.yaml` on every launch. Model folders are launch-time only: changing
them means editing `config.yaml` and restarting the app.

---

## 4. Workflows

A workflow is three files. The Generate UI reads **only** the manifest.

### 4.1 Files
- `workflow.ui.json` — what the embedded ComfyUI editor loads and saves.
- `workflow.api.json` — produced from the editor via `app.graphToPrompt()` at
  save time so the two are always in sync. This is what gets queued.

The embedded editor is ComfyUI's frontend **proxied under the app's origin**
(`/comfy/*` → the local ComfyUI port), so the iframe is same-origin and the
app can call `app.graph.serialize()` / `app.graphToPrompt()` on it. The app
never relies on ComfyUI's own Save button: when editing a workflow, an
app-owned toolbar sits above the iframe with **Save & return** (writes both
json files, returns to the screen that opened the editor) and **Discard**.
ComfyUI's native Save writes to ComfyUI's user dir, which the app ignores.
- `manifest.json` — the exposed inputs and output nodes.

### 4.2 Manifest schema

```json
{
  "id": "krea2",
  "name": "Flux Krea 2",
  "family": "flux",
  "kind": "image",
  "category": null,
  "description": "Text-to-image with Krea 2. VAE and sampler are fixed.",
  "params": [
    { "key": "prompt", "label": "Prompt", "type": "text", "required": true, "bind": "6.text" },
    { "key": "negative", "type": "text", "bind": "7.text", "advanced": true },
    { "key": "seed", "type": "seed", "bind": "3.seed" },
    { "key": "steps", "type": "int", "default": 28, "min": 1, "max": 100, "bind": "3.steps", "advanced": true },
    { "key": "cfg", "type": "float", "default": 3.5, "step": 0.1, "bind": "3.cfg", "advanced": true },
    { "key": "size", "type": "size", "default": [1024, 1024], "bind": { "w": "5.width", "h": "5.height" } },
    { "key": "loras", "type": "lora_list", "filter": { "family": "flux" },
      "bind": { "chain": {
        "model_from": "1.MODEL", "clip_from": "1.CLIP",
        "model_to": ["3.model"], "clip_to": ["6.clip", "7.clip"] } } }
  ],
  "outputs": [ { "node": "9", "kind": "image" } ]
}
```

Field notes:
- `bind` is `"<nodeId>.<inputName>"` for scalar params. Everything not bound is
  hardcoded in the graph (VAE, sampler, scheduler, model path, …).
- `advanced: true` places the param in a collapsed section.
- `required: true` blocks submission when empty.
- `family` on the workflow and `filter.family` on `lora_list` / `checkpoint`
  params restrict pickers to compatible models (§8.1).
- `category` (string, optional) tags the workflow's role for UI routing. Known
  value: `img2img` — a workflow exposing `image` (required) and `denoise`,
  used by **Use image in workflow** and **Upscale image** (§10).
  Uncategorised workflows are ordinary generators.

### 4.3 Param types (closed set)

| type | widget | bind |
|---|---|---|
| `text` | textarea | scalar |
| `int`, `float` | number/slider | scalar |
| `bool` | toggle | scalar, or `switch` (graph rewrite, §4.4) |
| `enum` | dropdown; `options` in manifest, or `source: "checkpoints"` etc. | scalar |
| `seed` | number + 🎲 + "lock" | scalar; `-1` → random at submit |
| `size` | width×height with ratio presets/aspect lock; `default` is the workflow's base resolution, optional `step` (16 or 64) snaps ratio results to the model's grid | `{w, h}` |
| `checkpoint` | model picker (filtered by family) | scalar (filename) |
| `lora_list` | repeatable rows: lora picker + strength(s) | `chain` (graph rewrite, §4.4) |
| `image` | upload / pick from gallery / paste | scalar (`LoadImage.image`), content-addressed (§9) |
| `mask` | paint over the bound `image` param | scalar, content-addressed (§9) |
| `video` | upload / pick from gallery | scalar, content-addressed (§9) |

### 4.4 Graph rewrites

#### `lora_list`
At submit time the server splices `LoraLoader` nodes into the api graph:

1. Start with `model = chain.model_from`, `clip = chain.clip_from`.
2. For each LoRA row, create a `LoraLoader` node `{model, clip, lora_name,
   strength_model, strength_clip}` and set `model`/`clip` to its outputs.
3. Rewire every `model_to` / `clip_to` input to the final `model` / `clip`.
4. Zero rows → no change to the graph.

This avoids depending on third-party stack loader nodes. Workflows using
model-only LoRAs (no CLIP) set `clip_from`/`clip_to` to null and the rewrite
uses `LoraLoaderModelOnly`.

#### `bool` with a `switch` bind

A checkbox usually sets a widget, and a widget cannot turn a branch of the
graph on and off. Some options are a branch: Krea 2's prompt enhancer is four
nodes that either feed the encoder or do not. Rather than ship the workflow
twice — which is what it did at first, and which meant every later change to
Krea 2 had to be made in both copies — a `bool` may bind a `switch`:

```json
"bind": { "switch": { "input": "4.text", "on": "13.STRING", "off": "10.STRING" } }
```

At submit the bound `input` is linked to `on` or to `off` accordingly.
ComfyUI executes only what an output needs, so the side that is not linked
never runs. Both sources are validated against the graph at load, and `input`
must already be fed by a link: an input holding a literal means the manifest
has drifted from its graph, and saying so on load beats a surprise at submit.

### 4.5 Workflow versions
Only the **latest** version of each workflow is exposed in the UI. There is no
version table. Each workflow's content hash (`sha256(api.json + manifest.json)`)
is stamped into every output sidecar so old outputs can be recognised, but
nothing in the DB references workflows by foreign key (§7).

The editor is proxied under this app's origin, which makes ComfyUI's
`localStorage` this origin's too. ComfyUI reopens every tab it had open on
boot, so a session that has edited twenty workflows opens twenty of them — 
none of which the app asked for. Opening the editor screen **drops the
tab-restore keys** before ComfyUI can read them; settings stay, including the
workflow-shaped ones (`Comfy.Settings.Comfy.Workflow.*`). The app keeps
nothing in that storage itself. Several app tabs editing different workflows
are unaffected: this only decides what a fresh editor restores, and each of
them loads its own graph through `loadGraphData`.

### 4.6 Bundled workflows
Shipped under `workflows/bundled/` and overwritten on upgrade. Editing a
bundled workflow in the app copies it to `workflows/user/<id>/` first; the user
copy shadows the bundled one.

Initial set:
| id | family | kind | notes |
|---|---|---|---|
| `krea2` | krea2 | image | prompt, enhance, model, seed, size, loras; steps/cfg/clip/vae/enhancer length advanced. `enhance` is a `switch` bind (§4.4): the prompt enhancer is a checkbox on this workflow, not a second copy of it |
| `krea2-img2img` | flux | image | `category: img2img`; image (required), prompt, denoise (default 0.5), seed, size, loras; steps/cfg advanced. Image is resized to `size` before encoding |
| `illustrious` | sdxl | image | prompt, negative, seed, size, steps/cfg (adv), loras |
| `ltx` | ltx | video | prompt, seed, size, frames, fps; loras |
| `anima` | anima | image | as above; family-filtered loras |
| `flux-klein` | flux2 | image | prompt, model, size, loras, seed, clip |
| `z-image-turbo` | z-image | image | prompt, model, seed, size, loras; few steps by default |
| `sd15` | sd15 | image | prompt, negative, seed, size, loras; steps/cfg advanced |

Display names: Flux Krea 2, Flux Krea 2 (img2img), Illustrious XL, LTX Video,
Anima, Flux Klein, Z-Image Turbo, Stable Diffusion 1.5. This list is final for
v1 and must match the Workflows screen and the use-in-workflow popover in the
mocks.

`sd15` earns its place by being runnable: its weights are a two-gigabyte
download and it produces an image on a CPU in seconds, so it is the workflow
the contract check (§14.1) generates with. The other seven need a GPU and
hand-picked model files. Editing
workflows (Kontext-style), inpainting and dedicated upscalers are not bundled;
they are ordinary user workflows added later.

Exact node graphs are authored in ComfyUI and committed as files; the table
above defines the intended manifest surface.

### 4.7 Manifest authoring UI
"Expose inputs" panel: lists every literal node input in `workflow.api.json`
(from `GET /api/workflows/:id/inputs`) with its current value; user ticks
inputs to expose and sets key/label/type/default/advanced. `size` binds two
literal inputs into one row. `lora_list` is not a node input at all — it is
a synthetic **chain** row (§4.4) configured with its own dialog and is not
counted among the literal inputs. Row order is panel order. "Auto-expose
all" generates one advanced param per literal widget value, for a freshly
imported graph. Saving a bundled workflow's manifest creates the user copy
first (§4.6) and changes the workflow hash; existing outputs are unaffected.

---

## 5. Generation pipeline

1. **Validate** params against the manifest; resolve `seed: -1`.
2. **Ingest inputs** (§9): hash, store, upload to ComfyUI.
3. **Rewrite graph**: bind scalars, splice LoRAs, set every output node's
   `filename_prefix` to `<jobid>/out` so all files land in `staging/<jobid>/`.
4. **Persist job** (status `queued`) *before* submitting, so a crash or refresh
   never loses it.
5. `POST /prompt` with the app's `client_id` and a `prompt_id` the app chose
   itself, recorded on the job row before the request goes out so the first
   events cannot arrive before the app knows whose they are. A ComfyUI that
   ignores the supplied id and answers with its own is accommodated.
6. **Progress** via WebSocket: `execution_start`, `executing` (node), `progress`
   (step/max within node), `executed`, `execution_error`. Progress is stored on
   the job row so any client, after any refresh, sees the same state.
   ComfyUI's binary preview frames are relayed to clients as binary `/ws`
   messages prefixed with the job id (push; never polled): `uint32` event (1 =
   preview), `uint32` format (1 = JPEG, 2 = PNG, as ComfyUI tags it), `uint32`
   job id length, the job id in UTF-8, then the image bytes.
   The managed child is launched with **`--preview-method auto`**: ComfyUI's
   own default is `none`, which sends no preview frames at all, so the
   running card sat on its dark ground waiting for one that was never
   coming. A ComfyUI the app did not start (`mode: local_url`) needs the
   same flag passed to it by whoever did.
   Every (re)connection to ComfyUI is followed by a reconcile pass over the
   jobs the app still thinks are in flight, resolving them from `/queue` and
   `/history`; that is how a dropped socket or a ComfyUI that died before
   `executed` ends up settled.
7. On completion: `rename()` `staging/<jobid>/*` → `outputs/YYYY/MM/DD/`, write
   the sidecar, embed a copy of the sidecar in PNG `tEXt` as a convenience
   (videos are not embedded — the sidecar is canonical and MP4 metadata is
   size-limited), index into SQLite, notify clients.
8. On error: job → `failed` with ComfyUI's error payload; staging dir removed.

### 5.1 Progress estimation
Per-node durations are recorded per `workflow_hash` after each successful run.
`node_timings` is seeded from the `timing.nodes` block of every existing
sidecar on first launch after this phase and updated after every successful
job (EWMA, α = 0.3).
Overall progress = elapsed weight of finished nodes + fractional weight of the
current node (from `progress` step/max). First run of a workflow falls back to
equal weights. Displays: percent, ETA, current node label, step x/y.

### 5.2 Queue
Jobs are submitted to ComfyUI immediately (its queue is the queue). One
click of Generate is one job; there is no batch count and the app never
uses in-graph batch sizes — click Generate again for another run. The app
shows queued/running/finished states from its own `jobs` table. Cancel →
`POST /interrupt` (running) or `POST /queue {delete}` (queued).

`jobs` rows are kept forever, including failed and cancelled ones; they are
small, and they are the record of what was attempted (errors, timings), not
just what succeeded. `reindex` recreates a `done` job row for any output whose
job is missing.

---

## 6. Outputs and reproducibility

### 6.1 Principle
**A generated file plus its sidecar is self-sufficient.** Deleting, renaming,
or replacing any workflow must never affect the ability to rerun an old output.

### 6.2 Sidecar schema (`<jobid>.json`)

```json
{
  "app_version": "0.1.0",
  "job_id": "01J…",
  "created_at": "2026-09-03T18:12:04Z",
  "workflow": { "id": "krea2", "name": "Flux Krea 2", "hash": "sha256:…", "family": "flux", "kind": "image" },
  "params": {
    "prompt": "…", "seed": 123456, "steps": 28, "cfg": 3.5, "size": [1024, 1024],
    "loras": [ { "name": "foo.safetensors", "hash": "sha256:…", "strength_model": 0.8, "strength_clip": 0.8 } ],
    "image": { "sha256": "…", "ext": "png", "original_name": "ref.png", "derived_from": "01J…" }
  },
  "models": [ { "role": "checkpoint", "name": "krea2.safetensors", "hash": "sha256:…" } ],
  "api_graph": { "...the fully rewritten prompt-format graph that was queued..." },
  "outputs": [ { "file": "01J…-0.png", "kind": "image", "width": 1024, "height": 1024 } ],
  "timing": { "total_ms": 12034, "nodes": { "3": 9800, "8": 1200 } },
  "raw": null
}
```
`raw` holds unmapped source data for imported samples (§8.3).

### 6.3 Why `rename()` and not copy
ComfyUI writes to `staging/` on the same filesystem; moving is a metadata
operation, so there is exactly one copy of every file. `staging/` is swept on
startup to remove leftovers from crashed jobs.

### 6.4 Reuse Parameters
Available on every output and every sample. Two actions:
- **Edit in Generate →** (load params) — opens the Generate view for
  `workflow.id` (latest version) and fills params by key; no job is created.
  Keys missing from the current manifest are shown as warnings; inputs are
  re-attached from the content-addressed store.
- **Rerun now ⟳** (rerun exact) — enqueues `api_graph` verbatim immediately
  (re-uploading inputs first) and stays on the current screen. Works even if
  the workflow no longer exists. Seed is kept.

---

## 7. Database

SQLite, WAL mode, `<appdata>/app.db`. The DB is a **derived index**: every
row about outputs, inputs, and samples can be rebuilt from files and sidecars
by `app reindex`. No foreign keys point at workflows; `workflow_id` /
`workflow_hash` on outputs are plain text used for filtering only.

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,            -- ULID
  prompt_id TEXT,                 -- ComfyUI id
  workflow_id TEXT, workflow_hash TEXT,
  status TEXT NOT NULL,           -- queued|running|done|failed|cancelled
  params_json TEXT NOT NULL,
  api_graph_json TEXT NOT NULL,   -- the rewritten graph that was queued (enables retry of failed jobs)
  progress_json TEXT,             -- {pct, eta_ms, node_id, node_label, node_index, node_total, step, max}
  error_json TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);

CREATE TABLE outputs (
  id TEXT PRIMARY KEY,            -- <jobid>-<n>
  job_id TEXT,                    -- no FK; index is rebuildable from sidecars
  path TEXT NOT NULL UNIQUE,      -- relative to <appdata>
  sidecar_path TEXT NOT NULL,
  kind TEXT NOT NULL,             -- image|video
  width INTEGER, height INTEGER, duration_ms INTEGER,
  sha256 TEXT,
  workflow_id TEXT, workflow_hash TEXT, family TEXT,
  prompt TEXT,                    -- denormalised for search
  params_json TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX outputs_created ON outputs(created_at DESC, id DESC);
CREATE INDEX outputs_workflow ON outputs(workflow_id, created_at DESC);
CREATE VIRTUAL TABLE outputs_fts USING fts5(prompt, content='outputs', content_rowid='rowid');

CREATE TABLE models (
  hash TEXT PRIMARY KEY,          -- sha256 of file
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,             -- checkpoint|lora|vae|controlnet|…
  size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  display_name TEXT,              -- editable; NULL → basename(path) minus extension
  family TEXT,                    -- user- or civitai-derived
  civitai_json TEXT, notes TEXT, tags_json TEXT,
  strength_min REAL, strength_max REAL,  -- what a LoRA's sliders span; NULL → the -2..2 default
  thumb_path TEXT,                -- chosen sample's media, or NULL → most recent output → empty plate
  output_count INTEGER NOT NULL DEFAULT 0,  -- derived from output_models; maintained on insert/delete and by reindex
  last_used_at INTEGER,           -- derived: max(outputs.created_at) over output_models; same maintenance
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE output_models (      -- discoverability: what used what
  output_id TEXT NOT NULL, model_hash TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (output_id, model_hash, role)
);
CREATE INDEX output_models_model ON output_models(model_hash);

CREATE TABLE inputs (
  sha256 TEXT PRIMARY KEY,
  path TEXT NOT NULL, ext TEXT NOT NULL,
  kind TEXT NOT NULL,             -- image|mask|video
  width INTEGER, height INTEGER,
  original_name TEXT, derived_from_output TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE output_inputs (
  output_id TEXT NOT NULL, input_sha256 TEXT NOT NULL, param_key TEXT NOT NULL,
  PRIMARY KEY (output_id, input_sha256, param_key)
);

CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  model_hash TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE, sidecar_path TEXT NOT NULL,
  kind TEXT NOT NULL, source_url TEXT,
  params_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX samples_model ON samples(model_hash);

CREATE TABLE node_timings (       -- for progress estimation
  workflow_hash TEXT NOT NULL, node_id TEXT NOT NULL,
  ewma_ms REAL NOT NULL, samples INTEGER NOT NULL,
  PRIMARY KEY (workflow_hash, node_id)
);
```

Model hashing runs in a background worker; a model is re-hashed only if
`path+size+mtime` changed. Until hashed, a model is identified by path.

---

## 8. Models, LoRAs, samples

### 8.1 Model library
- Scans configured folders (read-only) on startup and on demand (Rescan).
  Scan and background-hash progress are pushed on `/ws` as `rescan_progress`
  and `hashing_progress` events and shown in the queue strip's status area:
  `{running, folders_done, folders_total, models}` and
  `{running, done, total, current, bytes_done, bytes_total}`, where `done` and
  `total` count the files queued for this pass and `current` is the model's
  name. Both are pushed, never polled.
- A model appears in pickers as soon as it is scanned, identified by `path`.
  The hash is a streamed sha256 of the whole file, so the pass is bounded by
  read speed and a folder of multi-gigabyte checkpoints takes minutes. The
  queue is therefore **smallest first**: a hundred LoRAs behind ten
  checkpoints would otherwise gain no identity until the checkpoints were
  done, and nothing about a model needs its hash to be usable.
  Its `models` row (keyed by `hash`) exists only once the background hasher
  has finished it; until then display name, family, notes, tags and thumbnail
  cannot be edited and the UI shows a `hashing` state. At job completion,
  `output_models` rows are written for every model whose hash is known. When a
  model finishes hashing, a backfill pass inserts `output_models` rows for
  existing outputs whose sidecar `models[].name` matches and whose `hash` is
  `null`; the sidecar is not rewritten. `reindex` applies the same name-based
  resolution for sidecars with `hash: null`.
- **What a model is pictured by**: a thumbnail chosen by hand on its page
  always wins — "Set as thumbnail" is a decision, not a preference. Failing
  that it is whichever of its **first sample** or its **latest generation**
  `ui.model_thumbnail` asks for, with the other as the fallback so a model
  with only one of the two is still not an empty plate. The setting is in
  `config.yaml` and on the Settings page, and it applies everywhere a model
  is pictured.
- Each model has: thumbnail (as above), family, notes,
  tags, optional Civitai metadata (fetched by hash **only when the user
  clicks "Fetch info"**; never automatic). All of this lives in
  `models-meta/<hash>/` and the DB — nothing beside the safetensors.
- **Families are a hardcoded list** in the app — `flux`, `sdxl`, `anima`,
  `ltx`, `z-image`, `wan2`, `qwen-image`, `sd15` — served by
  `GET /api/families` with counts; there is no
  family CRUD and the app attaches no behaviour to a family, it is only the
  matching key between a workflow's `family` and a model's. A family can
  exist with no workflow behind it: filing the models is worth doing before
  there is anything to run them in. A model's family
  is inferred from Civitai `baseModel` when available (mapped onto the
  list), else read from the file itself (§6), else set by the user from the
  same list, else `unset`. A model can also be **hidden**: kept out of the
  Generate pickers while still listed on Models behind its own filter, for
  the files you cannot identify and might want to delete later.
  `ui.hidden_families` hides a whole architecture the same way — gone from
  the family chips and from every family picker, and every model filed as it
  reads as hidden. It never touches the per-model flag, so turning a family
  back on brings its models back exactly as they were. A probe
  answer records **which detector produced it**, and a scan re-reads any header an older one answered for: a family
  added in a later build otherwise never reached a model already on disk —
  the file had not changed, so no rescan ever looked at it again, and adding
  one did nothing for the people who had those models. `wan2` is one family and not two: ComfyUI builds
  Wan 2.1 and 2.2 from the same config off the same key, so the files do not
  draw the line. Pickers
  filter by family; unfiltered view is one click away.
- **The family is set from the same control everywhere** — the model page,
  a card in the grid, and the Family column of the table — a chip that opens
  a searchable list. It is positioned in viewport coordinates rather than
  absolutely inside its trigger: a card and a table cell both clip their own
  overflow, which swallowed the list whole.
- **A file is identified by its path, a model by its content.** `models` is
  keyed by the sha256, so two identical files at two paths are one model
  there and only one of them is named on the row; `model_files` records what
  each *file* hashed to, which is what the re-hash decision reads. Without
  it the losing path had no row at all — which is what "still hashing" means
  — so it was queued again on every single rescan, for ever, and the count
  never reached zero.

  The corollary is that **`ModelView.id` is not unique across a list**: the
  list walks files, and two files that hashed the same carry one id between
  them. A keyed `{#each}` over it therefore throws `each_key_duplicate` and
  renders nothing — which is how the model picker went blank for anyone with
  one checkpoint reachable through two configured folders. So key a list on
  what its rows actually mean: a picker writes a model's **name** into the
  workflow, so it lists one row per name (`byChoice`); the gallery's filter
  is a **hash**, so it lists one per model (`byModel`); the Models screen
  lists files, and keys on the path. The id is the identity of a model, not
  of a row in a list of files.
- **Hashing progress counts the pass that is running**, not every pass since
  launch. Carrying the totals forward made each rescan report a window onto
  nothing — "74/86", the tail of the last pass plus the head of this one.
  A file the hasher **cannot read** gets no `models` row, and a model with no
  row is "hashing", so one unreadable file wore that badge for ever and said
  nothing about why; it now reads `unreadable` and carries the error.
- **Display name** is editable and separate from the filename. It renders
  everywhere a model is named: model page header and breadcrumb, Models grid
  cards, LoRA/checkpoint pickers, Gallery table MODELS chips, and viewer
  metadata model links. Unset, it falls back to the filename minus extension.
  The **filename is immutable** and appears only on the model page metadata
  line. Sidecars keep recording filename + hash, so renames never affect
  reproduction. Display names may collide; the hash is the identity.
- A LoRA carries the ends of its own strength sliders, `strength_min` and
  `strength_max`, typed on its model page — only whoever trained or
  downloaded it knows how far it wants to be pushed. Unset means the default
  range of -2 to 2, which is wider than the ±1 most LoRAs want and leaves
  room for the ones that do not. A row added from the picker starts at 1.
- Model page = header (thumb, display name, family, size, full sha256, tags,
  notes, Civitai link, filename + folder with Copy path) + **Samples** strip +
  the standard gallery filtered to `output_models.model_hash = ?`. Header
  fields are edit-in-place (blur commits, esc reverts).

### 8.2 Model switching
Solved by construction: a workflow bakes in its checkpoint and its defaults.
Choosing a model = choosing a workflow. A workflow may expose a `checkpoint`
param restricted to its family for "same pipeline, different finetune."

### 8.3 Samples
Sample media for a model that did not necessarily come from this app (e.g.
Civitai). Stored in `samples/<model_hash>/` with a sidecar in the same schema
as outputs so **Reuse Parameters works on samples**.

Import paths:
- Drop a file onto the model page.
- Paste a Civitai image/model URL (fetches images and their generation data).
- "Promote to sample" on any output: the models popover (§11.3) lists the
  models that output used, checkpoint then LoRAs, multi-select; one sample
  is created per checked model (hardlink + sidecar copy).

Imported generation data (A1111-style infotext or Civitai `meta`) is **not
mapped in v1**. It is parsed only enough to be stored as `raw` in the sample's
sidecar (`params` empty, `workflow` null) and shown read-only on the sample so
the prompt/seed/settings are visible next to the image. Samples imported this
way do not offer Edit in Generate; samples promoted from the app's own
outputs carry a full sidecar and behave like any output. Mapping `raw` onto
a workflow's params is a later phase.

---

## 9. Input media (image / mask / video params)

Content-addressed store so inputs reused across many generations are stored
once: `inputs/<sha256[0:2]>/<sha256>.<ext>`.

On submit:
1. Hash the file (uploaded, pasted, painted mask, or picked from gallery).
2. Write to the store if absent. If the source is an app output on the same
   filesystem, hardlink; record `derived_from_output`.
3. `POST /upload/image` to ComfyUI with filename `<sha256>.<ext>` and
   `overwrite=true` (safe: identical content), landing in `comfy-input/`.
4. Bind the param to `<sha256>.<ext>`.
5. Record `output_inputs` rows on completion.

`comfy-input/` is a cache: swept on startup; **Rerun now** re-uploads from
the store as needed. Inputs are ref-counted through `output_inputs`; an orphan
sweep removes unreferenced files (user-triggered, with a dry-run preview).

The "edit this image" vs. "use as inspiration" distinction is not a storage
concept — it is which workflow the image is sent to and a `denoise`/`strength`
param on the img2img-style workflows.

---

## 10. Image-to-image, upscale, and editing

No new architecture: img2img, upscale and (later) editing are all workflows
with an `image` param.
- `krea2-img2img` ships in v1 (§4.6). Editing workflows (Kontext /
  Qwen-Image-Edit / Klein-edit / inpaint) are the same shape — `image`
  (+ optional `mask`) + `prompt` — and are added as user workflows later.
- Every output has **Use image in workflow** (video: **Use video in
  workflow**) listing workflows with a matching `image`/`video` param.
- **Upscale image** sits beside it. It is not a separate workflow: it routes
  to the `category: img2img` workflow in the **same family** as the output's
  workflow (no menu when exactly one matches, the popover filtered to
  `category: img2img` when several do, hidden when none; **image outputs
  only** — never shown on videos in v1), attaches the image,
  and presets `denoise` to **0.4** and `size` to **2× the source**, snapped
  down to a multiple of 16. Prompt, seed and LoRAs are prefilled from the
  source output's sidecar, not from whatever is currently selected. The
  user lands in Generate with the panel filled and can adjust before
  generating. Mechanically identical to "use in workflow": the input is
  hashed into the content-addressed store and `derived_from_output`
  recorded. An upscale is an ordinary derived output, not a special case.
  Resolution is client-side: `GET /api/workflows` carries `category` and
  `family`, `GET /api/outputs/:id` carries the output's workflow family and
  pixel size; the client picks the target and presets `denoise`/`size`
  before navigating to Generate. No upscale-specific route.
- The `mask` widget is a simple brush/erase canvas over the bound image,
  producing a PNG that goes through §9.
- Provenance chain via `derived_from_output` gives a "lineage" view.

---

## 11. UI

### 11.1 Global layout
Left nav rail, with Lucide icons: **Generate** `pencil-sparkles`,
**Gallery** `images`, **Models** `brain`, **Workflows** `workflow`,
**ComfyUI** `server`, **Settings** `settings`. The rail is a **56px icon
rail by default**,
collapsible to 196px labelled; the state persists. There are no keyboard
shortcuts for switching screens. A persistent **queue strip** pinned to the bottom shows the running
job (one detailed chip with progress), collapsed count chips per workflow for
queued jobs, and connection + VRAM state at the right, on every screen. It
has an idle form rather than disappearing, and collapses to a 6px bar. Queue
state lives **only** here — no screen duplicates it. The strip offers only
*Clear queue* and cancel of the running job; cancelling an individual queued
job is done from its placeholder on the Generate page.

Every media list (Generate session, Gallery, Models) shares one **tiles /
table toggle** — small tiles, large tiles, table — stored per screen.

### 11.2 Screens

**Generate**
- Workflow selector sits **inside the param panel**, at the top, as a card
  (thumb of last output, name, family/kind badges, last run). Clicking it
  opens a picker grouped by family and kind.
- Param panel rendered from the manifest: required params first, then
  optional, then a collapsed **Advanced** section. A PARAMETERS header row
  carries **Reset to defaults**. Sticky **Generate** button (one click = one job).
  Seed row has 🎲 and 🔒.
- Selecting a workflow populates the panel with the params from the **most
  recent job for that `workflow_id`** (a SQLite lookup on `jobs`), falling
  back to manifest defaults for a never-run workflow or for keys the last job
  lacks; keys the current manifest no longer has are ignored. Seed comes back
  as random unless 🔒 was on. Inputs are re-attached from the content-addressed
  store. A **Reset to defaults** button restores manifest defaults for
  every param except `text` params and attached inputs — what the user
  authored is kept. No separate "sticky defaults" storage exists — the job
  history *is* it.
- Right side: **live results** — the same gallery component, filtered to
  "this session's jobs," with in-progress cards showing percent/ETA/current
  node and streaming previews (ComfyUI binary preview frames). Failed cards
  keep their slot with the error inline plus Retry / Edit in Generate / Copy
  error.
- The viewer's actions are **Reuse parameters**, **Generate again**, **Save
  as sample** and Delete. Reuse parameters fills the panel and leaves the
  view alone — it used to drop back to the grid, taking away the thing you
  were setting the next run up from. The chip over the media reads **latest**
  while it is following (a label: nothing happens when clicked, so nothing
  lights up under the pointer) and **jump to latest** when it is not, which
  is the way back.
- **Focused output view**: clicking a result keeps the params panel left
  (360px) and puts the output in the centre, using **the same viewer layout
  as Gallery**: a metadata sidebar on the right (actions, created, duration,
  params, FILES, inputs, lineage) and a filmstrip along the bottom that
  walks the session's results. Both the sidebar and the filmstrip are
  **collapsible** (chevron on each; collapsed sidebar becomes a thin edge,
  collapsed filmstrip becomes a one-line count bar), and each open/closed
  state persists per screen. There is no separate session rail. Esc returns
  to the full-width grid. See §11.4 for follow-latest behaviour.
- **Metadata sidebar**: every row sits on its own raised plate, so the eye
  finds where the prompt stops and the next param starts without reading it.
  The label sits **above** its value rather than beside it: a label column
  took a fifth of a 306px sidebar away from the part worth reading.
  A model-valued param carries the link to its model page itself, and the
  roles below (unet / clip / vae / loras) list only what no param already
  named — the same LoRA is never shown twice. Each model is resolved by its
  filename, which is what a graph binds and what a sidecar records; a role
  cannot identify one, because a job with three LoRAs has three rows under
  the one `lora` role. Prompt and seed are
  `user-select: all`, so one click takes the whole value.
- **A LoRA row offers itself to the panel.** Each LoRA in the params carries
  a `+` that adds it to the workflow open in Generate **at the strength this
  run used** — the number that makes a LoRA worth anything is the one
  somebody already found for it, and it is sitting right there in the
  metadata, so it should not have to be read off and typed back in. Model
  and clip strengths stay apart when they differ. A LoRA the panel already
  lists is moved to the new strength rather than added a second time, which
  ComfyUI would apply twice. The `+` is dim rather than hidden — an offer
  nobody can see is not an offer — and it is absent when no workflow is open
  or the open one takes no LoRAs. Its title names the workflow, so it is
  unambiguous from the Gallery, where the panel is off screen.
- **No `dd` holds a value here**, which is why the rows are plain elements
  rather than a description list: Firefox's plain-text serialiser indents the
  contents of a `dd` by four spaces — on every line, blank ones included —
  whenever the selection spans the element, so a copied prompt arrived
  indented. It is the `dd` that does it, not the layout and not the nesting;
  a span inside one is indented too. `Selection.toString()` disagrees with
  what Ctrl+C produces, so only a clipboard round-trip settles it.
- Reuse Parameters lands here with the panel filled in.

**Gallery**
- One infinite, virtualized list (keyset pagination on `created_at, id`) in
  tiles or table form. Finished outputs only — no queue state here. Refresh
  restores exactly this view including scroll offset.
- **Day dividers** group both views by generation date (Today / Yesterday /
  date, with the day's count); headers stick while scrolling. The list endpoint
  returns flat rows; the client inserts dividers from `created_at` and
  fetches per-day counts lazily for the days on screen
  (`GET /api/outputs/days`), so counts may land a moment after the rows.
  No "n of total" position indicator in the viewer.
- Filters, all URL params: `workflow`, `kind` (image/video), `models`
  (multi-select over checkpoints *and* LoRAs, backed by `output_models`,
  selections always **AND**), `q` (prompt full-text), and `sort`
  (`newest` = `created_at desc`, default, or `oldest`). Nothing else is
  sortable — no workflow/model sort, no sortable table columns.
  There is no family filter (workflow implies it) and no date range (sort +
  day dividers cover it).
- Tile: square-cropped media with a 24–26px metadata strip (prompt excerpt,
  workflow badge). Table row: thumb, prompt, workflow, MODELS chips
  (checkpoint first, then LoRAs, `+n` overflow), SIZE (`1024×1024`; video
  `1216×704 · 0:05`), seed, DURATION (generation wall-clock, `31.4s`).
- **Viewer** replaces the browsing area (nav rail and queue strip stay):
  media centre with Fit / 1:1 and a size+zoom chip (video: transport bar),
  metadata sidebar right, filmstrip bottom that walks the same filtered set.
  Sidebar and filmstrip are collapsible, state persisted per screen; this is
  the one viewer component, shared with Generate's focused view.
  Sidebar order: actions, then created (absolute + relative), duration,
  params, FILES, inputs, lineage. Checkpoint and LoRA rows are links to their
  model pages; shift-click filters the grid to them.
- Output actions, named for consequence: **Edit in Generate →** (navigates,
  fills the panel, no job), **Rerun now ⟳** (enqueues immediately, stays
  put), **Use image in workflow** / **Use video in workflow**, **Upscale
  image**, **Promote to sample**, **Delete**. No favorites in v1.
- **Delete** has no confirmation: the item disappears and an undo toast
  (~8s) restores it. The row is soft-deleted (`deleted_at`) at once; the
  media and sidecar are removed from disk only after the undo window
  closes. A deleted output that is the parent of others appears in their
  LINEAGE as an orphan marker ("?"), not a link; bytes hard-linked into
  `inputs/` stay while any child references them.
- **LINEAGE** is read-only metadata: parents above, children below, each
  node showing the id suffix and the family from that output's sidecar,
  "this" marking the current one. Clicking a node opens it.
- **Identifiers**: an output's id is `<ulid>-<n>` and there is no
  secondary human id. Tiles, badges and lineage nodes show the last 5
  characters of the ULID plus index (`…ZM4T-0`); the viewer header shows
  the full id; FILES shows filenames.
- **FILES** block: absolute paths to media and sidecar, each copyable on
  click, left-truncated with `unicode-bidi: plaintext` (never
  `direction: rtl`).

**Models**
- Tabs: one per model **class** — Diffusion models / LoRAs / Text encoders /
  VAEs / other classes — not one per folder. The four folders that hold a
  model you can generate with (`checkpoints`, `Stable-Diffusion`,
  `diffusion_models`, `unet`, §8.2) are one tab, because looking through four
  of them for one model is four times the work. Under the tabs, when a class
  pools more than one folder, a row of folder chips (`All` + each folder key)
  narrows to one of them; the family chips sit below that, so each row down
  narrows further. Both views take the keyboard (§11.4): the tiles walk left
  and right, because an `auto-fill` grid has no column count to step by
  without measuring it, and the table walks up and down, one model to a
  line. Enter opens the highlight, Esc drops it. Both are URL params (`?class=`, `?kind=`). Tiles or table
  of cards with
  thumbnail (chosen sample → most recent output → empty plate), display name,
  family badge (or an inline SET FAMILY control when unset), count of outputs
  (a link into the Gallery filtered to that hash). Search (same matcher as
  the API `q`) + a **tag picker** beside it + family filter including an
  "unset" chip. `q` reaches tags, but only mixed in with names and
  filenames, so `?tags=` is the way to ask for a tag and mean it: comma
  separated, all of them required, a URL param like every other filter. The
  picker lists the ten commonest with their counts and narrows as you type,
  because a text box could only be typed into blind. The model page uses the
  same picker to *edit* a model's tags — typing a name nothing matches offers
  to make it, which is where the first tag of a kind comes from — and each
  tag on that page is a link back to this screen filtered to it, on the tab
  that model is on. **Show hidden** swaps
  the list for the models kept out of the Generate pickers; it is one or the
  other, never both. Every count beside a tab or a chip follows the search,
  the tags and that switch — a count has to say what clicking it would give
  you. The row under the filters carries the total size on disk. No
  multi-select or bulk edits in v1; family is set from the same picker on the
  card, in the table's Family column, or on the model page.
- Model detail page as described in §8.1: header with Copy path, full sha256
  on its own line (`user-select: all`, no truncation, no button), **Hide**
  (out of the Generate inputs, still listed here — the same toggle the grid
  card carries), **Re-read this file** and lookups on **civitaiarchive** and **civitai** built from
  that sha256 — the one identifier that survives a rename or a refiling.
  Re-read is a debugging action: it reads the header and the hash again
  past both caches, which is the only way to correct a wrong cached answer,
  since the ordinary Rescan exists precisely to skip files that have not
  moved. Nothing is sent anywhere; the lookups are ordinary links.
  Continuing: edit-in-place
  display name / family combo / tags / notes; Samples strip (with import drop
  zone and Civitai URL field; "Set as thumbnail" on a sample's hover menu);
  filtered gallery beneath.

**Workflows**
- Table of workflows: a drag grip, thumb (most recent output), name (+ USER
  COPY badge),
  family, kind, PARAMS column listing exposed keys with advanced params
  counted not named, source (bundled/user), last used. **Dragging a row by
  its grip sets the order**, which `config.yaml` keeps as `ui.workflow_order`
  and the Generate picker follows — groups included, so a workflow dragged to
  the top is not left below every family whose name sorts earlier. The list
  holds only the ids that were moved: anything else follows by name, so a new
  workflow needs no list updating and a deleted one leaves no hole. The grip
  alone starts the drag, as on a LoRA row. Header actions:
  **Import .json**, **New in ComfyUI**. Row ⋯ menu: Open in ComfyUI,
  Duplicate, Reset to bundled (only when a user copy exists), Delete (user
  copies only — never shown on bundled rows).
- Detail: manifest editor (§4.7) as one table of every literal input in
  `api.json` — exposed rows full-width editable (key, label, type, default,
  advanced), unexposed rows collapsed to node · input · current value; a live
  panel preview on the right; **Auto-expose all**; Duplicate; "Open in
  ComfyUI" (embedded editor loads `workflow.ui.json`; its Save writes both
  json files and returns here); **Save manifest** (changes the workflow hash;
  existing outputs keep their own graph copy).

**ComfyUI**
- Full embedded ComfyUI UI (same-origin proxy, §4.1), as an escape hatch.
- When opened from Generate's header ("Edit this workflow in ComfyUI") or
  a Workflows row, the current workflow's `ui.json` is loaded and the
  **Save & return / Discard** toolbar is shown; from the rail item it is
  raw ComfyUI with no toolbar.

**Settings**
- ComfyUI connection (managed child process vs. local URL as two radio
  cards; generated launch flags shown read-only for copying), ComfyUI install
  path, model folders (display-only list per kind, with Rescan; missing
  folders marked, not dropped; no add/remove — edit `config.yaml` and
  restart the app), data dir (read-only, set by `--data-dir` / env var at
  launch) with storage counts, maintenance (reindex, sweep staging, sweep
  orphan inputs).
- **No save button**: editable fields write `config.yaml` on blur.
  `model_folders` is not editable via the UI or `PATCH /api/config`; it is
  read at launch and `extra_model_paths.yaml` is generated from it then.
- **Destructive maintenance is dry-run first**: Sweep orphan inputs shows
  the count and size it would delete, then offers a button naming that
  number.

### 11.3 Interaction notes

- **Model and LoRA pickers** open over the param panel rather than hanging
  off the row that triggered them, so a picker low in the panel is not half
  off the bottom of the screen, and the search box takes the caret as it
  opens. Above the list are chips for the five commonest tags among the
  models it would show, each with the count it would leave; the rest are
  behind one `N more` control with its own search. Choosing more than one
  narrows — a model has to carry all of them. Every picker's list — models,
  LoRAs, families — answers to the up and down arrows and to Enter, from the
  search box, so choosing never needs the mouse. The highlight is a ring
  round the whole option, inset so it cannot shift the row, and it starts
  again at the top whenever the search narrows the list.
- A chip that reads as one control — the tag chip is a tag icon, a label and
  sometimes a ×, all in one rounded box — **lights up whole**. The padding
  belongs to the buttons inside it, never to the chip: padding on the chip is
  a band no button can reach, which is how the tag icon came to sit in an
  unlit margin while the words beside it were highlighted. The hover tint and
  the focus ring both go on the chip; the buttons inside keep only their own
  colour.
- Every in-app link is an `<a href>` whose handler calls `preventDefault()`,
  which is what makes routing work and what took ctrl-click away with it.
  Ctrl, ⌘ and the middle button are the browser's, through `opensElsewhere`;
  shift is left to the caller, because the metadata sidebar gives it a
  meaning of its own. **The middle button never arrives as a `click`** — no
  browser fires one for it — so an anchor middle-clicks natively (its handler
  never runs, so nothing is prevented) while anything that is not an anchor,
  such as a table row, has to answer `onauxclick` itself and call `newTab`.
  A row's own controls stop the click from reaching it but stop nothing on an
  auxclick, so the row skips one whose target sits inside a control.
- A **LoRA row carries its own model's family**, not the workflow's: they are
  the same word on every row only by coincidence, and a LoRA nobody has filed
  read as the workflow's family the moment it was chosen, having said `unset`
  in the list a second earlier.
- The pictures in the pickers follow new outputs: a generation gives every
  model it used a newer latest-generation, so the model lists are refetched
  once the outputs stop arriving. The server resolves which picture a model
  gets (§8.1), so the client asks rather than guessing.
- Param panels are narrow (360px) so results stay visible; textareas
  auto-grow.
- Picking a **model** hands the caret to the prompt: that is the start of
  writing one. Adding a **LoRA** does not — you are working in the list and
  usually about to add another, and being thrown back up to the prompt took
  the panel's scroll with it.
- **LoRA rows**: picker with thumbnail + name, remove button, drag to
  reorder **from the grip alone** — a row that is draggable everywhere means
  a drag on the strength slider moves the row instead of the handle.
  **Linked is the default**: one `strength` slider drives model and clip
  together; the ⛓ toggle unlinks and splits it into two sliders. The sidecar
  always records both values regardless. A slider reaches as far as its own
  model's `strength_min`/`strength_max` say (§8.1), and a row starts at 1.
  The strength beside the slider is an editable number, for the values a
  drag cannot land on; it wears no outline until it takes the caret. No
  number field in the panel shows spin arrows — not these and not the size
  W/H — they are a pixel-hunt for a step nobody wants.
- **Size presets are ratios** (`1:1, 2:3, 3:2, 4:3, 16:9, 9:16, 21:9`); exact
  pixels live on the native `title` tooltip and in the W/H fields. Ratios
  resolve against the workflow's base resolution, so 16:9 is 1344×768 on Flux
  and something else on SDXL.
- **Seed lock**: 🔒 captures the last run's *actual* seed into the field (not
  just whatever is displayed) so the next run repeats it. While unlocked the
  field shows the last-used seed greyed with a "random each run" hint. 🎲
  re-rolls immediately in either state. **Editing the field auto-locks** to
  the typed value; `-1` always means random (the field unlocks and the hint
  returns).
- Progress card is **one tile like every other**: percent, ETA, node label and
  step counter over the streaming preview, sized to fit the square. It spanned
  two columns once, for the numbers' sake; what that actually cost was the
  grid's rhythm, reflowing every finished tile around it for as long as a job
  was in flight. The numbers shrank instead. The preview **fits** rather than
  fills: a frame from the sampler is a handful of pixels to begin with, and
  cropping it only makes the one thing it is for harder to read. Failed cards
  expose the error inline with Retry.
- Video and image tiles are one component; kind only changes the badge and
  hover playback (muted autoplay).
- Tile actions (Edit in Generate, Rerun now, Use in workflow, Upscale) appear
  as an overlay on hover and stay visible on the **selected** tile; they are
  focusable buttons, so a selected tile's actions are reachable with Tab.
- The LoRA picker is family-filtered to the workflow by default ("Show all" is
  one click and does not persist); already-added LoRAs stay listed, marked
  "added". Rows show output count and last-used time; sorted by recent use,
  then count.
- One popover component (326px) serves the LoRA picker, the models filter,
  the use-in-workflow menu and the promote-to-sample target picker.

- **Narrow windows** (desktop-only app, no real breakpoints): the metadata
  sidebar collapses first, then the media centre shrinks; the params panel is
  the last to give. The filmstrip stays unless the user collapses it.

- **ComfyUI state.** The **Generate** button is disabled whenever ComfyUI is
  not connected, and whenever any `required` param is empty. While ComfyUI
  is starting up, the queue strip's place shows a "ComfyUI starting…"
  indicator; when it is disconnected or failed, the queue strip is not
  shown at all and the Settings connection card carries the error.

### 11.4 Behaviour
- **Follow-latest, sticky (Generate focused view).** While the displayed
  output *is* the newest, the centre updates in place as each result lands
  ("following latest" chip, "newest" badge on the media). Selecting any older
  output stops following: the chip greys to "pinned · <id>", and new results
  appear only in the filmstrip — they never steal the centre. Pressing →
  past the newest, or clicking the chip, resumes following.
- **Keyboard.** Exactly two behaviours are bound, and only while a media
  view or a media list has focus (never inside text inputs):
  - ← / → move selection through the current ordered set (← older, →
    newer); ↑ / ↓ move by row in tile view. Applies to Generate's session
    list and Gallery alike, with auto-scroll to keep the selection visible.
  - **f** toggles fullscreen of the displayed output — media only, no
    chrome, black field. Escape also exits fullscreen and leaves the
    focused/viewer state back to the grid at the same scroll position.

  No screen-switching, generate, or view-toggle shortcuts. All bindings are
  declared in `config.yaml` and are the single source of truth:

  ```yaml
  keys:
    select_prev:  [ArrowLeft, a]
    select_next:  [ArrowRight, d]
    select_up:    [ArrowUp, w]
    select_down:  [ArrowDown, s]
    fullscreen:   [f]
    close:        [Escape]
  ```

  A chord is never one of these: a binding is a bare key, and several are
  plain letters, so an event carrying ctrl, meta or alt matches nothing —
  otherwise `Ctrl+A` would move the selection on its way to selecting all.

  A first run writes the whole default tree into `config.yaml`, which makes
  the file self-documenting and also **freezes every value in it**: a default
  changed later loses the merge to the stored one, which is how these letters
  reached new installs only. A stored block that still matches a former
  default was never touched by anybody, so it is brought forward on load and
  the file rewritten; a block that was edited matches none of them and is
  left exactly as it is. `SUPERSEDED_KEYS` in `src/config/config.ts` is that
  history — append to it when a default changes again.

  Values are `KeyboardEvent.key` names; a list allows alternates. Adding a
  new shortcut later means adding a key here, not a hardcoded handler.

### 11.5 Visual system
- **No outlines.** Separation comes from fill steps, not borders: canvas
  `#0d0d0d` · app `#191919` · panel `#1e1e1e` · raised `#232323`/`#262626` ·
  control `#2b2b2b` · selected control `#3d3d3d`. Hairlines only for
  structural edges: `#242424`/`#262626`.
- **Neutral achromatic greys.** Text `#ededed` / `#c8c8c8` / `#9a9a9a` /
  `#6e6e6e` / `#585858`. Accent `#6fb6c8` (tint bg `#15292f`/`#1f3238`),
  running `#e0a253`, error `#e0736a`, ok `#7fbf7a`.
- **Radii**: 4px controls, 6px inputs/buttons/tiles, 8px cards, 10px
  popovers, 12px window.
- **Type**: IBM Plex Sans for UI, IBM Plex Mono for all numbers, paths, ids,
  seeds, badges.
- **Media tiles are always `aspect-ratio: 1`**, cropped to fill, with a
  24–26px metadata strip overlaid at the bottom. Never assume portrait or
  landscape; real dimensions live in metadata.
- Dashed borders survive in exactly two places: drop zones and queued
  placeholders.
- Dark only. There is no light theme.
- Source of truth for visuals: `ComfyUI Frontend Mocks.dc.html` (11 frames,
  1440×900).

---

## 12. HTTP API (app ↔ frontend)

```
GET  /api/workflows                     list (latest versions): id, name, family, kind, category, params summary, source, last_job_at, last_output_id
GET  /api/workflows/:id                 manifest + metadata (+ has_user_copy)
GET  /api/workflows/:id/inputs          every literal input of api.json: [{node_id, node_type, node_title, input, value, type_hint}]
PUT  /api/workflows/:id                 save manifest / ui+api json (bundled → creates the user copy)
POST /api/workflows                     new: {} (blank, opens the editor) or {ui_json} (Import .json)
POST /api/workflows/:id/duplicate
POST /api/workflows/:id/reset           delete the user copy, revert to bundled
DELETE /api/workflows/:id               user copies only; 409 for bundled
POST /api/jobs                          {workflow_id, params}   one job per call
POST /api/jobs/rerun                    {output_id} | {job_id}   resubmit a frozen graph (rerun exact / retry failed)
POST /api/jobs/:id/cancel
POST /api/jobs/clear                    cancel every queued job
GET  /api/jobs?status=active
GET  /api/jobs?workflow_id=&limit=1        last-used params for a workflow
GET  /api/jobs/:id                      one job row with the ids of its outputs
GET  /api/outputs?cursor&filters…&sort   keyset paginated; filters per §11.2; sort newest|oldest
                                        rows carry the row of §7 plus media_url, the models chips
                                        and generation_ms (the job's wall clock, for DURATION)
GET  /api/outputs/days?filters&dates=   per-day counts for the given days only (lazy, client-driven);
                                        `tz_offset` in minutes (as getTimezoneOffset() reports it)
                                        so the counts match the dividers the client drew
GET  /api/outputs/count?filters         total under the active filters (lazy)
GET  /api/outputs/:id                   with sidecar contents
GET  /api/outputs/:id/lineage           {parents[], children[]}; each node: id, family, deleted (→ "?" marker)
POST /api/outputs/:id/promote           {model_hashes[]} → one sample per model
DELETE /api/outputs/:id                 soft delete (sets deleted_at); file removal deferred past the undo window
POST /api/outputs/:id/restore           undo within the window (clears deleted_at)
GET  /api/media/*                       serves outputs/inputs/samples
GET  /api/config                        contents of config.yaml (effective, after CLI overrides)
PATCH /api/config                       partial update, written to config.yaml
GET  /api/families                      hardcoded list with model/workflow counts
GET  /api/models?kind&class&family&q&tags&hidden  q: substring, case-insensitive, over display name + filename + tags; returns output_count, last_used_at
                                        tags: comma separated, all required; hidden=1 lists the hidden pile instead of the visible one
                                        also returns `classes`: the class of every configured folder kind, which is what the Models tabs group by
                                        hashed and unhashed models together; an unhashed one has hash: null and is addressed by `path:<base64url of its path>`
GET  /api/models/:hash
PATCH /api/models/:hash                 display_name, family, notes, tags, hidden, strength_min, strength_max, thumb_sample_id ("Set as thumbnail"); 409 while the model is still unhashed
POST /api/models/:hash/rescan           re-read this one file's header and hash, past both caches (§8.1); returns the model
POST /api/models/:hash/samples          upload or {civitai_url}; generation data stored as raw only
DELETE /api/samples/:id
POST /api/models/:hash/fetch-info       explicit Civitai lookup
POST /api/inputs                        upload → {sha256}
GET  /api/system/status                 comfy state (starting|running|disconnected|failed), pid, uptime, VRAM free (ComfyUI /system_stats)
POST /api/system/comfy/restart          managed mode only
GET  /api/system/comfy/log              tail of the child process log
GET  /api/system/storage                counts + bytes for outputs, inputs, samples, app.db
GET  /ws                                job/progress/output events, system_status, hashing_progress, rescan_progress (JSON) + preview frames (binary, job-id-prefixed)
POST /api/maintenance/reindex
POST /api/maintenance/sweep-staging
POST /api/maintenance/sweep-inputs      {dry_run: bool} → {count, bytes, files[]}; dry_run feeds the preview
POST /api/maintenance/rescan-models
```

---

## 13. Build phases

**Phase 1 — core loop**
Deno server, SQLite schema, ComfyUI child-process management, workflow
loading + manifest rendering, scalar bindings + `lora_list` rewrite, job
submission, WS progress, staging→outputs move, sidecars, single gallery with
pagination, Reuse Parameters (both modes), bundled image workflows. Test
scaffolding from §14 (fake ComfyUI, fixture generators) is built in this phase,
not after it.

**Phase 2 — models & discoverability**
Read-only model scan, background hashing, model/LoRA pages with filtered
gallery, family filtering in pickers, samples import (file drop),
promote-to-sample, node-timing-based ETA.

**Phase 3 — inputs & video polish**
Content-addressed inputs, `image`/`video` params, "Use in workflow" + "Upscale image", provenance,
orphan sweeps, LTX bundled workflow verified end-to-end, video previews,
Civitai fetch-info and URL import (raw only).

**Phase 4 — editing**
`mask` widget, inpaint/edit bundled workflows, lineage view.

**Phase 5 — quality**
Manifest auto-generation, embedded ComfyUI save round-trip hardening,
`reindex` robustness, packaging (`deno compile`).

---

## 14. Testing scope

Actually running image or video generation is **out of scope** for the test
suite: no GPU, no real models, no real ComfyUI in the default run. Everything
else is in scope, and the DB is exercised through the server's HTTP/WS
interface rather than through a separate repository layer.

### 14.1 Levels

**Unit (pure functions, no I/O)**
- Manifest validation and param coercion (each type in §4.3, `required`,
  min/max, `seed: -1` resolution).
- Graph rewrite: scalar `bind`, `size` bind, `lora_list` splice (0, 1, N rows;
  model-only LoRAs), `filename_prefix` stamping. Written as **golden tests**:
  `api.json` + params → expected `api.json`, fixtures committed under
  `tests/golden/`.
- Sidecar construction and parsing (round-trip; forward-compat with unknown
  fields).
- Import parsers: A1111 infotext and Civitai `meta` → `raw` (structure
  preserved, nothing mapped).
- Safetensors header parsing and the `path+size+mtime` re-hash decision.
- Progress estimation (§5.1) given a `node_timings` table and a WS event
  sequence.
- Keyset pagination cursor encode/decode and filter → SQL builder.

**Server integration (real SQLite, real filesystem, fake ComfyUI)**
- Each test boots the Deno server in-process against a temp `<appdata>` dir
  and a temp SQLite file (WAL on, same pragmas as production).
- **Every HTTP route in §12 has at least one test** that goes through the
  route, not the DB directly. Assertions may read the DB afterwards to verify
  state, and may inspect the filesystem (outputs, inputs, staging, sidecars).
- Fixtures are generated, not stored: tiny PNGs/MP4s via a helper, fake
  safetensors files (valid JSON header + a few bytes of tensor data) so the
  model scanner and hasher run for real on kilobyte-sized files.
- Coverage targets: job lifecycle (queued → running → done/failed/cancelled),
  staging → outputs rename + sidecar + index, pagination and filters, model
  scan/hash/metadata patch, samples import (file drop; Civitai URL via a
  stubbed fetch), inputs upload/dedup/hardlink/`derived_from`, `reindex`
  rebuilding an identical DB from files, sweeps (staging, orphan inputs)
  including dry-run.

**Fake ComfyUI**
An in-process HTTP+WS server implementing the subset the app uses: `/prompt`,
`/queue`, `/interrupt`, `/history`, `/upload/image`, `/view`, `/ws`. On
`/prompt` it validates the graph shape, writes fixture files to
`staging/<jobid>/` per the graph's output nodes, and emits a scripted event
sequence. Scenarios are data-driven so tests can cover: success, multi-output,
`execution_error` mid-graph, cancel while queued vs. running, WS disconnect
and reconnect mid-job, and process death before `executed` (job marked failed
on restart, staging swept). This is the only place WebSocket behaviour is
tested, and it is tested thoroughly — it is the most fragile boundary in the
app.

**Frontend**
- Component tests for the param panel: one test per param type rendering from
  a manifest, advanced-section collapse, `required` gating, LoRA row
  add/remove/reorder, seed 🎲/🔒.
- Reuse Parameters "load params" mapping into the panel, including the
  missing-key warning.
- One Playwright smoke test (server + fake ComfyUI): submit a job, watch
  progress, see the output card appear, refresh, confirm it is still there.
  Kept to a handful of flows; not a substitute for the layers above.

**Contract check (opt-in, not in default run)**
A test tagged `comfy` that runs against a real local ComfyUI with a trivial
graph needing no models (e.g. `EmptyImage` → `SaveImage`) to verify the
API/WS assumptions the fake is built on. Run manually or in a nightly job.
If it fails, update the fake; never make the default suite depend on it.

### 14.2 Rules
- Hermetic: temp dirs, no network (Civitai calls go through an injectable
  fetch), no shared state between tests, no real model folders.
- `deno test` with `--allow-read/--allow-write` scoped to the temp dir;
  the `comfy` tag is opted into via an env var.
- Golden files are updated deliberately (`UPDATE_GOLDEN=1`), never
  silently.
- A bug fix in the rewrite, sidecar, or job pipeline ships with a test that
  reproduces it.

---

## 15. Open questions (from the mock pass)
1. *(Resolved)* Upscale is the same-family `img2img` workflow with denoise
   0.4 and 2× size; only `krea2-img2img` ships in v1, so Upscale is hidden on
   sdxl/anima/ltx/z-image outputs until their img2img workflows exist.
2. *(Resolved)* `display_name` collisions allowed; hash is the identity
   (§8.1).
3. Should notes / Civitai description be searchable anywhere, given they are
   excluded from `q`? Proposed: a "search notes" toggle on the Models page
   only.
4. *(Resolved)* Ratio presets resolve against the `size` param's `default`;
   optional `step` (16|64) snaps results to the model's grid (§4.3).
