# ForgeUI — Phase 1 implementation instructions

You are implementing Phase 1 of the app described in `docs/DESIGN.md`. That
document is **authoritative**. If this file and DESIGN.md disagree, DESIGN.md
wins. If the code you are about to write disagrees with DESIGN.md, stop and
ask rather than deviating.

Visual reference: `docs/mocks/*.png` (numbered frames) and
`docs/mocks/ComfyUI Frontend Mocks.dc.html`. Match them; do not invent UI
that is not in a frame or in DESIGN.md §11.

## What Phase 1 delivers

A person can start the app, pick a bundled image workflow, type a prompt,
press Generate, watch progress, see the image land in the session grid,
click it to view it, and reproduce it later from the Gallery — and every
byte needed to do that is on disk, not just in memory. Nothing about models
pages, samples, input images, upscale, or video is in scope.

**Definition of done** — all of these are true, and each is covered by a
test that runs without a GPU:

1. `deno task start` launches the app, reads `config.yaml` (creating it on
   first run), starts ComfyUI as a managed child process, generates
   `extra_model_paths.yaml`, and serves the UI on one port with ComfyUI
   proxied under `/comfy/*`.
2. The seven bundled workflows load from `workflows/bundled/`; the Generate
   panel renders each one from its manifest alone (§4.2–4.3), with the
   param panel populated from the last job for that workflow (§11.2).
3. Generate submits one job: manifest values are bound into `api.json`,
   `lora_list` is spliced (§4.4), `filename_prefix` is set to `<jobid>/out`,
   the job row is persisted *before* `POST /prompt`, and progress arrives
   over the app's `/ws` including binary preview frames (§5).
4. On completion, files are `rename()`d from `staging/<jobid>/` to
   `outputs/YYYY/MM/DD/`, the sidecar (§6.2) is written, a copy is embedded
   in PNG `tEXt`, the DB is indexed, and clients are notified. Failures land
   on the job row with ComfyUI's error and the staging dir removed.
5. Gallery lists outputs flat with keyset pagination, client-inserted day
   dividers with lazy counts, the tiles/table toggle, the viewer with
   sidebar + filmstrip, and the same viewer layout in Generate's focused
   view (§11.2).
6. Reuse Parameters works both ways: **Edit in Generate →** fills the panel
   by key, warning on keys the manifest no longer has; **Rerun now ⟳**
   resubmits the frozen `api_graph` from the sidecar or from a failed job
   row (§6.4). Delete is soft with an undo window (§11.2).
7. Browser refresh loses nothing: queued/running jobs and the session grid
   are rebuilt from `jobs` and `outputs`.
8. `deno task reindex` on an empty DB rebuilds identical `jobs`/`outputs`
   rows from the sidecars on disk (§7).
9. `deno test` passes: unit tests for validation/rewrite/sidecar/pagination,
   server integration tests against a temp data dir and a **fake ComfyUI**,
   and one Playwright smoke test (§14). The fake ComfyUI and fixture
   generators are built in this phase, before the real pipeline.

## Out of scope (do not build, do not stub in the UI)

Models/LoRA pages and scanning beyond what the LoRA picker needs (see M4),
samples, Civitai, content-addressed inputs, `image`/`mask`/`video` params,
Upscale image / Use in workflow, video outputs, ETA from node timings (use
equal node weights, §5.1 fallback), Settings page beyond a read-only view of
`config.yaml`, packaging via `deno compile`.

## Milestones, in order

Each milestone ends with its tests green. Do not start the next one with the
previous one red.

### M0 — skeleton and test harness
- Repo layout below; `deno.json` tasks: `start`, `test`, `reindex`,
  `fmt`, `lint`.
- Config loading (§3.1): `--data-dir` / `FORGEUI_DATA_DIR` / `~/.forgeui`; create
  `config.yaml` with defaults on first run; CLI overrides never written
  back; `keys:` block present.
- SQLite open (WAL) + migrations from `src/db/schema.sql` (§7, exactly).
- **Fake ComfyUI** (`tests/fake-comfy/`): HTTP + WS server implementing
  `/prompt`, `/queue`, `/interrupt`, `/history`, `/upload/image`, `/view`,
  `/ws`, `/system_stats`. On `/prompt` it validates graph shape, writes
  fixture PNGs into `<staging>/<jobid>/` per the graph's `SaveImage` nodes,
  and replays a scripted event sequence (success, multi-output, error
  mid-graph, cancel while queued, cancel while running, WS disconnect +
  reconnect, death before `executed`). Scenarios are data-driven.
- Fixture generators: tiny PNGs with known dimensions; sidecar builder.
- Golden-test runner with `UPDATE_GOLDEN=1`.
- Test: server boots against a temp data dir; config round-trips.

### M1 — workflows and manifests
- Load `workflows/bundled/<id>/{workflow.ui.json, workflow.api.json,
  manifest.json}`; user copies in `workflows/user/<id>/` shadow bundled.
- Manifest validation against the closed param type set (§4.3); content
  hash `sha256(api.json + manifest.json)` (§4.5).
- Param coercion: `required`, min/max/step, `seed: -1` → random, `size`
  defaults + `step` snapping.
- Graph rewrite (`src/workflows/rewrite.ts`): scalar `bind`, `size` bind,
  `lora_list` chain splice incl. model-only LoRAs, `filename_prefix`
  stamping. **Golden tests**: `tests/golden/<case>/{api.json, params.json,
  expected.json}` for 0/1/N LoRAs, model-only, size, seed.
- `GET /api/workflows`, `GET /api/workflows/:id`, `PUT` (bundled → creates
  user copy), `GET /api/workflows/:id/inputs`, `POST /api/workflows`
  (blank or `{ui_json}`), `duplicate`, `reset`, `DELETE` (409 on bundled).
- Bundled workflows: author the seven `api.json` + `manifest.json` files
  from standard ComfyUI core nodes per §4.6. You cannot run them; keep
  node types to core ComfyUI (`CheckpointLoaderSimple`/`UNETLoader`,
  `CLIPTextEncode`, `EmptyLatentImage`/`EmptySD3LatentImage`, `KSampler`,
  `VAEDecode`, `SaveImage`, `LoraLoader`). Mark model filenames as
  placeholders in a `README` under `workflows/bundled/`; the user will
  open each in ComfyUI, fix model names, and re-save.

### M2 — ComfyUI process and the job pipeline
- Managed child process (§2): spawn with `--output-directory`,
  `--input-directory`, `--extra-model-paths-config`; capture logs; status
  state machine `starting|running|disconnected|failed`; `GET
  /api/system/status`, `POST /api/system/comfy/restart`, `GET
  /api/system/comfy/log`. Local-URL mode connects without spawning.
- Reverse proxy `/comfy/*` (HTTP and WS) to the ComfyUI port so the
  embedded editor is same-origin (§4.1).
- `POST /api/jobs`: validate → rewrite → persist job (`api_graph_json`,
  `params_json`, status `queued`) → `POST /prompt` → store `prompt_id`.
- ComfyUI WS client with reconnect: map `execution_start / executing /
  progress / executed / execution_error` onto `progress_json` (exact shape
  in §7) and job status; relay binary preview frames on `/ws` prefixed
  with the job id (§5 step 6).
- Completion: `rename()` staging → `outputs/YYYY/MM/DD/`, write sidecar
  (§6.2), embed in PNG `tEXt`, insert `outputs` + `output_models` rows,
  broadcast. Error: job `failed`, staging removed.
- `POST /api/jobs/:id/cancel`, `POST /api/jobs/clear`, `POST
  /api/jobs/rerun {output_id|job_id}`, `GET /api/jobs?...`.
- Startup: sweep `staging/` orphans; mark jobs that were `running` at
  shutdown as `failed`.
- Integration tests for every scenario the fake ComfyUI scripts.

### M3 — outputs, gallery API, reindex
- `GET /api/outputs` keyset on `(created_at, id)`, filters `workflow`,
  `kind`, `models`, `q` (FTS5), `sort newest|oldest`; `GET
  /api/outputs/days`, `GET /api/outputs/count`, `GET /api/outputs/:id`,
  `DELETE` (soft) + `POST /api/outputs/:id/restore`, deferred file removal
  after the undo window, `GET /api/media/*`.
- `deno task reindex` and `POST /api/maintenance/reindex`: walk `outputs/`,
  parse sidecars, rebuild `jobs` (as `done`) / `outputs` / `output_models`.
  Test: generate → snapshot DB → drop DB → reindex → identical.

### M4 — frontend
- Svelte SPA served by the Deno process; single design-token file from
  §11.5; IBM Plex Sans/Mono; dark only; Lucide icons per §11.1.
- Shell: 56px icon rail (collapsible, persisted in `config.yaml` `ui`),
  persistent queue strip with its three states (idle / running / hidden
  when disconnected; "ComfyUI starting…" while starting).
- Generate: workflow card + picker popover, manifest-driven param panel
  (text, int, float, bool, enum, seed with lock semantics §11.3, size with
  ratio presets, `lora_list` with linked/unlinked strengths), Advanced
  collapse, Reset to defaults (§11.2 semantics), Generate button disabled
  rules (§11.3), session grid with running/queued/failed/done cards, tile
  action overlay on hover + selected, focused view with sidebar +
  filmstrip (§11.2), follow-latest (§11.4), keyboard from `config.yaml`
  `keys` only.
  - The LoRA picker needs a model list. Ship a **minimal read-only scan**
    of the `loras` folder (path, filename, display_name fallback, family
    `unset`) — no hashing, no pages. Full model library is Phase 2.
- Gallery: tiles/table toggle, day dividers with lazy counts, filters as
  URL params, viewer with collapsible sidebar/filmstrip, Delete + undo
  toast, Edit in Generate / Rerun now.
- Workflows list + manifest editor (§4.7) + embedded ComfyUI with the
  **Save & return / Discard** toolbar (§4.1).
- Settings: read-only rendering of `config.yaml` sections shown in frame
  08 (no maintenance actions except Reindex).
- Component tests for the param panel per §14.1; one Playwright smoke test
  (submit → progress → card → refresh → still there) against the fake
  ComfyUI.

## Repository layout

```
deno.json
src/
  main.ts                 CLI, config, boot
  config/                 load/merge/write config.yaml; extra_model_paths.yaml
  db/                     schema.sql, migrations, queries (no ORM)
  comfy/                  process manager, ws client, http client, proxy
  workflows/              loader, manifest schema, validate, rewrite
  jobs/                   submit, progress, completion, sidecar
  outputs/                list/filters, delete/restore, reindex
  http/                   routes (one file per §12 group), ws hub
  frontend/               Svelte app (Vite), built into dist/ and embedded
workflows/bundled/<id>/   the seven workflows + README
tests/
  unit/  integration/  golden/  fake-comfy/  fixtures/  e2e/
docs/
  DESIGN.md  MOCK-REVISIONS.md  mocks/*.png  mocks/*.dc.html
```

## Conventions the agent must follow

- TypeScript strict, Deno std + `@db/sqlite`; no ORM; SQL lives in
  `src/db/queries.ts` as tagged functions, one per query.
- No foreign keys to `workflows` anywhere (§7). Outputs must stay usable
  after a workflow is deleted — there is a test for this.
- Sidecar is the source of truth; the DB is derived. Anything you'd store
  only in the DB about an output must also be in the sidecar.
- Never write inside model folders. Never download anything.
- Every route in §12 that Phase 1 implements has at least one integration
  test hitting the route, not the query.
- Copy the exact JSON shapes from DESIGN.md (`progress_json`, sidecar,
  manifest). Add fields only by editing DESIGN.md first.
- UI: only the two keyboard bindings, read from config; no favorites, no
  batch count, no light theme, no reveal-in-file-manager, no bulk edits.
- Commit per milestone with a short summary of what was verified.

## When to stop and ask

- A bundled workflow needs a node type that isn't core ComfyUI.
- The ComfyUI frontend's `app.graphToPrompt()` / `graph.serialize()` are not
  reachable from the proxied iframe in the version installed.
- Any place where the mocks and DESIGN.md §11 disagree.
