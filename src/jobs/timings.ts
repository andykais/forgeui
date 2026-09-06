import type { Database } from "@db/sqlite";
import { relative } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import {
  countNodeTimings,
  NODE_TIMING_ALPHA,
  replaceNodeTimings,
} from "../db/queries.ts";
import { parseSidecar } from "./sidecar.ts";
import { sidecarFiles } from "../outputs/reindex.ts";

/**
 * §5.1: `node_timings` is seeded from the `timing.nodes` block of every
 * existing sidecar, so the first ETA after this phase ships is already worth
 * reading rather than waiting for the workflow to be run again.
 *
 * Seeding is a rebuild, not an accumulation: the table is recomputed from the
 * files in the order they were written, so running it twice leaves exactly
 * the same rows — the same property `reindex` has, and for the same reason
 * (§7: the database is derived).
 */

export interface SeedTimingsResult {
  sidecars: number;
  workflows: number;
  nodes: number;
  skipped: number;
}

interface Accumulator {
  ewma: number;
  samples: number;
}

export async function seedNodeTimings(options: {
  db: Database;
  paths: DataPaths;
  alpha?: number;
}): Promise<SeedTimingsResult> {
  const alpha = options.alpha ?? NODE_TIMING_ALPHA;
  const byWorkflow = new Map<string, Map<string, Accumulator>>();
  const result: SeedTimingsResult = {
    sidecars: 0,
    workflows: 0,
    nodes: 0,
    skipped: 0,
  };

  // Sidecars come out in day-directory then job-id order, which is the order
  // they were written: an average is only meaningful played forwards.
  for await (const path of sidecarFiles(options.paths.outputs)) {
    let hash: string | null = null;
    let nodes: Record<string, number> = {};
    try {
      const sidecar = parseSidecar(
        await Deno.readTextFile(path),
        relative(options.paths.root, path),
      );
      hash = sidecar.workflow?.hash ?? null;
      nodes = sidecar.timing.nodes ?? {};
    } catch {
      result.skipped++;
      continue;
    }
    if (!hash || Object.keys(nodes).length === 0) {
      result.skipped++;
      continue;
    }
    result.sidecars++;
    const timings = byWorkflow.get(hash) ?? new Map<string, Accumulator>();
    for (const [nodeId, ms] of Object.entries(nodes)) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
      const existing = timings.get(nodeId);
      timings.set(nodeId, {
        ewma: existing === undefined
          ? ms
          : alpha * ms + (1 - alpha) * existing.ewma,
        samples: (existing?.samples ?? 0) + 1,
      });
    }
    byWorkflow.set(hash, timings);
  }

  const rows = [...byWorkflow].flatMap(([workflow_hash, timings]) =>
    [...timings].map(([node_id, accumulator]) => ({
      workflow_hash,
      node_id,
      ewma_ms: accumulator.ewma,
      samples: accumulator.samples,
    }))
  );
  result.nodes = replaceNodeTimings(options.db, rows);
  result.workflows = byWorkflow.size;
  return result;
}

/** First launch after §5.1 shipped: an empty table is one nobody has filled. */
export async function seedNodeTimingsIfEmpty(options: {
  db: Database;
  paths: DataPaths;
}): Promise<SeedTimingsResult | null> {
  if (countNodeTimings(options.db) > 0) return null;
  return await seedNodeTimings(options);
}
