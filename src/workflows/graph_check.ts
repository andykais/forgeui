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
import {
  expectedInputs,
  MATCH_TYPE,
  matchedInputs,
  type ObjectInfo,
} from "./node_spec.ts";

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

export type { ObjectInfo, ObjectInfoNode } from "./node_spec.ts";

export interface GraphCheck {
  /** Would make ComfyUI refuse the prompt. */
  errors: string[];
  /**
   * Saved anyway, because they may be fixed by something other than the
   * graph — a model downloaded later. Each says whether ComfyUI would
   * refuse to run the graph meanwhile.
   */
  warnings: string[];
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

/**
 * What output `slot` of node `id` carries. A match-type output reports a
 * placeholder and takes its type from the inputs sharing its template — a
 * switch passes on whatever is wired into it — so follow those links up the
 * graph; with none wired, it is whatever the template allows.
 */
function outputType(
  graph: ApiGraph,
  info: ObjectInfo,
  id: string,
  slot: number,
  depth = 0,
): string | null {
  const node = graph[id];
  const schema = node ? info[node.class_type] : undefined;
  const type = schema?.output?.[slot];
  if (typeof type !== "string") return null;
  if (type !== MATCH_TYPE) return type;
  const matched = matchedInputs(schema!, slot);
  if (depth < 16) {
    for (const input of matched) {
      const value = node!.inputs?.[input.name];
      if (!Array.isArray(value)) continue;
      const upstream = outputType(
        graph,
        info,
        String(value[0]),
        Number(value[1]),
        depth + 1,
      );
      if (upstream !== null && upstream !== "*") return upstream;
    }
  }
  return matched[0]?.type ?? "*";
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
 * The warning says plainly that ComfyUI refuses to run it meanwhile ("Value
 * not in list"), because an earlier wording said the opposite and an agent
 * took it at its word.
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
    const hidden = schema.input?.hidden ?? {};
    const inputs = node.inputs ?? {};
    // The names this node takes with the values it holds: a dynamic combo's
    // chosen option adds inputs, an autogrow input is its numbered names.
    const expected = expectedInputs(schema, inputs);

    for (const input of expected.values()) {
      if (input.required && !(input.name in inputs)) {
        errors.push(`${at}: required input "${input.name}" is missing`);
      }
    }
    for (const [name, value] of Object.entries(inputs)) {
      const input = expected.get(name);
      if (input === undefined) {
        // A nested name past what is expanded here (a dynamic combo inside
        // another) is left to ComfyUI rather than guessed at.
        if (name in hidden || name.includes(".")) continue;
        warnings.push(
          `${at}: "${name}" is not an input of ${node.class_type}, so ` +
            `ComfyUI ignores it` +
            didYouMean(
              closest(
                name,
                [...expected.keys()].filter((key) => !key.includes(".")),
              ),
            ),
        );
        continue;
      }
      const { type, choices } = input;
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
        const given = outputType(graph, info, from, slot);
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
      // A dynamic combo's choice decides which inputs the node has; one that
      // is not among its options leaves ComfyUI nothing to expand.
      if (
        input.kind === "dynamic_combo" && choices !== null &&
        !choices.includes(value)
      ) {
        errors.push(
          `${at}.${name}: ${JSON.stringify(value)} is not one of its ` +
            `options (${listChoices(choices)})`,
        );
        continue;
      }
      if (
        choices !== null && choices.length > 0 && !choices.includes(value)
      ) {
        warnings.push(
          `${at}.${name}: ${JSON.stringify(value)} is not one of this ` +
            `ComfyUI's choices (${listChoices(choices)}), so ComfyUI will ` +
            `refuse to run the graph until it is — fine only if that ` +
            `file is still to be downloaded`,
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
