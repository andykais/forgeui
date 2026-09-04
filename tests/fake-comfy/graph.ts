/**
 * Graph shape validation for the fake ComfyUI. It deliberately mirrors the
 * checks real ComfyUI performs before queueing: node types must exist, links
 * must point at nodes that exist, and the prompt must have an output node.
 * Bundled workflows are held to the core node set (§4.6), so a workflow that
 * reaches for a custom node fails in tests instead of at the user's machine.
 */

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ApiGraph = Record<string, ApiNode>;

/** Core ComfyUI nodes the bundled workflows are allowed to use. */
export const CORE_NODE_TYPES: readonly string[] = [
  "CLIPLoader",
  "CLIPSetLastLayer",
  "CLIPTextEncode",
  "CheckpointLoaderSimple",
  "ConditioningZeroOut",
  "DualCLIPLoader",
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "ImageScale",
  "KSampler",
  "KSamplerAdvanced",
  "LoadImage",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "ModelSamplingSD3",
  "SaveAnimatedWEBP",
  "SaveImage",
  "UNETLoader",
  "VAEDecode",
  "VAEEncode",
  "VAELoader",
];

/** Nodes that write files, i.e. the ones a prompt is queued for. */
export const OUTPUT_NODE_TYPES: readonly string[] = [
  "SaveAnimatedWEBP",
  "SaveImage",
];

export interface NodeError {
  errors: {
    type: string;
    message: string;
    details: string;
    extra_info: Record<string, unknown>;
  }[];
  dependent_outputs: string[];
  class_type: string;
}

export interface ValidationFailure {
  ok: false;
  message: string;
  nodeErrors: Record<string, NodeError>;
}

export interface ValidationSuccess {
  ok: true;
  /** Node ids in insertion order. */
  order: string[];
  /** Ids of the output nodes, in insertion order. */
  outputNodes: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ValidateOptions {
  /** Node types accepted on top of {@link CORE_NODE_TYPES}. */
  extraNodeTypes?: readonly string[];
}

function nodeError(classType: string, message: string): NodeError {
  return {
    errors: [{
      type: "invalid_prompt",
      message,
      details: "",
      extra_info: {},
    }],
    dependent_outputs: [],
    class_type: classType,
  };
}

export function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "string" && typeof value[1] === "number";
}

export function validateGraph(
  prompt: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const nodeErrors: Record<string, NodeError> = {};
  if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt)) {
    return {
      ok: false,
      message: "prompt must be an object of nodes",
      nodeErrors,
    };
  }
  const graph = prompt as Record<string, unknown>;
  const ids = Object.keys(graph);
  if (ids.length === 0) {
    return { ok: false, message: "prompt is empty", nodeErrors };
  }

  const known = new Set([
    ...CORE_NODE_TYPES,
    ...(options.extraNodeTypes ?? []),
  ]);
  const outputNodes: string[] = [];

  for (const id of ids) {
    const raw = graph[id];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      nodeErrors[id] = nodeError("", "node must be an object");
      continue;
    }
    const node = raw as Record<string, unknown>;
    const classType = node.class_type;
    if (typeof classType !== "string" || classType.length === 0) {
      nodeErrors[id] = nodeError("", "missing class_type");
      continue;
    }
    if (!known.has(classType)) {
      nodeErrors[id] = nodeError(
        classType,
        `unknown node type "${classType}" (not a core ComfyUI node)`,
      );
      continue;
    }
    const rawInputs = node.inputs;
    if (
      typeof rawInputs !== "object" || rawInputs === null ||
      Array.isArray(rawInputs)
    ) {
      nodeErrors[id] = nodeError(classType, "missing inputs object");
      continue;
    }
    const inputs = rawInputs as Record<string, unknown>;
    for (const [name, value] of Object.entries(inputs)) {
      if (!Array.isArray(value)) continue;
      if (!isLink(value)) {
        nodeErrors[id] = nodeError(
          classType,
          `input "${name}" is not a [node_id, slot] link`,
        );
        continue;
      }
      if (!(value[0] in graph)) {
        nodeErrors[id] = nodeError(
          classType,
          `input "${name}" links to unknown node "${value[0]}"`,
        );
      }
    }
    if (OUTPUT_NODE_TYPES.includes(classType)) {
      if (typeof inputs.filename_prefix !== "string") {
        nodeErrors[id] = nodeError(
          classType,
          "output node needs a string filename_prefix",
        );
        continue;
      }
      outputNodes.push(id);
    }
  }

  if (Object.keys(nodeErrors).length > 0) {
    return {
      ok: false,
      message: "Prompt has invalid nodes",
      nodeErrors,
    };
  }
  if (outputNodes.length === 0) {
    return {
      ok: false,
      message: "Prompt has no output node",
      nodeErrors,
    };
  }
  return { ok: true, order: ids, outputNodes };
}

export interface PrefixParts {
  /** Directory below the output root, `""` when the prefix has no slash. */
  subfolder: string;
  /** Leading part of the written filenames. */
  prefix: string;
}

/** `<jobid>/out` → `{ subfolder: "<jobid>", prefix: "out" }`. */
export function splitFilenamePrefix(filenamePrefix: string): PrefixParts {
  const normalized = filenamePrefix.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return { subfolder: "", prefix: normalized };
  return {
    subfolder: normalized.slice(0, slash),
    prefix: normalized.slice(slash + 1),
  };
}

/** First `KSampler`-ish node, else the node feeding the first output node. */
export function samplerNode(graph: ApiGraph): string | null {
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type.startsWith("KSampler")) return id;
  }
  return Object.keys(graph)[0] ?? null;
}
