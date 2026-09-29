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

import {
  basename,
  dirname,
  extname,
  join,
  resolve as resolvePath,
} from "@std/path";
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
import {
  CIVITAI_AUTH_HINT,
  downloadFile,
  HUGGINGFACE_AUTH_HINT,
} from "./download.ts";
import {
  CivitaiClient,
  describeCandidate,
  LookupError,
  type LookupSource,
} from "./civitai_client.ts";
import { HuggingFaceClient } from "./huggingface_client.ts";
import {
  appendToLedger,
  type Existing,
  findExisting,
  isFetched,
  label,
  type Ledger,
  listed,
  readLedger,
  type Wanted,
  wantedFromUrl,
} from "./existing.ts";
import { parseHuggingFaceUrl } from "../models/huggingface.ts";

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
  /** `--import-source`: which site answers, or `auto` for the §4.1 order. */
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
  /**
   * Set when nothing was fetched because this model already was: a batch
   * waiting in the import folder, or one the app has ingested. Only without
   * `--overwrite`.
   */
  existing?: Existing;
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
  /** Where `CIVITAI_TOKEN` and `HF_TOKEN` are read from; tests pass their own. */
  env?: { get(key: string): string | undefined };
  client?: CivitaiClient;
  log?: (line: string) => void;
}

export async function runModels(
  options: RunModelsOptions,
): Promise<ModelsCommandResult> {
  requireOneIdentifier(options);
  const settings = options.config.import;
  const say = options.log ?? ((line: string) => console.log(line));
  const token = civitaiToken(options.config, options.env);
  const hfToken = huggingFaceToken(options.config, options.env);
  const client = options.client ?? new CivitaiClient({
    civitaiUrl: settings.civitai_url,
    archiveUrl: settings.archive_url,
    browsingLevel: options.browsingLevel ?? settings.browsing_level,
    timeoutMs: options.timeoutMs,
    token,
    huggingface: new HuggingFaceClient({
      hubUrl: settings.huggingface_url,
      token: hfToken,
      timeoutMs: options.timeoutMs,
      say,
    }),
  });

  // Discovery writes nothing: it is how you find the URL the other flags
  // want, without anything being on disk first.
  if (options.search !== undefined) {
    const onHub = options.source === "huggingface";
    const found = onHub
      ? await huggingFace(client).search(options.search)
      : await client.search(options.search);
    if (found.length === 0) {
      throw new LookupError(
        `nothing on ${onHub ? "Hugging Face" : "Civitai"} matches ` +
          `"${options.search}"`,
      );
    }
    say(`${found.length} match${found.length === 1 ? "" : "es"}:`);
    for (const candidate of found) say(describeCandidate(candidate));
    return { dir: "", batch: null, samples: 0, skipped: 0, files: 0 };
  }

  // A local file is hashed once, here, for both questions: whether this was
  // already fetched, and — if not — what to ask for.
  let localHash: string | undefined;
  if (options.localFile !== undefined) {
    const path = await resolveLocalFile(options.config, options.localFile);
    say(`hashing ${path}`);
    localHash = await hashFile(path);
  }

  // `imports/imported_checksums.txt` decides what counts as fetched (§3.2),
  // seeded the first time from what already is.
  const ledger = await readLedger(options.paths);

  // Without `--overwrite`, a model on that list is left alone, and found
  // without asking the network where that is possible: re-running a list of
  // commands costs nothing for the ones already done.
  if (!options.overwrite) {
    const wanted = wantedFor(options, localHash);
    const have = wanted === null
      ? null
      : await findExisting(options.paths, wanted, ledger);
    if (have !== null) return alreadyFetched(have, ledger, say);
  }

  const found = await resolve(options, client, localHash);
  if (found.sha256 === null) {
    throw new LookupError(
      "the model was found but carries no sha256, so nothing could be " +
        "matched to a file on disk",
    );
  }
  // A link nothing on this machine had recorded, for a model the list has
  // anyway — fetched elsewhere, or listed by hand. The lookup could not be
  // saved, but the samples, the weights and the batch can.
  if (
    !options.overwrite && await isFetched(options.paths, ledger, found.sha256)
  ) {
    return alreadyFetched(
      {
        ...listed(ledger, found.sha256),
        name: found.record.model.name ?? found.display_name,
        version: found.record.version.name,
      },
      ledger,
      say,
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
    for (const line of summarize(found)) say(line);
    if (options.downloadSamples > 0) {
      say(`  samples       up to ${options.downloadSamples}`);
    }
    if (options.downloadModel) say(`  weights       would be downloaded`);
    say(`would write ${dir}`);
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
      const onHub = found.record.source.kind === "huggingface";
      const files = await fetchWeights({
        found,
        staging,
        // The Civitai CLI knows nothing of Hugging Face, and each site gets
        // its own key and never the other's.
        cli: onHub ? null : settings.civitai_cli,
        token: onHub ? hfToken : token,
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

  // On the list the moment the batch exists, so a second run — or a second
  // machine sharing this folder — leaves it alone.
  await appendToLedger(
    ledger,
    found.sha256,
    label({
      name: found.record.model.name ?? found.display_name,
      version: found.record.version.name,
    }),
  );

  for (const line of summarize(found)) say(line);
  if (options.downloadSamples > 0) {
    say(
      `  samples       ${result.samples}${
        result.skipped > 0
          ? ` (${result.skipped} over import.nsfw_level, skipped)`
          : ""
      }`,
    );
  }
  if (batch.files && batch.files.length > 0) {
    say(
      `  weights       ${
        batch.files.map((file) =>
          file.size == null
            ? basename(file.file)
            : `${basename(file.file)} (${mebibytes(file.size)})`
        ).join(", ")
      }`,
    );
  }
  say(`wrote ${dir}`);
  return result;
}

/**
 * The Civitai key: `CIVITAI_TOKEN` first, then `import.civitai_token`. The
 * environment wins, as it does for every tool that reads both — it is how you
 * use a different key for one run without editing a file.
 */
export function civitaiToken(
  config: Config,
  env: { get(key: string): string | undefined } = Deno.env,
): string | null {
  const fromEnv = env.get("CIVITAI_TOKEN")?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config.import.civitai_token?.trim();
  return fromConfig ? fromConfig : null;
}

/** The Hugging Face token: `HF_TOKEN` first, as the Hub's own tools read it. */
export function huggingFaceToken(
  config: Config,
  env: { get(key: string): string | undefined } = Deno.env,
): string | null {
  const fromEnv = env.get("HF_TOKEN")?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config.import.huggingface_token?.trim();
  return fromConfig ? fromConfig : null;
}

function huggingFace(client: CivitaiClient): HuggingFaceClient {
  if (client.huggingface === null) {
    throw new LookupError("this client was built without Hugging Face");
  }
  return client.huggingface;
}

/** The run that fetches nothing, and says why and how to make it. */
function alreadyFetched(
  have: Existing,
  ledger: Ledger,
  say: (line: string) => void,
): ModelsCommandResult {
  say(`already fetched: ${label(have) || have.hash}`);
  if (have.state === "pending") {
    say(`  waiting for the app in ${dirname(have.path)}`);
  } else if (have.state === "imported") {
    say(`  imported by the app; its record is ${have.path}`);
  }
  say(`  ${have.hash} is in ${ledger.path}`);
  say(
    "nothing was fetched; remove that line, or pass --overwrite, to fetch it again",
  );
  return {
    dir: have.state === "listed" ? dirname(ledger.path) : dirname(have.path),
    batch: null,
    samples: 0,
    skipped: 0,
    files: 0,
    existing: have,
  };
}

// ------------------------------------------------------------------ lookup

/** What to look for among the batches already fetched (`existing.ts`). */
function wantedFor(
  options: ModelsCommandOptions,
  localHash: string | undefined,
): Wanted | null {
  if (options.sha256checksum !== undefined) {
    return { hash: options.sha256checksum };
  }
  if (localHash !== undefined) return { hash: localHash };
  if (options.filename !== undefined) return { filename: options.filename };
  if (options.url !== undefined) return wantedFromUrl(options.url);
  return null;
}

async function resolve(
  options: RunModelsOptions,
  client: CivitaiClient,
  localHash?: string,
): Promise<LookupResult> {
  if (options.sha256checksum !== undefined) {
    return await client.byHash(options.sha256checksum, options.source);
  }

  if (localHash !== undefined) {
    // The exact road: a hash beats every name-based search, and the answer is
    // about *your* file rather than one that happens to share its name.
    return await client.byHash(localHash, options.source);
  }

  if (options.filename !== undefined) {
    // Purely remote (§4.1): this flag is for a model that is *not* here yet,
    // so nothing on this machine is read. `--local-file` is the other one.
    return await client.byFilename(options.filename, options.source);
  }

  // A Hugging Face link is a repo and maybe a file in it, and only the Hub
  // can answer for it (§4.5).
  const hub = parseHuggingFaceUrl(options.url!);
  if (hub !== null) {
    if (options.source !== "auto" && options.source !== "huggingface") {
      throw new UsageError(
        `--url names a Hugging Face repo, which --import-source ` +
          `${sourceName(options.source)} cannot answer for`,
      );
    }
    return await huggingFace(client).byRef(hub);
  }

  const ref = parseModelUrl(options.url!);
  if (options.source === "huggingface") {
    throw new UsageError(
      "--url names a Civitai model, which --import-source huggingface " +
        "cannot answer for; pass a huggingface.co link, or drop the flag",
    );
  }
  // A URL that names a site is asked there first; `--import-source` still
  // wins.
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
  if (found.record.source.kind === "huggingface") {
    // Not a failure: a model card's pictures are decoration, not samples with
    // a prompt behind them, and there is nothing else to fetch.
    say("Hugging Face has no sample images; none were fetched");
    return { samples: [], skipped: 0 };
  }

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

  // Counted in the summary rather than said here, next to what they are of.
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
  token: string | null;
  timeoutMs: number;
  say: (line: string) => void;
}): Promise<ImportFile[]> {
  const { found, staging, cli, token, say } = input;
  const into = join(staging, "model");
  await Deno.mkdir(into, { recursive: true });

  // The official CLI when it is actually installed — it handles the gated and
  // paid models a plain GET cannot — and a direct download otherwise, which
  // is the common case and must not need a separate install.
  const versionId = found.record.source.model_version_id;
  const wanted = found.files.filter((file) => file.download_url !== null);
  // The file the batch is named after, when the version lists it: a hash
  // lookup may have named its fp16 or pruned variant rather than the primary.
  // Failing that the primary, unless the version ships nothing marked as
  // one: pulling every variant is rarely what "download the model" means.
  const chosen = wanted.find((file) => file.sha256 === found.sha256) ??
    wanted.find((file) => file.primary) ?? wanted[0] ?? null;
  // A token given to ForgeUI wins. The CLI keeps its own login somewhere else
  // entirely, and preferring it whenever it happened to be installed would
  // quietly ignore the key in `config.yaml` — the one thing the person set.
  // It also downloads by version, which means the primary file, so it is no
  // use when the one wanted is a variant.
  if (
    token === null && cli !== null && (chosen?.primary ?? true) &&
    await onPath(cli)
  ) {
    if (versionId === null) {
      throw new LookupError(
        `${cli} downloads by model version id, and this lookup found none`,
      );
    }
    say(`downloading the weights with ${cli}…`);
    await runCivitaiCli(cli, versionId, into);
  } else {
    if (chosen === null) {
      throw new LookupError(
        versionId === null
          ? "this lookup found no downloadable file"
          : `no download URL for model version ${versionId}`,
      );
    }
    say(`downloading ${chosen.name}…`);
    await downloadFile({
      url: chosen.download_url!,
      into,
      fallbackName: chosen.name,
      authHint: found.record.source.kind === "huggingface"
        ? HUGGINGFACE_AUTH_HINT
        : CIVITAI_AUTH_HINT,
      token,
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
  // Ingest files the weights by what they hash to and applies the metadata by
  // the batch's name. If those differ, the model lands but its description,
  // samples and trigger words wait forever for a file that never comes.
  if (!files.some((file) => file.sha256 === found.sha256)) {
    throw new LookupError(
      `downloaded ${files.map((file) => file.file).join(", ")}, which hashes ` +
        `to ${files.map((file) => file.sha256).join(", ")}, not the ` +
        `${found.sha256} this lookup is about. Nothing was written: that ` +
        `batch could never be matched to its model.`,
    );
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

/** How `--import-source` spells a source, for messages. */
export function sourceName(source: LookupSource): string {
  return source === "civitai"
    ? "civitai.red/civitai.com"
    : source === "archive"
    ? "civitaiarchive"
    : source;
}

/**
 * `--import-source`, spelled as the sites are. `civitai.red` and `civitai.com`
 * are one API on two hosts (§4.0), so both are the `civitai` source, pointed
 * at the host named.
 */
export function parseImportSource(
  value: string,
): { source: LookupSource; civitaiUrl: string | null } {
  switch (value.trim().toLowerCase()) {
    case "auto":
      return { source: "auto", civitaiUrl: null };
    case "civitai.red":
      return { source: "civitai", civitaiUrl: "https://civitai.red" };
    case "civitai.com":
      return { source: "civitai", civitaiUrl: "https://civitai.com" };
    case "civitaiarchive":
    case "civitaiarchive.com":
      return { source: "archive", civitaiUrl: null };
    case "huggingface":
    case "huggingface.co":
      return { source: "huggingface", civitaiUrl: null };
  }
  throw new UsageError(
    `--import-source: expected auto, civitai.red, civitai.com, ` +
      `civitaiarchive or huggingface, got "${value}"`,
  );
}

/**
 * What a run found, said back before it is written: where it came from, and
 * enough of what it holds to tell at a glance whether it is the right model —
 * which version, for which base model, triggered by what. A model's versions
 * differ in exactly those, so they are what is shown.
 */
export function summarize(found: LookupResult): string[] {
  const { record } = found;
  const row = (label: string, value: string) =>
    `  ${label.padEnd(13)} ${value}`;
  const host = (() => {
    try {
      return new URL(record.source.url).host;
    } catch {
      return null;
    }
  })();
  const lines = [
    `from ${record.source.label}${
      host === null ? "" : ` (${host})`
    }: ${record.source.url}`,
  ];
  const name = record.model.name ?? found.display_name ?? found.filename;
  if (name) lines.push(row("model", name));
  if (record.version.name) lines.push(row("version", record.version.name));
  lines.push(row("file", found.filename ?? found.sha256 ?? "unknown"));
  lines.push(row(
    "kind",
    [
      found.kind,
      found.family === null
        ? `family unknown${
          record.version.base_model ? ` (${record.version.base_model})` : ""
        }, the app's is kept`
        : `${found.family}${
          record.version.base_model ? ` (${record.version.base_model})` : ""
        }`,
    ].join(" · "),
  ));
  if (record.creator) lines.push(row("by", record.creator.username));
  lines.push(row(
    "trigger words",
    found.trigger_words.length > 0 ? found.trigger_words.join(", ") : "none",
  ));
  if (record.model.tags.length > 0) {
    const shown = record.model.tags.slice(0, 8);
    lines.push(row(
      "their tags",
      `${shown.join(", ")}${
        record.model.tags.length > shown.length
          ? ` +${record.model.tags.length - shown.length}`
          : ""
      }`,
    ));
  }
  const description = record.version.description_text ??
    record.model.description_text;
  lines.push(row(
    "description",
    description
      ? `${description.length.toLocaleString("en")} characters`
      : "none",
  ));
  return lines;
}

function mebibytes(bytes: number): string {
  return bytes >= 1 << 30
    ? `${(bytes / (1 << 30)).toFixed(1)} GiB`
    : `${(bytes / (1 << 20)).toFixed(1)} MiB`;
}
