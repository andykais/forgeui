import type { Config, ModelClass } from "./types.ts";

/**
 * Kinds listed in Settings (frame 08); any other key is honoured too. The
 * list is wider than the four folders Phase 2 shipped because a workflow now
 * picks its model from a *class* rather than a folder, and the
 * current-generation models keep their text encoders and latent upscalers
 * in folders of their own.
 *
 * Everything here defaults to an empty folder list, so adding a kind changes
 * nothing for an existing install until it is pointed somewhere.
 */
export const DEFAULT_MODEL_KINDS = [
  "checkpoints",
  "Stable-Diffusion",
  "diffusion_models",
  "unet",
  "loras",
  "vae",
  "text_encoders",
  "controlnet",
  "upscale_models",
  "latent_upscale_models",
  "embeddings",
  // Not a ComfyUI folder key: the Breeze TTS 2 node pack registers this one
  // itself and searches any `breezetts2:` mapping it finds in
  // extra_model_paths.yaml (docs/DESIGN-AUDIO.md §4.4). Listing it here is
  // what puts six gigabytes of speech model on the Models page instead of
  // leaving it invisible to the page whose job is "what is on disk".
  "breezetts2",
] as const;

/**
 * Which class each known kind belongs to. `diffusion` is the grab bag: a
 * model that can drive a generation, wherever it happens to be filed.
 *
 * ComfyUI already treats some of these as one key — `diffusion_models`
 * searches `unet/` too, and `text_encoders` searches `clip/` — so the pairs
 * below agree with `folder_paths.py` rather than inventing a second opinion.
 */
const KIND_CLASSES: Record<string, ModelClass> = {
  checkpoints: "diffusion",
  "Stable-Diffusion": "diffusion",
  diffusion_models: "diffusion",
  unet: "diffusion",
  loras: "lora",
  lycoris: "lora",
  vae: "vae",
  vae_approx: "vae",
  clip: "clip",
  text_encoders: "clip",
  clip_vision: "clip",
  controlnet: "controlnet",
  upscale_models: "upscale",
  latent_upscale_models: "upscale",
  embeddings: "embedding",
  // Speech weights drive a generation, but not through a model picker: the
  // pack's loader node takes one of four fixed build labels and resolves the
  // file itself, so these rows are informational (§4.4).
  breezetts2: "other",
};

/** Kinds whose folders are pooled so any of them loads through any loader. */
export const DIFFUSION_KINDS: readonly string[] = Object.entries(KIND_CLASSES)
  .filter(([, modelClass]) => modelClass === "diffusion")
  .map(([kind]) => kind);

/**
 * The class a kind belongs to: the config override first, then the table
 * above, then `other`. Unknown kinds are not an error — a user may point a
 * folder at anything ComfyUI understands.
 */
export function classOf(
  kind: string,
  overrides: Record<string, ModelClass> = {},
): ModelClass {
  return overrides[kind] ?? KIND_CLASSES[kind] ?? "other";
}

export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

/**
 * `.red` rather than `.com`: the same API is served from both, and what it
 * returns is decided by the visibility parameter rather than the hostname —
 * but `.red` is the host whose *pages* show everything, so a link built from
 * a lookup lands somewhere that can display what was found (§4.0).
 */
export const DEFAULT_CIVITAI_URL = "https://civitai.red";
export const DEFAULT_ARCHIVE_URL = "https://civitaiarchive.com";

export function defaultConfig(): Config {
  return {
    server: { host: "127.0.0.1", port: 7777 },
    comfy: {
      mode: "managed",
      path: null,
      url: DEFAULT_COMFY_URL,
      python: null,
      extra_args: [],
      // Deliberate by default: a run should not be a download (§4.6).
      allow_model_downloads: false,
    },
    model_folders: Object.fromEntries(
      DEFAULT_MODEL_KINDS.map((kind) => [kind, [] as string[]]),
    ),
    model_classes: {},
    keys: {
      // WASD beside the arrows, so a hand already on the keyboard does not
      // have to travel. Every screen that reads these gets them at once,
      // which is the point of the table (§11.4).
      select_prev: ["ArrowLeft", "a"],
      select_next: ["ArrowRight", "d"],
      select_up: ["ArrowUp", "w"],
      select_down: ["ArrowDown", "s"],
      fullscreen: ["f"],
      close: ["Escape"],
    },
    ui: {
      rail_expanded: false,
      tile_size: { generate: "small", gallery: "small", models: "small" },
      // Three columns, which is what the app has always opened as.
      layout: { generate: "columns", gallery: "columns", models: "columns" },
      sidebar_collapsed: { generate: false, gallery: false, models: false },
      filmstrip_collapsed: { generate: false, gallery: false, models: false },
      workflow_order: [],
      // What was already happening before this was a setting.
      model_thumbnail: "latest_generated",
      hidden_families: [],
    },
    import: {
      dir: null,
      model_dir: null,
      civitai_url: DEFAULT_CIVITAI_URL,
      // Ask broadly and file narrowly: a mature model is still identified,
      // named and filed correctly while `nsfw_level` keeps its images off
      // the disk (DESIGN-MODEL-IMPORT §8).
      browsing_level: 31,
      archive_url: DEFAULT_ARCHIVE_URL,
      civitai_token: null,
      civitai_cli: "civitai",
      samples: 4,
      nsfw_level: 1,
      ingest_on_boot: true,
    },
  };
}
