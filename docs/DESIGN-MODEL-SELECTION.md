# Design — one model picker across every diffusion folder

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §4.3, §4.6, §8.1, §8.2, §11.2, §12.
**Premise being revised:** §8.2 ("Model switching — solved by construction …
choosing a model = choosing a workflow").

---

## The problem

ForgeUI bakes a model into its workflow. A `checkpoint` param reads one
folder — `checkpoints` — so `diffusion_models`, `unet` and `Stable-Diffusion`
are four unrelated kinds of thing to the app, and no bundled workflow exposes
a model param at all. Keeping several variants of one family therefore means
editing the graph in ComfyUI or maintaining near-identical copies of the same
workflow, for what is the same recipe with different weights. SwarmUI has one
*Model* dropdown over all of it, because it owns the graph and generates the
right loader per pick; ForgeUI is workflow-first and will not do that. This
proposal takes the part of SwarmUI's flexibility that transfers — one search
box over every diffusion folder, with the pick applied to a workflow authored
in its architecture's native shape — and leaves graph authoring in ComfyUI
where it belongs.

---

## 1. What this does

Four things.

1. **ForgeUI treats `diffusion_models` and `checkpoints` identically.** Both,
   plus `unet` and `Stable-Diffusion`, become one class — `diffusion` — and one
   search box lists all of them together. The folder a file happens to sit in
   stops being a type.
2. **The generated `extra_model_paths.yaml` lists every diffusion folder under
   both keys by default**, so any file the picker offers is resolvable by
   whichever loader node the workflow uses. Without this the picker offers
   names ComfyUI cannot find (§4).
3. **The bundled workflows are rebuilt from the official ComfyUI workflows**
   for each model. What ships today is a placeholder set, authored without
   the weights and never run (§7).
4. **Every bundled workflow exposes a `model` param** so the base model can be
   swapped without editing the graph, defaulting to the file its graph already
   names.

That is the whole design. It is deliberately much smaller than the first draft
of this document, for the reason in §2.

## 2. Why it is this small

The first draft assumed a workflow would have to change its *loader topology*
at generate time. An all-in-one checkpoint carries MODEL + CLIP + VAE and loads
with one `CheckpointLoaderSimple`; a split-file diffusion model carries MODEL
only and needs `UNETLoader` + `CLIPLoader` + `VAELoader` beside it. Swapping
across that line is a change of graph shape, not of a string, so the draft
grew a slot-rewrite engine, companion resolution, node remapping and a prune
pass.

All of that is only needed to swap **between the two packagings inside one
architecture**. `scripts/classify-models.ts` was written to find out whether
that case exists in a real library: it reads each safetensors header — never
the weights — and reports whether a file holds MODEL, CLIP and VAE or MODEL
alone.

**The answer was no.** Packaging does not vary within a family. Every
architecture ships one way or the other:

| shipped as | architectures |
|---|---|
| all-in-one checkpoint | sd15, sdxl (and its finetunes — Illustrious, Pony, NoobAI) |
| split-file | flux, krea2, z-image, anima, ltx-2 |

So a workflow authored in its architecture's native shape never needs to
change that shape. Swapping models inside a family is a **pure filename
substitution into the loader that is already there** — the same operation
`bind: "1.ckpt_name"` performs today.

The consequence is that a `model` param is an ordinary scalar param. It
behaves exactly like `steps` or `cfg`: the editor shows the authored value,
the param panel holds your override, and the queued graph is a clone with one
string replaced. No new machinery, and none of the questions the first draft
spent its length on.

## 3. `diffusion_models` and `checkpoints` are the same thing

`kind` stays what it is — the `config.yaml` key, which is also the
`extra_model_paths.yaml` key ComfyUI resolves against. A derived `class` sits
above it:

| class | kinds |
|---|---|
| `diffusion` | `checkpoints`, `Stable-Diffusion`, `diffusion_models`, `unet` |
| `lora` | `loras`, `lycoris` |
| `vae` | `vae`, `vae_approx` |
| `clip` | `clip`, `text_encoders`, `clip_vision` |
| `controlnet` | `controlnet` |
| `upscale` | `upscale_models`, `latent_upscale_models` |
| `embedding` | `embeddings` |
| `other` | anything else |

Overridable for custom folder keys:

```yaml
model_classes:
  my_weird_folder: diffusion
```

`DEFAULT_MODEL_KINDS` grows to cover the table — including `text_encoders` and
`latent_upscale_models`, which the current-generation models need and the
four-key default does not have. All new keys default to empty, so no existing
install changes behaviour.

`GET /api/models` gains `?class=`, beside `?kind=`. `ENUM_SOURCES` widens from
four hardcoded kinds to any class name or any configured kind.

## 4. Folder aliasing — the part that makes it work

Unifying the picker does not unify how ComfyUI *resolves* a filename. Each
loader searches exactly one folder key:

```python
CheckpointLoaderSimple   get_filename_list("checkpoints")
UNETLoader               get_full_path_or_raise("diffusion_models", unet_name)   nodes.py:1003
CLIPLoader               get_full_path_or_raise("text_encoders", clip_name)      nodes.py:1030
VAELoader                get_filename_list("vae") + vae_approx                   nodes.py:776
```

So a unified picker on its own produces broken jobs: it offers
`foo.safetensors` from `checkpoints/`, the manifest writes it into
`1.unet_name`, and ComfyUI looks under `diffusion_models/` and fails.

ForgeUI generates that config file (`src/config/extra_model_paths.ts`), so the
fix is entirely ours: **write every `diffusion`-class folder under both the
`checkpoints` and `diffusion_models` keys.** Given

```yaml
model_folders:
  checkpoints:      [/models/checkpoints]
  diffusion_models: [/models/diffusion_models]
```

the generated file becomes

```yaml
forgeui:
  checkpoints: |-
    /models/checkpoints
    /models/diffusion_models
  diffusion_models: |-
    /models/checkpoints
    /models/diffusion_models
```

Every diffusion-class file is then reachable through either loader. No
symlinks, no moving files, no user action. This is a contained change to one
renderer and it is the linchpin: without it §3 is cosmetic.

Two notes. Duplicate names across the two folders resolve to the first listed,
which is already how ComfyUI and `ModelScanner` both behave. And the app's own
scan still reports a model under the kind whose folder it was found in, so the
library does not double-count.

## 5. The `model` param

Almost exactly today's `checkpoint` param. Today:

```json
{ "key": "model", "type": "checkpoint", "bind": "1.ckpt_name" }
```

Proposed:

```json
{
  "key": "model",
  "label": "Model",
  "type": "model",
  "bind": "1.unet_name",
  "filter": { "class": "diffusion", "family": "flux" },
  "default": "flux1-krea-dev.safetensors"
}
```

The only change is where the options come from: a class rather than the single
`checkpoints` folder. `bind` stays a scalar and names whatever input the
workflow's own loader uses — `ckpt_name` for a checkpoint-shaped workflow,
`unet_name` for a split-file one. That is the manifest author's choice, made
once, not a runtime decision.

`checkpoint` is a misnomer once it can point at `diffusion_models/`, so the
type is renamed to `model` with `checkpoint` kept as an accepted alias.
Existing manifests keep working untouched.

**The family filter is a default sort, not a gate.** Models matching the
workflow's family come first; the rest sit under an "Other models" divider,
still selectable. An untagged model must stay reachable — see §6.

## 6. Family has to be detected, not asked for

§8.1 gives family one automatic source (Civitai `baseModel`, on an explicit
"Fetch info" click) and one manual one. Everything therefore starts `unset`.

That was harmless while family only decorated the Models screen. It stops
being harmless the moment one picker lists every diffusion folder at once: an
all-`unset` library shows SD1.5 checkpoints beside Flux diffusion models with
nothing to separate them. The folder cannot help — `diffusion_models/` holds
Flux *and* Z-Image *and* Anima.

So family should be **detected from the file**. `scripts/classify-models.ts`
already reads the safetensors header; the same tensor names that distinguish
MODEL from CLIP from VAE also identify the architecture (`double_blocks.` →
flux, `input_blocks.` + `cond_stage_model.` → sd15, and so on). One short read
per file, no network, no weights, no "Fetch info" click.

This is **not a blocker for §3–§5**: the picker works with everything `unset`,
it simply cannot sort helpfully. Ship it second.

Two consequences for §8.1 as written:

- **Families must be generational, not brand names.** `ltx` currently covers
  both LTX-Video 0.9.x (T5 text encoder) and LTX-2.x (Gemma-3 12B) — different
  models that would sort together and mislead. `FAMILIES` needs entries at the
  granularity a workflow actually targets. **Implemented as** `flux`, `flux2`,
  `krea2`, `chroma`, `sdxl`, `anima`, `ltx`, `ltx-2`, `z-image`, `sd15` — the
  architectures the probe can tell apart. `ltx` keeps its name and means the
  0.9.x line, since the bundled workflow targeting it is rebuilt in §7 and
  should take `ltx-2` at that point; renaming it to `ltx-0.9` is a §7
  decision, not one to make twice.
- §8.1's "the app attaches no behaviour to a family" no longer holds. Family
  drives picker ordering, so it becomes load-bearing and must be accurate.

## 7. Rebuilding the bundled workflows from the official sources

The eight bundled workflows were authored without their weights and, except
`sd15`, have never been run — `workflows/bundled/README.md` says as much and
calls their model filenames placeholders. They are placeholders in shape as
well as in name, so this is the moment to replace them with the real thing:
each one derived from the official ComfyUI workflow for its model.

| workflow | source |
|---|---|
| `krea2` | https://docs.comfy.org/tutorials/image/krea/krea-2 |
| `ltx` | https://docs.comfy.org/tutorials/video/ltx/ltx-2-3 — **deferred**: text-to-video without image-to-video has little use, and image inputs are a later phase |
| `anima` | https://docs.comfy.org/tutorials/image/anima/anima |
| `z-image-turbo` | https://docs.comfy.org/tutorials/image/z-image/z-image-turbo |
| `flux-klein` | https://docs.comfy.org/tutorials/flux/flux-2-klein |
| `krea2-img2img` | https://docs.comfy.org/tutorials/basic/image-to-image, applied to the `krea2` graph above — **deferred** with `ltx`, for the same reason |
| `sd15` | https://docs.comfy.org/tutorials/basic/text-to-image — already matches; leave the graph alone |
| `illustrious` | no official page: an SDXL community finetune. Keep the current SDXL graph and only add the `model` param |

Rebuilding `krea2` from that page also settles a naming collision: the graph
in the repo today is **Flux.1 Krea [dev]**, a Flux-family model, while the
page covers **Krea 2**, a later model on a Qwen3-VL text encoder. Deriving
from the source makes the workflow match its name.

### 7.1 Where we deviate from the recommended workflow

Derived, not copied. A template is written for someone sitting in the ComfyUI
editor; a bundled ForgeUI workflow is driven from the param panel, and the two
want different things. Every deviation is listed here as it is made, so the
next person can tell an adjustment from a mistake.

**Every model file the graph loads is a param.** A template hardcodes its
text encoder and VAE filenames, and those filenames are wrong on anyone
else's disk. Each `CLIPLoader` / `VAELoader` gets a `model` param of the
matching class, marked `advanced` so the panel leads with the base model and
keeps the rest one click away. The base model itself is not advanced.

**Sample LoRAs become the `lora_list` param.** Templates ship a LoRA wired in
to demonstrate one — `krea2_darkbrush`, and Anima's turbo LoRA. A fixed LoRA
in the graph is a file the user has to own and cannot change; ForgeUI already
has a repeatable picker for exactly this (§4.4), so the chain replaces it.
Anima's turbo LoRA is the exception: it is kept behind the template's own
switch, because it is a different set of sampler defaults rather than a style.

**The prompt enhancer gets its own workflow rather than a switch.** Krea 2
pipes the prompt through a `TextGenerate` node — a language model that
rewrites it before encoding, using the same Qwen3-VL encoder the workflow
already loads, so it costs no extra download. Whether it earns its place is a
question about output, not architecture, so both exist: `krea2` without it
and `krea2-enhanced` with it, sharing every input so one prompt can be run
through each. Two workflows rather than one toggle because a workflow is how
this app already expresses "the same recipe, wired differently", and because
the enhanced one records a different graph in its sidecar.

`TextGenerate`'s `sampling_mode` is a `DynamicCombo`: one declared input that
expands into as many widgets as the selected option carries, named
`<parent>.<child>` in the prompt. The LiteGraph rebuild
(`src/workflows/litegraph.ts`) now expands those in place, and emits a
placeholder for a widget that has been promoted to a link — without either,
every value after the first link shifts by one, which is what produced a NaN
`max_length` and a stray `sampling_mode` slot in the editor.

**A model file a workflow names is checked before the job is queued.** The
bundled workflows ship their source template's filenames, which are nobody
else's filenames. The panel marks a value that is not in the scanned library,
and `POST /api/jobs` refuses it, naming the param and the value. A class the
library has scanned nothing for is not judged: there is no difference there
between a missing file and a folder the user never configured.

**A manifest states a `default` only where the graph cannot.** A scalar-bound
param and the input it binds are the same fact written twice, and two copies
drift: a loader changed in the ComfyUI editor left the panel showing the old
filename, and the panel then overwrote that edit at submit. So the graph is
the default, resolved on load, and the manifest overrides it only where it
means something the graph has no way to say — `seed`'s `-1` for "randomise at
submit", and `size`'s base resolution that ratio presets resolve against
(§4.3). Everything else — model, text encoder, VAE, steps, cfg, prompts — is
stated once, in the graph.

**Sample prompts are cleared.** A template ships a demo prompt; the graph
holds an empty string, which is therefore the default.

**Output nodes are renamed to `ForgeUI/out`.** The rewrite stamps
`<jobid>/out` at submit time (§5 step 3); the template's own prefix would
never be used.

### How to rebuild

Author from the workflow JSON each page links rather than by hand — that
gets the real node graph, the real filenames and the real sampler settings in
one step, and it is the only way to be sure. Then add a `model` param per §5,
bound to whatever input that workflow's own loader uses.

Two things to watch. The current-generation templates use ComfyUI **Subgraph**
nodes, which `CORE_NODES` (`src/workflows/nodes.ts`) does not model — check
what `app.graphToPrompt()` produces for one before assuming the api graph
round-trips. And several of these need folder kinds the four-key default does
not have (`text_encoders`, `latent_upscale_models`), which §3 adds.

## 8. What this explicitly does not do

Recorded so the next reader does not re-derive it:

- **No runtime loader substitution.** No slot binds, no `spliceModel`, no
  companion (CLIP/VAE) resolution, no `companions_json`, no old→new node
  remapping, no `@key.OUTPUT` references, no param phase ordering. All of it
  existed to cross the packaging line, and §2 shows nothing crosses it.
- **No packaging column, no `model_probes.packaging`.** The header probe
  survives only to detect family (§6), so `model_probes` is
  `(path, size, mtime, arch, probed_at)`. DESIGN.md §7 needs that table when
  this proposal is accepted.
- **No sidecar change.** A `model` param's value is a filename string, so
  `collectModels` and §6.2's `params` block are untouched, and Reuse
  Parameters and `POST /api/jobs/rerun` keep working as they do.
- **No graph pruning.** The first draft added a prune pass to `rewriteGraph`
  to clean up orphaned loaders. With nothing replaced there are no orphans.
  It remains a reasonable hardening for hand-authored graphs — as its own
  change, not this one.

If a future architecture *does* ship both ways, re-read the first draft in
this file's history rather than reinventing it. `scripts/classify-models.ts`
is how to find out.

## 9. Order of work

| # | Step | Result |
|---|---|---|
| 1 | Class taxonomy: `model_classes`, `class` on `ModelView`, `?class=`, widened `ENUM_SOURCES`, wider `DEFAULT_MODEL_KINDS` | one search box over every diffusion folder |
| 2 | Folder aliasing in `extra_model_paths.ts` + a contract test that a `checkpoints/` file loads through `UNETLoader` | picked names actually resolve |
| 3 | `model` param type (with `checkpoint` as alias) + the `ModelPicker` popover | swapping works, unsorted |
| 4 | Family detection from the safetensors header; generational `FAMILIES` | the picker sorts usefully |
| 5 | Rebuild the bundled workflows from official sources; add `model` params | the workflows are correct and swappable |

Steps 1–2 are the feature; 3 makes it usable; 4 makes it pleasant; 5 is a
separate correctness problem that this design is the occasion to fix.

## 10. Risks and open questions

1. **Folder aliasing and duplicate filenames.** The same name in
   `checkpoints/` and `diffusion_models/` resolves to whichever is listed
   first. Matches existing behaviour, but worth a test.
2. **Subgraph nodes** in the official templates are unmodelled by
   `CORE_NODES`. May affect §7 more than expected.
3. **`FAMILIES` granularity** is a DESIGN.md decision (§6). The list in §6 is
   what the probe can distinguish; whether ForgeUI wants entries it cannot
   detect is still open.
4. **§8.2 needs rewriting.** "Choosing a model = choosing a workflow" does not
   survive. The narrow reading does: a workflow still fixes its pipeline and
   its defaults, and you are swapping weights, not the recipe.
5. **`.ckpt` files** cannot be probed cheaply (pickle, not safetensors), so
   they get no detected family. They stay listed and manually taggable.

---

## Appendix — verified against ComfyUI v0.34.0

The version `scripts/setup-comfy.sh` pins. Read from source, not run.

- **The folder is only a search path.** Both `checkpoints/` and
  `diffusion_models/` hold plain safetensors state dicts. ComfyUI never
  inspects the folder to decide what a file is; it decides from tensor names.
  The folder chooses which node's dropdown lists the file — §4.
- **`UNETLoader` can load an all-in-one checkpoint.** `comfy/sd.py:2286` is
  commented `#Allow loading unets from checkpoint files`, and
  `unet_prefix_from_state_dict` (`model_detection.py:1299`) strips
  `model.diffusion_model.`, the SD1.5/SDXL prefix. Not needed by this design,
  but it means the split is even shallower than it looks.
- **`CLIPLoader` cannot read a checkpoint's text encoder.** `detect_te_model`
  (`comfy/sd.py:1610`) matches bare keys such as
  `text_model.encoder.layers.0.mlp.fc1.weight`; inside a checkpoint those
  carry a `cond_stage_model.` prefix and nothing strips it. `VAELoader` is
  likewise bare-file only. This is why an all-in-one cannot be driven through
  a split-file graph, and so why §7's topologies must match their models.
