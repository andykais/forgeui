import type { LoraRow, Manifest, ModelEntry, Param, Template } from "../types.ts";

/**
 * Templates (§4.8) as the screens handle them. Each of a workflow's params is
 * in one of three states on a template: **set** (it carries a value),
 * **ask** (it is left to whoever applies the template, and required while it
 * is applied) or **open** (neither: whatever the panel would hold anyway).
 */
export type ParamState = "set" | "ask" | "open";

export const STATE_LABELS: Record<ParamState, string> = {
  set: "Save value",
  ask: "Ask",
  open: "Leave open",
};

/** What each state means, for the control's `title`. */
export const STATE_HINTS: Record<ParamState, string> = {
  set: "The template fills this in with the value shown",
  ask: "Left for whoever applies the template, and required until filled",
  open: "Not part of the template: the workflow default, or the source run's",
};

/**
 * Where a template leaves each of its workflow's params. An input the
 * workflow requires reads as asked when the template does not set it: it is
 * required either way, and "open" would promise it could be left empty.
 */
export function statesOf(
  template: Pick<Template, "values" | "ask">,
  manifest: Manifest,
): Record<string, ParamState> {
  const states: Record<string, ParamState> = {};
  for (const param of manifest.params) {
    const required = param.required && param.type !== "seed";
    states[param.key] =
      param.key in template.values
        ? "set"
        : template.ask.includes(param.key) || required
          ? "ask"
          : "open";
  }
  return states;
}

/**
 * Where a new template starts, from the panel it is saved out of: what the
 * workflow requires is asked for — a set of LoRAs saved without its prompt
 * still needs one — what was changed from the workflow's default is saved,
 * and the rest is left open. The seed is left open unless it is pinned:
 * a template that always rolled the same picture is rarely what was meant.
 */
export function defaultStates(
  manifest: Manifest,
  values: Record<string, unknown>,
  defaultFor: (param: Param) => unknown,
  seedLocked: boolean,
): Record<string, ParamState> {
  const states: Record<string, ParamState> = {};
  for (const param of manifest.params) {
    const value = values[param.key];
    if (param.type === "seed") {
      states[param.key] =
        seedLocked && typeof value === "number" && value >= 0 ? "set" : "open";
    } else if (param.required) {
      states[param.key] = "ask";
    } else if (
      value !== undefined &&
      JSON.stringify(value) !== JSON.stringify(defaultFor(param))
    ) {
      states[param.key] = "set";
    } else {
      states[param.key] = "open";
    }
  }
  return states;
}

/** The body a save sends: the set values, and the asked keys. */
export function fromStates(
  states: Record<string, ParamState>,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; ask: string[] } {
  const set: Record<string, unknown> = {};
  const ask: string[] = [];
  for (const [key, state] of Object.entries(states)) {
    if (state === "set") set[key] = values[key];
    if (state === "ask") ask.push(key);
  }
  return { values: set, ask };
}

const MEDIA = /^[0-9a-f]{64}\.[a-z0-9]+$/;

/**
 * A value as one line of text, for a table cell or a row in the save
 * dialog. LoRAs by their title, as a model is named everywhere (§8.1); a
 * picture by the start of its hash. `param` is optional because the list
 * has the values but not the manifests, and the shape says enough there.
 */
export function describeValue(
  value: unknown,
  param?: Param,
  loras: ModelEntry[] = [],
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (param?.type === "seed" || (param === undefined && value === -1)) {
    if (value === -1) return "random";
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (MEDIA.test(value)) return `${param?.type ?? "file"} ${value.slice(0, 8)}…`;
    const flat = value.replace(/\s+/g, " ").trim();
    if (param?.type === "text" || flat.includes(" ")) {
      return `“${flat.length > 48 ? `${flat.slice(0, 47)}…` : flat}”`;
    }
    return flat;
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "number")
  ) {
    return `${value[0]} × ${value[1]}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return (value as LoraRow[])
      .map((row) => {
        const title =
          loras.find((model) => model.name === row.name)?.display_name || row.name;
        return `${title} ${row.strength_model}`;
      })
      .join(", ");
  }
  return JSON.stringify(value);
}

/** `scale 2 · creativity 0.2`, for a row in the Templates table. */
export function describeValues(
  values: Record<string, unknown>,
  loras: ModelEntry[] = [],
): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "—";
  return entries
    .map(([key, value]) => `${key} ${describeValue(value, undefined, loras)}`)
    .join(" · ");
}
