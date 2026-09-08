# ForgeUI + ComfyUI, built for local use with podman on an NVIDIA GPU
# (developed against an RTX 5090 / Blackwell, CUDA 12.8).
#
# Everything the app needs to run lives in this image: Deno, the built
# frontend, and a pinned ComfyUI with CUDA-enabled torch. Only user data
# (config, database, outputs, models) is expected to come from volumes.
# See the README for build/run instructions.

# ---- stage 1: build the Svelte frontend -----------------------------------
FROM node:22-bookworm-slim AS frontend

WORKDIR /app/src/frontend
COPY src/frontend/package.json src/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/frontend/ ./
RUN npm run build

# ---- stage 2: runtime -------------------------------------------------------
# CUDA 12.8 for Blackwell/sm_120 (RTX 50-series) support; bump with
# --build-arg CUDA_IMAGE=... if you're on different hardware or drivers.
ARG CUDA_IMAGE=nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04
FROM ${CUDA_IMAGE}

# Pinned to the ComfyUI version this repo is verified against
# (docs/HARDWARE-CHECKLIST.md); override with --build-arg to try another.
ARG COMFY_VERSION=v0.34.0
ARG COMFY_HOME=/opt/ComfyUI

ENV DEBIAN_FRONTEND=noninteractive \
    DENO_INSTALL=/usr/local \
    PATH="/usr/local/bin:${PATH}" \
    FORGEUI_DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev \
      git curl ca-certificates unzip build-essential \
    && rm -rf /var/lib/apt/lists/*

# Deno (runs the app itself)
RUN curl -fsSL https://deno.land/install.sh | sh

# ComfyUI, in its own venv so `pythonFor()` (src/comfy/launch.ts) finds it
# automatically from comfy.path without extra config.
RUN git clone --depth 1 --branch "${COMFY_VERSION}" \
      https://github.com/comfyanonymous/ComfyUI.git "${COMFY_HOME}" \
    && python3 -m venv "${COMFY_HOME}/venv"

# CUDA 12.8 wheels (Blackwell/sm_120, i.e. RTX 50-series support) ahead of
# ComfyUI's unpinned torch requirement, so pip never substitutes a CPU build.
RUN "${COMFY_HOME}/venv/bin/pip" install --no-cache-dir --upgrade pip && \
    "${COMFY_HOME}/venv/bin/pip" install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu128 \
      torch torchvision torchaudio && \
    "${COMFY_HOME}/venv/bin/pip" install --no-cache-dir \
      -r "${COMFY_HOME}/requirements.txt"

WORKDIR /app
COPY deno.json deno.lock ./
COPY src/ ./src/
COPY workflows/ ./workflows/
COPY --from=frontend /app/src/frontend/dist/ ./src/frontend/dist/

# Pre-fetch Deno's module cache, and force @db/sqlite's native library
# download (it fetches its prebuilt binary via @denosaurs/plug on first use),
# so the container doesn't need network access at startup.
RUN deno cache src/main.ts && \
    deno eval --allow-ffi --allow-net --allow-read --allow-write --allow-env \
      "import { Database } from 'jsr:@db/sqlite@^0.12.0'; new Database(':memory:').close();"

# App data (config.yaml, app.db, workflows/user, outputs, samples, ...) and
# models are the only things meant to be mounted in.
VOLUME ["/data", "/models"]
EXPOSE 7777

ENTRYPOINT ["deno", "task", "start"]
# --host 0.0.0.0 so the app is reachable from outside the container;
# --comfy-path points at the ComfyUI baked into this image;
# --models-dir wires up the /models layout the README describes.
# These are per-run overrides (never written to config.yaml), so editing
# config.yaml for anything else is still safe across restarts.
CMD ["--host", "0.0.0.0", \
     "--comfy-path", "/opt/ComfyUI", \
     "--models-dir", "checkpoints=/models/checkpoints", \
     "--models-dir", "loras=/models/loras", \
     "--models-dir", "vae=/models/vae", \
     "--models-dir", "controlnet=/models/controlnet"]
