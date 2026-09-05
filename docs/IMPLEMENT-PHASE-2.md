# ForgeUI — Phase 2 implementation instructions

You are implementing Phase 2 of ForgeUI. `docs/DESIGN.md` is **authoritative**;
if code and DESIGN.md disagree, stop and ask. Read `docs/PHASE-1-HANDOFF.md`
before touching anything — its "Decisions worth knowing" section (int64
SQLite, client-chosen `prompt_id`, second-truncated `created_at`, sidecars
outrank the DB, shared WS payload shapes) all still apply and are not
repeated here.

Phase 1 built the loop: workflow → job → output → gallery → reproduce.
Phase 2 makes the **model library** real and closes the "discoverability"
goals of §1: you can click a LoRA and see everything it made, name and tag
your models without touching the safetensors, hang sample images off them,
and get an ETA that means something.

## Two things before any Phase 2 code

**1. Prove Phase 1 on real hardware.** Nothing in the repo has run against a
real ComfyUI. The first milestone below (M5) writes the `comfy`-tagged
contract check from DESIGN.md §14.1 and lists what the user must verify by
hand. The agent writes the test and the checklist; the user runs them. Do not
proceed past M5 until the user reports the checklist green — several Phase 2
features (thumbnails, samples, output↔model links) are worthless if the
pipeline they hang off doesn't work for real.

**2. Amend DESIGN.md first** for the two things Phase 2 needs that it does
not yet say, and one rescheduling. Proposed wording follows; edit DESIGN.md,
then implement.

- **§8.1, unhashed models.** "A model appears in pickers as soon as it is
  scanned, identified by `path`. Its `models` row (keyed by `hash`) exists
  only once the background hasher has finished it; until then display name,
  family, notes, tags and thumbnail cannot be edited and the UI shows a
  `hashing` state. At job completion, `output_models` rows are written for
  every model whose hash is known. When a model finishes hashing, a backfill
  pass inserts `output_models` rows for existing outputs whose sidecar
  `models[].name` matches and whose `hash` is `null`; the sidecar is not
  rewritten. `reindex` applies the same name-based resolution for sidecars
  with `hash: null`."
- **§13, Civitai moves to Phase 3.** `fetch-info`, Civitai URL import and
  the infotext parser leave Phase 2. Phase 2 samples come only from file
  drop and Promote to sample; family is set by the user. Add "Civitai
  fetch-info and URL import (raw only)" to the Phase 3 line and remove it
  from Phase 2.
- **§5.1, seeding node timings.** "`node_timings` is seeded from the
  `timing.nodes` block of every existing sidecar on first launch after this
  phase and updated after every successful job (EWMA, α = 0.3)."

## What Phase 2 delivers

**Definition of done** — each point has a test that runs without a GPU:

1. Models are scanned from the configured folders on launch and on Rescan,
   hashed in the background (sha256 of the whole file, one worker, lowest
   priority), with `hashing_progress` on `/ws` and the count in the queue
   strip's status area. Re-hash only when `path+size+mtime` changed.
2. `GET /api/models` returns hashed and unhashed models, with
   `output_count`, `last_used_at`, `family`, `display_name`, `thumb`;
   `GET /api/families` returns the hardcoded list with counts.
3. Models screen: tabs per kind, tiles/table, search over display name /
   filename / tags, family filter with `unset` chip, per-card SET FAMILY,
   Rescan. Model detail: edit-in-place header (display name, family combo,
   tags, notes), full sha256 line, Copy path, Samples strip, and the
   standard gallery filtered to that model. The "Fetch info from Civitai"
   button and the Civitai URL field are **not rendered** in this phase.
4. Samples: drop a file or Promote to sample from any output (models
   popover, multi-select). Sample hover menu: Set as thumbnail, Delete.
   Dropped files get a sidecar with empty `params` and no Edit in
   Generate; promoted ones behave like outputs.
5. Every model reference in the UI is a display name and a link: viewer
   PARAMS rows (shift-click filters the grid), gallery MODELS chips, the
   models filter popover (grouped checkpoints/LoRAs with counts), the LoRA
   and checkpoint pickers (family-filtered by default, "Show all", output
   count, last used, "added" state, thumbnails).
6. `output_models` is populated at completion for hashed models and
   backfilled as hashes land; `reindex` rebuilds it (the Phase 1 test that
   seeds rows by hand becomes redundant and is replaced).
7. ETA uses per-node weights from `node_timings` (§5.1), seeded from
   existing sidecars; first run of a workflow falls back to equal weights.
8. `GET /api/system/storage` and the Settings storage cards; Rescan button.
9. The `comfy`-tagged contract check exists and is documented; the default
   `deno task test` still needs no ComfyUI.

## Out of scope

Content-addressed inputs, `image`/`mask`/`video` params, Use in workflow,
Upscale image, video outputs, sweeps, `deno compile`, **anything Civitai**
(fetch-info, URL import, infotext parsing — all Phase 3), model downloading
of any kind. Leave `civitai_json` in the schema untouched and unused.

## Milestones, in order

### M5 — real-hardware contract check (write, then wait)
- `tests/contract/comfy_test.ts`, tagged so it runs only with
  `FORGEUI_COMFY_URL` set (and `deno task test:comfy`). Against a real local
  ComfyUI it verifies exactly the assumptions the fake makes: `/prompt`
  honours a client-supplied `prompt_id`; the WS event sequence and field
  names for `execution_start / executing / progress / executed /
  execution_error`; binary preview frame layout; `SaveImage` with
  `filename_prefix = <jobid>/out` lands in `<output-directory>/<jobid>/`;
  `/system_stats` shape; `/upload/image` with `overwrite=true`. Use a graph
  that needs no model (`EmptyImage` → `SaveImage`).
- If any assertion fails, fix the **fake** to match reality and re-run the
  default suite; do not paper over it in the app.
- `docs/HARDWARE-CHECKLIST.md`: the manual steps from the handoff — fix
  bundled model filenames in ComfyUI and Save & return; confirm
  `graphToPrompt()` is reachable through `/comfy/*`; run one real
  generation with `krea2` end-to-end and check the sidecar, the PNG
  `tEXt`, and Rerun now. **Stop here until the user confirms.**

### M6 — model library backend
- Extend `src/models/scan.ts` (do not replace): persist scan results in an
  in-memory registry keyed by `path`; kinds from `config.model_folders`;
  `POST /api/maintenance/rescan-models`; `rescan_progress` on `/ws`.
- `src/models/hasher.ts`: single background worker, streaming sha256,
  cache decision on `path+size+mtime`, `hashing_progress` events, writes
  the `models` row on completion (with `last_seen_at`), then runs the
  backfill of `output_models` described in the §8.1 amendment.
- `output_count` / `last_used_at` maintenance on output insert, soft
  delete/restore, and reindex.
- Routes: `GET /api/families`, `GET /api/models` (merged hashed +
  unhashed; `q` per §12), `GET /api/models/:hash`, `PATCH /api/models/:hash`
  (409 while unhashed), `GET /api/system/storage`.
- Tests: hashing of kilobyte-sized fake safetensors; re-hash skipped when
  unchanged and triggered on mtime change; backfill inserts the right
  `output_models` rows from sidecars with `hash: null`; reindex produces
  identical `output_models`; every route through HTTP.

### M7 — samples
- `samples/<model_hash>/` layout (§3), `samples` table, sidecar per sample
  in the §6.2 schema: dropped files get `params: {}` / `workflow: null` /
  `raw: null`; promotions get a full copy of the output's sidecar plus a
  hard link to its media.
- Routes: `POST /api/models/:hash/samples` (multipart upload only; the
  `{civitai_url}` body form returns 501 until Phase 3), `DELETE
  /api/samples/:id`, `POST /api/outputs/:id/promote {model_hashes[]}`,
  `PATCH … thumb_sample_id`.
- Tests: import by file sets kind/size from the bytes; promote to two
  models creates two rows hard-linked to one file; delete removes the row
  and the file but never the output it was promoted from; set-as-thumbnail
  updates `thumb_path` and the card.

### M8 — ETA from node timings
- On first launch after M8, seed `node_timings` from every sidecar's
  `timing.nodes`; update after each successful job (EWMA α = 0.3).
- `progress.ts`: weighted `pct` and `eta_ms` per §5.1, equal weights when
  a workflow has no rows.
- Tests: golden progress sequences with and without timings; seeding is
  idempotent.

### M9 — frontend
- **Models** screen and **Model detail** as in DESIGN.md §11.2 and mock
  frames 04/05, with the MOCK-REVISIONS changes (no multi-select, no
  "New family…", no Use in Generate, no Reveal). Unhashed models render
  with a `hashing` badge and disabled edits.
- Samples strip: drop zone and hover menu (Set as thumbnail, Delete). No
  URL field, no Fetch info button — leave the space, don't stub them.
- **Pickers**: LoRA and checkpoint pickers gain thumbnails, output count,
  last used, "added" state, family filter default + "Show all" (frame 09).
- **Gallery**: models filter popover grouped with counts and display
  names; MODELS chips link to model pages.
- **Viewer**: model rows are links; shift-click filters; **Promote to
  sample** opens the models popover restricted to the output's models.
- **Queue strip**: hashing / rescan progress in the status area.
- **Settings**: storage cards from `/api/system/storage`, Rescan button;
  everything else stays read-only.
- Enable the Models rail slot.
- Tests: component tests for the model card, header edit-in-place (blur
  commits, esc reverts, 409 while hashing surfaces as the badge), samples
  strip actions; e2e: scan → hash → open a LoRA page → filtered gallery
  shows the output that used it → promote an output → thumbnail set.

## Conventions carried forward (plus two new ones)

Everything in `AGENTS.md` and `IMPLEMENT-PHASE-1.md` still applies. In
addition:

- **Never block on hashing.** Pickers, generation and the gallery must work
  with zero hashed models. Anything that needs a hash degrades to a `path`
  identity or a disabled control, never to an error.
- **No outbound network at all in Phase 2.** The app makes no HTTP calls
  except to the local ComfyUI; Civitai arrives in Phase 3 behind explicit
  user actions.

## When to stop and ask

- The contract check disagrees with the fake in a way that changes the job
  pipeline (not just field names).
- `graphToPrompt()` is unreachable through the proxy.
- A model file type in the folders is not a safetensors/ckpt the hasher
  understands, and you would need a format-specific reader.