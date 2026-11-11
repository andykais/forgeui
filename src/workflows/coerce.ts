import type {
  LoraRow,
  Manifest,
  NumberParam,
  Param,
  SizeParam,
} from "./types.ts";
import { applicableParams } from "./visibility.ts";

export class ParamError extends Error {
  override readonly name = "ParamError";
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.key = key;
  }
}

/** ComfyUI seeds are 64-bit; stay inside the safe integer range. */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

export interface CoerceOptions {
  /** Injectable for tests; resolves `seed: -1` (§4.3). */
  randomSeed?: () => number;
}

export interface CoercedParams {
  /** One entry per manifest param, in manifest order. */
  values: Record<string, unknown>;
}

/** What a `lora_list` row may carry (§4.3); anything else is a typo. */
const LORA_ROW_KEYS = ["name", "strength", "strength_model", "strength_clip"];

export function randomSeed(): number {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  // 53 usable bits: 21 high bits + 32 low bits.
  return (bytes[0]! % 0x200000) * 0x100000000 + bytes[1]!;
}

function snap(value: number, step: number, floor: number | undefined): number {
  const base = floor ?? 0;
  return base + Math.round((value - base) / step) * step;
}

function clamp(value: number, min?: number, max?: number): number {
  let out = value;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
}

function toNumber(value: unknown, param: Param): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ParamError(param.key, `expected a number, got ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** "4–100", "at least 4", "at most 100": what a refusal shows. */
function range(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return `${min}–${max}`;
  return min !== undefined ? `at least ${min}` : `at most ${max}`;
}

/**
 * A value the submitter named must be inside the range, not moved into it
 * (§4.3): a clamped value is a result they will read as the one they asked
 * for. A default nobody named is still clamped.
 */
function assertInRange(
  param: Param,
  value: number,
  min: number | undefined,
  max: number | undefined,
) {
  if (min === undefined && max === undefined) return;
  if (
    (min !== undefined && value < min) || (max !== undefined && value > max)
  ) {
    throw new ParamError(
      param.key,
      `${value} is out of range (${range(min, max)})`,
    );
  }
}

function coerceNumber(
  param: NumberParam,
  value: unknown,
  provided: boolean,
): number {
  let out = toNumber(value, param);
  if (param.type === "int") out = Math.round(out);
  if (provided) assertInRange(param, out, param.min, param.max);
  if (param.step !== undefined && param.step > 0) {
    out = snap(out, param.step, param.min);
    if (param.type === "int") out = Math.round(out);
  }
  out = clamp(out, param.min, param.max);
  return param.type === "int" ? Math.round(out) : roundFloat(out);
}

/** Kill the float noise `0.1` steps introduce, without inventing precision. */
function roundFloat(value: number): number {
  return Number(value.toFixed(6));
}

function coerceSize(param: SizeParam, value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ParamError(param.key, "expected [width, height]");
  }
  const step = param.step;
  const dimension = (raw: unknown, which: string): number => {
    let out = Math.round(toNumber(raw, param));
    if (step) out = Math.max(step, Math.round(out / step) * step);
    if (out <= 0) {
      throw new ParamError(param.key, `${which} must be positive`);
    }
    return out;
  };
  return [dimension(value[0], "width"), dimension(value[1], "height")];
}

function coerceLoras(param: Param, value: unknown): LoraRow[] {
  if (!Array.isArray(value)) {
    throw new ParamError(param.key, "expected a list of LoRA rows");
  }
  const rows: LoraRow[] = [];
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ParamError(param.key, `row ${i} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const unknown = Object.keys(row).filter((key) =>
      !LORA_ROW_KEYS.includes(key)
    );
    if (unknown.length > 0) {
      throw new ParamError(
        param.key,
        `row ${i} has no ${quoteAll(unknown)}; a row takes ${
          LORA_ROW_KEYS.join(", ")
        }`,
      );
    }
    if (row.name !== undefined && typeof row.name !== "string") {
      throw new ParamError(
        param.key,
        `row ${i}: name must be a LoRA filename, got ${describe(row.name)}`,
      );
    }
    const name = (row.name ?? "").trim();
    // An empty row is a picker the user never filled in.
    if (name === "") continue;
    // `strength` is the panel's linked slider; either half overrides it, and
    // without it clip follows model, as the panel's rows always have. The
    // sidecar records both halves either way.
    const strength = row.strength === undefined
      ? undefined
      : toNumber(row.strength, param);
    const strengthModel = row.strength_model === undefined
      ? strength ?? 1
      : toNumber(row.strength_model, param);
    const strengthClip = row.strength_clip === undefined
      ? strength ?? strengthModel
      : toNumber(row.strength_clip, param);
    rows.push({
      name,
      strength_model: roundFloat(strengthModel),
      strength_clip: roundFloat(strengthClip),
    });
  }
  return rows;
}

function defaultValue(param: Param): unknown {
  switch (param.type) {
    case "text":
      return param.default ?? "";
    case "int":
    case "float":
      return param.default ?? param.min ?? 0;
    case "bool":
      return param.default ?? false;
    case "enum":
      return param.default ?? param.options?.[0] ?? "";
    case "seed":
      return param.default ?? -1;
    case "size":
      return [...param.default];
    case "model":
    case "text_encoder":
    case "vae":
      return param.default ?? "";
    case "lora_list":
      return param.default ? structuredClone(param.default) : [];
    case "image":
    case "mask":
    case "video":
    case "audio":
      return null;
  }
}

function quoteAll(keys: string[]): string {
  return keys.map((key) => `"${key}"`).join(", ");
}

function coerceBool(param: Param, value: unknown): boolean {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  throw new ParamError(
    param.key,
    `expected true or false, got ${JSON.stringify(value) ?? describe(value)}`,
  );
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Validate and normalise submitted params against the manifest: fill defaults,
 * enforce `required`, snap numbers to their step, resolve `seed: -1` to a real
 * seed, and drop empty LoRA rows. A key the manifest lacks, or a value outside
 * its range, is refused rather than dropped or clamped (§4.3). The result is
 * what gets bound into the graph and recorded in the sidecar, so it is always
 * fully resolved.
 */
export function coerceParams(
  manifest: Manifest,
  input: Record<string, unknown> = {},
  options: CoerceOptions = {},
): CoercedParams {
  const known = new Set(manifest.params.map((param) => param.key));
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ParamError(
      unknown[0]!,
      `this workflow has no param ${quoteAll(unknown)}; it takes ${
        known.size > 0 ? [...known].join(", ") : "none"
      }`,
    );
  }

  const values: Record<string, unknown> = {};
  for (const param of manifest.params) {
    const provided = input[param.key];
    const raw = provided === undefined ? defaultValue(param) : provided;

    switch (param.type) {
      case "text":
        if (typeof raw === "object" && raw !== null) {
          throw new ParamError(
            param.key,
            `expected text, got ${describe(raw)}`,
          );
        }
        values[param.key] = typeof raw === "string" ? raw : String(raw ?? "");
        break;
      case "int":
      case "float":
        values[param.key] = coerceNumber(param, raw, provided !== undefined);
        break;
      case "bool":
        values[param.key] = coerceBool(param, raw);
        break;
      case "enum": {
        const text = typeof raw === "string" ? raw : String(raw ?? "");
        if (param.options && !param.options.includes(text)) {
          throw new ParamError(
            param.key,
            `"${text}" is not one of ${param.options.join(", ")}`,
          );
        }
        values[param.key] = text;
        break;
      }
      case "seed": {
        // A workflow may take a narrower range than the app's own; rolling
        // outside it is a refusal the user never asked for (§4.3).
        const low = Math.max(0, param.min ?? 0);
        const high = Math.min(param.max ?? MAX_SEED, MAX_SEED);
        const seed = Math.round(toNumber(raw ?? -1, param));
        if (seed >= 0 && provided !== undefined) {
          assertInRange(param, seed, low, high);
        }
        values[param.key] = seed < 0
          ? low + (options.randomSeed ?? randomSeed)() % (high - low + 1)
          : clamp(seed, low, high);
        break;
      }
      case "size":
        values[param.key] = coerceSize(param, raw);
        break;
      case "model":
      case "text_encoder":
      case "vae":
        if (raw !== null && typeof raw !== "string") {
          throw new ParamError(
            param.key,
            `expected a model filename, got ${describe(raw)}`,
          );
        }
        values[param.key] = raw ?? "";
        break;
      case "lora_list":
        values[param.key] = coerceLoras(param, raw ?? []);
        break;
      case "image":
      case "mask":
      case "video":
      case "audio":
        values[param.key] = raw ?? null;
        break;
    }
  }

  // Required is checked afterwards, against the values rather than as they
  // arrive: whether a param applies can depend on another one's value (§4.3),
  // and that value is not known until every param has been read. A field the
  // workflow is ignoring must not be able to refuse the job — the panel does
  // not show it, so there would be nothing to go and fill in.
  for (const param of applicableParams(manifest, values)) {
    if (!param.required || param.type === "seed") continue;
    if (isEmpty(values[param.key])) {
      throw new ParamError(param.key, "is required");
    }
  }

  return { values };
}
