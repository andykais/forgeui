# Design proposal — one model picker for every kind of model

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §4.3, §4.4, §6.2, §7, §8.1, §8.2, §11.2, §12.
**Premise being revised:** §8.2 ("Model switching — solved by construction ...
choosing a model = choosing a workflow").

---

## 1. The problem

SwarmUI has one *Model* dropdown. Everything that can drive a generation —
whatever sits in `checkpoints/`, `Stable-Diffusion/`, `diffusion_models/`,
`unet/` — appears in it, and picking one is all the user does. SwarmUI can do
that because it owns the graph: it classifies the file, then *generates* a
graph with the right loader wired in.

ForgeUI is workflow-first, and that is what makes this hard. Two separate
couplings stand in the way.

**Coupling A — a model's kind is the folder it was found in.** `ModelScanner`
stamps `kind` with the `config.yaml` key its folder was listed under
(`src/models/scan.ts`), and `DEFAULT_MODEL_KINDS` is
`checkpoints | loras | vae | controlnet` (`src/config/defaults.ts`). So a file
in `diffusion_models/` and a file in `checkpoints/` are, to every part of the
app, two unrelated kinds of thing. The picker asks for one kind
(`api.modelsOfKind("checkpoints")` in `stores/app.svelte.ts`) and gets one
folder's worth. `ENUM_SOURCES` is that same closed four-value list.

**Coupling B — a `checkpoint` param is a scalar bound to one node input.**
`{ "type": "checkpoint", "bind": "1.ckpt_name" }` writes a filename into node
`1`. That only works if node `1` stays a `CheckpointLoaderSimple`. It cannot
express "this model needs a `UNETLoader` instead", and the two are not
interchangeable: an all-in-one checkpoint carries MODEL + CLIP + VAE, a bare
diffusion model carries MODEL only and needs separate text encoders and a VAE
beside it. Compare the two bundled shapes:

```
sd15, illustrious, anima, z-image-turbo
  1  CheckpointLoaderSimple {ckpt_name}          → MODEL, CLIP, VAE

krea2, krea2-img2img, flux-klein
  1  UNETLoader     {unet_name, weight_dtype}    → MODEL
  2  DualCLIPLoader {clip_name1, clip_name2}     → CLIP
  4  VAELoader      {vae_name}                   → VAE
```

Swapping a model across that line is a change of *graph topology*, not of a
string. A scalar `bind` cannot do it, which is why every bundled workflow
today hardcodes its loader and exposes no model param at all.

So: fixing the taxonomy alone gets a picker that lists everything and then
wires half of it wrong. Both couplings have to go.

## 2. What we keep

- The graph stays authored in ComfyUI and committed as a file. We do not
  generate graphs the way SwarmUI does.
- The manifest stays the only thing the Generate panel reads (§4).
- Pickers keep working with **zero hashed models** — the standing rule in
  AGENTS.md. Everything below has an answer available at scan time.
- We never write inside a model folder, and never download at runtime.

The precedent for all of this already exists: `lora_list` is a param whose
`bind` is not a scalar but a **chain**, and whose application is a graph
rewrite that splices nodes in and rewires their consumers (§4.4,
`spliceLoras` in `src/workflows/rewrite.ts`). A model param is the same idea
applied to the head of the graph instead of the middle.

## 3. The design in one paragraph

Three layers, each useful on its own.

1. **Class** — a taxonomy above `kind`. Many folder kinds map onto one class;
   `diffusion` is the grab bag the user wants to search. Fixes coupling A.
2. **Packaging** — what a `diffusion` file actually contains: `full`
   (MODEL+CLIP+VAE) or `diffusion_only` (MODEL). Detected from the file, not
   from its folder, with a folder-based answer available immediately.
3. **The `model` param** — a param type whose `bind` names a **loader slot**
   (who consumes MODEL, who consumes CLIP, who consumes VAE) rather than a
   node input. At submit time the rewrite builds whichever loader subgraph the
   chosen model's packaging calls for and rewires the slot's consumers onto
   it. Fixes coupling B.

---

## 4. Layer 1 — model class

`kind` stays exactly what it is: the `config.yaml` key, which is also the
`extra_model_paths.yaml` key ComfyUI resolves names against
(`src/config/extra_model_paths.ts`). It must not change.

A new derived field `class` sits above it:

| class | default kinds |
|---|---|
| `diffusion` | `checkpoints`, `Stable-Diffusion`, `diffusion_models`, `unet` |
| `lora` | `loras`, `lycoris` |
| `vae` | `vae`, `vae_approx` |
| `clip` | `clip`, `text_encoders`, `clip_vision` |
| `controlnet` | `controlnet` |
| `upscale` | `upscale_models` |
| `embedding` | `embeddings` |
| `other` | anything else |

`config.yaml` gains an override map so a custom folder key lands in the right
class:

```yaml
model_folders:
  checkpoints:       [/models/checkpoints]
  Stable-Diffusion:  [/models/Stable-Diffusion]
  diffusion_models:  [/models/diffusion_models]
  unet:              [/models/unet]
  text_encoders:     [/models/text_encoders]
  vae:               [/models/vae]
model_classes:
  my_weird_folder: diffusion     # kind → class; overrides the table above
```

`DEFAULT_MODEL_KINDS` grows to cover the table (all empty by default, so no
existing install changes behaviour). `ENUM_SOURCES` widens from the four
hardcoded kinds to *any class name or any configured kind* — a manifest can
say `"source": "diffusion"` (class) or `"source": "text_encoders"` (kind).

`GET /api/models` gains `?class=`, alongside the existing `?kind=`. That one
endpoint is the "giant grab bag": `GET /api/models?class=diffusion&q=flux`
returns everything from all four folders, in one list, ranked by the same
substring match §12 already specifies.

**This alone is the visible win** — one search box over every model folder —
and it is a small change. Layers 2 and 3 are what make the result *work* when
you pick from it.

## 5. Layer 2 — packaging and architecture

For a `diffusion` model we need to know which loader it wants. Three sources,
best answer wins:

1. **User override.** A `packaging` field on the model page, next to `family`.
   Always wins. This is the escape hatch that makes the other two tiers safe
   to get wrong.
2. **Header probe.** A `.safetensors` file starts with a u64 little-endian
   header length followed by a JSON blob of tensor names and shapes. Reading
   it costs one `open` plus one short read (typically well under a megabyte,
   a few at worst) — nothing next to the full-file sha256 the hasher already
   does. The tensor names classify the file:
   - `first_stage_model.*` and `cond_stage_model.*` present → `full`
   - only `model.diffusion_model.*`, or Flux's `double_blocks.*` /
     `single_blocks.*` → `diffusion_only`
   The same names give the **architecture** (`sd15`, `sdxl`, `flux`, `ltx`,
   `z-image`, …), which maps straight onto the existing hardcoded `FAMILIES`
   list. That is a bonus worth having on its own: §8.1 currently infers family
   only from Civitai, and every scanned model starts `unset`. This gives an
   offline answer with no network and no "Fetch info" click.
3. **Folder heuristic.** `diffusion_models` / `unet` → `diffusion_only`;
   `checkpoints` / `Stable-Diffusion` → `full`. Available the instant a file
   is scanned, which is what keeps the picker honest before any probe or hash
   has run.

`.ckpt` is a pickle and cannot be probed cheaply — it falls back to the folder
heuristic. `.gguf` has its own header format and is in practice always
diffusion-only, but loading one needs a custom node (`UnetLoaderGGUF`); until
custom-node support exists, a `.gguf` is listed but marked unswappable, with
the reason shown in the picker rather than as a ComfyUI failure later.

**Where it is stored.** Detection is derived and path-shaped; user metadata is
editable and hash-shaped. They go in different places, matching the existing
split:

```sql
-- derived, rebuildable, keyed by path, invalidated on size/mtime change
CREATE TABLE model_probes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  packaging TEXT,          -- full | diffusion_only | unknown
  arch TEXT,               -- flux | sdxl | sd15 | ... | NULL
  probed_at INTEGER NOT NULL
);

-- models: user metadata, keyed by hash, as today
ALTER TABLE models ADD COLUMN packaging TEXT;       -- user override, NULL → detected
ALTER TABLE models ADD COLUMN companions_json TEXT; -- §6
```

The probe runs as its own pass over newly scanned files — before hashing, not
after, since it is cheap and its answer is needed in the picker. Like hashing,
it must never block anything and a failed read must never stop the rest.

`ModelView` gains `class`, `packaging` and `packaging_source`
(`user | probe | folder`), so the UI can show *why* a model is treated the way
it is.

## 6. Layer 3 — the `model` param and the loader-slot rewrite

A new param type. Its `bind` describes a **slot**: the set of graph inputs that
consume this model's outputs.

```json
{
  "key": "model",
  "label": "Model",
  "type": "model",
  "filter": { "class": "diffusion", "family": "flux" },
  "default": "flux1-krea-dev.safetensors",
  "bind": {
    "slot": {
      "model_to": ["3.model"],
      "clip_to":  ["6.clip", "7.clip"],
      "vae_to":   ["8.vae"],
      "clip_type": "flux"
    }
  }
}
```

`clip_to` / `vae_to` are optional and may be `null` for a workflow whose CLIP
or VAE genuinely comes from somewhere else.

At submit time, `applyParam` gets a `case "model"` beside the existing
`case "lora_list"`, calling a new `spliceModel` that mirrors `spliceLoras`:

1. Resolve the picked model to its `name` (the folder-relative name ComfyUI
   binds to) and its effective `packaging`.
2. Build the loader subgraph, allocating ids with the existing `nextNodeId`:
   - **`full`** — one `CheckpointLoaderSimple { ckpt_name }`; MODEL, CLIP and
     VAE all come off it.
   - **`diffusion_only`** — `UNETLoader { unet_name, weight_dtype }` for MODEL,
     plus a `CLIPLoader` / `DualCLIPLoader` and a `VAELoader` for the
     companions resolved in §7.
3. Rewire every entry in `model_to` / `clip_to` / `vae_to` onto the new nodes
   with the existing `setScalar`.
4. Record the mapping *old loader node → new loader node* for §8.

The rewrite **never deletes a node**. It only adds and rewires. The loaders the
graph shipped with are simply left unreferenced.

**A general prune pass closes the loop.** `rewriteGraph` gains a final step:
walk backwards from `manifest.outputs` and drop every node nothing reaches.
ComfyUI would not execute an orphan anyway, but two things here care:
`collectModels` (`src/jobs/models.ts`) walks *every* node, so without the prune
a discarded `UNETLoader` would put a model that was never loaded into the
sidecar's `models` block and into `output_models`; and a stale placeholder
filename in an orphan is a validation risk we simply do not need to reason
about. Making the prune a general post-pass — rather than making the swap
responsible for deciding what is safe to delete — keeps the swap trivial and
fixes a latent sharp edge for hand-authored graphs at the same time.

## 7. Companions — CLIP and VAE for a diffusion-only pick

Picking a bare diffusion model leaves three questions open: text encoder(s),
VAE, and `weight_dtype`. Resolved in this order, first hit wins:

1. **The model's own recorded companions** (`models.companions_json`:
   `{clip: [...], vae: ..., weight_dtype: ...}`). Editable on the model page,
   and offered to be remembered the first time a generation with that model
   succeeds. This is what makes an arbitrary pick work in a graph whose
   companions were wrong for it.
2. **What the graph already has.** If the workflow's existing slot already
   supplies CLIP and VAE and the arch matches the picked model's, keep them
   and change only the diffusion filename. This is the common case — swapping
   one Flux unet for another in `krea2` — and it asks the user for nothing.
3. **A family default**, derived from what is actually in the configured
   folders (family `flux` → a `t5xxl*` plus a `clip_l*`, plus `ae.safetensors`).
4. **Fail, in the picker.** If nothing resolves, the model is listed but
   annotated — "needs a text encoder" — and selecting it surfaces a param
   validation error naming exactly what is missing. This is a `ParamError` at
   coerce time, before submission, not a ComfyUI failure two minutes later.

Rule 4 is the one that matters most for the feel of the feature: the picker is
permissive like SwarmUI's, but it never lets you queue something it already
knows cannot wire up.

## 8. Interaction with the LoRA chain

`lora_list` binds `model_from: "1.MODEL"`, `clip_from: "1.CLIP"` — hardcoded
references to the very nodes the swap replaces. Two things handle this:

- **Order.** The model swap runs before the LoRA splice. `rewriteGraph`
  currently applies params in manifest order; it gains an explicit phase order
  (`model` → scalars → `lora_list` → outputs → prune) so this does not depend
  on how a manifest happens to be written.
- **Remapping.** The swap's old→new node map is applied to any chain reference
  that pointed at a replaced loader. `"1.MODEL"` in an existing manifest keeps
  working and follows the swap automatically — **no bundled manifest needs
  editing.**

For manifests authored from here on, a chain may also name the slot
symbolically:

```json
"model_from": "@model.MODEL",   "clip_from": "@model.CLIP"
```

where `model` is the key of the `model` param. Explicit, and immune to node
renumbering. The `@key.OUTPUT` form is a small addition to `parseBind`; plain
`node.OUTPUT` stays valid.

## 9. Reproducibility

§6.1 makes the sidecar authoritative, so the swap must not make a job
un-replayable. It does not: `collectModels` runs on the **final, rewritten,
pruned** graph, so `models[]` already records the loaders that actually ran,
with the right `role` (`checkpoint` for a full pick, `unet` + `clip` + `vae`
for a diffusion-only one). No change to the sidecar's `models` block.

One change is needed. Replaying a job's `params` re-runs companion resolution,
and a user who edits a model's companions in between would get a different
graph from the same params. So a `model` param's **stored value is the resolved
set**, not the bare name:

```json
"model": {
  "name": "flux1-krea-dev.safetensors",
  "packaging": "diffusion_only",
  "clip": ["t5xxl_fp16.safetensors", "clip_l.safetensors"],
  "vae": "ae.safetensors",
  "weight_dtype": "default"
}
```

Submitting accepts either a bare string (resolve now) or the full object
(replay exactly). Reuse Parameters and `POST /api/jobs/rerun` both stay exact.
This is an additive shape change to §6.2's `params` and must land in DESIGN.md
before any code.

## 10. UI

- **One `ModelPicker` component**, on the existing 326px popover (§11.3 already
  wants one popover component for the LoRA picker, the models filter, the
  use-in-workflow menu and promote-to-sample — this is the same one, taking a
  class filter). Search box, thumbnail + display name rows, family badge.
- **Grouped by compatibility, not hidden by it.** Models matching the
  workflow's `family` come first; the rest sit under an "Other models" divider,
  selectable but flagged. This is the SwarmUI-ish permissiveness the request is
  really asking for, with the existing family filter kept as the default sort
  rather than a hard gate. "Show all" already exists for the LoRA picker
  (§11.4) and behaves the same way here.
- A row for a model that cannot be wired shows the reason inline
  ("needs a text encoder", "GGUF needs a custom node") and is not selectable.
- The **model page** gains `packaging` (with its detected value and source
  shown when it is not overridden) and a companions editor, both beside the
  existing `family` field.

## 11. Migration and compatibility

Nothing breaks, and nothing has to be edited in one go:

- `checkpoint` stays a valid param type, treated as a `model` param with
  `filter.class = "diffusion"` and a scalar bind — a filename swap with no
  topology change, exactly what it does today. It is documented as superseded.
- Existing manifests, including all eight bundled ones, keep working
  untouched; §8's remapping covers their LoRA chains.
- `model_folders` defaults grow, all empty. Existing `config.yaml` files are
  unaffected; the new folders only matter once a user points them somewhere.
- `model_probes` is derived and rebuildable — `deno task reindex` and Rescan
  both repopulate it, in keeping with "the database is a derived index".

## 12. Suggested order of work

Each step is independently shippable and independently useful.

| # | Step | Result |
|---|---|---|
| 1 | Class taxonomy: `model_classes` config, `class` on `ModelView`, `?class=` on `GET /api/models`, widened `ENUM_SOURCES`, wider folder defaults | one search box over every model folder |
| 2 | The general prune pass in `rewriteGraph` + explicit param phase order | latent sharp edge closed; prerequisite for 4 |
| 3 | Safetensors header probe: `model_probes`, packaging + arch detection, the family it fills in for free | models stop being `unset`; packaging known |
| 4 | The `model` param and `spliceModel`, with old→new remapping and `@key.OUTPUT` binds | topology-crossing swaps work |
| 5 | Companion resolution + `companions_json` + the picker's un-wireable annotations | arbitrary picks work, and fail early when they can't |
| 6 | `ModelPicker` UI, model-page packaging/companions editors, bundled manifests grow `model` params | the feature as the user asked for it |

Steps 1–3 are worth doing even if 4–6 are deferred: they are what turn
`/models` into one library instead of four folders.

## 13. Risks and open questions

1. **Probe accuracy.** Tensor-name classification is heuristic. It is wrong
   sometimes, which is why the user override is tier 1 and the folder
   heuristic is the floor. Worth a golden-file test over a table of real
   header JSONs (headers are small — they can be committed as fixtures without
   any weights).
2. **`.ckpt` and `.gguf`** get folder-heuristic answers only. Acceptable;
   both are named explicitly in the UI as "packaging not detected".
3. **`weight_dtype`** — proposed default `"default"`, overridable per model via
   companions. Should it also be an exposed advanced param? Leaning no.
4. **Does §8.2 survive?** This proposal contradicts "choosing a model =
   choosing a workflow" head-on. The narrower reading still holds — a workflow
   still bakes in its *defaults* and its pipeline — but the sentence needs
   rewriting, and that is a decision for DESIGN.md, not for an implementation.
5. **Custom nodes.** Everything above assumes core ComfyUI loaders, matching
   `CORE_NODES`. GGUF and other custom loaders need a node-schema source
   beyond the hardcoded table; out of scope here, but the slot abstraction is
   where they would eventually plug in.
