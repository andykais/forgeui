/** Shapes of `config.yaml` (DESIGN.md §3.1, §11.4). */

export type ComfyMode = "managed" | "local_url";

export type TileSize = "small" | "large" | "table";

/** Screens that own a per-screen `ui` preference. */
export const UI_SCREENS = ["generate", "gallery", "models"] as const;
export type UiScreen = typeof UI_SCREENS[number];

/** The key actions bound in `config.yaml`; §11.4 allows no others. */
export const KEY_ACTIONS = [
  "select_prev",
  "select_next",
  "select_up",
  "select_down",
  "fullscreen",
  "close",
] as const;
export type KeyAction = typeof KEY_ACTIONS[number];

export interface ServerConfig {
  /** Interface the app's own HTTP server binds to. */
  host: string;
  /** Port the UI, the API and the `/comfy/*` proxy are served on. */
  port: number;
}

export interface ComfyConfig {
  mode: ComfyMode;
  /** ComfyUI install directory; required in `managed` mode. */
  path: string | null;
  /** Where ComfyUI listens. In `managed` mode the child is launched on it. */
  url: string;
  /** Interpreter for `managed` mode; null → look inside the install dir. */
  python: string | null;
  /** Appended verbatim to the generated launch flags. */
  extra_args: string[];
}

/** `kind` → folders, mirroring ComfyUI's `extra_model_paths.yaml` keys. */
export type ModelFolders = Record<string, string[]>;

/**
 * What a model is *for*, above the folder it was found in. Many kinds map
 * onto one class: `checkpoints`, `Stable-Diffusion`, `diffusion_models` and
 * `unet` are all `diffusion`, and one picker lists them together.
 */
export const MODEL_CLASSES = [
  "diffusion",
  "lora",
  "vae",
  "clip",
  "controlnet",
  "upscale",
  "embedding",
  "other",
] as const;
export type ModelClass = typeof MODEL_CLASSES[number];

/** `kind` → class, for folder keys the default table does not cover. */
export type ModelClasses = Record<string, ModelClass>;

export type KeyBindings = Record<KeyAction, string[]>;

/**
 * What a model tile shows when nobody has picked a thumbnail by hand:
 * `first_sample` is the earliest sample on its page — a reference image you
 * put there on purpose — and `latest_generated` is whatever came out of it
 * most recently (§8.1).
 */
export const MODEL_THUMBNAILS = ["first_sample", "latest_generated"] as const;
export type ModelThumbnail = typeof MODEL_THUMBNAILS[number];

export interface UiConfig {
  /** Icon rail (56px) vs. labelled rail (196px). */
  rail_expanded: boolean;
  tile_size: Record<UiScreen, TileSize>;
  sidebar_collapsed: Record<UiScreen, boolean>;
  filmstrip_collapsed: Record<UiScreen, boolean>;
  /**
   * The order the user dragged the workflows into, most wanted first. Ids
   * only, and only the ones that have been moved: anything absent keeps its
   * place after them, by name, so adding a workflow does not need this list
   * touched and deleting one leaves no hole (§4.6).
   */
  workflow_order: string[];
  /** What a model tile falls back to when no thumbnail was chosen (§8.1). */
  model_thumbnail: ModelThumbnail;
}

export interface Config {
  server: ServerConfig;
  comfy: ComfyConfig;
  model_folders: ModelFolders;
  /** Overrides for `kind` → class; the defaults cover the known kinds. */
  model_classes: ModelClasses;
  keys: KeyBindings;
  ui: UiConfig;
}

/** A `config.yaml` document, a CLI override layer, or a `PATCH` body. */
export interface PartialConfig {
  server?: Partial<ServerConfig>;
  comfy?: Partial<ComfyConfig>;
  model_folders?: ModelFolders;
  model_classes?: ModelClasses;
  keys?: Partial<KeyBindings>;
  ui?: PartialUiConfig;
}

export interface PartialUiConfig {
  rail_expanded?: boolean;
  tile_size?: Partial<Record<UiScreen, TileSize>>;
  sidebar_collapsed?: Partial<Record<UiScreen, boolean>>;
  filmstrip_collapsed?: Partial<Record<UiScreen, boolean>>;
  workflow_order?: string[];
  model_thumbnail?: ModelThumbnail;
}
