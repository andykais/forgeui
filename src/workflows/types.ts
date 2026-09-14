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
 * `wan2` is one family and not two: ComfyUI builds Wan 2.1 and 2.2 from the
 * same config off the same `head.modulation` key, so a 2.1/2.2 split would be
 * a distinction the files themselves do not draw.
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
  "wan2",
  "qwen-image",
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
  "text_encoder",
  "vae",
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

/**
 * Known `category` values (§4.2). Both are routed on: `img2img` answers
 * "use this image in a workflow", and `upscale` is what the Upscale action
 * looks for in the output's own family (§10).
 */
export const WORKFLOW_CATEGORIES = ["img2img", "upscale"] as const;
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

/**
 * When a param applies at all (§4.3).
 *
 * A switch in a graph leaves some of the panel meaningless: Anima's Turbo
 * routes steps and cfg to a different pair of primitives, so the `steps` and
 * `cfg` fields go on sitting there doing nothing the moment it is on, and
 * Krea 2's enhancer length matters only while the enhancer is running. A
 * field that silently does nothing is worse than no field, because there is
 * no way to tell it apart from one that does.
 *
 * Equality against another param's value, and nothing cleverer: every case
 * so far is "when this checkbox is on", and an expression language here
 * would be a second thing to learn for no more reach.
 */
export interface ParamWhen {
  /** The key whose value decides it. */
  param: string;
  /** The value it has to equal. */
  is: string | number | boolean;
}

export interface ParamCommon {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  /** Renders inside the collapsed Advanced section (§11.2). */
  advanced?: boolean;
  /** Only applies while another param holds a given value (§4.3). */
  when?: ParamWhen;
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

/**
 * Which of two sources feeds one input (§4.4). A checkbox that only sets a
 * widget cannot turn a branch of the graph on and off, and a branch is what
 * some options are: the prompt enhancer is four nodes that either feed the
 * encoder or do not. Rather than ship the same workflow twice, one input is
 * re-linked and the unreached nodes are never executed.
 */
export interface BoolSwitch {
  /** `"<node_id>.<input>"` — the input that changes where it reads from. */
  input: string;
  /** `"<node_id>.<output>"` to link when the box is ticked. */
  on: string;
  /** And when it is not. */
  off: string;
}

export interface BoolParam extends ParamCommon {
  type: "bool";
  bind: string | { switch: BoolSwitch };
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
 * A model file, picked from a class rather than from one folder. `bind` is a
 * scalar naming whatever input the workflow's own loader uses — `ckpt_name`
 * for a checkpoint-shaped graph, `unet_name` for a split-file one — so the
 * pick is a filename substitution, not a change of graph shape (§2).
 *
 * The three types differ only in which class they pick from, which is what
 * makes each picker list the right files: a workflow names a text encoder and
 * a VAE as well as a base model, and offering all of `diffusion` for a VAE
 * slot is not a choice anybody wants.
 */
export type ModelParamType = "model" | "text_encoder" | "vae";

/** The class each type picks from when the manifest does not say. */
export const MODEL_PARAM_CLASS: Record<ModelParamType, ModelClass> = {
  model: "diffusion",
  text_encoder: "clip",
  vae: "vae",
};

export interface ModelParam extends ParamCommon {
  type: ModelParamType;
  /**
   * The input the pick lands in, or every input it lands in.
   *
   * A list is for the graph that reads one file from more than one loader:
   * LTX-2.3 opens its checkpoint three times — the diffusion model, the audio
   * VAE and the AV text-encoder pairing all come out of the same file (§4.6)
   * — and picking a different checkpoint has to move all three or the run is
   * assembled from two different models. One picker, several targets, rather
   * than three pickers nobody can be expected to keep in step.
   */
  bind: string | string[];
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
