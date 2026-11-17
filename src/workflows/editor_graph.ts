/**
 * A ComfyUI editor document (`workflow.ui.json`, what the editor saves and
 * what ComfyUI's templates and most shared workflows are) turned into the
 * API-format graph a ForgeUI workflow runs (§4.9).
 *
 * The editor does this itself with `graphToPrompt()`, and this follows it,
 * checked against what that produced for every template a stock ComfyUI
 * 0.34 ships (tests/golden/editor_graph/):
 *
 * - **Widget values.** A node's `widgets_values` is positional. Its names
 *   come from the node's inputs as `/object_info` lists them: each value
 *   input in order, a dynamic combo's chosen option's inputs right after it,
 *   and two that hold a value the graph never sees — the
 *   `control_after_generate` choice after a seed, the upload button after
 *   a file picker.
 * - **Links** are followed to the node that actually produces the value:
 *   through `Reroute`, through a bypassed node (mode 4) to its input of the
 *   same type, into a subgraph to what feeds its output, and out of one to
 *   what feeds the instance's input. A muted node (mode 2) feeds nothing.
 * - **Subgraphs** are flattened. An inner node is named
 *   `<instance id>:<inner id>`, as ComfyUI names it, nested as deep as the
 *   subgraphs are. An input the instance leaves unconnected keeps the inner
 *   node's own value.
 * - **Editor-only nodes** (`Note`, `MarkdownNote`, `Reroute`,
 *   `PrimitiveNode`) are not queued: a `PrimitiveNode`'s value is written
 *   into each input it fed.
 */

import type { ApiGraph } from "./types.ts";
import {
  type ObjectInfo,
  type ObjectInfoNode,
  type ParsedInput,
  parseInputs,
} from "./node_spec.ts";

/** Subgraph inputs that show as a widget on the instance. */
const VALUE_TYPES = new Set([
  "INT",
  "FLOAT",
  "STRING",
  "BOOLEAN",
  "COMBO",
  "COMFY_DYNAMICCOMBO_V3",
]);

/**
 * Widgets whose value the editor makes itself, at the moment it queues — a
 * rendered 3D view, a painted canvas sized to its picture. Nothing outside
 * the editor can produce one, so a graph using them is said to need it.
 */
const EDITOR_RENDERED_TYPES = new Set([
  "LOAD_3D",
  "LOAD3D_CAMERA",
  "LOAD3D_MODEL_INFO",
]);

/** What the editor always sends for a widget that only displays. */
const EDITOR_FIXED_VALUES: Record<string, unknown> = {
  IMAGECOMPARE: ["", ""],
};

/** Node types the editor draws and the server never sees. */
const EDITOR_ONLY = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
]);

const MODE_MUTED = 2;
const MODE_BYPASSED = 4;
/** A subgraph's own input and output nodes, as its links name them. */
const SUBGRAPH_INPUT = -10;
const SUBGRAPH_OUTPUT = -20;

interface EditorLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
}

interface EditorNode {
  id: number;
  type: string;
  mode?: number;
  title?: string;
  inputs?: {
    name: string;
    type?: string;
    link?: number | null;
    widget?: { name: string };
  }[];
  outputs?: {
    name?: string;
    type?: string;
    links?: number[] | null;
    widget?: { name: string };
  }[];
  widgets_values?: unknown[] | Record<string, unknown> | null;
  properties?: Record<string, unknown>;
}

interface SubgraphDef {
  id: string;
  name?: string;
  inputs?: { name: string; type?: string; linkIds?: number[] }[];
  outputs?: { name: string; type?: string; linkIds?: number[] }[];
  nodes: EditorNode[];
  links: unknown[];
}

interface Scope {
  nodes: Map<number, EditorNode>;
  links: Map<number, EditorLink>;
  /** The subgraph this scope is the inside of, with its instance. */
  subgraph: SubgraphDef | null;
  instance: EditorNode | null;
  parent: Scope | null;
  /** What this scope's node ids are prefixed with: `238:` inside node 238. */
  prefix: string;
}

export interface Converted {
  graph: ApiGraph;
  /** What stops the graph from being used: an unknown node type, a cycle. */
  errors: string[];
  /** What was dropped or assumed, for the caller to know about. */
  notes: string[];
}

type Source =
  | { link: [string, number] }
  | { value: unknown }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Links are arrays at the top level and objects inside a subgraph. */
function readLink(raw: unknown): EditorLink | null {
  if (Array.isArray(raw) && raw.length >= 5) {
    const [id, origin_id, origin_slot, target_id, target_slot, type] = raw;
    return {
      id: Number(id),
      origin_id: Number(origin_id),
      origin_slot: Number(origin_slot),
      target_id: Number(target_id),
      target_slot: Number(target_slot),
      type: String(type ?? "*"),
    };
  }
  if (isRecord(raw) && raw.id !== undefined) {
    return {
      id: Number(raw.id),
      origin_id: Number(raw.origin_id),
      origin_slot: Number(raw.origin_slot),
      target_id: Number(raw.target_id),
      target_slot: Number(raw.target_slot),
      type: String(raw.type ?? "*"),
    };
  }
  return null;
}

function makeScope(
  nodes: EditorNode[],
  links: unknown[],
  subgraph: SubgraphDef | null,
  instance: EditorNode | null,
  parent: Scope | null,
  prefix: string,
): Scope {
  const linkMap = new Map<number, EditorLink>();
  for (const raw of links ?? []) {
    const link = readLink(raw);
    if (link) linkMap.set(link.id, link);
  }
  return {
    nodes: new Map(nodes.map((node) => [Number(node.id), node])),
    links: linkMap,
    subgraph,
    instance,
    parent,
    prefix,
  };
}

/** Whether a link of `type` fits an input of `wanted`. */
function fits(type: string | undefined, wanted: string | undefined): boolean {
  if (!type || !wanted || type === "*" || wanted === "*") return true;
  const a = type.split(",");
  return wanted.split(",").some((t) => a.includes(t));
}

/** What a widget the document has no value for starts at in the editor. */
function defaultOf(input: ParsedInput): unknown {
  if (input.options.default !== undefined) return input.options.default;
  if (input.choices && input.choices.length > 0) return input.choices[0];
  return undefined;
}

/**
 * Name → value for a node's widgets, from its positional `widgets_values`.
 *
 * Read against the node's inputs in order: a value input takes the next
 * slot; a seed's `control_after_generate` and a file picker's upload button
 * each take one more that the graph never sees; a dynamic combo's chosen
 * option's inputs follow it. A document saved before a node grew an input
 * has fewer values than widgets, and the editor starts the rest at their
 * defaults, so this does too.
 */
function widgetValues(
  node: EditorNode,
  schema: ObjectInfoNode,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const raw = node.widgets_values;
  if (isRecord(raw)) {
    for (const [name, value] of Object.entries(raw)) out.set(name, value);
    return out;
  }
  const values = Array.isArray(raw) ? raw : [];
  let at = 0;
  const read = (inputs: ParsedInput[]) => {
    for (const input of inputs) {
      if (input.kind === "link" || input.kind === "autogrow") continue;
      const value = at < values.length ? values[at] : defaultOf(input);
      at++;
      if (value !== undefined) out.set(input.name, value);
      const o = input.options;
      // The editor gives every INT called seed or noise_seed the control,
      // whether or not the node asks for one.
      if (
        o.control_after_generate === true ||
        (input.type === "INT" &&
          (input.name === "seed" || input.name === "noise_seed"))
      ) at++;
      if (
        o.image_upload === true || o.video_upload === true ||
        o.audio_upload === true || o.file_upload === true
      ) at++;
      if (input.kind === "dynamic_combo") {
        const chosen = input.dynamic?.find((d) => d.key === value);
        if (chosen) read(chosen.inputs);
      }
    }
  };
  read(parseInputs(schema));
  return out;
}

/**
 * A literal as the prompt carries it: a list is wrapped as
 * `{"__value__": [...]}`, which ComfyUI unwraps, so that it is not read as
 * a `[node, slot]` link.
 */
function literal(value: unknown): unknown {
  return Array.isArray(value) ? { __value__: value } : value;
}

export function editorToApi(doc: unknown, info: ObjectInfo): Converted {
  const errors: string[] = [];
  const notes: string[] = [];
  const graph: ApiGraph = {};
  if (!isRecord(doc) || !Array.isArray(doc.nodes)) {
    return {
      graph,
      errors: [
        "not a ComfyUI editor document: expected {nodes: [...], links: " +
        "[...]} as the editor saves it (an API-format graph goes in " +
        "api_json instead)",
      ],
      notes,
    };
  }
  const subgraphs = new Map<string, SubgraphDef>();
  const definitions = isRecord(doc.definitions) ? doc.definitions : {};
  for (
    const sg of Array.isArray(definitions.subgraphs)
      ? definitions.subgraphs
      : []
  ) {
    if (isRecord(sg) && typeof sg.id === "string") {
      subgraphs.set(sg.id, sg as unknown as SubgraphDef);
    }
  }
  if (
    isRecord(doc.extra) && isRecord(doc.extra.groupNodes) &&
    Object.keys(doc.extra.groupNodes).length > 0
  ) {
    errors.push(
      "this document uses group nodes (an older editor feature); open it in " +
        "ComfyUI's editor and convert them to subgraphs first",
    );
  }

  const root = makeScope(
    doc.nodes as EditorNode[],
    Array.isArray(doc.links) ? doc.links : [],
    null,
    null,
    null,
    "",
  );
  const missing = new Set<string>();

  /** The scope inside a subgraph instance. */
  const inside = (scope: Scope, node: EditorNode): Scope => {
    const sg = subgraphs.get(node.type)!;
    return makeScope(
      sg.nodes,
      sg.links,
      sg,
      node,
      scope,
      `${scope.prefix}${node.id}:`,
    );
  };

  /** What feeds `link` in `scope`, followed to a real node or a value. */
  const resolveLink = (
    scope: Scope,
    linkId: number | null | undefined,
    depth = 0,
  ): Source => {
    if (linkId === null || linkId === undefined || depth > 200) return null;
    const link = scope.links.get(Number(linkId));
    if (!link) return null;
    return resolveOutput(
      scope,
      link.origin_id,
      link.origin_slot,
      link.type,
      depth + 1,
    );
  };

  const resolveOutput = (
    scope: Scope,
    nodeId: number,
    slot: number,
    type: string,
    depth: number,
  ): Source => {
    if (nodeId === SUBGRAPH_INPUT) {
      // Out of the subgraph, to whatever feeds its instance's input.
      const sgInputs = scope.subgraph?.inputs ?? [];
      const name = sgInputs[slot]?.name;
      const input = scope.instance?.inputs?.find((i) => i.name === name);
      if (scope.parent && input && input.link != null) {
        const fed = resolveLink(scope.parent, input.link, depth);
        if (fed !== null) return fed;
      }
      // Unconnected: the value the instance shows for it, when it keeps
      // one — positional over the subgraph's value inputs. A newer editor
      // keeps none there (`proxyWidgets`) and the inner node's own stands.
      const held = scope.instance?.widgets_values;
      if (Array.isArray(held) && held.length > 0) {
        const valueInputs = sgInputs.filter((i) =>
          VALUE_TYPES.has(i.type ?? "")
        );
        const at = valueInputs.findIndex((i) => i === sgInputs[slot]);
        if (at >= 0 && at < held.length) return { value: held[at] };
      }
      // A promoted widget lives on the inner node it was promoted from —
      // the instance's `proxyWidgets` names which — and every input the
      // subgraph input feeds gets that widget's value. Without one, each
      // input keeps its own.
      const proxies = scope.instance?.properties?.proxyWidgets;
      if (Array.isArray(proxies)) {
        for (const link of scope.links.values()) {
          if (link.origin_id !== SUBGRAPH_INPUT || link.origin_slot !== slot) {
            continue;
          }
          const target = scope.nodes.get(link.target_id);
          const schema = target ? info[target.type] : undefined;
          const widget = target?.inputs?.[link.target_slot]?.widget?.name;
          if (!target || !schema || !widget) continue;
          const promoted = proxies.some((p) =>
            Array.isArray(p) && String(p[0]) === String(target.id) &&
            p[1] === widget
          );
          if (!promoted) continue;
          const values = widgetValues(target, schema);
          if (values.has(widget)) return { value: values.get(widget) };
        }
      }
      return null;
    }
    const node = scope.nodes.get(nodeId);
    if (!node) return null;
    const mode = node.mode ?? 0;
    if (mode === MODE_MUTED) return null;
    if (node.type === "Reroute") {
      return resolveLink(scope, node.inputs?.[0]?.link, depth);
    }
    if (node.type === "PrimitiveNode") {
      const values = Array.isArray(node.widgets_values)
        ? node.widgets_values
        : [];
      return values.length > 0 ? { value: values[0] } : null;
    }
    if (mode === MODE_BYPASSED) {
      // A bypassed node hands on its input of the output's type: the one at
      // the same position when that fits, else the first that does.
      const inputs = node.inputs ?? [];
      const outType = node.outputs?.[slot]?.type ?? type;
      const same = inputs[slot];
      const through = same && same.link != null && fits(outType, same.type)
        ? same
        : inputs.find((i) => i.link != null && fits(outType, i.type));
      return through ? resolveLink(scope, through.link, depth) : null;
    }
    if (subgraphs.has(node.type)) {
      const inner = inside(scope, node);
      const feed = [...inner.links.values()].find((l) =>
        l.target_id === SUBGRAPH_OUTPUT && l.target_slot === slot
      );
      return feed
        ? resolveOutput(
          inner,
          feed.origin_id,
          feed.origin_slot,
          feed.type,
          depth + 1,
        )
        : null;
    }
    return { link: [`${scope.prefix}${node.id}`, slot] };
  };

  const emit = (scope: Scope, depth = 0) => {
    if (depth > 32) {
      errors.push("subgraphs nested more than 32 deep, or inside themselves");
      return;
    }
    for (const node of scope.nodes.values()) {
      const mode = node.mode ?? 0;
      if (mode === MODE_MUTED || mode === MODE_BYPASSED) continue;
      if (EDITOR_ONLY.has(node.type)) continue;
      if (subgraphs.has(node.type)) {
        emit(inside(scope, node), depth + 1);
        continue;
      }
      const schema = info[node.type];
      if (!schema) {
        missing.add(node.type);
        continue;
      }
      const inputs: Record<string, unknown> = {};
      for (const [name, value] of widgetValues(node, schema)) {
        inputs[name] = literal(value);
      }
      for (const input of parseInputs(schema)) {
        // Whatever preview was saved with it, the editor sends its own.
        if (input.type in EDITOR_FIXED_VALUES) {
          inputs[input.name] = literal(EDITOR_FIXED_VALUES[input.type]);
        }
        if (
          EDITOR_RENDERED_TYPES.has(input.type) ||
          input.options.widgetType === "PAINTER" ||
          input.name === "viewport_state"
        ) {
          notes.push(
            `node "${scope.prefix}${node.id}" (${node.type}): "${input.name}" ` +
              `is made by ComfyUI's editor when it queues (a rendered view or ` +
              `a painted canvas), so this node will not run as converted; ` +
              `replace it or save the workflow from the editor`,
          );
        }
      }
      for (const input of node.inputs ?? []) {
        if (input.link === null || input.link === undefined) continue;
        const name = input.widget?.name ?? input.name;
        const source = resolveLink(scope, input.link);
        if (source === null) continue; // keeps its own value, if it has one
        inputs[name] = "link" in source ? source.link : literal(source.value);
      }
      graph[`${scope.prefix}${node.id}`] = {
        class_type: node.type,
        inputs,
        _meta: { title: node.title ?? schema.display_name ?? node.type },
      } as ApiGraph[string];
    }
  };
  emit(root);

  for (const type of [...missing].sort()) {
    errors.push(
      `node type "${type}" is not in this ComfyUI — a custom node pack ` +
        `that is not installed (list_node_packs says what is)`,
    );
  }
  return { graph, errors, notes };
}
