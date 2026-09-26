/**
 * Reading generation data back out of an image (DESIGN-MODEL-IMPORT §6).
 *
 * Four tools write their settings into the file itself, in four shapes, and
 * this reads all of them into one. It is pure: bytes in, a record out, no I/O
 * and no network. Three callers want it — the sample drop zone that already
 * exists, `forge models` when the API has no `meta` for an image, and the
 * SwarmUI/ComfyUI importers that do not exist yet.
 *
 * What it produces is `raw` in the §8.3 sense: stored and shown, never mapped
 * onto a workflow's params. `fields` is the closed subset the UI renders;
 * everything else stays in `source`, untouched, for the day mapping arrives.
 */

import { readTextChunks } from "../jobs/png.ts";
import { parseSidecar, type Sidecar, SidecarError } from "../jobs/sidecar.ts";

export type InfotextFormat =
  | "civitai-meta"
  | "a1111-infotext"
  | "comfyui-workflow"
  | "forgeui-sidecar"
  | "unknown";

/**
 * The closed list of §5.3. Everything here is optional: a parse that got half
 * of it is worth more than an error, because a prompt you can read beats a
 * stack trace.
 */
export interface InfotextFields {
  prompt?: string;
  negative_prompt?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  width?: number;
  height?: number;
  model?: string;
  model_hash?: string;
  loras?: { name: string; weight?: number }[];
}

export interface Infotext {
  format: InfotextFormat;
  fields: InfotextFields;
  /** The original blob the fields were read out of, unmodified. */
  source: unknown;
}

/** A file this build cannot read is `unknown`, never an exception. */
export const NO_INFOTEXT: Infotext = {
  format: "unknown",
  fields: {},
  source: null,
};

// --------------------------------------------------------------- A1111 text

/**
 * The A1111 grammar, which is three parts and no delimiter between the first
 * two beyond a line that happens to start with `Negative prompt:`:
 *
 *     a prompt, possibly several lines
 *     Negative prompt: also possibly several lines
 *     Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 123, Size: 768x768
 *
 * The settings line is only the *last* line, and only when it parses as
 * `Key: value` pairs — a prompt whose final line contains a colon is common
 * and must not be eaten.
 */
export function parseA1111(text: string): Infotext {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let settings: Record<string, string> = {};
  let body = lines;

  const last = lines[lines.length - 1] ?? "";
  const parsed = parseSettingsLine(last);
  if (parsed !== null) {
    settings = parsed;
    body = lines.slice(0, -1);
  }

  const negativeAt = body.findIndex((line) =>
    line.trimStart().toLowerCase().startsWith("negative prompt:")
  );
  const prompt = (negativeAt < 0 ? body : body.slice(0, negativeAt))
    .join("\n").trim();
  const negative = negativeAt < 0 ? "" : [
    body[negativeAt]!.trimStart().slice("negative prompt:".length),
    ...body.slice(negativeAt + 1),
  ].join("\n").trim();

  const fields: InfotextFields = {};
  if (prompt) fields.prompt = prompt;
  if (negative) fields.negative_prompt = negative;
  assignSettings(fields, settings);
  return { format: "a1111-infotext", fields, source: text };
}

/**
 * `Steps: 30, Sampler: DPM++ 2M Karras, Hashes: {"model":"abc"}` — split on
 * commas that are not inside quotes or braces, because both appear in real
 * values and a naive `split(",")` mangles every one of them.
 */
function parseSettingsLine(line: string): Record<string, string> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !/^[A-Za-z][\w .+/-]*:/.test(trimmed)) {
    return null;
  }

  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '"' && trimmed[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && (char === "{" || char === "[")) depth++;
    else if (!quoted && (char === "}" || char === "]")) depth--;
    else if (char === "," && !quoted && depth === 0) {
      parts.push(trimmed.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start));

  const out: Record<string, string> = {};
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim().replace(/^"|"$/g, "");
    if (key.length > 0) out[key] = value;
  }
  // A "settings line" with one pair and no recognised key is a prompt that
  // ended in a colon, not settings.
  return Object.keys(out).length > 1 ||
      KNOWN_KEYS.has(Object.keys(out)[0] ?? "")
    ? out
    : null;
}

const KNOWN_KEYS = new Set([
  "steps",
  "sampler",
  "scheduler",
  "cfg scale",
  "seed",
  "size",
  "model",
  "model hash",
  "denoising strength",
]);

function assignSettings(
  fields: InfotextFields,
  settings: Record<string, string>,
): void {
  const num = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const set = <K extends keyof InfotextFields>(
    key: K,
    value: InfotextFields[K] | undefined,
  ) => {
    if (value !== undefined) fields[key] = value;
  };

  set("steps", num(settings["steps"]));
  set("cfg", num(settings["cfg scale"] ?? settings["cfg"]));
  set("seed", num(settings["seed"]));
  set("denoise", num(settings["denoising strength"] ?? settings["denoise"]));
  set("sampler", settings["sampler"] || undefined);
  set("scheduler", settings["scheduler"] || undefined);
  set("model", settings["model"] || undefined);
  set("model_hash", settings["model hash"] || undefined);

  const size = settings["size"];
  const match = size?.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (match) {
    fields.width = Number(match[1]);
    fields.height = Number(match[2]);
  }
}

// ------------------------------------------------------------ civitai meta

/**
 * Civitai's `meta`, which is A1111's vocabulary as an object — the same keys
 * in camelCase, plus `resources` naming the LoRAs.
 */
export function parseCivitaiMeta(meta: Record<string, unknown>): Infotext {
  const fields: InfotextFields = {};
  const str = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const num = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const set = <K extends keyof InfotextFields>(
    key: K,
    value: InfotextFields[K] | undefined,
  ) => {
    if (value !== undefined) fields[key] = value;
  };

  set("prompt", str(meta.prompt));
  set("negative_prompt", str(meta.negativePrompt));
  set("seed", num(meta.seed));
  set("steps", num(meta.steps));
  set("cfg", num(meta.cfgScale));
  set("sampler", str(meta.sampler));
  set("scheduler", str(meta.scheduler));
  set("denoise", num(meta.denoise ?? meta["Denoising strength"]));
  set("model", str(meta.Model));
  set("width", num(meta.width));
  set("height", num(meta.height));

  const size = str(meta.Size)?.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (size && fields.width === undefined) {
    fields.width = Number(size[1]);
    fields.height = Number(size[2]);
  }

  const hashes = meta.hashes;
  if (typeof hashes === "object" && hashes !== null) {
    const model = (hashes as Record<string, unknown>).model;
    if (typeof model === "string") fields.model_hash = model;
  }

  const resources = meta.resources;
  if (Array.isArray(resources)) {
    const loras: { name: string; weight?: number }[] = [];
    for (const entry of resources) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "lora") continue;
      const name = str(record.name);
      if (name === undefined) continue;
      const weight = num(record.weight);
      loras.push(weight === undefined ? { name } : { name, weight });
    }
    if (loras.length > 0) fields.loras = loras;
  }

  return { format: "civitai-meta", fields, source: meta };
}

// ------------------------------------------------------------------- files

/**
 * What an image says about itself. The order is deliberate: this app's own
 * sidecar first, because importing your own output back in should restore the
 * real thing rather than a re-parse of it.
 */
export function readInfotext(bytes: Uint8Array): Infotext {
  const png = pngText(bytes);
  if (png !== null) {
    const embedded = png["forgeui"];
    if (embedded !== undefined) {
      const sidecar = tryParseSidecar(embedded);
      if (sidecar !== null) {
        return {
          format: "forgeui-sidecar",
          fields: fieldsFromSidecar(sidecar),
          source: sidecar,
        };
      }
    }
    // SwarmUI writes JSON under the same keyword A1111 uses plain text under.
    const parameters = png["parameters"];
    if (parameters !== undefined) {
      const swarm = trySwarmUi(parameters);
      if (swarm !== null) return swarm;
      return parseA1111(parameters);
    }
    const prompt = png["prompt"];
    const workflow = png["workflow"];
    if (prompt !== undefined || workflow !== undefined) {
      return comfyWorkflow(prompt, workflow);
    }
  }

  const comment = exifUserComment(bytes);
  if (comment !== null) return parseA1111(comment);
  return NO_INFOTEXT;
}

function pngText(bytes: Uint8Array): Record<string, string> | null {
  try {
    return readTextChunks(bytes);
  } catch {
    return null;
  }
}

function tryParseSidecar(text: string): Sidecar | null {
  try {
    return parseSidecar(text, "embedded sidecar");
  } catch (cause) {
    if (cause instanceof SidecarError) return null;
    throw cause;
  }
}

function fieldsFromSidecar(sidecar: Sidecar): InfotextFields {
  const fields: InfotextFields = {};
  const params = sidecar.params;
  const str = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const num = (key: string) => {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  const set = <K extends keyof InfotextFields>(
    key: K,
    value: InfotextFields[K] | undefined,
  ) => {
    if (value !== undefined) fields[key] = value;
  };
  set("prompt", str("prompt"));
  set("negative_prompt", str("negative") ?? str("negative_prompt"));
  set("seed", num("seed"));
  set("steps", num("steps"));
  set("cfg", num("cfg"));
  set("denoise", num("denoise"));
  set("sampler", str("sampler"));
  set("scheduler", str("scheduler"));
  const model = sidecar.models.find((entry) => entry.role !== "lora");
  if (model) {
    fields.model = model.name;
    if (model.hash) fields.model_hash = model.hash;
  }
  const loras = sidecar.models
    .filter((entry) => entry.role === "lora")
    .map((entry) => ({ name: entry.name }));
  if (loras.length > 0) fields.loras = loras;
  return fields;
}

/**
 * SwarmUI writes `{"sui_image_params": {...}}` under `parameters`, where
 * A1111 writes plain text. Same keyword, different worlds.
 */
function trySwarmUi(text: string): Infotext | null {
  if (!text.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const params = (parsed as Record<string, unknown>).sui_image_params;
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;

  const fields: InfotextFields = {};
  const str = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const num = (key: string) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };
  const set = <K extends keyof InfotextFields>(
    key: K,
    value: InfotextFields[K] | undefined,
  ) => {
    if (value !== undefined) fields[key] = value;
  };
  set("prompt", str("prompt"));
  set("negative_prompt", str("negativeprompt"));
  set("seed", num("seed"));
  set("steps", num("steps"));
  set("cfg", num("cfgscale"));
  set("sampler", str("sampler"));
  set("scheduler", str("scheduler"));
  set("width", num("width"));
  set("height", num("height"));
  set("model", str("model"));
  return { format: "a1111-infotext", fields, source: parsed };
}

/**
 * ComfyUI writes the API graph under `prompt` and the editor graph under
 * `workflow`. Neither says which node held the prompt, so nothing is guessed:
 * the graph is kept whole and the fields stay empty. Mapping a graph back
 * onto params is the later phase §8.3 describes.
 */
function comfyWorkflow(
  prompt: string | undefined,
  workflow: string | undefined,
): Infotext {
  const json = (text: string | undefined) => {
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  return {
    format: "comfyui-workflow",
    fields: {},
    source: { prompt: json(prompt), workflow: json(workflow) },
  };
}

/**
 * The A1111 infotext a JPEG or WebP carries, which lives in EXIF
 * `UserComment` (tag 0x9286) — usually UTF-16BE behind an eight-byte
 * character-code prefix, occasionally plain ASCII.
 *
 * This walks the TIFF header rather than pulling in an EXIF library: one tag
 * out of one IFD is not worth a dependency, and the failure mode we want is
 * "no infotext" rather than "threw inside someone else's parser".
 */
export function exifUserComment(bytes: Uint8Array): string | null {
  const tiff = findTiffHeader(bytes);
  if (tiff === null) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const little = bytes[tiff] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (tiff + 8 > bytes.length || u16(tiff + 2) !== 0x2a) return null;

  const ifd0 = tiff + u32(tiff + 4);
  const exifIfd = findTag(bytes, view, ifd0, 0x8769, little);
  for (const ifd of [exifIfd === null ? null : tiff + exifIfd, ifd0]) {
    if (ifd === null) continue;
    const found = readUserComment(bytes, view, tiff, ifd, little);
    if (found !== null) return found;
  }
  return null;
}

/** `Exif\0\0` inside an APP1 segment, whatever container wraps it. */
function findTiffHeader(bytes: Uint8Array): number | null {
  const limit = Math.min(bytes.length - 6, 1 << 16);
  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
      bytes[i + 3] === 0x66 && bytes[i + 4] === 0 && bytes[i + 5] === 0
    ) {
      const tiff = i + 6;
      const order = bytes[tiff];
      if (order === 0x49 || order === 0x4d) return tiff;
    }
  }
  return null;
}

function findTag(
  bytes: Uint8Array,
  view: DataView,
  ifd: number,
  tag: number,
  little: boolean,
): number | null {
  if (ifd + 2 > bytes.length) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return null;
    if (view.getUint16(entry, little) !== tag) continue;
    return view.getUint32(entry + 8, little);
  }
  return null;
}

function readUserComment(
  bytes: Uint8Array,
  view: DataView,
  tiff: number,
  ifd: number,
  little: boolean,
): string | null {
  if (ifd + 2 > bytes.length) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return null;
    if (view.getUint16(entry, little) !== 0x9286) continue;
    const length = view.getUint32(entry + 4, little);
    if (length <= 8) return null;
    const at = tiff + view.getUint32(entry + 8, little);
    if (at + length > bytes.length) return null;
    return decodeUserComment(bytes.subarray(at, at + length), little);
  }
  return null;
}

function decodeUserComment(data: Uint8Array, little: boolean): string | null {
  const prefix = new TextDecoder("latin1").decode(data.subarray(0, 8));
  const body = data.subarray(8);
  let text: string;
  if (prefix.startsWith("UNICODE")) {
    text = new TextDecoder(little ? "utf-16le" : "utf-16be").decode(body);
  } else if (prefix.startsWith("ASCII")) {
    text = new TextDecoder("latin1").decode(body);
  } else {
    text = new TextDecoder("utf-8").decode(data);
  }
  const trimmed = text.replace(/\0+$/, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}
