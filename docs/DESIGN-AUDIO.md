# Design — audio: speech, voices, and sound for video

**Status:** proposal. Nothing here is implemented.
**Touches:** DESIGN.md §3.1, §4.2, §6.3, §7.1, §9, §11.2, §11.4, §12.
**Already decided:** custom nodes are acceptable. They must be installed by
the `Containerfile` and documented in the README.
**Goal behind the goal:** generated speech, used in generated video.

---

## 0. Summary

ForgeUI becomes able to generate speech and treat it as a first-class result,
so that a line of dialogue can be written, generated, auditioned, and then
carried into an LTX video.

Two workflows ship:

| Workflow | What the user gives it | What it is for |
| --- | --- | --- |
| **Voice clone** | a reference clip, the exact transcript of that clip, and the text to speak | making one specific voice say something |
| **Voice design** | a description of a voice ("older man, warm, unhurried"), and the text to speak | making a voice that does not exist yet |

Both are text-to-speech. They differ only in where the voice comes from.

The work divides into four parts, in this order:

1. **Audio as a result** — a third `kind` beside `image` and `video`, with a
   tile, a player, and a place in the gallery.
2. **Audio as an input** — the content-addressed input store (§9) learns to
   take sound, so a reference clip can be attached the way a picture is.
3. **The two TTS workflows**, on a custom node pack installed by the
   container.
4. **Sound in video** — the generated speech is muxed onto an LTX render.

Three findings shaped this, all verified against the pinned ComfyUI
(`v0.34.0`) and this repository:

- **The database needs no migration.** `outputs.kind` and `inputs.kind` are
  plain `TEXT`, and every dimension column is already nullable (§5).
- **There is one integration bug waiting.** ComfyUI reports audio files under
  a key this app does not read, so an audio workflow would run, succeed, and
  be reported as having produced nothing (§4.1).
- **LTX-2.3 will carry our audio, but it will not lip-sync to it.** The
  existing graph already has the seam where a track can be substituted;
  driving the picture *from* the audio is a different model family (§3).

---

## 1. The two candidates

Both were asked for by name. Both do the job. They differ most in licence,
size, and language coverage.

| | **Qwen3-TTS** | **Breeze-TTS-2** |
| --- | --- | --- |
| Weights | 0.6B and 1.7B | 3B |
| Licence (weights) | Apache 2.0 | BreezeBlue Research and Non-Commercial |
| Languages | 10, incl. English | English and Chinese |
| Voice cloning | reference clip + its transcript | reference clip + its transcript |
| Voice design | yes, a separate `VoiceDesign` checkpoint | yes, same checkpoint |
| Peak VRAM | not published; 0.6B is a 2.5 GB download, 1.7B is 4.5 GB | 5.3–7.5 GiB, or 4.5 GiB for the int8-hybrid build |
| ComfyUI nodes | several third-party packs, none canonical | one well-developed pack |
| Extras | — | voice direction, multi-speaker dialogue, inline vocal events |

**Recommendation: integrate Qwen3-TTS first.** Three reasons, in order of
weight:

1. **Licence.** Apache 2.0 covers the weights. Breeze's weights are
   research/non-commercial, which is probably fine for a personal tool but
   puts a condition on a repository that ships bundled workflows pointing at
   them. A default should not carry that.
2. **VRAM.** This machine already runs out of memory on LTX past eight
   seconds at 2720×1536. A 0.6B speech model that costs ~2 GB is a very
   different neighbour to a 3B one that wants 5–7 GiB, and TTS will often be
   run in the same session as a video render.
3. **Languages.** Ten against two. It costs nothing now and avoids a rebuild
   later.

**Breeze-TTS-2 stays on the list as a second family, not a fallback.** Its
node pack is the better piece of software — voice direction and an
eight-speaker dialogue node are genuinely ahead of what the Qwen packs offer —
and its cloning is reported to be strong. The manifest format is what makes
this cheap: adding Breeze later is two more workflow directories and no app
code, because the param panel does not know what a TTS model is. If the Qwen
output quality disappoints in testing, swapping the default is a workflow
change, not a redesign.

**What I could not verify.** Node *class* names (the ids that go in
`workflow.api.json`) are not reliably documented in any of these packs;
READMEs list display names. The graphs must be authored against
`/object_info` on the machine that has the pack installed — the same way the
LTX-2.3 graph was built. Treat every node id in this document as
illustrative.

**Which pack.** For Qwen3-TTS there are at least five. They need comparing on
the machine before one is pinned; the selection criteria should be: exposes
cloning *and* design, accepts an `AUDIO` input rather than only a file path,
puts its weights somewhere configurable, and has a licence compatible with
being named in our README. Pinning a commit is required either way (§6).

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

Neither has a size row — they declare no `size` param, and the panel already
only renders what the manifest declares. Neither declares a `model` param
either, for reasons covered in §4.4.

### 2.2 The result

An audio output is a row in the same grid as images and videos. The problem
it brings is that a grid is built on pictures, and sound has none.

**The tile** shows a waveform, the duration, and the first line of the text
that was spoken. The waveform is what makes a grid of speech scannable — a
three-second line and a thirty-second paragraph should not look alike, and
silence at the front of a take should be visible before it is audible.

**Where the waveform comes from** is the one genuinely new piece of
engineering in this design. Three options were considered:

| Approach | Cost | Verdict |
| --- | --- | --- |
| Decode server-side, store peaks | needs an audio decoder; there is no ffmpeg in the container and Deno has none | rejected — a new binary dependency for a thumbnail |
| Decode in the browser per tile | free (WebAudio has the codecs) but re-downloads and re-decodes the whole file per tile | rejected — a gallery of 100 takes is unusable |
| Decode in the browser **once**, persist the peaks | one decode per output, ever | **chosen** |

The peaks are ~200 min/max pairs — under 1 KB as a JSON array. They belong in
the output's sidecar, next to the params, which keeps them out of the database
and makes them survive a reindex. The viewer computes them on first open and
writes them back through a small endpoint; a tile with no peaks yet draws a
flat placeholder and the duration. This mirrors how video thumbnails already
work: the browser has the codecs, so the browser does the work.

**The viewer** replaces the image element with a transport: waveform, a
playhead, a scrub bar, play/pause on space, and the duration. The existing
rules carry across where they make sense and are dropped where they do not —
audio autoplays on open like video does, and `f` for fullscreen is meaningless
and is not bound.

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

This is the actual goal, so it gets the most precision.

### 3.1 What the LTX-2.3 workflow does today

The bundled `ltx2-i2v` graph already generates sound. It is an audio-visual
model: an empty audio latent is created, concatenated with the video latent,
and the two are denoised together, so the sound it produces is the sound of
the scene it drew.

```
LTXVEmptyLatentAudio ─┐
                      ├─ LTXVConcatAVLatent ─ SamplerCustomAdvanced ─ LTXVSeparateAVLatent ─┐
EmptyLTXVLatentVideo ─┘                                                                     │
                                          ┌─ video latents → VAEDecode → images ────────────┤
                                          └─ audio latent  → LTXVAudioVAEDecode → audio ────┤
                                                                                            ▼
                                                                        CreateVideo(images, audio) → SaveVideo
```

The important node is the last one. `CreateVideo` takes an `audio` input
(`workflow.api.json` node 49). That is the seam.

### 3.2 Three ways to get our speech into a video

| | How | Lip-sync | Effort |
| --- | --- | --- | --- |
| **A. Mux** | attach the generated speech as an audio param; it replaces LTX's own track at `CreateVideo` | none | one new bundled workflow |
| **B. Condition the AV latent** | encode our speech with `LTXVAudioVAEEncode` and pass it to `LTXVConcatAVLatent` instead of the empty latent | unknown | an experiment first |
| **C. An audio-driven model** | Wan S2V / HuMo — `AudioEncoderLoader` → `AudioEncoderEncode` → `WanSoundImageToVideo` | yes, by design | a new family and a new model folder |

**Phase 1 does A.** It is small, it cannot fail in an interesting way, and it
covers the common case: narration, a voice-over, a line of dialogue on a shot
where the speaker is not in frame or not in close-up.

**B is a question, not a plan.** `LTXVAudioVAEEncode` exists and produces an
audio latent from real audio, so the graph *can* be wired that way. Whether
the sampler preserves what it is given depends on the sigma schedule over the
audio half of the latent: at full noise it is an init latent and gets
overwritten, exactly like img2img at denoise 1.0. LTX-2.3 is a joint AV model,
not an audio-driven one, so the honest expectation is that this produces
"video that ignores your audio". It is a half-day experiment and worth doing
before anyone designs around it.

**C is the real lip-sync answer** and is out of scope here. Worth noting for
sequencing: it needs the `audio_encoders` model folder, which §4.4 adds
anyway, so the groundwork lands either way.

### 3.3 Length

A video is a frame count. Speech is however long the sentence takes. Muxing a
nine-second line onto a five-second render truncates it, and there is no way
for the workflow to know which of the two the user meant.

The panel should **show the attached clip's duration next to the length
field** — and stop there. Following the decision already made for image size:
show what would match, never silently change what the user set. If it turns
out to be tedious, a "match the clip" button next to the length field is the
smallest thing that fixes it, and it is still the user pressing it.

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
  returns width and height. It needs an audio sibling that recognises `RIFF`,
  `fLaC`, `OggS`, `ftyp` and MPEG frame headers, and returns **duration**
  instead of dimensions. Reading duration from a container header is
  straightforward for WAV and FLAC and fiddly for MP3 (it means either
  trusting a VBR header or counting frames); the browser knows it anyway from
  the `<audio>` element, so the probe may reasonably return `null` and let the
  client fill it in.
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
The only audio-specific key in `folder_paths.py` is `audio_encoders/`, used by
Wan S2V and HuMo.

**One addition to `DEFAULT_MODEL_KINDS`** (`src/config/defaults.ts:13`):
`audio_encoders`. It is a real ComfyUI key, its contents are single
`.safetensors` files loaded through `folder_paths`, and it is what §3.2 option
C needs. It must also be added to the `--models-dir` list in the
`Containerfile` — skipping that step is what caused the latent-upscaler
failure, where the model was on disk, the folder was not passed, and the
loader offered an empty dropdown.

**The TTS weights are a different shape, and should not become a model kind.**
A TTS checkpoint is a *directory* — sharded weights, a tokenizer, an audio
codec — and the node pack downloads it itself on first use. Adding a `TTS` key
to `model_folders` would have a side effect that is easy to miss: that config
drives two things at once, the generated `extra_model_paths.yaml` *and* the
library scan, and the scan takes every `.safetensors` and `.bin` it finds
(`src/models/scan.ts:33`). The Models screen would fill up with tokenizer
shards presented as models.

So, for phase 1:

- the TTS weights live on the `/models` mount at the path the pack expects,
  put there by the container rather than by config;
- the TTS workflows declare **no `model` param**, so the model-presence check
  does not apply to them — it only iterates declared model params;
- nothing about TTS appears on the Models screen.

If a second TTS family arrives and picking between them becomes a real choice,
the clean fix is to let a model kind be *unscanned*: written to
`extra_model_paths.yaml` for ComfyUI, skipped by the library. That is a small
change to one function and is not needed yet.

### 4.5 Waveform peaks

Covered in §2.2. The primitive is: a short array of min/max pairs, computed
once in the browser, stored in the output's sidecar, read by the tile and the
viewer. It needs a write path (`POST /api/outputs/:id/peaks` or a field on the
existing patch route) and a decision about whether an input clip gets the same
treatment — it should, for the same reason.

### 4.6 A custom-node requirement

This is the first workflow that cannot run on stock ComfyUI. That is a change
to what the project promises, and it deserves to be visible rather than
discovered:

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
| sidecars | `kind: "audio"`, plus peaks | no migration; **validator change** (see below) |
| `config.yaml` | two new model folders | **none** — new keys are merged into an existing config on launch |

So: one migration, version 6, adding `inputs.duration_ms`. It follows the
established shape — additive, nullable, no backfill, also present in
`schema.sql` so a fresh database gets it at version 1.

**The compatibility note that matters more than the migration.** The sidecar
validator rejects any kind that is not `image` or `video`
(`src/jobs/sidecar.ts:183`). It must learn `audio`. Once it has, the
compatibility is one-way: new ForgeUI reads every old sidecar, but an older
build pointed at a data directory containing audio sidecars will reject them
at reindex. That is acceptable and normal, and it should be stated in the
phase notes rather than found.

**Nothing needs backfilling and nothing is rewritten.** Existing outputs keep
their rows; the waveform peaks are additive and absent means "not computed
yet", which the tile already has to handle for a brand-new output.

---

## 6. Custom nodes: the container and the README

Two places, one source of truth: a pinned commit.

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

Weights are **not** baked into the image. They are gigabytes, and they belong
on the `/models` mount with everything else. The pack downloads them on first
use into its own directory, so that directory has to resolve onto the mount —
a symlink created at build time is enough, and it keeps the weights out of
`model_folders` for the reason given in §4.4.

**README.** A subsection under *Running in a container*, covering: which pack
and pin is installed, where the weights land and roughly how large the first
download is, the licence of the weights, and — for people not using the
container — the manual install: clone the pack into `custom_nodes/`,
`pip install -r requirements.txt` into ComfyUI's venv, restart ComfyUI.

**Tests.** The existing `tests/unit/container_test.ts` holds the Containerfile
to the model-kind list. It should also hold it to the node pin, so a pack
added to the image without a documented commit fails a test rather than a
build months later.

---

## 7. Auto transcript — explored, not built

Voice cloning needs the exact words of the reference clip. Both candidate
models require it, and both node packs ship a Whisper transcription node to
produce it (`Breeze TTS 2 Whisper Transcribe`; `Whisper STT` in the Qwen
pack). So the capability is already in the box — what phase 1 declines is
wiring it into the UI.

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
2. The audio tile, the player in the viewer, the gallery chip, the peaks
   (§2.2).
3. The `audio` param, the probe, the input-store extensions (§4.2, §4.3).
4. The node pack in the `Containerfile`, the README section, the
   `audio_encoders` folder key (§4.4, §6).
5. Two bundled workflows: `qwen-tts-clone` and `qwen-tts-design`.
6. One bundled workflow: LTX-2.3 image-to-video with an optional audio input
   that replaces the generated track (§3.2 option A).

**Deliberately not in phase 1:** auto transcript (§7), lip-sync via Wan S2V or
HuMo (§3.2 C), the AV-latent conditioning experiment (§3.2 B), Breeze-TTS-2 as
a second family (§1), music generation with ACE-Step or Stable Audio, and TTS
weights as library models (§4.4).

**A suggested first cut.** Steps 1 and 5 are the smallest end-to-end proof:
one workflow, one result, played back with the browser's default controls.
Everything in step 2 is easier to judge once there is a real take to look at.

---

## 9. Open questions

1. **Which Qwen3-TTS node pack?** Five candidates, none canonical. Needs a
   comparison on the machine against the criteria in §1.
2. **Does the 0.6B model sound good enough**, or does this want the 1.7B?
   Affects nothing in this design; worth knowing before writing the README's
   download sizes.
3. **Are peaks in the sidecar right?** The alternative is a column, which
   makes the gallery query heavier but avoids a write path. Sidecar is
   proposed because it survives a reindex.
4. **Should an audio result be upscalable/reusable** in the sense the viewer
   means today? "Generate again" makes sense; "Upscale" does not, and the
   action should be absent rather than disabled for an audio output.
5. **Does the app need a volume control**, or is the system mixer enough for
   a local tool?
6. **Where exactly do the TTS weights land**, and does the chosen pack let
   that be configured, or does it need the symlink of §6? Answer per pack,
   during the comparison in question 1.
