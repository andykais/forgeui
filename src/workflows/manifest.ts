import {
  type ApiGraph,
  type EnumSource,
  FAMILIES,
  type Family,
  isLink,
  type LoraChain,
  type LoraRow,
  type Manifest,
  type ManifestOutput,
  type ModelFilter,
  type Param,
  PARAM_TYPES,
  type ParamType,
  WORKFLOW_CATEGORIES,
  WORKFLOW_KINDS,
  type WorkflowCategory,
  type WorkflowKind,
} from "./types.ts";
import { outputSlot } from "./nodes.ts";

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

function fail(where: string, expected: string): never {
  throw new ManifestError(`${where}: expected ${expected}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "an object");
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") fail(where, "a string");
  return value;
}

function nonEmptyStr(value: unknown, where: string): string {
  const text = str(value, where);
  if (text.trim().length === 0) fail(where, "a non-empty string");
  return text;
}

function num(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(where, "a number");
  }
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(where, "true or false");
  return value;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, "a list");
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  where: string,
  allowed: readonly T[],
): T {
  const text = str(value, where);
  if (!allowed.includes(text as T)) {
    fail(where, `one of ${allowed.join(", ")}`);
  }
  return text as T;
}

function nullable<T>(
  value: unknown,
  read: (value: unknown) => T,
): T | null {
  return value === null || value === undefined ? null : read(value);
}

/** `"6.text"` → node `6`, input `text`. */
export function parseBind(
  bind: string,
  where: string,
): { node: string; input: string } {
  const dot = bind.indexOf(".");
  if (dot <= 0 || dot === bind.length - 1) {
    fail(where, 'a "<node_id>.<input>" binding');
  }
  return { node: bind.slice(0, dot), input: bind.slice(dot + 1) };
}

function assertBindTarget(
  graph: ApiGraph | null,
  bind: string,
  where: string,
): void {
  const { node, input } = parseBind(bind, where);
  if (!graph) return;
  const target = graph[node];
  if (!target) {
    throw new ManifestError(`${where}: no node "${node}" in workflow.api.json`);
  }
  if (!(input in target.inputs)) {
    throw new ManifestError(
      `${where}: node ${node} (${target.class_type}) has no input "${input}"`,
    );
  }
  if (isLink(target.inputs[input])) {
    throw new ManifestError(
      `${where}: node ${node}.${input} is fed by a link, so it cannot be bound`,
    );
  }
}

/** `"1.MODEL"` → the node and the slot the chain starts from (§4.4). */
export function assertChainSource(
  graph: ApiGraph | null,
  reference: string,
  where: string,
): void {
  const { node, input: outputName } = parseBind(reference, where);
  if (!graph) return;
  const target = graph[node];
  if (!target) {
    throw new ManifestError(`${where}: no node "${node}" in workflow.api.json`);
  }
  if (outputSlot(target.class_type, outputName) === null) {
    throw new ManifestError(
      `${where}: ${target.class_type} has no output "${outputName}" ` +
        `(use a slot index such as "${node}.0" for nodes the app has no schema for)`,
    );
  }
}

function assertChainTarget(
  graph: ApiGraph | null,
  bind: string,
  where: string,
): void {
  const { node, input } = parseBind(bind, where);
  if (!graph) return;
  const target = graph[node];
  if (!target) {
    throw new ManifestError(`${where}: no node "${node}" in workflow.api.json`);
  }
  if (!isLink(target.inputs[input])) {
    throw new ManifestError(
      `${where}: node ${node}.${input} must be fed by a link for the LoRA chain to rewire it`,
    );
  }
}

function filter(value: unknown, where: string): ModelFilter | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, where);
  const out: ModelFilter = {};
  if (raw.family !== undefined) {
    out.family = oneOf<Family>(raw.family, `${where}.family`, FAMILIES);
  }
  return out;
}

function loraRows(value: unknown, where: string): LoraRow[] {
  return array(value, where).map((row, i) => {
    const at = `${where}[${i}]`;
    const raw = record(row, at);
    const strengthModel = num(raw.strength_model ?? 1, `${at}.strength_model`);
    return {
      name: nonEmptyStr(raw.name, `${at}.name`),
      strength_model: strengthModel,
      strength_clip: num(
        raw.strength_clip ?? strengthModel,
        `${at}.strength_clip`,
      ),
    };
  });
}

function chain(value: unknown, where: string): LoraChain {
  const raw = record(value, where);
  const modelTo = array(raw.model_to, `${where}.model_to`).map((entry, i) =>
    nonEmptyStr(entry, `${where}.model_to[${i}]`)
  );
  if (modelTo.length === 0) {
    fail(`${where}.model_to`, "at least one input to rewire");
  }
  const clipFrom = nullable(
    raw.clip_from,
    (v) => nonEmptyStr(v, `${where}.clip_from`),
  );
  const clipTo = raw.clip_to === null || raw.clip_to === undefined
    ? null
    : array(raw.clip_to, `${where}.clip_to`).map((entry, i) =>
      nonEmptyStr(entry, `${where}.clip_to[${i}]`)
    );
  if ((clipFrom === null) !== (clipTo === null || clipTo.length === 0)) {
    throw new ManifestError(
      `${where}: clip_from and clip_to must both be set, or both be null for ` +
        `model-only LoRAs (§4.4)`,
    );
  }
  return {
    model_from: nonEmptyStr(raw.model_from, `${where}.model_from`),
    clip_from: clipFrom,
    model_to: modelTo,
    clip_to: clipTo && clipTo.length > 0 ? clipTo : null,
  };
}

function validateParam(
  value: unknown,
  where: string,
  graph: ApiGraph | null,
): Param {
  const raw = record(value, where);
  const key = nonEmptyStr(raw.key, `${where}.key`);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    fail(
      `${where}.key`,
      "a lower_snake_case identifier (it is the key in params and sidecars)",
    );
  }
  const at = `${where} (${key})`;
  const type = oneOf<ParamType>(raw.type, `${at}.type`, PARAM_TYPES);
  const common = {
    key,
    ...(raw.label !== undefined
      ? { label: nonEmptyStr(raw.label, `${at}.label`) }
      : {}),
    ...(raw.description !== undefined
      ? { description: str(raw.description, `${at}.description`) }
      : {}),
    ...(raw.required !== undefined
      ? { required: bool(raw.required, `${at}.required`) }
      : {}),
    ...(raw.advanced !== undefined
      ? { advanced: bool(raw.advanced, `${at}.advanced`) }
      : {}),
  };

  const scalarBind = (): string => {
    const bind = nonEmptyStr(raw.bind, `${at}.bind`);
    assertBindTarget(graph, bind, `${at}.bind`);
    return bind;
  };

  switch (type) {
    case "text":
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(raw.default !== undefined
          ? { default: str(raw.default, `${at}.default`) }
          : {}),
      };
    case "int":
    case "float": {
      const min = raw.min === undefined ? undefined : num(raw.min, `${at}.min`);
      const max = raw.max === undefined ? undefined : num(raw.max, `${at}.max`);
      const step = raw.step === undefined
        ? undefined
        : num(raw.step, `${at}.step`);
      if (min !== undefined && max !== undefined && min > max) {
        throw new ManifestError(`${at}: min ${min} is above max ${max}`);
      }
      if (step !== undefined && step <= 0) {
        fail(`${at}.step`, "a positive number");
      }
      const value = raw.default === undefined
        ? undefined
        : num(raw.default, `${at}.default`);
      if (value !== undefined && type === "int" && !Number.isInteger(value)) {
        fail(`${at}.default`, "a whole number");
      }
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(value !== undefined ? { default: value } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
      };
    }
    case "bool":
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(raw.default !== undefined
          ? { default: bool(raw.default, `${at}.default`) }
          : {}),
      };
    case "enum": {
      const options = raw.options === undefined
        ? undefined
        : array(raw.options, `${at}.options`).map((option, i) =>
          nonEmptyStr(option, `${at}.options[${i}]`)
        );
      // A source is a model class or a `model_folders` key, and kinds are
      // open-ended, so anything non-empty is accepted rather than an enum.
      const source: EnumSource | undefined = raw.source === undefined
        ? undefined
        : nonEmptyStr(raw.source, `${at}.source`);
      if (!options && !source) {
        throw new ManifestError(
          `${at}: an enum needs either options or a source`,
        );
      }
      if (options && options.length === 0) {
        fail(`${at}.options`, "at least one option");
      }
      const value = raw.default === undefined
        ? undefined
        : nonEmptyStr(raw.default, `${at}.default`);
      if (value !== undefined && options && !options.includes(value)) {
        throw new ManifestError(
          `${at}.default: "${value}" is not one of the options`,
        );
      }
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(options ? { options } : {}),
        ...(source ? { source } : {}),
        ...(value !== undefined ? { default: value } : {}),
      };
    }
    case "seed":
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(raw.default !== undefined
          ? { default: num(raw.default, `${at}.default`) }
          : {}),
      };
    case "size": {
      const bind = record(raw.bind, `${at}.bind`);
      const w = nonEmptyStr(bind.w, `${at}.bind.w`);
      const h = nonEmptyStr(bind.h, `${at}.bind.h`);
      assertBindTarget(graph, w, `${at}.bind.w`);
      assertBindTarget(graph, h, `${at}.bind.h`);
      const size = array(raw.default, `${at}.default`);
      if (size.length !== 2) {
        fail(`${at}.default`, "[width, height] — the base resolution");
      }
      const width = num(size[0], `${at}.default[0]`);
      const height = num(size[1], `${at}.default[1]`);
      if (width <= 0 || height <= 0) {
        fail(`${at}.default`, "positive dimensions");
      }
      const step = raw.step === undefined
        ? undefined
        : num(raw.step, `${at}.step`);
      if (step !== undefined && ![8, 16, 64].includes(step)) {
        fail(`${at}.step`, "8, 16 or 64");
      }
      return {
        ...common,
        type,
        bind: { w, h },
        default: [width, height],
        ...(step !== undefined ? { step: step as 8 | 16 | 64 } : {}),
      };
    }
    case "checkpoint":
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(filter(raw.filter, `${at}.filter`)
          ? { filter: filter(raw.filter, `${at}.filter`)! }
          : {}),
        ...(raw.default !== undefined
          ? { default: str(raw.default, `${at}.default`) }
          : {}),
      };
    case "lora_list": {
      const bind = record(raw.bind, `${at}.bind`);
      const parsed = chain(bind.chain, `${at}.bind.chain`);
      assertChainSource(
        graph,
        parsed.model_from,
        `${at}.bind.chain.model_from`,
      );
      if (parsed.clip_from) {
        assertChainSource(
          graph,
          parsed.clip_from,
          `${at}.bind.chain.clip_from`,
        );
      }
      parsed.model_to.forEach((target, i) =>
        assertChainTarget(graph, target, `${at}.bind.chain.model_to[${i}]`)
      );
      parsed.clip_to?.forEach((target, i) =>
        assertChainTarget(graph, target, `${at}.bind.chain.clip_to[${i}]`)
      );
      const parsedFilter = filter(raw.filter, `${at}.filter`);
      return {
        ...common,
        type,
        bind: { chain: parsed },
        ...(parsedFilter ? { filter: parsedFilter } : {}),
        ...(raw.default !== undefined
          ? { default: loraRows(raw.default, `${at}.default`) }
          : {}),
      };
    }
    case "image":
    case "mask":
    case "video":
      return {
        ...common,
        type,
        bind: scalarBind(),
        ...(raw.of !== undefined
          ? { of: nonEmptyStr(raw.of, `${at}.of`) }
          : {}),
      };
  }
}

function validateOutput(
  value: unknown,
  where: string,
  graph: ApiGraph | null,
): ManifestOutput {
  const raw = record(value, where);
  const node = nonEmptyStr(raw.node, `${where}.node`);
  if (graph && !(node in graph)) {
    throw new ManifestError(
      `${where}.node: no node "${node}" in workflow.api.json`,
    );
  }
  return {
    node,
    kind: oneOf<WorkflowKind>(raw.kind, `${where}.kind`, WORKFLOW_KINDS),
  };
}

export interface ValidateManifestOptions {
  /** Checked against `manifest.id`; the directory name wins. */
  id?: string;
  /** When given, every bind is checked against the graph. */
  graph?: ApiGraph | null;
}

/**
 * Validate a `manifest.json` against the closed param type set (§4.3) and,
 * when the graph is available, against the nodes it binds to.
 */
export function validateManifest(
  value: unknown,
  options: ValidateManifestOptions = {},
): Manifest {
  const graph = options.graph ?? null;
  const raw = record(value, "manifest");
  const id = nonEmptyStr(raw.id, "manifest.id");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    fail("manifest.id", "a lowercase directory-safe id");
  }
  if (options.id !== undefined && options.id !== id) {
    throw new ManifestError(
      `manifest.id: "${id}" does not match the directory "${options.id}"`,
    );
  }

  const params: Param[] = array(raw.params, "manifest.params").map(
    (param, i) => validateParam(param, `manifest.params[${i}]`, graph),
  );
  const seen = new Set<string>();
  for (const param of params) {
    if (seen.has(param.key)) {
      throw new ManifestError(`manifest.params: duplicate key "${param.key}"`);
    }
    seen.add(param.key);
  }
  for (const param of params) {
    if (
      param.type === "mask" && param.of !== undefined && !seen.has(param.of)
    ) {
      throw new ManifestError(
        `manifest.params (${param.key}).of: no param "${param.of}"`,
      );
    }
  }
  const loraLists = params.filter((param) => param.type === "lora_list");
  if (loraLists.length > 1) {
    throw new ManifestError(
      "manifest.params: only one lora_list param is supported per workflow",
    );
  }

  return {
    id,
    name: nonEmptyStr(raw.name, "manifest.name"),
    family: nullable(
      raw.family,
      (v) => oneOf<Family>(v, "manifest.family", FAMILIES),
    ),
    kind: oneOf<WorkflowKind>(raw.kind, "manifest.kind", WORKFLOW_KINDS),
    category: nullable(
      raw.category,
      (v) =>
        oneOf<WorkflowCategory>(v, "manifest.category", WORKFLOW_CATEGORIES),
    ),
    description: nullable(
      raw.description,
      (v) => str(v, "manifest.description"),
    ),
    params,
    // An empty list is a draft: it loads and lists, but cannot be submitted.
    outputs: array(raw.outputs, "manifest.outputs").map((output, i) =>
      validateOutput(output, `manifest.outputs[${i}]`, graph)
    ),
  };
}

/** Field order for a manifest written back to disk, matching §4.2. */
export function serializeManifest(manifest: Manifest): string {
  const ordered = {
    id: manifest.id,
    name: manifest.name,
    family: manifest.family,
    kind: manifest.kind,
    category: manifest.category,
    description: manifest.description,
    params: manifest.params,
    outputs: manifest.outputs,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
