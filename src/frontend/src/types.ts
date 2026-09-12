/** The API shapes the screens use; mirrors src/db/queries.ts and §4.2. */

export type ParamType =
  | "text"
  | "int"
  | "float"
  | "bool"
  | "enum"
  | "seed"
  | "size"
  | "model"
  | "text_encoder"
  | "vae"
  | "lora_list"
  | "image"
  | "mask"
  | "video";

export interface LoraChain {
  model_from: string;
  clip_from: string | null;
  model_to: string[];
  clip_to: string[] | null;
}

export interface Param {
  key: string;
  label?: string;
  type: ParamType;
  required?: boolean;
  advanced?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  source?: string;
  filter?: { family?: string; class?: string };
  bind: string | { w: string; h: string } | { chain: LoraChain };
  of?: string;
}

export interface Manifest {
  id: string;
  name: string;
  family: string | null;
  kind: "image" | "video";
  category: string | null;
  description: string | null;
  params: Param[];
  outputs: { node: string; kind: "image" | "video" }[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  family: string | null;
  kind: "image" | "video";
  category: string | null;
  description: string | null;
  source: "bundled" | "user";
  has_user_copy: boolean;
  has_bundled: boolean;
  hash: string;
  params: { keys: string[]; advanced: number };
  runnable: boolean;
  error: string | null;
  last_job_at: number | null;
  last_output_id: string | null;
  has_ui_json: boolean;
}

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export interface WorkflowDetail extends WorkflowSummary {
  manifest: Manifest | null;
  api_json: Record<string, ApiNode>;
  ui_json: Record<string, unknown>;
}

export interface LiteralInput {
  node_id: string;
  node_type: string;
  node_title: string | null;
  input: string;
  value: unknown;
  type_hint: string;
  exposed_by: string | null;
}

export interface Progress {
  pct: number;
  eta_ms: number | null;
  node_id: string | null;
  node_label: string | null;
  node_index: number;
  node_total: number;
  step: number;
  max: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobError {
  type: string;
  message: string;
  node_id?: string | null;
  node_type?: string | null;
  traceback?: string[];
  node_errors?: Record<string, unknown>;
}

export interface Job {
  id: string;
  prompt_id: string | null;
  workflow_id: string | null;
  workflow_hash: string | null;
  status: JobStatus;
  params: Record<string, unknown>;
  api_graph: Record<string, ApiNode>;
  progress: Progress | null;
  error: JobError | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  outputs: string[];
}

export interface Output {
  id: string;
  job_id: string | null;
  path: string;
  sidecar_path: string;
  kind: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sha256: string | null;
  workflow_id: string | null;
  workflow_hash: string | null;
  family: string | null;
  prompt: string | null;
  params: Record<string, unknown>;
  deleted_at: number | null;
  created_at: number;
  media_url: string;
  generation_ms: number | null;
  models: { model_hash: string; role: string }[];
}

export interface Sidecar {
  app_version: string;
  job_id: string;
  created_at: string;
  workflow: {
    id: string;
    name: string;
    hash: string;
    family: string | null;
    kind: string;
  } | null;
  params: Record<string, unknown>;
  models: { role: string; name: string; hash: string | null }[];
  api_graph: Record<string, ApiNode> | null;
  outputs: { file: string; kind: string; width?: number; height?: number }[];
  timing: { total_ms: number; nodes: Record<string, number> };
  raw: unknown;
}

export interface OutputDetail extends Output {
  sidecar: Sidecar | null;
  sidecar_error: string | null;
}

export interface ComfyStatus {
  state: "starting" | "running" | "disconnected" | "failed";
  mode: "managed" | "local_url";
  url: string;
  pid: number | null;
  uptime_ms: number | null;
  error: string | null;
  device: string | null;
  vram_free: number | null;
  vram_total: number | null;
  comfyui_version: string | null;
  queue_remaining: number;
  launch_flags: string[];
}

export type TileSize = "small" | "large" | "table";
export type UiScreen = "generate" | "gallery" | "models";

export interface Config {
  server: { host: string; port: number };
  comfy: {
    mode: "managed" | "local_url";
    path: string | null;
    url: string;
    python: string | null;
    extra_args: string[];
  };
  model_folders: Record<string, string[]>;
  keys: Record<string, string[]>;
  ui: {
    rail_expanded: boolean;
    tile_size: Record<UiScreen, TileSize>;
    sidebar_collapsed: Record<UiScreen, boolean>;
    filmstrip_collapsed: Record<UiScreen, boolean>;
    /** Workflow ids the user dragged into place, most wanted first (§4.6). */
    workflow_order: string[];
    /** What a model tile falls back to when none was chosen (§8.1). */
    model_thumbnail: "first_sample" | "latest_generated";
    /** Families kept out of sight entirely; their models read as hidden. */
    hidden_families: string[];
  };
}

export interface ModelEntry {
  /** The hash, or `path:<base64url>` while the file has none (§8.1). */
  id: string;
  hash: string | null;
  path: string;
  /** What a workflow binds to: the path relative to its model folder. */
  name: string;
  filename: string;
  display_name: string;
  family: string;
  kind: string;
  /** What the model is for, above the folder it came from (§3). */
  class: string;
  size: number;
  mtime: number | null;
  notes: string | null;
  tags: string[];
  /** The ends of this model's strength sliders; always a number (§8.1). */
  strength_min: number;
  strength_max: number;
  thumb_path: string | null;
  thumb_url: string | null;
  output_count: number;
  last_used_at: number | null;
  /** True until the background hasher has read the file (§8.1). */
  hashing: boolean;
  /** Why the hasher could not read it; a file that failed is not waiting. */
  hash_error: string | null;
  /** Kept out of the Generate pickers; still listed on Models (§8.1). */
  hidden: boolean;
  present: boolean;
}

/** The model page: the header, plus its Samples strip (§8.1, §8.3). */
export interface ModelDetail extends ModelEntry {
  samples: Sample[];
}

export interface Sample {
  id: string;
  model_hash: string;
  path: string;
  sidecar_path: string;
  kind: string;
  source_url: string | null;
  params: Record<string, unknown> | null;
  created_at: number;
  media_url: string;
  /** Promoted from an output, so Reuse Parameters works on it (§8.3). */
  reusable: boolean;
}

/**
 * §8.1's list, kept in step with `src/workflows/types.ts` — the server
 * validates a family against that one, so a name missing here is a family the
 * UI cannot offer. It is only the fallback: `app.families` reconciles it with
 * what `/api/families` reports and with what the models on disk are already
 * filed as.
 */
export const FAMILIES = [
  "flux",
  "flux2",
  "krea2",
  "chroma",
  "sdxl",
  "anima",
  "ltx",
  "ltx-2",
  "z-image",
  "wan2",
  "qwen-image",
  "sd15",
] as const;

export interface FamilyCount {
  family: string;
  models: number;
  workflows: number;
}

/** §8.1's two background passes, as they arrive on `/ws`. */
export interface RescanProgress {
  running: boolean;
  folders_done: number;
  folders_total: number;
  models: number;
}

export interface HashingProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  bytes_done: number;
  bytes_total: number;
}

export interface StorageUse {
  files: number;
  bytes: number;
}

export interface Storage {
  data_dir: string;
  outputs: StorageUse;
  inputs: StorageUse;
  samples: StorageUse;
  staging: StorageUse;
  db: StorageUse;
  /** The health log of §7.1, which nothing else needs to run. */
  telemetry: StorageUse;
  total: StorageUse;
}

export interface LoraRow {
  name: string;
  strength_model: number;
  strength_clip: number;
}

// ------------------------------------------------------- telemetry (§7.1)

export type TelemetryUnit = "ms" | "bytes";

export interface TelemetryColumn {
  key: string;
  label: string;
  kind: "time" | "value" | "text" | "number";
}

export interface TelemetryFilterOption {
  value: string | number;
  entries: number;
}

export interface TelemetryFilter {
  /** The URL param, which is also the column it narrows. */
  key: string;
  label: string;
  /** `enum` is picked from `options`; `min` is a number the user types. */
  kind: "enum" | "min";
  column?: string;
  numeric?: boolean;
  unit?: "ms";
  options?: TelemetryFilterOption[];
}

/** One line of a report that draws more than one (§11.2). */
export interface TelemetrySeriesDef {
  key: string;
  label: string;
}

export interface TelemetryReport {
  id: string;
  title: string;
  description: string;
  unit: TelemetryUnit;
  value_label: string;
  columns: TelemetryColumn[];
  filters: TelemetryFilter[];
  /**
   * What an entry is, which is how the graph reads it (§7.1): `events` is
   * something that happened, `gauge` a level that was sampled, `total` a
   * change whose running sum is the line.
   */
  shape: "events" | "gauge" | "total";
  /** The lines the graph draws; absent when it draws one. */
  series?: TelemetrySeriesDef[];
  entries: number;
}

export interface TelemetryPoint {
  id: number;
  at: number;
  value: number;
}

/** One line's points, oldest first; `key` is null for a single-line report. */
export interface TelemetryLine {
  key: string | null;
  points: TelemetryPoint[];
}

export interface TelemetrySeries {
  report: string;
  series: TelemetryLine[];
  /** True when the oldest points were left out to stay under the cap. */
  truncated: boolean;
  total: number;
}

export interface TelemetryEntry {
  id: number;
  report: string;
  at: number;
  value: number;
  label: string | null;
  method: string | null;
  route: string | null;
  status: number | null;
  family: string | null;
  model_class: string | null;
  change: string | null;
  series: string | null;
  /** The raw entry the sidebar shows (§11.2). */
  data: Record<string, unknown>;
}

export interface TelemetryEntryPage {
  report: string;
  entries: TelemetryEntry[];
  cursor: string | null;
}

/**
 * One file in the content-addressed input store (§9). `filename` is what an
 * `image` param holds and what the graph binds; `url` is what the panel and
 * the viewer show.
 */
export interface InputMedia {
  sha256: string;
  ext: string;
  filename: string;
  width: number;
  height: number;
  bytes: number;
  url: string;
  derived_from_output: string | null;
}
