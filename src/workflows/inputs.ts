import { CORE_NODES } from "./nodes.ts";
import { type ApiGraph, isLink, type Manifest, type Param } from "./types.ts";

/**
 * Every literal (non-link) input in `workflow.api.json`, which is what the
 * manifest editor lists (§4.7). `lora_list` is not here: it is a synthetic
 * chain row, not a node input, and the header count must not include it.
 */
export interface LiteralInput {
  node_id: string;
  node_type: string;
  node_title: string | null;
  input: string;
  value: unknown;
  type_hint: "text" | "int" | "float" | "bool" | "enum" | "unknown";
  /** The manifest param key that already exposes it, if any. */
  exposed_by: string | null;
}

/** Inputs ComfyUI renders as a combo rather than a text field. */
const COMBO_INPUTS = new Set([
  "sampler_name",
  "scheduler",
  "type",
  "weight_dtype",
  "crop",
  "upscale_method",
  "method",
  "add_noise",
  "return_with_leftover_noise",
]);

const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|sft|gguf|bin)$/i;

function typeHint(input: string, value: unknown): LiteralInput["type_hint"] {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "string") {
    // A hint only: the user picks the real type in the manifest editor.
    if (COMBO_INPUTS.has(input) || MODEL_FILE.test(value)) return "enum";
    return "text";
  }
  return "unknown";
}

/** Which literal inputs a manifest already binds, keyed `<node>.<input>`. */
export function boundInputs(manifest: Manifest | null): Map<string, string> {
  const bound = new Map<string, string>();
  const add = (bind: string, param: Param) => bound.set(bind, param.key);
  for (const param of manifest?.params ?? []) {
    switch (param.type) {
      case "size":
        add(param.bind.w, param);
        add(param.bind.h, param);
        break;
      case "lora_list":
        break;
      default:
        add(param.bind, param);
    }
  }
  return bound;
}

export function literalInputs(
  graph: ApiGraph,
  manifest: Manifest | null = null,
): LiteralInput[] {
  const bound = boundInputs(manifest);
  const out: LiteralInput[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    const order = CORE_NODES[node.class_type]?.widgets;
    const literals = Object.entries(node.inputs).filter(([, value]) =>
      !isLink(value)
    );
    const sorted = order
      ? literals.sort(([a], [b]) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
      })
      : literals;
    for (const [input, value] of sorted) {
      out.push({
        node_id: nodeId,
        node_type: node.class_type,
        node_title: node._meta?.title ?? null,
        input,
        value,
        type_hint: typeHint(input, value),
        exposed_by: bound.get(`${nodeId}.${input}`) ?? null,
      });
    }
  }
  return out;
}
