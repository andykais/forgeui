/** Manifest and workflow shapes (DESIGN.md §4.2–§4.3). */

import { MODEL_CLASSES, type ModelClass } from "../config/types.ts";

/** A prompt-format graph: the thing that gets queued. */
export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ApiGraph = Record<string, ApiNode>;

/** `[node_id, output_slot]` — how api graphs reference another node. */
export type ApiLink = [string, number];

/**
 * Hardcoded family list (§8.1). A family is an *architecture*, at the
 * granularity a workflow targets: `ltx` and `ltx-2` are separate because
 * LTX-Video 0.9.x conditions on T5 and LTX-2 on Gemma-3, so a model of one
 * cannot be loaded into a workflow built for the other. Same for `flux` and
 * `flux2`, and for `krea2`, which shares a brand with Flux Krea and nothing
 * else.
 *
 * Since the picker orders by family (§5), this is no longer decoration: it
 * is what tells a user which of their models a workflow can actually use.
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
  "sd15",
] as const;
export type Family = typeof FAMILIES[number];

export const PARAM_TYPES = [
  "text",
  "int",
  "float",
  "bool",
  "enum",
  "seed",
  "size",
  "model",
  /** Superseded by `model`; accepted and normalised to it (§5). */
  "checkpoint",
  "lora_list",
  "image",
  "mask",
  "video",
] as const;
export type ParamType = typeof PARAM_TYPES[number];

export const WORKFLOW_KINDS = ["image", "video"] as const;
export type WorkflowKind = typeof WORKFLOW_KINDS[number];

/** Known `category` values; `img2img` is the only one the app routes on (§4.2). */
export const WORKFLOW_CATEGORIES = ["img2img"] as const;
export type WorkflowCategory = typeof WORKFLOW_CATEGORIES[number];

/**
 * Where an `enum` param pulls its options from: a model class (`diffusion`
 * lists every kind that can drive a generation) or any configured folder
 * kind. A kind is not a closed set — `config.yaml` may name any of them —
 * so this is validated as a non-empty string rather than an enum.
 */
export const ENUM_SOURCES = [
  ...MODEL_CLASSES,
  "checkpoints",
  "loras",
  "vae",
  "controlnet",
  "text_encoders",
] as const;
/** A class name, or a `model_folders` key. */
export type EnumSource = string;

export interface ParamCommon {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  /** Renders inside the collapsed Advanced section (§11.2). */
  advanced?: boolean;
}

export interface TextParam extends ParamCommon {
  type: "text";
  bind: string;
  default?: string;
}

export interface NumberParam extends ParamCommon {
  type: "int" | "float";
  bind: string;
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface BoolParam extends ParamCommon {
  type: "bool";
  bind: string;
  default?: boolean;
}

export interface EnumParam extends ParamCommon {
  type: "enum";
  bind: string;
  options?: string[];
  source?: EnumSource;
  default?: string;
}

export interface SeedParam extends ParamCommon {
  type: "seed";
  bind: string;
  /** `-1` means "random at submit" (§4.3). */
  default?: number;
}

export interface SizeParam extends ParamCommon {
  type: "size";
  bind: { w: string; h: string };
  /** The workflow's base resolution; ratio presets resolve against it. */
  default: [number, number];
  /** Snaps ratio results to the model's grid. */
  step?: 8 | 16 | 64;
}

export interface ModelFilter {
  family?: Family;
  /** Which model class the picker lists; defaults to `diffusion` (§5). */
  class?: ModelClass;
}

/**
 * A base model, picked from a class rather than from one folder. `bind` is a
 * scalar naming whatever input the workflow's own loader uses — `ckpt_name`
 * for a checkpoint-shaped graph, `unet_name` for a split-file one — so the
 * pick is a filename substitution, not a change of graph shape (§2).
 */
export interface ModelParam extends ParamCommon {
  type: "model";
  bind: string;
  filter?: ModelFilter;
  default?: string;
}

/** The synthetic chain row that drives the `LoraLoader` splice (§4.4). */
export interface LoraChain {
  model_from: string;
  clip_from: string | null;
  model_to: string[];
  clip_to: string[] | null;
}

export interface LoraRow {
  name: string;
  strength_model: number;
  strength_clip: number;
}

export interface LoraListParam extends ParamCommon {
  type: "lora_list";
  bind: { chain: LoraChain };
  filter?: ModelFilter;
  default?: LoraRow[];
}

export interface MediaParam extends ParamCommon {
  type: "image" | "mask" | "video";
  bind: string;
  /** For `mask`: the `image` param it is painted over. */
  of?: string;
}

export type Param =
  | TextParam
  | NumberParam
  | BoolParam
  | EnumParam
  | SeedParam
  | SizeParam
  | ModelParam
  | LoraListParam
  | MediaParam;

export interface ManifestOutput {
  node: string;
  kind: WorkflowKind;
}

export interface Manifest {
  id: string;
  name: string;
  family: Family | null;
  kind: WorkflowKind;
  category: WorkflowCategory | null;
  description: string | null;
  params: Param[];
  outputs: ManifestOutput[];
}

export type WorkflowSource = "bundled" | "user";

/** One workflow on disk, after loading and validation. */
export interface Workflow {
  id: string;
  source: WorkflowSource;
  dir: string;
  /** True when a user copy shadows a bundled workflow of the same id (§4.6). */
  hasUserCopy: boolean;
  hasBundled: boolean;
  manifest: Manifest | null;
  /** Why the manifest was rejected; the workflow still lists, but cannot run. */
  error: string | null;
  apiGraph: ApiGraph;
  /** LiteGraph document for the embedded editor, if one has been saved. */
  uiGraph: Record<string, unknown> | null;
  /** `sha256(api.json + manifest.json)` (§4.5). */
  hash: string;
}

export function isLink(value: unknown): value is ApiLink {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "string" && typeof value[1] === "number";
}

/** Params a workflow can actually be run with. */
export function isRunnable(workflow: Workflow): boolean {
  return workflow.manifest !== null &&
    workflow.manifest.outputs.length > 0 &&
    Object.keys(workflow.apiGraph).length > 0;
}
