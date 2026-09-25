/**
 * `forge models` (DESIGN-MODEL-IMPORT §3, §4, §5).
 *
 * Resolves a model, fetches what it can, and writes a batch into the import
 * folder. It writes files and nothing else: it never opens `app.db`, never
 * talks to the running server, and never touches a folder `config.yaml`
 * names. What the app does with the batch afterwards is `src/models/import.ts`.
 *
 * The invariant worth stating, because a test asserts it: **nothing in this
 * file or anything it imports opens the database.**
 */

import { basename, extname, join } from "@std/path";
import { ulid } from "@std/ulid";
import type { Config } from "../config/types.ts";
import type { DataPaths } from "../config/paths.ts";
import {
  type LookupResult,
  normalizeHash,
  originalImageUrl,
  parseModelUrl,
} from "../models/civitai.ts";
import type {
  ImportBatch,
  ImportFile,
  ImportSample,
} from "../models/import.ts";
import { IMPORT_FORMAT } from "../models/import.ts";
import { parseCivitaiMeta, readInfotext } from "../media/infotext.ts";
import { sha256Hex } from "../workflows/hash.ts";
import {
  CivitaiClient,
  LookupError,
  type LookupSource,
} from "./civitai_client.ts";

export { LookupError };

export interface ModelsCommandOptions {
  url?: string;
  filename?: string;
  sha256checksum?: string;
  source: LookupSource;
  downloadSamples: number;
  downloadModel: boolean;
  overwrite: boolean;
  dryRun: boolean;
  browsingLevel?: number;
  timeoutMs: number;
}

export interface ModelsCommandResult {
  /** Where the batch landed, or would have with `--dry-run`. */
  dir: string;
  batch: ImportBatch;
  samples: number;
  skipped: number;
  files: number;
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Exactly one of the three says which model. Checked here rather than left to
 * cliffy's conflict rules so the message can say what to do instead.
 */
export function requireOneIdentifier(options: ModelsCommandOptions): void {
  const given = [
    options.url !== undefined ? "--url" : null,
    options.filename !== undefined ? "--filename" : null,
    options.sha256checksum !== undefined ? "--sha256checksum" : null,
  ].filter((flag): flag is string => flag !== null);
  if (given.length === 1) return;
  throw new UsageError(
    given.length === 0
      ? "say which model: one of --url, --filename or --sha256checksum"
      : `${given.join(" and ")} both name a model; pass exactly one`,
  );
}

export interface RunModelsOptions extends ModelsCommandOptions {
  config: Config;
  paths: DataPaths;
  client?: CivitaiClient;
  log?: (line: string) => void;
}

export async function runModels(
  options: RunModelsOptions,
): Promise<ModelsCommandResult> {
  requireOneIdentifier(options);
  const settings = options.config.import;
  const say = options.log ?? ((line: string) => console.log(line));
  const client = options.client ?? new CivitaiClient({
    civitaiUrl: settings.civitai_url,
    archiveUrl: settings.archive_url,
    browsingLevel: options.browsingLevel ?? settings.browsing_level,
    timeoutMs: options.timeoutMs,
  });

  const found = await resolve(options, client, say);
  if (found.sha256 === null) {
    throw new LookupError(
      "the model was found but carries no sha256, so nothing could be " +
        "matched to a file on disk",
    );
  }

  const batch: ImportBatch = {
    format: IMPORT_FORMAT,
    forgecli_version: "0.1.0",
    created_at: isoSeconds(new Date()),
    overwrite: options.overwrite,
    model: {
      sha256: found.sha256,
      filename: found.filename,
      kind: found.kind,
      display_name: found.display_name,
      family: found.family,
      tags: found.tags,
      notes: notesFrom(found),
      trigger_words: found.trigger_words,
    },
    source: found.record.source as unknown as Record<string, unknown>,
    civitai: found.record as unknown as Record<string, unknown>,
    samples: [],
  };

  const dir = join(options.paths.imports, found.sha256);
  const result: ModelsCommandResult = {
    dir,
    batch,
    samples: 0,
    skipped: 0,
    files: 0,
  };

  if (options.dryRun) {
    say(`would write ${dir}`);
    say(`  ${found.display_name ?? found.filename ?? found.sha256}`);
    if (options.downloadSamples > 0) {
      say(`  up to ${options.downloadSamples} samples`);
    }
    if (options.downloadModel) say(`  the weights`);
    return result;
  }

  // Written into `.staging/` and renamed into place, so the app either sees a
  // complete batch or sees nothing: no lock, no handshake, no half-read JSON.
  const staging = join(options.paths.imports, ".staging", ulid());
  await Deno.mkdir(staging, { recursive: true });
  try {
    if (options.downloadSamples > 0) {
      const { samples, skipped } = await fetchSamples({
        client,
        found,
        staging,
        limit: options.downloadSamples,
        nsfwLevel: settings.nsfw_level,
        say,
      });
      batch.samples = samples;
      result.samples = samples.length;
      result.skipped = skipped;
    }

    if (options.downloadModel) {
      const files = await fetchWeights({
        found,
        staging,
        cli: settings.civitai_cli,
        overwrite: options.overwrite,
        say,
      });
      batch.files = files;
      result.files = files.length;
    }

    await Deno.writeTextFile(
      join(staging, "model.json"),
      `${JSON.stringify(batch, null, 2)}\n`,
    );

    // An existing batch for the same model is replaced: it is the same
    // question asked again, and two answers to it would collide on ingest.
    await Deno.mkdir(options.paths.imports, { recursive: true });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.rename(staging, dir);
  } catch (cause) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw cause;
  }

  say(`wrote ${dir}`);
  return result;
}

// ------------------------------------------------------------------ lookup

async function resolve(
  options: RunModelsOptions,
  client: CivitaiClient,
  say: (line: string) => void,
): Promise<LookupResult> {
  if (options.sha256checksum !== undefined) {
    return await client.byHash(options.sha256checksum, options.source);
  }

  if (options.filename !== undefined) {
    // Resolved locally first: an exact hash beats every name-based search,
    // and the answer is about *your* file rather than one with the same name.
    const path = await findModelFile(options.config, options.filename);
    if (path !== null) {
      say(`hashing ${path}`);
      const hash = await sha256Hex(await Deno.readFile(path));
      return await client.byHash(hash, options.source);
    }
    say(`no file named "${options.filename}" in the configured folders`);
    return await client.byFilename(options.filename);
  }

  const ref = parseModelUrl(options.url!);
  // A URL that names a site is asked there first; `--source` still wins.
  const source: LookupSource = options.source !== "auto"
    ? options.source
    : ref.site === "archive"
    ? "archive"
    : "auto";

  if (ref.sha256 !== null) return await client.byHash(ref.sha256, source);
  if (ref.image_id !== null) {
    return await client.byImageId(ref.image_id, source);
  }
  if (ref.model_id !== null) {
    return await client.byModelId(ref.model_id, ref.model_version_id, source);
  }
  if (ref.model_version_id !== null) {
    return await client.byVersionId(ref.model_version_id, source);
  }
  throw new LookupError(`nothing in "${options.url}" names a model`);
}

/** The configured model folders, walked for a basename match (§4.1). */
export async function findModelFile(
  config: Config,
  filename: string,
): Promise<string | null> {
  const wanted = basename(filename);
  for (const folders of Object.values(config.model_folders)) {
    for (const folder of folders) {
      const found = await walkFor(folder, wanted, 0);
      if (found !== null) return found;
    }
  }
  return null;
}

async function walkFor(
  root: string,
  wanted: string,
  depth: number,
): Promise<string | null> {
  if (depth > 4) return null;
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch {
    return null; // a folder that is missing or unreadable holds nothing
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile && entry.name === wanted) return path;
    if (entry.isDirectory) {
      const found = await walkFor(path, wanted, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

// ----------------------------------------------------------------- samples

async function fetchSamples(input: {
  client: CivitaiClient;
  found: LookupResult;
  staging: string;
  limit: number;
  nsfwLevel: number;
  say: (line: string) => void;
}): Promise<{ samples: ImportSample[]; skipped: number }> {
  const { client, found, staging, limit, nsfwLevel, say } = input;
  const versionId = found.record.source.model_version_id;

  // The lookup's own images carry dimensions and links; the images endpoint
  // carries `meta`. Where both exist, they are joined on the image id.
  let listed: Record<string, unknown>[] = [];
  if (found.record.source.kind === "civitai" && versionId !== null) {
    try {
      listed = await client.imagesFor(versionId, limit);
    } catch (cause) {
      // The archive path has no images endpoint at all, and a failure here
      // costs metadata rather than the batch.
      say(
        `could not read the generation data: ${
          cause instanceof Error ? cause.message : cause
        }`,
      );
    }
  }
  /**
   * The images endpoint is preferred where it answered, because the version
   * object's own images carry **no `id`** — checked against the live API —
   * and without an id there is no page to link a sample back to. The embedded
   * ones are the fallback, which is the archive's path and the path where the
   * endpoint failed.
   */
  const candidates = listed.length > 0
    ? listed.map((image) => ({
      id: typeof image.id === "number" ? image.id : null,
      url: String(image.url ?? ""),
      width: typeof image.width === "number" ? image.width : null,
      height: typeof image.height === "number" ? image.height : null,
      kind: image.type === "video" ? "video" as const : "image" as const,
      nsfw_level: typeof image.nsfwLevel === "number" ? image.nsfwLevel : 1,
      page_url: typeof image.id === "number"
        ? `${client.civitaiUrl}/images/${image.id}`
        : null,
      meta: (image.meta ?? null) as Record<string, unknown> | null,
    }))
    : found.images;

  const samples: ImportSample[] = [];
  let skipped = 0;
  let index = 0;
  for (const image of candidates) {
    if (samples.length >= limit) break;
    if (image.url.length === 0) continue;
    // ForgeUI's own ceiling, separate from what the lookup was allowed to
    // see: ask broadly, file narrowly (§4.3).
    if (image.nsfw_level > nsfwLevel) {
      skipped++;
      continue;
    }

    const url = originalImageUrl(image.url);
    let bytes: Uint8Array;
    try {
      bytes = await client.download(url);
    } catch (cause) {
      say(
        `skipped an image: ${cause instanceof Error ? cause.message : cause}`,
      );
      skipped++;
      continue;
    }

    const name = `${String(++index).padStart(4, "0")}${
      extensionFor(url, image.kind)
    }`;
    await Deno.mkdir(join(staging, "samples"), { recursive: true });
    await Deno.writeFile(join(staging, "samples", name), bytes);

    // The API's `meta` where there is one; the file's own infotext otherwise.
    // The archive has neither, which is why a sample from it arrives with its
    // link and its dimensions and nothing else (§4.3).
    const raw = image.meta && Object.keys(image.meta).length > 0
      ? parseCivitaiMeta(image.meta)
      : readInfotext(bytes);

    samples.push({
      file: `samples/${name}`,
      kind: image.kind,
      width: image.width,
      height: image.height,
      source: {
        kind: found.record.source.kind,
        label: found.record.source.label,
        url: image.page_url ?? url,
        imported_at: null,
      },
      raw: raw.format === "unknown" ? null : raw,
    });
  }

  say(
    `fetched ${samples.length} sample${samples.length === 1 ? "" : "s"}${
      skipped > 0 ? `, skipped ${skipped}` : ""
    }`,
  );
  return { samples, skipped };
}

function extensionFor(url: string, kind: "image" | "video"): string {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (/^\.(png|jpe?g|webp|gif|mp4|webm)$/.test(ext)) return ext;
  return kind === "video" ? ".mp4" : ".jpeg";
}

// ----------------------------------------------------------------- weights

/**
 * The one part that needs a login, and the one part the official CLI still
 * owns: device login, token storage, and a resumable transfer verified
 * against the file's SHA256 (§4.0). The bytes land in the batch; the app
 * files them (§7.2).
 */
async function fetchWeights(input: {
  found: LookupResult;
  staging: string;
  cli: string | null;
  overwrite: boolean;
  say: (line: string) => void;
}): Promise<ImportFile[]> {
  const { found, staging, cli, say } = input;
  if (cli === null) {
    throw new UsageError(
      "--download-model needs the Civitai CLI, and import.civitai_cli is null",
    );
  }
  const versionId = found.record.source.model_version_id;
  if (versionId === null) {
    throw new LookupError(
      "--download-model needs a model version id, and this lookup found none",
    );
  }

  const into = join(staging, "model");
  await Deno.mkdir(into, { recursive: true });
  say(`downloading the weights with ${cli}…`);

  const command = new Deno.Command(cli, {
    args: ["download", String(versionId), "--output", into],
    stdout: "inherit",
    stderr: "inherit",
  });
  let status: Deno.CommandStatus;
  try {
    status = await command.output();
  } catch (cause) {
    throw new UsageError(
      `could not run "${cli}": ${
        cause instanceof Error ? cause.message : cause
      }\nInstall it, or set import.civitai_cli to where it lives.`,
    );
  }
  if (!status.success) {
    throw new UsageError(
      `${cli} download exited ${status.code}. If it asked for a login: ` +
        `run \`${cli} login\`, or set CIVITAI_TOKEN.`,
    );
  }

  const files: ImportFile[] = [];
  for await (const entry of Deno.readDir(into)) {
    if (!entry.isFile) continue;
    const bytes = await Deno.readFile(join(into, entry.name));
    files.push({
      file: `model/${entry.name}`,
      kind: found.kind,
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
      source: {
        kind: found.record.source.kind,
        label: found.record.source.label,
        url: found.files.find((file) => file.name === entry.name)
          ?.download_url ?? null,
      },
    });
  }
  if (files.length === 0) {
    throw new LookupError(`${cli} downloaded nothing into ${into}`);
  }
  return files;
}

// ------------------------------------------------------------------- notes

/**
 * What lands in the model's `notes`, which is a field a person types into:
 * the trigger words, and nothing else. The author's description is six to
 * eight kilobytes of HTML and belongs in the source record, where the model
 * page renders it under its own heading (§5.5).
 */
function notesFrom(found: LookupResult): string | null {
  if (found.trigger_words.length === 0) return null;
  return `Trigger words: ${found.trigger_words.join(", ")}`;
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Exposed for the CLI's own error path, which prints it beside the usage. */
export function describeHash(value: string): string | null {
  return normalizeHash(value);
}
