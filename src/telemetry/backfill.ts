import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import { listLiveOutputs } from "../db/queries.ts";
import { log } from "../log.ts";
import { recordedLabels } from "./queries.ts";
import type { TelemetryStore } from "./store.ts";

/**
 * The Output Size report can be given the history it predates (§7.1): every
 * output already indexed is an entry that was never written, and `outputs`
 * plus the files on disk is all it takes to write it now. Entries are
 * stamped with the output's own `created_at`, so the line climbs where the
 * generations actually happened rather than all at once at this boot.
 *
 * It is a diff, not a one-shot: an output already in the report is skipped,
 * so this is safe on every boot and also picks up whatever `reindex` found.
 * That makes the report's history as good as `app.db`'s, which is the most
 * that can be said for it — `app.db` is itself rebuildable from sidecars.
 */
export interface BackfillResult {
  /** Entries written. */
  recorded: number;
  /** Outputs whose file is no longer on disk; nothing is written for them. */
  missing: number;
  elapsed_ms: number;
}

export async function backfillOutputSizes(options: {
  db: Database;
  telemetry: TelemetryStore;
  paths: DataPaths;
}): Promise<BackfillResult> {
  const startedAt = Date.now();
  const result: BackfillResult = { recorded: 0, missing: 0, elapsed_ms: 0 };
  const already = recordedLabels(options.telemetry.db, "output_size");
  const outputs = listLiveOutputs(options.db);

  for (const output of outputs) {
    if (already.has(output.id)) continue;
    let bytes: number;
    try {
      bytes = (await Deno.stat(join(options.paths.root, output.path))).size;
    } catch {
      // The row outlived its file. `reindex` is what settles that; a report
      // of sizes is not the place to guess at one.
      result.missing++;
      continue;
    }
    options.telemetry.recordOutput({
      output_id: output.id,
      path: output.path,
      bytes,
      kind: output.kind,
      family: output.family,
      workflow_id: output.workflow_id,
      job_id: output.job_id,
      created_at: output.created_at,
      backfilled: true,
    });
    result.recorded++;
  }

  result.elapsed_ms = Date.now() - startedAt;
  if (result.recorded > 0) {
    log(
      `telemetry: backfilled ${result.recorded} outputs into the size report${
        result.missing > 0 ? ` — ${result.missing} files are gone` : ""
      }`,
    );
  }
  return result;
}
