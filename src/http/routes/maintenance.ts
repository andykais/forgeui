import { seedNodeTimings } from "../../jobs/timings.ts";
import { reindex } from "../../outputs/reindex.ts";
import { json } from "../json.ts";
import type { AppContext, Route } from "../server.ts";

/**
 * §12's maintenance group. Only reindex is in Phase 1, and it is safe to run
 * at any time: it reads the files and rewrites the index, never the reverse.
 */
export function maintenanceRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/maintenance/reindex",
      handler: async () => {
        const result = await reindex({
          db: ctx.db,
          paths: ctx.paths,
          resolveModels: (models) => ctx.models.resolveModels(models),
        });
        // Deleted rows may have gone; drop any timers that pointed at them.
        await ctx.outputs.resumeDeletions();
        // `node_timings` is derived from the same sidecars (§5.1).
        const timings = await seedNodeTimings({ db: ctx.db, paths: ctx.paths });
        return json({ ...result, node_timings: timings.nodes });
      },
    },
    {
      method: "POST",
      path: "/api/maintenance/rescan-models",
      handler: async () => {
        const result = await ctx.models.rescan();
        return json({ ...result, progress: ctx.models.progress });
      },
    },
  ];
}
