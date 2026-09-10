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
  thumb_path: string | null;
  thumb_url: string | null;
  output_count: number;
  last_used_at: number | null;
  /** True until the background hasher has read the file (§8.1). */
  hashing: boolean;
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

/** The hardcoded list of §8.1; the app attaches no behaviour to a family. */
export const FAMILIES = ["flux", "sdxl", "anima", "ltx", "z-image", "sd15"] as const;

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
  total: StorageUse;
}

export interface LoraRow {
  name: string;
  strength_model: number;
  strength_clip: number;
}
