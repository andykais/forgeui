# Bundled workflows

The seven workflows of DESIGN §4.6, shipped with the app and copied into
`<appdata>/workflows/bundled/` on every launch. Editing one in the app copies it
to `<appdata>/workflows/user/<id>/` first, and the user copy shadows this one
from then on (§4.6).

| id              | name                  | family  | kind  | exposed params                                                  |
| --------------- | --------------------- | ------- | ----- | --------------------------------------------------------------- |
| `krea2`         | Flux Krea 2           | flux    | image | prompt, size, seed, loras · steps, cfg advanced                 |
| `krea2-img2img` | Flux Krea 2 (img2img) | flux    | image | image, prompt, denoise, size, seed, loras · steps, cfg advanced |
| `illustrious`   | Illustrious XL        | sdxl    | image | prompt, negative, size, seed, loras · steps, cfg advanced       |
| `anima`         | Anima                 | anima   | image | prompt, negative, size, seed, loras · steps, cfg advanced       |
| `flux-klein`    | Flux Klein            | flux    | image | prompt, size, seed, loras                                       |
| `z-image-turbo` | Z-Image Turbo         | z-image | image | prompt, size, seed                                              |
| `ltx`           | LTX Video             | ltx     | video | prompt, size, frames, fps, seed, loras                          |
| `sd15`          | Stable Diffusion 1.5  | sd15    | image | prompt, negative, size, seed, loras · steps, cfg advanced       |

Each directory holds `workflow.api.json` (what gets queued) and `manifest.json`
(what the Generate panel renders). There is no `workflow.ui.json` yet — see
below.

## The model filenames are placeholders — except `sd15`

`sd15` names the checkpoint `deno task comfy:setup` downloads
(`v1-5-pruned-emaonly-fp16.safetensors`), so it runs as shipped and is what the
contract check generates with (`docs/HARDWARE-CHECKLIST.md`).

The other seven have never been run: this repository has no GPU and none of
their weights. Every model filename below is a **placeholder** and will not
resolve on your machine until you point it at a file you actually have.

| workflow                 | placeholder filenames                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `krea2`, `krea2-img2img` | `flux1-krea-dev.safetensors`, `t5xxl_fp16.safetensors`, `clip_l.safetensors`, `ae.safetensors` |
| `flux-klein`             | `flux-klein.safetensors`, `t5xxl_fp16.safetensors`, `clip_l.safetensors`, `ae.safetensors`     |
| `illustrious`            | `illustriousXL.safetensors`                                                                    |
| `anima`                  | `anima.safetensors`                                                                            |
| `z-image-turbo`          | `z-image-turbo.safetensors`                                                                    |
| `ltx`                    | `ltx-video-2b-v0.9.5.safetensors`, `t5xxl_fp16.safetensors`                                    |

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
- Only core ComfyUI nodes are used, so nothing here depends on custom nodes.
- Two of these cannot be generated from yet: `krea2-img2img` needs the
  content-addressed input store behind `image` params, and `ltx` writes a video.
  Both are later phases; the workflows load, list and rewrite today.
