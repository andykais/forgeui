/**
 * What Tensor.Art says, in this app's vocabulary (DESIGN-MODEL-IMPORT §4.6).
 *
 * Tensor.Art itself cannot be asked: its site sits behind Cloudflare's
 * browser challenge, and its web API rejects any request without the site's
 * own request signature — even one for a path that does not exist. What can
 * be asked is **CivArchive's mirror** of it: every Tensor.Art model it has
 * seen has a page at `/tensorart/models/<id>/versions/<vid>`, server-rendered
 * with its data embedded as `__NEXT_DATA__` — description, creator, base
 * model, trigger words, tags, showcase images, and the files with their
 * sha256 and the public copies of the same bytes elsewhere.
 *
 * Tensor.Art ids are 18-digit numbers, past what a JavaScript number holds
 * exactly (765307161749456877 parses as …900). The archive writes them as
 * strings and they stay strings here, all the way into the source record.
 *
 * Pure normalisation, as `civitai.ts` and `huggingface.ts` are: the fetching
 * is in `src/cli/civitai_client.ts`, which already talks to the archive.
 */

import {
  familyOf,
  isoSeconds,
  kindOf,
  type LookupResult,
  normalizeHash,
  normalizeTriggerWords,
  type SourceRecord,
} from "./civitai.ts";
import { htmlToText } from "./html.ts";

export class TensorArtUrlError extends Error {
  override readonly name = "TensorArtUrlError";
}

/** A Tensor.Art model, and the version when the link names one. */
export interface TensorArtRef {
  model_id: string;
  version_id: string | null;
}

const HOSTS = new Set(["tensor.art", "www.tensor.art"]);

/**
 * `tensor.art/models/<id>`, optionally `/<versionId>` after it, or the
 * archive's `/tensorart/models/<id>/versions/<vid>` for the same thing. Null
 * for a link that is neither, so the caller tries the other sites' forms.
 */
export function parseTensorArtUrl(input: string): TensorArtRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const id = (value: string | undefined) =>
    value !== undefined && /^\d{6,}$/.test(value) ? value : null;

  if (HOSTS.has(host)) {
    if (parts[0] !== "models") {
      throw new TensorArtUrlError(
        `--url: "${input}" is a Tensor.Art page, but not a model; expected ` +
          `tensor.art/models/<id>`,
      );
    }
    const model = id(parts[1]);
    if (model === null) {
      throw new TensorArtUrlError(`--url: "${input}" names no model id`);
    }
    // A second segment is a version id when it is one, and a slug otherwise.
    return { model_id: model, version_id: id(parts[2]) };
  }

  const archive = host === "civitaiarchive.com" || host === "civarchive.com" ||
    host.endsWith(".civitaiarchive.com");
  if (archive && parts[0] === "tensorart" && parts[1] === "models") {
    const model = id(parts[2]);
    if (model === null) return null;
    return {
      model_id: model,
      version_id: parts[3] === "versions" ? id(parts[4]) : null,
    };
  }
  return null;
}

/** The archive's page for a Tensor.Art model, as a path on its host. */
export function archivePagePath(ref: TensorArtRef): string {
  return ref.version_id === null
    ? `/tensorart/models/${ref.model_id}`
    : `/tensorart/models/${ref.model_id}/versions/${ref.version_id}`;
}

export function tensorArtModelUrl(modelId: string): string {
  return `https://tensor.art/models/${modelId}`;
}

/**
 * The model a server-rendered archive page carries, from its
 * `__NEXT_DATA__`. Null when the page is not one of those — an error page,
 * a redesign — which the caller reports rather than guesses around.
 */
export function pageModel(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const model = record(record(record(data)?.props)?.pageProps)?.model;
  const found = record(model);
  return found !== null && found.platform === "tensorart" ? found : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry) => entry !== null)
    : [];
}

/** A string id, whatever JSON it came in — never through a number. */
function idOf(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
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
 * Where the same bytes can be fetched without Tensor.Art's login: the public
 * copies the archive lists for a file, best first. A Civitai download that
 * is not deleted, gated or paid, then a Hugging Face `resolve` URL; an
 * archive-relative path is not a download. The
 * download is checked against the sha256 either way (§7.2).
 */
export function publicCopy(
  file: Record<string, unknown>,
): { url: string; via: "civitai" | "huggingface" } | null {
  const mirrors = records(file.mirrors).filter((mirror) =>
    typeof mirror.url === "string" && /^https?:\/\//.test(mirror.url) &&
    mirror.is_gated !== true && mirror.is_paid !== true &&
    (mirror.deleted_at ?? mirror.deletedAt ?? null) === null
  );
  const civitai = mirrors.find((mirror) => mirror.source === "civitai");
  const hub = mirrors.find((mirror) =>
    mirror.source === "huggingface" &&
    /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\//.test(
      String(mirror.url),
    )
  );
  if (civitai) return { url: String(civitai.url), via: "civitai" };
  if (hub) return { url: String(hub.url), via: "huggingface" };
  return null;
}

/**
 * The archive's copy of a Tensor.Art model version into §5.5's record.
 * `hash`, when the lookup was by one, picks the file the batch is about;
 * otherwise the version's first file is.
 */
export function sourceRecordFromTensorArt(options: {
  model: Record<string, unknown>;
  hash?: string | null;
  fetchedAt: Date;
}): LookupResult {
  const { model } = options;
  const version = record(model.version) ?? {};
  const modelId = idOf(model.id);
  const versionId = idOf(version.id);
  const creatorName = text(model.creator_name) ?? text(model.username);
  const creatorId = idOf(model.creator_id);
  const tags = (Array.isArray(model.tags) ? model.tags : [])
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  const triggerWords = normalizeTriggerWords(version.trigger);
  const baseModel = text(version.base_model);
  const pageUrl = text(version.platform_url) ??
    (modelId === null ? "https://tensor.art" : tensorArtModelUrl(modelId));

  const files = records(version.files).map((file) => {
    const sha = normalizeHash(String(file.sha256 ?? ""));
    const sizeKb = typeof file.size_kb === "number" ? file.size_kb : null;
    // Not Tensor.Art's own download, which needs a logged-in browser: a
    // public copy of the same bytes, when the archive knows one.
    const copy = publicCopy(file);
    return {
      name: text(file.name) ?? "model.safetensors",
      sha256: sha,
      size: sizeKb === null ? null : Math.round(sizeKb * 1024),
      download_url: copy?.url ?? null,
      primary: false,
      ...(copy === null ? {} : { download_via: copy.via }),
    };
  });
  const wanted = options.hash
    ? files.find((file) => file.sha256 === options.hash)
    : undefined;
  const primary = wanted ?? files.find((file) => file.sha256 !== null) ??
    files[0] ?? null;
  if (primary) primary.primary = true;

  const images = records(version.images)
    .map((image) => {
      const url = text(image.url);
      if (url === null) return null;
      return {
        id: null,
        url,
        width: typeof image.width === "number" ? image.width : null,
        height: typeof image.height === "number" ? image.height : null,
        kind: image.type === "video" ? "video" as const : "image" as const,
        nsfw_level: typeof image.nsfwLevel === "number"
          ? image.nsfwLevel
          : model.is_nsfw === true
          ? 8
          : 1,
        // Tensor.Art's showcase images have no page of their own; the model's
        // is the nearest thing to one.
        page_url: pageUrl,
        meta: null,
      };
    })
    .filter((image) => image !== null);

  const record_: SourceRecord = {
    format: 1,
    source: {
      kind: "tensorart",
      label: "Tensor.Art",
      url: pageUrl,
      model_id: null,
      model_version_id: null,
      fetched_at: isoSeconds(options.fetchedAt),
      tensorart_model_id: modelId ?? undefined,
      tensorart_version_id: versionId ?? undefined,
    },
    creator: creatorName === null ? null : {
      username: creatorName,
      url: creatorId === null ? null : `https://tensor.art/u/${creatorId}`,
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
      published_at: text(version.created_at) ?? text(model.created_at),
      ...describe(version.description),
    },
    trigger_words: triggerWords,
    license: null,
    stats: {
      ...(typeof version.download_count === "number"
        ? { downloads: version.download_count }
        : {}),
      ...(typeof version.favorite_count === "number"
        ? { favorites: version.favorite_count }
        : {}),
    },
  };

  return {
    sha256: primary?.sha256 ?? null,
    filename: primary?.name ?? null,
    kind: kindOf(text(model.type)),
    display_name: text(model.name),
    family: familyOf(baseModel),
    tags,
    trigger_words: triggerWords,
    record: record_,
    files,
    images,
  };
}
