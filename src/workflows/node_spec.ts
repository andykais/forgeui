/**
 * ComfyUI's node list (`/object_info`), read into one shape (§4.9).
 *
 * Shared by the graph check (`graph_check.ts`) and the node catalog the
 * bridge serves (`node_catalog.ts`), so what an agent is told a node takes
 * and what its graph is checked against cannot drift apart.
 *
 * An input spec is `[type, options?]`. Beyond the plain cases — a link type
 * such as `MODEL`, a widget such as `INT`, a combo written as a list of
 * choices or as `["COMBO", {options}]` — ComfyUI's v3 schema adds three
 * that change which input *names* a node takes in API format
 * (`comfy_api/latest/_io.py`):
 *
 * - `COMFY_DYNAMICCOMBO_V3`: the parent holds the chosen option's `key`, and
 *   that option's own inputs follow as `<parent>.<child>`.
 * - `COMFY_AUTOGROW_V3`: a repeatable input, sent as `<parent>.<prefix>0`,
 *   `<parent>.<prefix>1`, … (or `<parent>.<name>` for a fixed list of
 *   names); the first `min` are required. The parent itself is never sent.
 * - `COMFY_MATCHTYPE_V3`: takes a link of any of `allowed_types`.
 */

export interface ObjectInfoNode {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
    hidden?: Record<string, unknown>;
  };
  input_order?: Record<string, string[]>;
  output?: unknown[];
  output_name?: unknown[];
  output_is_list?: unknown[];
  output_tooltips?: unknown[];
  /** For a `COMFY_MATCHTYPE_V3` output: the template id it shares with inputs. */
  output_matchtypes?: unknown[];
  output_node?: boolean;
  display_name?: string | null;
  description?: string | null;
  category?: string;
  python_module?: string;
  search_aliases?: string[] | null;
  deprecated?: boolean;
  experimental?: boolean;
  dev_only?: boolean;
  api_node?: boolean;
}

export type ObjectInfo = Record<string, ObjectInfoNode>;

/**
 * - `link`: fed by another node's output.
 * - `value`: a literal in the graph (it may also be fed by a link of `type`).
 * - `combo`: a literal that must be one of `choices`.
 * - `dynamic_combo`: a combo whose choice brings inputs of its own.
 * - `autogrow`: a repeatable input; see `grow`.
 */
export type InputKind =
  | "link"
  | "value"
  | "combo"
  | "dynamic_combo"
  | "autogrow";

export interface ParsedInput {
  /** As it is named in API format, with any `<parent>.` prefix. */
  name: string;
  required: boolean;
  kind: InputKind;
  /** What a link into it must carry: `MODEL`, `INT`, `IMAGE,MASK`, `*`. */
  type: string;
  choices: unknown[] | null;
  /** The spec's own options object: default, min, max, tooltip, … */
  options: Record<string, unknown>;
  /** A dynamic combo's options, each with the inputs it brings. */
  dynamic?: { key: string; inputs: ParsedInput[] }[];
  /** An autogrow input: every name it may be sent as, and how many must be. */
  grow?: { names: string[]; min: number; template: ParsedInput };
  /** A match-type input's template id: outputs naming it carry its type. */
  match?: string;
}

/** The placeholder a match-type output reports instead of a type. */
export const MATCH_TYPE = "COMFY_MATCHTYPE_V3";

const VALUE_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One input spec, read. `prefix` is the parent's name for nested inputs. */
export function parseInput(
  name: string,
  spec: unknown,
  required: boolean,
  prefix = "",
): ParsedInput {
  const full = prefix ? `${prefix}.${name}` : name;
  const base = { name: full, required, choices: null, options: {} };
  if (!Array.isArray(spec) || spec.length === 0) {
    return { ...base, kind: "link", type: "*" };
  }
  const [head, rawOptions] = spec;
  const options = isRecord(rawOptions) ? rawOptions : {};
  if (Array.isArray(head)) {
    return { ...base, options, kind: "combo", type: "COMBO", choices: head };
  }
  if (typeof head !== "string") {
    return { ...base, options, kind: "link", type: "*" };
  }

  if (head === "COMBO") {
    return {
      ...base,
      options,
      kind: "combo",
      type: "COMBO",
      // A combo filled from a route (an output picker) lists no choices.
      choices: Array.isArray(options.options) ? options.options : null,
    };
  }
  if (head === "COMFY_DYNAMICCOMBO_V3") {
    const dynamic = (Array.isArray(options.options) ? options.options : [])
      .filter(isRecord)
      .map((option) => ({
        key: String(option.key),
        inputs: parseSection(
          isRecord(option.inputs) ? option.inputs : {},
          full,
        ),
      }));
    return {
      ...base,
      options,
      kind: "dynamic_combo",
      type: "COMBO",
      choices: dynamic.map((option) => option.key),
      dynamic,
    };
  }
  if (head === "COMFY_AUTOGROW_V3") {
    const template = isRecord(options.template) ? options.template : {};
    const templateInputs = isRecord(template.input) ? template.input : {};
    const [section, entries] = Object.entries(templateInputs).find(([, v]) =>
      isRecord(v) && Object.keys(v).length > 0
    ) ?? ["required", {}];
    const [childName, childSpec] = Object.entries(
      entries as Record<string, unknown>,
    )[0] ?? ["input", ["*"]];
    const names = Array.isArray(template.names)
      ? template.names.map(String)
      : Array.from(
        { length: typeof template.max === "number" ? template.max : 1 },
        (_, i) =>
          `${
            typeof template.prefix === "string" ? template.prefix : childName
          }${i}`,
      );
    const min = typeof template.min === "number" ? template.min : 0;
    const child = parseInput(childName, childSpec, section === "required");
    return {
      ...base,
      // The parent is never sent; whether any child must be is in `grow`.
      required: false,
      options,
      kind: "autogrow",
      type: child.type,
      grow: {
        names: names.map((n) =>
          `${full}.${n}`
        ),
        min: child.required ? min : 0,
        template: child,
      },
    };
  }
  if (head === MATCH_TYPE) {
    const template = isRecord(options.template) ? options.template : {};
    return {
      ...base,
      options,
      kind: "link",
      type: typeof template.allowed_types === "string"
        ? template.allowed_types
        : "*",
      ...(typeof template.template_id === "string"
        ? { match: template.template_id }
        : {}),
    };
  }
  // A custom type with a default (`COLOR`, `BOUNDING_BOXES`, `CURVE`) is
  // one the editor draws a widget for; a link type never has one.
  const isValue = options.forceInput !== true && (
    VALUE_TYPES.has(head) || options.socketless === true ||
    typeof options.widgetType === "string" || options.default !== undefined
  );
  return { ...base, options, kind: isValue ? "value" : "link", type: head };
}

function parseSection(
  section: Record<string, unknown>,
  prefix = "",
): ParsedInput[] {
  const out: ParsedInput[] = [];
  for (
    const [kind, required] of [["required", true], ["optional", false]] as const
  ) {
    const entries = section[kind];
    if (!isRecord(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) {
      out.push(parseInput(name, spec, required, prefix));
    }
  }
  return out;
}

/** Every input a node declares, required first, hidden ones left out. */
export function parseInputs(node: ObjectInfoNode): ParsedInput[] {
  return parseSection(node.input ?? {});
}

/**
 * The inputs a node takes given the values it holds: a dynamic combo's
 * chosen option's inputs are added, an autogrow input is replaced by the
 * names it is sent as.
 */
export function expectedInputs(
  node: ObjectInfoNode,
  values: Record<string, unknown>,
): Map<string, ParsedInput> {
  const expected = new Map<string, ParsedInput>();
  const add = (inputs: ParsedInput[]) => {
    for (const input of inputs) {
      if (input.kind === "autogrow" && input.grow) {
        input.grow.names.forEach((name, i) =>
          expected.set(name, {
            ...input.grow!.template,
            name,
            required: i < input.grow!.min,
          })
        );
        continue;
      }
      expected.set(input.name, input);
      if (input.kind === "dynamic_combo") {
        const chosen = input.dynamic?.find((o) => o.key === values[input.name]);
        if (chosen) add(chosen.inputs);
      }
    }
  };
  add(parseInputs(node));
  return expected;
}

/** Where a node comes from, by the module ComfyUI loaded it from. */
export function nodeSource(node: ObjectInfoNode): string {
  const module = node.python_module ?? "";
  if (module.startsWith("custom_nodes.")) {
    return `custom: ${module.slice("custom_nodes.".length).split(".")[0]}`;
  }
  if (module.startsWith("comfy_api_nodes")) return "api";
  return "core";
}

/**
 * The inputs a match-type output follows: those sharing its template id.
 * Empty for an ordinary output.
 */
export function matchedInputs(
  node: ObjectInfoNode,
  slot: number,
): ParsedInput[] {
  if (node.output?.[slot] !== MATCH_TYPE) return [];
  const id = node.output_matchtypes?.[slot];
  return parseInputs(node).filter((input) => input.match === id);
}
