/**
 * Checks for a graph somebody wrote by hand — usually an agent (§4.9).
 *
 * Two levels, because only one of them needs ComfyUI:
 *
 * - {@link checkGraphShape}: what every prompt needs whatever nodes are
 *   installed. The server runs it on every graph it is asked to write.
 * - {@link checkGraphAgainstNodes}: the graph against ComfyUI's own node
 *   list (`/object_info`) — node types that exist, required inputs present,
 *   links into slots that exist and carry the right type. The bridge runs it
 *   before it saves, so a hallucinated node name is refused while the model
 *   is still resident, not minutes later when a round reaches ComfyUI.
 *
 * Both return every problem at once, each naming the node, so a caller can
 * fix them in one pass.
 */

import type { ApiGraph } from "./types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(id: string, classType: unknown): string {
  return typeof classType === "string" && classType.length > 0
    ? `node "${id}" (${classType})`
    : `node "${id}"`;
}

/**
 * The shape ComfyUI's api format needs: each node an object with a
 * `class_type` and an `inputs` object; each array input a `[node_id, slot]`
 * link — ComfyUI reads every array input as one — to a node that exists.
 * An empty graph passes: it is a draft (§4.2).
 */
export function checkGraphShape(graph: ApiGraph): string[] {
  const problems: string[] = [];
  const raw = graph as Record<string, unknown>;
  for (const [id, node] of Object.entries(raw)) {
    if (!isPlainObject(node)) {
      problems.push(`node "${id}": expected {class_type, inputs}`);
      continue;
    }
    const at = label(id, node.class_type);
    if (typeof node.class_type !== "string" || node.class_type.length === 0) {
      problems.push(`${at}: class_type is missing`);
    }
    if (!isPlainObject(node.inputs)) {
      problems.push(`${at}: inputs is missing (use {} for a node with none)`);
      continue;
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue;
      const [from, slot] = value;
      if (
        value.length !== 2 || typeof slot !== "number" ||
        !Number.isInteger(slot) || slot < 0 ||
        (typeof from !== "string" && typeof from !== "number")
      ) {
        problems.push(
          `${at}.${name}: an array is read as a link and must be ` +
            `["<node id>", <output slot>], e.g. ["4", 0]`,
        );
        continue;
      }
      if (typeof from === "number") {
        problems.push(
          `${at}.${name}: the node id in a link is a string — ` +
            `["${from}", ${slot}], not [${from}, ${slot}]`,
        );
        continue;
      }
      if (!(from in raw)) {
        problems.push(
          `${at}.${name}: links to node "${from}", which is not in the graph`,
        );
      }
    }
  }
  return problems;
}

/** One node type as ComfyUI's `/object_info` describes it. */
export interface ObjectInfoNode {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
    hidden?: Record<string, unknown>;
  };
  output?: unknown[];
  output_name?: unknown[];
  output_node?: boolean;
}

export type ObjectInfo = Record<string, ObjectInfoNode>;

export interface GraphCheck {
  /** Would make ComfyUI refuse the prompt. */
  errors: string[];
  /** Worth knowing, but ComfyUI would queue it. */
  warnings: string[];
}

/**
 * An input's spec, `[type, options?]`, read into the type and, for a combo,
 * its choices. ComfyUI writes a combo as `[[...choices], opts]` and newer
 * builds also as `["COMBO", {options: [...]}]`.
 */
function inputSpec(
  spec: unknown,
): { type: string | null; choices: unknown[] | null } {
  if (!Array.isArray(spec) || spec.length === 0) {
    return { type: null, choices: null };
  }
  const [head, options] = spec;
  if (Array.isArray(head)) return { type: "COMBO", choices: head };
  if (typeof head !== "string") return { type: null, choices: null };
  if (
    head === "COMBO" && isPlainObject(options) && Array.isArray(options.options)
  ) {
    return { type: "COMBO", choices: options.options };
  }
  return { type: head, choices: null };
}

/** `"IMAGE,MASK"` or `"*"`: the types an input or output may carry. */
function typesOf(type: string): Set<string> {
  return new Set(type.split(",").map((part) => part.trim()));
}

function compatible(given: string, wanted: string): boolean {
  if (given === "*" || wanted === "*") return true;
  const a = typesOf(given);
  for (const type of typesOf(wanted)) if (a.has(type)) return true;
  return false;
}

/** Edit distance, for "did you mean". Small inputs only. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = here;
    }
  }
  return row[b.length]!;
}

/** Up to three names close to `wanted`, closest first. */
export function closest(wanted: string, names: Iterable<string>): string[] {
  const lower = wanted.toLowerCase();
  const scored: [string, number][] = [];
  for (const name of names) {
    const other = name.toLowerCase();
    const score = other === lower
      ? 0
      : other.includes(lower) || lower.includes(other)
      ? 1
      : distance(lower, other);
    if (score <= Math.max(2, Math.floor(wanted.length / 4))) {
      scored.push([name, score]);
    }
  }
  return scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, 3).map(([name]) => name);
}

function didYouMean(options: string[]): string {
  return options.length === 0
    ? ""
    : ` — did you mean ${options.map((name) => `"${name}"`).join(" or ")}?`;
}

const SHOW_CHOICES = 12;

function listChoices(choices: unknown[]): string {
  const shown = choices.slice(0, SHOW_CHOICES).map((choice) =>
    JSON.stringify(choice)
  );
  const more = choices.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, … ${more} more` : "");
}

/**
 * The graph against the node types a ComfyUI actually has. Assumes
 * {@link checkGraphShape} passed.
 *
 * A combo value that is not among the choices is a warning, not an error:
 * for a loader the choices are the files on this machine today, and a
 * workflow made for a model that is not downloaded yet is still a workflow.
 * An input the node does not declare is a warning too, since ComfyUI
 * ignores it — but it is usually a misspelt one, which is worth saying.
 */
export function checkGraphAgainstNodes(
  graph: ApiGraph,
  info: ObjectInfo,
): GraphCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let outputs = 0;

  for (const [id, node] of Object.entries(graph)) {
    const at = label(id, node.class_type);
    const schema = info[node.class_type];
    if (!schema) {
      errors.push(
        `${at}: this ComfyUI has no node type "${node.class_type}"` +
          didYouMean(closest(node.class_type, Object.keys(info))),
      );
      continue;
    }
    if (schema.output_node) outputs++;
    const required = schema.input?.required ?? {};
    const optional = schema.input?.optional ?? {};
    const hidden = schema.input?.hidden ?? {};
    const inputs = node.inputs ?? {};

    for (const name of Object.keys(required)) {
      if (!(name in inputs)) {
        errors.push(`${at}: required input "${name}" is missing`);
      }
    }
    for (const [name, value] of Object.entries(inputs)) {
      const spec = required[name] ?? optional[name];
      if (spec === undefined) {
        // `<parent>.<child>`: a dynamic combo's own widgets (nodes.ts).
        if (name in hidden || name.includes(".")) continue;
        warnings.push(
          `${at}: "${name}" is not an input of ${node.class_type}, so ` +
            `ComfyUI ignores it` +
            didYouMean(
              closest(name, [
                ...Object.keys(required),
                ...Object.keys(optional),
              ]),
            ),
        );
        continue;
      }
      const { type, choices } = inputSpec(spec);
      if (Array.isArray(value)) {
        const [from, slot] = value as [string, number];
        const source = graph[from];
        const sourceSchema = source ? info[source.class_type] : undefined;
        if (!sourceSchema) continue; // reported on that node
        const produced = sourceSchema.output ?? [];
        if (slot >= produced.length) {
          const names = (sourceSchema.output_name ?? produced).map(String);
          errors.push(
            `${at}.${name}: links to output ${slot} of ${
              label(from, source!.class_type)
            }, which has ${produced.length} (${
              names.map((n, i) => `${i}: ${n}`).join(", ") || "none"
            })`,
          );
          continue;
        }
        const given = produced[slot];
        if (
          typeof given === "string" && type !== null && type !== "COMBO" &&
          !compatible(given, type)
        ) {
          errors.push(
            `${at}.${name}: expects ${type}, but output ${slot} of ${
              label(from, source!.class_type)
            } is ${given}`,
          );
        }
        continue;
      }
      if (
        choices !== null && choices.length > 0 && !choices.includes(value)
      ) {
        warnings.push(
          `${at}.${name}: ${JSON.stringify(value)} is not one of this ` +
            `ComfyUI's choices (${listChoices(choices)})`,
        );
      }
    }
  }

  if (Object.keys(graph).length > 0 && outputs === 0) {
    errors.push(
      "the graph has no output node (SaveImage, SaveVideo, …), so ComfyUI " +
        "would have nothing to run",
    );
  }
  return { errors, warnings };
}
