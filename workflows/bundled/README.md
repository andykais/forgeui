# Bundled workflows

The nine workflows of DESIGN §4.6, shipped with the app and copied into
`<appdata>/workflows/bundled/` on every launch. Editing one in the app copies it
to `<appdata>/workflows/user/<id>/` first, and the user copy shadows this one
from then on (§4.6).

| id              | name                   | family  | kind  | exposed params                                                                                                                       |
| --------------- | ---------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `krea2`         | Krea 2 Turbo           | krea2   | image | prompt, enhance, model, size, seed, loras · steps, cfg, clip, vae, enhancer length advanced                                          |
| `krea2-upscale` | Krea 2 Turbo (upscale) | krea2   | image | `category: upscale`; image, creativity (0.2), scale (2), prompt, seed, loras · upscale model, sampling and loader overrides advanced |
| `krea2-img2img` | Flux Krea 2 (img2img)  | flux    | image | image, prompt, denoise, size, seed, loras · steps, cfg advanced                                                                      |
| `illustrious`   | Illustrious XL         | sdxl    | image | prompt, negative, model, size, seed, loras · steps, cfg advanced                                                                     |
| `anima`         | Anima                  | anima   | image | prompt, negative, model, size, seed, turbo · steps, cfg, clip, vae advanced                                                          |
| `flux-klein`    | Flux.2 Klein           | flux2   | image | prompt, model, size, loras, seed, clip · steps, cfg, vae advanced                                                                    |
| `z-image-turbo` | Z-Image Turbo          | z-image | image | prompt, model, size, loras, seed · steps, shift, clip, vae advanced                                                                  |
| `ltx`           | LTX Video              | ltx     | video | prompt, size, frames, fps, seed, loras                                                                                               |
| `sd15`          | Stable Diffusion 1.5   | sd15    | image | prompt, negative, size, seed, loras · steps, cfg advanced                                                                            |

Each directory holds `workflow.api.json` (what gets queued) and `manifest.json`
(what the Generate panel renders). There is no `workflow.ui.json` yet — see
below.

## Rebuilding one from the official ComfyUI template

`scripts/import_template.ts` turns a ComfyUI workflow template into the flat api
graph this app queues:

```sh
deno run --allow-read --allow-write scripts/import_template.ts \
  <template>.json workflows/bundled/<id>/workflow.api.json
```

Every current template is a **Subgraph**: the saved document has three or four
top-level nodes, one of them a UUID-typed instance of a definition under
`definitions.subgraphs`, and the real graph lives inside. ComfyUI flattens that
at `graphToPrompt()` time because the prompt format has no subgraph concept; the
script does the same offline, splices the parent's output node onto the inner
node that feeds it, and renumbers to `1..n`. Widget order comes from
`src/workflows/nodes.ts`, so a node type missing there is an error naming the
type rather than a wrong guess.

`z-image-turbo`, `anima`, `flux-klein` and `krea2` were rebuilt this way; the
rest are still the placeholders described below.

`krea2` changed model in the process. The graph here was **Flux.1 Krea [dev]**,
a Flux-family model; the page it is named after covers **Krea 2**, which runs on
a Qwen3-VL text encoder and is a different architecture. Deriving from the
source made the workflow match its name. `krea2-img2img` still holds the old
Flux graph and keeps its old name; it is a Flux workflow that happens to be
called Krea, and rebuilding it on Krea 2 is a separate job.

`krea2-upscale` was written here rather than imported: it is `krea2`'s loaders
with `LoadImage` → `ImageScaleBy` → `VAEEncode` in front and the advanced
sampling set behind, so it names the same real model files the rebuilt `krea2`
does.

`ltx` is also still the old graph, LTX-Video 0.9.5 rather than LTX-2.3.
Rebuilding it waits on video outputs.

A template holding several variants ships all but one bypassed, so
`--subgraph <n>` picks which one to import — `flux-klein` is variant 1, the
distilled 4B, which the template ships switched off in favour of the base.

## The model filenames are placeholders — except the rebuilt four

`sd15` names the checkpoint `deno task comfy:setup` downloads
(`v1-5-pruned-emaonly-fp16.safetensors`), so it runs as shipped and is what the
contract check generates with (`docs/HARDWARE-CHECKLIST.md`).

The other eight have never been run: this repository has no GPU and none of
their weights. Every model filename below is a **placeholder** and will not
resolve on your machine until you point it at a file you actually have.

| workflow        | placeholder filenames                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `krea2-img2img` | `flux1-krea-dev.safetensors`, `t5xxl_fp16.safetensors`, `clip_l.safetensors`, `ae.safetensors` |
| `illustrious`   | `illustriousXL.safetensors`                                                                    |
| `ltx`           | `ltx-video-2b-v0.9.5.safetensors`, `t5xxl_fp16.safetensors`                                    |

**Fixing them:** open the workflow from the Workflows screen ("Open in
ComfyUI"), pick your real model files in the loader nodes, then use the app's
**Save & return** toolbar. That writes both `workflow.ui.json` and
`workflow.api.json` into your user copy, leaving this bundled copy alone.

## Why there is no `workflow.ui.json`

`workflow.api.json` is normally produced by the embedded editor from the
LiteGraph document at save time (§4.1), and these graphs were authored the other
way round. Until you open one in ComfyUI and save it, the app rebuilds a
LiteGraph document from the api graph so the editor has something to load;
saving replaces it with the editor's own.

## Choices worth knowing about

- **Flux workflows** (`krea2`, `krea2-img2img`, `flux-klein`) have no negative
  prompt: `ConditioningZeroOut` supplies the empty negative Flux expects, and
  CFG defaults to 1.
- **`ltx`** exposes `fps` as the frame rate of the `LTXVConditioning` node,
  which is what the model conditions on. The `SaveAnimatedWEBP` node writes at a
  fixed 25 fps; rewire it in ComfyUI if you want the two to track each other.
  `frames` snaps to 8n+1, which is what LTX requires.
- **`krea2-img2img`** resizes the input image to `size` with `ImageScale` before
  encoding, so `size` means the same thing as it does everywhere else.
- **`krea2-upscale`** scales with `ImageScaleBy` instead, so the result is a
  multiple of whatever was handed in rather than a size stated up front — which
  is what an upscale means. It then re-samples at `creativity` (the KSampler's
  denoise, 0.4 by default) so the model puts detail into what the scaler could
  only interpolate. Everything about it is an ordinary param: save a copy and
  change the numbers, or the scaler, or the model.
- Only core ComfyUI nodes are used, so nothing here depends on custom nodes.
- One of these cannot be generated from yet: `ltx` writes a video, and video
  outputs are a later phase; it loads, lists and rewrites today.
