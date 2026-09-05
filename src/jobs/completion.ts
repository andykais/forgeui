import type { Database } from "@db/sqlite";
import { dirname, extname, join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import {
  insertOutput,
  insertOutputModels,
  type JobRow,
  type OutputRow,
  refreshModelUsage,
  type SidecarModelRef,
} from "../db/queries.ts";
import type { ComfyImageRef } from "../comfy/events.ts";
import { sha256Hex } from "../workflows/hash.ts";
import type { Manifest, WorkflowKind } from "../workflows/types.ts";
import { collectModels } from "./models.ts";
import { readPngSize, SIDECAR_KEYWORD, withTextChunk } from "./png.ts";
import {
  buildSidecar,
  serializeSidecar,
  serializeSidecarAscii,
  type Sidecar,
  type SidecarOutput,
} from "./sidecar.ts";

/**
 * Step 7 of the pipeline (§5): move the files out of staging, write the
 * sidecar, embed a copy of it in each PNG, index the result, and leave
 * exactly one copy of every byte on disk (§6.3).
 */

export class CompletionError extends Error {
  override readonly name = "CompletionError";
}

export interface JobOutputImages {
  node: string;
  files: ComfyImageRef[];
}

export interface CompleteJobInput {
  db: Database;
  paths: DataPaths;
  job: JobRow;
  /** Null when the workflow has been deleted since the job ran (§6.1). */
  manifest: Manifest | null;
  images: JobOutputImages[];
  timing: { total_ms: number; nodes: Record<string, number> };
  createdAt: Date;
  /**
   * Fills in the hash of every model the library has already hashed, so
   * `output_models` is written at completion (§8.1). The sidecar keeps the
   * `hash: null` the graph knew; the backfill links the rest later.
   */
  resolveModels?: (models: SidecarModelRef[]) => SidecarModelRef[];
}

export interface CompleteJobResult {
  outputs: OutputRow[];
  sidecar: Sidecar;
  /** Relative to `<appdata>`, as stored in the database. */
  sidecarPath: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov"]);

function dayPath(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function kindFor(
  file: string,
  node: string,
  manifest: Manifest | null,
): WorkflowKind {
  const declared = manifest?.outputs.find((output) => output.node === node);
  if (declared) return declared.kind;
  const ext = extname(file).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return manifest?.kind ?? "image";
}

/** The prompt text the gallery searches on; denormalised into `outputs`. */
export function promptText(
  manifest: Manifest | null,
  params: Record<string, unknown>,
): string | null {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }
  for (const param of manifest?.params ?? []) {
    if (param.type !== "text") continue;
    const value = params[param.key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

async function moveFile(from: string, to: string): Promise<void> {
  await Deno.mkdir(dirname(to), { recursive: true });
  try {
    // A metadata operation: staging is on the same filesystem (§6.3).
    await Deno.rename(from, to);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw new CompletionError(
        `ComfyUI reported ${from}, but it is not there`,
      );
    }
    // Different filesystems (a symlinked data dir, say): fall back to a copy.
    await Deno.copyFile(from, to);
    await Deno.remove(from);
  }
}

export async function completeJob(
  input: CompleteJobInput,
): Promise<CompleteJobResult> {
  const { db, paths, job, manifest, images, createdAt } = input;
  const files = images.flatMap((entry) =>
    entry.files.map((file) => ({ node: entry.node, file }))
  );
  if (files.length === 0) {
    throw new CompletionError(
      "ComfyUI finished without writing any files; check that the workflow has a save node",
    );
  }

  const relativeDir = `outputs/${dayPath(createdAt)}`;
  const absoluteDir = join(paths.root, relativeDir);
  await Deno.mkdir(absoluteDir, { recursive: true });

  interface Moved {
    id: string;
    node: string;
    relativePath: string;
    absolutePath: string;
    file: string;
    kind: WorkflowKind;
    width: number | null;
    height: number | null;
  }

  const moved: Moved[] = [];
  for (const [index, entry] of files.entries()) {
    const ext = extname(entry.file.filename) || ".png";
    const name = `${job.id}-${index}${ext}`;
    const source = join(
      paths.staging,
      entry.file.subfolder,
      entry.file.filename,
    );
    const destination = join(absoluteDir, name);
    await moveFile(source, destination);

    let width: number | null = null;
    let height: number | null = null;
    if (ext.toLowerCase() === ".png") {
      try {
        const size = readPngSize(await Deno.readFile(destination));
        width = size.width;
        height = size.height;
      } catch {
        // A file we cannot measure still counts as an output.
      }
    }
    moved.push({
      id: `${job.id}-${index}`,
      node: entry.node,
      relativePath: `${relativeDir}/${name}`,
      absolutePath: destination,
      file: name,
      kind: kindFor(name, entry.node, manifest),
      width,
      height,
    });
  }

  // The sidecar records what the graph named; the index records what the
  // library has hashed so far (§6.2, §8.1).
  const models = collectModels(job.api_graph);
  const resolved = input.resolveModels?.(models) ?? models;
  const sidecarOutputs: SidecarOutput[] = moved.map((entry) => ({
    file: entry.file,
    kind: entry.kind,
    ...(entry.width !== null ? { width: entry.width } : {}),
    ...(entry.height !== null ? { height: entry.height } : {}),
  }));

  const sidecar = buildSidecar({
    job_id: job.id,
    created_at: createdAt,
    workflow: job.workflow_id === null ? null : {
      id: job.workflow_id,
      name: manifest?.name ?? job.workflow_id,
      hash: job.workflow_hash ?? "",
      family: manifest?.family ?? null,
      kind: manifest?.kind ?? moved[0]!.kind,
    },
    params: job.params,
    models,
    api_graph: job.api_graph,
    outputs: sidecarOutputs,
    timing: input.timing,
  });

  const sidecarName = `${job.id}.json`;
  const sidecarPath = `${relativeDir}/${sidecarName}`;
  await Deno.writeTextFile(
    join(absoluteDir, sidecarName),
    serializeSidecar(sidecar),
  );

  // A PNG carries a copy of its own sidecar as a convenience; the file on
  // disk stays canonical (§5 step 7). Videos are not embedded.
  const embedded = serializeSidecarAscii(sidecar);
  const rows: OutputRow[] = [];
  for (const entry of moved) {
    if (extname(entry.file).toLowerCase() === ".png") {
      try {
        const bytes = await Deno.readFile(entry.absolutePath);
        await Deno.writeFile(
          entry.absolutePath,
          withTextChunk(bytes, SIDECAR_KEYWORD, embedded),
        );
      } catch {
        // Not fatal: the sidecar file is the record that matters.
      }
    }
    // Hashed after the embed, so `reindex` recomputes the same value.
    const sha256 = await sha256Hex(await Deno.readFile(entry.absolutePath));
    const row: OutputRow = {
      id: entry.id,
      job_id: job.id,
      path: entry.relativePath,
      sidecar_path: sidecarPath,
      kind: entry.kind,
      width: entry.width,
      height: entry.height,
      duration_ms: null,
      sha256,
      workflow_id: job.workflow_id,
      workflow_hash: job.workflow_hash,
      family: manifest?.family ?? null,
      prompt: promptText(manifest, job.params),
      params: job.params,
      deleted_at: null,
      created_at: createdAt.getTime(),
    };
    insertOutput(db, row);
    insertOutputModels(db, row.id, resolved);
    rows.push(row);
  }
  refreshModelUsage(
    db,
    resolved.map((model) => model.hash).filter((hash): hash is string =>
      hash !== null
    ),
  );

  await removeStagingDir(paths, job.id);
  return { outputs: rows, sidecar, sidecarPath };
}

/** After a job ends, its staging directory has nothing left to give. */
export async function removeStagingDir(
  paths: DataPaths,
  jobId: string,
): Promise<void> {
  try {
    await Deno.remove(join(paths.staging, jobId), { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
