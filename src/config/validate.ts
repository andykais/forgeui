import {
  KEY_ACTIONS,
  type KeyAction,
  MODEL_CLASSES,
  type ModelClass,
  type PartialConfig,
  type PartialUiConfig,
  UI_SCREENS,
  type UiScreen,
} from "./types.ts";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function fail(where: string, expected: string): never {
  throw new ConfigError(`${where}: expected ${expected}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "a mapping");
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") fail(where, "a string");
  return value;
}

function nullableStr(value: unknown, where: string): string | null {
  if (value === null) return null;
  return str(value, where);
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(where, "true or false");
  return value;
}

function port(value: unknown, where: string): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > 65535
  ) {
    fail(where, "an integer between 0 and 65535");
  }
  return value;
}

function strArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(where, "a list of strings");
  return value.map((item, i) => str(item, `${where}[${i}]`));
}

function oneOf<T extends string>(
  value: unknown,
  where: string,
  allowed: readonly T[],
): T {
  const s = str(value, where);
  if (!allowed.includes(s as T)) {
    fail(where, `one of ${allowed.join(", ")}`);
  }
  return s as T;
}

function rejectUnknown(
  value: Record<string, unknown>,
  where: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${where}: unknown key "${key}" (known keys: ${allowed.join(", ")})`,
      );
    }
  }
}

/** Set `target[key]` only when `source` carries the key at all. */
function pick<T, K extends Extract<keyof T, string>>(
  source: Record<string, unknown>,
  key: K,
  target: T,
  read: (value: unknown, where: string) => T[K],
  where: string,
): void {
  if (key in source) target[key] = read(source[key], `${where}.${key}`);
}

function screenMap<V>(
  value: unknown,
  where: string,
  read: (value: unknown, where: string) => V,
): Partial<Record<UiScreen, V>> {
  const raw = record(value, where);
  rejectUnknown(raw, where, UI_SCREENS);
  const out: Partial<Record<UiScreen, V>> = {};
  for (const screen of UI_SCREENS) {
    if (screen in raw) out[screen] = read(raw[screen], `${where}.${screen}`);
  }
  return out;
}

function validateUi(value: unknown, where: string): PartialUiConfig {
  const raw = record(value, where);
  rejectUnknown(raw, where, [
    "rail_expanded",
    "tile_size",
    "sidebar_collapsed",
    "filmstrip_collapsed",
    "workflow_order",
  ]);
  const ui: PartialUiConfig = {};
  pick(raw, "rail_expanded", ui, bool, where);
  if ("tile_size" in raw) {
    ui.tile_size = screenMap(
      raw.tile_size,
      `${where}.tile_size`,
      (v, w) => oneOf(v, w, ["small", "large", "table"] as const),
    );
  }
  if ("sidebar_collapsed" in raw) {
    ui.sidebar_collapsed = screenMap(
      raw.sidebar_collapsed,
      `${where}.sidebar_collapsed`,
      bool,
    );
  }
  if ("filmstrip_collapsed" in raw) {
    ui.filmstrip_collapsed = screenMap(
      raw.filmstrip_collapsed,
      `${where}.filmstrip_collapsed`,
      bool,
    );
  }
  if ("workflow_order" in raw) {
    ui.workflow_order = stringList(
      raw.workflow_order,
      `${where}.workflow_order`,
    );
  }
  return ui;
}

/** A list of ids, deduplicated: the same workflow cannot be in two places. */
function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${where}: expected a list`);
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new ConfigError(`${where}[${i}]: expected a string`);
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Validate one config layer: a parsed `config.yaml`, a CLI override layer or a
 * `PATCH /api/config` body. Unknown keys and wrong types are errors so a typo
 * is reported instead of silently ignored.
 */
export function validatePartialConfig(
  value: unknown,
  where = "config",
): PartialConfig {
  const raw = record(value, where);
  rejectUnknown(raw, where, [
    "server",
    "comfy",
    "model_folders",
    "model_classes",
    "keys",
    "ui",
  ]);
  const out: PartialConfig = {};

  if ("server" in raw) {
    const server = record(raw.server, `${where}.server`);
    rejectUnknown(server, `${where}.server`, ["host", "port"]);
    out.server = {};
    pick(server, "host", out.server, str, `${where}.server`);
    pick(server, "port", out.server, port, `${where}.server`);
  }

  if ("comfy" in raw) {
    const comfy = record(raw.comfy, `${where}.comfy`);
    const at = `${where}.comfy`;
    rejectUnknown(comfy, at, ["mode", "path", "url", "python", "extra_args"]);
    out.comfy = {};
    if ("mode" in comfy) {
      out.comfy.mode = oneOf(
        comfy.mode,
        `${at}.mode`,
        [
          "managed",
          "local_url",
        ] as const,
      );
    }
    pick(comfy, "path", out.comfy, nullableStr, at);
    pick(comfy, "url", out.comfy, str, at);
    pick(comfy, "python", out.comfy, nullableStr, at);
    pick(comfy, "extra_args", out.comfy, strArray, at);
  }

  if ("model_folders" in raw) {
    const folders = record(raw.model_folders, `${where}.model_folders`);
    out.model_folders = {};
    for (const [kind, value] of Object.entries(folders)) {
      out.model_folders[kind] = strArray(
        value,
        `${where}.model_folders.${kind}`,
      );
    }
  }

  if ("model_classes" in raw) {
    const classes = record(raw.model_classes, `${where}.model_classes`);
    out.model_classes = {};
    for (const [kind, value] of Object.entries(classes)) {
      out.model_classes[kind] = oneOf<ModelClass>(
        value,
        `${where}.model_classes.${kind}`,
        MODEL_CLASSES,
      );
    }
  }

  if ("keys" in raw) {
    const keys = record(raw.keys, `${where}.keys`);
    rejectUnknown(keys, `${where}.keys`, KEY_ACTIONS);
    out.keys = {};
    for (const action of KEY_ACTIONS) {
      if (action in keys) {
        const binding = strArray(keys[action], `${where}.keys.${action}`);
        if (binding.length === 0) {
          throw new ConfigError(
            `${where}.keys.${action}: expected at least one key name`,
          );
        }
        out.keys[action as KeyAction] = binding;
      }
    }
  }

  if ("ui" in raw) out.ui = validateUi(raw.ui, `${where}.ui`);

  return out;
}
