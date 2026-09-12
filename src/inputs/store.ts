import { dirname, join } from "@std/path";
import type { Database } from "@db/sqlite";
import { sha256Hex } from "../workflows/hash.ts";
import {
  getInput,
  getOutput,
  type InputRow,
  insertInput,
  insertOutputInput,
} from "../db/queries.ts";
import type { DataPaths } from "../config/paths.ts";
import { type ProbedImage, probeImage } from "./probe.ts";

/**
 * The content-addressed input store (§9): `inputs/<sha[0:2]>/<sha>.<ext>`.
 *
 * Content-addressed because the same image is used over and over — upscale a
 * picture, dislike the result, upscale it again with a different prompt — and
 * storing it once per attempt would fill a disk with copies of one file. It
 * also makes the identity of an input something the app can state rather than
 * guess: two params holding the same sha hold the same picture.
 */

export class InputError extends Error {
  override readonly name = "InputError";
}

export interface StoredInput extends ProbedImage {
  sha256: string;
  /** Relative to the data dir; what the DB row holds and media serves. */
  path: string;
  /** The name ComfyUI will know it by, once uploaded. */
  filename: string;
  bytes: number;
  derived_from_output: string | null;
}

export class InputStore {
  #db: Database;
  #paths: DataPaths;
  #now: () => number;

  constructor(options: { db: Database; paths: DataPaths; now?: () => number }) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#now = options.now ?? Date.now;
  }

  /** `inputs/ab/abcd….png`, relative to the data dir. */
  #relative(sha256: string, ext: string): string {
    return join("inputs", sha256.slice(0, 2), `${sha256}.${ext}`);
  }

  absolute(relative: string): string {
    return join(this.#paths.root, relative);
  }

  /**
   * Take bytes into the store. Already there → nothing is written and the
   * existing row is returned: the file is the same file, and its provenance
   * belongs to whoever put it there first.
   */
  async add(
    bytes: Uint8Array,
    options: {
      kind?: string;
      originalName?: string | null;
      derivedFromOutput?: string | null;
    } = {},
  ): Promise<StoredInput> {
    const probed = probeImage(bytes);
    const sha256 = await sha256Hex(bytes);
    const relative = this.#relative(sha256, probed.ext);
    const absolute = this.absolute(relative);
    await Deno.mkdir(dirname(absolute), { recursive: true });
    // Write even when the row exists: a row whose file has been swept away
    // is worse than a redundant write, and the content cannot differ.
    await Deno.writeFile(absolute, bytes);
    return this.#record({
      sha256,
      relative,
      probed,
      bytes: bytes.length,
      kind: options.kind ?? "image",
      originalName: options.originalName ?? null,
      derivedFromOutput: options.derivedFromOutput ?? null,
    });
  }

  /**
   * Take one of the app's own outputs in as an input — what Upscale and
   * "use in workflow" do (§10). Hardlinked where the filesystem allows it,
   * so a 6 MB render costs nothing to reuse, and copied where it does not.
   */
  async adoptOutput(outputId: string): Promise<StoredInput> {
    const output = getOutput(this.#db, outputId);
    if (!output) throw new InputError(`no output "${outputId}"`);
    if (output.deleted_at !== null) {
      throw new InputError(`output "${outputId}" has been deleted`);
    }
    const source = join(this.#paths.root, output.path);
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(source);
    } catch {
      throw new InputError(`output "${outputId}" is no longer on disk`);
    }
    const probed = probeImage(bytes);
    const sha256 = await sha256Hex(bytes);
    const relative = this.#relative(sha256, probed.ext);
    const absolute = this.absolute(relative);
    await Deno.mkdir(dirname(absolute), { recursive: true });
    try {
      await Deno.link(source, absolute);
    } catch {
      // Already linked, a different filesystem, or a filesystem with no
      // hardlinks at all: the copy is the fallback, never the failure.
      await Deno.writeFile(absolute, bytes);
    }
    return this.#record({
      sha256,
      relative,
      probed,
      bytes: bytes.length,
      kind: "image",
      originalName: null,
      derivedFromOutput: outputId,
    });
  }

  #record(input: {
    sha256: string;
    relative: string;
    probed: ProbedImage;
    bytes: number;
    kind: string;
    originalName: string | null;
    derivedFromOutput: string | null;
  }): StoredInput {
    const row: InputRow = {
      sha256: input.sha256,
      path: input.relative,
      ext: input.probed.ext,
      kind: input.kind,
      width: input.probed.width,
      height: input.probed.height,
      original_name: input.originalName,
      derived_from_output: input.derivedFromOutput,
      created_at: this.#now(),
    };
    insertInput(this.#db, row);
    const stored = getInput(this.#db, input.sha256) ?? row;
    return {
      ...input.probed,
      sha256: stored.sha256,
      path: stored.path,
      filename: `${stored.sha256}.${stored.ext}`,
      bytes: input.bytes,
      derived_from_output: stored.derived_from_output,
    };
  }

  /** What a param's stored value resolves to, or null if it names nothing. */
  get(sha256: string): StoredInput | null {
    const row = getInput(this.#db, sha256);
    if (!row) return null;
    return {
      sha256: row.sha256,
      path: row.path,
      ext: row.ext,
      filename: `${row.sha256}.${row.ext}`,
      contentType: contentTypeOf(row.ext),
      width: row.width ?? 0,
      height: row.height ?? 0,
      bytes: 0,
      derived_from_output: row.derived_from_output,
    };
  }

  async read(sha256: string): Promise<Uint8Array> {
    const row = getInput(this.#db, sha256);
    if (!row) throw new InputError(`no input "${sha256}"`);
    try {
      return await Deno.readFile(this.absolute(row.path));
    } catch {
      throw new InputError(`input "${sha256}" is no longer on disk`);
    }
  }

  /** §9 step 5: what this output was generated from, once it exists. */
  link(outputId: string, sha256: string, paramKey: string): void {
    insertOutputInput(this.#db, outputId, sha256, paramKey);
  }
}

function contentTypeOf(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}
