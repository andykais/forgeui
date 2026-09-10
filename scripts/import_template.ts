/**
 * Turn a ComfyUI workflow template into the flat api graph ForgeUI queues.
 *
 * Every current template is a Subgraph: the saved document holds three or
 * four top-level nodes, one of which is a UUID-typed instance of a definition
 * under `definitions.subgraphs`, and the real graph — loaders, sampler,
 * decode — lives inside that definition. ComfyUI flattens it at
 * `graphToPrompt()` time because the prompt format has no subgraph concept,
 * and this does the same thing offline.
 *
 * Widget values are positional in `widgets_values`, so decoding them needs
 * the widget order for each node type. That order already lives in
 * `src/workflows/nodes.ts`, which is the repo's one copy of it; a node type
 * missing from there is an error naming the type rather than a guess.
 *
 *   deno run --allow-read --allow-write scripts/import_template.ts \
 *     <template.json> <out/workflow.api.json> [--subgraph <index>]
 */

import { CORE_NODES } from "../src/workflows/nodes.ts";
import type { ApiGraph, ApiNode } from "../src/workflows/types.ts";

/** Nodes that exist only to annotate the canvas. */
const CANVAS_ONLY = new Set(["MarkdownNote", "Note", "PreviewAny", "Reroute"]);

/** `origin_id` of a link fed by the subgraph's own boundary. */
const BOUNDARY = -10;
/** `target_id` of a link leaving the subgraph through one of its outputs. */
const OUTPUT_BOUNDARY = -20;

interface UiLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type?: string;
}

/**
 * The editor writes links two ways in the same document: subgraph
 * definitions use the object form, the top-level graph the older positional
 * array `[id, origin, origin_slot, target, target_slot, type]`.
 */
type RawLink = UiLink | [number, number, number, number, number, string?];

function linkMap(raw: RawLink[] | undefined): Map<number, UiLink> {
  const out = new Map<number, UiLink>();
  for (const link of raw ?? []) {
    const normalised: UiLink = Array.isArray(link)
      ? {
        id: link[0],
        origin_id: link[1],
        origin_slot: link[2],
        target_id: link[3],
        target_slot: link[4],
        type: link[5],
      }
      : link;
    out.set(normalised.id, normalised);
  }
  return out;
}

interface UiSlot {
  name: string;
  type?: string;
  link?: number | null;
  links?: number[] | null;
  widget?: { name: string };
}

interface UiNode {
  id: number;
  type: string;
  inputs?: UiSlot[];
  outputs?: UiSlot[];
  widgets_values?: unknown[] | null;
  title?: string;
  mode?: number;
}

interface UiSubgraph extends UiGraph {
  id: string;
  name?: string;
  outputs?: UiSlot[];
}

interface UiGraph {
  nodes?: UiNode[];
  links?: RawLink[];
  definitions?: { subgraphs?: UiSubgraph[] };
}

export class ImportError extends Error {
  override readonly name = "ImportError";
}

/**
 * Widget values as `{inputName: value}`. The editor writes UI-only widgets
 * into the same array — the `control_after_generate` combo that follows a
 * seed is the common one — so they are skipped by the same `after` table the
 * LiteGraph rebuild uses.
 */
function widgetsOf(node: UiNode): Record<string, unknown> {
  const schema = CORE_NODES[node.type];
  if (!schema) {
    throw new ImportError(
      `no widget order for "${node.type}": add it to src/workflows/nodes.ts`,
    );
  }
  const values = node.widgets_values ?? [];
  if (!Array.isArray(values)) return {};
  const out: Record<string, unknown> = {};
  let at = 0;
  for (const name of schema.widgets ?? []) {
    if (at >= values.length) break;
    out[name] = values[at++];
    // A UI-only widget sits directly after the one it decorates.
    if (schema.after && name in schema.after) at++;
  }
  // Values left over mean the widget list is short, and every name after the
  // gap would take the wrong value — steps reading what cfg meant. A node
  // with a `DynamicCombo` input does this: one declared input expands into
  // however many widgets the selected option carries, so its width cannot be
  // known from the schema. Refuse rather than write a plausible wrong graph.
  if (at < values.length) {
    throw new ImportError(
      `${node.type}: ${values.length} widget values but ` +
        `src/workflows/nodes.ts accounts for ${at}. ` +
        `Left over: ${JSON.stringify(values.slice(at)).slice(0, 120)}`,
    );
  }
  return out;
}

/** Follow a link back to the node and slot that produced it. */
function sourceOf(
  links: Map<number, UiLink>,
  linkId: number,
): { node: number; slot: number } | null {
  const link = links.get(linkId);
  if (!link || link.origin_id === BOUNDARY) return null;
  return { node: link.origin_id, slot: link.origin_slot };
}

export interface FlattenOptions {
  /** Which subgraph definition to use when a template holds several. */
  subgraph?: number;
}

export function flatten(
  document: UiGraph,
  options: FlattenOptions = {},
): ApiGraph {
  const definitions = document.definitions?.subgraphs ?? [];
  if (definitions.length === 0) {
    throw new ImportError("this template has no subgraph definitions");
  }
  const index = options.subgraph ?? 0;
  const definition = definitions[index];
  if (!definition) {
    throw new ImportError(
      `--subgraph ${index}: the template has ${definitions.length}`,
    );
  }

  const inner = definition.nodes ?? [];
  const links = linkMap(definition.links);

  const graph: ApiGraph = {};
  for (const node of inner) {
    if (CANVAS_ONLY.has(node.type)) continue;
    // Mode 2 and 4 are "muted" and "bypassed": the editor keeps them, the
    // prompt does not.
    if (node.mode === 2 || node.mode === 4) continue;
    const api: ApiNode = {
      class_type: node.type,
      inputs: { ...widgetsOf(node) },
    };
    for (const slot of node.inputs ?? []) {
      if (slot.link === null || slot.link === undefined) continue;
      const source = sourceOf(links, slot.link);
      // A boundary link carries a value the parent supplies; the inner node
      // keeps its own widget value for it, which widgetsOf already took.
      if (!source) continue;
      api.inputs[slot.name] = [String(source.node), source.slot];
    }
    if (node.title) api._meta = { title: node.title };
    graph[String(node.id)] = api;
  }

  appendOutputs(graph, document, definition, links);
  return graph;
}

/**
 * The nodes that write files sit in the parent document, outside the
 * subgraph, fed through its output slots. Wire each one straight onto the
 * inner node that produces the slot, which is what flattening means here.
 */
function appendOutputs(
  graph: ApiGraph,
  document: UiGraph,
  definition: UiSubgraph,
  innerLinks: Map<number, UiLink>,
): void {
  // Which inner node produces each of the subgraph's output slots.
  const producers = new Map<number, { node: number; slot: number }>();
  for (const link of innerLinks.values()) {
    if (link.target_id !== OUTPUT_BOUNDARY) continue;
    producers.set(link.target_slot, {
      node: link.origin_id,
      slot: link.origin_slot,
    });
  }

  const outerLinks = linkMap(document.links);
  const instances = new Set(
    (document.nodes ?? []).filter((node) => node.type === definition.id).map((
      node,
    ) => node.id),
  );

  let next = Object.keys(graph).reduce(
    (max, id) => (/^\d+$/.test(id) ? Math.max(max, Number(id)) : max),
    0,
  );

  for (const node of document.nodes ?? []) {
    if (!CORE_NODES[node.type]?.output) continue;
    // A template holding several variants ships all but one bypassed, the
    // instance and its save node together. Which variant this is came from
    // `--subgraph`, and the wiring below is what selects the matching save
    // node, so a bypassed one is not skipped here — asking for variant 1 is
    // asking for the variant the template left switched off.
    const api: ApiNode = {
      class_type: node.type,
      inputs: { ...widgetsOf(node) },
    };
    let wired = false;
    for (const slot of node.inputs ?? []) {
      if (slot.link === null || slot.link === undefined) continue;
      const link = outerLinks.get(slot.link);
      if (!link) continue;
      if (!instances.has(link.origin_id)) continue;
      const producer = producers.get(link.origin_slot);
      if (!producer) continue;
      api.inputs[slot.name] = [String(producer.node), producer.slot];
      wired = true;
    }
    // An output node the chosen subgraph does not feed belongs to another
    // variant in the same template; it is not part of this workflow.
    if (!wired) continue;
    if (node.title) api._meta = { title: node.title };
    graph[String(++next)] = api;
  }
}

/** Renumber to `1..n` in the order the nodes appear, as a hand-authored graph is. */
export function renumber(graph: ApiGraph): ApiGraph {
  const ids = Object.keys(graph);
  const mapping = new Map(ids.map((id, i) => [id, String(i + 1)]));
  const out: ApiGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      if (
        Array.isArray(value) && value.length === 2 &&
        typeof value[0] === "string" && typeof value[1] === "number"
      ) {
        inputs[name] = [mapping.get(value[0]) ?? value[0], value[1]];
      } else {
        inputs[name] = value;
      }
    }
    out[mapping.get(id)!] = { ...node, inputs };
  }
  return out;
}

if (import.meta.main) {
  const args = [...Deno.args];
  let subgraph = 0;
  const flag = args.indexOf("--subgraph");
  if (flag >= 0) {
    subgraph = Number(args[flag + 1]);
    args.splice(flag, 2);
  }
  const [input, output] = args;
  if (!input) {
    console.error(
      "usage: import_template.ts <template.json> [out.json] [--subgraph n]",
    );
    Deno.exit(2);
  }
  const document = JSON.parse(await Deno.readTextFile(input)) as UiGraph;
  const graph = renumber(flatten(document, { subgraph }));
  const text = JSON.stringify(graph, null, 2) + "\n";
  if (output) await Deno.writeTextFile(output, text);
  else console.log(text);
}
