import type { Database } from "@db/sqlite";
import { extname, join, relative } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import {
  allOutputIds,
  deleteOutputRow,
  insertOutput,
  insertOutputModels,
  insertRebuiltJob,
  jobExists,
  type OutputRow,
  rebuildOutputsFts,
  refreshModelUsage,
  type SidecarModelRef,
} from "../db/queries.ts";
import { promptText } from "../jobs/completion.ts";
import { readPngSize } from "../jobs/png.ts";
import { parseSidecar, type Sidecar } from "../jobs/sidecar.ts";
import { sha256Hex } from "../workflows/hash.ts";
import type { ApiGraph } from "../workflows/types.ts";

/**
 * `deno task reindex` (§7): the database is a derived index, so it can be
 * thrown away and rebuilt from the files and sidecars on disk. Sidecars are
 * the source of truth; anything a sidecar cannot know (a ComfyUI prompt id,
 * per-node progress) stays null.
 */

export interface ReindexResult {
  sidecars: number;
  outputs: number;
  jobs_created: number;
  output_models: number;
  /** Rows whose files are no longer on disk. */
  removed: string[];
  errors: { path: string; message: string }[];
}

export interface ReindexOptions {
  db: Database;
  paths: DataPaths;
  /**
   * Fills in the hashes a sidecar could not know, by name (§8.1). Without it
   * only sidecars that already carry hashes produce `output_models` rows.
   */
  resolveModels?: (models: SidecarModelRef[]) => SidecarModelRef[];
  /** Report progress while walking a large outputs tree. */
  onProgress?: (done: number) => void;
}

async function* sidecarFiles(root: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  // Sorted so a rebuild is deterministic, and so days come out in order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      yield* sidecarFiles(path);
    } else if (entry.isFile && extname(entry.name) === ".json") {
      yield path;
    }
  }
}

function sidecarCreatedAt(sidecar: Sidecar): number {
  const parsed = Date.parse(sidecar.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Rebuild `outputs`, `output_models` and the missing `jobs` rows from every
 * sidecar under `outputs/`.
 */
export async function reindex(options: ReindexOptions): Promise<ReindexResult> {
  const { db, paths } = options;
  const result: ReindexResult = {
    sidecars: 0,
    outputs: 0,
    jobs_created: 0,
    output_models: 0,
    removed: [],
    errors: [],
  };
  const seen = new Set<string>();

  for await (const sidecarPath of sidecarFiles(paths.outputs)) {
    const relativeSidecar = relative(paths.root, sidecarPath).replaceAll(
      "\\",
      "/",
    );
    let sidecar: Sidecar;
    try {
      sidecar = parseSidecar(
        await Deno.readTextFile(sidecarPath),
        relativeSidecar,
      );
    } catch (cause) {
      result.errors.push({
        path: relativeSidecar,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    result.sidecars++;
    const createdAt = sidecarCreatedAt(sidecar);
    const dir = join(sidecarPath, "..");

    for (const [index, output] of sidecar.outputs.entries()) {
      const id = `${sidecar.job_id}-${index}`;
      const mediaPath = join(dir, output.file);
      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(mediaPath);
      } catch (cause) {
        result.errors.push({
          path: `${relativeSidecar} → ${output.file}`,
          message: cause instanceof Deno.errors.NotFound
            ? "the file named in the sidecar is missing"
            : cause instanceof Error
            ? cause.message
            : String(cause),
        });
        continue;
      }

      let width = typeof output.width === "number" ? output.width : null;
      let height = typeof output.height === "number" ? output.height : null;
      if (extname(output.file).toLowerCase() === ".png") {
        try {
          // The file itself outranks the sidecar for its own dimensions.
          const size = readPngSize(bytes);
          width = size.width;
          height = size.height;
        } catch {
          // Keep whatever the sidecar claimed.
        }
      }

      const row: OutputRow = {
        id,
        job_id: sidecar.job_id,
        path: relative(paths.root, mediaPath).replaceAll("\\", "/"),
        sidecar_path: relativeSidecar,
        kind: output.kind,
        width,
        height,
        duration_ms: typeof output.duration_ms === "number"
          ? output.duration_ms
          : null,
        // Hashed from the bytes on disk, exactly as the pipeline does.
        sha256: await sha256Hex(bytes),
        workflow_id: sidecar.workflow?.id ?? null,
        workflow_hash: sidecar.workflow?.hash ?? null,
        family: sidecar.workflow?.family ?? null,
        prompt: promptText(null, sidecar.params),
        params: sidecar.params,
        deleted_at: null,
        created_at: createdAt,
      };
      // A rebuild replaces whatever was there before.
      deleteOutputRow(db, id);
      insertOutput(db, row);
      const models = options.resolveModels?.(sidecar.models) ?? sidecar.models;
      result.output_models += insertOutputModels(db, id, models);
      result.outputs++;
      seen.add(id);
      options.onProgress?.(result.outputs);
    }

    if (!jobExists(db, sidecar.job_id) && seen.size > 0) {
      insertRebuiltJob(db, {
        id: sidecar.job_id,
        workflow_id: sidecar.workflow?.id ?? null,
        workflow_hash: sidecar.workflow?.hash ?? null,
        params: sidecar.params,
        api_graph: (sidecar.api_graph ?? {}) as ApiGraph,
        created_at: createdAt,
        total_ms: typeof sidecar.timing?.total_ms === "number"
          ? sidecar.timing.total_ms
          : 0,
      });
      result.jobs_created++;
    }
  }

  // Rows the files no longer back: the index follows the disk, not the reverse.
  for (const id of allOutputIds(db)) {
    if (seen.has(id)) continue;
    deleteOutputRow(db, id);
    result.removed.push(id);
  }

  rebuildOutputsFts(db);
  // `output_count` and `last_used_at` are derived from what was just rebuilt.
  refreshModelUsage(db);
  return result;
}
