# Design proposal — one model picker for every kind of model

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §4.3, §4.4, §4.7, §6.2, §7, §8.1, §8.2, §11.2, §12.
**Premise being revised:** §8.2 ("Model switching — solved by construction ...
choosing a model = choosing a workflow").

Part I is *what this does* and is the part to argue with. Part II is *how it
works* and only matters once Part I is agreed.

---

# Part I — What

## 1. The problem

SwarmUI has one *Model* dropdown. Everything that can drive a generation —
whatever sits in `checkpoints/`, `Stable-Diffusion/`, `diffusion_models/`,
`unet/` — appears in it, and picking one is all the user does.

In ForgeUI those are four unrelated things, and no bundled workflow lets you
pick a model at all. The everyday case this blocks: **you keep several
variants of the same family and want to switch between them.** For Flux you
might have `krea2_turbo_bf16.safetensors` (a bare diffusion model) sitting
next to a full Flux checkpoint someone published. Today, using either one
means editing the `krea2` workflow in ComfyUI, or keeping two near-identical
workflows around. Neither is what you want: it is the same recipe, a different
set of weights.

Two things in the code stand in the way.

**The folder is the type.** `ModelScanner` stamps a model's `kind` with the
`config.yaml` key its folder was listed under (`src/models/scan.ts`), and
`DEFAULT_MODEL_KINDS` is `checkpoints | loras | vae | controlnet`
(`src/config/defaults.ts`). The picker asks for one kind
(`api.modelsOfKind("checkpoints")`) and gets one folder's worth.

**A model param can only rewrite text inside a node.**
`{ "type": "checkpoint", "bind": "1.ckpt_name" }` writes a filename into node
`1`, which holds only while node `1` stays a `CheckpointLoaderSimple`. But
the two file layouts need *different loader nodes*: a full checkpoint carries
MODEL + CLIP + VAE and loads with one node, a bare diffusion model carries
MODEL only and needs separate text encoders and a VAE beside it. That is a
change of graph shape, not of a string — which is why every bundled workflow
hardcodes its loaders and exposes no model param.

## 2. What you get

**Every bundled workflow grows a Model row at the top of the param panel.**
Clicking it opens a search box listing every model from every diffusion
folder at once — `checkpoints`, `Stable-Diffusion`, `diffusion_models`,
`unet`, together. Models of the workflow's own family come first; everything
else sits under an "Other models" divider, still selectable, flagged.

Each workflow's Model defaults to the file its graph already names, so a
fresh install behaves exactly as it does today until you touch it.

Then, for `krea2`, whose graph loads a bare Flux diffusion model plus a
`DualCLIPLoader` and a `VAELoader`:

| you pick | what happens | asks you anything? |
|---|---|---|
| `krea2_turbo_bf16.safetensors` — another bare Flux diffusion model | its filename replaces the one in the `UNETLoader`; the text encoders and VAE in the graph are kept as-is | no |
| a **full Flux checkpoint** | one `CheckpointLoaderSimple` replaces all three loaders; the checkpoint's own CLIP and VAE are used | no |
| a **full SDXL checkpoint** | same single-loader substitution; flagged as a different family than the workflow, but it runs | no |
| a bare diffusion model in a family ForgeUI has no text encoder for | not selectable; the row reads *"needs a text encoder"* | it tells you before you queue |

The first two rows are the case you described, and neither needs any setup:
one keeps the companions the workflow already has, the other needs no
companions at all.

The sampler, prompt encoders, decode and save nodes are untouched in every
case. **You are swapping the weights, not the recipe** — `krea2` is still 28
steps at cfg 1.0 on euler/simple whatever you load into it.

## 3. What you see when you edit a workflow in ComfyUI

**A complete, ordinary workflow.** Nothing is missing and nothing is
generated on the fly in the file.

The loaders stay authored in `workflow.api.json` exactly as they are today,
with real filenames in them. Open `krea2` in the editor and you see
`UNETLoader → flux1-krea-dev.safetensors`, `DualCLIPLoader`, `VAELoader`, all
wired up; ComfyUI's own Run button works on it standalone.

Substitution happens on a **throwaway copy** made at submit time. This is not
new machinery: `rewriteGraph` already starts with
`structuredClone(options.graph)` (`src/workflows/rewrite.ts:176`), and
`lora_list` already splices `LoraLoader` nodes into a graph that has none
saved in it (§4.4). The model swap is the same trick applied to the head of
the graph. The files on disk are never touched by a generate.

So the authored loaders keep two real jobs:

1. **They are the default.** Pick nothing, or pick the file already named
   there, and no substitution happens at all.
2. **They are the companion source.** Swapping one Flux diffusion model for
   another keeps the authored `DualCLIPLoader` and `VAELoader` verbatim. The
   graph you wrote is where the text encoders come from.

### The recipe and the run are different things

There is one discontinuity worth being explicit about. Pick a full SDXL
checkpoint in Generate, hit Generate, then click "Open in ComfyUI" — you see
the *authored* three-loader Flux graph, not the single-loader graph that just
ran. That is intended, and the split is:

- **The editor edits the recipe.** It always loads the authored graph, and
  Save & return writes the authored graph. If it loaded the rewritten one,
  saving would silently bake your last model pick in as the workflow's
  permanent default — which is the opposite of what a model param is for.
- **The output's frozen graph is the record of the run.** The sidecar already
  stores the exact submitted graph and `POST /api/jobs/rerun` already
  resubmits it (§6). "Show me the graph that made this image" is an *output*
  action, not a workflow action.

That second half is currently only reachable as a rerun, so this proposal
adds a **View graph** entry to the output metadata sidebar (§11.2) to make it
visible. Without it the discontinuity has no explanation available to the
user, which is what makes it feel like a bug rather than a design.

### Editing the graph does not break the model param

The manifest names the *consumers* of the model — "node 3 needs MODEL, node 6
needs CLIP, node 8 needs VAE" — not the loaders that produce them. Rearrange,
replace or rewire the loaders in ComfyUI however you like: as long as node 3
still takes a MODEL, the Model param still works. This is strictly more
robust than today's `1.ckpt_name` binds, which break the moment that node
stops being a `CheckpointLoaderSimple`.

## 4. What changes in the bundled workflows

All eight gain a `model` param, defaulting to the filename already in their
graph. No graph changes. Three shapes are already represented, and the third
is the one that proves the design has to be partial:

| workflow | authored loaders | what the Model param owns |
|---|---|---|
| `sd15`, `illustrious`, `anima`, `z-image-turbo` | one `CheckpointLoaderSimple` | MODEL, CLIP and VAE |
| `krea2`, `krea2-img2img`, `flux-klein` | `UNETLoader` + `DualCLIPLoader` + `VAELoader` | MODEL, CLIP and VAE |
| `ltx` | `CheckpointLoaderSimple` **+ a separate `CLIPLoader`** | MODEL and VAE only — **not** CLIP |

`ltx` loads a full checkpoint but deliberately drives its text encoding from
an external T5 (`CLIPLoader`, `type: ltxv`) rather than the checkpoint's own
CLIP. So a model slot cannot be all-or-nothing: `ltx`'s says
`clip_to: null`, meaning *"swap the model and the VAE, leave the text encoder
alone."* Any of the three outputs can be disclaimed this way.

## 5. What does not change

- Graphs are still authored in ComfyUI and committed as files. ForgeUI does
  not generate graphs the way SwarmUI does.
- The manifest is still the only thing the Generate panel reads (§4).
- Pickers still work with **zero hashed models** (the standing rule in
  AGENTS.md); every mechanism below has an answer available at scan time.
- Nothing is ever written inside a model folder, and nothing is downloaded at
  runtime.
- A workflow still bakes in its pipeline and its defaults. The narrow reading
  of §8.2 survives; the sentence "choosing a model = choosing a workflow"
  does not.

---

# Part II — How

Three layers. Each is independently shippable and independently useful.

## 6. Layer 1 — model class

`kind` stays exactly what it is: the `config.yaml` key, which is also the
`extra_model_paths.yaml` key ComfyUI resolves names against
(`src/config/extra_model_paths.ts`). It must not change.

A derived field `class` sits above it:

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

`config.yaml` gains an override map so a custom folder key lands correctly:

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

`DEFAULT_MODEL_KINDS` grows to cover the table, all empty by default, so no
existing install changes behaviour. `ENUM_SOURCES` widens from four hardcoded
kinds to *any class name or any configured kind*, so a manifest can say
`"source": "diffusion"` or `"source": "text_encoders"`.

`GET /api/models` gains `?class=`, beside the existing `?kind=`. That one
endpoint is the grab bag: `GET /api/models?class=diffusion&q=flux` returns
every match from all four folders, ranked by the substring match §12 already
specifies.

## 7. Layer 2 — packaging and architecture

For a `diffusion` model we need to know which loader it wants. Three sources,
best answer wins:

1. **User override.** A `packaging` field on the model page, next to
   `family`. Always wins — the escape hatch that makes the other two tiers
   safe to get wrong.
2. **Header probe.** A `.safetensors` file starts with a u64 little-endian
   header length followed by a JSON blob of tensor names and shapes. Reading
   it costs one `open` and one short read — nothing next to the full-file
   sha256 the hasher already does. The tensor names classify the file:
   - `first_stage_model.*` and `cond_stage_model.*` present → `full`
   - only `model.diffusion_model.*`, or Flux's `double_blocks.*` /
     `single_blocks.*` → `diffusion_only`

   The same names give the **architecture** (`sd15`, `sdxl`, `flux`, `ltx`,
   `z-image`, …), which maps onto the existing hardcoded `FAMILIES` list.
   Worth having on its own: §8.1 infers family only from Civitai today, so
   every scanned model starts `unset`. This is an offline answer with no
   network and no "Fetch info" click.
3. **Folder heuristic.** `diffusion_models` / `unet` → `diffusion_only`;
   `checkpoints` / `Stable-Diffusion` → `full`. Available the instant a file
   is scanned, which is what keeps the picker honest before any probe or hash
   has run.

`.ckpt` is a pickle and cannot be probed cheaply — folder heuristic only.
`.gguf` has its own header format and is in practice always diffusion-only,
but loading one needs a custom node (`UnetLoaderGGUF`); until custom-node
support exists a `.gguf` is listed but marked unswappable, with the reason
shown in the picker rather than as a ComfyUI failure later.

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
ALTER TABLE models ADD COLUMN companions_json TEXT; -- §9
```

The probe runs as its own pass over newly scanned files, before hashing, since
it is cheap and its answer is needed in the picker. Like hashing, it must
never block anything and a failed read must never stop the rest.

`ModelView` gains `class`, `packaging` and `packaging_source`
(`user | probe | folder`), so the UI can show *why* a model is treated as it
is.

## 8. Layer 3 — the `model` param and the loader-slot rewrite

A new param type whose `bind` describes a **slot**: the graph inputs that
consume this model's outputs. `krea2`:

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
      "clip_to":  ["6.clip"],
      "vae_to":   ["8.vae"],
      "clip_type": "flux"
    }
  }
}
```

and `ltx`, disclaiming CLIP per §4:

```json
"bind": { "slot": { "model_to": ["3.model"], "clip_to": null, "vae_to": ["8.vae"] } }
```

`applyParam` gets a `case "model"` beside the existing `case "lora_list"`,
calling a `spliceModel` that mirrors `spliceLoras`:

1. Resolve the pick to its `name` (the folder-relative name ComfyUI binds to)
   and its effective `packaging`.
2. Build the loader subgraph, allocating ids with the existing `nextNodeId`:
   - **`full`** — one `CheckpointLoaderSimple { ckpt_name }`; MODEL, CLIP and
     VAE all come off it.
   - **`diffusion_only`** — `UNETLoader { unet_name, weight_dtype }` for
     MODEL, plus a `CLIPLoader` / `DualCLIPLoader` and a `VAELoader` for the
     companions of §9.

   Only for the outputs the slot claims: a `null` target list means that
   output is left alone and no loader is built for it.
3. Rewire every entry in `model_to` / `clip_to` / `vae_to` onto the new nodes
   with the existing `setScalar`.
4. Record the mapping *old loader node → new loader node* for §10.

The rewrite **never deletes a node.** It only adds and rewires.

**A general prune pass closes the loop.** `rewriteGraph` gains a final step:
walk backwards from `manifest.outputs` and drop every node nothing reaches.
ComfyUI would not execute an orphan anyway, but two things here care.
`collectModels` (`src/jobs/models.ts`) walks *every* node, so without the
prune a discarded `UNETLoader` would write a model that was never loaded into
the sidecar's `models` block and into `output_models`. And a stale
placeholder filename in an orphan is a validation risk not worth reasoning
about. Making the prune general — rather than making the swap decide what is
safe to delete — keeps the swap trivial and fixes a latent sharp edge for
hand-authored graphs at the same time.

## 9. Companions — CLIP and VAE for a diffusion-only pick

Picking a bare diffusion model leaves three questions open: text encoder(s),
VAE, and `weight_dtype`. Resolved in this order, first hit wins:

1. **The model's own recorded companions** (`models.companions_json`:
   `{clip: [...], vae: ..., weight_dtype: ...}`). Editable on the model page,
   and offered to be remembered the first time a generation with that model
   succeeds.
2. **What the graph already has.** If the authored slot already supplies CLIP
   and VAE and the arch matches the pick, keep them and change only the
   diffusion filename. This is the `krea2` swap from §2 — the common case,
   and it asks for nothing.
3. **A family default**, derived from what is actually in the configured
   folders (family `flux` → a `t5xxl*` plus a `clip_l*`, plus
   `ae.safetensors`).
4. **Fail, in the picker.** If nothing resolves, the model is listed but not
   selectable and annotated — "needs a text encoder" — and selecting it
   raises a `ParamError` at coerce time naming exactly what is missing.

Rule 4 is what makes the picker feel right: permissive like SwarmUI's, but it
never lets you queue something it already knows cannot wire up.

Note that a `full` pick skips this section entirely — it needs no companions.
So both halves of the §2 table work with zero configuration, in opposite
ways.

## 10. Interaction with the LoRA chain

`lora_list` binds `model_from: "1.MODEL"`, `clip_from: "1.CLIP"` — hardcoded
references to the very nodes the swap replaces. Two things handle this:

- **Order.** The model swap runs before the LoRA splice. `rewriteGraph`
  currently applies params in manifest order; it gains an explicit phase
  order (`model` → scalars → `lora_list` → outputs → prune) so this does not
  depend on how a manifest happens to be written.
- **Remapping.** The swap's old→new node map is applied to any chain
  reference pointing at a replaced loader. `"1.MODEL"` keeps working and
  follows the swap automatically — **no bundled manifest needs its chain
  edited.**

For manifests authored from here on, a chain may also name the slot
symbolically:

```json
"model_from": "@model.MODEL",   "clip_from": "@model.CLIP"
```

where `model` is the key of the `model` param. Explicit, and immune to node
renumbering. The `@key.OUTPUT` form is a small addition to `parseBind`; plain
`node.OUTPUT` stays valid.

## 11. The manifest editor (§4.7)

A `model` param is not a literal node input, so it cannot appear as a
checkbox in the "Expose inputs" list — a slot spans several *consumers*.
It gets its own dialog, exactly as §4.7 already carves out for `lora_list`
("not a node input at all — it is a synthetic chain row … configured with its
own dialog and is not counted among the literal inputs").

Two additions:

- Loader inputs owned by a slot (`1.unet_name`, `2.clip_name1`, `4.vae_name`)
  are **marked as owned** in the literal-inputs list, so you cannot
  independently expose `1.unet_name` and end up with two params writing the
  same box.
- The slot dialog is phrased in consumers, matching §3: pick which inputs
  take MODEL, CLIP and VAE, with any of the three left unclaimed.

## 12. Reproducibility

§6.1 makes the sidecar authoritative, so the swap must not make a job
un-replayable. It does not: `collectModels` runs on the **final, rewritten,
pruned** graph, so `models[]` already records the loaders that actually ran,
with the right `role` (`checkpoint` for a full pick, `unet` + `clip` + `vae`
for a diffusion-only one). No change to the sidecar's `models` block.

One change is needed. Replaying a job's `params` re-runs companion
resolution, and a user who edits a model's companions in between would get a
different graph from the same params. So a `model` param's **stored value is
the resolved set**, not the bare name:

```json
"model": {
  "name": "krea2_turbo_bf16.safetensors",
  "packaging": "diffusion_only",
  "clip": ["t5xxl_fp16.safetensors", "clip_l.safetensors"],
  "vae": "ae.safetensors",
  "weight_dtype": "default"
}
```

Submitting accepts either a bare string (resolve now) or the full object
(replay exactly). Reuse Parameters and `POST /api/jobs/rerun` stay exact.
This is an additive shape change to §6.2's `params` and must land in
DESIGN.md before any code.

## 13. UI surface

- **One `ModelPicker` component** on the existing 326px popover (§11.3
  already wants one popover component serving the LoRA picker, the models
  filter, the use-in-workflow menu and promote-to-sample — this is the same
  one, taking a class filter). Search box, thumbnail + display name rows,
  family badge.
- **Grouped by compatibility, not gated by it.** Workflow-family models
  first, everything else under an "Other models" divider, selectable and
  flagged. "Show all" already behaves this way for the LoRA picker (§11.4).
- A row that cannot be wired shows its reason inline and is not selectable.
- The **model page** gains `packaging` (showing the detected value and its
  source when not overridden) and a companions editor, beside `family`.
- The **output metadata sidebar** gains **View graph**, per §3.

## 14. Migration and compatibility

- `checkpoint` stays a valid param type, treated as a `model` param with
  `filter.class = "diffusion"` and a scalar bind — a filename swap with no
  shape change, exactly what it does today. Documented as superseded.
- Existing manifests keep working untouched; §10's remapping covers their
  LoRA chains. The bundled eight gain `model` params as a deliberate edit
  (§4), not as a forced migration.
- `model_folders` defaults grow, all empty. Existing `config.yaml` files are
  unaffected.
- `model_probes` is derived and rebuildable — `deno task reindex` and Rescan
  both repopulate it, in keeping with "the database is a derived index".

## 15. Suggested order of work

| # | Step | Result |
|---|---|---|
| 1 | Class taxonomy: `model_classes` config, `class` on `ModelView`, `?class=` on `GET /api/models`, widened `ENUM_SOURCES`, wider folder defaults | one search box over every model folder |
| 2 | The general prune pass in `rewriteGraph` + explicit param phase order | latent sharp edge closed; prerequisite for 4 |
| 3 | Safetensors header probe: `model_probes`, packaging + arch detection, the family it fills in for free | models stop being `unset`; packaging known |
| 4 | The `model` param and `spliceModel`, with old→new remapping and `@key.OUTPUT` binds | shape-crossing swaps work |
| 5 | Companion resolution + `companions_json` + the picker's un-wireable annotations | arbitrary picks work, and fail early when they cannot |
| 6 | `ModelPicker`, model-page packaging/companions editors, **`model` params on all eight bundled workflows**, output View graph | the feature as asked for |

Steps 1–3 are worth doing even if 4–6 are deferred: they are what turn
`/models` into one library instead of four folders.

## 16. Risks and open questions

1. **Probe accuracy.** Tensor-name classification is heuristic and will be
   wrong sometimes, which is why the user override is tier 1 and the folder
   heuristic is the floor. Worth a golden-file test over a table of real
   header JSONs — headers are small and can be committed as fixtures with no
   weights.
2. **`.ckpt` and `.gguf`** get folder-heuristic answers only. Both are named
   in the UI as "packaging not detected".
3. **`weight_dtype`** — proposed default `"default"`, overridable per model
   via companions. Should it also be an exposed advanced param? Leaning no.
4. **§8.2 needs rewriting.** This contradicts "choosing a model = choosing a
   workflow" head-on. The narrow reading survives (§5) but the sentence does
   not, and that is a DESIGN.md decision rather than an implementation one.
5. **Custom nodes.** Everything above assumes the core loaders in
   `CORE_NODES`. GGUF and other custom loaders need a node-schema source
   beyond the hardcoded table; out of scope here, but the slot is where they
   would plug in.
