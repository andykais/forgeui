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

import { basename, extname, join, resolve as resolvePath } from "@std/path";
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
import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { downloadFile } from "./download.ts";
import {
  CivitaiClient,
  describeCandidate,
  LookupError,
  type LookupSource,
} from "./civitai_client.ts";

export { LookupError };

export interface ModelsCommandOptions {
  url?: string;
  /** A remote lookup by name: nothing on this machine is consulted. */
  filename?: string;
  /** A file on this machine: hashed, then looked up by that hash. */
  localFile?: string;
  sha256checksum?: string;
  /** Discovery: list what Civitai has under this name and write nothing. */
  search?: string;
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
  /** Null for `--search`, which looks things up and writes nothing. */
  batch: ImportBatch | null;
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
    options.localFile !== undefined ? "--local-file" : null,
    options.sha256checksum !== undefined ? "--sha256checksum" : null,
    options.search !== undefined ? "--search" : null,
  ].filter((flag): flag is string => flag !== null);
  if (given.length === 1) return;
  throw new UsageError(
    given.length === 0
      ? "say which model: --local-file for one on this machine, or --url, " +
        "--filename or --sha256checksum for one that is not; --search to " +
        "look by name without importing anything"
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

  // Discovery writes nothing: it is how you find the URL the other flags
  // want, without anything being on disk first.
  if (options.search !== undefined) {
    const found = await client.search(options.search);
    if (found.length === 0) {
      throw new LookupError(`nothing on Civitai matches "${options.search}"`);
    }
    say(`${found.length} match${found.length === 1 ? "" : "es"}:`);
    for (const candidate of found) say(describeCandidate(candidate));
    return { dir: "", batch: null, samples: 0, skipped: 0, files: 0 };
  }

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
      // Deliberately empty. Civitai's tags stay in the source record, where
      // the model page shows them under "their tags": ForgeUI's `tags` are
      // your taxonomy and drive the `?tags=` filter, and importing forty
      // models should not silently add two hundred entries to it (§5.5).
      // Promoting one is a click on the model page, not something ingest
      // decides.
      tags: [],
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
        timeoutMs: options.timeoutMs,
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

  if (options.localFile !== undefined) {
    // The exact road: a hash beats every name-based search, and the answer is
    // about *your* file rather than one that happens to share its name.
    const path = await resolveLocalFile(options.config, options.localFile);
    say(`hashing ${path}`);
    const hash = await hashFile(path);
    return await client.byHash(hash, options.source);
  }

  if (options.filename !== undefined) {
    // Purely remote (§4.1): this flag is for a model that is *not* here yet,
    // so nothing on this machine is read. `--local-file` is the other one.
    return await client.byFilename(options.filename, options.source);
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

/**
 * What `--local-file` points at: a path, or failing that a filename in one of
 * the configured model folders. A path is the honest reading of the flag; the
 * folder search is what makes `--local-file dreamshaper_8.safetensors` work
 * from any directory, which is how anyone will actually type it.
 */
export async function resolveLocalFile(
  config: Config,
  given: string,
): Promise<string> {
  const direct = resolvePath(given);
  try {
    if ((await Deno.stat(direct)).isFile) return direct;
  } catch {
    // Not a path here; try the configured folders below.
  }
  const found = await findModelFile(config, given);
  if (found !== null) return found;
  throw new UsageError(
    `--local-file: no file at "${given}", and nothing named "${
      basename(given)
    }" in the configured model folders.\n` +
      `If the model is not on this machine, use --filename to look it up by ` +
      `name, or --search to see what is out there.`,
  );
}

/** The configured model folders, walked for a basename match. */
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
  timeoutMs: number;
  say: (line: string) => void;
}): Promise<ImportFile[]> {
  const { found, staging, cli, say } = input;
  const into = join(staging, "model");
  await Deno.mkdir(into, { recursive: true });

  // The official CLI when it is actually installed — it handles the gated and
  // paid models a plain GET cannot — and a direct download otherwise, which
  // is the common case and must not need a separate install.
  const versionId = found.record.source.model_version_id;
  if (cli !== null && await onPath(cli)) {
    if (versionId === null) {
      throw new LookupError(
        `${cli} downloads by model version id, and this lookup found none`,
      );
    }
    say(`downloading the weights with ${cli}…`);
    await runCivitaiCli(cli, versionId, into);
  } else {
    const wanted = found.files.filter((file) => file.download_url !== null);
    if (wanted.length === 0) {
      throw new LookupError(
        versionId === null
          ? "this lookup found no downloadable file"
          : `no download URL for model version ${versionId}`,
      );
    }
    // The primary file only, unless the version ships nothing marked as one:
    // a version can carry pruned, fp16 and config variants, and pulling all
    // of them is rarely what "download the model" means.
    const primary = wanted.find((file) => file.primary) ?? wanted[0]!;
    say(`downloading ${primary.name}…`);
    await downloadFile({
      url: primary.download_url!,
      into,
      fallbackName: primary.name,
      token: Deno.env.get("CIVITAI_TOKEN") ?? null,
      timeoutMs: Math.max(input.timeoutMs, 30 * 60_000),
      say,
    });
  }

  const files: ImportFile[] = [];
  for await (const entry of Deno.readDir(into)) {
    if (!entry.isFile) continue;
    const path = join(into, entry.name);
    const { size } = await Deno.stat(path);
    files.push({
      file: `model/${entry.name}`,
      kind: found.kind,
      // Hashed from disk rather than from memory: this is a file measured in
      // gigabytes, and ingest checks the same number again before filing it.
      sha256: await hashFile(path),
      size,
      source: {
        kind: found.record.source.kind,
        label: found.record.source.label,
        url: found.files.find((file) => file.name === entry.name)
          ?.download_url ?? null,
      },
    });
  }
  if (files.length === 0) {
    throw new LookupError(`nothing was downloaded into ${into}`);
  }
  return files;
}

async function runCivitaiCli(
  cli: string,
  versionId: number,
  into: string,
): Promise<void> {
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
      }`,
    );
  }
  if (!status.success) {
    throw new UsageError(
      `${cli} download exited ${status.code}. If it asked for a login: ` +
        `run \`${cli} login\`, or set CIVITAI_TOKEN.`,
    );
  }
}

/** Whether a configured helper is really there, before we depend on it. */
async function onPath(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    return (await probe.output()).success;
  } catch {
    return false;
  }
}

/** sha256 of a file, streamed: a checkpoint never fits in memory. */
async function hashFile(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const digest = await stdCrypto.subtle.digest("SHA-256", file.readable);
    return encodeHex(new Uint8Array(digest));
  } finally {
    // `readable` closes the handle when it drains; closing twice throws.
    try {
      file.close();
    } catch {
      // already closed by the stream
    }
  }
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
