import type { Database } from "../db/sqlite.ts";
import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { delay } from "@std/async/delay";
import {
  deleteModelFile,
  getModel,
  getModelByPath,
  listModelFiles,
  markModelSeen,
  type ModelFileRow,
  refreshModelUsage,
  setModelPath,
  upsertModel,
  upsertModelFile,
} from "../db/queries.ts";
import type { ScannedModel } from "./scan.ts";

/**
 * The background hasher of §8.1: one worker, lowest priority, streaming
 * sha256 of the whole file. A model is usable long before this finishes —
 * pickers, generation and the gallery all work off the path — so nothing here
 * may block anything, and a failure to read one file must not stop the rest.
 *
 * Re-hashing is decided on `path + size + mtime`, recorded per *file* in
 * `model_files`: an untouched file keeps the hash it already has, which is
 * what makes a restart cheap. It has to be per file rather than per model,
 * because `models` is keyed by content — two identical files at two paths are
 * one row there, the second overwrites the first, and the losing path then
 * looked unhashed for ever and was queued again on every single rescan.
 *
 * The queue is smallest first. Reading is what costs, so folder order put a
 * hundred LoRAs behind ten multi-gigabyte checkpoints and none of them gained
 * an identity for minutes; by size, the many small files are done in seconds
 * and the few large ones finish while everything else already works.
 */

/** §8.1's `hashing_progress`. */
export interface HashingProgress {
  running: boolean;
  done: number;
  total: number;
  /** The model being read, by the name a workflow would bind to. */
  current: string | null;
  bytes_done: number;
  bytes_total: number;
}

export interface HashedModel {
  model: ScannedModel;
  hash: string;
  /** False when the file was already hashed and had not changed. */
  fresh: boolean;
}

export interface ModelHasherOptions {
  db: Database;
  onProgress?: (progress: HashingProgress) => void;
  /** Called for every model that finished, fresh or cached. */
  onHashed?: (hashed: HashedModel) => void | Promise<void>;
  /**
   * Called once the queue has emptied. What the import folder waits for: a
   * batch dropped for a model that was still hashing can be applied as soon
   * as its hash lands (DESIGN-MODEL-IMPORT §7.1).
   */
  onDrained?: () => void;
  now?: () => number;
  /**
   * Whether a file is still on disk. Two identical files are one model, and
   * the row keeps naming the copy it already names for as long as that copy
   * is there — so the file generation uses does not flip to whichever copy
   * was read last (§8.1). The library answers from its scan; the default
   * asks the filesystem.
   */
  isPresent?: (path: string) => boolean;
  /** Injectable so tests can fail a read without a fixture that cannot be read. */
  hashFile?: (path: string, onBytes: (read: number) => void) => Promise<string>;
}

/** A megabyte at a time: a checkpoint is far too big to hold in memory. */
const CHUNK_BYTES = 1 << 20;

async function* readChunks(
  file: Deno.FsFile,
  onBytes: (read: number) => void,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const buffer = new Uint8Array(CHUNK_BYTES);
  let read = 0;
  while (true) {
    // The digest consumes each chunk before asking for the next, so one
    // buffer is enough.
    const count = await file.read(buffer);
    if (count === null) return;
    read += count;
    onBytes(read);
    yield buffer.subarray(0, count);
  }
}

/** Stream the file through sha256 (§8.1: sha256 of the whole file). */
export async function hashFileStreaming(
  path: string,
  onBytes: (read: number) => void = () => {},
): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const digest = await stdCrypto.subtle.digest(
      "SHA-256",
      readChunks(file, onBytes),
    );
    return encodeHex(new Uint8Array(digest));
  } finally {
    file.close();
  }
}

export class ModelHasher {
  #db: Database;
  #onProgress?: (progress: HashingProgress) => void;
  #onHashed?: (hashed: HashedModel) => void | Promise<void>;
  #onDrained?: () => void;
  #now: () => number;
  #hashFile: (path: string, onBytes: (read: number) => void) => Promise<string>;
  #isPresent: (path: string) => boolean;

  #queue: ScannedModel[] = [];
  #queued = new Set<string>();
  /** What each path hashed to last time, so an untouched file is skipped. */
  #files = new Map<string, ModelFileRow>();
  #running = false;
  #stopped = false;
  #done = 0;
  #total = 0;
  #bytesDone = 0;
  #bytesTotal = 0;
  #current: ScannedModel | null = null;
  #loop: Promise<void> = Promise.resolve();
  /** Paths whose read failed; not retried until the next rescan. */
  readonly failures = new Map<string, string>();

  constructor(options: ModelHasherOptions) {
    this.#db = options.db;
    this.#onProgress = options.onProgress;
    this.#onHashed = options.onHashed;
    this.#onDrained = options.onDrained;
    this.#now = options.now ?? Date.now;
    this.#hashFile = options.hashFile ?? hashFileStreaming;
    this.#isPresent = options.isPresent ?? existsOnDisk;
    this.#files = listModelFiles(options.db);
  }

  get progress(): HashingProgress {
    return {
      running: this.#running,
      done: this.#done,
      total: this.#total,
      current: this.#current?.name ?? null,
      bytes_done: this.#bytesDone,
      bytes_total: this.#bytesTotal,
    };
  }

  /**
   * Queue what a scan found. Models whose row is already current are settled
   * here rather than in the worker, so `total` counts only real work.
   */
  enqueue(models: readonly ScannedModel[]): number {
    // A finished pass leaves its own totals behind. Adding to them made the
    // next rescan read "74/86" — the tail of the last pass plus the head of
    // this one — which describes no pass that ever ran.
    if (!this.#running && this.#queue.length === 0) this.#reset();
    let queued = 0;
    for (const model of models) {
      if (this.#queued.has(model.path)) continue;
      const existing = this.#files.get(model.path);
      if (existing && unchanged(existing, model)) {
        markModelSeen(this.#db, existing.hash, this.#now());
        this.#onHashed?.({ model, hash: existing.hash, fresh: false });
        continue;
      }
      this.#queued.add(model.path);
      this.#queue.push(model);
      this.#bytesTotal += model.size;
      this.#total++;
      queued++;
    }
    if (queued > 0) {
      // Smallest first, over whatever is still waiting — a rescan mid-pass
      // sorts its additions in with the rest rather than after them.
      this.#queue.sort((a, b) =>
        a.size - b.size || a.path.localeCompare(b.path)
      );
      this.#publish();
    }
    return queued;
  }

  /**
   * Forget what this path hashed to, so the next `enqueue` reads it again.
   * The re-hash decision is deliberately a cache — an untouched file keeps
   * its hash, which is what makes a restart cheap — so re-reading one on
   * purpose means dropping its record first (§8.1).
   */
  forget(path: string): void {
    this.#files.delete(path);
    deleteModelFile(this.#db, path);
  }

  /** Back to an empty pass: counted work, bytes, and what failed last time. */
  #reset(): void {
    this.#done = 0;
    this.#total = 0;
    this.#bytesDone = 0;
    this.#bytesTotal = 0;
    this.failures.clear();
  }

  /** Start the worker if it is not already going. Never throws. */
  start(): void {
    if (this.#running || this.#stopped || this.#queue.length === 0) return;
    this.#running = true;
    this.#loop = this.#run().catch((error) => {
      console.error("the model hasher stopped unexpectedly:", error);
      this.#running = false;
    });
  }

  /** Resolves when the queue is empty; the test seam for "hashing is done". */
  async idle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const loop = this.#loop;
      await loop;
      if (this.#queue.length === 0 && loop === this.#loop) return;
    }
  }

  /** Stop after the file in flight; the rest is picked up on the next boot. */
  stop(): void {
    this.#stopped = true;
    this.#queue = [];
    this.#queued.clear();
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      const model = this.#queue.shift();
      if (!model) break;
      this.#current = model;
      this.#publish();
      const startedBytes = this.#bytesDone;
      try {
        const hash = await this.#hashFile(model.path, (read) => {
          this.#bytesDone = startedBytes + read;
        });
        this.#write(model, hash);
        this.#bytesDone = startedBytes + model.size;
        await this.#onHashed?.({ model, hash, fresh: true });
      } catch (cause) {
        this.failures.set(
          model.path,
          cause instanceof Error ? cause.message : String(cause),
        );
        this.#bytesDone = startedBytes + model.size;
      }
      this.#queued.delete(model.path);
      this.#done++;
      this.#current = null;
      this.#publish();
      // Lowest priority: hand the loop back between files so a generation
      // never waits on a scan of somebody's model folder.
      await delay(0);
    }
    this.#running = false;
    this.#current = null;
    this.#publish();
    this.#onDrained?.();
  }

  #write(model: ScannedModel, hash: string): void {
    const file: ModelFileRow = {
      path: model.path,
      size: model.size,
      mtime: model.mtime ?? 0,
      hash,
      hashed_at: this.#now(),
    };
    // The per-file record first: it is what stops this path being queued
    // again, whether or not it ends up owning the `models` row.
    upsertModelFile(this.#db, file);
    this.#files.set(model.path, file);
    // This file was the copy a model named, and it now holds something else:
    // another copy of the old content carries the model on, rather than the
    // row — and everything the owner hung off it — being dropped while
    // identical bytes are still on disk (§8.1).
    const previous = getModelByPath(this.#db, model.path);
    if (previous && previous.hash !== hash) {
      const heir = this.copyOf(previous.hash, model.path);
      if (heir) setModelPath(this.#db, previous.hash, heir);
    }
    // One model, one file: a second copy of something already known leaves
    // the row naming the first, so the path generation uses is stable (§8.1).
    const existing = getModel(this.#db, hash);
    const keep = existing !== null && existing.path !== model.path &&
      this.#files.get(existing.path)?.hash === hash &&
      this.#isPresent(existing.path);
    upsertModel(
      this.#db,
      keep
        ? {
          hash,
          path: existing.path,
          kind: existing.kind,
          size: existing.size,
          mtime: existing.mtime,
          last_seen_at: this.#now(),
        }
        : {
          hash,
          path: model.path,
          kind: model.kind,
          size: model.size,
          mtime: model.mtime ?? 0,
          last_seen_at: this.#now(),
        },
    );
    // A hash that was known before may already have outputs behind it.
    refreshModelUsage(this.#db, [hash]);
  }

  /**
   * Another file on disk with this content, if there is one: the first by
   * path, so the choice does not depend on which was read last (§8.1).
   */
  copyOf(hash: string, except?: string): string | null {
    let found: string | null = null;
    for (const file of this.#files.values()) {
      if (file.hash !== hash || file.path === except) continue;
      if (found !== null && file.path >= found) continue;
      if (!this.#isPresent(file.path)) continue;
      found = file.path;
    }
    return found;
  }

  #publish(): void {
    this.#onProgress?.(this.progress);
  }
}

function existsOnDisk(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** The §8.1 re-hash decision: same file, same size, same mtime. */
export function unchanged(
  row: { path: string; size: number; mtime: number },
  model: ScannedModel,
): boolean {
  return row.path === model.path && row.size === model.size &&
    row.mtime === (model.mtime ?? 0);
}
