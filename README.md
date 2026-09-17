# ForgeUI

A workflow-first frontend for ComfyUI. Every generation runs a ComfyUI workflow;
the UI is only the inputs a workflow's manifest exposes; every output ships with
a sidecar that reproduces it.

Deno · SQLite · Svelte. See `docs/DESIGN.md`.

## Documents

| File                         | Purpose                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/DESIGN.md`             | Authoritative spec: architecture, schema, API, UI.                                         |
| `docs/IMPLEMENT-PHASE-1.md`  | Work plan for the first milestone set (M0–M4), with definition of done.                    |
| `docs/MOCK-REVISIONS.md`     | Changes to the UI mocks that have been decided but may not yet be drawn.                   |
| `docs/MOCK-REVIEW.md`        | Review log of the mocks against the spec; every item carries its decision. Reference only. |
| `docs/mocks/`                | Frame PNGs (numbered) and the source `.dc.html` of the mocks.                              |
| `docs/PHASE-1-HANDOFF.md`    | What Phase 1 delivered and the decisions worth knowing.                                    |
| `docs/PHASE-2-HANDOFF.md`    | What Phase 2 delivered, the screens it added, and where Phase 3 picks up.                  |
| `docs/IMPLEMENT-PHASE-2.md`  | Work plan for the model library, samples and node-timing ETA (M5–M9).                      |
| `docs/HARDWARE-CHECKLIST.md` | What running against a real ComfyUI proves, and what it still does not.                    |
| `docs/DESIGN-AUDIO.md`       | Proposal: audio as a result, TTS voices, song, and lip-synced video. Not implemented.      |
| `AGENTS.md`                  | How to navigate and build the repo, and the conventions a coding agent must follow.        |

Phase 1 is complete and has been verified against a real ComfyUI; see the
handoff and the hardware checklist. Phase 2 — the model library, samples and the
node-timing ETA — is complete. Phases 3–5 of DESIGN.md §13 are not started.

## Running it

Requires [Deno](https://deno.com) 2.x to run. Node is needed only to build the
interface, which ships pre-built in a release.

```sh
deno task start --data-dir ./data   # serve the UI and the API
deno task test                      # unit + integration + golden tests
deno task check                      # type-check
deno task fmt                        # format
deno task lint                       # lint
deno task reindex                    # rebuild app.db from the sidecars on disk
```

The data directory holds `config.yaml`, `app.db`, workflows and every output
(§3). It comes from `--data-dir`, else `FORGEUI_DATA_DIR`, else `~/.forgeui`,
and is created with a default `config.yaml` on first run. Other flags
(`--comfy-path`, `--comfy-url`, `--models-dir kind=path`, `--host`, `--port`)
override `config.yaml` for one run and are never written back; `--help` lists
them.

## Tests

| Command              | What it covers                                   |
| -------------------- | ------------------------------------------------ |
| `deno task test`     | unit, golden and server integration tests        |
| `deno task test:ui`  | param-panel component tests (vitest + jsdom)     |
| `deno task test:e2e` | the Playwright smoke test, against the built app |

None of them need a GPU or a real ComfyUI: `tests/fake-comfy/` is a stand-in
whose per-prompt behaviour comes from the data-driven scenarios in
`tests/fake-comfy/scenarios.ts`, and the end-to-end test runs it as a managed
child process behind a stub interpreter. The Playwright test uses the browser
already installed on the machine (`channel: "chrome"`).

### Against a real ComfyUI

The fake is only as right as the assumptions it was written from, so there is a
second suite that checks them — and it brings its own ComfyUI:

```sh
deno task comfy:setup     # once: ComfyUI v0.34.0, CPU torch, SD 1.5 (~2 GB)
deno task test:comfy      # the §14.1 contract check, and one real generation
deno task test:e2e:comfy  # the same from a browser, including the editor
```

`comfy:setup` installs into `~/.forgeui-comfy` (override with
`FORGEUI_COMFY_HOME`), never inside the repository; on Debian and Ubuntu it
needs `python3-venv`. The two test tasks start that ComfyUI with `--cpu`, run
against it and shut it down, so a four-step 256×256 sample takes seconds and no
GPU. `FORGEUI_COMFY_URL` points them at a ComfyUI of your own instead.
`docs/HARDWARE-CHECKLIST.md` says what all this proves and what it does not.

Golden files under `tests/golden/` are only rewritten when asked:

```sh
UPDATE_GOLDEN=1 deno task test
```

## The interface

The Svelte app lives in `src/frontend/`, is built by Vite into
`src/frontend/dist/`, and is served by the Deno process — so `deno task start`
serves the API and the UI on one port. Node is only needed to build it.

```sh
deno task ui:install   # once: npm install inside src/frontend
deno task ui:build     # build into dist/, which the Deno server serves
deno task ui:dev       # Vite dev server on :5173, proxying /api, /ws and /comfy
deno task ui:check     # svelte-check
deno task ui:fmt       # prettier
```

## Running in a container (podman, NVIDIA GPU)

`Containerfile` builds a self-contained image: Deno, the pre-built frontend, and
a pinned ComfyUI (`docs/HARDWARE-CHECKLIST.md`'s verified version) with CUDA
12.8 torch wheels (Blackwell/RTX 50-series support, e.g. an RTX 5090).
Everything needed to launch the app is baked in at build time; only your data is
expected to come from volumes.

It also installs **`ffmpeg`**, which is the one external binary the app itself
runs: an audio result has no thumbnail of its own, so ffmpeg draws its waveform
beside it and reads how long the clip is. Running the app outside the container
means installing ffmpeg too — without it, audio still generates and plays, it
just has no waveform and no duration.

Build:

```sh
podman build -t forgeui -f Containerfile .
```

Run, with a workspace directory and a models directory mounted in:

```sh
podman volume create forgeui-workspace
podman volume create forgeui-models

podman run -d --name forgeui \
  --device nvidia.com/gpu=all \
  -p 7777:7777 \
  -v forgeui-workspace:/workspace \
  -v forgeui-models:/models \
  forgeui
```

`--device nvidia.com/gpu=all` uses the CDI integration from the NVIDIA Container
Toolkit; generate the CDI spec once on the host with
`nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml` (see the toolkit's
podman docs). Older toolkit setups can instead pass `--gpus all`.

`/models` is expected to hold one subfolder per model kind — `checkpoints`,
`Stable-Diffusion`, `diffusion_models`, `unet`, `loras`, `vae`, `text_encoders`,
`controlnet`, `upscale_models`, `latent_upscale_models`, `embeddings`,
`breezetts2` — matching how the container's entrypoint wires up `--models-dir`
(see `Containerfile`'s `CMD`). A folder you do not use can simply be absent; a
missing folder scans as empty.

Anything that can drive a generation is one _class_ to the app, so
`checkpoints`, `diffusion_models` and `unet` are listed together in a workflow's
model picker regardless of which of them a file sits in.

### Speech: the one custom node pack

Everything else in this repo runs on stock ComfyUI. The two speech workflows do
not: they need
[`ComfyUI-Breeze-TTS-2`](https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2)
(Apache-2.0, an unofficial pack — Breeze TTS 2 has no official ComfyUI nodes),
which the image clones at a pinned commit and whose lightweight dependencies it
installs into ComfyUI's venv. The pin is the `BREEZE_NODES_COMMIT` build arg;
override it to try a newer one. `ace-step-song` and the LTX video workflows need
nothing extra.

**The weights are yours to put there.** They are not baked into the image, and
nothing here fetches them while a graph runs: the bundled workflows tell the
loader `download_if_missing: false`, the app refuses any graph that would
(`comfy.allow_model_downloads`, below), and the image exports `HF_HUB_OFFLINE=1`
so a pack reaching for the Hub fails at once rather than after a DNS timeout. A
generation should take the time a generation takes, not five gigabytes.

There are four builds, and the Load Model node picks between them by label
rather than by filename: `int8 hybrid (recommended)` (4.5 GiB),
`bf16 (best quality)` (6.5 GiB), `int8 (smallest, slower)` (4.2 GiB), and
`int8 text encoder only` (5.8 GiB). Fetch the one you want from
[`drbaph/Breeze-TTS-2-comfyui`](https://huggingface.co/drbaph/Breeze-TTS-2-comfyui)
before the first run:

```sh
huggingface-cli download drbaph/Breeze-TTS-2-comfyui \
  --include 'config.json' 'generation_config.json' 'tokenizer*' \
            'special_tokens_map.json' 'audio_tokenizer/*' \
            'Breeze-TTS-2-int8-hybrid.safetensors' \
  --local-dir /models/breezetts2/drbaph_Breeze-TTS-2-comfyui
```

**The subfolder name matters**: the pack looks for
`<folder>/drbaph_Breeze-TTS-2-comfyui/`, the repo id with `/` replaced by `_`,
and checks for `config.json`, `audio_tokenizer/model.safetensors` and the
build's own `.safetensors`. Files loose in `/models/breezetts2` are not found.
Expect a little over five gigabytes for the recommended build, counting the 0.6
GiB audio tokenizer. The weights carry their own licence — check it before you
ship anything made with them.

Point it somewhere else by naming the folder rather than moving it: the
`breezetts2` key in `model_folders` can be any path (`/models/tts`, say), and
ForgeUI writes it into the `extra_model_paths.yaml` ComfyUI hands the pack.

### Models are never downloaded by a run

`comfy.allow_model_downloads` defaults to **false**, and with it off the app
refuses to submit a graph whose inputs would fetch weights mid-run —
`download_if_missing`, `auto_download`, `download_model` — naming the node and
the input instead. Custom node packs offer these to be helpful; the cost is that
a generation either takes ten seconds or several gigabytes depending on what
happens to be on disk, and fails with a network error rather than a missing
file. Set it to `true` in `config.yaml` if you would rather have the
convenience:

```yaml
comfy:
  allow_model_downloads: true
```

The check is a list of input names, not a guarantee: a pack that spells its own
differently is not covered, which is what `HF_HUB_OFFLINE=1` in the image is
for.

Running the speech workflows outside the container means doing the same three
things by hand:

```sh
git clone https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2 \
  <comfyui>/custom_nodes/ComfyUI-Breeze-TTS-2
<comfyui>/venv/bin/pip install -r \
  <comfyui>/custom_nodes/ComfyUI-Breeze-TTS-2/requirements.txt
# then restart ComfyUI
```

The pack needs `transformers >= 4.57`, which current ComfyUI already installs.
It finds weights through the `breezetts2:` key ForgeUI writes into
`extra_model_paths.yaml`, so pointing a `breezetts2` folder at your model
library in Settings is enough — but its _first download_ always goes to
`<comfyui>/models/breezetts2`, which no config can redirect. The container
symlinks that path onto `/models`; outside it, either symlink it the same way or
let the download land there and move it afterwards.

`/workspace` is ForgeUI's data directory (`--data-dir`, §3): `config.yaml`,
`app.db`, `workflows/user`, `outputs`, `samples`, and everything else the app
owns — the container's `CMD` passes `--data-dir /workspace` explicitly. On first
startup, if `/workspace/config.yaml` doesn't exist yet, ForgeUI writes a default
one there — the same first-run behavior as running it bare-metal — so a fresh
`forgeui-workspace` volume just works, and you can then hand-edit `config.yaml`
in the volume (or use Settings) for anything beyond what the container's launch
flags cover.

Output media always lives at `/workspace/outputs`; there's no separate flag for
it, since ForgeUI treats it as a fixed part of the data directory rather than an
independently configurable path. If you want it on its own volume — bigger or
faster storage, say — mount one directly at `/workspace/outputs` instead of
bundling it with the rest of `/workspace`; it's a plain subdirectory, so a
nested volume mount works the same way:

```sh
podman volume create forgeui-outputs

podman run -d --name forgeui \
  --device nvidia.com/gpu=all \
  -p 7777:7777 \
  -v forgeui-workspace:/workspace \
  -v forgeui-outputs:/workspace/outputs \
  -v forgeui-models:/models \
  forgeui
```

## Starting the build

Open `docs/IMPLEMENT-PHASE-1.md` and begin at M0. Replace the mock PNGs in
`docs/mocks/` with the revised frames when they are ready, keeping the
numbering.
