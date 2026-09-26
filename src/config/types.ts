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
  /**
   * Whether a graph may fetch model weights while it runs (§4.6).
   *
   * Several custom node packs "helpfully" download a checkpoint the first
   * time a node executes. That turns a generation into an unannounced
   * multi-gigabyte transfer, and makes a run's behaviour depend on what a
   * remote host served that day. Off, a graph carrying such an input is
   * refused at submit, naming the node — so weights are something you put on
   * disk deliberately, before the run.
   */
  allow_model_downloads: boolean;
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

/**
 * How a screen arranges its three pieces: the inputs, the media, and the
 * metadata (§11.3).
 *
 * The names say where the media goes, because the media is what the
 * arrangement is for:
 *
 * - `columns`     inputs | media | metadata — three across, the default
 * - `split`       inputs | media over metadata
 * - `wide`        inputs | media, and no metadata
 * - `top`         media across the top, inputs underneath
 * - `top-split`   media across the top, inputs and metadata underneath
 * - `media-split` media | metadata, and no inputs panel
 * - `media`       media alone
 *
 * Gallery has no inputs, so only the first three mean anything there, and
 * the picker offers it only those.
 */
export const LAYOUTS = [
  "columns",
  "split",
  "wide",
  "top",
  "top-split",
  "media-split",
  "media",
] as const;
export type Layout = typeof LAYOUTS[number];

/** The layouts that keep the metadata pane. */
export const LAYOUTS_WITH_METADATA: readonly Layout[] = [
  "columns",
  "split",
  "top-split",
  "media-split",
];

export interface UiConfig {
  /** Icon rail (56px) vs. labelled rail (196px). */
  rail_expanded: boolean;
  tile_size: Record<UiScreen, TileSize>;
  /** Where the inputs, the media and the metadata go (§11.3). */
  layout: Record<UiScreen, Layout>;
  /**
   * Superseded by `layout`, which says whether there is a metadata pane at
   * all. Still read and written so a config.yaml from before the layouts
   * still loads — an older build of the app reads it, and refusing to start
   * over a key we stopped needing would be a poor trade.
   */
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
  /**
   * Families to keep out of sight entirely: gone from the family chips and
   * from every family picker, and their models treated as hidden — behind
   * Show hidden, out of the Generate inputs (§8.1). For the architectures a
   * given machine simply does not run.
   */
  hidden_families: string[];
}

/**
 * Where `forge models` drops batches, where ingest files what it fetched, and
 * who gets asked (DESIGN-MODEL-IMPORT §8). Both halves of the tool read this
 * same file, which is why the folder is a config entry rather than a flag:
 * they have to agree on it, and there is exactly one place that says where it
 * is.
 */
export interface ImportConfig {
  /**
   * The drop folder; null → `<appdata>/import`. An absolute path may live on
   * a share, which is how the fetching machine and the serving machine can be
   * different ones.
   */
  dir: string | null;
  /**
   * Where ingest files weights fetched with `--download-model`; null →
   * `<appdata>/models`. It is a model folder like any other and is scanned as
   * one (§5.1), so point it at a disk with room on it.
   */
  model_dir: string | null;
  /**
   * Looked up first. `civitai.com` is the same API with a narrower default
   * filter (§4.0), so this is the `.red` host and `browsing_level` does the
   * filtering rather than the hostname.
   */
  civitai_url: string;
  /**
   * Civitai's visibility bitmask: 1 is PG only, 31 is everything. What a
   * *lookup* may return — `nsfw_level` is what may be kept. Which query
   * parameter carries it differs per endpoint (§4.0); one place translates
   * it, and this is the only knob.
   */
  browsing_level: number;
  /** The fallback, and the only source for models Civitai has deleted. */
  archive_url: string;
  /**
   * A Civitai API key, from civitai.com/user/account. Sent as a Bearer
   * header to Civitai only — never to the archive or the image CDN — and
   * only needed for gated, early-access or paid models; everything public
   * works without it. `CIVITAI_TOKEN` in the environment wins over this.
   *
   * Stored in plaintext in `config.yaml`: keeping it anywhere safer is out of
   * scope for now. It is never served by `GET /api/config`.
   */
  civitai_token: string | null;
  /**
   * The official Civitai CLI, used for `--download-model` only when it is
   * installed *and* no token is configured — so a token given to ForgeUI is
   * never silently traded for the CLI's own login. A bare name is looked up
   * on PATH; null never uses it.
   */
  civitai_cli: string | null;
  /** What `--download-samples` means with no number after it. */
  samples: number;
  /** Civitai's nsfwLevel scale: 1 is safe. Images above this are skipped. */
  nsfw_level: number;
  /** Slurp the import folder during the boot rescan as well as on demand. */
  ingest_on_boot: boolean;
}

export interface Config {
  server: ServerConfig;
  comfy: ComfyConfig;
  model_folders: ModelFolders;
  /** Overrides for `kind` → class; the defaults cover the known kinds. */
  model_classes: ModelClasses;
  keys: KeyBindings;
  ui: UiConfig;
  import: ImportConfig;
}

/** A `config.yaml` document, a CLI override layer, or a `PATCH` body. */
export interface PartialConfig {
  server?: Partial<ServerConfig>;
  comfy?: Partial<ComfyConfig>;
  model_folders?: ModelFolders;
  model_classes?: ModelClasses;
  keys?: Partial<KeyBindings>;
  ui?: PartialUiConfig;
  import?: Partial<ImportConfig>;
}

export interface PartialUiConfig {
  rail_expanded?: boolean;
  tile_size?: Partial<Record<UiScreen, TileSize>>;
  layout?: Partial<Record<UiScreen, Layout>>;
  sidebar_collapsed?: Partial<Record<UiScreen, boolean>>;
  filmstrip_collapsed?: Partial<Record<UiScreen, boolean>>;
  workflow_order?: string[];
  model_thumbnail?: ModelThumbnail;
  hidden_families?: string[];
}
