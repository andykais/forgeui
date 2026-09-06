import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import type { DataPaths } from "../config/paths.ts";
import {
  insertOutputModels,
  refreshModelUsage,
  type SidecarModelRef,
} from "../db/queries.ts";
import { parseSidecar } from "../jobs/sidecar.ts";

/**
 * §8.1: an output written before its models were hashed records
 * `models: [{role, name, hash: null}]` and nothing in `output_models`. When a
 * model finishes hashing, the rows are filled in from the sidecars — by name,
 * because that is what a sidecar of an unhashed model has. **The sidecar is
 * not rewritten**: it already says what it should, and the index is the
 * derived thing (§7).
 */

export interface PendingRef {
  output_id: string;
  role: string;
}

/**
 * Name → the outputs whose sidecar names it without a hash. Built once and
 * reused for a whole hashing pass, because a pass hashes many models and
 * reading every sidecar for each of them would not scale.
 */
export class SidecarModelIndex {
  #byName = new Map<string, PendingRef[]>();
  /** What the outputs table looked like when this was built. */
  readonly stamp: string;

  private constructor(stamp: string) {
    this.stamp = stamp;
  }

  static stampOf(db: Database): string {
    const row = db.prepare(
      `SELECT count(*), coalesce(max(created_at), 0), coalesce(max(id), '')
         FROM outputs`,
    ).value<[number, number, string]>();
    return row ? `${row[0]}:${row[1]}:${row[2]}` : "0:0:";
  }

  static async build(
    db: Database,
    paths: DataPaths,
  ): Promise<SidecarModelIndex> {
    const index = new SidecarModelIndex(SidecarModelIndex.stampOf(db));
    const rows = db.prepare(
      `SELECT id, sidecar_path FROM outputs ORDER BY sidecar_path, id`,
    ).values<[string, string]>();

    const bySidecar = new Map<string, string[]>();
    for (const [id, sidecarPath] of rows) {
      const ids = bySidecar.get(sidecarPath) ?? [];
      ids.push(id);
      bySidecar.set(sidecarPath, ids);
    }

    for (const [sidecarPath, ids] of bySidecar) {
      let models: SidecarModelRef[];
      try {
        models = parseSidecar(
          await Deno.readTextFile(join(paths.root, sidecarPath)),
          sidecarPath,
        ).models;
      } catch {
        // A sidecar that cannot be read is reindex's problem, not the
        // hasher's; it must never stop a hashing pass.
        continue;
      }
      for (const model of models) {
        if (model.hash) continue;
        const refs = index.#byName.get(model.name) ?? [];
        for (const id of ids) refs.push({ output_id: id, role: model.role });
        index.#byName.set(model.name, refs);
      }
    }
    return index;
  }

  get size(): number {
    return this.#byName.size;
  }

  outputsFor(name: string): PendingRef[] {
    return this.#byName.get(name) ?? [];
  }
}

/** Link every output whose sidecar named this model to its new hash. */
export function backfillOutputModels(
  db: Database,
  index: SidecarModelIndex,
  model: { name: string; hash: string },
): number {
  const refs = index.outputsFor(model.name);
  let inserted = 0;
  for (const ref of refs) {
    inserted += insertOutputModels(db, ref.output_id, [{
      role: ref.role,
      name: model.name,
      hash: model.hash,
    }]);
  }
  if (inserted > 0) refreshModelUsage(db, [model.hash]);
  return inserted;
}
