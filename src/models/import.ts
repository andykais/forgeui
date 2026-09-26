/**
 * The import folder, and what the app does with what it finds there
 * (DESIGN-MODEL-IMPORT §7.1, §7.2).
 *
 * `forge models` writes batches here and exits; this picks them up on boot
 * and around every model rescan, applies each one to the model it names, and
 * deletes it. The two halves never share a process, a database handle or a
 * lock — they meet on the filesystem, which is what makes "the CLI cannot
 * corrupt anything" true by construction rather than by care.
 *
 * Ingest runs in **two phases around the scan**, because weights force it: a
 * batch carrying a file the library has never seen cannot be applied until
 * that file has been filed, scanned and hashed, and the hash is what the
 * batch is keyed on.
 *
 *   Phase A  file the weights into `<appdata>/models/<kind>/`
 *   …the ordinary scan and the hasher run…
 *   Phase B  apply the metadata and the samples, then delete the batch
 */

import { basename, extname, join } from "@std/path";
import type { Database } from "../db/sqlite.ts";
import type { DataPaths } from "../config/paths.ts";
import {
  getModel,
  type MediaSource,
  type ModelMetaPatch,
  normalizeModelHash,
  sampleSourceExists,
  updateModelMeta,
} from "../db/queries.ts";
import type { SampleStore } from "../samples/store.ts";
import { sha256Hex } from "../workflows/hash.ts";
import { log, logError } from "../log.ts";

/** What a batch's `model.json` holds (§5.2). */
export interface ImportBatch {
  format: number;
  forgecli_version?: string;
  created_at?: string;
  /** Replace fields the model already has, rather than only filling blanks. */
  overwrite?: boolean;
  model: {
    sha256: string;
    filename?: string | null;
    kind?: string | null;
    display_name?: string | null;
    family?: string | null;
    tags?: string[];
    notes?: string | null;
    trigger_words?: string[];
  };
  source?: Record<string, unknown> | null;
  /** The §5.5 record, stored whole on the model row. */
  civitai?: Record<string, unknown> | null;
  /** Only with `--download-model`. */
  files?: ImportFile[];
  samples?: ImportSample[];
  [unknownField: string]: unknown;
}

export interface ImportFile {
  file: string;
  kind: string;
  sha256?: string | null;
  size?: number | null;
  source?: Record<string, unknown> | null;
  /** Set by Phase A once the file has been moved, so a crash cannot re-file. */
  filed?: boolean;
}

export interface ImportSample {
  file: string;
  kind?: string;
  width?: number | null;
  height?: number | null;
  source?: Record<string, unknown> | null;
  raw?: unknown;
}

/** The newest format this build can read; a newer batch is refused (§5.2). */
export const IMPORT_FORMAT = 1;

export class ImportError extends Error {
  override readonly name = "ImportError";
}

export interface IngestCounts {
  /** Batches on disk at the start of the pass. */
  found: number;
  /** Weights files moved into the download folder by Phase A. */
  filed: number;
  /** Batches fully applied and deleted by Phase B. */
  applied: number;
  /** Batches left alone because their model has not been hashed yet. */
  waiting: number;
  /** Batches moved to `.failed/`. */
  failed: number;
}

export function emptyCounts(): IngestCounts {
  return { found: 0, filed: 0, applied: 0, waiting: 0, failed: 0 };
}

export interface ImportInboxOptions {
  db: Database;
  paths: DataPaths;
  /**
   * Absent on the library `deno task reindex` builds, which never ingests —
   * it drives the scanner directly. A batch applied without one keeps its
   * metadata and skips its images rather than failing.
   */
  samples?: SampleStore;
  now?: () => number;
}

export class ImportInbox {
  #db: Database;
  #paths: DataPaths;
  #samples?: SampleStore;
  #now: () => number;

  constructor(options: ImportInboxOptions) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#samples = options.samples;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Phase A: move every downloaded weights file into the download folder, so
   * the scan that follows sees it. Nothing else in the batch is touched and
   * the batch stays put — Phase B applies it once the hasher has given the
   * file an identity.
   */
  async file(): Promise<IngestCounts> {
    const counts = emptyCounts();
    for await (const dir of this.#batches()) {
      counts.found++;
      let batch: ImportBatch;
      try {
        batch = await this.#read(dir);
      } catch (cause) {
        counts.failed++;
        await this.#fail(dir, cause);
        continue;
      }
      if (!batch.files || batch.files.length === 0) continue;
      try {
        let moved = false;
        for (const entry of batch.files) {
          if (entry.filed) continue;
          await this.#fileOne(dir, batch, entry);
          entry.filed = true;
          moved = true;
          counts.filed++;
        }
        // Written back before the scan, so a crash between the move and the
        // next pass cannot file the same bytes twice.
        if (moved) await this.#write(dir, batch);
      } catch (cause) {
        counts.failed++;
        await this.#fail(dir, cause);
      }
    }
    return counts;
  }

  /**
   * Phase B: apply every batch whose model the library now knows, and delete
   * it. A batch naming a hash with no row is left exactly as it is — that is
   * a file still being hashed, not an error, and it lands on a later pass.
   */
  async apply(): Promise<IngestCounts> {
    const counts = emptyCounts();
    const waiting: {
      hash: string;
      name: string;
      filename: string | null;
      carriesWeights: boolean;
    }[] = [];
    for await (const dir of this.#batches()) {
      counts.found++;
      let batch: ImportBatch;
      try {
        batch = await this.#read(dir);
      } catch (cause) {
        counts.failed++;
        await this.#fail(dir, cause);
        continue;
      }
      const hash = normalizeModelHash(batch.model.sha256);
      if (getModel(this.#db, hash) === null) {
        counts.waiting++;
        waiting.push({
          hash,
          name: batch.model.display_name ?? batch.model.filename ?? hash,
          filename: batch.model.filename ?? null,
          // A batch that brought its own weights is mid-flight rather than
          // stuck: Phase A filed them and the hasher has not caught up yet.
          carriesWeights: (batch.files ?? []).length > 0,
        });
        continue;
      }
      try {
        await this.#apply(dir, batch, hash);
        await Deno.remove(dir, { recursive: true });
        counts.applied++;
      } catch (cause) {
        counts.failed++;
        await this.#fail(dir, cause);
      }
    }
    if (counts.applied > 0 || counts.failed > 0) {
      log(
        `import: applied ${counts.applied} batch${
          counts.applied === 1 ? "" : "es"
        }${counts.failed > 0 ? `, ${counts.failed} failed` : ""}`,
      );
    }

    // A batch whose model is not here yet used to be skipped in silence, on
    // the grounds that it is a normal state rather than an error. It is — and
    // silence still made it look like nothing had happened at all, because
    // from the outside that is exactly what it looks like. Metadata cannot
    // attach to a model the library has no row for, and the only way anyone
    // learns that is if this says so.
    const stuck = waiting.filter((entry) => !entry.carriesWeights);
    if (stuck.length > 0) {
      log(
        `import: ${stuck.length} batch${
          stuck.length === 1 ? " is" : "es are"
        } waiting for a model this library has not seen`,
      );
      for (const entry of stuck.slice(0, 5)) {
        log(
          `  ${entry.name} — ${entry.filename ?? entry.hash.slice(0, 12)} is ` +
            `not in any configured model folder`,
        );
      }
      if (stuck.length > 5) log(`  …and ${stuck.length - 5} more`);
      log(
        `  put the file in a model folder and rescan, or re-run \`forge ` +
          `models\` with --download-model to fetch it`,
      );
    }
    return counts;
  }

  // ------------------------------------------------------------- phase A

  async #fileOne(
    dir: string,
    batch: ImportBatch,
    entry: ImportFile,
  ): Promise<void> {
    const from = join(dir, entry.file);
    const bytes = await Deno.readFile(from).catch((cause) => {
      throw new ImportError(
        `${entry.file}: ${cause instanceof Error ? cause.message : cause}`,
      );
    });

    // The batch's own name is what the bytes have to hash to, which makes a
    // truncated or substituted download something this pass catches rather
    // than something a loader discovers at generate time (§5.1).
    const actual = await sha256Hex(bytes);
    const expected = normalizeModelHash(entry.sha256 ?? batch.model.sha256);
    if (actual !== expected) {
      throw new ImportError(
        `${entry.file}: hashes to ${actual}, but the batch says ${expected}`,
      );
    }

    const kind = entry.kind || "other";
    const into = join(this.#paths.downloads, kind);
    await Deno.mkdir(into, { recursive: true });
    // `entry.file` is a path *inside the batch* (`model/x.safetensors`); what
    // gets filed is its name, not its staging location.
    const target = await this.#freeName(into, basename(entry.file), actual);
    if (target === null) return; // already filed by an earlier run
    await move(from, target);
    log(`import: filed ${basename(target)} into ${kind}/`);
  }

  /**
   * A name nothing else is using. A name already taken by *these* bytes means
   * a previous run filed it, and the batch's copy is dropped rather than
   * duplicated.
   */
  async #freeName(
    into: string,
    file: string,
    hash: string,
  ): Promise<string | null> {
    const ext = extname(file);
    const stem = basename(file, ext);
    for (let n = 1; n < 100; n++) {
      const candidate = join(into, n === 1 ? file : `${stem} (${n})${ext}`);
      let existing: Uint8Array;
      try {
        existing = await Deno.readFile(candidate);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return candidate;
        throw error;
      }
      if (await sha256Hex(existing) === hash) return null;
    }
    throw new ImportError(`${file}: a hundred files of that name already`);
  }

  // ------------------------------------------------------------- phase B

  async #apply(
    dir: string,
    batch: ImportBatch,
    hash: string,
  ): Promise<void> {
    const model = getModel(this.#db, hash)!;
    const overwrite = batch.overwrite === true;
    const patch: ModelMetaPatch = {};

    // Fields the user edits are filled only where they are empty, unless the
    // batch says otherwise. A hand-typed display name surviving an import is
    // the default because losing one is the kind of thing you notice a week
    // later (§7.2).
    const fill = <K extends "display_name" | "family" | "notes">(
      key: K,
      value: string | null | undefined,
    ) => {
      if (value === undefined || value === null || value === "") return;
      if (!overwrite && model[key] !== null && model[key] !== "") return;
      patch[key] = value;
    };
    fill("display_name", batch.model.display_name);
    fill("family", batch.model.family);
    fill("notes", batch.model.notes);

    const tags = batch.model.tags ?? [];
    if (tags.length > 0 && (overwrite || model.tags.length === 0)) {
      patch.tags = tags;
    }
    const triggers = batch.model.trigger_words ?? [];
    if (
      triggers.length > 0 && (overwrite || model.trigger_words.length === 0)
    ) {
      patch.trigger_words = triggers;
    }
    // The source record is a cached copy of somebody else's document, not a
    // field anyone edits, so a re-fetch replaces it whole either way (§5.5).
    if (batch.civitai) patch.civitai = batch.civitai;

    if (Object.keys(patch).length > 0) {
      updateModelMeta(this.#db, hash, patch);
    }
    await this.#writeMeta(hash, batch);
    await this.#importSamples(dir, batch, hash);
  }

  /**
   * The raw upstream response, beside the model's other metadata. §8.1 says a
   * model's Civitai data lives in `models-meta/<hash>/` *and* the DB, and this
   * is the half a rebuild could read back.
   */
  async #writeMeta(hash: string, batch: ImportBatch): Promise<void> {
    if (!batch.civitai && !batch.source) return;
    const dir = join(this.#paths.modelsMeta, hash);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "civitai.json"),
      `${
        JSON.stringify(
          { source: batch.source ?? null, ...batch.civitai },
          null,
          2,
        )
      }\n`,
    );
  }

  async #importSamples(
    dir: string,
    batch: ImportBatch,
    hash: string,
  ): Promise<void> {
    if (this.#samples === undefined) return;
    for (const entry of batch.samples ?? []) {
      const source = toMediaSource(entry.source, this.#now());
      const url = source?.url ?? null;
      // What makes re-running the CLI free: the same image is one sample,
      // however many times it is fetched (§7.2).
      if (url !== null && sampleSourceExists(this.#db, hash, url)) continue;

      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(join(dir, entry.file));
      } catch (cause) {
        // One unreadable image does not fail a batch: the metadata is worth
        // more than the picture, and the batch is deleted either way.
        logError(
          `import: ${entry.file} is missing from its batch (${
            cause instanceof Error ? cause.message : cause
          })`,
        );
        continue;
      }
      await this.#samples.import({
        modelHash: hash,
        bytes,
        filename: basename(entry.file),
        sourceUrl: url,
        source,
        raw: entry.raw ?? null,
      });
    }
  }

  // --------------------------------------------------------------- files

  /** Every batch directory, skipping the dot-prefixed bookkeeping ones. */
  async *#batches(): AsyncGenerator<string> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(this.#paths.imports)) {
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      yield join(this.#paths.imports, entry.name);
    }
  }

  async #read(dir: string): Promise<ImportBatch> {
    const path = join(dir, "model.json");
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (cause) {
      throw new ImportError(
        cause instanceof Deno.errors.NotFound
          ? "no model.json in this batch"
          : `model.json: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ImportError(
        `model.json: invalid JSON: ${
          cause instanceof Error ? cause.message : cause
        }`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ImportError("model.json: expected an object");
    }
    const batch = parsed as ImportBatch;
    // A newer writer is refused with a sentence rather than misread (§5.2).
    if (typeof batch.format !== "number" || batch.format > IMPORT_FORMAT) {
      throw new ImportError(
        `model.json: format ${batch.format} is newer than this build reads (${IMPORT_FORMAT})`,
      );
    }
    if (
      typeof batch.model !== "object" || batch.model === null ||
      typeof batch.model.sha256 !== "string" ||
      normalizeModelHash(batch.model.sha256).length !== 64
    ) {
      throw new ImportError("model.json: model.sha256 must be a sha256");
    }
    // The directory is named by the model it is about, and disagreeing with
    // its own contents is the one thing that cannot be recovered from.
    const named = basename(dir).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(named)) {
      const claimed = normalizeModelHash(batch.model.sha256);
      if (named !== claimed) {
        throw new ImportError(
          `the folder is named ${named} but model.json says ${claimed}`,
        );
      }
    }
    return batch;
  }

  async #write(dir: string, batch: ImportBatch): Promise<void> {
    await Deno.writeTextFile(
      join(dir, "model.json"),
      `${JSON.stringify(batch, null, 2)}\n`,
    );
  }

  /**
   * A batch that throws goes to `.failed/` with the reason beside it, so one
   * bad JSON cannot wedge every boot from now on. Nothing ever retries it; it
   * is yours to look at or delete.
   */
  async #fail(dir: string, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    logError(`import: ${basename(dir)} refused: ${message}`);
    const failed = join(this.#paths.imports, ".failed", basename(dir));
    try {
      await Deno.mkdir(join(this.#paths.imports, ".failed"), {
        recursive: true,
      });
      await Deno.remove(failed, { recursive: true }).catch(() => {});
      await Deno.rename(dir, failed);
      await Deno.writeTextFile(
        join(failed, "error.txt"),
        `${new Date(this.#now()).toISOString()}\n${message}\n`,
      );
    } catch (error) {
      logError(
        `import: could not set ${basename(dir)} aside: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}

/** A `source` block from a batch, with the fields the badge needs assured. */
export function toMediaSource(
  value: Record<string, unknown> | null | undefined,
  now: number,
): MediaSource | null {
  if (!value || typeof value !== "object") return null;
  const kind = typeof value.kind === "string" ? value.kind : null;
  if (kind === null) return null;
  const label = typeof value.label === "string" ? value.label : kind;
  return {
    ...value,
    kind,
    label,
    url: typeof value.url === "string" ? value.url : null,
    imported_at: typeof value.imported_at === "string"
      ? value.imported_at
      : `${new Date(now).toISOString().slice(0, 19)}Z`,
  };
}

/** Rename where the filesystem allows it, copy where it does not. */
async function move(from: string, to: string): Promise<void> {
  try {
    await Deno.rename(from, to);
  } catch {
    await Deno.copyFile(from, to);
    await Deno.remove(from).catch(() => {});
  }
}
