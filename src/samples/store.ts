import type { Database } from "@db/sqlite";
import { extname, join } from "@std/path";
import { ulid } from "@std/ulid";
import type { DataPaths } from "../config/paths.ts";
import {
  clearThumbPath,
  deleteSampleRow,
  getModel,
  getSample,
  insertSample,
  listSamples,
  normalizeModelHash,
  type OutputRow,
  type SampleRow,
} from "../db/queries.ts";
import { readPngSize } from "../jobs/png.ts";
import {
  buildSidecar,
  parseSidecar,
  serializeSidecar,
  type Sidecar,
  type SidecarOutput,
} from "../jobs/sidecar.ts";
import { mediaUrl } from "../outputs/store.ts";

/**
 * Samples (§8.3): media that shows what a model does, whether or not this app
 * made it. They live in `samples/<model_hash>/` beside a sidecar in the §6.2
 * schema, so **Reuse Parameters works on a sample** exactly as it does on an
 * output — for the ones that came from an output. A dropped file has nothing
 * to reuse: `params: {}`, `workflow: null`, and no Edit in Generate.
 */

export class SampleError extends Error {
  override readonly name = "SampleError";
}

export class SampleNotFoundError extends Error {
  override readonly name = "SampleNotFoundError";
  constructor(id: string) {
    super(`no sample "${id}"`);
  }
}

/** Civitai import arrives in Phase 3; the route says so rather than pretending. */
export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

export interface SampleView extends SampleRow {
  media_url: string;
  /**
   * True when the sample carries a generation to reuse — a promotion. A
   * dropped file has empty params and offers no Edit in Generate (§8.3).
   */
  reusable: boolean;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov"]);

interface Sniffed {
  kind: "image" | "video";
  ext: string;
}

/** What the bytes say they are; the filename only breaks a tie. */
export function sniffMedia(bytes: Uint8Array, filename: string): Sniffed {
  const starts = (...signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", ext: ".png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", ext: ".jpg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "image", ext: ".gif" };
  if (starts(0x52, 0x49, 0x46, 0x46)) {
    const tag = new TextDecoder("latin1").decode(bytes.subarray(8, 12));
    if (tag === "WEBP") return { kind: "image", ext: ".webp" };
  }
  const brand = new TextDecoder("latin1").decode(bytes.subarray(4, 8));
  if (brand === "ftyp") return { kind: "video", ext: ".mp4" };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return { kind: "video", ext: ".webm" };

  const ext = extname(filename).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: "video", ext };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image", ext };
  throw new SampleError(
    `"${filename}" is not an image or a video the app can show`,
  );
}

export interface ImportSampleInput {
  modelHash: string;
  bytes: Uint8Array;
  filename: string;
  /** Where it came from, when that is known; Civitai fills this in Phase 3. */
  sourceUrl?: string | null;
  /** Unmapped generation data, stored as `raw` and never interpreted (§8.3). */
  raw?: unknown;
}

export class SampleStore {
  #db: Database;
  #paths: DataPaths;
  #now: () => number;

  constructor(options: {
    db: Database;
    paths: DataPaths;
    now?: () => number;
  }) {
    this.#db = options.db;
    this.#paths = options.paths;
    this.#now = options.now ?? Date.now;
  }

  list(modelHash: string): SampleView[] {
    return listSamples(this.#db, normalizeModelHash(modelHash)).map((row) =>
      this.view(row)
    );
  }

  get(id: string): SampleView | null {
    const row = getSample(this.#db, id);
    return row ? this.view(row) : null;
  }

  require(id: string): SampleView {
    const view = this.get(id);
    if (!view) throw new SampleNotFoundError(id);
    return view;
  }

  view(row: SampleRow): SampleView {
    return {
      ...row,
      media_url: mediaUrl(row.path),
      reusable: row.params !== null && Object.keys(row.params).length > 0,
    };
  }

  /** Drop a file onto the model page: bytes in, sample out (§8.3). */
  async import(input: ImportSampleInput): Promise<SampleView> {
    const modelHash = this.#requireModel(input.modelHash);
    const { kind, ext } = sniffMedia(input.bytes, input.filename);
    const id = ulid();
    const { dir, relativeDir } = await this.#folder(modelHash);
    const file = `${id}${ext}`;
    await Deno.writeFile(join(dir, file), input.bytes);

    const output: SidecarOutput = { file, kind };
    if (ext === ".png") {
      try {
        const size = readPngSize(input.bytes);
        output.width = size.width;
        output.height = size.height;
      } catch {
        // A file we cannot measure is still a sample.
      }
    }
    const sidecar = buildSidecar({
      job_id: id,
      created_at: new Date(this.#now()),
      workflow: null,
      params: {},
      models: [{
        role: "model",
        name: this.#modelName(modelHash),
        hash: modelHash,
      }],
      api_graph: null,
      outputs: [output],
      raw: input.raw ?? null,
    });
    return this.#record({
      id,
      modelHash,
      relativeDir,
      dir,
      file,
      kind,
      sidecar,
      params: null,
      sourceUrl: input.sourceUrl ?? null,
    });
  }

  /**
   * Promote to sample (§8.3): one sample per checked model, each a hard link
   * to the output's media — one copy of the bytes, however many models used
   * it — beside a copy of the output's sidecar.
   */
  async promote(
    output: OutputRow,
    modelHashes: string[],
  ): Promise<SampleView[]> {
    if (modelHashes.length === 0) {
      throw new SampleError("promote needs at least one model hash");
    }
    const source = join(this.#paths.root, output.path);
    const sidecarText = await Deno.readTextFile(
      join(this.#paths.root, output.sidecar_path),
    );
    const created: SampleView[] = [];
    for (const raw of modelHashes) {
      const modelHash = this.#requireModel(raw);
      const id = ulid();
      const ext = extname(output.path) || ".png";
      const { dir, relativeDir } = await this.#folder(modelHash);
      const file = `${id}${ext}`;
      await link(source, join(dir, file));

      // A full copy of the output's record, pointed at the file beside it and
      // certain of the hash it was promoted for.
      const sidecar = parseSidecar(sidecarText, output.sidecar_path);
      const promoted: Sidecar = {
        ...sidecar,
        models: sidecar.models.map((model) =>
          model.hash === null && model.name === this.#modelName(modelHash)
            ? { ...model, hash: modelHash }
            : model
        ),
        outputs: [{
          ...(sidecar.outputs.find((entry) =>
            output.path.endsWith(`/${entry.file}`)
          ) ?? sidecar.outputs[0] ?? { file, kind: output.kind as "image" }),
          file,
        }],
      };
      created.push(
        await this.#record({
          id,
          modelHash,
          relativeDir,
          dir,
          file,
          kind: output.kind,
          sidecar: promoted,
          params: sidecar.params,
          sourceUrl: null,
        }),
      );
    }
    return created;
  }

  /**
   * Remove the sample and its files. The output it was promoted from is
   * untouched: the hard link means deleting one name never takes the bytes
   * out from under the other.
   */
  async remove(id: string): Promise<SampleView> {
    const sample = this.require(id);
    await removeFile(join(this.#paths.root, sample.path));
    await removeFile(join(this.#paths.root, sample.sidecar_path));
    clearThumbPath(this.#db, sample.path);
    deleteSampleRow(this.#db, id);
    return sample;
  }

  async #record(input: {
    id: string;
    modelHash: string;
    relativeDir: string;
    dir: string;
    file: string;
    kind: string;
    sidecar: Sidecar;
    params: Record<string, unknown> | null;
    sourceUrl: string | null;
  }): Promise<SampleView> {
    const sidecarName = `${input.id}.json`;
    await Deno.writeTextFile(
      join(input.dir, sidecarName),
      serializeSidecar(input.sidecar),
    );
    const row: SampleRow = {
      id: input.id,
      model_hash: input.modelHash,
      path: `${input.relativeDir}/${input.file}`,
      sidecar_path: `${input.relativeDir}/${sidecarName}`,
      kind: input.kind,
      source_url: input.sourceUrl,
      params: input.params,
      created_at: this.#now(),
    };
    insertSample(this.#db, row);
    return this.view(row);
  }

  async #folder(
    modelHash: string,
  ): Promise<{ dir: string; relativeDir: string }> {
    const relativeDir = `samples/${modelHash}`;
    const dir = join(this.#paths.samples, modelHash);
    await Deno.mkdir(dir, { recursive: true });
    return { dir, relativeDir };
  }

  /** A sample belongs to a model, and a model is a hash that exists (§8.3). */
  #requireModel(hash: string): string {
    const normalized = normalizeModelHash(hash);
    if (!getModel(this.#db, normalized)) {
      throw new SampleNotFoundError(hash);
    }
    return normalized;
  }

  #modelName(hash: string): string {
    const model = getModel(this.#db, hash);
    if (!model) return hash;
    return model.path.split("/").pop() ?? model.path;
  }
}

/** One copy of the bytes; a filesystem that cannot link falls back to two. */
async function link(from: string, to: string): Promise<void> {
  try {
    await Deno.link(from, to);
  } catch (cause) {
    if (cause instanceof Deno.errors.AlreadyExists) throw cause;
    await Deno.copyFile(from, to);
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
