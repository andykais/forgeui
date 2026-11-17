/**
 * The node types a ComfyUI has, as an agent writing a workflow needs them
 * (§4.9): searched, then described one by one.
 *
 * `/object_info` is the source, and it is far too big to hand over whole —
 * 900 node types and 1.6 MB on a stock 0.34 install, a third of them paid
 * cloud API nodes. So a search returns one compact line of signature per
 * node, and only the nodes asked for are described in full, with every
 * input's type, range, default and choices, and an API-format example
 * ready to paste into a graph.
 */

import { closest } from "./graph_check.ts";
import {
  matchedInputs,
  nodeSource,
  type ObjectInfo,
  type ObjectInfoNode,
  type ParsedInput,
  parseInputs,
} from "./node_spec.ts";

const DESCRIPTION_LINE_MAX = 160;
const DESCRIPTION_MAX = 1500;
const TOOLTIP_MAX = 240;
/** A loader's choices are the files on disk, which can run to hundreds. */
const CHOICES_MAX = 100;

/** The start of a description, flattened: some open with "Recipes:". */
function oneLine(
  text: string | null | undefined,
  max: number,
): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A model merge node lists a weight per block; the line stays a line. */
const SIGNATURE_INPUTS_MAX = 14;

function clipped(text: unknown, max: number): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export interface SearchFilters {
  /** Words that must all appear in the name, display name, aliases, category or description. */
  query?: string;
  /** A category or the start of one, e.g. `model/loaders` or `sampling`. */
  category?: string;
  /** Only nodes with an input that takes this type, e.g. `LATENT`. */
  input_type?: string;
  /** Only nodes with an output of this type, e.g. `CONDITIONING`. */
  output_type?: string;
  /** Paid cloud API nodes, left out unless asked for. */
  include_api_nodes?: boolean;
  /** Deprecated nodes, left out unless asked for. */
  include_deprecated?: boolean;
  limit?: number;
  offset?: number;
}

export interface NodeSummary {
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  /** `name: TYPE`, comma separated; `?` marks an optional input. */
  inputs: string;
  /** Output types in slot order: `MODEL, CLIP, VAE`. */
  outputs: string;
  output_node?: true;
  source: string;
  experimental?: true;
  deprecated?: true;
}

function typesOf(type: string): string[] {
  return type.split(",").map((part) => part.trim().toUpperCase());
}

/** What an input is called in a signature: its type, or COMBO, or its grown form. */
function signatureType(input: ParsedInput): string {
  if (input.kind === "autogrow" && input.grow) {
    return `${input.grow.template.type}… (${input.grow.names.length} max)`;
  }
  return input.type;
}

/**
 * An output's type as a reader needs it: a match-type output's placeholder
 * becomes what it passes on, e.g. `* (as on_false)`.
 */
function outputTypeOf(node: ObjectInfoNode, slot: number): {
  type: string;
  follows?: string[];
} {
  const matched = matchedInputs(node, slot);
  if (matched.length === 0) return { type: String(node.output?.[slot]) };
  return {
    type: matched[0]!.type,
    follows: matched.map((input) => input.name),
  };
}

export function summarizeNode(name: string, node: ObjectInfoNode): NodeSummary {
  const all = parseInputs(node).map((input) =>
    `${input.name}${input.required ? "" : "?"}: ${signatureType(input)}`
  );
  const inputs = all.length > SIGNATURE_INPUTS_MAX
    ? `${all.slice(0, SIGNATURE_INPUTS_MAX).join(", ")}, … ${
      all.length - SIGNATURE_INPUTS_MAX
    } more`
    : all.join(", ");
  return {
    name,
    ...(node.display_name && node.display_name !== name
      ? { display_name: node.display_name }
      : {}),
    ...(node.category ? { category: node.category } : {}),
    ...(oneLine(node.description, DESCRIPTION_LINE_MAX)
      ? { description: oneLine(node.description, DESCRIPTION_LINE_MAX) }
      : {}),
    inputs,
    outputs: (node.output ?? []).map((_, slot) => {
      const { type, follows } = outputTypeOf(node, slot);
      return follows ? `${type} (as ${follows.join("/")})` : type;
    }).join(", "),
    ...(node.output_node ? { output_node: true as const } : {}),
    source: nodeSource(node),
    ...(node.experimental ? { experimental: true as const } : {}),
    ...(node.deprecated ? { deprecated: true as const } : {}),
  };
}

function searchable(name: string, node: ObjectInfoNode): string {
  return [
    name,
    node.display_name ?? "",
    ...(node.search_aliases ?? []),
    node.category ?? "",
    node.description ?? "",
  ].join("\n").toLowerCase();
}

/** Lower is better: where in the node the query was found. */
function rank(name: string, node: ObjectInfoNode, words: string[]): number {
  const lower = name.toLowerCase();
  const display = (node.display_name ?? "").toLowerCase();
  const joined = words.join(" ");
  if (lower === joined.replace(/\s+/g, "") || display === joined) return 0;
  if (words.every((w) => lower.includes(w) || display.includes(w))) return 1;
  if (
    words.every((w) =>
      (node.search_aliases ?? []).some((a) => a.toLowerCase().includes(w))
    )
  ) return 2;
  if (words.every((w) => (node.category ?? "").toLowerCase().includes(w))) {
    return 3;
  }
  return 4;
}

export interface SearchResult {
  total: number;
  offset: number;
  nodes: NodeSummary[];
  /** Categories among the matches, with counts — where to look next. */
  categories: { category: string; count: number }[];
  /** Hidden by default and matching: how many, so the caller can ask. */
  left_out?: { api_nodes?: number; deprecated?: number };
}

export function searchNodes(
  info: ObjectInfo,
  filters: SearchFilters,
): SearchResult {
  const words = (filters.query ?? "").toLowerCase().split(/\s+/).filter(
    Boolean,
  );
  const category = filters.category?.toLowerCase().replace(/\/+$/, "");
  const inputType = filters.input_type?.toUpperCase();
  const outputType = filters.output_type?.toUpperCase();
  let api = 0;
  let deprecated = 0;

  const matches: [string, ObjectInfoNode][] = [];
  for (const [name, node] of Object.entries(info)) {
    if (node.dev_only) continue;
    if (words.length > 0) {
      const text = searchable(name, node);
      if (!words.every((w) => text.includes(w))) continue;
    }
    if (category !== undefined) {
      const own = (node.category ?? "").toLowerCase();
      if (own !== category && !own.startsWith(`${category}/`)) continue;
    }
    if (inputType !== undefined) {
      const takes = parseInputs(node).some((input) => {
        const type = input.kind === "autogrow" && input.grow
          ? input.grow.template.type
          : input.type;
        return typesOf(type).includes(inputType) || type === "*";
      });
      if (!takes) continue;
    }
    if (outputType !== undefined) {
      if (
        !(node.output ?? []).some((t) =>
          typesOf(String(t)).includes(outputType)
        )
      ) {
        continue;
      }
    }
    if (node.api_node && !filters.include_api_nodes) {
      api++;
      continue;
    }
    if (node.deprecated && !filters.include_deprecated) {
      deprecated++;
      continue;
    }
    matches.push([name, node]);
  }

  matches.sort(([a, an], [b, bn]) =>
    (words.length > 0 ? rank(a, an, words) - rank(b, bn, words) : 0) ||
    a.localeCompare(b)
  );
  const counts = new Map<string, number>();
  for (const [, node] of matches) {
    const key = node.category || "(none)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const offset = Math.max(0, filters.offset ?? 0);
  const limit = Math.max(1, filters.limit ?? 30);
  return {
    total: matches.length,
    offset,
    nodes: matches.slice(offset, offset + limit).map(([name, node]) =>
      summarizeNode(name, node)
    ),
    categories: [...counts].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    )
      .slice(0, 40)
      .map(([category, count]) => ({ category, count })),
    ...(api > 0 || deprecated > 0
      ? {
        left_out: {
          ...(api > 0 ? { api_nodes: api } : {}),
          ...(deprecated > 0 ? { deprecated } : {}),
        },
      }
      : {}),
  };
}

export interface InputDetail {
  name: string;
  required: boolean;
  /**
   * `link`: from another node's output, as `["<id>", <slot>]`.
   * `value`: a literal (a link of the same type also works).
   * `choice`: one of `choices`.
   * `choice_with_inputs`: one of `options[].key`; that option's inputs follow
   * as `<this name>.<input>`.
   * `repeatable`: sent as the numbered `names`, the first `min` required.
   */
  takes: "link" | "value" | "choice" | "choice_with_inputs" | "repeatable";
  type: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  multiline?: true;
  choices?: unknown[];
  /** When there were more choices than shown. */
  choices_total?: number;
  /** Why `choices` is empty, when it is. */
  choices_note?: string;
  options?: { key: string; inputs: InputDetail[] }[];
  names?: string;
  min_count?: number;
  tooltip?: string;
}

function detailOf(input: ParsedInput): InputDetail {
  const o = input.options;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const takes: InputDetail["takes"] = input.kind === "combo"
    ? "choice"
    : input.kind === "dynamic_combo"
    ? "choice_with_inputs"
    : input.kind === "autogrow"
    ? "repeatable"
    : input.kind;
  const detail: InputDetail = {
    name: input.name,
    required: input.required,
    takes,
    type: input.kind === "autogrow" && input.grow
      ? input.grow.template.type
      : input.type,
  };
  if (o.default !== undefined) detail.default = o.default;
  const min = num(o.min), max = num(o.max), step = num(o.step);
  // ComfyUI's seed max is 2^64-1, which JSON rounds; it says nothing useful.
  if (min !== undefined) detail.min = min;
  if (max !== undefined && max < Number.MAX_SAFE_INTEGER) detail.max = max;
  if (step !== undefined) detail.step = step;
  if (o.multiline === true) detail.multiline = true;
  if (input.kind === "combo" && input.choices) {
    detail.choices = input.choices.slice(0, CHOICES_MAX);
    if (input.choices.length > CHOICES_MAX) {
      detail.choices_total = input.choices.length;
    }
    if (input.choices.length === 0) {
      // A loader whose folder is empty: any value is refused at run time.
      detail.choices_note = "none: this ComfyUI has no file of this kind, " +
        "so any value is refused until one is added";
    }
  }
  if (input.kind === "dynamic_combo" && input.dynamic) {
    detail.options = input.dynamic.map((option) => ({
      key: option.key,
      inputs: option.inputs.map(detailOf),
    }));
  }
  if (input.kind === "autogrow" && input.grow) {
    const names = input.grow.names;
    detail.names = names.length > 3
      ? `${names[0]}, ${names[1]}, … ${names.at(-1)}`
      : names.join(", ");
    detail.min_count = input.grow.min;
  }
  const tooltip = clipped(o.tooltip, TOOLTIP_MAX);
  if (tooltip) detail.tooltip = tooltip;
  return detail;
}

/** What to put in an example graph for one input, or nothing. */
function exampleValues(input: ParsedInput, out: Record<string, unknown>): void {
  const o = input.options;
  if (input.kind === "autogrow" && input.grow) {
    input.grow.names.slice(0, Math.max(1, input.grow.min)).forEach((name) =>
      exampleValues({ ...input.grow!.template, name, required: true }, out)
    );
    return;
  }
  if (input.kind === "link") {
    if (input.required) out[input.name] = `<link: ${input.type}>`;
    return;
  }
  if (input.kind === "dynamic_combo" && input.dynamic?.length) {
    const key = typeof o.default === "string" &&
        input.dynamic.some((d) => d.key === o.default)
      ? o.default
      : input.dynamic[0]!.key;
    out[input.name] = key;
    for (const child of input.dynamic.find((d) => d.key === key)!.inputs) {
      exampleValues(child, out);
    }
    return;
  }
  if (o.default !== undefined) {
    out[input.name] = o.default;
  } else if (input.kind === "combo" && input.choices?.length) {
    out[input.name] = input.choices[0];
  } else if (input.required) {
    out[input.name] = input.kind === "combo"
      ? "<a file name>"
      : input.type === "STRING"
      ? ""
      : input.type === "BOOLEAN"
      ? false
      : 0;
  }
}

export interface NodeDetail {
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  source: string;
  output_node: boolean;
  experimental?: true;
  deprecated?: true;
  inputs: InputDetail[];
  outputs: {
    slot: number;
    name: string;
    type: string;
    /** Carries the type of whatever is linked into these inputs. */
    same_type_as?: string[];
    is_list?: true;
    tooltip?: string;
  }[];
  /**
   * The node in API format with every required input filled: literals at
   * their defaults, links as `"<link: TYPE>"` placeholders to replace with
   * `["<node id>", <slot>]`. Optional inputs with a default are included.
   */
  example: { class_type: string; inputs: Record<string, unknown> };
}

export function describeNode(name: string, node: ObjectInfoNode): NodeDetail {
  const inputs = parseInputs(node);
  const example: Record<string, unknown> = {};
  for (const input of inputs) exampleValues(input, example);
  const outputs = (node.output ?? []).map((raw, slot) => {
    const tooltip = clipped(node.output_tooltips?.[slot], TOOLTIP_MAX);
    const { type, follows } = outputTypeOf(node, slot);
    return {
      slot,
      name: String(node.output_name?.[slot] ?? raw),
      type,
      ...(follows ? { same_type_as: follows } : {}),
      ...(node.output_is_list?.[slot] === true
        ? { is_list: true as const }
        : {}),
      ...(tooltip ? { tooltip } : {}),
    };
  });
  return {
    name,
    ...(node.display_name && node.display_name !== name
      ? { display_name: node.display_name }
      : {}),
    ...(node.category ? { category: node.category } : {}),
    ...(clipped(node.description, DESCRIPTION_MAX)
      ? { description: clipped(node.description, DESCRIPTION_MAX) }
      : {}),
    source: nodeSource(node),
    output_node: node.output_node === true,
    ...(node.experimental ? { experimental: true as const } : {}),
    ...(node.deprecated ? { deprecated: true as const } : {}),
    inputs: inputs.map(detailOf),
    outputs,
    example: { class_type: name, inputs: example },
  };
}

/** Each named node described, or why it could not be, with near names. */
export function describeNodes(
  info: ObjectInfo,
  names: string[],
): (NodeDetail | { name: string; error: string })[] {
  return names.map((name) => {
    const node = info[name];
    if (node) return describeNode(name, node);
    const near = closest(name, Object.keys(info));
    return {
      name,
      error: `this ComfyUI has no node type "${name}"` +
        (near.length > 0
          ? ` — did you mean ${near.map((n) => `"${n}"`).join(" or ")}?`
          : " (search_comfy_nodes finds them by what they do)"),
    };
  });
}
