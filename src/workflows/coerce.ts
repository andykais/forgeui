import type {
  LoraRow,
  Manifest,
  NumberParam,
  Param,
  SizeParam,
} from "./types.ts";

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
  /** Keys the caller sent that the manifest no longer has (§6.4). */
  unknownKeys: string[];
}

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

function coerceNumber(param: NumberParam, value: unknown): number {
  let out = toNumber(value, param);
  if (param.type === "int") out = Math.round(out);
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
    const name = typeof row.name === "string" ? row.name.trim() : "";
    // An empty row is a picker the user never filled in.
    if (name === "") continue;
    const strengthModel = row.strength_model === undefined
      ? 1
      : toNumber(row.strength_model, param);
    // Linked strengths are the default; the sidecar records both either way.
    const strengthClip = row.strength_clip === undefined
      ? strengthModel
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
      return param.default ?? "";
    case "lora_list":
      return param.default ? structuredClone(param.default) : [];
    case "image":
    case "mask":
    case "video":
      return null;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Validate and normalise submitted params against the manifest: fill defaults,
 * enforce `required`, clamp and snap numbers, resolve `seed: -1` to a real
 * seed, and drop empty LoRA rows. The result is what gets bound into the
 * graph and recorded in the sidecar, so it is always fully resolved.
 */
export function coerceParams(
  manifest: Manifest,
  input: Record<string, unknown> = {},
  options: CoerceOptions = {},
): CoercedParams {
  const values: Record<string, unknown> = {};
  const known = new Set<string>();

  for (const param of manifest.params) {
    known.add(param.key);
    const provided = input[param.key];
    const raw = provided === undefined ? defaultValue(param) : provided;

    if (param.required && isEmpty(raw) && param.type !== "seed") {
      throw new ParamError(param.key, "is required");
    }

    switch (param.type) {
      case "text":
        values[param.key] = typeof raw === "string" ? raw : String(raw ?? "");
        break;
      case "int":
      case "float":
        values[param.key] = coerceNumber(param, raw);
        break;
      case "bool":
        values[param.key] = typeof raw === "boolean"
          ? raw
          : raw === "true" || raw === 1;
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
        const seed = Math.round(toNumber(raw ?? -1, param));
        values[param.key] = seed < 0
          ? (options.randomSeed ?? randomSeed)()
          : Math.min(seed, MAX_SEED);
        break;
      }
      case "size":
        values[param.key] = coerceSize(param, raw);
        break;
      case "model":
        values[param.key] = typeof raw === "string" ? raw : "";
        break;
      case "lora_list":
        values[param.key] = coerceLoras(param, raw ?? []);
        break;
      case "image":
      case "mask":
      case "video":
        values[param.key] = raw ?? null;
        break;
    }
  }

  return {
    values,
    unknownKeys: Object.keys(input).filter((key) => !known.has(key)),
  };
}
