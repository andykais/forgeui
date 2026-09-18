# Design — audio: speech, voices, and sound for video

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §6.3, §7.1, §9, §11.2, §11.4, §12.
**Already decided:** custom nodes are acceptable. They must be installed by
the `Containerfile` and documented in the README.
**Goal behind the goal:** generated speech and song, used in generated video.

---

## 0. Summary

ForgeUI becomes able to generate speech and song, and to treat the result as a
first-class one — so that a line of dialogue or a chorus can be written,
generated, auditioned, and then carried into an LTX video that is lip-synced
to it.

Four workflows ship:

| Workflow | What it does | Custom nodes | Models |
| --- | --- | --- | --- |
| `breeze-tts-clone` | Speech in a cloned voice. Takes a reference clip, that clip's exact transcript, and the text to speak. | `ComfyUI-Breeze-TTS-2` | `Breeze-TTS-2-int8-hybrid` (or another of the four builds) |
| `breeze-tts-design` | Speech in a voice described in words — no reference clip. | `ComfyUI-Breeze-TTS-2` | `Breeze-TTS-2-int8-hybrid` |
| `ace-step-song` | A song: style tags plus lyrics, sung, with backing. | none — core nodes | `acestep_v1.5_xl_turbo_bf16`, `qwen_0.6b_ace15`, `qwen_4b_ace15`, `ace_1.5_vae` |
| `ltx2-ia2v` | An image plus an audio take, returning video lip-synced to it. | none — core nodes | `ltx-2.3-22b-dev-fp8`, `gemma_3_12B_it_fp4_mixed`, `ltx_2.3_22b_distilled_1.1_lora`, `ltx-2.3-spatial-upscaler-x2-1.1` |

The first two are text-to-speech and differ only in where the voice comes
from. The third sings. The fourth is the point of the other three: it takes a
take made by any of them and makes video that matches it.

Only the speech workflows need anything that is not already in ComfyUI. The
LTX models are the ones `ltx2-i2v` already uses, so that row costs no new
downloads.

The work divides into four parts, in this order:

1. **Audio as a result** — a third `kind` beside `image` and `video`, with a
   tile, a player, and a place in the gallery.
2. **Audio as an input** — the content-addressed input store (§9) learns to
   take sound, so a reference clip can be attached the way a picture is.
3. **The generation workflows** — two speech, one song; the speech pair
   needs a custom node pack installed by the container, the song does not.
4. **Sound in video** — a fourth workflow takes an image and a generated
   take and returns video that is lip-synced to it.

Three findings shaped this, all verified against the pinned ComfyUI
(`v0.34.0`), its official workflow templates, and this repository:

- **LTX-2.3 lip-syncs to an audio track you give it**, in the open-weights
  model, with core nodes. There is an official template for it —
  `video_ltx2_3_ia2v`, "LTX-2.3: Image Audio to Video" — and it differs from
  the graph this repo already ships by four nodes (§3).
- **The database needs no migration.** `outputs.kind` and `inputs.kind` are
  plain `TEXT`, and every dimension column is already nullable; one additive
  column carries a clip's duration, and the waveform is a file rather than a
  row (§5).
- **There is one integration bug waiting.** ComfyUI reports audio files under
  a key this app does not read, so an audio workflow would run, succeed, and
  be reported as having produced nothing (§4.1).

---

## 1. The speech model: two candidates

Only speech is a choice. The song model was named — ACE-Step 1.5, MIT, and
already supported in core ComfyUI (§2.1.1) — and LTX is the video model this
app already runs. This section is about the two TTS candidates only.

**Breeze-TTS-2 is the one to integrate.** Licensing is not a constraint here —
LTX already carries its own — and 7 GiB is affordable on this machine, because
jobs run one at a time: ForgeUI serialises the queue and ComfyUI frees a model
between prompts, so the TTS model and the video model never need to be
resident together.

With those two off the table, what is left favours Breeze:

| | **Breeze-TTS-2** | **Qwen3-TTS** |
| --- | --- | --- |
| Weights | 3B | 0.6B and 1.7B |
| Peak VRAM | 5.3–7.5 GiB; 4.5 GiB for the int8-hybrid build | smaller, not published |
| Voice cloning | reference clip + its exact transcript | reference clip + its exact transcript |
| Voice design | yes, from a natural-language description | yes, via a separate `VoiceDesign` checkpoint |
| Languages | English and Chinese | 10, incl. English |
| Extras | voice direction, 8-speaker dialogue, inline vocal events | — |
| Licence (weights) | BreezeBlue Research and Non-Commercial | Apache 2.0 |

The two workflows asked for map straight onto Breeze's two modes, and its
node pack covers both plus a Whisper helper for §7. A bigger model on a
machine that can hold it is the better default for quality; ten languages is
not worth anything to an English-and-Chinese user today.

**Qwen3-TTS stays on the list as a second family, not a fallback.** Adding it
later is two more workflow directories and no app code, because the param
panel does not know what a TTS model is. Its 0.6B is the one to reach for if
TTS ever does need to sit alongside a resident video model.

**Neither pack is official.** There is no ComfyUI-org or BreezeBlue node pack
for either model — everything on offer is third-party. The one this design
assumes is the one you named:

```
https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2   (Apache-2.0 node code)
```

It registers seven nodes — Load Model, Voice Clone, Voice Design, Voice
Direction, Whisper Transcribe, Speaker, Multi-Speaker — and downloads weights
to `ComfyUI/models/breezetts2/` on first use, with four build options
(bf16 combined, int8-hybrid, int8 all-linears, int8 text-encoder-only). That
being unofficial is the reason §6 pins a commit and §4.6 asks for a missing-node
check: an unofficial dependency that moves under you is the most likely source
of a workflow that stopped working.

**What I could not verify.** Node *class* names — the ids that go in
`workflow.api.json` — are not documented; the README lists display names. The
graphs must be authored against `/object_info` on the machine with the pack
installed, the same way the LTX-2.3 graph was. Treat every TTS node id in this
document as illustrative.

---

## 2. How the user interacts with audio

### 2.1 Generating it

Audio workflows appear in the same list as everything else, and the param
panel is built from the manifest exactly as it is today. Nothing about the
Generate screen changes structurally. What a user sees:

**Voice clone**

```
reference voice   [ drop a clip, or pick a result ]     ← audio param
transcript        [ what the reference clip says  ]     ← text param
text              [ what you want it to say       ]     ← text param
seed              [ 1234567  🔒 ]
```

**Voice design**

```
voice             [ an older man, warm, unhurried, faint Irish accent ]
text              [ what you want it to say ]
seed              [ 1234567  🔒 ]
```

**A song (ACE-Step 1.5)**

```
style             [ neo-soul, live drums, warm rhodes, female vocal ]
lyrics            [ [verse] … [chorus] …            ]
duration          [ 120 ] seconds   bpm [ 120 ]   key [ C major ]
language          [ en ]            time signature [ 4 ]
model             [ acestep_v1.5_xl_turbo_bf16 ]
seed              [ 1234567  🔒 ]
```

None of the three has a size row — they declare no `size` param, and the panel
already only renders what the manifest declares. The two speech workflows
declare no `model` param either, for reasons covered in §4.4; the song one
does, because its checkpoint is an ordinary single file.

**How delivery is controlled.** Two mechanisms, and they are not
interchangeable:

| What | How | Where |
| --- | --- | --- |
| A laugh, a cough, a sigh, a throat-clear | **inline in the text**, in parentheses: `(sigh) It is good to hear your voice again.` Chinese uses square brackets: `[叹气]` | the `text` param of either workflow — it is only text, so it costs nothing |
| Pauses and emphasis | punctuation and line breaks in the same text | same |
| Tone, emotion, pace, delivery | a **separate instruction**, e.g. "Speak slowly with a restrained, serious tone." | `voice` in the design workflow; a `direction` toggle in the clone workflow |

Design already has somewhere to put tone, because its whole input is a
description of a voice — "an older man, warm, unhurried" is a delivery
instruction as much as a timbre. Cloning does not: the Voice Clone node runs
at CFG 1.0 and takes no instruction, because the reference is the voice.

Breeze's answer to that is a third node, **Voice Direction**, which is
"clone this voice *and* deliver it like this", at CFG 4. Rather than a third
workflow, the clone workflow should carry it as an option:

```
reference voice   [ drop a clip, or pick a result ]
transcript        [ what the reference clip says  ]
text              [ (sigh) what you want it to say ]
direct the read   [x]                                   ← bool param
instruction       [ slowly, restrained, serious ]        ← when direct is on
seed              [ 1234567  🔒 ]
```

That is the `when` pattern this repo already has, with a `ComfySwitchNode`
picking Voice Clone or Voice Direction — the same shape as `ltx2-i2v`'s
optional distilled LoRA, including the lazy evaluation that keeps the
unselected branch from running.

### 2.1.1 The song workflow, in more detail

`ace-step-song` is the odd one out in three useful ways.

**It needs no custom nodes.** ACE-Step 1.5 is supported in core ComfyUI —
`TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `VAEDecodeAudio` —
and ships with official templates for every variant. The bundled workflow
should follow `audio_ace_step1_5_xl_turbo` — a graph of eight nodes, with
separate UNet, dual-CLIP and VAE loaders.

**Its models are ordinary library models.** Single `.safetensors` files in
the folders the library already scans, so they are hashed, tagged and picked
exactly like a diffusion checkpoint, and the workflow gets a real `model`
param. Nothing in §4.4's argument about TTS weights applies to it.

**Its params are musical, not visual.** `TextEncodeAceStepAudio1.5` takes
tags, lyrics, bpm, duration, time signature, language and key scale, with
sampler knobs behind Advanced (`cfg_scale`, `temperature`, `top_p`, `top_k`,
`min_p`, and `generate_audio_codes` — an LLM pass that raises quality and
costs time). Duration is set in two places that must agree: the text encoder's
`duration` and `EmptyAceStep1.5LatentAudio`'s `seconds`. One param, two binds
— which the manifest format already supports, and which `ltx2-i2v` already
does for its checkpoint.

**Which build: the 4B XL turbo, split.** ACE-Step 1.5 ships a 2B line and a
4B XL line, each in base / SFT / turbo, plus separate 0.6B, 1.7B and 4B
language models. The XL models want ~20 GB without offloading, which a 5090
has, so there is no reason to take the smaller one. Turbo over base because
the official templates run it at 8 steps and CFG 1 against base's 50 steps and
CFG 6 — six times the work for a difference nobody has measured here yet.

Four files rather than one:

```
UNETLoader      acestep_v1.5_xl_turbo_bf16.safetensors
DualCLIPLoader  qwen_0.6b_ace15.safetensors + qwen_4b_ace15.safetensors  (type: ace)
VAELoader       ace_1.5_vae.safetensors
```

The split layout is also the more useful one for this app: the language model
is the quality-for-VRAM dial, so having it as its own picker means dropping to
the 1.7B is a change in a dropdown rather than a different workflow. The
all-in-one checkpoint (`ace_step_1.5_turbo_aio.safetensors`, 2B) stays worth
knowing about as the small-machine option. The licence is MIT.

**Singing in a cloned voice is out of scope**, as agreed. Worth recording
where the thread is picked up if that changes: core ComfyUI has
`ReferenceTimbreAudio` ("Set Reference Audio"), an experimental node that
feeds a reference latent into ACE-Step 1.5's conditioning. That is the hook —
a different workflow, with its own questions about clip length and how much
identity actually transfers.

### 2.2 The result

An audio output is a row in the same grid as images and videos. The problem
it brings is that a grid is built on pictures, and sound has none.

**The tile** shows a waveform, the duration, and the first line of the text
that was spoken. The waveform is what makes a grid of speech scannable — a
three-second line and a thirty-second paragraph should not look alike, and
silence at the front of a take should be visible before it is audible.

**And a tone line above it, in a colour the waveform shares** (§11.5 below).
The waveform alone turned out to be scannable for length and not for anything
else: forty takes of speech are forty grey hedges, and what actually
distinguishes them — the voice, the direction, the style tags — is the one
thing an amplitude plot cannot draw. So the tile says it three ways, each
once:

- **above the waveform**, the tone as text, one line, ellipsised. Drawn by
  the tile rather than baked into the PNG, so it stays crisp at every tile
  size and follows an edited prompt without redrawing a file;
- **the waveform itself**, drawn in a colour picked from that tone. Takes of
  one voice come out one hue whatever the words are, so a grid groups by ear
  without being read;
- **below, in the strip that was already there**, the words. Unchanged.

The hue is picked from the tone and never from the prompt. Colouring by the
words would give a single voice a different colour every take, which is the
opposite of the grouping this is for. Ten muted hues (`src/media/tone.ts`)
rather than a full wheel: forty saturated tiles is a bag of sweets, and the
hue only has to say "same" or "not the same".

A take with no tone — an old row, an uploaded clip, a workflow that does not
say where its tone lives — keeps the grey it always had and shows no line.

**Where the waveform comes from: ffmpeg, at completion.** ffmpeg is a
reasonable thing for this stack to require — it is one apt package, every
machine that runs ComfyUI has room for it, and it removes three problems at
once:

- the waveform is **a PNG file beside the audio**, drawn once by
  `ffmpeg -filter_complex showwavespic`, so the tile and the viewer are an
  `<img>` and nothing more. No peaks format, no write-back endpoint, no
  canvas drawing, no "not computed yet" state after the first second;
- `ffprobe` gives the **duration** of both outputs and uploaded clips, so the
  input probe (§4.3) is a subprocess call rather than a set of hand-written
  container parsers;
- it is the same answer for every codec, including the ones a browser's
  decoder is patchy on.

The file is `<output path>.waveform.png` — a sibling, by convention, so it
needs no column and no migration. It is drawn in one colour on transparency
so the one image reads in both themes, and it is deleted with the output
(`remove()` in `src/outputs/store.ts:343` gains a third path).

If ffmpeg is missing — a dev box, not the container — the waveform is simply
absent and the tile falls back to the duration on a plain plate. Missing
ffmpeg must never fail a generation.

**The viewer** replaces the image element with a transport: waveform, a
playhead, a scrub bar, play/pause on space, and the duration. The existing
rules carry across where they make sense and are dropped where they do not:

- audio autoplays on open, as video does;
- `f` for fullscreen is meaningless and is not bound;
- **Upscale is absent** — not disabled, absent. There is no upscale workflow
  for audio and there is no plan for one, so the action should not be in the
  sidebar at all for an audio output (`upscalersFor` already returns an empty
  list when nothing matches, which hides it);
- **Generate again** and **Reuse parameters** work unchanged;
- there is **no volume control**. This is a local app on a machine with a
  system mixer.

**The gallery** gains a third chip beside Image and Video. Search already
matches the prompt, which for a TTS workflow is the spoken text — so searching
"we're closed" finds the take that says it. That falls out for free and is
worth not breaking.

### 2.3 Audio as an input

The reference clip for voice cloning is attached the same way a picture is:
drop it, pick it from a file dialog, or drag a previous result onto the field.
It lands in the content-addressed input store (§9) and is uploaded to ComfyUI
on submit — both paths already work for any file type (§4.3).

Two differences from an image input:

- **No paste.** Clipboards rarely hold audio, and the paste-while-hovering
  behaviour has nothing to catch.
- **It shows a player, not a thumbnail.** An attached clip must be
  auditionable in place — the whole question about a reference voice is what
  it sounds like.

---

## 3. How the user uses audio in video workflows

This is the goal, so it gets the most precision.

**Correction to an earlier draft of this document, which said LTX would carry
our audio but not lip-sync to it. That was wrong.** LTX-2.3 generates video
that is lip-synced to an audio track you supply, in the open-weights model,
with nodes that ship in ComfyUI `v0.34.0`. There is an official workflow
template for it: `video_ltx2_3_ia2v`, "LTX-2.3: Image Audio to Video".

### 3.1 What the bundled graph does today

`ltx2-i2v` is audio-visual already: an *empty* audio latent is concatenated
with the video latent and the two are denoised together, so the sound it
produces is the sound it imagined for the scene it drew.

```
LTXVEmptyLatentAudio ──┐
                       ├─ LTXVConcatAVLatent ─ SamplerCustomAdvanced ─ LTXVSeparateAVLatent ─→ video ─┐
EmptyLTXVLatentVideo ──┘                                                            └────────→ audio ─┤
                                                                                                     ▼
                                                                         CreateVideo(images, audio) → SaveVideo
```

### 3.2 What the audio-to-video graph does instead

The supplied audio is encoded into an audio latent, **masked so the sampler
keeps it rather than regenerating it**, and concatenated with the video latent
in its place. The model then has to draw a video that fits the sound — which
is what makes the mouth match.

```
LoadAudio → TrimAudioDuration → LTXVAudioVAEEncode ─┐
                                                    ├─ SetLatentNoiseMask ─┐
                              SolidMask(value = 0) ─┘                      │
                                                                           ├─ LTXVConcatAVLatent → sampler → …
                                         LTXVImgToVideoInplace(image) ─────┘
```

The whole delta from the graph already in this repo is four nodes —
`LoadAudio`, `TrimAudioDuration`, `LTXVAudioVAEEncode`, `SetLatentNoiseMask`
(plus a `SolidMask`) — replacing one, `LTXVEmptyLatentAudio`. Everything
downstream is unchanged: the same two-pass half-res-then-upsample structure,
the same guiders, the same `CreateVideo` → `SaveVideo`.

Two details worth stating, both taken from the official template:

- **`SolidMask` has value `0`.** In ComfyUI a noise mask of 1 means "generate
  this", 0 means "keep it". Zero is what pins the supplied audio.
- **`LTXVConcatAVLatent` is built for this.** Its own code describes fitting
  an audio stream "to the length of the one it replaces", and zero-pads a
  short clip with mask `1` so the model generates the tail. A clip shorter
  than the video is handled, not an error.

This is a **separate bundled workflow**, `ltx2-ia2v`, as asked — not a
variant of `ltx2-i2v` behind a `when`. The two have different inputs, different
lengths, and different reasons to exist; the shared graph would be mostly
branches. In the panel:

```
image             [ the first frame ]                   ← image param
audio             [ a take from the gallery ]           ← audio param · 11.4s
duration          [ 9 ] seconds        start [ 0 ]
prompt            [ what is happening in the shot ]
size              [ 1280 × 720 ]   fps [ 24 ]
seed              [ 1234567  🔒 ]
```

Both media params accept a drag from the results grid, so the ordinary path is:
generate the line, generate or pick the frame, drag both in.

### 3.3 Length: the audio decides it

The official template derives the frame count from the audio, and this is
worth copying exactly:

```
frames = duration × fps + 1      (ComfyMathExpression "a * b + 1")
```

`TrimAudioDuration(start_index, duration)` trims the clip to the same window.
So the user sets a **duration in seconds** and a **start offset**, and the
video length follows from them. Nothing has to reconcile a frame count against
a clip length, and there is no silent adjustment of a field the user set — the
duration *is* the field.

The panel should show the attached clip's own duration beside that input, so
"9 seconds" can be checked against "the clip is 11.4s" without opening it.

### 3.4 Two further capabilities, noted and not built

- **`LTXVModalityGuidance`** ("A/V coupling") runs an extra pass per step with
  the audio↔video cross-attention severed and guides toward the coupled
  prediction; its own description names lip-sync as the thing it strengthens.
  Reference default is 3.0. The official ia2v template does **not** use it. If
  sync is weak in testing, this is the first knob to reach for, and it can be
  added to the graph later without changing anything in the app.
- **`LTXVReferenceAudio`** ("ID-LoRA") is a different feature that is easy to
  confuse with cloning: it transfers a *speaker identity* into the audio LTX
  generates itself, from a ~5-second reference. It is the subject of another
  official template, `video_ltx2_3_id_lora`. Worth knowing about; not part of
  this design, because the voice we want is the one Breeze made.

---

## 4. New primitives

Six. Four are small; two are real work.

### 4.1 `audio` as a `WorkflowKind`

`WORKFLOW_KINDS` becomes `["image", "video", "audio"]`
(`src/workflows/types.ts:68`). Manifests can declare `kind: audio`, outputs
can be filed as audio, and the frontend's eight `kind === "video"` branches
become three-way.

**The bug this uncovers.** ComfyUI reports saved files under a different key
per media type. `outputImages()` reads `images`, `gifs` and `videos`
(`src/comfy/events.ts:118`), and every audio save node reports under `audio`
(`comfy_api/latest/_ui.py:65`). Until that key is read, an audio workflow
finishes successfully and the app says *"ComfyUI finished without writing any
files"*. One line, invisible until the first run.

`kindFor()` (`src/jobs/completion.ts:75`) also needs the audio extensions —
`.flac`, `.mp3`, `.opus`, `.wav` — for the fallback path where a manifest
does not declare its output kind.

### 4.2 An `audio` param type

`MediaParam` is already `"image" | "mask" | "video"`
(`src/workflows/types.ts:253`); `audio` joins it. The widget
(`AudioParam.svelte`) is `ImageParam.svelte` with the thumbnail replaced by a
player and the paste handler removed.

The binding is identical to an image's. ComfyUI's `LoadAudio` takes a filename
from the input directory exactly as `LoadImage` does, so a manifest says
`bind: "13.audio"` and the existing submit path does the rest.

### 4.3 Audio in the input store

The store itself needs nothing — it is content-addressed by bytes and does not
care what they are. Two things around it are image-shaped:

- **The probe** (`src/inputs/probe.ts`) sniffs PNG, JPEG and WebP magic and
  returns width and height. Audio needs a sibling that returns **duration**
  instead of dimensions, and with ffmpeg in the stack (§2.2) that is one
  `ffprobe` call rather than a hand-written parser per container — which
  matters most for MP3, where the honest alternatives are trusting a VBR
  header or counting frames. It still sniffs the magic bytes to decide the
  extension, because the extension is what the store writes and a `.wav` that
  is really an MP3 breaks ComfyUI at load time, not at upload time.
- **The filename pattern** — `^([0-9a-f]{64})\.(png|jpe?g|webp)$` — appears in
  both `src/jobs/pipeline.ts` and `src/frontend/src/lib/media.ts`. It gains
  the audio extensions, and the two copies should agree.

Uploading needs no work at all: ComfyUI's `/upload/image` is a generic file
writer with no image validation (`server.py:397`), so `client.uploadImage()`
carries a `.wav` unchanged.

### 4.4 Model folders

**There is no top-level audio model folder in ComfyUI, and we should not
invent one.** Audio checkpoints (Stable Audio, ACE-Step) live in
`checkpoints/`, their text encoders in `text_encoders/`, their VAEs in `vae/`.
The only audio-specific key in `folder_paths.py` is `audio_encoders/`, and
nothing in this design uses it: LTX takes its audio VAE from the checkpoint it
already loads. It is what Wan S2V and HuMo would need, so it is worth adding
the day one of those is wanted — as a model kind *and* to the `--models-dir`
list in the `Containerfile`, because omitting the second is what caused the
latent-upscaler failure, where the file was on disk, the folder was not
passed, and the loader offered an empty dropdown.

**ACE-Step needs nothing new.** Its files are ordinary single `.safetensors`
in `checkpoints/`, `text_encoders/` and `vae/` — folders the library already
scans — so they appear on the Models screen like any other model, and the song
workflow gets an ordinary `model` param (§2.1.1).

**Breeze does get a model folder: `breezetts2`.** An earlier draft argued for
keeping it out of the library on the grounds that the scan would fill the
Models screen with tokenizer shards. That was wrong, and reading the pack's
loader settles it. What is on disk per build is:

```
/models/breezetts2/<repo>/Breeze-TTS-2-int8-hybrid.safetensors   4.5 GiB
/models/breezetts2/<repo>/config.json
/models/breezetts2/<repo>/audio_tokenizer/model.safetensors      small
```

One real weights file per build — four of them if all four are pulled, at
4.2–7.5 GiB each — plus one small audio-tokenizer file. That is a handful of
rows, not shard soup, and the big ones are exactly what somebody looking at
the Models screen wants to see: six gigabytes of speech model should not be
invisible to the page whose job is "what is on disk", and the Model Size
telemetry report (§7.1) reads the same scan.

So `breezetts2` goes into `model_folders`, which puts it in the library scan
and writes a `breezetts2:` key into the generated `extra_model_paths.yaml`,
which the pack reads. The one row of noise — `audio_tokenizer/model.safetensors`
— can be hidden from its own page like any other model (§8.1).

**One caveat, and it is about the Generate panel rather than the library.**
The pack's Load Model node does not take a filename: it takes one of four
fixed labels ("int8 hybrid (recommended)", "bf16 (best quality)", …) and
resolves the file itself. So the speech workflows expose an `enum` of those
labels, not a `model` picker, and the Breeze rows on the Models screen are
informational — size, hash, tags, notes — rather than something Generate
selects from. Worth knowing before somebody wonders why the model row and the
param do not line up.

### 4.5 The waveform image

Covered in §2.2. The primitive is: **one PNG per audio file**, drawn by
ffmpeg at completion, named by convention beside the audio, served by the
existing media route, and deleted with its output. An uploaded clip gets the
same treatment for the same reason — the player on an attached reference
should show the shape of what was attached.

What this replaces is worth stating, since an earlier draft proposed it: no
peaks array, no sidecar field for it, no endpoint for the browser to write one
back, and no canvas. A file the server already knows how to serve is less to
build and less to get wrong.

**The colour is chosen when the file is drawn**, from the take's tone (§2.2).
That is the one thing that makes the PNG depend on the job rather than only on
the bytes: `drawWaveform` takes a colour, `media/tone.ts` maps a tone to one,
and the API sends the same hex to the client as `tone_color` so the tile's
tone line and the shape under it cannot drift apart. A take drawn before this
existed stays grey until it is generated again — the picture is a cache of the
audio, and nothing is rewritten to chase a colour.

### 4.5.1 `prompt` and `tone` on a manifest

Two optional manifest fields, because a speech workflow has several text
params and the gallery has to know which is which:

- **`prompt`** names the param holding the words — what a tile captions a
  take with and what search reads. Without it the prompt is guessed as the
  first `text` param, which is right for every image workflow and wrong for
  all three speech ones: `breeze-tts-design` would caption every take with
  its own voice description and never with a word that was said.
- **`tone`** is an ordered list of the params that say what it sounds like.
  A list because a workflow can hold the answer in more than one place —
  `breeze-tts-clone` is directed when Direct the read is on and described by
  its reference transcript when it is not — and the first entry that applies
  (§4.3) and is not empty wins.

Both are validated against the params the manifest declares, and both have to
name a `text` param: pointing `prompt` at a seed would put a number under
every tile.

| Workflow | `prompt` | `tone` |
| --- | --- | --- |
| `breeze-tts-design` | `text` | `voice` |
| `breeze-tts-clone` | `text` | `instruction`, `transcript` |
| `ace-step-song` | `lyrics` | `style` |

### 4.6 A custom-node requirement

The two speech workflows are the first in this repo that cannot run on stock
ComfyUI — `ace-step-song` and `ltx2-ia2v` still can. That is a change to what
the project promises, and it deserves to be visible rather than discovered:

- the manifest gains an optional `requires` field naming the node pack and the
  minimum version;
- the workflow list marks a workflow whose nodes are missing, and the error
  says which pack to install rather than "node type not found";
- the check is against `/object_info`, which the app already fetches.

Without this, a user pulling the repo and running it outside the container
gets an inscrutable ComfyUI error.

---

## 5. Data migrations

**Almost none.** This was checked rather than assumed.

| Store | Change | Migration |
| --- | --- | --- |
| `outputs` | `kind = 'audio'`; `width`/`height` stay null | **none** — `kind` is plain `TEXT` with no constraint, dimensions are already nullable (`schema.sql:22`) |
| `inputs` | `kind = 'audio'`; `width`/`height` null | **none** — same (`schema.sql:78`) |
| `inputs` | duration of a clip | **one additive column**, `duration_ms INTEGER`, nullable |
| `outputs` | duration of a take | **none** — `duration_ms` exists and is currently written as null |
| `outputs` | the tone a take was asked for | **one additive column**, `tone TEXT`, nullable (§2.2) |
| sidecars | `kind: "audio"` | no migration; **validator change** (see below) |
| waveform PNGs | one per audio file, named by convention | **none** — a file beside the audio, not a row (§4.5) |
| `config.yaml` | no new keys | **none** |

So: two migrations. Version 6 adds `inputs.duration_ms`; version 7 adds
`outputs.tone`. Both follow the established shape — additive, nullable, no
backfill, also present in `schema.sql` so a fresh database gets them at
version 1.

`tone` is denormalised out of the params the same way `prompt` is, and like
`prompt` it is derived rather than authoritative: `deno task reindex` rebuilds
it from the sidecar's params and the workflow's manifest, which is why
`reindex` now takes a `manifestFor` resolver. Without one it can still rebuild
every other column — it just leaves the tone lines blank, since a sidecar
alone cannot say which param held the tone.

**The compatibility note that matters more than the migration.** The sidecar
validator rejects any kind that is not `image` or `video`
(`src/jobs/sidecar.ts:183`). It must learn `audio`. Once it has, the
compatibility is one-way: new ForgeUI reads every old sidecar, but an older
build pointed at a data directory containing audio sidecars will reject them
at reindex. That is acceptable and normal, and it should be stated in the
phase notes rather than found.

**Nothing needs backfilling and nothing is rewritten.** Existing outputs keep
their rows, and a missing waveform PNG means "no waveform", which the tile has
to handle anyway for the moment between a file landing and ffmpeg finishing.

---

## 6. What the container and the README gain

Three things: ffmpeg, the node pack, and somewhere for the weights to live.

**ffmpeg.** One line in the existing `apt-get install`, beside `git` and
`curl`. The README should say what it is for — audio waveform thumbnails and
reading clip durations (§2.2) — so nobody wonders why a video app that shells
out to nothing suddenly wants it, and so a non-container install knows to
provide it.

**`Containerfile`.** After ComfyUI's own requirements are installed, clone the
pack at a pinned commit and install its requirements into the same venv:

```dockerfile
ARG TTS_NODES_REPO=https://github.com/<owner>/<pack>.git
ARG TTS_NODES_COMMIT=<sha>

RUN git clone "${TTS_NODES_REPO}" "${COMFY_HOME}/custom_nodes/<pack>" \
    && git -C "${COMFY_HOME}/custom_nodes/<pack>" checkout "${TTS_NODES_COMMIT}" \
    && "${COMFY_HOME}/venv/bin/pip" install --no-cache-dir \
         -r "${COMFY_HOME}/custom_nodes/<pack>/requirements.txt"
```

A commit, not a branch: a custom node pack that moves under you is the most
likely source of "it worked last week". The version is a build arg for the
same reason `COMFY_VERSION` is.

**Where the Breeze weights live.** Read out of the pack's loader rather than
guessed, because the behaviour is in three parts:

- it **searches** `<models_dir>/breezetts2`, any `breezetts2:` key in
  `extra_model_paths.yaml`, and — usefully — `<root>/breezetts2` for every
  models root it can infer from the standard folder keys. Since ForgeUI maps
  `checkpoints/`, `loras/` and the rest to folders under `/models`, it infers
  `/models` and probes `/models/breezetts2` on its own;
- it **registers** `breezetts2` with ComfyUI's `folder_paths` at import;
- it **downloads** to `model_dirs()[0]`, which is always the running
  install's own `ComfyUI/models/breezetts2` — a yaml key does not redirect
  that.

So finding the weights is solved twice over, and only the first download needs
help. A symlink at build time is that help:

```dockerfile
RUN mkdir -p /models/breezetts2 \
    && ln -s /models/breezetts2 "${COMFY_HOME}/models/breezetts2"
```

Downloads then land on the mount, the library scans them there (§4.4), and
nothing is baked into the image — the weights are gigabytes, and an image
should not carry them.

**README.** A subsection under *Running in a container*, covering: that
ffmpeg is required and what for; which pack and pin is installed; where the
weights land and roughly how large the first download is; the licence of the
weights; and — for people not using the container — the manual steps: install
ffmpeg, clone the pack into `custom_nodes/`, `pip install -r requirements.txt`
into ComfyUI's venv, restart ComfyUI.

**Tests.** The existing `tests/unit/container_test.ts` holds the Containerfile
to the model-kind list and to the README. It should also hold it to the node
pin and to ffmpeg, so a pack added without a documented commit — or an
`apt-get` line that loses ffmpeg in a rebase — fails a test rather than a
generation months later.

---

## 7. Auto transcript — explored, not built

Voice cloning needs the exact words of the reference clip. Both candidate
models require it, and both node packs ship a Whisper transcription node to
produce it — `Breeze TTS 2 Whisper Transcribe` in the pack this design uses,
and an equivalent in every Qwen pack. So the capability is already in the
box — what phase 1 declines is wiring it into the UI.

There are two ways it could work, and they are not the same feature:

1. **A node in the graph.** The reference clip goes to a transcriber whose
   output feeds `ref_text`, and the transcript param disappears from the
   panel. Simplest to build — one extra node, one fewer param. The cost is
   that the user never sees the transcript, so when cloning is poor because
   the transcription was wrong, there is nothing to look at and nothing to
   correct.
2. **A fill-in action beside the field.** The transcript stays a normal text
   param. Attaching a clip offers *Transcribe* next to it; pressing it runs a
   small transcription job and writes the result into the field, where it can
   be corrected before generating.

**Option 2 is the one to build**, when it is built. It matches how this app
already behaves — the size row still lets you overrule what an attached image
suggested; the LoRA `+` puts a value in a field rather than acting on your
behalf. A transcript is exactly that shape: a value the machine can propose
and the human should be able to fix. It needs one thing the app does not have
yet: a way to run a small utility job whose result is a *value*, not an
output. That is a genuine new concept and the reason this is not phase 1.

Practical notes for whoever picks it up: Whisper needs its own weights
(another model folder, another download); transcription of a 5–10 second
reference is fast enough to feel synchronous; and the transcript must be
verbatim including filler words, which is a Whisper prompting detail worth
testing before trusting.

---

## 8. Phasing

**Phase 1 — audio exists.**

1. Read `ui.audio` from ComfyUI's outputs; add `audio` to `WorkflowKind` and
   the extension sniffing (§4.1). Without this nothing else is testable.
2. ffmpeg in the container; the waveform PNG at completion; the audio tile,
   the player in the viewer, the gallery chip (§2.2, §6).
3. The `audio` param, the `ffprobe` duration probe, the input-store
   extensions (§4.2, §4.3).
4. The node pack and the `breezetts2` model folder in the `Containerfile`,
   and the README section (§4.4, §6).
5. Three bundled workflows: `breeze-tts-clone`, `breeze-tts-design`, and
   `ace-step-song`.
6. One bundled workflow: `ltx2-ia2v`, image plus audio to lip-synced video
   (§3.2).

**Deliberately not in phase 1:** auto transcript (§7), singing in a cloned
voice (§2.1.1), `LTXVModalityGuidance` and `LTXVReferenceAudio` (§3.4),
Qwen3-TTS as a second family (§1), audio-driven video from other model
families (Wan S2V, HuMo).

**A suggested first cut.** Steps 1 and 5 are the smallest end-to-end proof:
one workflow, one result, played back with the browser's default controls.
`ace-step-song` is the one to start with, because it needs no custom nodes —
the whole audio path can be proved before the container grows a dependency.
Everything in step 2 is easier to judge once there is a real take to look at.
Step 6 is worth doing early anyway, before the polish in step 2 — it is the
step that proves the point of all of this, and it can be tested by hand in
ComfyUI with a clip from anywhere.

---

## 9. Open questions

Six of the original nine were answered in review and are now decisions in the
text above: ffmpeg draws the waveform (§2.2), Upscale is absent for audio and
Generate again stays (§2.2), there is no volume control (§2.2), the Breeze
weights reach `/models` by symlink (§6), the song workflow takes the 4B XL
turbo (§2.1.1), and `ltx2-ia2v` writes only the video (§3.2).

What is left:

1. **Which Breeze build?** int8-hybrid (4.5 GiB, claimed to match bf16) or
   bf16 combined (6.5 GiB, fastest). A run of each on the same line of text
   settles it; the README quotes whichever is pinned.
2. **Is lip-sync good enough out of the official ia2v graph**, or does it want
   `LTXVModalityGuidance` (§3.4)? Testable in ComfyUI before any app code is
   written, with any audio clip at all.
3. **How should the waveform be coloured** so one PNG reads on both themes?
   A mid-tone at partial opacity is the cheap answer; two files, one per
   theme, is the thorough one and probably not worth it.
4. **Does the clone workflow's `direction` toggle earn its place**, or is
   Voice Direction different enough to be its own workflow? Depends on whether
   a directed clone at CFG 4 sounds like the same feature as a clone at CFG 1.
   A listening question, not a design one.
