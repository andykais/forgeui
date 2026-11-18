#!/usr/bin/env bash
# Provision a real ComfyUI for the contract check (docs/HARDWARE-CHECKLIST.md).
#
# CPU only, one pinned ComfyUI, one small checkpoint: enough to run the whole
# pipeline for real without a GPU. Nothing here lands inside the repository —
# the install lives in $FORGEUI_COMFY_HOME (default ~/.forgeui-comfy) so the
# multi-gigabyte parts stay out of git.
#
# Re-running is safe: each step is skipped when its result is already there.
set -euo pipefail

COMFY_VERSION="${FORGEUI_COMFY_VERSION:-v0.34.0}"
COMFY_HOME="${FORGEUI_COMFY_HOME:-$HOME/.forgeui-comfy}"
COMFY_DIR="$COMFY_HOME/ComfyUI"
VENV_DIR="$COMFY_HOME/venv"
PYTHON="${FORGEUI_PYTHON:-python3}"

# Stable Diffusion 1.5, fp16: ~2 GB, and the smallest checkpoint that produces
# a real image on a CPU in seconds. Comfy-Org mirrors the original weights.
MODEL_REPO="Comfy-Org/stable-diffusion-v1-5-archive"
MODEL_FILE="v1-5-pruned-emaonly-fp16.safetensors"
MODEL_DIR="$COMFY_DIR/models/checkpoints"

# The pose workflow (sd15-pose): an SD 1.5 OpenPose ControlNet, ~720 MB, and
# core SDPose's pose detector, ~1.9 GB. Skip both with FORGEUI_SKIP_POSE=1;
# the pose contract test is then skipped too.
CONTROLNET_REPO="comfyanonymous/ControlNet-v1-1_fp16_safetensors"
CONTROLNET_FILE="control_v11p_sd15_openpose_fp16.safetensors"
SDPOSE_REPO="Comfy-Org/SDPose"
SDPOSE_FILE="sdpose_wholebody_fp16.safetensors"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "ComfyUI $COMFY_VERSION in $COMFY_DIR"
if [ -d "$COMFY_DIR/.git" ]; then
  current="$(git -C "$COMFY_DIR" describe --tags --always 2>/dev/null || echo unknown)"
  if [ "$current" != "$COMFY_VERSION" ]; then
    echo "checked out $current, moving to $COMFY_VERSION"
    git -C "$COMFY_DIR" fetch --depth 1 origin "refs/tags/$COMFY_VERSION:refs/tags/$COMFY_VERSION"
    git -C "$COMFY_DIR" checkout --quiet "$COMFY_VERSION"
  else
    echo "already at $COMFY_VERSION"
  fi
else
  mkdir -p "$COMFY_HOME"
  git clone --depth 1 --branch "$COMFY_VERSION" \
    https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
fi

step "Python environment in $VENV_DIR"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  if ! "$PYTHON" -c 'import ensurepip' >/dev/null 2>&1; then
    echo "$PYTHON cannot create virtual environments." >&2
    echo "On Debian/Ubuntu: sudo apt-get install -y python3-venv" >&2
    exit 1
  fi
  "$PYTHON" -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip

# The CPU wheels first and from PyTorch's own index: ComfyUI's requirements
# name torch/torchvision/torchaudio without pins, so an unsatisfied one would
# drag in the multi-gigabyte CUDA build.
step "PyTorch (CPU wheels)"
"$VENV_DIR/bin/python" -m pip install --quiet \
  --index-url https://download.pytorch.org/whl/cpu \
  torch torchvision torchaudio

step "ComfyUI requirements"
"$VENV_DIR/bin/python" -m pip install --quiet -r "$COMFY_DIR/requirements.txt"

# fetch <repo> <path in repo> <destination file>
fetch() {
  if [ -s "$3" ]; then
    echo "already downloaded ($(du -h "$3" | cut -f1))"
    return
  fi
  mkdir -p "$(dirname "$3")"
  curl -fL --retry 3 --retry-delay 2 -C - --progress-bar \
    -o "$3.part" "https://huggingface.co/$1/resolve/main/$2?download=true"
  mv "$3.part" "$3"
}

step "Checkpoint $MODEL_FILE"
fetch "$MODEL_REPO" "$MODEL_FILE" "$MODEL_DIR/$MODEL_FILE"

if [ "${FORGEUI_SKIP_POSE:-}" != "1" ]; then
  step "ControlNet $CONTROLNET_FILE"
  fetch "$CONTROLNET_REPO" "$CONTROLNET_FILE" \
    "$COMFY_DIR/models/controlnet/$CONTROLNET_FILE"
  step "Pose detector $SDPOSE_FILE"
  fetch "$SDPOSE_REPO" "checkpoints/$SDPOSE_FILE" "$MODEL_DIR/$SDPOSE_FILE"
fi

step "Ready"
cat <<EOF
ComfyUI   $COMFY_VERSION  $COMFY_DIR
python    $("$VENV_DIR/bin/python" --version)
torch     $("$VENV_DIR/bin/python" -c 'import torch; print(torch.__version__)')
model     $MODEL_DIR/$MODEL_FILE

  deno task test:comfy     the contract check, against this install
  deno task comfy:serve    run it in the foreground and print its URL

Both start ComfyUI themselves; set FORGEUI_COMFY_HOME if you moved the
install, or FORGEUI_COMFY_URL to point the tests at a ComfyUI of your own.
EOF
