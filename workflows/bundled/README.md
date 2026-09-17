# Bundled workflows

The 17 workflows of DESIGN §4.6, shipped with the app and copied into
`<appdata>/workflows/bundled/` on every launch. Editing one in the app copies it
to `<appdata>/workflows/user/<id>/` first, and the user copy shadows this one
from then on (§4.6).

| id                    | name                           | family       | kind  | exposed params                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------ | ------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace-step-song`       | ACE-Step Song                  | ace-step-1.5 | audio | style, lyrics, duration, bpm, key_scale, time_signature, language, seed, model · language_model, vae, steps, audio_codes, encoder_cfg advanced                                                                                                                         |
| `anima`               | Anima                          | anima        | image | prompt, negative, model, size, seed, loras, turbo · steps/cfg (or the turbo pair, `when` turbo), clip, vae advanced                                                                                                                                                    |
| `anima-upscale`       | Anima (upscale)                | anima        | image | `category: upscale`; image, creativity, scale, prompt, negative, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, scheduler, upscale_method, clip, vae, model advanced                                                                |
| `breeze-tts-clone`    | Breeze TTS (voice clone)       | —            | audio | reference, transcript, text, direct, instruction (`when` direct), seed · build, cfg_scale (`when` direct), max_new_tokens, temperature, repetition_penalty advanced; **requires `ComfyUI-Breeze-TTS-2`**                                                               |
| `breeze-tts-design`   | Breeze TTS (voice design)      | —            | audio | voice, text, seed · build, cfg_scale, max_new_tokens, temperature, repetition_penalty advanced; **requires `ComfyUI-Breeze-TTS-2`**                                                                                                                                    |
| `flux-klein`          | Flux.2 Klein                   | flux2        | image | prompt, model, size, loras, seed, clip · steps, cfg, vae advanced                                                                                                                                                                                                      |
| `flux-klein-upscale`  | Flux.2 Klein (upscale)         | flux2        | image | `category: upscale`; image, creativity, scale, prompt, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, upscale_method, clip, vae, model advanced                                                                                     |
| `illustrious`         | Illustrious XL                 | sdxl         | image | prompt, negative, model, size, seed, loras · steps, cfg advanced                                                                                                                                                                                                       |
| `illustrious-upscale` | Illustrious XL (upscale)       | sdxl         | image | `category: upscale`; image, creativity, scale, prompt, negative, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, scheduler, upscale_method, model advanced                                                                           |
| `krea2`               | Krea 2 Turbo                   | krea2        | image | prompt, enhance, model, size, seed, loras · steps, cfg, clip, vae, max_length (`when` enhance) advanced                                                                                                                                                                |
| `krea2-upscale`       | Krea 2 Turbo (upscale)         | krea2        | image | `category: upscale`; image, creativity, scale, prompt, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, scheduler, upscale_method, clip, vae, model advanced                                                                          |
| `ltx2-ia2v`           | LTX-2.3 Image + Audio to Video | ltx-2        | video | image, audio, prompt, negative, size, duration, start, fps, seed, loras, use_distilled, enhance · model, clip, distilled_lora + distilled_strength (`when` use_distilled), latent_upscale_model, enhancer_lora (`when` enhance), sampler, sigmas_base, sigmas advanced |
| `ltx2-i2v`            | LTX-2.3 Image to Video         | ltx-2        | video | image, prompt, negative, size, duration, fps, seed, loras, use_distilled, enhance · model, clip, distilled_lora + distilled_strength (`when` use_distilled), latent_upscale_model, enhancer_lora (`when` enhance), sampler, sigmas_base, sigmas advanced               |
| `sd15`                | Stable Diffusion 1.5           | sd15         | image | prompt, negative, size, seed, loras · steps, cfg advanced                                                                                                                                                                                                              |
| `sd15-upscale`        | Stable Diffusion 1.5 (upscale) | sd15         | image | `category: upscale`; image, creativity, scale, prompt, negative, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, scheduler, upscale_method, model advanced                                                                           |
| `z-image-turbo`       | Z-Image Turbo                  | z-image      | image | prompt, model, size, loras, seed · steps, shift, clip, vae advanced                                                                                                                                                                                                    |
| `z-image-upscale`     | Z-Image Turbo (upscale)        | z-image      | image | `category: upscale`; image, creativity, scale, prompt, seed, loras · use_upscale_model, upscale_model, model_scale, steps, cfg, sampler, scheduler, shift, upscale_method, clip, vae, model advanced                                                                   |

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

`ltx2-ia2v` is the official `video_ltx2_3_ia2v` template, imported by the
script. Three things in the importer had to grow first, and each was a real gap
rather than a special case: a `Reroute` is now resolved away as ComfyUI resolves
it (every consumer is pointed at what the reroute was reading); `SaveVideo`'s
`format` is a DynamicCombo carrying a `codec` child, which the schema did not
say; and `TextGenerateLTX2Prompt` was missing its `thinking` and
`use_default_template` widgets, which the first template to use it got away with
only because nothing re-read them. Two nodes are added after the import, because
the subgraph read them from the parent document: `LoadImage` and `LoadAudio`.
The optional-distilled-LoRA switch is added to match `ltx2-i2v`.

`ace-step-song` follows the official `audio_ace_step1_5_xl_turbo` template — the
same eight nodes, the same split loaders, the same eight steps at cfg 1 — but
was written out here rather than run through the importer, because the
template's duration and seed are `PrimitiveNode`s, a LiteGraph-only node with no
prompt form. They are a `PrimitiveFloat` and a `PrimitiveInt` here, which is
what the flattened graph needs and what the params bind to.

The two `breeze-tts-*` graphs have no template: they were written from the
pack's own node definitions, and its example workflow is where the widget order
in `src/workflows/nodes.ts` was read from.

`krea2` changed model in the process. The graph here was **Flux.1 Krea [dev]**,
a Flux-family model; the page it is named after covers **Krea 2**, which runs on
a Qwen3-VL text encoder and is a different architecture. Deriving from the
source made the workflow match its name. There was a `krea2-img2img` holding the
old Flux graph under the Krea name; it has been dropped — it had never been run,
and an upscale workflow does the job it was there to demonstrate.

**The upscale workflows were written here rather than imported.** Each is its
own family's loaders with `LoadImage` → `ImageScaleBy` → `VAEEncode` in front
and the advanced sampling set behind, so each names the same model files its
sibling does. They come from one script rather than by hand, which is what keeps
them the same shape as each other.

`ltx2-i2v` is the official Comfy-Org LTX-2.3 image-to-video template
(`templates/video_ltx2_3_i2v.json`), which ships as a single subgraph node; it
was flattened into an api graph here, because that is the form the app queues.
The text-to-video `ltx` it replaced was the old LTX-Video 0.9.5 graph.

A template holding several variants ships all but one bypassed, so
`--subgraph <n>` picks which one to import — `flux-klein` is variant 1, the
distilled 4B, which the template ships switched off in favour of the base.

## The model filenames are placeholders — except the rebuilt four

`sd15` names the checkpoint `deno task comfy:setup` downloads
(`v1-5-pruned-emaonly-fp16.safetensors`), so it runs as shipped and is what the
contract check generates with (`docs/HARDWARE-CHECKLIST.md`).

The other eleven have never been run: this repository has no GPU and none of
their weights. Every model filename below is a **placeholder** and will not
resolve on your machine until you point it at a file you actually have.

| workflow        | placeholder filenames                                                       |
| --------------- | --------------------------------------------------------------------------- |
| `illustrious`   | `illustriousXL.safetensors`                                                 |
| `ltx2-i2v`      | none — it names the files the official template names                       |
| `ace-step-song` | none — it names the files the official ACE-Step 1.5 XL turbo template names |
| `ltx2-ia2v`     | none — the same four files `ltx2-i2v` names                                 |
| `breeze-tts-*`  | none — the pack resolves a build label to a file itself                     |

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

- **Flux-shaped workflows** (`krea2`, `flux-klein`, `z-image-turbo` and their
  upscale siblings) have no negative prompt: `ConditioningZeroOut` supplies the
  empty negative they expect, and CFG defaults to 1.
- **`ltx2-i2v`** asks for a length in **seconds**, not frames: the graph
  multiplies duration by fps and adds one itself, and the same frame rate
  reaches the conditioning, the audio latent and the written file, so the three
  cannot drift apart. It samples twice — a half-resolution pass, a spatial
  latent upsample, then a refine pass — carrying an audio latent beside the
  video one the whole way, which is why the result has sound. `model` is one
  pick bound to three loaders: the diffusion model, the audio VAE and the AV
  text-encoder pairing all come out of that one checkpoint. LoRAs splice in
  after the distilled LoRA as model-only loaders, because an LTX-2 video LoRA
  has nothing to say to a Gemma text encoder.
- **The `-upscale` workflows** scale with `ImageScaleBy`, so the result is a
  multiple of whatever was handed in rather than a size stated up front — which
  is what an upscale means. It then re-samples at `creativity` (the KSampler's
  denoise, 0.4 by default) so the model puts detail into what the scaler could
  only interpolate. Everything about it is an ordinary param: save a copy and
  change the numbers, or the scaler, or the model.
- **The two speech workflows are the only ones that need a custom node pack.**
  They say so in `requires`, which is checked at load: a graph using a node the
  app knows belongs to a pack, without declaring that pack, fails with the
  node's name rather than with ComfyUI's "node type not found" later. The
  container installs the pack at a pinned commit, and the README says how to do
  it by hand. Everything else here is core ComfyUI, `ace-step-song` included.
- **`breeze-tts-clone` carries the directed read as a switch**, not as a second
  workflow: `ComfySwitchNode` sends the save node to either Voice Clone (cfg 1,
  no instruction — the reference is the delivery) or Voice Direction (cfg 4, the
  same voice steered by words), and only the reached branch executes.
- **`ltx2-ia2v` is where a take becomes a performance.** `ltx2-i2v` already
  carries an audio latent, but an empty one: the sound it makes is the sound it
  imagined. Here the supplied clip is encoded into that latent and masked with
  `SolidMask(value 0)` — a noise mask of 0 means "keep this" — so the sampler
  cannot regenerate it and has to draw a picture that fits it. That is what
  makes the mouth match. The delta from `ltx2-i2v` is four nodes in
  (`LoadAudio`, `TrimAudioDuration`, `LTXVAudioVAEEncode`, `SetLatentNoiseMask`)
  and one out (`LTXVEmptyLatentAudio`); everything downstream is unchanged.
- **One number is the length of both.** `duration` trims the clip and, through
  `a * b + 1` against the frame rate, sets the frame count, so the video and the
  sound cannot disagree. A clip shorter than the window is padded and the model
  generates the tail — `LTXVConcatAVLatent` does that itself.
- **`ace-step-song` sets its length in two places on purpose.** The text encoder
  is told the duration so it writes an arrangement that fits, and the empty
  latent is told so there is somewhere to put it; both read one
  `PrimitiveFloat`, as the official template wires them, so they cannot drift
  apart. Its seed works the same way.
- `ltx2-i2v` needs a recent ComfyUI: the LTX-2.3 classes it uses
  (`LTXAVTextEncoderLoader`, `LTXVConcatAVLatent`, `LTXVImgToVideoInplace` and
  the rest) arrived with the model.
