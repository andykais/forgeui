import { parseBind } from "./manifest.ts";
import { outputSlot } from "./nodes.ts";
import type {
  ApiGraph,
  ApiLink,
  LoraChain,
  LoraRow,
  Manifest,
  Param,
} from "./types.ts";

export class RewriteError extends Error {
  override readonly name = "RewriteError";
}

export interface RewriteOptions {
  manifest: Manifest;
  graph: ApiGraph;
  /** Already coerced by {@link coerceParams}. */
  params: Record<string, unknown>;
  /** The job's ULID; every output node writes under `<jobid>/`. */
  jobId: string;
}

export interface RewriteResult {
  graph: ApiGraph;
  /** Nodes that will write files, in manifest order. */
  outputNodes: string[];
  filenamePrefix: string;
}

function node(graph: ApiGraph, id: string, where: string) {
  const found = graph[id];
  if (!found) throw new RewriteError(`${where}: no node "${id}" in the graph`);
  return found;
}

function setScalar(
  graph: ApiGraph,
  bind: string,
  value: unknown,
  where: string,
): void {
  const { node: id, input } = parseBind(bind, where);
  node(graph, id, where).inputs[input] = value;
}

function resolveSource(
  graph: ApiGraph,
  reference: string,
  where: string,
): ApiLink {
  const { node: id, input: outputName } = parseBind(reference, where);
  const source = node(graph, id, where);
  const slot = outputSlot(source.class_type, outputName);
  if (slot === null) {
    throw new RewriteError(
      `${where}: ${source.class_type} has no output "${outputName}"`,
    );
  }
  return [id, slot];
}

function nextNodeId(graph: ApiGraph): () => string {
  let next = Object.keys(graph).reduce(
    (max, id) => (/^\d+$/.test(id) ? Math.max(max, Number(id)) : max),
    0,
  );
  return () => String(++next);
}

/**
 * Splice one `LoraLoader` per row into the graph and rewire the chain's
 * targets onto the last one (§4.4). Model-only chains use
 * `LoraLoaderModelOnly`. Zero rows leave the graph untouched.
 */
function spliceLoras(
  graph: ApiGraph,
  chain: LoraChain,
  rows: LoraRow[],
  where: string,
): void {
  if (rows.length === 0) return;

  let model = resolveSource(graph, chain.model_from, `${where}.model_from`);
  let clip = chain.clip_from
    ? resolveSource(graph, chain.clip_from, `${where}.clip_from`)
    : null;
  const nextId = nextNodeId(graph);

  for (const row of rows) {
    const id = nextId();
    graph[id] = clip
      ? {
        class_type: "LoraLoader",
        inputs: {
          model,
          clip,
          lora_name: row.name,
          strength_model: row.strength_model,
          strength_clip: row.strength_clip,
        },
        _meta: { title: "Load LoRA" },
      }
      : {
        class_type: "LoraLoaderModelOnly",
        inputs: {
          model,
          lora_name: row.name,
          strength_model: row.strength_model,
        },
        _meta: { title: "LoraLoaderModelOnly" },
      };
    model = [id, 0];
    if (clip) clip = [id, 1];
  }

  for (const [i, target] of chain.model_to.entries()) {
    setScalar(graph, target, model, `${where}.model_to[${i}]`);
  }
  for (const [i, target] of (chain.clip_to ?? []).entries()) {
    if (!clip) {
      throw new RewriteError(
        `${where}: clip_to is set but the chain has no clip source`,
      );
    }
    setScalar(graph, target, clip, `${where}.clip_to[${i}]`);
  }
}

function applyParam(
  graph: ApiGraph,
  param: Param,
  value: unknown,
): void {
  const where = `params.${param.key}`;
  switch (param.type) {
    case "size": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new RewriteError(`${where}: expected [width, height]`);
      }
      setScalar(graph, param.bind.w, value[0], `${where}.w`);
      setScalar(graph, param.bind.h, value[1], `${where}.h`);
      return;
    }
    case "lora_list":
      spliceLoras(
        graph,
        param.bind.chain,
        (value ?? []) as LoraRow[],
        `${where}.chain`,
      );
      return;
    case "bool": {
      // A switched checkbox picks which of two sources feeds one input, so
      // that a branch of the graph can be turned on and off rather than
      // shipped as a second workflow (§4.4). ComfyUI executes only what an
      // output needs, so the side that is not linked never runs.
      if (typeof param.bind !== "string") {
        const { input, on, off } = param.bind.switch;
        const source = value === true ? on : off;
        setScalar(
          graph,
          input,
          resolveSource(
            graph,
            source,
            `${where}.${value === true ? "on" : "off"}`,
          ),
          `${where}.input`,
        );
        return;
      }
      setScalar(graph, param.bind, value, where);
      return;
    }
    case "image":
    case "mask":
    case "video":
      // An optional input the user left empty keeps whatever the graph has.
      if (value === null || value === undefined || value === "") return;
      setScalar(graph, param.bind, value, where);
      return;
    case "model":
    case "text_encoder":
    case "vae":
      // One file, however many loaders open it (§4.6).
      if (Array.isArray(param.bind)) {
        for (const [i, target] of param.bind.entries()) {
          setScalar(graph, target, value, `${where}[${i}]`);
        }
        return;
      }
      setScalar(graph, param.bind, value, where);
      return;
    default:
      setScalar(graph, param.bind, value, where);
  }
}

/**
 * Turn a workflow plus a set of coerced params into the exact graph that gets
 * queued (§5 step 3): scalars bound, LoRAs spliced, and every output node
 * stamped with `<jobid>/out` so all files land in `staging/<jobid>/`.
 */
export function rewriteGraph(options: RewriteOptions): RewriteResult {
  const { manifest, params, jobId } = options;
  if (jobId.length === 0 || jobId.includes("/") || jobId.includes("\\")) {
    throw new RewriteError(`jobId: "${jobId}" is not a usable directory name`);
  }
  const graph: ApiGraph = structuredClone(options.graph);

  for (const param of manifest.params) {
    if (!(param.key in params)) continue;
    applyParam(graph, param, params[param.key]);
  }

  const filenamePrefix = `${jobId}/out`;
  const outputNodes: string[] = [];
  for (const output of manifest.outputs) {
    const target = node(graph, output.node, `outputs.${output.node}`);
    target.inputs.filename_prefix = filenamePrefix;
    outputNodes.push(output.node);
  }
  if (outputNodes.length === 0) {
    throw new RewriteError(
      "manifest.outputs is empty: this workflow has nothing to save",
    );
  }

  return { graph, outputNodes, filenamePrefix };
}
