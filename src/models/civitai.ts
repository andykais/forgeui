/**
 * What Civitai says, in this app's vocabulary
 * (DESIGN-MODEL-IMPORT §4.1, §4.2, §5.5).
 *
 * Pure normalisation: URL forms in, a model version out; an upstream response
 * in, a source record out. No I/O — `src/cli/civitai_client.ts` does the
 * fetching and this says what the answers mean, so every mapping here is a
 * unit test rather than a network call.
 */

import { FAMILIES } from "../workflows/types.ts";
import { htmlToText } from "./html.ts";

// --------------------------------------------------------------------- urls

export interface ModelRef {
  /** Which source the input named, when it named one. */
  site: "civitai" | "archive" | null;
  model_id: number | null;
  model_version_id: number | null;
  image_id: number | null;
  sha256: string | null;
}

export class CivitaiUrlError extends Error {
  override readonly name = "CivitaiUrlError";
}

const URL_FORMS = [
  "civitai.red/models/<id>[?modelVersionId=<v>]",
  "civitai.com/models/<id>[?modelVersionId=<v>]",
  "civitai.red/images/<id>",
  "civitaiarchive.com/models/<id>?modelVersionId=<v>",
  "civitaiarchive.com/sha256/<hash>",
  "civitai.com/api/download/models/<v>",
];

/**
 * Parsed, never fetched as a page. A `.com` link is honoured and then looked
 * up through the `.red` API, because they are the same database and only the
 * default visibility filter differs (§4.0).
 */
export function parseModelUrl(input: string): ModelRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CivitaiUrlError(
      `--url: not a URL: "${input}"\nexpected one of:\n  ${
        URL_FORMS.join("\n  ")
      }`,
    );
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const site = host === "civitaiarchive.com" || host === "civarchive.com"
    ? "archive" as const
    : host === "civitai.com" || host === "civitai.red"
    ? "civitai" as const
    : null;
  if (site === null) {
    throw new CivitaiUrlError(
      `--url: "${host}" is not a host this understands\nexpected one of:\n  ${
        URL_FORMS.join("\n  ")
      }`,
    );
  }

  const empty: ModelRef = {
    site,
    model_id: null,
    model_version_id: null,
    image_id: null,
    sha256: null,
  };
  const version = numeric(url.searchParams.get("modelVersionId"));

  // civitai.com/api/download/models/<versionId>
  if (parts[0] === "api" && parts[2] === "models" && parts[3] !== undefined) {
    const id = numeric(parts[3]);
    if (id !== null) return { ...empty, model_version_id: id };
  }
  if (parts[0] === "sha256" && parts[1] !== undefined) {
    const hash = normalizeHash(parts[1]);
    if (hash !== null) return { ...empty, sha256: hash };
  }
  if (parts[0] === "models" && parts[1] !== undefined) {
    const id = numeric(parts[1]);
    if (id !== null) {
      return { ...empty, model_id: id, model_version_id: version };
    }
  }
  if (parts[0] === "images" && parts[1] !== undefined) {
    const id = numeric(parts[1]);
    if (id !== null) return { ...empty, image_id: id };
  }
  throw new CivitaiUrlError(
    `--url: nothing in "${input}" names a model\nexpected one of:\n  ${
      URL_FORMS.join("\n  ")
    }`,
  );
}

function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Lower-case, and only when it is actually 64 hex characters. */
export function normalizeHash(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

// ------------------------------------------------------------ the mappings

/**
 * `baseModel` onto §8.1's hardcoded family list. A `baseModel` with no entry
 * leaves the family alone rather than inventing one: the header probe's answer
 * is better than a wrong guess, and `unset` is better than either.
 */
const BASE_MODEL_FAMILIES: [RegExp, string][] = [
  [/^sd\s*1\.[45]/i, "sd15"],
  [/^sd\s*1\b/i, "sd15"],
  [/^sdxl/i, "sdxl"],
  [/^pony/i, "sdxl"],
  [/^illustrious/i, "sdxl"],
  [/^noobai/i, "sdxl"],
  [/^flux\.?\s*2/i, "flux2"],
  [/^flux/i, "flux"],
  [/^chroma/i, "chroma"],
  [/^chroma/i, "chroma"],
  [/^ltxv?\s*2/i, "ltx-2"],
  [/^ltx/i, "ltx"],
  [/^z[\s-]?image/i, "z-image"],
  [/^wan/i, "wan2"],
  [/^qwen/i, "qwen-image"],
  [/^aura/i, "other"],
];

export function familyOf(baseModel: string | null | undefined): string | null {
  if (!baseModel) return null;
  for (const [pattern, family] of BASE_MODEL_FAMILIES) {
    if (!pattern.test(baseModel.trim())) continue;
    return (FAMILIES as readonly string[]).includes(family) ? family : null;
  }
  return null;
}

/**
 * Civitai's model `type` onto a ForgeUI kind, which is the folder a
 * downloaded file is filed under (§7.2). An unmapped type files under
 * `other`, which is scanned like every other kind — a model in the wrong
 * drawer is a nuisance, a refused download is worse.
 */
const TYPE_KINDS: Record<string, string> = {
  checkpoint: "checkpoints",
  lora: "loras",
  locon: "loras",
  lycoris: "loras",
  dora: "loras",
  textualinversion: "embeddings",
  embedding: "embeddings",
  vae: "vae",
  controlnet: "controlnet",
  upscaler: "upscale_models",
  motionmodule: "other",
  wildcards: "other",
  poses: "other",
  other: "other",
};

export function kindOf(type: string | null | undefined): string {
  if (!type) return "other";
  return TYPE_KINDS[type.trim().toLowerCase().replace(/[\s_-]/g, "")] ??
    "other";
}

/**
 * `trainedWords` needs cleaning before anyone can trust it. It lives on the
 * *version* rather than the model, and comes in three shapes in the wild:
 *
 *     ["shuimobysim", "wuchangshuo"]                    a clean list
 *     ["abstractionism, brush stroke, traditional, "]   one comma-separated string
 *     []                                                very common
 */
export function normalizeTriggerWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    for (const part of entry.split(",")) {
      const word = part.trim();
      if (word.length === 0) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
  }
  return out;
}

/**
 * Which query parameter widens a lookup is **not uniform across endpoints**
 * (§4.0), which is the kind of thing that costs an afternoon if it is not
 * written down:
 *
 * | endpoint        | what widens it                                     |
 * | --------------- | -------------------------------------------------- |
 * | `/images`       | `browsingLevel` or `nsfw`                          |
 * | `/models`       | `nsfw` only — `browsingLevel` is a 400 (`ZodError`)|
 * | `/model-versions/by-hash` | neither                                  |
 *
 * One setting behind all three, translated here, so no call site gets to be
 * wrong about it on its own.
 */
export type CivitaiEndpoint = "images" | "models" | "by-hash";

export function visibilityParams(
  endpoint: CivitaiEndpoint,
  browsingLevel: number,
): Record<string, string> {
  switch (endpoint) {
    case "images":
      return { browsingLevel: String(browsingLevel) };
    case "models":
      // `browsingLevel=31` is rejected here; `nsfw=true` is what widens it.
      return browsingLevel > 1 ? { nsfw: "true" } : {};
    case "by-hash":
      return {};
  }
}

// ------------------------------------------------------- the source record

/** §5.5. What we keep of what Civitai knows, normalised once, at ingest. */
export interface SourceRecord {
  format: 1;
  source: {
    kind: "civitai" | "civitai-archive";
    label: string;
    url: string;
    model_id: number | null;
    model_version_id: number | null;
    fetched_at: string;
  };
  creator: { username: string; url: string | null } | null;
  model: {
    name: string | null;
    type: string | null;
    tags: string[];
    description_html: string | null;
    description_text: string | null;
  };
  version: {
    name: string | null;
    base_model: string | null;
    published_at: string | null;
    description_html: string | null;
    description_text: string | null;
  };
  trigger_words: string[];
  license: Record<string, unknown> | null;
  stats: Record<string, unknown> | null;
}

/** What ingest applies, next to the record it came from. */
export interface LookupResult {
  sha256: string | null;
  filename: string | null;
  kind: string;
  display_name: string | null;
  family: string | null;
  tags: string[];
  trigger_words: string[];
  record: SourceRecord;
  /** Every file the version ships, for `--download-model`. */
  files: {
    name: string;
    sha256: string | null;
    size: number | null;
    download_url: string | null;
    primary: boolean;
  }[];
  /** The images posted with the version, newest first. */
  images: {
    id: number | null;
    url: string;
    width: number | null;
    height: number | null;
    kind: "image" | "video";
    nsfw_level: number;
    page_url: string | null;
    meta: Record<string, unknown> | null;
  }[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "string" ? entry : text(record(entry)?.name) ?? null
    )
    .filter((entry): entry is string => entry !== null);
}

function describe(html: unknown): {
  description_html: string | null;
  description_text: string | null;
} {
  const source = text(html);
  return {
    description_html: source,
    description_text: source === null ? null : htmlToText(source) || null,
  };
}

/**
 * Civitai's `/models/<id>` plus one of its versions, into §5.5's record.
 * `version` is the one the lookup landed on; without it the newest is used,
 * which is what a bare `/models/<id>` link means.
 */
export function sourceRecordFromCivitai(options: {
  model: Record<string, unknown>;
  version: Record<string, unknown> | null;
  baseUrl: string;
  fetchedAt: Date;
}): LookupResult {
  const { model } = options;
  const versions = Array.isArray(model.modelVersions)
    ? model.modelVersions
    : [];
  const version = options.version ?? record(versions[0]) ?? {};
  const modelId = typeof model.id === "number" ? model.id : null;
  const versionId = typeof version.id === "number" ? version.id : null;
  const creator = record(model.creator);
  const creatorName = text(creator?.username);
  const tags = stringList(model.tags);
  const triggerWords = normalizeTriggerWords(version.trainedWords);
  const baseModel = text(version.baseModel);

  const url = modelId === null
    ? options.baseUrl
    : `${options.baseUrl}/models/${modelId}${
      versionId === null ? "" : `?modelVersionId=${versionId}`
    }`;

  const files = (Array.isArray(version.files) ? version.files : [])
    .map((entry) => {
      const file = record(entry);
      if (file === null) return null;
      const hashes = record(file.hashes);
      const sha = text(hashes?.SHA256) ?? text(file.sha256);
      const sizeKb = typeof file.sizeKB === "number" ? file.sizeKB : null;
      return {
        name: text(file.name) ?? "model.safetensors",
        sha256: sha === null ? null : sha.toLowerCase(),
        size: sizeKb === null ? null : Math.round(sizeKb * 1024),
        download_url: text(file.downloadUrl),
        primary: file.primary === true || file.is_primary === true,
      };
    })
    .filter((file): file is NonNullable<typeof file> => file !== null);

  const images = (Array.isArray(version.images) ? version.images : [])
    .map((entry) => {
      const image = record(entry);
      const source = text(image?.url);
      if (image === null || source === null) return null;
      const id = typeof image.id === "number" ? image.id : null;
      return {
        id,
        url: source,
        width: typeof image.width === "number" ? image.width : null,
        height: typeof image.height === "number" ? image.height : null,
        kind: image.type === "video" ? "video" as const : "image" as const,
        nsfw_level: typeof image.nsfwLevel === "number" ? image.nsfwLevel : 1,
        page_url: id === null ? null : `${options.baseUrl}/images/${id}`,
        meta: record(image.meta),
      };
    })
    .filter((image): image is NonNullable<typeof image> => image !== null);

  const primary = files.find((file) => file.primary) ?? files[0] ?? null;

  return {
    sha256: primary?.sha256 ?? null,
    filename: primary?.name ?? null,
    kind: kindOf(text(model.type)),
    display_name: text(model.name),
    family: familyOf(baseModel),
    tags,
    trigger_words: triggerWords,
    files,
    images,
    record: {
      format: 1,
      source: {
        kind: "civitai",
        label: "Civitai",
        url,
        model_id: modelId,
        model_version_id: versionId,
        fetched_at: isoSeconds(options.fetchedAt),
      },
      creator: creatorName === null ? null : {
        username: creatorName,
        url: `${options.baseUrl}/user/${encodeURIComponent(creatorName)}`,
      },
      model: {
        name: text(model.name),
        type: text(model.type),
        tags,
        ...describe(model.description),
      },
      version: {
        name: text(version.name),
        base_model: baseModel,
        published_at: text(version.publishedAt) ?? text(version.createdAt),
        ...describe(version.description),
      },
      trigger_words: triggerWords,
      license: pick(model, [
        "allowCommercialUse",
        "allowDerivatives",
        "allowNoCredit",
        "allowDifferentLicense",
      ]),
      stats: record(model.stats),
    },
  };
}

/**
 * The archive's `/api/models/<id>?modelVersionId=<v>`, which is a different
 * shape with the same content — and, unlike Civitai, answers for models that
 * have been deleted. What it does not carry is per-image generation data:
 * there is no image endpoint on it, so `meta` is null and the sample arrives
 * with its link, its dimensions, and whatever the file itself says (§4.3).
 */
export function sourceRecordFromArchive(options: {
  model: Record<string, unknown>;
  baseUrl: string;
  fetchedAt: Date;
}): LookupResult {
  const { model } = options;
  const version = record(model.version) ?? {};
  const modelId = typeof model.id === "number" ? model.id : null;
  const versionId = typeof version.id === "number" ? version.id : null;
  const creatorName = text(model.creator_username) ?? text(model.username);
  const tags = stringList(model.tags);
  const triggerWords = normalizeTriggerWords(version.trigger);
  const baseModel = text(version.baseModel);

  const files = (Array.isArray(version.files) ? version.files : [])
    .map((entry) => {
      const file = record(entry);
      if (file === null) return null;
      const sha = text(file.sha256);
      const sizeKb = typeof file.sizeKB === "number" ? file.sizeKB : null;
      return {
        name: text(file.name) ?? "model.safetensors",
        sha256: sha === null ? null : sha.toLowerCase(),
        size: sizeKb === null ? null : Math.round(sizeKb * 1024),
        download_url: text(file.downloadUrl),
        primary: file.is_primary === true,
      };
    })
    .filter((file): file is NonNullable<typeof file> => file !== null);

  const images = (Array.isArray(version.images) ? version.images : [])
    .map((entry) => {
      const image = record(entry);
      const source = text(image?.image_url) ?? text(image?.url);
      if (image === null || source === null) return null;
      return {
        id: typeof image.id === "number" ? image.id : null,
        url: source,
        width: typeof image.width === "number" ? image.width : null,
        height: typeof image.height === "number" ? image.height : null,
        kind: image.type === "video" ? "video" as const : "image" as const,
        nsfw_level: typeof image.nsfwLevel === "number" ? image.nsfwLevel : 1,
        page_url: text(image.link),
        meta: null,
      };
    })
    .filter((image): image is NonNullable<typeof image> => image !== null);

  const primary = files.find((file) => file.primary) ?? files[0] ?? null;
  const url = modelId === null
    ? options.baseUrl
    : `${options.baseUrl}/models/${modelId}${
      versionId === null ? "" : `?modelVersionId=${versionId}`
    }`;

  return {
    sha256: primary?.sha256 ?? null,
    filename: primary?.name ?? null,
    kind: kindOf(text(model.type)),
    display_name: text(model.name),
    family: familyOf(baseModel),
    tags,
    trigger_words: triggerWords,
    files,
    images,
    record: {
      format: 1,
      source: {
        kind: "civitai-archive",
        label: "CivArchive",
        url,
        model_id: modelId,
        model_version_id: versionId,
        fetched_at: isoSeconds(options.fetchedAt),
      },
      creator: creatorName === null ? null : {
        username: creatorName,
        url: text(model.creator_url) === null
          ? null
          : `${options.baseUrl}${model.creator_url}`,
      },
      model: {
        name: text(model.name),
        type: text(model.type),
        tags,
        ...describe(model.description),
      },
      version: {
        name: text(version.name),
        base_model: baseModel,
        published_at: text(version.publishedAt) ?? text(version.createdAt),
        ...describe(version.description),
      },
      trigger_words: triggerWords,
      license: null,
      stats: null,
    },
  };
}

function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Civitai's CDN puts its transform in the path — `width=450,optimized=true`
 * is the card thumbnail. A sample should be the image, not the card.
 */
export function originalImageUrl(url: string): string {
  return url.replace(
    /\/(?:[a-z]+=[^/,]+,)*[a-z]+=[^/,]+\//i,
    (segment) =>
      /(?:width|height|optimized|anim|quality|fit)=/i.test(segment)
        ? "/original=true/"
        : segment,
  );
}
