import { CORE_NODES } from "./nodes.ts";
import { type ApiGraph, isLink } from "./types.ts";

/**
 * Rebuild a LiteGraph document from an api graph, so the embedded editor has
 * something to open for a workflow that only ships `workflow.api.json` (the
 * bundled ones do — §4.6 expects the user to open each, fix the placeholder
 * model names and re-save, which writes a real `workflow.ui.json`).
 *
 * Widget order comes from {@link CORE_NODES}; for a node the app has no
 * schema for, the literal inputs are emitted in the order the graph lists
 * them, which is what ComfyUI's own api export produces.
 */

export interface LiteGraphSlot {
  name: string;
  type: string;
  link?: number | null;
  links?: number[] | null;
  slot_index?: number;
}

export interface LiteGraphNode {
  id: number;
  type: string;
  pos: [number, number];
  size: [number, number];
  flags: Record<string, unknown>;
  order: number;
  mode: number;
  inputs?: LiteGraphSlot[];
  outputs?: LiteGraphSlot[];
  title?: string;
  properties: Record<string, unknown>;
  widgets_values?: unknown[];
}

export interface LiteGraphDocument {
  id?: string;
  last_node_id: number;
  last_link_id: number;
  nodes: LiteGraphNode[];
  links: [number, number, number, number, number, string][];
  groups: unknown[];
  config: Record<string, unknown>;
  extra: Record<string, unknown>;
  version: number;
}

const COLUMN_WIDTH = 340;
const ROW_HEIGHT = 200;

function widgetOrder(
  classType: string,
  inputs: Record<string, unknown>,
): string[] {
  const declared = CORE_NODES[classType]?.widgets;
  const literals = Object.keys(inputs).filter((name) => !isLink(inputs[name]));
  if (!declared) return literals;
  const ordered = declared.filter((name) => literals.includes(name));
  // Anything the schema does not know about keeps its position at the end.
  return [...ordered, ...literals.filter((name) => !declared.includes(name))];
}

function linkOrder(
  classType: string,
  inputs: Record<string, unknown>,
): string[] {
  const declared = CORE_NODES[classType]?.inputs;
  const links = Object.keys(inputs).filter((name) => isLink(inputs[name]));
  if (!declared) return links;
  return [
    ...declared.filter((name) => links.includes(name)),
    ...links.filter((name) => !declared.includes(name)),
  ];
}

/** Depth from the roots, so nodes lay out left to right like a real graph. */
function columns(graph: ApiGraph): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // A cycle cannot happen in a prompt graph.
    visiting.add(id);
    const node = graph[id];
    let column = 0;
    for (const value of Object.values(node?.inputs ?? {})) {
      if (isLink(value) && graph[value[0]]) {
        column = Math.max(column, walk(value[0]) + 1);
      }
    }
    visiting.delete(id);
    depth.set(id, column);
    return column;
  };

  for (const id of Object.keys(graph)) walk(id);
  return depth;
}

export function apiGraphToLiteGraph(graph: ApiGraph): LiteGraphDocument {
  const depth = columns(graph);
  const perColumn = new Map<number, number>();
  const nodes: LiteGraphNode[] = [];
  const links: LiteGraphDocument["links"] = [];
  const numericId = (id: string, index: number) =>
    /^\d+$/.test(id) ? Number(id) : index + 1;

  const ids = Object.keys(graph);
  const order = [...ids].sort((a, b) =>
    (depth.get(a) ?? 0) - (depth.get(b) ?? 0)
  );

  let lastLinkId = 0;
  const outputsUsed = new Map<string, Map<number, number[]>>();

  // Links first, so each node can report the ids on its slots.
  const inputLink = new Map<string, Map<string, number>>();
  for (const targetId of ids) {
    const target = graph[targetId]!;
    for (const [inputName, value] of Object.entries(target.inputs)) {
      if (!isLink(value)) continue;
      const [sourceId, slot] = value;
      if (!graph[sourceId]) continue;
      const linkId = ++lastLinkId;
      links.push([
        linkId,
        numericId(sourceId, ids.indexOf(sourceId)),
        slot,
        numericId(targetId, ids.indexOf(targetId)),
        // Must match the order the node's input slots are emitted in.
        linkOrder(target.class_type, target.inputs).indexOf(inputName),
        CORE_NODES[graph[sourceId]!.class_type]?.outputs?.[slot] ?? "*",
      ]);
      if (!inputLink.has(targetId)) inputLink.set(targetId, new Map());
      inputLink.get(targetId)!.set(inputName, linkId);
      if (!outputsUsed.has(sourceId)) outputsUsed.set(sourceId, new Map());
      const bySlot = outputsUsed.get(sourceId)!;
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), linkId]);
    }
  }

  for (const [index, id] of order.entries()) {
    const apiNode = graph[id]!;
    const schema = CORE_NODES[apiNode.class_type];
    const column = depth.get(id) ?? 0;
    const row = perColumn.get(column) ?? 0;
    perColumn.set(column, row + 1);

    const widgets = widgetOrder(apiNode.class_type, apiNode.inputs);
    const widgetValues: unknown[] = [];
    for (const name of widgets) {
      widgetValues.push(apiNode.inputs[name]);
      const extra = schema?.after?.[name];
      if (extra !== undefined) widgetValues.push(extra);
    }

    const inputs: LiteGraphSlot[] = linkOrder(
      apiNode.class_type,
      apiNode.inputs,
    )
      .map((name) => ({
        name,
        type: "*",
        link: inputLink.get(id)?.get(name) ?? null,
      }));

    const outputs: LiteGraphSlot[] = (schema?.outputs ?? []).map(
      (name, slot) => ({
        name,
        type: name,
        links: outputsUsed.get(id)?.get(slot) ?? null,
        slot_index: slot,
      }),
    );

    nodes.push({
      id: numericId(id, ids.indexOf(id)),
      type: apiNode.class_type,
      pos: [column * COLUMN_WIDTH, row * ROW_HEIGHT],
      size: [300, 100],
      flags: {},
      order: index,
      mode: 0,
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(apiNode._meta?.title ? { title: apiNode._meta.title } : {}),
      properties: { "Node name for S&R": apiNode.class_type },
      ...(widgetValues.length > 0 ? { widgets_values: widgetValues } : {}),
    });
  }

  return {
    last_node_id: nodes.reduce((max, node) => Math.max(max, node.id), 0),
    last_link_id: lastLinkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}

/** An empty document, for `POST /api/workflows` with no body (§12). */
export function emptyLiteGraph(): LiteGraphDocument {
  return {
    last_node_id: 0,
    last_link_id: 0,
    nodes: [],
    links: [],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}
