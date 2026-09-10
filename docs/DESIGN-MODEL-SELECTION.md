# Design — one model picker across every diffusion folder

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §4.3, §4.6, §8.1, §8.2, §11.2, §12.
**Premise being revised:** §8.2 ("Model switching — solved by construction …
choosing a model = choosing a workflow").

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
   for each model, rather than hand-authored from assumption. Four of them are
   wrong today — two have the wrong loader topology and two target a different
   model than their name claims (§7).
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
  granularity a workflow actually targets.
- §8.1's "the app attaches no behaviour to a family" no longer holds. Family
  drives picker ordering, so it becomes load-bearing and must be accurate.

## 7. Rebuilding the bundled workflows from the official sources

`workflows/bundled/README.md` already says seven of the eight have never been
run and carry placeholder filenames. Checking four against docs.comfy.org
shows the problem is worse than placeholder names — the graphs themselves are
wrong, in two different ways.

| workflow | repo has | official | problem |
|---|---|---|---|
| `krea2` | `flux1-krea-dev.safetensors`, `DualCLIPLoader` t5xxl + clip_l, Flux-shaped | Krea 2: `krea2_turbo_fp8_scaled` (diffusion_models), `qwen3vl_4b_fp8_scaled` (text_encoders), `qwen_image_vae` (vae), 8 steps | **different model** |
| `ltx` | `ltx-video-2b-v0.9.5`, `CLIPLoader` t5xxl `type: ltxv` | LTX-2.3: `ltx-2.3-22b-dev-fp8` (checkpoints), `gemma_3_12B_it_fp4_mixed` (text_encoders), a required distilled LoRA, a spatial upscaler | **different model** |
| `anima` | one `CheckpointLoaderSimple` | `anima-base-v1.0` (diffusion_models) + `qwen_3_06b_base` (text_encoders) + `qwen_image_vae` (vae) | **wrong topology** |
| `z-image-turbo` | one `CheckpointLoaderSimple` | `z_image_turbo_bf16` (diffusion_models) + `qwen_3_4b` (text_encoders) + `ae.safetensors` (vae) | **wrong topology** |

`anima` and `z-image-turbo` cannot load their models at all: a
`CheckpointLoaderSimple` has no way to read a split-file model, and no
filename will fix that.

`krea2` is a naming collision. The repo's workflow is **Flux.1 Krea [dev]** —
a Flux-family model, which its filename, its family tag and its T5 + CLIP-L
pair all confirm. **Krea 2** is a separate later model on a Qwen3-VL text
encoder and a Qwen image VAE. ComfyUI v0.34.0 lists `krea2` as its own
`CLIPLoader` type alongside `flux2`, so the two are distinct to ComfyUI as
well. The repo needs to decide whether it ships one, the other, or both under
honest names (`flux-krea` and `krea2`).

### How to rebuild

Author these from the workflow JSON each docs page links, not by hand. That
gets the real node graph, the real filenames and the real sampler settings in
one step, and it is the only way to be sure. Note that the current-generation
templates use ComfyUI **Subgraph** nodes, which `CORE_NODES`
(`src/workflows/nodes.ts`) does not model — worth checking what
`app.graphToPrompt()` produces for one before assuming the api graph round-trips.

Then add a `model` param per §5 to each, bound to the input its loader
actually uses.

`sd15` is exempt: it is the one workflow that runs, it is what the contract
check generates with, and it is correct as shipped. It gains a `model` param
and nothing else.

Four workflows were not checked and still need the same pass:
`illustrious`, `flux-klein`, `krea2-img2img`, and whatever replaces `ltx`.

## 8. What this explicitly does not do

Recorded so the next reader does not re-derive it:

- **No runtime loader substitution.** No slot binds, no `spliceModel`, no
  companion (CLIP/VAE) resolution, no `companions_json`, no old→new node
  remapping, no `@key.OUTPUT` references, no param phase ordering. All of it
  existed to cross the packaging line, and §2 shows nothing crosses it.
- **No packaging column, no `model_probes.packaging`.** The header probe
  survives only to detect family (§6).
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
3. **`FAMILIES` granularity** is a DESIGN.md decision (§6), not something to
   settle in an implementation.
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
