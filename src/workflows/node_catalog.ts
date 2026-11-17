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
/**
 * Tooltips and descriptions are never cut (§4.9): a clipped tooltip is the
 * sentence that would have said what the input does. They are left out of
 * a description unless asked for instead, so a node stays short to read and
 * the text comes whole when it is wanted.
 */
export interface DescribeOptions {
  /** Every input's and output's tooltip, in full. */
  tooltips?: boolean;
  /** Only these inputs (a dynamic combo brings its options' inputs). */
  inputs?: string[];
}
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

/** Text as ComfyUI wrote it, trimmed and whole, or nothing when blank. */
function clipped(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  return text.trim();
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
  /**
   * Where the node comes from: `core`, `api`, `custom` (any pack), or a
   * pack's folder name under `custom_nodes/`.
   */
  source?: string;
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
    if (filters.source !== undefined) {
      const from = nodeSource(node);
      const wanted = filters.source.toLowerCase();
      const pack = from.startsWith("custom: ")
        ? from.slice(8).toLowerCase()
        : null;
      const fits = from === wanted ||
        (wanted === "custom" && pack !== null) ||
        (pack !== null && (wanted === pack || wanted === `custom: ${pack}`));
      if (!fits) continue;
      // Asking for API nodes by source is asking for them.
      if (wanted === "api") {
        matches.push([name, node]);
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
  /** What the editor labels it, when that is not its name. */
  label?: string;
  /** A choice that takes a list of choices rather than one. */
  multiselect?: true;
  /**
   * The value is a file in ComfyUI's input folder, uploaded in the editor.
   * In a ForgeUI workflow, expose it as the param of that kind (§4.3), which
   * puts the file there at submit.
   */
  upload?: "image" | "video" | "audio" | "file";
  /** ComfyUI's own editor tucks it away: a fair guess for `advanced`. */
  advanced?: true;
  /** A seed the editor re-rolls after each run; API format does not. */
  randomized_in_editor?: true;
  /** Choices the editor fetches at run time, so none are listed here. */
  choices_from?: string;
}

function detailOf(input: ParsedInput, tooltips = false): InputDetail {
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
      inputs: option.inputs.map((child) => detailOf(child, tooltips)),
    }));
  }
  if (input.kind === "autogrow" && input.grow) {
    const names = input.grow.names;
    detail.names = names.length > 3
      ? `${names[0]}, ${names[1]}, … ${names.at(-1)}`
      : names.join(", ");
    detail.min_count = input.grow.min;
  }
  if (tooltips && typeof o.tooltip === "string" && o.tooltip.trim()) {
    detail.tooltip = o.tooltip.trim();
  }
  // What a raw read of /object_info would be looked at for (§4.9).
  if (typeof o.display_name === "string" && o.display_name !== input.name) {
    detail.label = o.display_name;
  }
  if (o.multiselect === true) detail.multiselect = true;
  const upload = o.image_upload === true
    ? "image"
    : o.video_upload === true
    ? "video"
    : o.audio_upload === true
    ? "audio"
    : o.file_upload === true
    ? "file"
    : undefined;
  if (upload) detail.upload = upload;
  if (o.advanced === true) detail.advanced = true;
  if (o.control_after_generate === true) detail.randomized_in_editor = true;
  if (isRecord(o.remote) && typeof o.remote.route === "string") {
    detail.choices_from = `ComfyUI's ${o.remote.route}, at run time`;
    delete detail.choices_note;
  }
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
   * Left out when only some inputs were asked for.
   */
  example?: { class_type: string; inputs: Record<string, unknown> };
  /** Input names asked for that the node does not have. */
  unknown_inputs?: string[];
  /** Says how to see the tooltips, when the node has some and they were not asked for. */
  tooltips?: string;
}

function hasTooltips(node: ObjectInfoNode): boolean {
  const any = (spec: unknown): boolean =>
    Array.isArray(spec) && isRecord(spec[1]) &&
    typeof spec[1].tooltip === "string" && spec[1].tooltip.length > 0;
  return [node.input?.required, node.input?.optional].some((section) =>
    Object.values(section ?? {}).some(any)
  ) || (node.output_tooltips ?? []).some((t) => typeof t === "string" && t);
}

export function describeNode(
  name: string,
  node: ObjectInfoNode,
  options: DescribeOptions = {},
): NodeDetail {
  const tooltips = options.tooltips === true;
  const all = parseInputs(node);
  const wanted = options.inputs;
  const inputs = wanted === undefined
    ? all
    : all.filter((input) => wanted.includes(input.name));
  const unknown = (wanted ?? []).filter((name) =>
    !all.some((input) => input.name === name)
  );
  const example: Record<string, unknown> = {};
  for (const input of all) exampleValues(input, example);
  const outputs = (node.output ?? []).map((raw, slot) => {
    const text = node.output_tooltips?.[slot];
    const tooltip = tooltips && typeof text === "string" && text.trim()
      ? text.trim()
      : undefined;
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
    ...(clipped(node.description)
      ? { description: clipped(node.description) }
      : {}),
    source: nodeSource(node),
    output_node: node.output_node === true,
    ...(node.experimental ? { experimental: true as const } : {}),
    ...(node.deprecated ? { deprecated: true as const } : {}),
    inputs: inputs.map((input) => detailOf(input, tooltips)),
    outputs,
    ...(wanted === undefined
      ? { example: { class_type: name, inputs: example } }
      : {}),
    ...(unknown.length > 0
      ? {
        unknown_inputs: unknown.map((name) => {
          const near = closest(name, all.map((input) => input.name));
          return near.length > 0 ? `${name} (did you mean ${near[0]}?)` : name;
        }),
      }
      : {}),
    ...(!tooltips && hasTooltips(node)
      ? { tooltips: "hidden: include_tooltips: true shows them in full" }
      : {}),
  };
}

/** Each named node described, or why it could not be, with near names. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A node's `/object_info` entry exactly as ComfyUI serves it. */
export interface RawNode {
  name: string;
  raw: ObjectInfoNode;
}

/**
 * Each named node described, or why it could not be, with near names. With
 * `raw`, each node's own `/object_info` entry as ComfyUI serves it — every
 * field and every choice, nothing clipped — so nothing is ever a reason to
 * read the whole list, which is megabytes.
 */
export function describeNodes(
  info: ObjectInfo,
  names: string[],
  options: DescribeOptions & { raw?: boolean } = {},
): (NodeDetail | RawNode | { name: string; error: string })[] {
  return names.map((name) => {
    const node = info[name];
    if (node && options.raw) return { name, raw: node };
    if (node) return describeNode(name, node, options);
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

/** A custom node pack as this ComfyUI has it loaded. */
export interface InstalledPack {
  /** The folder under `custom_nodes/`. */
  pack: string;
  node_count: number;
  /** A few of its node types, to search or describe. */
  nodes: string[];
}

/** A pack ForgeUI knows a workflow may need (nodes.ts `NODE_PACKS`). */
export interface KnownPack {
  id: string;
  name: string;
  url: string;
  installed: boolean;
  /** Its node types this ComfyUI does not have, when not installed. */
  missing_nodes?: string[];
}

/**
 * Custom node packs, read off where ComfyUI loaded each node from, and the
 * packs ForgeUI's own workflows can require, each with whether every node
 * it is known for is there. A pack is installed by whoever runs ComfyUI;
 * ForgeUI never downloads one (AGENTS.md).
 */
export function nodePacks(
  info: ObjectInfo,
  known: Record<
    string,
    { id: string; name: string; url: string; nodes: Record<string, unknown> }
  >,
): { installed: InstalledPack[]; known: KnownPack[] } {
  const byPack = new Map<string, string[]>();
  for (const [name, node] of Object.entries(info)) {
    const from = nodeSource(node);
    if (!from.startsWith("custom: ")) continue;
    const pack = from.slice(8);
    byPack.set(pack, [...(byPack.get(pack) ?? []), name]);
  }
  return {
    installed: [...byPack].sort((a, b) => a[0].localeCompare(b[0])).map((
      [pack, names],
    ) => ({
      pack,
      node_count: names.length,
      nodes: names.sort().slice(0, 8),
    })),
    known: Object.values(known).map((pack) => {
      const missing = Object.keys(pack.nodes).filter((type) => !(type in info));
      return {
        id: pack.id,
        name: pack.name,
        url: pack.url,
        installed: missing.length === 0,
        ...(missing.length > 0 ? { missing_nodes: missing } : {}),
      };
    }),
  };
}
