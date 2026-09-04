# Mock review — `ComfyUI Frontend Mocks.dc.html` vs `DESIGN.md`

Reviewed all 11 frames plus the rail/menu figures and the annotation text in
the HTML. Items are grouped as requested. Each has a frame reference and a
suggested resolution. "Spec" means DESIGN.md after the DESIGN-CHANGES pass.

---

## A. Frontend inconsistencies with backend

Things the mocks show that contradict the spec, or contradict other frames.

1. **Filter bar vs. results (02).** Filter reads `Workflow: Flux Krea 2` and
   `Models: krea2 +1`, but the grid shows `ltx`, `sdxl` and `anima` outputs.
   Mock-data slip, but Claude Code will copy it as fixture data.
   **Decision:** show only Krea 2 outputs in this frame; the table view (02b,
   unfiltered) already demonstrates mixed families.

2. **Checkpoint shown by filename in the viewer (02c).** PARAMS lists
   `krea2.safetensors`, while §8.1 now says display name renders everywhere
   including viewer model links. Should read the display name with the
   filename on hover/tooltip.

3. **Krea 2 output has "INPUTS USED" (02c).** The output is from the Krea 2
   t2i workflow, whose manifest has no `image` param, yet the sidebar shows
   `ref.png … from out-0184` and a parent in LINEAGE.
   **Decision:** drop the INPUTS USED block from this frame. LINEAGE stays but
   shows children only, labelled per D.7 (`…suffix · flux`); a t2i output
   has no parent.

4. **Upscale / edit workflows exist in the menu but not in the Workflows
   list (06 vs 09).** The use-in-workflow popover lists *Kontext Edit, Inpaint
   (mask), Img2img refine, Upscale 2×, LTX image-to-video*; the Workflows
   screen lists only Kontext Edit.
   **Decision:** the bundled set, identical in frames 06/09 and §4.6, is:
   Flux Krea 2 · Flux Krea 2 (img2img) · Illustrious XL · LTX Video · Anima ·
   Flux Klein · Z-Image Turbo. Kontext Edit, Inpaint, Upscale 2× and LTX i2v
   are dropped (can be added later as user workflows). The use-in-workflow
   popover therefore lists only *Flux Krea 2 (img2img)*. **Upscale image** is
   not a separate workflow: it selects the same-family workflow with
   `category: img2img`, attaches the image, presets `denoise` to 0.4 and size
   to 2× the source (snapped to a multiple of 16). See §4.6/§10.

5. **"Reveal in file manager" contradicts itself.** 02c annotation says the
   FILES block deliberately has *no* "open in file manager" action; 09's
   popover and 08's Data directory both offer **Reveal in file manager**.
   **Decision:** remove every "Reveal in file manager" button (09 popover,
   08 Data directory). Copy path / copy-on-click is the only file affordance.

6. **Output identifiers are three different things.** Tiles show
   `out-0231.png`, the viewer header shows `OUTPUT 01JBX7…-0`, and FILES
   shows `01JBX7QK9ZM4T-0.png`. The spec's id is `<ulid>-<n>`.
   **Decision:** see D.6 — ULID suffix in badges, full id in the viewer
   header, filename in FILES; no `out-NNNN` ids anywhere.

7. **Manifest editor attributes `lora_list` to a node (07).** The row reads
   `1 · CheckpointLoader · MODEL / CLIP chain`. `lora_list` is a graph rewrite
   (§4.4), not an input of node 1; the row should be a synthetic "chain"
   row, and the header count "23 literal inputs" should not include it.
   Likewise `size` collapses two literal inputs into one row, so the
   "6 of 23 exposed" arithmetic doesn't add up.

8. **Editing a bundled workflow (07).** Header says `krea2 · bundled` while
   editing. §4.6: editing copies to `workflows/user/` first. The editor
   should say that Save will create the user copy (or already show USER
   COPY).

9. **Batch seeds look sequential (01/02b).** Seed field is locked at
   `774312096`; table shows sibling outputs at `…095`, `…094`, `…088`. That
   implies A1111-style `seed+i` per batch item. **Decision:** the batch
   count is dropped from the UI and API (one Generate click = one job), so
   there is no batch seed policy; remove the `– 4 +` stepper from frames
   01/01b and fix the sibling seeds in 02b to be unrelated values.

10. **Delete on bundled rows (06).** The ⋯ menu offers Delete on every row.
    A bundled workflow can't be deleted (it comes back on upgrade); only a
    user copy can. Delete should be hidden for `source: bundled`.

11. **Data directory is an editable field (08).** Changing the data dir at
    runtime means moving `app.db`, outputs, inputs, samples — a migration,
    not a setting. Spec treats it as fixed.
    **Decision:** static. Show the path read-only (copyable) with the storage
    counts; it is set by `--data-dir` / env var at launch and never editable
    in the UI.

12. **Model folders "written on save" (08).** Annotation says the list is
    written to `extra_model_paths.yaml` on save, but the page has no save
    button. Also, ComfyUI reads that file at startup, so a folder change
    needs a ComfyUI restart to take effect. **Decision:** the folder list is
    display-only in Settings — no "+ Add folder", no × per row. Folders are
    edited in `config.yaml` and applied by restarting the app. Rescan stays.

13. **Favorites (01b, 02, 02b, 02c).** ★ appears on tiles, the table, the
    viewer header and as an action, with a Favorites filter and
    "Favorites first" sort. **Decision:** dropped from v1 entirely — remove
    every ★, the filter chip and the sort option.

14. **Frame 03 counts.** "41 models found in 3 folders" while Settings lists
    four folders (one missing). Trivial; align the numbers.

---

## B. Frontend that needs backend additions

Things the mocks rely on that the schema/API don't provide yet. Suggested
additions in brackets.

1. **Per-model derived stats.** Cards, the picker and the models filter show
   output count and "last used 4m ago" per model. Computable from
   `output_models ⋈ outputs`, but it's on every card and popover row.
   [Add `models.output_count` and `models.last_used_at`, maintained on
   output insert/delete and on reindex; `GET /api/models` returns them.]

2. **Families as a vocabulary.** The family combo lists families with counts
   plus "New family…". **Decision:** families are a hardcoded list in the
   app (`flux`, `sdxl`, `anima`, `ltx`, `z-image`), no CRUD. [`GET
   /api/families` → `[{id, model_count, workflow_count}]`; the combo drops
   "New family…" and offers only the hardcoded ids plus "unset".]

3. **Set as thumbnail from a sample.** [`PATCH /api/models/:hash`
   `{thumb_sample_id}` or `POST /api/models/:hash/thumbnail`.]

4. **Sample delete / hover menu.** [`DELETE /api/samples/:id`.]

5. **Lineage.** Sidebar shows parents *and* children. Children require a
   reverse lookup through `inputs.derived_from_output → output_inputs`.
   [`GET /api/outputs/:id/lineage` → `{parents[], children[]}` with each
   family from each output's sidecar.]

6. **Retry a failed job.** "Retry resubmits the same api_graph", but failed
   jobs have no output/sidecar and `jobs` stores only `params_json`.
   [Store `api_graph_json` on `jobs`; `POST /api/jobs/rerun` accepts
   `{job_id}` as well as `{output_id}` — same submission path, different
   source of the frozen graph. No separate retry route.]

7. **Clear queue.** [`POST /api/jobs/clear` (cancels all queued).]

8. **Progress shape.** Running card shows `KSampler · step 12/28 · node 3
    of 7 · 41% · 0:18 ETA`. [Pin `progress_json` as
    `{pct, eta_ms, node_id, node_label, node_index, node_total, step, max}`.]

9. **Streaming previews.** ComfyUI sends binary preview frames on its WS;
    the app must relay them. **Decision:** push, not poll — relayed as
    binary frames on the app's `/ws`, prefixed with the job id; no preview
    HTTP route.]

10. **System status.** Queue strip shows connection state and free VRAM;
    Settings shows pid/uptime, Restart, View log; strip shows "Hashing
    models · 6 of 41" and rescan progress. [`GET /api/system/status` (comfy
    running, pid, uptime, VRAM from ComfyUI `/system_stats`),
    `POST /api/system/comfy/restart`, `GET /api/system/comfy/log`,
    WS events `hashing_progress`, `rescan_progress`.]

11. **Storage stats.** Data directory card shows counts and sizes for
    outputs/inputs/samples/db. [`GET /api/system/storage`.]

12. **Config read/write.** No config route exists, and the spec never said
    how settings exist *before* first run. **Decision** (now §3.1): the data
    dir is the only bootstrap setting (`--data-dir` / `FORGEUI_DATA_DIR`);
    everything else lives in `<data-dir>/config.yaml`, hand-editable before
    first launch, written by Settings on blur, and overridable per-run by
    CLI flags. Not SQLite — the DB sits inside the data dir and is a
    rebuildable index. [`GET/PATCH /api/config` reads/writes `config.yaml`;
    UI-only prefs (rail state, tile size, details open) go under a `ui`
    key in the same file.]

13. **Model folders per kind.** Settings keys folders by
    checkpoints/loras/vae/controlnet; spec had a flat list.
    [`config.model_folders: {kind: [path]}` in `config.yaml`, read at
    launch, `extra_model_paths.yaml` generated from it; not writable via
    `PATCH /api/config`.]

14. **Dry-run sweep** (08, Maintenance → Sweep orphan inputs card: "would
    delete 14 files · 96 MB", Preview again / Delete 14 files).
    [`POST /api/maintenance/sweep-inputs {dry_run: bool}` →
    `{count, bytes, files[]}`; `dry_run: true` feeds the preview.]

15. **Workflow list needs derived fields.** Thumb of most recent output,
    last used, source, USER COPY. [`GET /api/workflows` returns
    `last_job_at`, `last_output_id`, `source`, `has_user_copy`.]

16. **Workflow CRUD.** Import .json, New in ComfyUI, Duplicate, Reset to
    bundled, Delete. [`POST /api/workflows` (`{ui_json}` or empty),
    `POST /api/workflows/:id/duplicate`, `DELETE /api/workflows/:id`
    (user copies only), `POST /api/workflows/:id/reset`.]

17. **Manifest editor input inventory.** The table lists every literal input
    of `api.json` with current values. [`GET /api/workflows/:id/inputs` →
    `[{node_id, node_type, node_title, input, value, type_hint}]`.]

18. **Day dividers and counts.** "TODAY · 18 outputs", "4,812 outputs",
    "14 of 4,812". Per-day counts under the active filters, a total, and the
    position of an item in the filtered set. **Decision:** the list stays
    flat and fast — `GET /api/outputs` returns rows only, no rollups; the
    client inserts day dividers from `created_at` as it renders. Counts come
    from a separate, lazily called `GET /api/outputs/days?filters&dates=…`
    → `[{date, count}]` for just the days on screen, filled in after the
    fact (a second late is fine). The header total is
    `GET /api/outputs/count?filters`, also lazy. "14 of 4,812" is dropped —
    exact rank under keyset pagination is a full scan.]

19. **Gallery `sort`** is `newest|oldest` only; no extra indexes.

20. **Upscale routing.** Needs `category` and `family` on `GET /api/workflows`
    plus the output's family and size to resolve the target and preset
    `denoise`/`size` client-side. **Done:** §10 states resolution is
    client-side and §12's `GET /api/workflows` lists `category`/`family`;
    no upscale-specific route.

21. **Base resolution for ratio presets.** Client needs it per workflow.
    [Manifest `size.default` + optional `size.step`, per §15 Q4.]

22. **Civitai import target.** "Imported infotext maps onto workflow params"
    — the mapper would need to know *which* workflow. **Decision:** no
    mapping in v1; imported infotext is stored as `raw` in the sample
    sidecar and displayed read-only. Frame 05's annotation should say so,
    and imported samples get no Edit in Generate action. [No API change.]

23. **Promote to sample target.** See D.3. [`POST /api/outputs/:id/promote
    {model_hashes[]}` — one sample row per hash, hard-linked media.]

---

## C. Broken and poorly designed UI

1. **⌘1–⌘6 are browser tab shortcuts.** Chrome, Firefox and Safari reserve
   ⌘1–⌘9 (Ctrl on Windows/Linux) for tab switching and most will not let a
   page override them; ⌥1–⌥3 type `¡ ™ £` on macOS. **Decision:** no
   screen-switching, generate (⌘↵) or view-toggle (⌥1–3) shortcuts at all.
   The only bindings are arrow keys for thumbnail navigation and `f` for
   fullscreen (Escape closes), declared in `config.yaml` under `keys`
   (§11.4). Remove the ⌘/⌥ hints from the rail tooltips, the Generate
   button and the view toggle in every frame.

2. **Contrast.** Secondary text at `#6e6e6e` and `#585858` on `#191919`/
   `#1e1e1e` is ~2.6:1 and ~1.9:1 — well below WCAG AA (4.5:1) and below the
   3:1 large-text floor. The mock's own annotations are barely legible in
   the screenshots. Raise the floor for anything informational (seed hint,
   "random each run", column headers, table meta) to ≥ `#8a8a8a`; keep
   `#585858` for truly decorative marks only.

3. **Icon-only rail with abstract glyphs.** Square/diamond/grid/circle/lines
   don't read as Generate/Gallery/Models/Workflows/ComfyUI/Settings.
   **Decision** (Lucide): Generate `pencil-sparkles` · Gallery `images` ·
   Models `brain` · Workflows `workflow` · ComfyUI `server` · Settings
   `settings`. Recorded in §11.1. (If `pencil-sparkles` is missing from the
   pinned lucide version, fall back to `wand-sparkles`.)

4. **No way to cancel one queued job from Gallery.** Queue placeholders were
   removed from Gallery and the strip collapses queued jobs into per-workflow
   count chips, so from Gallery/Models/Workflows the only queue action is
   *Clear queue*. **Decision:** accepted as-is; per-job cancel lives only on
   the Generate page. The strip's count chips stay non-interactive.

5. **Queued placeholders take grid slots (01).** With a few queued that's
   fine; with twenty the session grid is twenty dashed tiles. **Decision:** keep
   one placeholder per queued job for now and see how it feels — the wall
   of tiles is an honest signal of how much has been queued. Revisit after
   use; a "+N queued" collapse is the fallback.

6. **Hover-only action overlay on tiles.** Keyboard users and touchpads
   without hover can't reach Edit/Rerun/Use/Upscale from the grid.
   **Decision:** the action overlay is shown on hover *and* persistently on
   the selected tile (the one displayed in the centre view). Its buttons are
   real focusable elements, so once a tile is selected each action is
   reachable by Tab. No extra shortcuts or context menu needed.

7. **Reset to defaults has no undo.** It wipes the prompt with one click,
   next to the workflow card people click to switch workflows.
   **Decision:** Reset to defaults restores manifest defaults for every
   param *except* `text` params (prompt, negative) and attached inputs —
   the things the user authored. Clearing the prompt is one select-all away;
   no undo infrastructure needed.

8. **Delete with no confirmation and undefined lineage effect.** Outputs are
   soft-deleted (`deleted_at`), which makes undo possible.
   **Decision:** no confirmation modal; Delete removes the tile immediately
   and shows an undo toast (~8s) that clears `deleted_at`. Files are removed
   from disk only when the undo window closes. When a deleted output is a
   parent of others, lineage shows it as an orphan marker ("?") rather than
   a link; the input store keeps the bytes while any child references them.

9. **Two near-identical viewer layouts.** Generate-focused (details in a
   collapsible bar under the media) and Gallery viewer (details in a right
   sidebar). Same component, different placement, different affordances.
   **Decision:** one viewer layout. Generate's focused view (01b) adopts the
   Gallery viewer: params panel left, media centre, metadata sidebar right,
   filmstrip bottom (the session's results, replacing the 252px session
   rail). Both the sidebar and the filmstrip are collapsible with persisted
   state. Frame 01b needs redrawing; the DETAILS bar goes away.

10. **Table view lacks kind and duration columns (02b).** Video is only
    inferable from a badge on a 32px thumb; the sort-by-size column shows
    pixels only. **Decision:** rename the TIME column to DURATION (wall-clock
    generation time from the sidecar, e.g. `31.4s`), and for video outputs
    the SIZE cell combines pixels and length (`1216×704 · 0:05`). Creation
    clock-time leaves the table (it's in the viewer; day dividers and sort
    already order rows by it).

11. **No min-width / responsive rules.** Desktop-only is fine.
    **Decision:** below the comfortable width, the metadata sidebar collapses
    first, then the media centre shrinks; the params panel (with the prompt)
    is the last thing to give. The filmstrip is horizontal and stays;
    the user can collapse it manually. No further breakpoints.

12. **Seed field semantics are easy to get wrong.** If a user types a seed
    while unlocked, does the run use it or re-roll? **Decision:** editing
    the field auto-locks the seed to the typed value; typing `-1` means
    random in all cases (field unlocks, hint returns). 🎲 unlocks and
    re-rolls. Recorded in §11.3.

13. **Models-grid multi-select (05 annotation).** The only bulk action in
    the app was "select several cards, then Set family".
    **Decision:** no bulk edits in v1. Remove the multi-select from the
    Models grid; family is set per card via the inline SET FAMILY control or
    filled by "Fetch info from Civitai". Gallery has no selection model
    either; bulk delete can come later with one shared selection
    model for both screens.

14. **Missing states that will get invented ad hoc.** **Decisions** (now in
    §11.3): ComfyUI disconnected → queue strip not shown, Generate disabled;
    ComfyUI starting up → an indicator in the strip's place, Generate
    disabled; any required param empty → Generate disabled. Light theme is
    dropped entirely. `mask` / `video` / `enum` / `bool` widgets are not
    mocked (obvious or later).
    **Still to mock:** the `image` + `denoise` widgets in the panel (Flux
    Krea 2 (img2img) exposes them and no frame shows it), a `checkpoint`
    picker widget, the workflow picker popover (from the card), the Advanced
    section expanded, first run with no ComfyUI path set, the embedded
    ComfyUI screen, drop-zone highlight, and the collapsed 6px queue bar.

---

## D. Ambiguous UI instructions

Each needs a decision before Claude Code starts; a proposed default follows.

1. **"Use in Generate" on a model page (05).** Which workflow would it
   target, and what would it mean for a checkpoint? **Decision:** drop the
   button from the model page header for v1; the LoRA picker's search
   matches display name / filename / tag, so pasting the name into Generate
   is the path.

2. **"Sort: Model" (02).** An output has a checkpoint and 0–n LoRAs.
   The mock's sort menu (02) offers Newest / Oldest / Workflow / Model, and
   02b says column headers sort. **Decision:** sort is `created_at` only
   (Newest / Oldest); remove Workflow/Model from the menu and make table
   headers non-sortable. Day dividers therefore always apply.

3. **"Promote to sample" target.** An output used a checkpoint and two LoRAs.
   **Decision:** reuse the models popover from frame 09 (the same
   multi-select component as the gallery models filter), listing only the
   models this output used, checkpoint then LoRAs, each checkable; confirm
   promotes to every checked model.

4. **"Open in ComfyUI" in the Generate header (01).** Opens the current
   workflow's `ui.json` in the editor, or just the ComfyUI tab? There is
   also a ComfyUI rail item. **Decision:** header button = "Edit this
   workflow in ComfyUI"; rail item = raw ComfyUI. Returning does not depend
   on ComfyUI's own Save (unreachable cross-origin): ComfyUI is proxied under
   the app origin and the embedded editor gets an app-owned toolbar with
   **Save & return** / **Discard** that reads ui+api JSON out of the frame
   and navigates back (§4.1, §11.2 ComfyUI screen).

5. **Upscale for videos.** "Upscale image" appears on the video card hover
   in 01. **Decision:** hidden for video outputs in v1 (only image outputs
   get the button); remove it from the video card's hover overlay in 01.

6. **Human-readable output ids.** `out-0231` vs ULID (A.6). **Decision:** no
    second id. Badges and lineage nodes show the last 5 chars of the ULID
    (`…ZM4T-0`), the viewer header shows the full id, FILES shows the
    filename. Replace every `out-0231`-style label in the frames.

7. **Lineage node labels (02c).** **Decision:** lineage is plain read-only
    metadata: each node shows the id suffix and the family read from that
    output's own sidecar (`…ZM4T-0 · flux`), with "this" marking the current
    output. No "edit"/category labels.

8. **Families and "New family…".** **Decision:** hardcoded family list
    (see B.2); the system attaches no behaviour to a family, it is only a
    matching key between workflows and models. Remove "New family…" from
    the combo in frame 05.
