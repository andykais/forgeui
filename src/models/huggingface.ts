/**
 * What Hugging Face says, in this app's vocabulary (DESIGN-MODEL-IMPORT §4.5).
 *
 * The same split as `civitai.ts`: pure normalisation here, fetching in
 * `src/cli/huggingface_client.ts`. What Hugging Face is for is narrow — a
 * title and a README. It has no sample images, no trigger-word field, and no
 * idea which ComfyUI folder a file belongs in, and whatever the safetensors
 * header says the scan has already read. So the record it produces is the
 * §5.5 shape with most of the Civitai-specific half empty, not a new shape.
 */

import {
  isoSeconds,
  type LookupResult,
  normalizeTriggerWords,
  type SourceRecord,
} from "./civitai.ts";
import { markdownWithoutHtml } from "./html.ts";

export class HuggingFaceUrlError extends Error {
  override readonly name = "HuggingFaceUrlError";
}

/** A repo, and when the link names one, a revision and a file in it. */
export interface HuggingFaceRef {
  repo: string;
  revision: string | null;
  path: string | null;
}

const HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

/** First path segments that are site pages rather than a model's owner. */
const NOT_OWNERS = new Set([
  "api",
  "blog",
  "collections",
  "datasets",
  "docs",
  "join",
  "login",
  "models",
  "organizations",
  "papers",
  "pricing",
  "settings",
  "spaces",
  "tasks",
]);

/**
 * `huggingface.co/<owner>/<repo>`, with `/blob/<rev>/<path>`,
 * `/resolve/<rev>/<path>` or `/tree/<rev>` after it. Null for a URL that is
 * not Hugging Face at all, so the caller can try Civitai's forms; an error for
 * one that is Hugging Face but not a model.
 */
export function parseHuggingFaceUrl(input: string): HuggingFaceRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split("/").filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
  if (parts[0] === "datasets" || parts[0] === "spaces") {
    throw new HuggingFaceUrlError(
      `--url: "${input}" is a Hugging Face ${
        parts[0].slice(0, -1)
      }, not a model`,
    );
  }
  if (parts.length < 2 || NOT_OWNERS.has(parts[0]!)) {
    throw new HuggingFaceUrlError(
      `--url: "${input}" does not name a model repo; expected ` +
        `huggingface.co/<owner>/<repo>, optionally with /blob/<revision>/<file>`,
    );
  }
  const repo = `${parts[0]}/${parts[1]}`;
  const [kind, revision, ...rest] = parts.slice(2);
  if (kind === "blob" || kind === "resolve") {
    if (revision === undefined || rest.length === 0) {
      throw new HuggingFaceUrlError(`--url: "${input}" names no file`);
    }
    return { repo, revision, path: rest.join("/") };
  }
  if (kind === "tree") return { repo, revision: revision ?? null, path: null };
  return { repo, revision: null, path: null };
}

/** The parts of a Hub model this reads. Everything is optional upstream. */
export interface HuggingFaceModel {
  name: string;
  author?: string | null;
  task?: string | null;
  library_name?: string | null;
  tags?: string[];
  cardData?: Record<string, unknown> | null;
  downloads?: number;
  likes?: number;
  gated?: false | "auto" | "manual";
  updatedAt?: string | Date | null;
  sha?: string | null;
}

/** Weight files, as opposed to configs, tokenizers and pictures. */
export const WEIGHT_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i;

function list(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" && entry.trim().length > 0
  );
}

/**
 * Which ForgeUI kind a file is, which only matters for where a download is
 * filed (§7.2). Hugging Face does not say, so this reads the tags and the
 * path and falls back to `other`, which is scanned like every other kind —
 * the same bargain as Civitai's unmapped types.
 */
export function kindFromHuggingFace(
  path: string,
  tags: readonly string[],
  task: string | null | undefined,
): string {
  const lower = path.toLowerCase();
  const file = lower.split("/").pop() ?? lower;
  const dir = lower.includes("/") ? lower.split("/")[0]! : "";
  const tagged = new Set(tags.map((tag) => tag.toLowerCase()));

  if (tagged.has("lora") || /lora/.test(file)) return "loras";
  if (tagged.has("controlnet") || /controlnet/.test(file)) return "controlnet";
  if (tagged.has("textual_inversion")) return "embeddings";
  if (dir === "vae" || /(^|[_\-.])vae([_\-.]|$)/.test(file)) return "vae";
  if (dir.startsWith("text_encoder")) return "text_encoders";
  if (/esrgan|upscal/.test(lower)) return "upscale_models";
  if (
    task === "text-to-image" || task === "image-to-image" ||
    task === "text-to-video" || task === "image-to-video"
  ) {
    return "checkpoints";
  }
  return "other";
}

/**
 * Hub repo ids onto §8.1's families. Only the declared `base_model` is read
 * first; the repo's own id is read when it declares none, which is what a
 * base model's own repo looks like (`stabilityai/sdxl-turbo`). Anything else
 * stays unset, and the header probe's answer stands.
 */
const REPO_FAMILIES: [RegExp, string][] = [
  [/stable-diffusion-v1-[45]|stable-diffusion-v1\b|\bsd-?1\.?5\b/i, "sd15"],
  [/stable-diffusion-xl|\bsdxl\b|sdxl[-_]/i, "sdxl"],
  [/flux\.?-?2/i, "flux2"],
  [/flux/i, "flux"],
  [/chroma/i, "chroma"],
  [/ltx-?2/i, "ltx-2"],
  [/ltx/i, "ltx"],
  [/z-?image/i, "z-image"],
  [/wan-?2|\bwan\b/i, "wan2"],
  [/qwen-?image/i, "qwen-image"],
];

export function familyFromHuggingFace(
  repo: string,
  baseModels: readonly string[],
): string | null {
  for (const candidate of baseModels.length > 0 ? baseModels : [repo]) {
    for (const [pattern, family] of REPO_FAMILIES) {
      if (pattern.test(candidate)) return family;
    }
  }
  return null;
}

/** The YAML block at the top of a model card, which `cardData` already is. */
function withoutFrontMatter(readme: string): string {
  return readme.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A path relative to `from` in the repo, or null when it climbs out. */
function repoPath(from: string, target: string): string | null {
  const [path] = target.split(/[?#]/);
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const raw of path!.split("/")) {
    // Decoded here and encoded once on the way out, so `a%20b` stays that.
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else base.push(part);
  }
  return base.length === 0 ? null : base.join("/");
}

/** The card as the page shows it: Markdown, without HTML or dead links. */
export function readmeMarkdown(options: {
  readme: string;
  repo: string;
  revision: string;
  baseUrl: string;
}): string | null {
  const { repo, revision, baseUrl } = options;
  const text = markdownWithoutHtml(
    withoutFrontMatter(options.readme),
    (target, image) => {
      const path = repoPath("README.md", target);
      if (path === null) return null;
      // An image is the file itself; a link is the page that shows it.
      return `${baseUrl}/${repo}/${image ? "resolve" : "blob"}/${
        encodeURIComponent(revision)
      }/${encodePath(path)}`;
    },
  );
  return text.length > 0 ? text : null;
}

/**
 * One file in one repo, into §5.5's record. `file` is the file the lookup is
 * about — the batch is named after its hash, as every lookup's is (§4.1).
 */
export function sourceRecordFromHuggingFace(options: {
  info: HuggingFaceModel;
  readme: string | null;
  file: { path: string; sha256: string; size: number | null };
  revision: string;
  baseUrl: string;
  fetchedAt: Date;
}): LookupResult {
  const { info, file, baseUrl } = options;
  const repo = info.name;
  const card = info.cardData ?? {};
  const allTags = info.tags ?? [];
  // `license:other`, `region:us`, `base_model:…` are index keys, not tags
  // anyone chose; the ones worth showing have no colon.
  const seen = new Set<string>();
  const tags = allTags.filter((tag) => {
    const key = tag.toLowerCase();
    if (tag.includes(":") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const baseModels = list(card.base_model);
  const triggerWords = normalizeTriggerWords(list(card.instance_prompt));
  const description = options.readme === null ? null : readmeMarkdown({
    readme: options.readme,
    repo,
    revision: options.revision,
    baseUrl,
  });
  const updated = info.updatedAt instanceof Date
    ? info.updatedAt.toISOString()
    : typeof info.updatedAt === "string"
    ? info.updatedAt
    : null;
  const author = info.author ?? repo.split("/")[0] ?? null;
  const filename = file.path.split("/").pop()!;

  const license = typeof card.license === "string"
    ? {
      license: card.license,
      ...(typeof card.license_name === "string"
        ? { license_name: card.license_name }
        : {}),
      ...(typeof card.license_link === "string"
        ? { license_link: card.license_link }
        : {}),
    }
    : null;

  const record: SourceRecord = {
    format: 1,
    source: {
      kind: "huggingface",
      label: "Hugging Face",
      url: `${baseUrl}/${repo}`,
      model_id: null,
      model_version_id: null,
      fetched_at: isoSeconds(options.fetchedAt),
      repo,
      revision: info.sha ?? options.revision,
      path: file.path,
    },
    creator: author === null
      ? null
      : { username: author, url: `${baseUrl}/${encodeURIComponent(author)}` },
    model: {
      name: repo,
      type: info.task ?? null,
      tags,
      description_html: null,
      description_text: description,
    },
    version: {
      name: null,
      base_model: baseModels[0] ?? null,
      published_at: updated,
      description_html: null,
      description_text: null,
    },
    trigger_words: triggerWords,
    license,
    stats: {
      ...(typeof info.downloads === "number"
        ? { downloads: info.downloads }
        : {}),
      ...(typeof info.likes === "number" ? { likes: info.likes } : {}),
    },
  };

  return {
    sha256: file.sha256,
    filename,
    kind: kindFromHuggingFace(file.path, allTags, info.task),
    display_name: repo.split("/").pop() ?? repo,
    family: familyFromHuggingFace(repo, baseModels),
    tags,
    trigger_words: triggerWords,
    record,
    files: [{
      name: filename,
      sha256: file.sha256,
      size: file.size,
      download_url: `${baseUrl}/${repo}/resolve/${
        encodeURIComponent(options.revision)
      }/${encodePath(file.path)}`,
      primary: true,
    }],
    // Hugging Face has no sample images. A card's pictures are decoration,
    // and link-only on the page like every other description image.
    images: [],
  };
}
