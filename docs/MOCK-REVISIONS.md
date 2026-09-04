# Mock revisions — round 2

Apply these to `ComfyUI Frontend Mocks.dc.html`. Everything not mentioned
stays as drawn. Reference spec: `DESIGN.md` (v1 decisions are final).

---

## 1. Global — every frame

**Remove**
- All keyboard-shortcut hints: ⌘1–⌘6 on rail tooltips, ⌘↵ on the Generate
  button, ⌥1–⌥3 on the tiles/table toggle. The only bindings in the app are
  ←/→/↑/↓ for thumbnail selection and `f` for fullscreen (Escape closes).
- Every ★ / favorite affordance: tile corner stars, table ★ column, viewer
  header star, "Favorited" action button, "Favorites" filter chip,
  "Favorites first" sort option. Favorites do not exist in v1.
- Every "Reveal in file manager" button. Copy-path / copy-on-click is the
  only file affordance anywhere.
- The batch stepper (`– 4 +`) beside Generate. One click of Generate is one
  job.
- The light-theme note. The app is dark only.

**Change**
- Wordmark: the project is **ForgeUI** — replace "TBD" in the expanded
  rail, and `~/.tbd/…` paths in FILES blocks and Settings become
  `~/.forgeui/…`.
- Rail icons (Lucide): Generate `pencil-sparkles` · Gallery `images` ·
  Models `brain` · Workflows `workflow` · ComfyUI `server` · Settings
  `settings`.
- Contrast floor: anything informational that is currently `#6e6e6e` or
  `#585858` (seed hint, "random each run", column headers, table meta,
  card meta) goes to ≥ `#8a8a8a`. Keep `#585858` for purely decorative
  marks only.
- Output identifiers: no `out-0231`-style ids anywhere. Tiles, badges and
  lineage nodes show the last 5 characters of the ULID plus index
  (`…ZM4T-0`); the viewer header shows the full id; FILES shows filenames.
- Model names: display name everywhere a model is named (viewer PARAMS
  rows included), filename only on the model page metadata line.
- Tile action overlay: shown on hover **and** persistently on the selected
  tile (the one in the centre view). Buttons are focusable.
- Queue strip states: while ComfyUI is starting, the strip's place shows a
  "ComfyUI starting…" indicator and Generate is disabled; when ComfyUI is
  disconnected the strip is not shown at all and Generate is disabled.
  Generate is also disabled while any required param is empty. Queued
  count chips in the strip are non-interactive.

**Bundled workflow set (final, must match everywhere it appears)**
Flux Krea 2 · Flux Krea 2 (img2img) · Illustrious XL · LTX Video · Anima ·
Flux Klein · Z-Image Turbo. Kontext Edit, Inpaint, Img2img refine,
Upscale 2× and LTX image-to-video are gone.

---

## 2. Frame 01 — Generate

- Remove the batch stepper; Generate button stands alone.
- Remove "Upscale image" from the **video** card's hover overlay (image
  outputs only).
- Header button: rename "Open in ComfyUI" to **Edit this workflow in
  ComfyUI**.
- Seed row: hint text at the new contrast floor. Behaviour note for the
  annotation: editing the field auto-locks to the typed value; `-1` always
  means random (field unlocks, hint returns); 🎲 unlocks and re-rolls.
- Reset to defaults annotation: restores manifest defaults for everything
  except text params (prompt, negative) and attached inputs.
- Keep one queued placeholder per job as drawn.

## 3. Frame 01b — Generate, focused output (redraw)

Adopt the Gallery viewer layout; the 252px session rail and the DETAILS bar
are gone:

- Left: params panel, unchanged, 360px.
- Centre: the output with Fit / 1:1, size+zoom chip, "following latest" /
  "pinned" chip, "newest" badge — as before.
- Right: the **metadata sidebar** from 02c (actions row, created, duration,
  PARAMS, FILES, INPUTS USED where applicable, LINEAGE). Collapsible via a
  chevron; collapsed it is a thin edge.
- Bottom: a **filmstrip** of this session's results (replaces the rail);
  running job keeps its progress treatment as a filmstrip tile. Collapsible
  via a chevron; collapsed it is a one-line count bar.
- Show one variant with both open, one with sidebar collapsed.
- Narrow-window note for the annotation: sidebar collapses first, then the
  media shrinks, params panel last; the filmstrip stays unless the user
  collapses it.

## 4. Frame 02 — Gallery tiles

- Show **only Flux Krea 2 outputs** (the filter bar says Krea 2); 02b keeps
  the mixed-family data.
- Sort menu: **Newest / Oldest** only. Remove Workflow, Model, Favorites
  first. Day dividers always apply.
- Remove the Favorites filter chip and tile stars.
- Models filter chips show display names (`Krea 2`, not `krea2`).
- Annotation: rows arrive flat and fast; per-day counts on the dividers are
  filled in a moment later from a separate call — fine if they pop in late.

## 5. Frame 02b — Gallery table

- Remove the ★ column.
- Rename **TIME → DURATION** and show generation wall-clock (`31.4s`), not
  clock time.
- SIZE cell for video outputs combines pixels and length: `1216×704 · 0:05`.
- Column headers are **not** sortable; drop that annotation.
- Sibling Krea 2 rows: seeds must be unrelated values, not
  `…096 / …095 / …094`.

## 6. Frame 02c — Gallery viewer

- Header: full ULID; remove the ★ and "14 of 4,812".
- Action row: remove "Favorited". Remaining: Edit in Generate →, Rerun now
  ⟳, Use image in workflow, Upscale image, Promote to sample, Delete.
- Delete behaviour (annotation): no confirmation; item disappears and an
  undo toast (~8s) restores it.
- PARAMS: checkpoint row shows the **display name** (filename on tooltip).
- **Remove the INPUTS USED block** from this frame (a t2i output has none).
- LINEAGE: children only for this output. Nodes are read-only metadata —
  id suffix + family from the sidecar (`…ZM4T-0 · flux`), "this" on the
  current node. No "edit"/category words. A deleted parent, when one
  exists, renders as a "?" orphan marker rather than a link.
- Sidebar and filmstrip both get a collapse chevron (same component as
  01b).

## 7. Frame 03 — Gallery empty

- Filter bar: remove the Favorites chip.
- Footer line: "7 bundled workflows ready"; align folder count with
  Settings (four folders listed).

## 8. Frame 04 — Models, LoRA tab

- No multi-select; remove any selection affordance from cards. SET FAMILY
  stays as the inline per-card control.
- Family chips are the hardcoded list: flux · sdxl · anima · ltx · z-image
  · unset.

## 9. Frame 05 — Model detail

- Remove **Use in Generate** from the header.
- Header edit-state figure: family combo lists only the hardcoded families
  plus "unset" — remove "New family…". Remove the bulk-set-family
  annotation.
- Samples strip annotation: imported Civitai/infotext data is stored as
  **raw** and shown read-only; imported samples have no Edit in Generate.
  Promoted-from-output samples behave like outputs.
- Sample hover menu: **Set as thumbnail** and **Delete** (Edit in Generate
  only on samples promoted from the app's own outputs).

## 10. Frame 06 — Workflows list

- Rows are exactly the seven bundled workflows above (Illustrious XL may
  keep its USER COPY badge as the example). Header count becomes
  "7 · 7 bundled, 1 user copy".
- ⋯ menu: **Delete only on user copies**; hidden for bundled rows.
  Bundled rows keep Open in ComfyUI · Duplicate · Reset to bundled (the
  last only when a user copy exists).

## 11. Frame 07 — Manifest editor

- The `loras` row is a synthetic **chain** row, not attributed to node
  `1 · CheckpointLoader`; label it "LoRA chain" with the binding summary.
  Header count "23 literal inputs" excludes it, and the "6 of 23 exposed"
  arithmetic must add up (size = 2 literal inputs in one row).
- Header for a bundled workflow: badge or note that **Save creates a user
  copy** (or show USER COPY once saved).
- "Open in ComfyUI" leads to the embedded editor with an app-owned
  **Save & return / Discard** toolbar above the iframe (see §14).

## 12. Frame 08 — Settings

- **Model folders**: display-only. Remove "+ Add folder" and the × per row;
  keep Rescan and the missing-folder red state. Annotation: edited in
  `config.yaml`, applied on app restart.
- **Data directory**: read-only path (copyable), no Browse/Reveal; keep the
  storage count cards. Annotation: set by `--data-dir` at launch.
- Remove "Reveal".
- Config file is `config.yaml` (not `.json`) wherever it is named,
  including the top-right "changes save immediately · config.yaml".
- Remove the Theme mention.
- In "Connect to a local URL" mode, **Restart ComfyUI** and **View log** are
  disabled (the app doesn't own the process).
- Sweep orphan inputs card stays as drawn (dry-run first).

## 13. Frame 09 — Menus

- **Use in workflow** popover lists only *Flux Krea 2 (img2img)* (`image ·
  prompt · denoise · flux`). Video outputs list nothing → button hidden.
- Remove "Reveal in file manager" from the file section; keep "Copy to
  clipboard".
- Add a fourth figure: **Promote to sample** popover — the same models
  popover, listing only the models this output used (checkpoint, then
  LoRAs), each checkable, with a confirm.
- Models filter: unchanged.
- LoRA picker: unchanged.

## 14. New frames to add

1. **Generate — Flux Krea 2 (img2img)**: the param panel with an `image`
   widget (attached thumbnail, hashed id, "from …ZM4T-0" provenance,
   replace/clear) and a `denoise` slider, as it looks after clicking
   **Upscale image** on an output: image attached, denoise preset to 0.4,
   size preset to 2× the source, prompt/seed/LoRAs prefilled from the
   source.
2. **Generate — `checkpoint` param widget**: a picker row (same popover
   family as the LoRA picker) for a workflow that exposes a checkpoint.
3. **Workflow picker popover** opened from the workflow card at the top of
   the param panel: grouped by family and kind, last-output thumbnails.
4. **Generate — Advanced section expanded** (negative, steps, cfg).
5. **Embedded ComfyUI screen**: the iframe with the app-owned toolbar above
   it — workflow name, **Save & return**, **Discard** — for the
   edit-this-workflow case; and the raw ComfyUI case with no toolbar.
6. **First run**: Settings with no ComfyUI path set and Generate disabled;
   queue strip showing "ComfyUI starting…"; and the disconnected state
   (strip absent, Generate disabled, error on the connection card).
7. **Drop-zone highlight** on the model page during a drag.
8. **Collapsed 6px queue bar**.
9. **Viewer for a derived output** (the result of the Upscale in frame 1
   above): this is where **INPUTS USED** (source thumbnail, hash, "from
   …ZM4T-0") and a parent node in LINEAGE appear, since they were removed
   from 02c.

## 15. Unchanged decisions worth restating in annotations

- One tiles / table toggle per media list, stored per screen.
- Per-job cancel exists only on Generate placeholders; the strip offers
  Clear queue and cancel-running only.
- Seed lock, LoRA linked-strength default, ratio presets — as drawn.
